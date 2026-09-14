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

	// table() announces its schema change without awaiting the local ITC handler, whose rescan reopens
	// every database. These tests await the close, so that rescan has to land first or it reopens the
	// database underneath the assertion.
	function settleSchemaRescan() {
		return new Promise((resolve) => setTimeout(resolve, 300));
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
		await settleSchemaRescan();
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
		const dbPath = T.primaryStore.rootStore.path;
		await settleSchemaRescan();
		// a table with a derived index closes its column families only once the runtime settles; an
		// exiting job worker that returned before that would leak them into the process-global registry
		let release;
		T.derivedIndexRuntime = { close: () => new Promise((resolve) => (release = resolve)) };

		let settled = false;
		const closed = closeLoadedDatabases().then(() => (settled = true));

		await new Promise((resolve) => setTimeout(resolve, 50));
		assert.equal(settled, false, 'the close must not resolve while the runtime is still releasing');
		assert.ok(refCountFor(dbPath) > 0, 'the table handles are still open while it is');
		release();
		await closed;
		assert.strictEqual(refCountFor(dbPath), 0, 'and released by the time the caller may exit the thread');
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
