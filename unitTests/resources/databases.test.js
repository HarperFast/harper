require('../testUtils');
const assert = require('assert');
const { setupTestDBPath } = require('../testUtils');
const { existsSync, mkdirSync, writeFileSync } = require('node:fs');
const { dirname, join } = require('node:path');
const { table, flushDatabases, dropDatabase, getDatabases, resetDatabases } = require('#src/resources/databases');
const { setMainIsWorker } = require('#js/server/threads/manageThreads');
const { RocksDatabase } = require('@harperfast/rocksdb-js');
const { beginRestore, completeRestore, RESTORE_META_DIR } = require('#src/dataLayer/restoreMarker');

describe('flushDatabases', () => {
	before(async function () {
		setupTestDBPath();
		setMainIsWorker(true);
		table({
			table: 'FlushTest',
			database: 'test',
			attributes: [{ name: 'id', isPrimaryKey: true }],
		});
	});

	it('flushes all databases without error', async function () {
		await assert.doesNotReject(() => flushDatabases());
	});
});

describe('table() randomAccessFields directive', () => {
	before(function () {
		setupTestDBPath();
		setMainIsWorker(true);
	});

	it('defaults to classic structures (struct writes disabled) when the directive is absent', function () {
		const DefaultTable = table({
			table: 'RafDefault',
			database: 'test',
			attributes: [{ name: 'id', isPrimaryKey: true }],
		});
		const encoder = DefaultTable.primaryStore.encoder;
		assert.ok(!encoder.randomAccessStructure);
		assert.strictEqual(encoder._writeStruct.length, 0, 'expected the no-op write stub');
	});

	it('enables typed random-access structures when @table(randomAccessFields: true)', function () {
		const RafTable = table({
			table: 'RafEnabled',
			database: 'test',
			randomAccessFields: true,
			attributes: [{ name: 'id', isPrimaryKey: true }],
		});
		const encoder = RafTable.primaryStore.encoder;
		assert.strictEqual(encoder.randomAccessStructure, true);
		assert.ok(encoder._writeStruct.length > 0, 'expected the real struct-write hook');
	});
});

describe('schemaDefined backfill on replicas missing the flag', () => {
	const TABLE = 'SchemaDefinedBackfillTest';
	const DB = 'test';

	before(function () {
		setupTestDBPath();
		setMainIsWorker(true);
	});

	it('heals in-memory and on-disk schemaDefined when an explicit reload sees a stale descriptor', async function () {
		// Create the table without an explicit schemaDefined — it defaults to true on disk.
		const Tbl = table({
			table: TABLE,
			database: DB,
			attributes: [{ name: 'id', isPrimaryKey: true }],
		});
		assert.strictEqual(Tbl.schemaDefined, true, 'fresh table should be schemaDefined=true');

		const dbisDB = Tbl.dbisDB;
		const descriptorKey = TABLE + '/';
		const original = dbisDB.getSync(descriptorKey);
		assert.ok(original, 'primary descriptor should exist after table creation');
		assert.strictEqual(original.schemaDefined, true, 'descriptor should carry schemaDefined=true initially');

		// Simulate a stale replica descriptor: strip schemaDefined from disk and from the live Table.
		// This reproduces the state a replica node was left in after a 4.7.x deploy where the
		// replicated descriptor lacked the flag.
		const stripped = { ...original };
		delete stripped.schemaDefined;
		await dbisDB.put(descriptorKey, stripped);
		Tbl.schemaDefined = undefined;
		assert.strictEqual(
			dbisDB.getSync(descriptorKey).schemaDefined,
			undefined,
			'precondition: descriptor should be missing the flag'
		);
		assert.strictEqual(Tbl.schemaDefined, undefined, 'precondition: in-memory flag should be cleared');

		// Re-enter table() with an explicit schemaDefined: true (as the schema declaration would do
		// on every worker reload). schemaDefinedExplicit=true causes the existing-Table branch to
		// re-assert the in-memory value and to rewrite the on-disk descriptor when there's a mismatch.
		const Rehealed = table({
			table: TABLE,
			database: DB,
			schemaDefined: true,
			attributes: [{ name: 'id', isPrimaryKey: true }],
		});
		assert.strictEqual(Rehealed.schemaDefined, true, 'Table.schemaDefined must be healed in memory');

		await Rehealed.dbisDB.committed;
		const healed = Rehealed.dbisDB.getSync(descriptorKey);
		assert.strictEqual(healed.schemaDefined, true, 'on-disk descriptor must be rewritten with schemaDefined=true');
	});
});

describe('dropDatabase restore serialization', () => {
	const DB = 'drop-vs-restore-test';

	before(function () {
		setupTestDBPath();
		setMainIsWorker(true);
	});

	it('refuses to drop a RocksDB database while a restore holds its lock, then drops once released', async function () {
		this.timeout(30000);
		const Table = table({
			table: 'DropRestore',
			database: DB,
			attributes: [{ name: 'id', isPrimaryKey: true }],
		});
		const rootStore = Table.primaryStore.rootStore;
		if (!(rootStore instanceof RocksDatabase)) return this.skip(); // serialization is RocksDB-only

		// simulate a restore in progress: it holds the per-database restore lock
		const lock = beginRestore(rootStore.path);
		try {
			await assert.rejects(dropDatabase(DB), (error) => error.statusCode === 409);
		} finally {
			completeRestore(lock);
		}
		// the blocked window may have unloaded the database from the in-memory map (a DB being
		// restored is intentionally not loaded); re-resolve it now that the marker is cleared, then
		// confirm the drop proceeds once the lock is released
		table({ table: 'DropRestore', database: DB, attributes: [{ name: 'id', isPrimaryKey: true }] });
		await assert.doesNotReject(dropDatabase(DB));
	});

	it('drops a multi-table RocksDB database without a spurious lock 409', async function () {
		this.timeout(30000);
		// every table shares one root store / lock path, so the per-table lock must dedupe by path —
		// otherwise the second table would re-acquire the (non-reentrant) lock and 409
		const MULTI = 'drop-multi-table-test';
		const T1 = table({ table: 'One', database: MULTI, attributes: [{ name: 'id', isPrimaryKey: true }] });
		table({ table: 'Two', database: MULTI, attributes: [{ name: 'id', isPrimaryKey: true }] });
		if (!(T1.primaryStore.rootStore instanceof RocksDatabase)) return this.skip();
		await assert.doesNotReject(dropDatabase(MULTI));
	});

	it('never loads the reserved restore-metadata directory as a database', function () {
		// the API can't create a database with this name (schemaRegex rejects the backtick), but the
		// scan opens any CURRENT+MANIFEST directory regardless of name, so it must skip the reserved dir
		const anchor = table({
			table: 'Anchor',
			database: 'scan-skip-test',
			attributes: [{ name: 'id', isPrimaryKey: true }],
		});
		if (!(anchor.primaryStore.rootStore instanceof RocksDatabase)) return this.skip();
		const databasesRoot = dirname(anchor.primaryStore.rootStore.path);

		// plant a directory that looks exactly like a RocksDB database at the reserved path
		const reservedDir = join(databasesRoot, RESTORE_META_DIR);
		mkdirSync(reservedDir, { recursive: true });
		writeFileSync(join(reservedDir, 'CURRENT'), 'MANIFEST-000001\n');
		writeFileSync(join(reservedDir, 'MANIFEST-000001'), '');

		resetDatabases();
		const loaded = getDatabases();
		assert.strictEqual(loaded[RESTORE_META_DIR], undefined, 'reserved dir must not be loaded as a database');
		assert.ok(existsSync(reservedDir), 'the reserved dir itself is left in place (used for lifecycle metadata)');
	});
});

describe('openBranchDatabase (scope-private graph, harper#643)', () => {
	const { openBranchDatabase, closeBranchDatabases, databases } = require('#src/resources/databases');
	const { mkdtempSync, rmSync } = require('node:fs');
	const { tmpdir } = require('node:os');
	const { registryStatus } = require('@harperfast/rocksdb-js');

	// the real observable for a released handle: rocksdb-js's registry is process-global and its
	// refCount only drops to zero once every column family opened under a path has been closed
	const refCountFor = (dbPath) => registryStatus().find((entry) => entry.path === dbPath)?.refCount ?? 0;

	let checkpointDir;
	let scratchRoot;
	let databasesDir;
	before(async function () {
		this.timeout(30000);
		databasesDir = setupTestDBPath();
		setMainIsWorker(true);
		const BranchSource = table({
			table: 'BranchSource',
			database: 'branchbase',
			attributes: [{ name: 'id', isPrimaryKey: true }, { name: 'note' }],
		});
		if (!(BranchSource.primaryStore.rootStore instanceof RocksDatabase)) return this.skip();
		await BranchSource.put({ id: 'a', note: 'base' });
		scratchRoot = mkdtempSync(join(tmpdir(), 'harper.unit-test.branch-'));
		checkpointDir = join(scratchRoot, 'checkpoint');
		await BranchSource.primaryStore.rootStore.createCheckpoint(checkpointDir);
	});

	afterEach(function () {
		closeBranchDatabases();
	});

	after(function () {
		if (scratchRoot) rmSync(scratchRoot, { recursive: true, force: true });
	});

	it('serves the base rows under the logical table name', async function () {
		const branch = openBranchDatabase(checkpointDir, 'branchbase', 'appA__branchbase');

		assert.ok(branch.tables.BranchSource);
		const row = await branch.tables.BranchSource.get('a');
		assert.strictEqual(row?.note, 'base', 'the branch reads the rows the checkpoint captured');
	});

	it('is invisible to every enumerator of the global databases map', function () {
		const baseTableClass = databases.branchbase.BranchSource;
		const globalKeysBefore = Object.keys(databases).length;

		const branch = openBranchDatabase(checkpointDir, 'branchbase', 'appA__branchbase');

		for (const [name, dbTables] of Object.entries(databases)) {
			assert.notStrictEqual(dbTables, branch.tables, `branch graph reachable as databases.${name}`);
		}
		assert.strictEqual(databases.branchbase.BranchSource, baseTableClass);
		assert.strictEqual(Object.keys(databases).length, globalKeysBefore);
	});

	it('stamps the branch identity on the store so blob roots do not resolve to the base', function () {
		const branch = openBranchDatabase(checkpointDir, 'branchbase', 'appA__branchbase');

		assert.strictEqual(branch.rootStore.databaseName, 'appA__branchbase');
		assert.notStrictEqual(
			branch.rootStore.databaseName,
			'branchbase',
			'sharing the base name would resolve the branch blob roots onto the base directory'
		);
	});

	it('refuses a second open of the same directory rather than handing out a rival graph', function () {
		openBranchDatabase(checkpointDir, 'branchbase', 'appA__branchbase');
		assert.throws(() => openBranchDatabase(checkpointDir, 'branchbase', 'appA__branchbase'), /already open/);
	});

	it('closes what nothing else can: the store is gone from the env map after close', function () {
		const branch = openBranchDatabase(checkpointDir, 'branchbase', 'appA__branchbase');
		branch.close();

		assert.doesNotThrow(
			() => openBranchDatabase(checkpointDir, 'branchbase', 'appA__branchbase'),
			'after close the directory can be opened again'
		);
	});

	it('refuses to adopt a directory that is already open as a real database', function () {
		const basePath = databases.branchbase.BranchSource.primaryStore.rootStore.path;
		// Its store is shared and closed by closeLoadedDatabases; adopting it would make this handle's
		// close() tear down a live database.
		assert.throws(() => openBranchDatabase(basePath, 'branchbase', 'appB__branchbase'), /already open as a database/);
	});

	it('refuses a store identity that names a real database, which would steal its blob roots', function () {
		assert.throws(
			() => openBranchDatabase(checkpointDir, 'branchbase', 'branchbase'),
			/a database of that name exists/
		);
	});

	it('releases every native handle it opened, not just the root', function () {
		const branch = openBranchDatabase(checkpointDir, 'branchbase', 'appA__branchbase');
		const branchPath = branch.rootStore.path;
		assert.ok(refCountFor(branchPath) > 0, 'the branch should hold native handles while open');

		branch.close();

		// a per-table column family left open keeps the process-global refCount above zero, which is
		// what distinguishes a released handle from a leaked one
		assert.strictEqual(refCountFor(branchPath), 0, 'close() must release every column family it opened');
	});

	it('tolerates a repeated close', function () {
		const branch = openBranchDatabase(checkpointDir, 'branchbase', 'appA__branchbase');
		branch.close();
		assert.doesNotThrow(() => branch.close(), 'a second close must not close the store twice');
		assert.strictEqual(refCountFor(branch.rootStore.path), 0, 'a second close must not double-release');
	});

	it('is not adopted back into the global map when the database scan reruns', async function () {
		this.timeout(30000);
		// harper#643 puts a branch directory inside the directory getDatabases() walks, so the first
		// resetDatabases() after a branch opens is the case that would rebuild it globally
		const probeDir = join(databasesDir, 'branchscanprobe');
		rmSync(probeDir, { recursive: true, force: true });
		let branch;
		try {
			await databases.branchbase.BranchSource.primaryStore.rootStore.createCheckpoint(probeDir);
			branch = openBranchDatabase(probeDir, 'branchbase', 'appA__scanprobe');

			resetDatabases();

			for (const [name, dbTables] of Object.entries(databases)) {
				for (const tableName in dbTables) {
					assert.notStrictEqual(
						dbTables[tableName]?.primaryStore?.rootStore,
						branch.rootStore,
						`the rescan adopted the branch store as databases.${name}.${tableName}`
					);
				}
			}
			assert.strictEqual(
				branch.rootStore.databaseName,
				'appA__scanprobe',
				'adoption would overwrite the store identity the branch blob roots resolve from'
			);
		} finally {
			branch?.close();
			rmSync(probeDir, { recursive: true, force: true });
		}
	});

	it('deregisters the storage-reclamation handler its stores registered', async function () {
		const { runReclamationHandlers, setAvailableSpaceRatioGetter } = require('#src/server/storageReclamation');
		const queried = [];
		setAvailableSpaceRatioGetter(async (path) => {
			queried.push(path);
			return 1;
		});
		try {
			const branch = openBranchDatabase(checkpointDir, 'branchbase', 'appA__branchbase');
			const branchPath = branch.rootStore.path;
			await runReclamationHandlers();
			assert.ok(queried.includes(branchPath), 'opening a branch registers a reclamation handler for its path');

			branch.close();
			queried.length = 0;
			await runReclamationHandlers();

			// registration is process-global and keyed by path, and its closure pins the closed store,
			// so an open/close cycle that leaves it behind grows unboundedly with branch churn
			assert.ok(!queried.includes(branchPath), 'close() must drop the handler pinning the closed store');
		} finally {
			setAvailableSpaceRatioGetter();
		}
	});

	it('rejects a store identity that would resolve blob roots outside the blobs directory', function () {
		assert.throws(() => openBranchDatabase(checkpointDir, 'branchbase', '..'), /not a legal database name/);
		assert.throws(() => openBranchDatabase(checkpointDir, 'branchbase', 'a/b'), /not a legal database name/);
		assert.throws(() => openBranchDatabase(checkpointDir, 'branchbase', ''), /not a legal database name/);
	});

	it('rejects a path that is not there rather than registering an empty database', function () {
		const before = Object.keys(databases).length;
		assert.throws(() => openBranchDatabase(join(checkpointDir, 'nope'), 'branchbase', 'x'), /no directory at/);
		assert.strictEqual(Object.keys(databases).length, before);
	});
});
