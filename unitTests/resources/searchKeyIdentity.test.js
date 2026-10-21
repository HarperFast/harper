const assert = require('node:assert');
const { setupTestDBPath } = require('../testUtils');
const { table } = require('#src/resources/databases');
const { executeConditions } = require('#src/resources/search');
const { compareKeys } = require('ordered-binary');
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
		// composite keys whose NUL-joined text is the same: ['t', 7], ['t', '7'] and 't\0007'
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
		Keyed.dropTable();
		Ranged.dropTable();
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
		const all = await collect(Keyed.search({ operator: 'or', conditions, select: ['id'] }));
		assert.strictEqual(all.length, 2);
		const page = await collect(Keyed.search({ operator: 'or', conditions, select: ['id'], offset: 1, limit: 5 }));
		assert.strictEqual(page.length, 1);
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
});
