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

describe('storage-reclamation deregistration on teardown', () => {
	before(function () {
		setupTestDBPath();
		setMainIsWorker(true);
	});

	it('deregisters the storage-reclamation handler when an ordinary database is closed', async function () {
		const { runReclamationHandlers, setAvailableSpaceRatioGetter } = require('#src/server/storageReclamation');
		const { closeDatabase } = require('#src/resources/databases');
		const queried = [];
		setAvailableSpaceRatioGetter(async (path) => {
			queried.push(path);
			return 1; // no pressure, so no handler runs and only the path registry is observed
		});
		try {
			const ReclaimProbe = table({
				table: 'ReclaimProbe',
				database: 'reclaimprobe',
				attributes: [{ name: 'id', isPrimaryKey: true }],
			});
			const rootPath = ReclaimProbe.primaryStore.rootStore.path;
			await runReclamationHandlers();
			assert.ok(queried.includes(rootPath), 'opening a database registers a reclamation handler for its root path');

			closeDatabase('reclaimprobe');
			queried.length = 0;
			await runReclamationHandlers();

			assert.ok(!queried.includes(rootPath), 'closeDatabase must drop the handler pinning the closed store');
		} finally {
			setAvailableSpaceRatioGetter();
		}
	});

	it('deregisters the storage-reclamation handler when a database is dropped', async function () {
		const { runReclamationHandlers, setAvailableSpaceRatioGetter } = require('#src/server/storageReclamation');
		const queried = [];
		setAvailableSpaceRatioGetter(async (path) => {
			queried.push(path);
			return 1;
		});
		try {
			const DropProbe = table({
				table: 'DropProbe',
				database: 'dropprobe',
				attributes: [{ name: 'id', isPrimaryKey: true }],
			});
			const rootPath = DropProbe.primaryStore.rootStore.path;
			await runReclamationHandlers();
			assert.ok(queried.includes(rootPath), 'opening a database registers a reclamation handler for its root path');

			await dropDatabase('dropprobe');
			queried.length = 0;
			await runReclamationHandlers();

			assert.ok(!queried.includes(rootPath), 'dropDatabase must drop the handler pinning the dropped store');
		} finally {
			setAvailableSpaceRatioGetter();
		}
	});
});

describe('audit cleanup retirement on teardown', () => {
	const { readMetaDb, databases } = require('#src/resources/databases');
	const { mkdtempSync, rmSync } = require('node:fs');
	const { tmpdir } = require('node:os');
	const { open } = require('lmdb');
	const { setTimeout: delay } = require('node:timers/promises');
	const { waitFor } = require('../waitFor');
	const scratchDirs = [];

	before(function () {
		setupTestDBPath();
		setMainIsWorker(true);
	});
	after(function () {
		for (const directory of scratchDirs) rmSync(directory, { recursive: true, force: true });
	});

	/** Suspends the store's next cleanup pass inside its removal, where teardown lands on it. */
	function gateCleanupPass(auditStore) {
		const state = { removals: 0, released: false };
		auditStore.getRange = () => ({
			[Symbol.iterator]: () => ({
				next: () => ({ done: false, value: { key: 1000 + state.removals, type: 'put' } }),
				return: () => ({ done: true, value: undefined }),
			}),
		});
		const gate = new Promise((resolve) => {
			state.release = () => {
				state.released = true;
				resolve();
			};
		});
		auditStore.remove = () => {
			state.removals++;
			return gate;
		};
		return state;
	}

	it('makes dropDatabase wait for an in-flight cleanup pass before it closes the stores', async function () {
		const Probe = table({
			table: 'AuditDrainProbe',
			database: 'auditdrain',
			audit: true,
			attributes: [{ name: 'id', isPrimaryKey: true }],
		});
		const rootStore = Probe.primaryStore.rootStore;
		// the Rocks pass is a single synchronous purgeLogs() call, so it has nothing to suspend
		if (rootStore instanceof RocksDatabase) return this.skip();
		const auditStore = rootStore.auditStore;
		const pass = gateCleanupPass(auditStore);
		let closedBeforeRelease = false;
		const realClose = rootStore.close.bind(rootStore);
		rootStore.close = (...args) => {
			if (!pass.released) closedBeforeRelease = true;
			return realClose(...args);
		};

		auditStore.scheduleAuditCleanup(1);
		await waitFor(() => pass.removals === 1, { timeout: 1000, message: 'the gated cleanup pass never started' });

		let dropped = false;
		const drop = dropDatabase('auditdrain').then(() => (dropped = true));
		await delay(50);
		assert.equal(dropped, false, 'dropDatabase must not finish while a cleanup pass still holds the stores');
		assert.equal(closedBeforeRelease, false, 'dropDatabase must not close the root store under a suspended pass');

		pass.release();
		await drop;
		assert.equal(closedBeforeRelease, false, 'dropDatabase must not close the root store under a suspended pass');
	});

	// The legacy per-table drop has no sibling coverage, and the store it retires is the one makeTable()
	// was handed - not `primaryStore.auditStore`, which nothing assigns.
	it('retires the legacy per-table drop against the table its own audit store, before closing it', async function () {
		const base = mkdtempSync(join(tmpdir(), 'harper-legacy-drop-'));
		scratchDirs.push(base);
		const tablePath = join(base, 'schema', 'legacydrop', 'dog.mdb');
		const auditPath = join(base, 'audit', 'legacydrop', 'dog.mdb');
		mkdirSync(dirname(tablePath), { recursive: true });
		mkdirSync(dirname(auditPath), { recursive: true });
		// initStores only adopts an audit path that already exists, so seed a real (empty) environment there
		await open({ path: auditPath }).close();
		let legacyAuditEnv;

		try {
			// the first load has no attributes to build a table from; it is what creates the catalog store
			// with the encoding initStores expects, so the attribute below is written the way production does
			const rootStore = readMetaDb(tablePath, 'dog', 'legacydrop', auditPath, true);
			// audit:false because a legacy audit store has no addDeleteRemovalCallback, so makeTable()
			// throws while loading an audited legacy table - a separate, pre-existing defect
			rootStore.dbisDb.putSync('id', { isPrimaryKey: true, name: 'id', tableId: 91, audit: false });
			readMetaDb(tablePath, 'dog', 'legacydrop', auditPath, true);

			const Dog = databases.legacydrop?.dog;
			assert.ok(Dog, 'the legacy fixture did not load a table');
			assert.notEqual(Dog.databasePath, Dog.databaseName, 'the fixture must take the legacy drop branch');
			legacyAuditEnv = Dog.auditStore;
			assert.equal(legacyAuditEnv?.isLegacy, true, 'the table should hold the legacy audit environment');
			assert.equal(
				Dog.primaryStore.auditStore,
				undefined,
				'nothing assigns primaryStore.auditStore, so a drop reading it retires nothing'
			);

			const { runReclamationHandlers, setAvailableSpaceRatioGetter } = require('#src/server/storageReclamation');
			const queried = [];
			setAvailableSpaceRatioGetter(async (path) => {
				queried.push(path);
				return 1;
			});
			const events = [];
			let releaseRetirement;
			const retired = new Promise((resolve) => (releaseRetirement = resolve));
			// legacy audit stores are opened with a plain open() rather than openAuditStore(), so they arm no
			// loop today; the spy is what an openAuditStore()-armed store on this branch would look like
			Dog.auditStore.stopAuditCleanup = () => {
				events.push('retired');
				return retired;
			};
			const realClose = Dog.primaryStore.close.bind(Dog.primaryStore);
			Dog.primaryStore.close = (...args) => {
				events.push('closed');
				return realClose(...args);
			};
			const primaryPath = Dog.primaryStore.path;

			try {
				await runReclamationHandlers();
				assert.ok(queried.includes(primaryPath), 'a loaded table registers a reclamation handler for its path');

				let dropped = false;
				const drop = Dog.dropTable().then(() => (dropped = true));
				await delay(50);
				assert.deepEqual(events, ['retired'], 'the drop must retire the audit store and wait, before closing');
				assert.equal(dropped, false);

				releaseRetirement();
				await drop;
				assert.deepEqual(events, ['retired', 'closed']);
				assert.ok(!existsSync(primaryPath), 'the legacy store file should be unlinked');

				queried.length = 0;
				await runReclamationHandlers();
				assert.ok(!queried.includes(primaryPath), 'the drop must drop the handler pinning the dropped store');
			} finally {
				setAvailableSpaceRatioGetter();
			}
		} finally {
			if (legacyAuditEnv && legacyAuditEnv.status !== 'closed') await legacyAuditEnv.close();
		}
	});
});
