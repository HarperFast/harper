require('../testUtils');
const assert = require('node:assert');
const { cpSync, mkdtempSync, readdirSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join, resolve } = require('node:path');
const { getRegistryStatus, RocksDatabase } = require('@harperfast/rocksdb-js');
const { setupTestDBPath } = require('../testUtils');
const {
	closeDatabase,
	closeRestoredGeneration,
	databases,
	getDatabases,
	openRestoredGeneration,
	requiredStoreNames,
	table,
} = require('#src/resources/databases');
const { setMainIsWorker } = require('#src/server/threads/manageThreads');

const describeUnlessLmdb = process.env.HARPER_STORAGE_ENGINE === 'lmdb' ? describe.skip : describe;

function catalog(rows) {
	return { getRange: () => rows.map(([key, value]) => ({ key, value: { ...value } })) };
}

function openHandlesOn(path) {
	const resolved = resolve(path);
	return getRegistryStatus()
		.filter((instance) => resolve(instance.path) === resolved)
		.reduce((total, instance) => total + (instance.refCount ?? 0), 0);
}

describe('requiredStoreNames', function () {
	const primary = (fields = {}) => ({ name: 'id', isPrimaryKey: true, tableId: 1, ...fields });

	it('requires a store for the primary key and each indexed attribute, none for an unindexed one', function () {
		const required = requiredStoreNames(
			catalog([
				['Orders/', primary()],
				['Orders/total', { name: 'total' }],
				['Orders/customer', { name: 'customer', indexed: true }],
				['Orders/vector', { name: 'vector', indexed: { type: 'HNSW' } }],
			])
		);
		assert.deepStrictEqual([...required], [['Orders', ['Orders/', 'Orders/customer', 'Orders/vector']]]);
	});

	it("names every store with the table's generation", function () {
		const required = requiredStoreNames(
			catalog([
				['Orders/', primary({ generation: 'g7' })],
				['Orders/customer', { name: 'customer', indexed: true }],
			])
		);
		assert.deepStrictEqual(required.get('Orders'), ['Orders/@g7', 'Orders/customer@g7']);
	});

	it('requires nothing for a table mid-drop or one with no primary-key row', function () {
		const required = requiredStoreNames(
			catalog([
				['Dropping/', primary({ dropping: true, dropGeneration: 'd1' })],
				['Dropping/customer', { name: 'customer', indexed: true }],
				['Creating/customer', { name: 'customer', indexed: true }],
				['Live/', primary({ tableId: 2 })],
			])
		);
		assert.deepStrictEqual([...required.keys()], ['Live']);
	});

	it('ignores generation and drop bookkeeping rows', function () {
		const required = requiredStoreNames(
			catalog([
				['/generation/g7', { table: 'Orders', generation: 'g7', phase: 'retired' }],
				['/dropped/Orders', { table: 'Orders', droppedTime: 1 }],
				['Orders/', primary()],
			])
		);
		assert.deepStrictEqual([...required], [['Orders', ['Orders/']]]);
	});
});

describeUnlessLmdb('openRestoredGeneration', function () {
	const SOURCE = 'restoredgensource';
	let sourcePath;
	let tempDir;
	let Orders;

	before(async function () {
		setupTestDBPath();
		setMainIsWorker(true);
		Orders = table({
			table: 'Orders',
			database: SOURCE,
			attributes: [{ name: 'id', isPrimaryKey: true }, { name: 'total' }, { name: 'customer', indexed: true }],
		});
		table({ table: 'Notes', database: SOURCE, attributes: [{ name: 'id', isPrimaryKey: true }] });
		// a recreate over a dropped table's stores takes a generation suffix
		const recreatedAttributes = [
			{ name: 'id', isPrimaryKey: true },
			{ name: 'tag', indexed: true },
		];
		await table({ table: 'Recreated', database: SOURCE, attributes: recreatedAttributes }).dropTable();
		const Recreated = table({ table: 'Recreated', database: SOURCE, attributes: recreatedAttributes });
		await Recreated.put({ id: 1, tag: 'again' });
		for (let i = 0; i < 20; i++) await Orders.put({ id: i, total: i * 10, customer: `c${i % 3}` });
		sourcePath = Orders.primaryStore.rootStore.path;
		await closeDatabase(SOURCE);
		tempDir = mkdtempSync(join(tmpdir(), 'harper.unit-test.restored-generation-'));
	});

	after(function () {
		if (tempDir) rmSync(tempDir, { recursive: true, force: true });
	});

	function copyOfSource(name) {
		const path = join(tempDir, name);
		cpSync(sourcePath, path, { recursive: true });
		return path;
	}

	it('requires exactly the stores initStores opens, and opens privately', async function () {
		const path = copyOfSource('healthy');
		const generation = openRestoredGeneration(path, 'restoredgenhealthy');
		try {
			const { Orders: RestoredOrders, Notes, Recreated } = generation.tables;
			assert.ok(RestoredOrders && Notes && Recreated, 'every catalogued table loads');
			for (const [tableName, Table] of Object.entries(generation.tables)) {
				const opened = [Table.primaryStore.name, ...Object.values(Table.indices).map((index) => index.name)];
				assert.deepStrictEqual(generation.requiredStores.get(tableName).sort(), opened.sort(), tableName);
			}
			assert.ok(
				generation.requiredStores.get('Recreated').every((name) => name.includes('@')),
				'precondition: the recreated table carries a generation'
			);
			assert.strictEqual((await RestoredOrders.get(7))?.customer, 'c1');
			assert.strictEqual(databases.restoredgenhealthy, undefined, 'never published under its name');
			assert.ok(
				!Object.values(getDatabases()).some((tables) =>
					Object.values(tables).some((Table) => Table?.primaryStore?.rootStore === generation.rootStore)
				),
				'never reachable through the loaded databases'
			);
		} finally {
			assert.deepStrictEqual(closeRestoredGeneration(path, generation), []);
		}
		assert.strictEqual(openHandlesOn(path), 0, 'closing releases every handle');
	});

	it('refuses a generation missing a store its catalogue requires, without creating it or leaving a handle', function () {
		const path = copyOfSource('missing-index');
		const indexStore = (() => {
			const root = RocksDatabase.open(path);
			try {
				return root.columns.find((name) => name.startsWith('Orders/customer'));
			} finally {
				root.close();
			}
		})();
		assert.ok(indexStore, 'precondition: the source has the index store');
		const index = RocksDatabase.open(path, { name: indexStore });
		index.dropSync();
		index.close();

		assert.throws(
			() => openRestoredGeneration(path, 'restoredgenmissing'),
			(error) => error.message.includes(`missing column families its catalogue requires: ${indexStore}`)
		);
		assert.strictEqual(openHandlesOn(path), 0, 'a refused open leaves no handle behind');
		const root = RocksDatabase.open(path);
		try {
			assert.ok(!root.columns.includes(indexStore), 'the refusal did not recreate the store empty');
		} finally {
			root.close();
		}
	});

	it('refuses a directory with no table catalogue', function () {
		const path = join(tempDir, 'no-catalogue');
		const root = RocksDatabase.open(path);
		root.putSync('k', 'v');
		root.close();
		assert.throws(() => openRestoredGeneration(path, 'restoredgenempty'), /has no table catalogue/);
		assert.strictEqual(openHandlesOn(path), 0);
		assert.ok(readdirSync(path).length > 0);
	});
});
