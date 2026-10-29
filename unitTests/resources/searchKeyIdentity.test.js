const assert = require('node:assert');
const { inspect } = require('node:util');
const { setupTestDBPath } = require('../testUtils');
const { table } = require('#src/resources/databases');
const { executeConditions, CandidateKeySet, distinctKeys, filterByType } = require('#src/resources/search');
const { writeKeyId } = require('#src/resources/DatabaseTransaction');
const { compareKeys, fromBufferKey, toBufferKey } = require('ordered-binary');
const { setMainIsWorker } = require('#js/server/threads/manageThreads');

async function collect(iterable) {
	const out = [];
	for await (const record of iterable) out.push(record);
	return out;
}

describe('search key identity and the "..." between alias', () => {
	let Keyed;
	let Ranged;
	const pendingKeys = Array.from({ length: 40 }, (_, i) => `p${String(i).padStart(2, '0')}`);

	before(async () => {
		setupTestDBPath();
		setMainIsWorker(true);
		Keyed = table({
			table: 'SearchKeyIdentityKeyed',
			database: 'test',
			attributes: [
				{ name: 'id', isPrimaryKey: true },
				{ name: 'grp', indexed: true },
				{ name: 'status', indexed: true },
				{ name: 'other', indexed: true },
			],
		});
		for (const id of pendingKeys) await Keyed.put(id, { grp: 'g1', status: 'pending' });
		// keeps `status = approved` from being the cheaper condition, so `grp` leads and `status` is filtered
		for (let i = 0; i < 200; i++) await Keyed.put(`z${i}`, { grp: 'g2', status: 'approved' });
		await Keyed.put(['t', 7], { grp: 'g1', status: 'approved' });
		await Keyed.put(['t', '7'], { grp: 'g1', status: 'rejected' });
		await Keyed.put('t\x007', { grp: 'g1', status: 'rejected' });
		await Keyed.put(['a\x00b', 'c'], { grp: 'g1', status: 'approved' });
		await Keyed.put(['a', 'b\x00c'], { grp: 'g1', status: 'rejected' });
		await Keyed.put(['tenant', 'item'], { grp: 'or_a', status: 'or_b', other: 'x' });
		await Keyed.put('scalar', { grp: 'or_a', status: 'or_b', other: 'x' });

		Ranged = table({
			table: 'SearchKeyIdentityRanged',
			database: 'test',
			attributes: [{ name: 'id', isPrimaryKey: true }, { name: 'indexedNum', indexed: true }, { name: 'plainNum' }],
		});
		for (const n of [1, 3, 5, 7]) await Ranged.put(`r${n}`, { indexedNum: n, plainNum: n });
	});

	after(() => {
		Keyed?.dropTable();
		Ranged?.dropTable();
	});

	it('does not let an id-filtered condition admit a different key with the same NUL-joined text', async () => {
		const results = await collect(
			Keyed.search({
				conditions: [
					{ attribute: 'grp', value: 'g1' },
					{ attribute: 'status', value: 'approved' },
				],
			})
		);
		const statuses = results.map((record) => record.status);
		assert.deepStrictEqual([...new Set(statuses)], ['approved']);
		assert.strictEqual(results.length, 2);
	});

	it('returns an array-keyed record once from an OR over two conditions it matches, on every iteration', async () => {
		const results = executeConditions(
			[
				{ attribute: 'grp', value: 'or_a' },
				{ attribute: 'status', value: 'or_b' },
			],
			'or',
			Keyed,
			Keyed._readTxnForContext(undefined),
			{},
			undefined,
			(entries) => entries
		);
		// a RocksDB range iterable is single-use, so only LMDB can be read a second time
		const passes = process.env.HARPER_STORAGE_ENGINE === 'lmdb' ? 2 : 1;
		for (let pass = 0; pass < passes; pass++) {
			const ids = (await collect(results)).map((entry) => entry?.key ?? entry);
			assert.deepStrictEqual(ids.sort(compareKeys), [['tenant', 'item'], 'scalar'].sort(compareKeys), `pass ${pass}`);
		}
	});

	it('pages an OR whose branches yield a composite key as an entry and as a bare key', async () => {
		const conditions = [
			{ attribute: 'id', value: ['tenant', 'item'] },
			{ attribute: 'grp', value: 'or_a' },
		];
		const expected = [['tenant', 'item'], 'scalar'].sort(compareKeys);
		const all = await collect(Keyed.search({ operator: 'or', conditions, select: ['id'] }));
		assert.deepStrictEqual(all.map((record) => record.id).sort(compareKeys), expected);
		const page = await collect(Keyed.search({ operator: 'or', conditions, select: ['id'], offset: 1, limit: 5 }));
		assert.strictEqual(page.length, 1);
		assert.ok(expected.some((id) => compareKeys(id, page[0].id) === 0));
	});

	for (const comparator of ['...', 'between']) {
		it(`includes the upper bound of "${comparator}" on a reversed index scan and on the primary key`, async () => {
			const reversed = await collect(
				Ranged.search({
					conditions: [{ attribute: 'indexedNum', comparator, value: [1, 5] }],
					sort: { attribute: 'indexedNum', descending: true },
					select: ['id'],
				})
			);
			assert.deepStrictEqual(
				reversed.map((record) => record.id),
				['r5', 'r3', 'r1']
			);
			const byKey = await collect(
				Ranged.search({ conditions: [{ attribute: 'id', comparator, value: ['r1', 'r5'] }], select: ['id'] })
			);
			assert.deepStrictEqual(byKey.map((record) => record.id).sort(), ['r1', 'r3', 'r5']);
		});
	}

	for (const [label, attribute] of [
		['indexed', 'indexedNum'],
		['unindexed', 'plainNum'],
	]) {
		it(`includes the upper bound of the "..." alias on an ${label} attribute`, async () => {
			const results = await collect(
				Ranged.search({ conditions: [{ attribute, comparator: '...', value: [1, 5] }], select: ['id'] })
			);
			assert.deepStrictEqual(results.map((record) => record.id).sort(), ['r1', 'r3', 'r5']);
		});
	}

	it('reports a key as new once, however it decodes', () => {
		const keys = new CandidateKeySet();
		assert.strictEqual(keys.addIfAbsent(['a\x00b', 'c']), true);
		assert.strictEqual(keys.addIfAbsent(['a\x00b', 'c']), false);
		assert.strictEqual(keys.addIfAbsent(['a', 'b\x00c']), true);
		assert.strictEqual(keys.addIfAbsent('a\x00b\x00c'), true);
		assert.strictEqual(keys.addIfAbsent(5), true);
		assert.strictEqual(keys.addIfAbsent(5n), false);
		assert.strictEqual(keys.addIfAbsent(2n ** 62n), true);
		assert.strictEqual(keys.addIfAbsent(2n ** 62n), false);
		assert.strictEqual(keys.addIfAbsent(true), true);
		assert.strictEqual(keys.addIfAbsent(true), false);
		assert.strictEqual(keys.size, 6);
	});

	it('dedupes an OR union that a synchronous index returns as a plain array', () => {
		const entries = [['k', 1], { key: ['k', 1] }, 'k1', { key: 'k1' }, ['k', 2]];
		const distinct = distinctKeys(entries);
		assert.strictEqual(distinct.length, 3);
		assert.strictEqual(distinctKeys(entries).length, 3, 'each call starts with an empty seen-set');
	});

	describe('primary-key conditions on every route a plan can take', () => {
		let Composite;
		let Numeric;
		const all = [
			[1, 'x'],
			['a\x00b', 'c'],
			['a', 'b\x00c'],
			['n', 5n, 'x'],
			['solo'],
			['t', 7],
			['t', '7'],
			['tenant', 'item'],
			['x', 'tenant'],
		];
		const allBut = (...excluded) => all.filter((id) => !excluded.some((other) => compareKeys(id, other) === 0));
		const routes = (keyRange) => ({
			'leading': (condition) => ({ conditions: [condition] }),
			'id filter after an index lead': (condition) => ({
				conditions: [{ attribute: 'grp', value: 'g' }, condition],
				enforceExecutionOrder: true,
			}),
			'record filter after a key-range lead': (condition) => ({
				conditions: [keyRange, condition],
				enforceExecutionOrder: true,
			}),
			'nested group': (condition) => ({
				conditions: [
					{ attribute: 'grp', value: 'g' },
					{ operator: 'or', conditions: [condition, { attribute: 'id', value: 'none' }] },
				],
				enforceExecutionOrder: true,
			}),
		});
		const keyRoutes = routes({ attribute: 'id', comparator: 'ge', value: 0 });
		// a record reports its id as written or as decoded depending on the route: 5n or 5, ['solo'] or 'solo'
		const asStored = (keys) => keys.map((key) => fromBufferKey(toBufferKey(key))).sort(compareKeys);
		async function ids(table, query) {
			const records = await collect(table.search(query));
			return asStored(records.map((record) => record.id));
		}

		before(async () => {
			Composite = table({
				table: 'SearchKeyIdentityComposite',
				database: 'test',
				attributes: [{ name: 'id', isPrimaryKey: true }, { name: 'grp', indexed: true }, { name: 'tags' }],
			});
			for (const id of all) await Composite.put(id, { grp: 'g', tags: id[0] === 't' ? ['t', 'u'] : ['v'] });
			Numeric = table({
				table: 'SearchKeyIdentityNumeric',
				database: 'test',
				attributes: [
					{ name: 'id', isPrimaryKey: true },
					{ name: 'grp', indexed: true },
					{ name: 'kind', indexed: true },
					{ name: 'targetIds' },
				],
			});
			await Numeric.put(0n, { grp: 'g' });
			await Numeric.put(5n, { grp: 'g', kind: 'five', targetIds: [5, 5n] });
			await Numeric.put(9, { grp: 'g' });
		});

		after(() => {
			Composite?.dropTable();
			Numeric?.dropTable();
		});

		for (const [condition, expected] of [
			[{ attribute: 'id', value: ['t', 7] }, [['t', 7]]],
			[{ attribute: 'id', value: 't' }, []],
			[{ attribute: 'id', value: 'solo' }, [['solo']]],
			[{ attribute: 'id', value: ['solo'] }, [['solo']]],
			[{ attribute: ['id'], value: ['t', 7] }, [['t', 7]]],
			[{ attribute: 'id', comparator: 'ne', value: ['t', 7] }, allBut(['t', 7])],
			[
				{
					attribute: 'id',
					comparator: 'in',
					value: [
						['t', 7],
						['a\x00b', 'c'],
					],
				},
				[
					['a\x00b', 'c'],
					['t', 7],
				],
			],
			[{ attribute: 'id', comparator: 'in', value: ['t'] }, []],
			[{ attribute: 'id', comparator: 'not_in', value: [['t', 7]] }, allBut(['t', 7])],
			[
				{
					attribute: 'id',
					comparator: 'between',
					value: [
						['t', 1],
						['t', 9],
					],
				},
				[['t', 7]],
			],
			[
				{
					attribute: 'id',
					comparator: '...',
					value: [
						['t', 1],
						['t', 9],
					],
				},
				[['t', 7]],
			],
			[
				{
					attribute: 'id',
					comparator: 'not_between',
					value: [
						['t', 1],
						['t', 9],
					],
				},
				allBut(['t', 7]),
			],
			[
				{ attribute: 'id', comparator: 'gt', value: ['t', 7] },
				[
					['t', '7'],
					['tenant', 'item'],
					['x', 'tenant'],
				],
			],
			[
				{ attribute: 'id', comparator: 'lt', value: 'b' },
				[
					[1, 'x'],
					['a\x00b', 'c'],
					['a', 'b\x00c'],
				],
			],
			[
				{ attribute: 'id', comparator: 'prefix', value: ['t'] },
				[
					['t', 7],
					['t', '7'],
				],
			],
			[{ attribute: 'id', comparator: 'starts_with', value: 'ten' }, [['tenant', 'item']]],
			[{ attribute: 'id', comparator: 'starts_with', value: 'so' }, [['solo']]],
			[{ attribute: 'id', comparator: 'starts_with', value: '' }, allBut([1, 'x'])],
			[{ attribute: 'id', comparator: 'prefix', value: ['solo'] }, []],
			[{ attribute: 'id', comparator: 'prefix', value: [] }, all],
			[{ attribute: 'id', comparator: 'prefix', value: [null] }, all],
			[{ attribute: 'id', comparator: 'prefix', value: ['n', 5] }, [['n', 5n, 'x']]],
			[{ attribute: 'id', value: ['n', 5, 'x'] }, [['n', 5n, 'x']]],
		]) {
			it(`${inspect(condition)} matches the same composite keys on every route`, async () => {
				for (const [route, query] of Object.entries(keyRoutes)) {
					assert.deepStrictEqual(await ids(Composite, query(condition)), asStored(expected), route);
				}
			});
		}

		it('gives a key spelled as a tuple the result its decoded spelling gets', () => {
			const prefixConditions = [
				{ attribute: 'id', comparator: 'starts_with', value: '' },
				{ attribute: 'id', comparator: 'starts_with', value: 'so' },
				{ attribute: 'id', comparator: 'prefix', value: [null] },
				{ attribute: 'id', comparator: 'prefix', value: ['solo'] },
				{ attribute: 'id', comparator: 'prefix', value: ['t', 5] },
			];
			const identityConditions = [
				{ attribute: 'id', value: 'solo' },
				{ attribute: 'id', comparator: 'in', value: [5, -1, 0.1, 'solo'] },
				{ attribute: 'id', comparator: 'ne', value: -1 },
				{ attribute: 'id', comparator: 'ne', value: 'solo' },
			];
			// [5] decodes as 5 but stores other bytes than 5 does, so only the prefix comparators can agree on it
			for (const [conditions, keys] of [
				[prefixConditions, [[5], [5n], [1, 'x'], ['solo'], [['solo']], ['t', 5n, 'x']]],
				[identityConditions, [['solo'], [['solo']], [-1], [-1n], [0.1], ['t', 5n, 'x']]],
			]) {
				for (const condition of conditions) {
					const filter = filterByType(condition, Composite, null, null, true);
					for (const key of keys) {
						const decoded = fromBufferKey(toBufferKey(key));
						assert.strictEqual(
							filter({ id: key }),
							filter.idFilter(decoded),
							`${inspect(condition)} on ${inspect(key)}`
						);
					}
				}
			}
		});

		it('still matches an array attribute that is not the key element by element', async () => {
			for (const [route, query] of Object.entries(keyRoutes)) {
				assert.deepStrictEqual(
					await ids(Composite, query({ attribute: 'tags', value: 't' })),
					[
						['t', 7],
						['t', '7'],
					],
					route
				);
			}
		});

		for (const [condition, expected] of [
			[{ attribute: 'id', value: 5 }, [5n]],
			[{ attribute: 'id', value: 0 }, [0n]],
			[{ attribute: 'id', comparator: 'in', value: [0n, 9n] }, [0n, 9]],
			[{ attribute: 'id', comparator: 'ne', value: 5 }, [0n, 9]],
		]) {
			it(`${inspect(condition)} treats a BigInt key and its number as one key`, async () => {
				for (const [route, query] of Object.entries(keyRoutes)) {
					assert.deepStrictEqual(await ids(Numeric, query(condition)), asStored(expected), route);
				}
			});
		}

		it('holds one entry per stored key, whichever spelling and method adds it', () => {
			const spellings = [
				[5, 5n],
				[0, 0n],
				[2 ** 62, 2n ** 62n],
				[2 ** 62, 2n ** 62n + 1n],
				[0, -0],
				['t', ['t']],
				['t', [['t']]],
				[5, [5]],
				[-1, [-1]],
				[NaN, [NaN]],
				[-1n, [[-1]]],
				[0.1, [0.1]],
				['a\x00b', ['a', 'b']],
				[
					['a\x00b', 'c'],
					['a', 'b\x00c'],
				],
			];
			for (const [first, second] of spellings) {
				const sameKey = writeKeyId(first) === writeKeyId(second);
				for (const [a, b] of [
					[first, second],
					[second, first],
				]) {
					const label = inspect([a, b]);
					const added = new CandidateKeySet();
					added.add(a);
					added.add(b);
					assert.strictEqual(added.size, sameKey ? 1 : 2, `add ${label}`);
					assert.strictEqual(added.has(a) && added.has(b), true, `has ${label}`);
					const checked = new CandidateKeySet();
					assert.strictEqual(checked.addIfAbsent(a), true, `addIfAbsent ${label}`);
					assert.strictEqual(checked.addIfAbsent(b), !sameKey, `addIfAbsent ${label}`);
					const single = new CandidateKeySet();
					single.add(a);
					assert.strictEqual(single.has(b), sameKey, `has ${label}`);
				}
			}
			assert.deepStrictEqual(distinctKeys([0n, 0]), [0n]);
			assert.deepStrictEqual(distinctKeys([0, 0n]), [0]);
		});

		it('keeps a single related id when the adaptive id filter collects it as a number and a BigInt', () => {
			const relationFilter = filterByType({ attribute: 'kind', value: 'five' }, Numeric, null, null, false, 1000);
			relationFilter.to = 'targetIds';
			assert.strictEqual(relationFilter({ kind: 'miss' }), false);
			assert.strictEqual(relationFilter.idFilter.idSet.size, 1);
			assert.strictEqual(relationFilter.idFilter.onlyId, 5);
		});
	});
});
