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
	resetDatabases,
	closeDatabase,
	closeDatabaseForRestore,
	closeLoadedDatabases,
	prepareDatabaseForDrop,
	cancelDatabaseDrop,
	cancelDatabaseDropsFromThread,
	openBranchDatabase,
	closeBranchDatabases,
} = require('#src/resources/databases');
const { registryStatus, RocksDatabase } = require('@harperfast/rocksdb-js');

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

	it('closeDatabase releases all of a database’s native handles (refCount → 0)', async function () {
		this.timeout(30000);
		const rootStore = openRocksDb('closerelease1');
		if (!(rootStore instanceof RocksDatabase)) return this.skip();
		const dbPath = rootStore.path;
		assert.ok(refCountFor(dbPath) > 0, 'database should be open before close');

		closeDatabase('closerelease1');

		assert.strictEqual(refCountFor(dbPath), 0, 'no native handles should remain after closeDatabase');
	});

	it('online restore waits for derived indexes to quiesce before closing native handles', async function () {
		this.timeout(30000);
		const databaseName = 'closerestore1';
		const Table = table({
			table: 'pkg',
			database: databaseName,
			attributes: [{ attribute: 'id', isPrimaryKey: true }, { attribute: 'name' }],
		});
		await Table.schemaChangeOperation;
		const rootStore = Table.primaryStore.rootStore;
		if (!(rootStore instanceof RocksDatabase)) return this.skip();
		let release;
		const barrier = new Promise((resolve) => (release = resolve));
		Table.derivedIndexRuntime = {
			close: () => barrier,
		};
		let settled = false;
		const closing = closeDatabaseForRestore(databaseName).then((result) => {
			settled = true;
			return result;
		});
		await new Promise((resolve) => setImmediate(resolve));
		assert.strictEqual(settled, false);
		assert.ok(refCountFor(rootStore.path) > 0, 'restore must not close storage while the writer can still publish');
		release();
		assert.strictEqual(await closing, true);
		assert.strictEqual(refCountFor(rootStore.path), 0);
	});

	it('closeLoadedDatabases releases every loaded user database (what a job worker does on exit)', async function () {
		this.timeout(30000);
		const a = openRocksDb('closerelease2a');
		const b = openRocksDb('closerelease2b');
		if (!(a instanceof RocksDatabase)) return this.skip();
		assert.ok(refCountFor(a.path) > 0 && refCountFor(b.path) > 0, 'both databases should be open');

		await closeLoadedDatabases();

		assert.strictEqual(refCountFor(a.path), 0, 'database a should be released');
		assert.strictEqual(refCountFor(b.path), 0, 'database b should be released');
	});

	it('closeLoadedDatabases quiesces derived indexes before releasing job-worker handles', async function () {
		this.timeout(30000);
		const databaseName = 'closerelease-derived';
		const Table = table({
			table: 'pkg',
			database: databaseName,
			attributes: [{ attribute: 'id', isPrimaryKey: true }, { attribute: 'name' }],
		});
		await Table.schemaChangeOperation;
		const rootStore = Table.primaryStore.rootStore;
		if (!(rootStore instanceof RocksDatabase)) return this.skip();
		let release;
		const barrier = new Promise((resolve) => (release = resolve));
		Table.derivedIndexRuntime = { close: () => barrier };

		let settled = false;
		const closing = closeLoadedDatabases().then(() => {
			settled = true;
		});
		await new Promise((resolve) => setImmediate(resolve));
		assert.strictEqual(settled, false);
		assert.ok(refCountFor(rootStore.path) > 0);

		release();
		await closing;
		assert.strictEqual(refCountFor(rootStore.path), 0);
	});

	it('keeps a peer database closed between drop preparation and cancellation', async function () {
		this.timeout(30000);
		const databaseName = 'close-drop-prepare';
		const rootStore = openRocksDb(databaseName);
		if (!(rootStore instanceof RocksDatabase)) return this.skip();
		assert.deepStrictEqual(Object.keys(getDatabases()[databaseName]), ['pkg']);
		assert.strictEqual(getDatabases()[databaseName].pkg.primaryStore.rootStore, rootStore);
		await getDatabases()[databaseName].pkg.schemaChangeOperation;

		await prepareDatabaseForDrop(databaseName);
		assert.strictEqual(getDatabases()[databaseName], undefined);
		assert.strictEqual(rootStore.status, 'closed');
		assert.strictEqual(refCountFor(rootStore.path), 0);
		resetDatabases();
		assert.strictEqual(getDatabases()[databaseName], undefined, 'catalog rescans must not reopen a prepared drop');

		cancelDatabaseDrop(databaseName);
		assert.ok(getDatabases()[databaseName]);
	});

	it('reopens a prepared database when its drop coordinator exits', async function () {
		this.timeout(30000);
		const databaseName = 'close-drop-originator-exit';
		const rootStore = openRocksDb(databaseName);
		if (!(rootStore instanceof RocksDatabase)) return this.skip();
		await getDatabases()[databaseName].pkg.schemaChangeOperation;
		const originator = 900_000 + Math.floor(Math.random() * 10_000);

		await prepareDatabaseForDrop(databaseName, originator);
		assert.strictEqual(getDatabases()[databaseName], undefined);
		cancelDatabaseDropsFromThread(originator);

		assert.ok(getDatabases()[databaseName], 'a dead coordinator must not leave the database name fenced forever');
	});

	it('rejects a late drop preparation from an exited coordinator', async function () {
		this.timeout(30000);
		const databaseName = 'close-drop-late-originator';
		const rootStore = openRocksDb(databaseName);
		if (!(rootStore instanceof RocksDatabase)) return this.skip();
		await getDatabases()[databaseName].pkg.schemaChangeOperation;
		const originator = 910_000 + Math.floor(Math.random() * 10_000);
		const { notifyThreadExit } = require('#js/server/threads/manageThreads');

		notifyThreadExit(originator);
		await assert.rejects(prepareDatabaseForDrop(databaseName, originator), /coordinator has exited/);

		assert.ok(getDatabases()[databaseName], 'a late prepare must not install a permanent drop marker');
	});

	it('rejects drop preparation when a database handle cannot close', async function () {
		this.timeout(30000);
		const databaseName = 'close-drop-handle-failure';
		const rootStore = openRocksDb(databaseName);
		if (!(rootStore instanceof RocksDatabase)) return this.skip();
		const Table = getDatabases()[databaseName].pkg;
		await Table.schemaChangeOperation;
		const close = Table.primaryStore.close.bind(Table.primaryStore);
		let closeAttempts = 0;
		Table.primaryStore.close = () => {
			if (++closeAttempts === 1) throw new Error('test handle close failure');
			return close();
		};

		await assert.rejects(prepareDatabaseForDrop(databaseName), /test handle close failure/);

		assert.ok(getDatabases()[databaseName], 'a rejected prepare must reload the database for continued use');
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
			await closeBranchDatabases();
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
