require('../testUtils');
const assert = require('assert');
const { setupTestDBPath } = require('../testUtils');
const { table } = require('#src/resources/databases');
const { registerDerivedIndexTables } = require('#src/resources/derivedIndexRegistry');
const { suspendDatabaseCommits, setTxnExpiration, getTxnExpiration } = require('#src/resources/DatabaseTransaction');
const { setMainIsWorker } = require('#js/server/threads/manageThreads');
const { getRegistryStatus } = require('@harperfast/rocksdb-js');

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

// Its own database, so the registry checks see only this fixture's handles.
describe('evict() owns its RocksDB handle end to end', () => {
	if (process.env.HARPER_STORAGE_ENGINE === 'lmdb') return;
	let OwnedTable;

	before(function () {
		setupTestDBPath();
		setMainIsWorker(true);
		OwnedTable = table({
			table: 'EvictOwnershipTable',
			database: 'evict-ownership',
			attributes: [
				{ name: 'id', isPrimaryKey: true },
				{ name: 'body', indexed: true },
			],
			audit: true,
		});
	});

	function assertNothingHeld() {
		const trackedTxns = setTxnExpiration(getTxnExpiration());
		const tracked = [...trackedTxns].filter((txn) => txn.db?.path === OwnedTable.primaryStore.path);
		assert.deepStrictEqual(
			tracked.map((txn) => txn.transaction?.id),
			[],
			'no transaction may stay registered with the monitor after an eviction settles'
		);
		const database = getRegistryStatus().find(({ path }) => path === OwnedTable.primaryStore.rootStore.path);
		assert.ok(database, 'the fixture database must be in the native registry');
		assert.deepStrictEqual(database.transactionDetails, [], 'no native handle may outlive an eviction');
	}

	it('releases its handle whether it evicts the record or skips a stale version', async function () {
		await OwnedTable.put('evicted', { id: 'evicted', body: 'evicted body' });
		await OwnedTable.put('kept', { id: 'kept', body: 'kept body' });
		const evicted = OwnedTable.primaryStore.getEntry('evicted');
		const kept = OwnedTable.primaryStore.getEntry('kept');
		await OwnedTable.evict('evicted', evicted.value, evicted.version);
		await OwnedTable.evict('kept', kept.value, kept.version - 1);
		assert.equal(OwnedTable.primaryStore.getEntry('evicted'), undefined);
		assert.equal(OwnedTable.indices.body.getValuesCount('evicted body'), 0, 'eviction must remove the index entry');
		assert.equal(OwnedTable.primaryStore.getEntry('kept')?.value.body, 'kept body', 'a stale version must not evict');
		assert.equal(OwnedTable.indices.body.getValuesCount('kept body'), 1);
		assertNothingHeld();
	});

	it('abandons an eviction that loses a real commit conflict, releasing its handle and keeping the competing write', async function () {
		const { Transaction } = require('@harperfast/rocksdb-js');
		const originalCommit = Transaction.prototype.commit;
		await OwnedTable.put('contended', { id: 'contended', body: 'resident' });
		const { value, version } = OwnedTable.primaryStore.getEntry('contended');
		let commitOutcome;
		Transaction.prototype.commit = function (...args) {
			Transaction.prototype.commit = originalCommit;
			OwnedTable.primaryStore.putSync('contended', { id: 'contended', body: 'competing' }, { version: version + 1 });
			const committing = originalCommit.apply(this, args);
			committing.then(
				(result) => (commitOutcome = `resolved ${result}`),
				(error) => (commitOutcome = error.code)
			);
			return committing;
		};
		try {
			await OwnedTable.evict('contended', value, version);
		} finally {
			Transaction.prototype.commit = originalCommit;
		}
		assert.equal(commitOutcome, 'ERR_BUSY', 'the eviction commit must hit the competing write as a conflict');
		assert.equal(OwnedTable.primaryStore.getEntry('contended')?.value.body, 'competing');
		assertNothingHeld();
	});
});
