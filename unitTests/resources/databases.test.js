require('../testUtils');
const assert = require('assert');
const { setupTestDBPath } = require('../testUtils');
const { table, flushDatabases, dropDatabase } = require('#src/resources/databases');
const { setMainIsWorker } = require('#js/server/threads/manageThreads');
const { RocksDatabase } = require('@harperfast/rocksdb-js');
const { beginRestore, completeRestore } = require('#src/dataLayer/restoreMarker');

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
});
