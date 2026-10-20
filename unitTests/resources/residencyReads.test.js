require('../testUtils');
const assert = require('node:assert');
const { setupTestDBPath } = require('../testUtils');
const { table } = require('#src/resources/databases');
const { Resource } = require('#src/resources/Resource');
const { transaction } = require('#src/resources/transaction');
const { setMainIsWorker } = require('#js/server/threads/manageThreads');
const { ServerError } = require('#src/utility/errors/hdbError');
const { INVALIDATED } = require('#src/resources/Table');
const { server } = require('#src/server/Server');

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
		// A retained audit blob is still readable and can be referenced by a later write.
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
		if (process.env.HARPER_STORAGE_ENGINE === 'lmdb') this.skip(); // Matches the existing HNSW suite's engine coverage.
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
