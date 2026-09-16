'use strict';

// Regression test for the job-worker RocksDB handle leak that blocked online restore_backup:
// rocksdb-js's registry is process-global across worker threads, and a thread that exits without
// closing leaks its handles (the process-global refCount never drops to zero). Job workers open
// the database graph via getDatabases() and exit per job, so they must release their handles
// explicitly. closeLoadedDatabases() is what jobProcess calls on exit to do that.

require('../testUtils');
const assert = require('node:assert');
const { setupTestDBPath } = require('../testUtils');
const { mkdtempSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const {
	table,
	database,
	getDatabases,
	closeDatabase,
	closeLoadedDatabases,
	databases,
	openBranchDatabase,
	closeBranchDatabases,
} = require('#src/resources/databases');
const { beginDrop, completeDrop } = require('#src/dataLayer/restoreMarker');
const { registryStatus, RocksDatabase } = require('@harperfast/rocksdb-js');
const { waitFor } = require('../waitFor');
const { setTimeout: sleep } = require('node:timers/promises');

describe('RocksDB handle release', function () {
	before(function () {
		setupTestDBPath();
	});

	function openRocksDb(databaseName) {
		const T = table({
			table: 'pkg',
			database: databaseName,
			attributes: [{ attribute: 'id', isPrimaryKey: true }, { attribute: 'name' }],
		});
		getDatabases();
		return T.primaryStore.rootStore;
	}

	function refCountFor(dbPath) {
		return registryStatus().find((e) => e.path === dbPath)?.refCount ?? 0;
	}

	// table() announces its schema change without awaiting the local ITC handler, whose rescan reopens
	// every database. These tests await the close, so that rescan has to land first or it reopens the
	// database underneath the assertion. Nothing exposes "a rescan is pending", but its effect is
	// observable: close first, then wait for the reopen that only that rescan can perform.
	async function settleSchemaRescan(databaseName) {
		await closeLoadedDatabases();
		await waitFor(() => databases[databaseName], { message: `no schema rescan reopened ${databaseName}` });
	}

	// the close broadcast drop_database and restore_backup send, as the receiving thread's ITC handler
	// sees it. Required lazily: the ITC module graph is far heavier than this file's other subjects.
	function closeBroadcast(databaseName) {
		const ITCEventObject = require('#js/server/itc/utility/ITCEventObject');
		const { SchemaEventMsg } = require('#js/server/threads/itc');
		const { ITC_EVENT_TYPES, ITC_SCHEMA_OPERATIONS } = require('#src/utility/hdbTerms');
		return new ITCEventObject(
			ITC_EVENT_TYPES.SCHEMA,
			new SchemaEventMsg(process.pid, ITC_SCHEMA_OPERATIONS.CLOSE_DATABASE, databaseName)
		);
	}

	it('closeDatabase releases all of a database’s native handles (refCount → 0)', async function () {
		this.timeout(30000);
		const rootStore = openRocksDb('closerelease1');
		if (!(rootStore instanceof RocksDatabase)) return this.skip();
		const dbPath = rootStore.path;
		assert.ok(refCountFor(dbPath) > 0, 'database should be open before close');

		closeDatabase('closerelease1');

		assert.strictEqual(refCountFor(dbPath), 0, 'no native handles should remain after closeDatabase');
	});

	it('closeLoadedDatabases releases every loaded user database (what a job worker does on exit)', async function () {
		this.timeout(30000);
		const a = openRocksDb('closerelease2a');
		const b = openRocksDb('closerelease2b');
		if (!(a instanceof RocksDatabase)) return this.skip();
		await settleSchemaRescan('closerelease2b');
		assert.ok(refCountFor(a.path) > 0 && refCountFor(b.path) > 0, 'both databases should be open');

		await closeLoadedDatabases();

		assert.strictEqual(refCountFor(a.path), 0, 'database a should be released');
		assert.strictEqual(refCountFor(b.path), 0, 'database b should be released');
	});

	it('closeLoadedDatabases resolves only once a derived index runtime has released the handles', async function () {
		this.timeout(30000);
		const T = table({
			table: 'pkg',
			database: 'closerelease5',
			attributes: [{ attribute: 'id', isPrimaryKey: true }, { attribute: 'name' }],
		});
		getDatabases();
		if (!(T.primaryStore.rootStore instanceof RocksDatabase)) return this.skip();
		await settleSchemaRescan('closerelease5');
		// the rescan reopened the database, so the live class is the one it published
		const Live = databases.closerelease5.pkg;
		const dbPath = Live.primaryStore.rootStore.path;
		// a table with a derived index closes its column families only once the runtime settles; an
		// exiting job worker that returned before that would leak them into the process-global registry
		let release;
		Live.derivedIndexRuntime = { close: () => new Promise((resolve) => (release = resolve)) };

		let settled = false;
		const closed = closeLoadedDatabases().then(() => (settled = true));

		await waitFor(() => release, { message: 'the derived runtime was never asked to release' });
		assert.equal(settled, false, 'the close must not resolve while the runtime is still releasing');
		assert.ok(refCountFor(dbPath) > 0, 'the table handles are still open while it is');
		release();
		await closed;
		assert.strictEqual(refCountFor(dbPath), 0, 'and released by the time the caller may exit the thread');
	});

	it('the close_database acknowledgement waits for the derived index runtime too', async function () {
		this.timeout(30000);
		// drop_database and restore_backup read a thread's acknowledgement of the close broadcast as
		// "that thread has let go of the database". The ITC handler that sends it is a second call site
		// of the same release, on the threads the drop is actually waiting for.
		const { schemaHandler } = require('#js/server/itc/serverHandlers');
		const T = table({
			table: 'pkg',
			database: 'closerelease6',
			attributes: [{ attribute: 'id', isPrimaryKey: true }, { attribute: 'name' }],
		});
		getDatabases();
		if (!(T.primaryStore.rootStore instanceof RocksDatabase)) return this.skip();
		await settleSchemaRescan('closerelease6');
		const Live = databases.closerelease6.pkg;
		const rootStore = Live.primaryStore.rootStore;
		const dbPath = rootStore.path;
		let release;
		Live.derivedIndexRuntime = { close: () => new Promise((resolve) => (release = resolve)) };

		// the drop holds the lifecycle lock across the broadcast, so the rescan this handler runs after
		// the release leaves the database unloaded, as it does on a real drop; without the marker that
		// rescan reopens the very handles the acknowledgement reports as released
		const lock = beginDrop(dbPath);
		try {
			let acknowledged = false;
			const handled = schemaHandler(closeBroadcast('closerelease6')).then(() => (acknowledged = true));

			await waitFor(() => release, { message: 'the derived runtime was never asked to release' });
			// a grace period for the negative assertion below: a handler that did not wait for the release
			// resolves within a few turns of this point. Too short only lets a regression pass, never the
			// reverse — the fixed handler cannot resolve until release() is called.
			await sleep(50);
			assert.equal(acknowledged, false, 'the acknowledgement must not fire while the runtime is releasing');
			assert.ok(refCountFor(dbPath) > 0, 'the table handles are still open while it is');
			assert.notStrictEqual(rootStore.status, 'closed', 'the root must outlive its column-family handles');

			release();
			await handled;

			assert.strictEqual(refCountFor(dbPath), 0, 'and gone by the time drop_database reads the acknowledgement');
			assert.strictEqual(rootStore.status, 'closed');
		} finally {
			completeDrop(lock);
		}
	});

	it('the acknowledgement still lands when the runtime cannot prove it released', async function () {
		this.timeout(30000);
		// Table.cleanup() deliberately leaves the column families open when derivedIndexRuntime.close()
		// rejects — closing them under a flush it could not prove finished is a write through a freed
		// handle. The cost is that this thread stays a holder and the drop refuses with 409 instead of
		// destroying under it, which is only reachable if the acknowledgement lands at all: a rejection
		// escaping into the handler's `Promise.all` would take the broadcast (and the worker) down.
		const { schemaHandler } = require('#js/server/itc/serverHandlers');
		const T = table({
			table: 'pkg',
			database: 'closerelease7',
			attributes: [{ attribute: 'id', isPrimaryKey: true }, { attribute: 'name' }],
		});
		getDatabases();
		if (!(T.primaryStore.rootStore instanceof RocksDatabase)) return this.skip();
		await settleSchemaRescan('closerelease7');
		const Live = databases.closerelease7.pkg;
		const rootStore = Live.primaryStore.rootStore;
		const dbPath = rootStore.path;
		Live.derivedIndexRuntime = { close: () => Promise.reject(new Error('could not prove quiescence')) };
		let cleanupPasses = 0;
		const realPurgeLogs = rootStore.purgeLogs.bind(rootStore);
		rootStore.purgeLogs = () => cleanupPasses++;

		const lock = beginDrop(dbPath);
		try {
			await schemaHandler(closeBroadcast('closerelease7'));

			assert.ok(refCountFor(dbPath) > 0, 'the stores the runtime might still write through stay open');
			assert.notStrictEqual(rootStore.status, 'closed', 'their root stays open too');
			await rootStore.auditStore.scheduleAuditCleanup(1);
			assert.equal(cleanupPasses, 1, 'the retained root must resume audit cleanup before the acknowledgement');
		} finally {
			await rootStore.auditStore.stopAuditCleanup();
			rootStore.purgeLogs = realPurgeLogs;
			// nothing reaches them through `databases` any more, so this test owns their release
			Live.closeStores();
			rootStore.close();
			completeDrop(lock);
		}
	});

	it('releases the class timers even when the derived runtime throws synchronously', async function () {
		this.timeout(30000);
		// derivedIndexRuntime.close() belongs to another component. A synchronous throw from it used to
		// skip every release after it — notably the record-expiration interval, which holds the event
		// loop open on a job worker trying to exit. closeDatabase's own catch covers the stores; nothing
		// covered the timers.
		const T = table({
			table: 'pkg',
			database: 'closerelease10',
			attributes: [{ attribute: 'id', isPrimaryKey: true }, { attribute: 'name' }],
		});
		getDatabases();
		if (!(T.primaryStore.rootStore instanceof RocksDatabase)) return this.skip();
		await settleSchemaRescan('closerelease10');
		const Live = databases.closerelease10.pkg;
		Live.derivedIndexRuntime = {
			close() {
				throw new Error('the runtime could not start its release');
			},
		};
		// Table.cleanup() is this function's only caller, so a call is proof the synchronous releases
		// ran; it sits last among them, after the timers and the delete callback
		const storageReclamation = require('#src/server/storageReclamation');
		const released = [];
		const originalRemoveHandler = storageReclamation.removeStorageReclamationHandler;
		storageReclamation.removeStorageReclamationHandler = function (path, handler) {
			released.push(path);
			return originalRemoveHandler.call(this, path, handler);
		};
		try {
			assert.throws(() => Live.cleanup(), /could not start its release/);
		} finally {
			storageReclamation.removeStorageReclamationHandler = originalRemoveHandler;
		}
		assert.deepStrictEqual(released, [Live.primaryStore.path], 'the releases ran before the runtime was asked');

		// nothing reaches them through `databases` any more, so this test owns their release
		Live.closeStores();
	});

	it('the acknowledgement still lands when a store close rejects', async function () {
		this.timeout(30000);
		// signalSchemaChange awaits this handler alongside the broadcast and documents that neither leg
		// rejects. closeStore catches a synchronous throw from close() but pushes an asynchronous close
		// — an LMDB environment's — into `closing` unwrapped, so a rejection there would skip the rescan
		// after it, drop the acknowledgement, and reject into notifyMessageListeners, which neither
		// catches it nor handles the promise it returns.
		const { schemaHandler } = require('#js/server/itc/serverHandlers');
		const T = table({
			table: 'pkg',
			database: 'closerelease9',
			attributes: [{ attribute: 'id', isPrimaryKey: true }, { attribute: 'name' }],
		});
		getDatabases();
		if (!(T.primaryStore.rootStore instanceof RocksDatabase)) return this.skip();
		await settleSchemaRescan('closerelease9');
		const rootStore = databases.closerelease9.pkg.primaryStore.rootStore;
		const dbPath = rootStore.path;
		// an own property shadowing the prototype's close: deleted rather than reassigned, so later
		// suites see the prototype method again
		const hadOwnClose = Object.prototype.hasOwnProperty.call(rootStore, 'close');
		const realClose = rootStore.close;
		rootStore.close = () => Promise.reject(new Error('the environment close failed'));

		const lock = beginDrop(dbPath);
		try {
			// the assertion is that this resolves at all
			await schemaHandler(closeBroadcast('closerelease9'));
		} finally {
			if (hadOwnClose) rootStore.close = realClose;
			else delete rootStore.close;
			rootStore.close();
			completeDrop(lock);
		}
	});

	it('closeLoadedDatabases releases a branch database (invisible to the databases map it walks)', async function () {
		this.timeout(30000);
		const rootStore = openRocksDb('closerelease4');
		if (!(rootStore instanceof RocksDatabase)) return this.skip();
		const scratchRoot = mkdtempSync(join(tmpdir(), 'harper.unit-test.branch-close-'));
		const checkpointDir = join(scratchRoot, 'checkpoint');
		try {
			await rootStore.createCheckpoint(checkpointDir);
			const branch = openBranchDatabase(checkpointDir, 'closerelease4', 'appA__closerelease4');
			assert.ok(refCountFor(branch.rootStore.path) > 0, 'branch should be open');

			await closeLoadedDatabases();

			// a branch is not in `databases`, so the walk below cannot reach it — an exiting job worker
			// would leak its handles process-wide unless this is the single teardown entry point
			assert.strictEqual(refCountFor(checkpointDir), 0, 'branch should be released on thread teardown');
		} finally {
			closeBranchDatabases();
			rmSync(scratchRoot, { recursive: true, force: true });
		}
	});

	it('closeLoadedDatabases releases a tableless database (root store not reachable via any table)', async function () {
		this.timeout(30000);
		// open a database with no tables: its root store is tracked only on the defined-database
		// entry, so the table-based detection alone would miss it and leak the handle
		const rootStore = database({ database: 'closerelease3' });
		if (!(rootStore instanceof RocksDatabase)) return this.skip();
		const dbPath = rootStore.path;
		assert.ok(refCountFor(dbPath) > 0, 'tableless database should be open');

		await closeLoadedDatabases();

		assert.strictEqual(refCountFor(dbPath), 0, 'tableless database should be released');
	});
});
