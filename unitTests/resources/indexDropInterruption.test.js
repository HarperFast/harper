'use strict';

require('../testUtils');
const assert = require('node:assert');
const { RocksDatabase } = require('@harperfast/rocksdb-js');
const { setupTestDBPath } = require('../testUtils');
const { indexingWasInterrupted, table } = require('#src/resources/databases');
const { setMainIsWorker } = require('#js/server/threads/manageThreads');

describe('index backfill interrupted by table drop', function () {
	async function startBackfill(tableName) {
		setupTestDBPath();
		setMainIsWorker(true);
		const define = (indexed) =>
			table({
				table: tableName,
				database: 'test',
				attributes: [
					{ name: 'id', isPrimaryKey: true },
					{ name: 'tag', indexed },
				],
			});
		const Seeded = define(false);
		if (!(Seeded.primaryStore.rootStore instanceof RocksDatabase)) return Seeded;
		let lastPut;
		for (let i = 0; i < 20; i++) lastPut = Seeded.put({ id: `row-${i}`, tag: i % 2 ? 'odd' : 'even' });
		await lastPut;
		return define(true);
	}

	it('does not recreate catalog rows after the drop removes them', async function () {
		this.timeout(30000);
		const tableName = 'IndexDropInterruption';
		const Rebuilding = await startBackfill(tableName);
		if (!(Rebuilding.primaryStore.rootStore instanceof RocksDatabase)) return this.skip();
		const indexingOperation = Rebuilding.indexingOperation;
		assert.ok(indexingOperation, 'adding the index must start a backfill');
		await Rebuilding.dropTable();
		await indexingOperation;
		if (Rebuilding.dbisDB.committed) await Rebuilding.dbisDB.committed;

		const catalogRows = [];
		for (const { key } of Rebuilding.dbisDB.getRange({ start: false })) {
			if (key.toString().startsWith(`${tableName}/`)) catalogRows.push(key.toString());
		}
		assert.deepEqual(catalogRows, []);
	});

	it('does not complete a catalog row claimed by a replacement build', async function () {
		this.timeout(30000);
		const tableName = 'IndexBuildReplacement';
		const Rebuilding = await startBackfill(tableName);
		if (!(Rebuilding.primaryStore.rootStore instanceof RocksDatabase)) return this.skip();
		const descriptorKey = `${tableName}/tag`;
		const replacement = { ...Rebuilding.dbisDB.getSync(descriptorKey), indexingBuildId: 'replacement-build' };
		Rebuilding.dbisDB.putSync(descriptorKey, replacement);

		await Rebuilding.indexingOperation;

		assert.strictEqual(Rebuilding.dbisDB.getSync(descriptorKey).indexingBuildId, 'replacement-build');
	});

	it('preserves metadata written during the same index build', async function () {
		this.timeout(30000);
		const tableName = 'IndexBuildMetadataMerge';
		const Rebuilding = await startBackfill(tableName);
		if (!(Rebuilding.primaryStore.rootStore instanceof RocksDatabase)) return this.skip();
		const descriptorKey = `${tableName}/tag`;
		const current = { ...Rebuilding.dbisDB.getSync(descriptorKey), concurrentMetadata: 'preserved' };
		Rebuilding.dbisDB.putSync(descriptorKey, current);

		await Rebuilding.indexingOperation;

		const completed = Rebuilding.dbisDB.getSync(descriptorKey);
		assert.strictEqual(completed.concurrentMetadata, 'preserved');
		assert.strictEqual(completed.indexingBuildId, undefined);
	});

	it('does not classify a live primary-descriptor catalog as a dropped table', function () {
		const descriptors = new Map([['IndexLegacyPrimaryDescriptor/id', { primary: true }]]);
		const open = { status: 'open' };
		const Table = {
			tableName: 'IndexLegacyPrimaryDescriptor',
			primaryKey: 'id',
			primaryStore: { status: 'open', rootStore: open },
			dbisDB: { status: 'open', getSync: (key) => descriptors.get(key) },
		};

		assert.equal(indexingWasInterrupted(Table), false);
		descriptors.set('IndexLegacyPrimaryDescriptor/', { dropping: true });
		assert.equal(indexingWasInterrupted(Table), true);
		descriptors.clear();
		assert.equal(indexingWasInterrupted(Table), true);
	});
});
