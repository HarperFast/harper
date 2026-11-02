require('../testUtils');
const assert = require('node:assert');
const { setupTestDBPath } = require('../testUtils');
const { table } = require('#src/resources/databases');
const { transaction } = require('#src/resources/transaction');
const { setMainIsWorker } = require('#src/server/threads/manageThreads');
const { INVALIDATED } = require('#src/resources/Table');
const { waitFor } = require('../waitFor');

describe('Invalidated cache rows under negated, grouped and sorted primary-key reads', function () {
	this.timeout(20_000);
	const database = 'test_invalidated_stub_key_sort';
	let Rows;
	const source = { loads: 0, missing: new Set(), fail: false, gate: null };

	before(async () => {
		setupTestDBPath();
		setMainIsWorker(true);
		Rows = table({
			database,
			table: 'StubRows',
			audit: true,
			attributes: [
				{ name: 'id', isPrimaryKey: true },
				{ name: 'body', type: 'String' },
			],
		});
		Rows.sourcedFrom({
			async get(id) {
				source.loads++;
				if (source.gate) await source.gate;
				if (source.fail) throw new Error('source unavailable');
				if (source.missing.has(id)) return;
				return { id, body: 'fresh ' + id };
			},
		});
	});

	beforeEach(async () => {
		await Rows.put('a', { id: 'a', body: 'zzz' });
		await Rows.put('b', { id: 'b', body: 'aaa' });
		await Rows.put('c', { id: 'c', body: 'mmm' });
		await invalidateNull('c');
		Object.assign(source, { loads: 0, missing: new Set(), fail: false, gate: null });
	});

	async function invalidateNull(id) {
		const context = {};
		await transaction(context, async () => {
			const resource = await Rows.getResource(id, context, { ensureLoaded: false });
			resource._writeInvalidate(id);
		});
		const entry = Rows.primaryStore.getEntry(id);
		assert.ok(entry.metadataFlags & INVALIDATED, `premise: ${id} is invalidated`);
		assert.strictEqual(entry.value, null, `premise: ${id} has no record`);
	}

	async function rowsOf(query, context, TableClass = Rows) {
		const rows = [];
		for await (const row of TableClass.search(query, context)) rows.push(`${row.id}:${row.body}`);
		return rows;
	}

	const inAC = { attribute: 'id', comparator: 'in', value: ['a', 'c'] };
	const geA = { attribute: 'id', comparator: 'ge', value: 'a' };

	describe('a negated or grouped primary-key condition keeps and reloads the stub', () => {
		const cases = [
			['id in (a, c) + id ne b', [inAC, { attribute: 'id', comparator: 'ne', value: 'b' }]],
			['id in (a, c) + id not_equals b', [inAC, { attribute: 'id', comparator: 'not_equals', value: 'b' }]],
			['id in (a, c) + id not_in (b)', [inAC, { attribute: 'id', comparator: 'not_in', value: ['b'] }]],
			[
				'id in (a, c) + id not_between (b, b)',
				[inAC, { attribute: 'id', comparator: 'not_between', value: ['b', 'b'] }],
			],
			['id in (a, c) + id not_starts_with b', [inAC, { attribute: 'id', comparator: 'not_starts_with', value: 'b' }]],
			[
				'id ge a + (id = a or id = c)',
				[
					geA,
					{
						operator: 'or',
						conditions: [
							{ attribute: 'id', value: 'a' },
							{ attribute: 'id', value: 'c' },
						],
					},
				],
			],
			[
				'id ge a + (id ne b and id le c)',
				[
					geA,
					{
						operator: 'and',
						conditions: [
							{ attribute: 'id', comparator: 'ne', value: 'b' },
							{ attribute: 'id', comparator: 'le', value: 'c' },
						],
					},
				],
			],
			[
				'id ge a + (id = a or not (id in (a, b)))',
				[
					geA,
					{
						operator: 'or',
						conditions: [
							{ attribute: 'id', value: 'a' },
							{ attribute: 'id', comparator: 'not_in', value: ['a', 'b'] },
						],
					},
				],
			],
		];
		for (const [name, conditions] of cases) {
			it(name, async () => {
				assert.deepStrictEqual(await rowsOf({ enforceExecutionOrder: true, conditions }), ['a:zzz', 'c:fresh c']);
				assert.strictEqual(source.loads, 1);
			});
		}

		const dropping = [
			[
				'a negated non-key condition',
				{ conditions: [inAC, { attribute: 'body', comparator: 'not_equals', value: 'x' }] },
			],
			[
				'a group with a non-key member',
				{
					conditions: [
						geA,
						{
							operator: 'or',
							conditions: [
								{ attribute: 'id', value: 'c' },
								{ attribute: 'body', value: 'zzz' },
							],
						},
					],
				},
			],
			[
				'a record guard',
				{ conditions: [inAC, { attribute: 'id', comparator: 'not_equals', value: 'b' }], rowFilter: () => true },
			],
		];
		for (const [name, query] of dropping) {
			it(`${name} still drops the stub`, async () => {
				assert.deepStrictEqual(await rowsOf({ enforceExecutionOrder: true, ...query }), ['a:zzz']);
				assert.strictEqual(source.loads, 0);
			});
		}
	});

	describe('a sorted read places a reloaded stub by its fresh value', () => {
		const inABC = { attribute: 'id', comparator: 'in', value: ['a', 'b', 'c'] };
		const cases = [
			['id in (a, b, c)', inABC, undefined, ['b:aaa', 'c:fresh c', 'a:zzz']],
			['id in (a, b, c), limit 1', inABC, 1, ['b:aaa']],
			['id ge a', geA, undefined, ['b:aaa', 'c:fresh c', 'a:zzz']],
			['id ge a, limit 1', geA, 1, ['b:aaa']],
			['id ne b', { attribute: 'id', comparator: 'ne', value: 'b' }, undefined, ['c:fresh c', 'a:zzz']],
		];
		for (const [name, condition, limit, expected] of cases) {
			it(name, async () => {
				assert.deepStrictEqual(await rowsOf({ conditions: [condition], sort: { attribute: 'body' }, limit }), expected);
				assert.strictEqual(source.loads, 1);
			});
		}

		it('descending, with an offset', async () => {
			assert.deepStrictEqual(
				await rowsOf({ conditions: [geA], sort: { attribute: 'body', descending: true }, offset: 1, limit: 1 }),
				['c:fresh c']
			);
			assert.strictEqual(source.loads, 1);
		});

		it('a sort on the primary key alone does not reload rows outside the page', async () => {
			assert.deepStrictEqual(await rowsOf({ conditions: [geA], sort: { attribute: 'id' }, limit: 1 }), ['a:zzz']);
			assert.strictEqual(source.loads, 0);
		});

		it('a sorted read with no stubs calls no source', async () => {
			await Rows.get('c');
			await waitFor(() => !(Rows.primaryStore.getEntry('c')?.metadataFlags & INVALIDATED));
			source.loads = 0;
			assert.deepStrictEqual(await rowsOf({ conditions: [geA], sort: { attribute: 'body' } }), [
				'b:aaa',
				'c:fresh c',
				'a:zzz',
			]);
			assert.strictEqual(source.loads, 0);
		});

		const or = {
			operator: 'or',
			conditions: [
				{ attribute: 'id', value: 'a' },
				{ attribute: 'id', value: 'c' },
			],
		};
		it('a sort on the primary key reads a stub by its key', async () => {
			assert.deepStrictEqual(await rowsOf({ ...or, sort: { attribute: 'id', descending: true }, limit: 1 }), [
				'c:fresh c',
			]);
			await invalidateNull('a');
			await invalidateNull('b');
			source.loads = 0;
			assert.deepStrictEqual(
				await rowsOf({ conditions: [geA], sort: { attribute: 'id', next: { attribute: 'body' } }, limit: 2 }),
				['a:fresh a', 'b:fresh b']
			);
			assert.strictEqual(source.loads, 2);
		});

		it('a one-element primary-key path reads a stub by its key', async () => {
			assert.deepStrictEqual(await rowsOf({ ...or, sort: { attribute: ['id'], descending: true }, limit: 1 }), [
				'c:fresh c',
			]);
		});

		it('does not resolve a clause after the primary key on a stub', async () => {
			let resolved = 0;
			const { propertyResolvers } = Rows;
			propertyResolvers.bodyLength = (record) => {
				resolved++;
				return record.body.length;
			};
			try {
				assert.deepStrictEqual(
					await rowsOf({ ...or, sort: { attribute: 'id', next: { attribute: 'bodyLength' } }, limit: 1 }),
					['a:zzz']
				);
				assert.strictEqual(resolved, 0);
			} finally {
				delete propertyResolvers.bodyLength;
			}
		});

		for (const attribute of ['$updatedtime', '$updatedTime']) {
			it(`a sort on ${attribute} does not reload rows outside the page`, async () => {
				// only a union post-orders by a metadata attribute, and slice() materializes the row after the page
				const union = { operator: 'or', conditions: ['a', 'b', 'c'].map((value) => ({ attribute: 'id', value })) };
				assert.deepStrictEqual(await rowsOf({ ...union, sort: { attribute }, limit: 1 }), ['a:zzz']);
				assert.strictEqual(source.loads, 0);
			});
		}

		it('reloads a stub to sort it even when the select does not need its record', async () => {
			const ids = [];
			for await (const row of Rows.search({ conditions: [geA], sort: { attribute: 'body' }, select: ['id'] }))
				ids.push(row.id);
			assert.deepStrictEqual(ids, ['b', 'c', 'a']);
			assert.strictEqual(source.loads, 1);
		});

		it('leaves out a stub deleted at the source, and fills the page from the next row', async () => {
			source.missing.add('c');
			assert.deepStrictEqual(
				await rowsOf({ conditions: [geA], sort: { attribute: 'body', descending: true }, limit: 2 }),
				['a:zzz', 'b:aaa']
			);
			await invalidateNull('a');
			source.missing = new Set(['a']);
			assert.deepStrictEqual(await rowsOf({ conditions: [geA], sort: { attribute: 'id' }, limit: 1 }), ['b:aaa']);
		});

		it('does not load a row the source no longer has a second time when the read keeps absent rows', async () => {
			source.missing.add('c');
			const context = {};
			const transform = Rows.transformEntryForSelect(undefined, context, Rows._readTxnForContext(context), null, true);
			const prepared = await transform.prepareForSort(Rows.primaryStore.getEntry('c'));
			assert.equal(prepared.value, null);
			assert.ok(!(prepared.metadataFlags & INVALIDATED), 'the materializer must not take it for a stub to reload');
			assert.equal(await transform.call({}, prepared), null);
			assert.strictEqual(source.loads, 1);
		});

		for (const attribute of ['$updatedtime', ['$updatedtime']]) {
			it(`a one-element ${attribute} path does not reload rows outside the page`, async () => {
				const union = { operator: 'or', conditions: ['a', 'b', 'c'].map((value) => ({ attribute: 'id', value })) };
				assert.deepStrictEqual(await rowsOf({ ...union, sort: { attribute }, limit: 1 }), ['a:zzz']);
				assert.strictEqual(source.loads, 0);
			});
		}

		it('rejects the read when the source rejects a stub reload', async () => {
			source.fail = true;
			await assert.rejects(rowsOf({ conditions: [geA], sort: { attribute: 'body' }, limit: 1 }), /source unavailable/);
		});

		it('stops at a closed iterator while a stub reload is pending', async () => {
			await invalidateNull('a');
			source.loads = 0;
			let release;
			source.gate = new Promise((resolve) => (release = resolve));
			const iterator = Rows.search({ conditions: [geA], sort: { attribute: 'body' } })[Symbol.asyncIterator]();
			const first = iterator.next();
			await waitFor(() => source.loads === 1, 5000);
			await iterator.return();
			release();
			assert.deepStrictEqual(await first, { done: true, value: undefined });
			assert.strictEqual(source.loads, 1);
		});

		it('an only-if-cached read calls no source', async () => {
			const ids = [];
			for await (const row of Rows.search({ conditions: [geA], sort: { attribute: 'body' } }, { onlyIfCached: true }))
				ids.push(row.id);
			assert.deepStrictEqual(ids.sort(), ['a', 'b', 'c']);
			assert.strictEqual(source.loads, 0);
		});

		it('a local-only read still leaves the stub out', async () => {
			const rows = [];
			for await (const row of Rows.search({ conditions: [geA], sort: { attribute: 'body' } }, { replicateFrom: false }))
				rows.push(row.id);
			assert.deepStrictEqual(rows, ['b', 'a']);
			assert.strictEqual(source.loads, 0);
		});
	});

	describe('a stub that keeps its indexed attributes', () => {
		let Partial;
		const hook = { allow: false, calls: 0 };
		before(() => {
			Partial = table({
				database,
				table: 'PartialStubRows',
				audit: true,
				attributes: [
					{ name: 'id', isPrimaryKey: true },
					{ name: 'tag', type: 'String', indexed: true },
					{ name: 'body', type: 'String' },
				],
			});
			Partial.sourcedFrom({
				get(id) {
					source.loads++;
					return { id, tag: 't', body: 'fresh ' + id };
				},
			});
			Partial.prototype.allowStaleWhileRevalidate = function () {
				hook.calls++;
				return hook.allow;
			};
		});
		beforeEach(async () => {
			await Partial.put('a', { id: 'a', tag: 't', body: 'zzz' });
			await Partial.put('b', { id: 'b', tag: 't', body: 'aaa' });
			await Partial.put('c', { id: 'c', tag: 't', body: 'mmm' });
			const context = {};
			await transaction(context, async () => {
				const resource = await Partial.getResource('c', context, { ensureLoaded: false });
				resource._writeInvalidate('c');
			});
			const entry = Partial.primaryStore.getEntry('c');
			assert.ok(entry.metadataFlags & INVALIDATED, 'premise: c is invalidated');
			assert.deepStrictEqual({ ...entry.value }, { id: 'c', tag: 't' }, 'premise: c keeps only its indexed attribute');
			Object.assign(hook, { allow: false, calls: 0 });
			source.loads = 0;
		});
		const byTag = { conditions: [{ attribute: 'tag', value: 't' }], sort: { attribute: 'body' } };

		it('reloads it before sorting when stale-while-revalidate declines', async () => {
			assert.deepStrictEqual(await rowsOf({ ...byTag, limit: 2 }, undefined, Partial), ['b:aaa', 'c:fresh c']);
			assert.strictEqual(source.loads, 1);
			assert.strictEqual(hook.calls, 1);
		});

		it('sorts it by its stale record, and reloads it once in the background, when stale-while-revalidate allows', async () => {
			hook.allow = true;
			assert.deepStrictEqual(await rowsOf({ ...byTag, limit: 1 }, undefined, Partial), ['c:undefined']);
			await waitFor(() => source.loads === 1, 5000);
			assert.strictEqual(hook.calls, 1);
		});

		it('still applies the row filter to the reloaded record', async () => {
			const rowFilter = (record) => record.body !== 'fresh c';
			assert.deepStrictEqual(await rowsOf({ ...byTag, rowFilter }, undefined, Partial), ['b:aaa', 'a:zzz']);
			assert.strictEqual(source.loads, 1);
		});
	});
});
