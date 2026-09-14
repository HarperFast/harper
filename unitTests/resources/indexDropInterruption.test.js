'use strict';

require('../testUtils');
const assert = require('node:assert');
const { RocksDatabase } = require('@harperfast/rocksdb-js');
const { setupTestDBPath } = require('../testUtils');
const { table } = require('#src/resources/databases');
const { setMainIsWorker } = require('#js/server/threads/manageThreads');

describe('index backfill interrupted by table drop', function () {
	it('does not recreate catalog rows after the drop removes them', async function () {
		this.timeout(30000);
		setupTestDBPath();
		setMainIsWorker(true);
		const tableName = 'IndexDropInterruption';
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
		if (!(Seeded.primaryStore.rootStore instanceof RocksDatabase)) return this.skip();
		let lastPut;
		for (let i = 0; i < 20; i++) lastPut = Seeded.put({ id: `row-${i}`, tag: i % 2 ? 'odd' : 'even' });
		await lastPut;

		const Rebuilding = define(true);
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
});
