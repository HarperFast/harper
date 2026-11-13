const assert = require('node:assert');
const { performance } = require('node:perf_hooks');
const { setupTestDBPath } = require('../testUtils');
const { table } = require('#src/resources/databases');
const { setMainIsWorker } = require('#js/server/threads/manageThreads');
const { transaction } = require('#src/resources/transaction');
const {
	replicationConfirmation: registerConfirmation,
	setReplicationConfirmationDefaults,
} = require('#src/resources/DatabaseTransaction');
const { ServerError } = require('#src/utility/errors/hdbError');

const isLMDB = process.env.HARPER_STORAGE_ENGINE === 'lmdb';

describe('Replication confirmation defaults', () => {
	let First, Second, Local, Unaudited;
	let sequence = 0;
	const nextId = () => `confirmation-default-${sequence++}`;
	let calls;

	before(() => {
		setupTestDBPath();
		setMainIsWorker(true);
		First = table({
			database: 'confirmation-default-first',
			table: 'Records',
			attributes: [{ name: 'id', isPrimaryKey: true }, { name: 'name' }],
		});
		Second = table({
			database: 'confirmation-default-second',
			table: 'Records',
			attributes: [{ name: 'id', isPrimaryKey: true }],
		});
		Unaudited = table({
			database: 'confirmation-default-first',
			table: 'Unaudited',
			attributes: [{ name: 'id', isPrimaryKey: true }],
			audit: false,
		});
		Local = table({
			database: 'system',
			table: 'confirmation_default_probe',
			attributes: [{ name: 'id', isPrimaryKey: true }],
		});
	});
	beforeEach(() => {
		calls = [];
		registerConfirmation((databaseName, _version, count, _residents, automatic) => {
			calls.push({ databaseName, count, automatic });
		});
	});
	afterEach(() => {
		registerConfirmation(undefined);
		setReplicationConfirmationDefaults({});
	});

	describe('write default', () => {
		it('waits for nothing when no default is configured', async () => {
			await transaction({}, () => First.put({ id: nextId() }));
			assert.deepStrictEqual(calls, []);
		});

		it('applies the default to a write that sets no count', async () => {
			setReplicationConfirmationDefaults({ writes: 1 });
			await transaction({}, () => First.put({ id: nextId() }));
			assert.deepStrictEqual(calls, [{ databaseName: 'confirmation-default-first', count: 1, automatic: false }]);
		});

		it('applies the default to a write outside any transaction() scope', async () => {
			setReplicationConfirmationDefaults({ writes: 1 });
			await First.put({ id: nextId() });
			assert.deepStrictEqual(calls, [{ databaseName: 'confirmation-default-first', count: 1, automatic: false }]);
		});

		it('lets an explicit count override the default', async () => {
			setReplicationConfirmationDefaults({ writes: 1 });
			await transaction({ replicatedConfirmation: 2 }, () => First.put({ id: nextId() }));
			assert.deepStrictEqual(calls, [{ databaseName: 'confirmation-default-first', count: 2, automatic: false }]);
		});

		it('lets an explicit 0 override the default', async () => {
			setReplicationConfirmationDefaults({ writes: 2 });
			await transaction({ replicatedConfirmation: 0 }, () => First.put({ id: nextId() }));
			assert.deepStrictEqual(calls, []);
		});

		it('treats a non-number count as unset', async () => {
			setReplicationConfirmationDefaults({ writes: 1 });
			await transaction({ replicatedConfirmation: Number.NaN }, () => First.put({ id: nextId() }));
			assert.deepStrictEqual(calls, [{ databaseName: 'confirmation-default-first', count: 1, automatic: false }]);
		});

		it('does not apply the default to the system database', async () => {
			setReplicationConfirmationDefaults({ writes: 1 });
			await transaction({}, () => Local.put({ id: nextId() }));
			assert.deepStrictEqual(calls, []);
			await transaction({ replicatedConfirmation: 1 }, () => Local.put({ id: nextId() }));
			assert.deepStrictEqual(calls, [{ databaseName: 'system', count: 1, automatic: false }]);
		});

		it('does not apply the default to a write that replicates nothing', async () => {
			setReplicationConfirmationDefaults({ writes: 1 });
			await transaction({}, () => Unaudited.put({ id: nextId() }));
			assert.deepStrictEqual(calls, []);
		});

		it('does not apply the default to a source-applied transaction', async () => {
			setReplicationConfirmationDefaults({ writes: 1 });
			await transaction({ sourceApply: true }, () => First.put({ id: nextId() }));
			assert.deepStrictEqual(calls, []);
			await transaction({ sourceApply: true, replicatedConfirmation: 1 }, () => First.put({ id: nextId() }));
			assert.strictEqual(calls.length, 1);
		});

		describe('across databases', () => {
			const databasesOf = () => calls.map(({ databaseName, count }) => `${databaseName}:${count}`).sort();

			it('applies the default to every database a scope writes', async () => {
				setReplicationConfirmationDefaults({ writes: 1 });
				await transaction({}, async () => {
					await First.put({ id: nextId() });
					await Second.put({ id: nextId() });
				});
				assert.deepStrictEqual(databasesOf(), ['confirmation-default-first:1', 'confirmation-default-second:1']);
			});

			it('opts every database out on an explicit 0', async () => {
				setReplicationConfirmationDefaults({ writes: 1 });
				await transaction({ replicatedConfirmation: 0 }, async () => {
					await First.put({ id: nextId() });
					await Second.put({ id: nextId() });
				});
				assert.deepStrictEqual(calls, []);
			});

			it('keeps an explicit count on the first database and the default on the others', async () => {
				setReplicationConfirmationDefaults({ writes: 1 });
				await transaction({ replicatedConfirmation: 2 }, async () => {
					await First.put({ id: nextId() });
					await Second.put({ id: nextId() });
				});
				assert.deepStrictEqual(databasesOf(), ['confirmation-default-first:2', 'confirmation-default-second:1']);
			});
		});

		it('refuses a default outside the non-negative integers', () => {
			for (const value of [-1, 1.5, Number.NaN, '1'])
				assert.throws(() => setReplicationConfirmationDefaults({ writes: value }), TypeError);
			assert.throws(() => setReplicationConfirmationDefaults({ recordLocks: -1 }), TypeError);
		});
	});

	(isLMDB ? describe.skip : describe)('record-lock count', () => {
		// a lock on a database no transport was registered for is node-scoped; joining a round makes it a
		// cluster-granted handle, as the transport would
		async function lockAsCluster(context, id) {
			const record = await First.lock(id, { lease: 5000 });
			const handle = context.transaction.recordLockFor(First.primaryStore, id);
			assert.ok(handle.joinClusterRound(Date.now(), 5000, performance.now(), () => {}));
			return record;
		}

		it('waits for the lock count when the commit holds a cluster lock', async () => {
			setReplicationConfirmationDefaults({ recordLocks: 1 });
			const id = nextId();
			const context = {};
			await transaction(context, async () => {
				const record = await lockAsCluster(context, id);
				record.set('name', 'locked');
				await record.save();
			});
			assert.deepStrictEqual(calls, [{ databaseName: 'confirmation-default-first', count: 1, automatic: false }]);
		});

		it('does not wait for a node-scoped lock', async () => {
			setReplicationConfirmationDefaults({ recordLocks: 1 });
			const id = nextId();
			await transaction({}, async () => {
				const record = await First.lock(id, { lease: 5000 });
				record.set('name', 'node');
				await record.save();
			});
			assert.deepStrictEqual(calls, []);
		});

		it('does not wait when the locked transaction writes nothing', async () => {
			setReplicationConfirmationDefaults({ recordLocks: 1 });
			const context = {};
			await transaction(context, async () => {
				await lockAsCluster(context, nextId());
			});
			assert.deepStrictEqual(calls, []);
		});

		it('takes the larger of the lock count and the requested count', async () => {
			setReplicationConfirmationDefaults({ recordLocks: 1 });
			for (const [replicatedConfirmation, expected] of [
				[0, 1],
				[2, 2],
			]) {
				calls = [];
				const context = { replicatedConfirmation };
				await transaction(context, async () => {
					const record = await lockAsCluster(context, nextId());
					record.set('name', 'max');
					await record.save();
				});
				assert.deepStrictEqual(
					calls.map(({ count }) => count),
					[expected]
				);
			}
		});

		it('asks the feasibility check for the lock count before the write lands', async () => {
			setReplicationConfirmationDefaults({ recordLocks: 1 });
			const counts = [];
			registerConfirmation(
				() => {},
				(_databaseName, count) => {
					counts.push(count);
					throw new ServerError('no peers', 400);
				}
			);
			const id = nextId();
			const context = {};
			await assert.rejects(
				transaction(context, async () => {
					const record = await lockAsCluster(context, id);
					record.set('name', 'refused');
					await record.save();
				}),
				/no peers/
			);
			assert.deepStrictEqual(counts, [1]);
			assert.equal(await First.get(id), null);
		});

		it('has released the lock when confirmation fails after the local commit', async () => {
			setReplicationConfirmationDefaults({ recordLocks: 1 });
			registerConfirmation(() => Promise.reject(new ServerError('Timed out waiting for replication', 504)));
			const id = nextId();
			const context = {};
			await assert.rejects(
				transaction(context, async () => {
					const record = await lockAsCluster(context, id);
					record.set('name', 'unconfirmed');
					await record.save();
				}),
				(error) => error.replicationUnconfirmed === true && error.retryable === false
			);
			assert.strictEqual((await First.get(id)).name, 'unconfirmed');
			const next = await First.lock(id, { lease: 1000, timeout: 400 });
			await next.unlock();
		});
	});
});
