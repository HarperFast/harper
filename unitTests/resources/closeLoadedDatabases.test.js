'use strict';

// Regression test for the job-worker RocksDB handle leak that blocked online restore_backup:
// rocksdb-js's registry is process-global across worker threads, and a thread that exits without
// closing leaks its handles (the process-global refCount never drops to zero). Job workers open
// the database graph via getDatabases() and exit per job, so they must release their handles
// explicitly. closeLoadedDatabases() is what jobProcess calls on exit to do that.

require('../testUtils');
const assert = require('node:assert');
const { setupTestDBPath } = require('../testUtils');
const { mkdirSync, mkdtempSync, rmSync, writeFileSync } = require('node:fs');
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
	beginDatabaseDrop,
	cancelDatabaseDrop,
	cancelDatabaseDropsFromThread,
	openBranchDatabase,
	closeBranchDatabases,
} = require('#src/resources/databases');
const { registryStatus, RocksDatabase } = require('@harperfast/rocksdb-js');
const env = require('#src/utility/environment/environmentManager');
const terms = require('#src/utility/hdbTerms');

describe('RocksDB handle release', function () {
	let testRoot;
	before(function () {
		testRoot = setupTestDBPath();
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

	it('closeLoadedDatabases attempts every user database before reporting close failures', async function () {
		this.timeout(30000);
		const firstName = 'closerelease-failure-a';
		const secondName = 'closerelease-failure-b';
		const first = openRocksDb(firstName);
		const second = openRocksDb(secondName);
		if (!(first instanceof RocksDatabase)) return this.skip();
		const firstTable = getDatabases()[firstName].pkg;
		await firstTable.schemaChangeOperation;
		firstTable.derivedIndexRuntime = {
			close: () => Promise.reject(new Error('test derived-index close failure')),
		};

		await assert.rejects(closeLoadedDatabases(), /Failed to close all loaded databases/);

		assert.ok(refCountFor(first.path) > 0, 'the failed database must remain open');
		assert.strictEqual(refCountFor(second.path), 0, 'a sibling database must still release its handles');
		delete firstTable.derivedIndexRuntime;
		await closeDatabaseForRestore(firstName);
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
		const originator = 890_000 + Math.floor(Math.random() * 10_000);

		await prepareDatabaseForDrop(databaseName, originator);
		assert.strictEqual(getDatabases()[databaseName], undefined);
		assert.strictEqual(rootStore.status, 'closed');
		assert.strictEqual(refCountFor(rootStore.path), 0);
		resetDatabases();
		assert.strictEqual(getDatabases()[databaseName], undefined, 'catalog rescans must not reopen a prepared drop');

		cancelDatabaseDrop(databaseName, originator);
		assert.ok(getDatabases()[databaseName]);
	});

	it('does not reopen a prepared legacy LMDB database during a catalog rescan', async function () {
		this.timeout(30000);
		const databaseName = 'close-drop-legacy-rescan';
		const legacyDatabasePath = join(testRoot, 'database', databaseName);
		mkdirSync(legacyDatabasePath, { recursive: true });
		writeFileSync(join(legacyDatabasePath, 'pkg.mdb'), 'not an LMDB database');
		const originator = 895_000 + Math.floor(Math.random() * 5_000);
		try {
			await prepareDatabaseForDrop(databaseName, originator);
			resetDatabases();
			assert.strictEqual(
				getDatabases()[databaseName],
				undefined,
				'a peer rescan must skip the prepared legacy database'
			);
		} finally {
			rmSync(legacyDatabasePath, { recursive: true, force: true });
			cancelDatabaseDrop(databaseName, originator);
		}
	});

	it('does not reopen a prepared legacy table with an explicit path during a catalog rescan', async function () {
		this.timeout(30000);
		const databaseName = 'close-drop-configured-table-rescan';
		const previousConfig = env.get(terms.CONFIG_PARAMS.DATABASES);
		const configuredRoot = join(testRoot, 'configured-legacy-table-drop');
		const tablePath = join(configuredRoot, 'pkg.mdb');
		mkdirSync(configuredRoot, { recursive: true });
		writeFileSync(tablePath, 'not an LMDB database');
		env.setProperty(terms.CONFIG_PARAMS.DATABASES, {
			...previousConfig,
			[databaseName]: { tables: { pkg: { path: configuredRoot } } },
		});
		const originator = 896_000 + Math.floor(Math.random() * 4_000);
		try {
			await prepareDatabaseForDrop(databaseName, originator);
			resetDatabases();
			assert.strictEqual(
				getDatabases()[databaseName],
				undefined,
				'a peer rescan must skip explicitly configured tables in the prepared database'
			);
		} finally {
			rmSync(configuredRoot, { recursive: true, force: true });
			cancelDatabaseDrop(databaseName, originator);
			env.setProperty(terms.CONFIG_PARAMS.DATABASES, previousConfig);
		}
	});

	it('keeps the coordinator database loaded while its drop barrier is pending', async function () {
		this.timeout(30000);
		const databaseName = 'close-drop-coordinator-rescan';
		const rootStore = openRocksDb(databaseName);
		if (!(rootStore instanceof RocksDatabase)) return this.skip();
		await getDatabases()[databaseName].pkg.schemaChangeOperation;

		beginDatabaseDrop(databaseName);
		resetDatabases();

		assert.ok(getDatabases()[databaseName], 'schema gossip must not evict the coordinator before dropDatabase runs');
		cancelDatabaseDrop(databaseName);
	});

	it('keeps a configured-path coordinator database loaded while its drop barrier is pending', async function () {
		this.timeout(30000);
		const databaseName = 'close-drop-configured-rescan';
		const previousConfig = env.get(terms.CONFIG_PARAMS.DATABASES);
		const configuredRoot = join(testRoot, 'configured-drop-root');
		mkdirSync(configuredRoot, { recursive: true });
		env.setProperty(terms.CONFIG_PARAMS.DATABASES, {
			...previousConfig,
			[databaseName]: { path: configuredRoot },
		});
		try {
			const rootStore = openRocksDb(databaseName);
			if (!(rootStore instanceof RocksDatabase)) return this.skip();
			await getDatabases()[databaseName].pkg.schemaChangeOperation;

			beginDatabaseDrop(databaseName);
			resetDatabases();

			assert.ok(
				getDatabases()[databaseName],
				'schema gossip must not evict a configured-path coordinator before dropDatabase runs'
			);
			cancelDatabaseDrop(databaseName);
		} finally {
			cancelDatabaseDrop(databaseName);
			env.setProperty(terms.CONFIG_PARAMS.DATABASES, previousConfig);
		}
	});

	it('reopens a peer when cancellation overtakes drop preparation', async function () {
		this.timeout(30000);
		const databaseName = 'close-drop-cancel-race';
		const Table = table({
			table: 'pkg',
			database: databaseName,
			attributes: [{ attribute: 'id', isPrimaryKey: true }, { attribute: 'name' }],
		});
		await Table.schemaChangeOperation;
		if (!(Table.primaryStore.rootStore instanceof RocksDatabase)) return this.skip();
		const rootStore = Table.primaryStore.rootStore;
		let release;
		const barrier = new Promise((resolve) => (release = resolve));
		Table.derivedIndexRuntime = { close: () => barrier };
		const originator = 920_000 + Math.floor(Math.random() * 10_000);
		const preparing = prepareDatabaseForDrop(databaseName, originator);
		await new Promise((resolve) => setImmediate(resolve));

		cancelDatabaseDrop(databaseName, originator);
		release();
		await assert.rejects(preparing, /canceled before/);

		assert.ok(getDatabases()[databaseName], 'cancellation must win over an in-flight prepare');
		assert.strictEqual(
			getDatabases()[databaseName].pkg.primaryStore.rootStore,
			rootStore,
			'cancellation before storage close must not churn the live database handle'
		);
	});

	it('rejects concurrent drop coordinators without replacing the active marker', async function () {
		this.timeout(30000);
		const databaseName = 'close-drop-concurrent-coordinator';
		const rootStore = openRocksDb(databaseName);
		if (!(rootStore instanceof RocksDatabase)) return this.skip();
		await getDatabases()[databaseName].pkg.schemaChangeOperation;
		const competingOriginator = 930_000 + Math.floor(Math.random() * 10_000);

		beginDatabaseDrop(databaseName);
		assert.throws(() => beginDatabaseDrop(databaseName), /already being dropped/);
		await assert.rejects(prepareDatabaseForDrop(databaseName, competingOriginator), /another coordinator/);
		cancelDatabaseDrop(databaseName, competingOriginator);
		assert.throws(
			() => database({ database: databaseName }),
			/being dropped/,
			'a competing coordinator must not clear or replace the active marker'
		);
		cancelDatabaseDrop(databaseName);
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

		await prepareDatabaseForDrop(databaseName);
		assert.strictEqual(closeAttempts, 2, 'the next preparation must retry the exact handle that failed to close');
		assert.strictEqual(refCountFor(rootStore.path), 0, 'the retried close must release the stranded native handle');
		cancelDatabaseDrop(databaseName);
	});

	it('retries a failed handle close even while the database is unloaded', async function () {
		this.timeout(30000);
		const databaseName = 'close-unloaded-handle-retry';
		const rootStore = openRocksDb(databaseName);
		if (!(rootStore instanceof RocksDatabase)) return this.skip();
		const Table = getDatabases()[databaseName].pkg;
		await Table.schemaChangeOperation;
		const close = Table.primaryStore.close.bind(Table.primaryStore);
		let closeAttempts = 0;
		Table.primaryStore.close = () => {
			if (++closeAttempts === 1) throw new Error('test unloaded handle close failure');
			return close();
		};

		await assert.rejects(closeDatabaseForRestore(databaseName), /test unloaded handle close failure/);
		assert.strictEqual(await closeDatabaseForRestore(databaseName), true);
		assert.strictEqual(closeAttempts, 2, 'the unloaded path must retry the exact stranded handle');
		assert.strictEqual(refCountFor(rootStore.path), 0);
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
