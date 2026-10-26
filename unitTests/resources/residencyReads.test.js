require('../testUtils');
const assert = require('node:assert');
const { setupTestDBPath } = require('../testUtils');
const { table } = require('#src/resources/databases');
const { Resource } = require('#src/resources/Resource');
const { transaction } = require('#src/resources/transaction');
const { setMainIsWorker } = require('#src/server/threads/manageThreads');
const { ServerError } = require('#src/utility/errors/hdbError');
const { INVALIDATED } = require('#src/resources/Table');
const { server } = require('#src/server/Server');
const { SKIP } = require('@harperfast/extended-iterable');

describe('Reads of residency stubs', function () {
	this.timeout(10_000);
	let Records, response, calls;
	const unavailable = new ServerError('residency test: no resident is reachable', 502);

	before(() => {
		setupTestDBPath();
		setMainIsWorker(true);
		Records = table({
			database: 'test',
			table: 'ResidencyReads',
			schemaDefined: true,
			attributes: [
				{ name: 'id', type: 'ID', isPrimaryKey: true },
				{ name: 'name', type: 'String', indexed: true },
				{ name: 'body', type: 'String' },
			],
			audit: true,
		});
		Records.sourcedFrom(
			class extends Resource {
				static async load(entry) {
					calls.push(entry.key);
					if (response instanceof Error) throw response;
					return response;
				}
			},
			{ intermediateSource: true }
		);
	});

	beforeEach(async () => {
		response = unavailable;
		calls = [];
		const context = {};
		await transaction(context, async () => {
			const resource = await Records.getResource('record', context, { ensureLoaded: false });
			resource._writeInvalidate('record', Object.freeze({ name: 'indexed' }), { residencyId: 123 });
		});
		const entry = Records.primaryStore.getEntry('record');
		assert.ok(entry.metadataFlags & INVALIDATED);
		assert.equal(entry.value.body, undefined);
	});

	async function query(select, conditions = []) {
		const records = [];
		for await (const record of Records.search({ conditions, select })) records.push(record);
		return records;
	}

	it('returns complete rows from an instance search without a context', async () => {
		const Rows = table({
			database: 'test',
			table: 'ContextlessLocalReads',
			attributes: [{ name: 'id', isPrimaryKey: true }],
		});
		await Rows.put('local', { id: 'local' });
		const rows = [];
		for await (const row of new Rows().search({ conditions: [] })) rows.push({ ...row });
		assert.deepStrictEqual(rows, [{ id: 'local' }]);
	});

	for (const shape of ['key', 'lazy', 'entry', 'missing']) {
		it(`skips a synchronous local-only ${shape} after loading its metadata`, async () => {
			const entry =
				shape === 'missing'
					? 'missing'
					: shape === 'key'
						? 'record'
						: shape === 'lazy'
							? { key: 'record', deref: () => undefined }
							: Records.primaryStore.getEntry('record');
			const transform = Records.transformEntryForSelect(
				undefined,
				{ replicateFrom: false },
				undefined,
				null,
				true,
				true
			);
			assert.equal(transform.call({ isSync: true }, entry), SKIP);
			assert.deepEqual(calls, []);
		});
	}

	for (const residencyId of [123, undefined]) {
		for (const mode of ['scan', 'index', 'postOrder', 'postOrderUnbounded']) {
			const indexed = mode !== 'scan';
			const sort = mode.startsWith('postOrder') ? { attribute: 'body' } : undefined;
			const limit = mode === 'postOrderUnbounded' ? undefined : 1;
			for (const select of [undefined, ['id', 'name']]) {
				it(`skips local-only invalidations (${residencyId ? 'residency' : 'cache'}, ${mode}, ${select ? 'projection' : 'full'})`, async () => {
					const Rows = table({
						database: 'test',
						table: `LocalOnlyReads${residencyId ?? 0}${mode}${Boolean(select)}`,
						attributes: [{ name: 'id', isPrimaryKey: true }, { name: 'name', indexed: true }, { name: 'body' }],
						audit: true,
					});
					let loads = 0;
					Rows.sourcedFrom({
						get(id) {
							loads++;
							return { id, name: 'indexed', body: 'source' };
						},
					});
					for (const id of ['a', 'b', 'c']) {
						await Rows.put(id, { id, name: 'indexed', body: 'old' });
						const context = {};
						await transaction(context, async () => {
							const resource = await Rows.getResource(id, context, { ensureLoaded: false });
							resource._writeInvalidate(id, { id, name: 'indexed' }, { residencyId });
						});
					}
					const snapshot = () =>
						Array.from(
							Rows.primaryStore.getRange({ versions: true }),
							({ key, value, metadataFlags, residencyId }) => ({
								key,
								value: { ...value },
								metadataFlags,
								residencyId,
							})
						);
					const before = snapshot();
					assert.ok(before.every((entry) => entry.metadataFlags & INVALIDATED));
					const target = { conditions: indexed ? [{ attribute: 'name', value: 'indexed' }] : [], select, sort, limit };
					if (sort) assert.ok(Rows.search({ ...target, explain: true }).postOrdering);
					const read = async (query = target) => {
						const rows = [];
						for await (const row of Rows.search(query, { replicateFrom: false })) rows.push({ ...row });
						return rows;
					};
					assert.deepStrictEqual(await read(), []);
					assert.equal(loads, 0);
					assert.deepStrictEqual(snapshot(), before);
					const local = { id: 'z', name: 'indexed', body: 'complete' };
					await Rows.put('z', local);
					assert.deepStrictEqual(await read(), [select ? { id: 'z', name: 'indexed' } : local]);
					assert.equal(loads, 0);
					if (sort) {
						const second = { id: 'y', name: 'indexed', body: 'later' };
						await Rows.put('y', second);
						const expected = [local, second].map((row) => (select ? { id: row.id, name: row.name } : row));
						assert.deepStrictEqual(await read({ ...target, limit: undefined }), expected);
						assert.deepStrictEqual(await read({ ...target, offset: 1, limit: 1 }), expected.slice(1));
						const array = await Rows.search({ ...target, limit: undefined }, { replicateFrom: false }).asArray;
						assert.deepStrictEqual(
							array.map((row) => ({ ...row })),
							expected
						);
						const counted = await Rows.search(
							{ ...target, offset: 1, limit: 1, count: 'exact' },
							{ replicateFrom: false }
						);
						assert.equal(counted.recordCount, 2);
						assert.deepStrictEqual(
							Array.from(counted, (row) => ({ ...row })),
							expected.slice(1)
						);
						const grouped = { ...target, sort: { attribute: 'name', next: { attribute: 'body' } }, limit: undefined };
						assert.ok(Rows.search({ ...grouped, explain: true }).postOrdering.dbOrderedAttribute);
						assert.deepStrictEqual(await read(grouped), expected);
					}
					const remote = [];
					for await (const row of Rows.search({ ...target, select: undefined, sort: undefined })) remote.push(row);
					assert.equal(remote[0].body, 'source');
					assert.ok(loads > 0);
				});
			}
		}
	}

	it('omits nonresident id-based rows from local-only sorting', async () => {
		const Rows = table({
			database: 'test',
			table: 'IdOnlyLocalSort',
			audit: true,
			attributes: [{ name: 'id', isPrimaryKey: true }, { name: 'body' }],
		});
		Rows.setResidencyById((id) => (id === 'stub' ? ['another-node'] : undefined));
		await Rows.put('stub', { id: 'stub', body: 'absent' });
		const entry = Rows.primaryStore.getEntry('stub');
		assert.equal(entry, undefined);
		await Rows.put('local', { id: 'local', body: 'complete' });
		const target = { conditions: [], allowFullScan: true, sort: { attribute: 'body' } };
		assert.ok(Rows.search({ ...target, explain: true }).postOrdering);
		const rows = [];
		for await (const row of Rows.search(target, { replicateFrom: false })) rows.push({ ...row });
		assert.deepStrictEqual(rows, [{ id: 'local', body: 'complete' }]);
	});

	it('consumes absent source rows across sorted groups on ordinary reads', async () => {
		const Rows = table({
			database: 'test',
			table: 'AbsentSortedSources',
			audit: true,
			attributes: [{ name: 'id', isPrimaryKey: true }, { name: 'name', indexed: true }, { name: 'body' }],
		});
		Rows.sourcedFrom({
			get() {
				return undefined;
			},
		});
		await Rows.put('stub', { id: 'stub', name: 'first', body: 'old' });
		const context = {};
		await transaction(context, async () => {
			const resource = await Rows.getResource('stub', context, { ensureLoaded: false });
			resource._writeInvalidate('stub', { id: 'stub', name: 'first' });
		});
		const local = { id: 'local', name: 'second', body: 'complete' };
		await Rows.put('local', local);
		const target = { conditions: [], sort: { attribute: 'name', next: { attribute: 'body' } } };
		assert.ok(Rows.search({ ...target, explain: true }).postOrdering.dbOrderedAttribute);
		const rows = await Rows.search(target).asArray;
		assert.deepStrictEqual(
			rows.map((row) => ({ ...row })),
			[local]
		);
	});

	it('sorts null cache invalidations for local-only and ordinary reads', async () => {
		const Rows = table({
			database: 'test',
			table: 'NullCacheLocalSort',
			audit: true,
			attributes: [{ name: 'id', isPrimaryKey: true }, { name: 'body' }],
		});
		let loads = 0;
		Rows.sourcedFrom({
			get(id) {
				loads++;
				return { id, body: 'loaded' };
			},
		});
		await Rows.put('stub', { id: 'stub', body: 'old' });
		const context = {};
		await transaction(context, async () => {
			const resource = await Rows.getResource('stub', context, { ensureLoaded: false });
			resource._writeInvalidate('stub');
		});
		const snapshot = () => {
			const { value, metadataFlags, version } = Rows.primaryStore.getEntry('stub');
			return { value, metadataFlags, version };
		};
		const before = snapshot();
		assert.ok(before.metadataFlags & INVALIDATED);
		assert.equal(before.value, null);
		const local = { id: 'local', body: 'complete' };
		await Rows.put('local', local);
		const rows = [];
		for await (const row of Rows.search(
			{ allowFullScan: true, conditions: [], sort: { attribute: 'body' }, limit: 1 },
			{ replicateFrom: false }
		))
			rows.push({ ...row });
		assert.deepStrictEqual(rows, [local]);
		assert.deepStrictEqual(snapshot(), before);
		assert.equal(loads, 0);
		const ordinary = await Rows.search({ allowFullScan: true, conditions: [], sort: { attribute: 'body' } }).asArray;
		assert.equal(ordinary.find((row) => row.id === 'stub').body, 'loaded');
		assert.equal(ordinary.find((row) => row.id === 'local').body, 'complete');
		assert.equal(loads, 1);
	});

	for (const partial of [false, true]) {
		it(`skips ${partial ? 'partial' : 'null'} invalidations before computed sort resolution`, async () => {
			const Rows = table({
				database: 'test',
				table: `InvalidatedComputedSort${partial}`,
				audit: true,
				attributes: [
					{ name: 'id', isPrimaryKey: true },
					...(partial ? [{ name: 'name', indexed: true }] : []),
					{ name: 'body' },
					{ name: 'bodyLength', computed: { from: 'body' } },
				],
			});
			const resolved = [];
			Rows.setComputedAttribute('bodyLength', (body) => {
				resolved.push(body);
				return body.length;
			});
			let loads = 0;
			Rows.sourcedFrom({
				get() {
					loads++;
					throw new Error('local-only read loaded its source');
				},
			});
			await Rows.put('b', { id: 'b', name: 'group', body: 'old' });
			const context = {};
			await transaction(context, async () => {
				const resource = await Rows.getResource('b', context, { ensureLoaded: false });
				resource._writeInvalidate('b', partial ? { id: 'b', name: 'group' } : undefined);
			});
			assert.ok(Rows.primaryStore.getEntry('b').metadataFlags & INVALIDATED);
			const snapshot = () => {
				const { value, metadataFlags, version } = Rows.primaryStore.getEntry('b');
				return { value, metadataFlags, version };
			};
			const before = snapshot();
			await Rows.put('a', { id: 'a', name: 'group', body: 'zzz' });
			await Rows.put('c', { id: 'c', name: 'group', body: 'a' });
			resolved.length = 0;
			const sort = { attribute: 'bodyLength' };
			const target = { allowFullScan: true, conditions: [], sort: partial ? { attribute: 'name', next: sort } : sort };
			assert.ok(Rows.search({ ...target, explain: true }).postOrdering);
			if (partial) assert.ok(Rows.search({ ...target, explain: true }).postOrdering.dbOrderedAttribute);
			const rows = [];
			for await (const row of Rows.search(target, { replicateFrom: false })) rows.push(row);
			assert.deepStrictEqual(
				rows.map((row) => row.id),
				['c', 'a']
			);
			assert.deepStrictEqual(resolved, ['zzz', 'a']);
			assert.deepStrictEqual(snapshot(), before);
			assert.equal(loads, 0);
		});
	}

	it('preserves metadata sort keys for null cache invalidations', async () => {
		const Rows = table({
			database: 'test',
			table: 'NullCacheMetadataSort',
			audit: true,
			attributes: [{ name: 'id', isPrimaryKey: true }, { name: 'body' }],
		});
		Rows.sourcedFrom({
			get(id) {
				return { id, body: 'loaded' };
			},
		});
		for (const id of ['a', 'b']) {
			await Rows.put(id, { id, body: 'old' });
			const context = {};
			await transaction(context, async () => {
				const resource = await Rows.getResource(id, context, { ensureLoaded: false });
				resource._writeInvalidate(id);
			});
			assert.equal(Rows.primaryStore.getEntry(id).value, null);
		}
		assert.ok(Rows.primaryStore.getEntry('b').version > Rows.primaryStore.getEntry('a').version);
		const target = {
			allowFullScan: true,
			conditions: [],
			sort: { attribute: 'body', next: { attribute: '$updatedtime', descending: true } },
		};
		assert.ok(Rows.search({ ...target, explain: true }).postOrdering);
		const rows = await Rows.search(target).asArray;
		assert.deepStrictEqual(
			rows.map((row) => row.id),
			['b', 'a']
		);
	});

	for (const [leadingRow, found] of [
		[false, false],
		[true, false],
		[false, true],
		[true, true],
	]) {
		it(`stops sorted materialization after closure (${leadingRow ? 'subsequent' : 'first'} row, ${found ? 'present' : 'absent'})`, async () => {
			const Rows = table({
				database: 'test',
				table: `ClosedSortedRead${leadingRow}${found}`,
				audit: true,
				attributes: [{ name: 'id', isPrimaryKey: true }, { name: 'name', indexed: true }, { name: 'body' }],
			});
			let resolveLoad, reportStarted;
			const load = new Promise((resolve) => {
				resolveLoad = resolve;
			});
			const started = new Promise((resolve) => {
				reportStarted = resolve;
			});
			const loads = [];
			Rows.sourcedFrom({
				get(id) {
					loads.push(id);
					if (id === 'a') {
						reportStarted();
						return load;
					}
				},
			});
			for (const id of ['a', 'b']) {
				await Rows.put(id, { id, name: 'indexed', body: 'old' });
				const context = {};
				await transaction(context, async () => {
					const resource = await Rows.getResource(id, context, { ensureLoaded: false });
					resource._writeInvalidate(id, { id, name: 'indexed' });
				});
			}
			if (leadingRow) await Rows.put('local', { id: 'local', name: 'indexed', body: 'complete' });
			const target = {
				conditions: [{ attribute: 'name', value: 'indexed' }],
				sort: { attribute: 'body', descending: true },
			};
			assert.ok(Rows.search({ ...target, explain: true }).postOrdering);
			const iterator = Rows.search(target)[Symbol.asyncIterator]();
			if (leadingRow) assert.equal((await iterator.next()).value.id, 'local');
			const pending = iterator.next();
			await started;
			try {
				await iterator.return();
			} finally {
				resolveLoad(found ? { id: 'a', name: 'indexed', body: 'loaded' } : undefined);
			}
			assert.equal((await pending).done, true);
			assert.deepStrictEqual(loads, ['a']);
		});
	}

	it('propagates the original source error from a single-record read', async () => {
		await assert.rejects(Records.get('record'), (error) => error === unavailable);
		assert.deepEqual(calls, ['record']);
	});

	for (const [label, conditions] of [
		['a scan', []],
		['an indexed query', [{ attribute: 'name', value: 'indexed' }]],
	]) {
		it(`propagates the source error from ${label} selecting non-indexed fields`, async () => {
			await assert.rejects(query(['id', 'body'], conditions), (error) => error === unavailable);
			assert.deepEqual(calls, ['record']);
		});

		it(`loads the complete record for ${label}`, async () => {
			response = { key: 'record', value: { id: 'record', name: 'indexed', body: 'complete' }, metadataFlags: 0 };
			assert.deepEqual(await query(['id', 'body'], conditions), [{ id: 'record', body: 'complete' }]);
			assert.deepEqual(calls, ['record']);
		});
	}

	it('keeps successful absence distinct from a source failure', async () => {
		response = undefined;
		assert.equal(await Records.get('record'), undefined);
		assert.deepEqual(await query(['id', 'body']), []);
		assert.deepEqual(calls, ['record', 'record']);
	});

	it('propagates a failure from an instance ensureLoaded without changing its stub', async () => {
		const resource = await Records.getResource('record', {}, { ensureLoaded: false });
		await assert.rejects(resource.ensureLoaded(), (error) => error === unavailable);
		assert.equal(resource.getRecord().name, 'indexed');
	});

	it('clears an instance when ensureLoaded receives successful absence', async () => {
		response = undefined;
		const resource = await Records.getResource('record', {}, { ensureLoaded: false });
		await resource.ensureLoaded();
		assert.equal(resource.getRecord(), null);
		assert.equal(resource.getMetadata(), undefined);
	});

	it('updates an instance when ensureLoaded receives a complete record', async () => {
		response = { key: 'record', value: { id: 'record', name: 'indexed', body: 'complete' }, version: 123 };
		const resource = await Records.getResource('record', {}, { ensureLoaded: false });
		await resource.ensureLoaded();
		assert.equal(resource.getRecord().body, 'complete');
		assert.equal(resource.getMetadata().version, 123);
	});

	it('advances request freshness when ensureLoaded adopts a newer resident version', async () => {
		const context = {};
		const resource = await Records.getResource('record', context, { ensureLoaded: false });
		const version = resource.getMetadata().version + 1;
		response = { key: 'record', value: { id: 'record', name: 'indexed', body: 'newer' }, version };
		await resource.ensureLoaded();
		assert.equal(context.lastModified, version);
		assert.equal(resource.getMetadata().version, version);
	});

	it('uses indexed-only projections without contacting a resident', async () => {
		assert.deepEqual(await query(['id', 'name']), [{ id: 'record', name: 'indexed' }]);
		assert.deepEqual(calls, []);
	});

	it('keeps the primary key on a patched stub, so an index-only select stays local', async () => {
		const context = {};
		await transaction(context, async () => {
			const resource = await Records.getResource('record', context, { ensureLoaded: false });
			resource._writeUpdate('record', { name: 'patched' }, false);
			resource.save();
		});
		assert.ok(Records.primaryStore.getEntry('record').metadataFlags & INVALIDATED, 'premise: the patch keeps the stub');
		assert.deepEqual(await query(['id', 'name'], [{ attribute: 'name', value: 'patched' }]), [
			{ id: 'record', name: 'patched' },
		]);
		assert.deepEqual(calls, []);
	});

	it('replaces indexed values when an existing stub is invalidated again', async () => {
		const context = {};
		await transaction(context, async () => {
			const resource = await Records.getResource('record', context, { ensureLoaded: false });
			resource._writeInvalidate('record', { id: 'record', name: 'changed' }, { residencyId: 123 });
		});
		assert.deepEqual(await query(['id'], [{ attribute: 'name', value: 'indexed' }]), []);
		assert.deepEqual(await query(['id'], [{ attribute: 'name', value: 'changed' }]), [{ id: 'record' }]);
		assert.deepEqual(calls, []);
	});

	it('removes an omitted indexed value from a received residency stub', async () => {
		const context = {};
		await transaction(context, async () => {
			const resource = await Records.getResource('record', context, { ensureLoaded: false });
			resource._writeInvalidate('record', Object.freeze({ name: undefined }), { residencyId: 123 });
		});
		assert.deepEqual(await query(['id'], [{ attribute: 'name', value: 'indexed' }]), []);
		assert.equal(Records.primaryStore.getEntry('record').value.name, undefined);
		assert.equal(Records.primaryStore.getEntry('record').value.id, 'record');
	});

	it('keeps committed indexed values when a fresh resource invalidates a local cache entry', async () => {
		await Records.put('cache-target', { id: 'cache-target', name: 'local-cache', body: 'complete' });
		const context = {};
		await transaction(context, () => {
			new Records('cache-target', context)._writeInvalidate('cache-target');
		});
		assert.equal(Records.primaryStore.getEntry('cache-target').value.name, 'local-cache');
		assert.deepEqual(await query(['id', 'name'], [{ attribute: 'name', value: 'local-cache' }]), [
			{ id: 'cache-target', name: 'local-cache' },
		]);
	});

	it('reads indexed accessors from an inherited incoming projection', async () => {
		const context = {};
		await transaction(context, async () => {
			const resource = await Records.getResource('record', context, { ensureLoaded: false });
			const projection = Object.freeze(
				Object.create({
					get name() {
						return 'inherited';
					},
				})
			);
			resource._writeInvalidate('record', projection, { residencyId: 123 });
		});
		assert.deepEqual(await query(['id'], [{ attribute: 'name', value: 'inherited' }]), [{ id: 'record' }]);
		assert.deepEqual(await query(['id'], [{ attribute: 'name', value: 'indexed' }]), []);
	});

	it('retains inherited non-indexed source fields when copying a frozen invalidation', async () => {
		const context = {};
		await transaction(context, async () => {
			const resource = await Records.getResource('record', context, { ensureLoaded: false });
			resource._writeInvalidate('record', Object.freeze(Object.create({ name: 'inherited', body: 'source body' })));
		});
		const entry = Records.primaryStore.getEntry('record');
		assert.ok(entry.metadataFlags & INVALIDATED);
		assert.equal(entry.value.body, 'source body');
	});

	it('never promotes an incomplete cache patch after invalidation in the same transaction', async () => {
		await Records.put('cache-patch', { name: 'before', body: 'complete' });
		const context = {};
		await transaction(context, async () => {
			const resource = await Records.getResource('cache-patch', context, { ensureLoaded: false });
			resource._writeInvalidate('cache-patch');
			await Records.patch('cache-patch', { name: 'after' }, context);
		});
		const entry = Records.primaryStore.getEntry('cache-patch');
		assert.equal(entry.value.name, 'after');
		assert.ok(
			entry.metadataFlags & INVALIDATED || entry.value.body === 'complete',
			'a patch cannot turn an incomplete base into a complete record'
		);
	});

	it('retains audit-referenced blobs from a superseded invalidation', async () => {
		const Blobs = table({
			database: 'test',
			table: 'ResidencyInvalidationBlobs',
			attributes: [{ name: 'id', isPrimaryKey: true }, { name: 'blob' }],
			audit: true,
		});
		const data = require('node:crypto').randomBytes(25_000);
		const first = await createBlob(data);
		const second = await createBlob(require('node:crypto').randomBytes(25_000));
		const context = {};
		await transaction(context, () => {
			new Blobs('blob-record', context)._writeInvalidate('blob-record', { blob: first });
			new Blobs('blob-record', context)._writeInvalidate('blob-record', { blob: second });
		});
		await Blobs.put('blob-record', { blob: first });
		assert.deepEqual(Buffer.from(await (await Blobs.get('blob-record')).blob.arrayBuffer()), data);
	});

	it('keeps a primary-key projection when a residency table has no secondary indexes', async () => {
		const PrimaryOnly = table({
			database: 'test',
			table: 'ResidencyPrimaryOnly',
			attributes: [{ name: 'id', isPrimaryKey: true }, { name: 'body' }],
			audit: true,
		});
		const context = {};
		await transaction(context, async () => {
			const resource = await PrimaryOnly.getResource('key-only', context, { ensureLoaded: false });
			resource._writeInvalidate('key-only', null, { residencyId: 123 });
		});
		const records = [];
		for await (const record of PrimaryOnly.search({ select: ['id'] })) records.push(record);
		assert.deepEqual(records, [{ id: 'key-only' }]);
	});

	it('preserves a computed index without evaluating its resolver on an incomplete stub', async () => {
		const Computed = table({
			database: 'test',
			table: 'ResidencyComputed',
			attributes: [
				{ name: 'id', isPrimaryKey: true },
				{ name: 'name' },
				{ name: 'upper', indexed: true, computed: true },
			],
			audit: true,
		});
		Computed.setComputedAttribute('upper', (record) => record.name.toUpperCase());
		await Computed.put('computed', { id: 'computed', name: 'original' });
		const context = {};
		await transaction(context, async () => {
			const resource = await Computed.getResource('computed', context, { ensureLoaded: false });
			resource._writeInvalidate('computed');
		});
		const records = [];
		for await (const record of Computed.search({
			conditions: [{ attribute: 'upper', value: 'ORIGINAL' }],
			select: ['id'],
		}))
			records.push(record);
		assert.deepEqual(records, [{ id: 'computed' }]);
	});

	describe('writes over a stub on a table with a computed index', () => {
		let Computed;
		before(() => {
			Computed = table({
				database: 'test',
				table: 'ResidencyComputedWrites',
				attributes: [
					{ name: 'id', isPrimaryKey: true },
					{ name: 'sku', indexed: true },
					{ name: 'name' },
					{ name: 'upper', indexed: true, computed: true },
					{ name: 'skuKey', indexed: true, computed: true },
				],
				audit: true,
			});
			// `name` is not indexed, so no stub carries the resolver's input; `sku` is, so `skuKey` resolves over a stub
			Computed.setComputedAttribute('upper', (record) => record.name.toUpperCase());
			Computed.setComputedAttribute('skuKey', (record) => record.sku.toLowerCase());
		});
		const indexedKeys = (attribute, id) =>
			Array.from(Computed.indices[attribute].getRange({}))
				.filter(({ value }) => value === id)
				.map(({ key }) => key);
		async function invalidate(id, context) {
			const resource = await Computed.getResource(id, context, { ensureLoaded: false });
			resource._writeInvalidate(id);
		}

		for (const staged of [false, true]) {
			const where = staged ? 'a stub staged earlier in the transaction' : 'a committed stub';
			async function overStub(id, write) {
				await Computed.put(id, { id, sku: 'A', name: 'old' });
				const context = {};
				await transaction(context, async () => {
					await invalidate(id, context);
					if (staged) await write(context);
				});
				if (staged) return;
				assert.ok(Computed.primaryStore.getEntry(id).metadataFlags & INVALIDATED, 'premise: a stub');
				await write({});
			}

			it(`a put over ${where} indexes the new computed value`, async () => {
				const id = `put-${staged ? 'staged' : 'committed'}`;
				await overStub(id, (context) => Computed.put(id, { id, sku: 'B', name: 'new' }, context));
				const entry = Computed.primaryStore.getEntry(id);
				assert.ok(!(entry.metadataFlags & INVALIDATED));
				assert.equal(entry.value.name, 'new');
				assert.ok(indexedKeys('upper', id).includes('NEW'));
				assert.deepEqual(indexedKeys('sku', id), ['B']);
				assert.deepEqual(indexedKeys('skuKey', id), ['b']);
			});

			it(`a delete of ${where} removes it`, async () => {
				const id = `delete-${staged ? 'staged' : 'committed'}`;
				await overStub(id, (context) => Computed.delete(id, context));
				assert.equal(Computed.primaryStore.getEntry(id)?.value ?? null, null);
				assert.deepEqual(indexedKeys('sku', id), []);
				assert.deepEqual(indexedKeys('skuKey', id), []);
			});
		}

		it('evicting a stub removes it', async () => {
			await Computed.put('evicted', { id: 'evicted', sku: 'A', name: 'old' });
			const context = {};
			await transaction(context, () => invalidate('evicted', context));
			const stub = Computed.primaryStore.getEntry('evicted');
			assert.ok(stub.metadataFlags & INVALIDATED, 'premise: a stub');
			await Computed.evict('evicted', stub.value, stub.version);
			assert.equal(Computed.primaryStore.getEntry('evicted')?.value ?? undefined, undefined);
			assert.deepEqual(indexedKeys('sku', 'evicted'), []);
			assert.deepEqual(indexedKeys('skuKey', 'evicted'), []);
		});
	});

	it('loads resolver inputs when an indexed query selects a computed index', async () => {
		const Computed = table({
			database: 'test',
			table: 'ResidencyComputedRead',
			attributes: [
				{ name: 'id', isPrimaryKey: true },
				{ name: 'sku', indexed: true },
				{ name: 'name' },
				{ name: 'upper', indexed: true, computed: true },
			],
			audit: true,
		});
		Computed.setComputedAttribute('upper', (record) => record.name.toUpperCase());
		const loaded = [];
		Computed.sourcedFrom(
			class extends Resource {
				static async load(entry) {
					loaded.push(entry.key);
					return { key: entry.key, value: { id: entry.key, sku: 'A1', name: 'resident' }, metadataFlags: 0 };
				}
			},
			{ intermediateSource: true }
		);
		await Computed.put('computed', { id: 'computed', sku: 'A1', name: 'original' });
		const context = {};
		await transaction(context, async () => {
			const resource = await Computed.getResource('computed', context, { ensureLoaded: false });
			resource._writeInvalidate('computed', { id: 'computed', sku: 'A1', upper: 'ORIGINAL' }, { residencyId: 123 });
		});
		const records = [];
		for await (const record of Computed.search({
			conditions: [{ attribute: 'sku', value: 'A1' }],
			select: ['id', 'upper'],
		}))
			records.push(record);
		assert.deepEqual(records, [{ id: 'computed', upper: 'RESIDENT' }]);
		assert.deepEqual(loaded, ['computed']);
	});

	for (const operations of [
		['put', 'invalidate'],
		['invalidate', 'put'],
		['invalidate', 'invalidate'],
		['invalidate', 'delete'],
	]) {
		it(`maintains indexes for ${operations.join(' then ')} in one transaction`, async () => {
			await Records.put('record', { name: 'indexed', body: 'complete' });
			const context = {};
			await transaction(context, async () => {
				for (const [index, operation] of operations.entries()) {
					const name = index === 0 ? 'middle' : 'final';
					if (operation === 'put') await Records.put('record', { name, body: 'complete' }, context);
					else if (operation === 'delete') await Records.delete('record', context);
					else {
						const resource = await Records.getResource('record', context, { ensureLoaded: false });
						resource._writeInvalidate('record', { name }, { residencyId: 123 });
					}
				}
			});
			for (const name of ['indexed', 'middle', 'final']) {
				const expected = name === 'final' && operations[1] !== 'delete' ? [{ id: 'record' }] : [];
				assert.deepEqual(await query(['id'], [{ attribute: 'name', value: name }]), expected, name);
				const indexed = Array.from(Records.indices.name.getRange({}))
					.filter(({ key, value }) => key === name && value === 'record')
					.map(({ value }) => ({ id: value }));
				assert.deepEqual(indexed, expected, `${name}: raw index must not retain orphaned entries`);
			}
		});
	}

	it('retains stored vectors on invalidation and maintains their graph on replacement and deletion', async function () {
		if (process.env.HARPER_STORAGE_ENGINE === 'lmdb') this.skip();
		const Vectors = table({
			database: 'test',
			table: 'ResidencyVectors',
			attributes: [
				{ name: 'id', isPrimaryKey: true },
				{ name: 'vector', indexed: { type: 'HNSW', nativePlane: false, quantization: 'none' }, type: 'Array' },
			],
			audit: true,
		});
		await Vectors.put('vector', { vector: [1, 0] });
		async function invalidate(projection, options) {
			const context = {};
			await transaction(context, async () => {
				const resource = await Vectors.getResource('vector', context, { ensureLoaded: false });
				resource._writeInvalidate('vector', projection, options);
			});
		}
		await invalidate();
		assert.deepEqual(Array.from(Vectors.primaryStore.getEntry('vector').value.vector), [1, 0]);
		await invalidate({ vector: [0, 1] }, { residencyId: 123 });
		const index = Vectors.indices.vector;
		const nodeId = index.getSync('vector');
		assert.deepEqual(Array.from(index.getSync(nodeId).vector), [0, 1]);
		await Vectors.delete('vector');
		assert.equal(index.getSync('vector'), undefined, 'deleting the stub must remove its graph node');
	});

	for (const [label, residents, newer, shouldInvalidate] of [
		['an equal-version copy addressed to a resident', 'self', false, false],
		['a newer invalidation', 'self', true, true],
		['a demotion to a non-resident', 'remote', false, true],
		['an ordinary cache invalidation', undefined, false, true],
	]) {
		it(`preserves the correct full/stub state for ${label}`, async () => {
			const id = 'copy-target';
			await Records.put(id, { id, name: 'indexed', body: 'complete' });
			const before = Records.primaryStore.getEntry(id);
			const residencyId = residents ? 456 : undefined;
			if (residents)
				Records.dbisDB.putSync(
					[Symbol.for('residency_by_id'), residencyId],
					[residents === 'self' ? server.hostname : 'other-resident']
				);
			const context = { sourceApply: true, timestamp: before.version + (newer ? 1 : 0) };
			await transaction(context, async () => {
				const resource = await Records.getResource(id, context, { ensureLoaded: false });
				resource._writeInvalidate(
					id,
					{ id, name: 'indexed' },
					{ version: before.version + (newer ? 1 : 0), nodeId: before.nodeId ?? 0, residencyId }
				);
			});
			const after = Records.primaryStore.getEntry(id);
			assert.equal(Boolean(after.metadataFlags & INVALIDATED), shouldInvalidate);
			assert.equal(after.value.body, shouldInvalidate ? undefined : 'complete');
		});
	}
});
