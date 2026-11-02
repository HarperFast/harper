const assert = require('node:assert');
const { setupTestDBPath } = require('../testUtils');
const { table } = require('#src/resources/databases');
const { transaction } = require('#src/resources/transaction');
const { getIdOfRemoteNode } = require('#src/resources/nodeIdMapping');
const { setMainIsWorker } = require('#src/server/threads/manageThreads');

const isLMDB = process.env.HARPER_STORAGE_ENGINE === 'lmdb';
const add = (value) => ({ __op__: 'add', value });

describe('Resolved audit references fold once', function () {
	this.timeout(30000);
	const keys = Array.from({ length: 200 }, (_, index) => `key-${index}`);
	const orders = [
		[0, 1, 2, 3],
		[0, 3, 2, 1],
		[0, 2, 3, 1],
	];
	let receivers;

	before(() => {
		setupTestDBPath();
		setMainIsWorker(true);
		receivers = orders.map((order, index) => {
			const T = table({
				table: 'Counters',
				database: `visitedAuditRefs${index}`,
				attributes: [{ name: 'id', isPrimaryKey: true }],
				audit: true,
			});
			const origins = ['fold-a', 'fold-b', 'fold-c'].map((name) => getIdOfRemoteNode(name, T.auditStore));
			return { T, origins, order };
		});
	});

	async function apply({ T, origins }, write, timestamp, prefix) {
		const context = { source: {}, sourceApply: true, timestamp };
		await transaction(context, async () => {
			for (const key of keys) {
				const id = `${prefix}-${key}`;
				const resource = await T.getResource(id, context);
				await resource._writeUpdate(id, { ...(write.put ? { id } : {}), ...write.value }, write.put ?? false, {
					isNotification: true,
					nodeId: origins[write.origin],
					version: timestamp,
				});
			}
		});
	}

	for (const latePut of [false, true]) {
		it(`converges for three origins and 200 keys with a late ${latePut ? 'put' : 'patch'}`, async function () {
			const base = Date.now() + (latePut ? 7_200_000 : 3_600_000);
			const prefix = latePut ? 'put' : 'patch';
			const writes = [
				{ origin: 0, put: true, value: { count: 0, label: 'seed', omitted: true } },
				{ origin: 1, put: latePut, value: { count: latePut ? 100 : add(7), label: 'older' } },
				{ origin: 2, value: { count: add(3), label: 'middle' } },
				{ origin: 0, value: { count: add(5), label: 'newest' } },
			];
			const snapshots = [];
			for (const receiver of receivers) {
				for (const index of receiver.order) await apply(receiver, writes[index], base + index * 1000, prefix);
				const expectedCount = latePut ? 108 : 15;
				const snapshot = [];
				for (const key of keys) {
					const id = `${prefix}-${key}`;
					const expected = { id, count: expectedCount, label: 'newest', ...(latePut ? {} : { omitted: true }) };
					const actual = { ...(await receiver.T.get(id)) };
					assert.deepStrictEqual(actual, expected, `${id}: arrival ${receiver.order.join(',')}`);
					assert.deepStrictEqual({ ...receiver.T.primaryStore.getEntry(id).value }, expected);
					snapshot.push(actual);
				}
				assert.strictEqual(snapshot.length, 200);
				snapshots.push(snapshot);
				if (isLMDB) continue; // LMDB re-delivery already reapplies increments on base; preserve its behavior.
				await apply(receiver, writes[2], base + 2000, prefix);
				for (const key of keys) {
					assert.strictEqual(
						(await receiver.T.get(`${prefix}-${key}`)).count,
						expectedCount,
						're-delivery adds nothing'
					);
				}
			}
			assert.deepStrictEqual(snapshots[1], snapshots[0]);
			assert.deepStrictEqual(snapshots[2], snapshots[0]);
		});
	}
});
