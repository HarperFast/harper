const assert = require('node:assert');
const { setupTestDBPath } = require('../testUtils');
const { table } = require('#src/resources/databases');
const { setTimeout: delay } = require('node:timers/promises');
const { getFileId, setDeletionDelay } = require('#src/resources/blob');
const { transaction } = require('#src/resources/transaction');
const { getIdOfRemoteNode } = require('#src/resources/nodeIdMapping');
const isLMDB = process.env.HARPER_STORAGE_ENGINE === 'lmdb';
const { setMainIsWorker } = require('#js/server/threads/manageThreads');

function permutations(values) {
	if (values.length === 0) return [[]];
	return values.flatMap((value, index) =>
		permutations(values.filter((_, other) => other !== index)).map((rest) => [value, ...rest])
	);
}

let nextTimestamp = Date.now() + 1_000_000;

const cases = [
	{
		name: 'removes omitted fields and preserves newer sets and additions',
		lmdbVersionRegressionOrders: ['201'],
		writes: [
			['put', { a: 'v0', b: 'v0', c: 'stale', counter: 10 }],
			['put', { a: 'v1-put', b: 'v1-put', counter: 100 }],
			['patch', { b: 'v2-patch', counter: { __op__: 'add', value: 5 } }],
		],
		expected: { a: 'v1-put', b: 'v2-patch', counter: 105 },
	},
	{
		name: 'preserves newer-only fields and adds onto an omitted field',
		lmdbVersionRegressionOrders: ['201'],
		writes: [
			['put', { a: 'old', c: 'stale', counter: 10 }],
			['put', { a: 'replacement' }],
			['patch', { b: 'introduced', counter: { __op__: 'add', value: 5 } }],
		],
		expected: { a: 'replacement', b: 'introduced', counter: 5 },
	},
	{
		name: 'replays multiple newer patches chronologically',
		lmdbVersionRegressionOrders: ['0312', '2013', '2031', '2301', '3012', '3021', '3102', '3120', '3201'],
		writes: [
			['put', { c: 'stale', counter: 10 }],
			['put', { a: 'replacement', counter: 100 }],
			['patch', { b: 'first', counter: { __op__: 'add', value: 5 } }],
			['patch', { b: 'last', counter: { __op__: 'add', value: 7 } }],
		],
		expected: { a: 'replacement', b: 'last', counter: 112 },
	},
	{
		name: 'replaces with an empty body before applying newer patches',
		lmdbVersionRegressionOrders: ['201'],
		writes: [
			['put', { c: 'stale', counter: 10 }],
			['put', {}],
			['patch', { b: 'introduced', counter: { __op__: 'add', value: 5 } }],
		],
		expected: { b: 'introduced', counter: 5 },
	},
	{
		name: 'lets a newer full PUT supersede all older writes',
		writes: [
			['put', { c: 'stale', counter: 10 }],
			['patch', { b: 'patch', counter: { __op__: 'add', value: 5 } }],
			['put', { a: 'newest' }],
		],
		expected: { a: 'newest' },
	},
];

for (const loadAsInstance of [true, false]) {
	describe(`Out-of-order full PUT replacement (loadAsInstance=${loadAsInstance}, harper#3404)`, () => {
		let T;

		before(() => {
			setupTestDBPath();
			setMainIsWorker(true);
			T = table({
				table: `FullPut${loadAsInstance}`,
				database: 'outOfOrderFullPut',
				attributes: [
					{ name: 'id', isPrimaryKey: true },
					{ name: 'c', indexed: true },
				],
				audit: true,
			});
			T.loadAsInstance = loadAsInstance;
		});

		for (const [caseIndex, { name, writes, expected, lmdbVersionRegressionOrders = [] }] of cases.entries()) {
			for (const order of permutations(writes.map((_, index) => index))) {
				// Other LMDB permutations hit the independent entry.version regression (#3388).
				const test = isLMDB && lmdbVersionRegressionOrders.includes(order.join('')) ? it.skip : it;
				test(`${name}: arrival ${order.join(',')}`, async () => {
					const id = `${caseIndex}-${order.join('-')}`;
					const timestamp = (nextTimestamp += 1000);
					for (const index of order) {
						const [method, value] = writes[index];
						await T[method](id, structuredClone(value), { timestamp: timestamp + index });
					}
					assert.deepStrictEqual({ ...(await T.get(id)) }, { id, ...expected });
					assert.deepStrictEqual({ ...T.primaryStore.getEntry(id).value }, { id, ...expected });
					for await (const record of T.search({
						conditions: [{ attribute: 'c', comparator: 'equals', value: 'stale' }],
					}))
						assert.notStrictEqual(record.id, id);
				});
			}
		}
	});

	describe(`Retained history boundaries (loadAsInstance=${loadAsInstance})`, () => {
		let T;
		before(() => {
			setupTestDBPath();
			setMainIsWorker(true);
			T = table({
				table: `Boundaries${loadAsInstance}`,
				database: 'fullPutBoundaries',
				attributes: [{ name: 'id', isPrimaryKey: true }],
				audit: true,
			});
			T.loadAsInstance = loadAsInstance;
		});

		it('preserves uncollected newer fields when the audit walk reaches its depth cap', async function () {
			if (isLMDB) return this.skip();
			const timestamp = (nextTimestamp += 100_000);
			nextTimestamp += 2000;
			await T.put('capped', { c: 'old' }, { timestamp });
			await T.patch('capped', { early: 'newer' }, { timestamp: timestamp + 10 });
			for (let i = 1; i <= 1010; i++) {
				await T.patch('capped', { seq: i }, { timestamp: timestamp + 10 + i });
			}
			await T.put('capped', { a: 'replacement' }, { timestamp: timestamp + 5 });
			assert.deepStrictEqual(
				{ ...(await T.get('capped')) },
				{
					id: 'capped',
					c: 'old',
					early: 'newer',
					seq: 1010,
					a: 'replacement',
				}
			);
		});

		it('preserves uncollected newer fields when an audit entry is missing', async function () {
			if (!isLMDB) return this.skip();
			const timestamp = (nextTimestamp += 1000);
			await T.put('missing', { c: 'old' }, { timestamp });
			await T.patch('missing', { early: 'newer' }, { timestamp: timestamp + 10 });
			const middle = [...T.auditStore.getRange({ start: 0, end: Infinity })].find(
				(entry) => entry.recordId === 'missing' && entry.version === timestamp + 10
			);
			assert.ok(middle);
			await T.patch('missing', { latest: 'newest' }, { timestamp: timestamp + 20 });
			await T.auditStore.remove(middle.key);
			assert.equal(T.auditStore.get(middle.txnLogKey, T.tableId, 'missing'), undefined);
			await T.put('missing', { a: 'replacement' }, { timestamp: timestamp + 5 });
			assert.deepStrictEqual(
				{ ...(await T.get('missing')) },
				{
					id: 'missing',
					c: 'old',
					early: 'newer',
					latest: 'newest',
					a: 'replacement',
				}
			);
		});

		it('preserves timestamp metadata while storing the original PUT in audit history', async () => {
			const Metadata = table({
				table: `Metadata${loadAsInstance}`,
				database: 'fullPutBoundaries',
				audit: true,
				attributes: [
					{ name: 'id', isPrimaryKey: true },
					{ name: 'created', type: 'Float', assignCreatedTime: true },
					{ name: 'updated', type: 'Float', assignUpdatedTime: true },
				],
			});
			Metadata.loadAsInstance = loadAsInstance;
			const timestamp = (nextTimestamp += 1000);
			await Metadata.put('metadata', { c: 'stale' }, { timestamp });
			await Metadata.patch('metadata', { b: 'newer' }, { timestamp: timestamp + 20 });
			await Metadata.put('metadata', { a: 'replacement' }, { timestamp: timestamp + 10 });
			assert.deepStrictEqual(
				{ ...(await Metadata.get('metadata')) },
				{
					id: 'metadata',
					a: 'replacement',
					b: 'newer',
					created: timestamp,
					updated: timestamp + 20,
				}
			);
			const audit = [...Metadata.auditStore.getRange({ start: 0, end: Infinity })].find(
				(entry) =>
					entry.tableId === Metadata.tableId && entry.recordId === 'metadata' && entry.version === timestamp + 10
			);
			assert.ok(audit);
			assert.deepStrictEqual(
				{ ...audit.getValue(Metadata.primaryStore) },
				{
					id: 'metadata',
					a: 'replacement',
					created: timestamp,
					updated: timestamp + 10,
				}
			);
		});

		it('retains a newer-only file-backed blob after the reclamation window', async () => {
			const Blobs = table({
				table: `Blobs${loadAsInstance}`,
				database: 'fullPutBoundaries',
				audit: true,
				attributes: [
					{ name: 'id', isPrimaryKey: true },
					{ name: 'blob', type: 'Blob' },
				],
			});
			Blobs.loadAsInstance = loadAsInstance;
			const timestamp = (nextTimestamp += 1000);
			const content = 'newer blob'.repeat(4096);
			await Blobs.put('blob', { c: 'stale' }, { timestamp });
			await Blobs.patch('blob', { blob: new Blob([content]) }, { timestamp: timestamp + 20 });
			const fileId = getFileId((await Blobs.get('blob')).blob);
			assert.ok(fileId, 'must use a file-backed blob');
			setDeletionDelay(0);
			try {
				await Blobs.put('blob', { a: 'replacement' }, { timestamp: timestamp + 10 });
				// Assert a non-event after the configured reclamation window.
				await delay(30);
				const record = await Blobs.get('blob');
				assert.equal(record.c, undefined);
				assert.strictEqual(getFileId(record.blob), fileId);
				assert.strictEqual(await record.blob.text(), content);
			} finally {
				setDeletionDelay(undefined);
			}
		});

		it('replays newer patches collected from separate origin branches', async function () {
			if (isLMDB) return this.skip();
			const timestamp = (nextTimestamp += 1000);
			async function apply(value, offset, origin, fullUpdate = false) {
				const nodeId = getIdOfRemoteNode(origin, T.auditStore);
				const context = { source: {}, sourceApply: true, timestamp: timestamp + offset };
				await transaction(context, async () => {
					const resource = await T.getResource('origins', context);
					await resource._writeUpdate('origins', value, fullUpdate, {
						isNotification: true,
						nodeId,
						version: timestamp + offset,
					});
				});
			}
			await apply({ id: 'origins', c: 'stale' }, 0, 'full-put-base', true);
			await apply({ b: 'newest' }, 30, 'full-put-first');
			await apply({ counter: { __op__: 'add', value: 5 } }, 20, 'full-put-second');
			await apply({ id: 'origins', a: 'replacement' }, 10, 'full-put-base', true);
			assert.deepStrictEqual(
				{ ...(await T.get('origins')) },
				{
					id: 'origins',
					a: 'replacement',
					b: 'newest',
					counter: 5,
				}
			);
		});
	});
}
