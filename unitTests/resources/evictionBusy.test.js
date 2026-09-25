require('../testUtils');
const assert = require('assert');
const { setupTestDBPath } = require('../testUtils');
const { table } = require('#src/resources/databases');
const { registerDerivedIndexTables } = require('#src/resources/derivedIndexRegistry');
const { suspendDatabaseCommits } = require('#src/resources/DatabaseTransaction');
const { setMainIsWorker } = require('#js/server/threads/manageThreads');

// Regression for #1287 (RocksDB leg). The cleanup scan's batcher retries ERR_BUSY, but the two
// fire-and-forget evict() call sites (the read-path expiry check and runRecordExpirationEviction on
// worker 0) commit the raw transaction directly, bypassing DatabaseTransaction's ERR_BUSY retry. A
// concurrent write to the same record makes that raw commit reject with TransactionIsBusyError, which
// escaped as an unhandledRejection on [main/0] and could exit the process. evict() must swallow the
// conflict (eviction is best-effort; lazy-expiry keeps reads correct) so it can never reject.
describe('evict() swallows a commit conflict instead of rejecting (#1287)', () => {
	if (process.env.HARPER_STORAGE_ENGINE === 'lmdb') return;
	let BusyTable;

	before(async function () {
		setupTestDBPath();
		setMainIsWorker(true);
		BusyTable = table({
			table: 'EvictBusyTable',
			database: 'test',
			attributes: [{ name: 'id', isPrimaryKey: true }],
		});
	});

	it('returns a thenable that resolves when the eviction commit hits ERR_BUSY', async function () {
		const { Transaction } = require('@harperfast/rocksdb-js');
		const originalCommit = Transaction.prototype.commit;
		await BusyTable.put('b1', { id: 'b1' });
		const entry = BusyTable.primaryStore.getEntry('b1');
		const unregister = registerDerivedIndexTables(BusyTable.auditStore, [BusyTable.tableId]);

		let injected = false;
		// Arm a single ERR_BUSY into the next commit — the eviction commit issued synchronously by evict().
		Transaction.prototype.commit = async function (...args) {
			if (!injected) {
				injected = true;
				const error = new Error('Resource busy');
				error.code = 'ERR_BUSY';
				throw error;
			}
			return originalCommit.apply(this, args);
		};

		try {
			const resolution = BusyTable.evict('b1', entry.value, entry.version);
			assert.equal(typeof resolution?.then, 'function', 'evict() must return a thenable');
			// Must resolve, not reject: a rejection here is the unhandledRejection that crashed [main/0].
			await resolution;
			assert.ok(injected, 'the injected ERR_BUSY conflict should have fired on the eviction commit');
			assert.ok(BusyTable.primaryStore.getEntry('b1'), 'the failed transaction must leave the resident record intact');
			assert.strictEqual(
				[...BusyTable.auditStore.getRange({ start: 1 })].some(
					(record) => record.type === 'evict' && record.recordId === 'b1'
				),
				false,
				'the failed transaction must not commit an eviction marker'
			);
		} finally {
			Transaction.prototype.commit = originalCommit;
			unregister();
		}
	});

	it('waits for a maintenance commit before disposing the table', async function () {
		const { Transaction } = require('@harperfast/rocksdb-js');
		const originalCommit = Transaction.prototype.commit;
		await BusyTable.put('b2', { id: 'b2' });
		const entry = BusyTable.primaryStore.getEntry('b2');
		let releaseCommit;
		let commitStarted;
		const started = new Promise((resolve) => (commitStarted = resolve));
		const blocked = new Promise((resolve) => (releaseCommit = resolve));
		Transaction.prototype.commit = async function (...args) {
			commitStarted();
			await blocked;
			return originalCommit.apply(this, args);
		};

		try {
			const eviction = BusyTable.evict('b2', entry.value, entry.version);
			await started;
			let closed = false;
			const close = BusyTable.closeMaintenance().then(() => (closed = true));
			await new Promise((resolve) => setImmediate(resolve));
			assert.strictEqual(closed, false, 'maintenance close must wait for the in-flight eviction');
			releaseCommit();
			await Promise.all([eviction, close]);
			assert.strictEqual(closed, true);
		} finally {
			Transaction.prototype.commit = originalCommit;
		}
	});

	it('resolves without an unhandled rejection when teardown denies the commit', async function () {
		await BusyTable.put('b3', { id: 'b3' });
		const entry = BusyTable.primaryStore.getEntry('b3');
		const suspension = suspendDatabaseCommits([BusyTable.primaryStore.rootStore]);
		const unhandled = [];
		const onUnhandled = (error) => unhandled.push(error);
		process.on('unhandledRejection', onUnhandled);
		try {
			await BusyTable.evict('b3', entry.value, entry.version);
			await new Promise((resolve) => setImmediate(resolve));
			assert.deepStrictEqual(unhandled, []);
			assert.ok(BusyTable.primaryStore.getEntry('b3'), 'denied eviction must leave the resident record intact');
		} finally {
			process.off('unhandledRejection', onUnhandled);
			suspension.release();
		}
	});
});
