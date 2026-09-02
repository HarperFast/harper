/**
 * An LMDB environment closes asynchronously. dropDatabase must not unlink the file under a close
 * that is still in flight, so closeDatabase() hands the caller every close promise it started.
 */
require('../testUtils');
const assert = require('node:assert');
const { existsSync } = require('node:fs');
const { setupTestDBPath } = require('../testUtils');
const { table, closeDatabase, dropDatabase, getDatabases } = require('#src/resources/databases');
const { setMainIsWorker } = require('#js/server/threads/manageThreads');

describe('LMDB drop closes the environment before unlinking under it', () => {
	if (process.env.HARPER_STORAGE_ENGINE !== 'lmdb') return;

	const DB = 'lmdbdrop';
	const define = () => table({ table: 'Rows', database: DB, attributes: [{ name: 'id', isPrimaryKey: true }] });

	it('closeDatabase collects the asynchronous environment close, and the drop awaits it', async function () {
		this.timeout(20_000);
		setupTestDBPath();
		setMainIsWorker(true);
		const Tbl = define();
		await Tbl.put({ id: 1 });
		const rootStore = Tbl.primaryStore.rootStore;
		const path = rootStore.path;
		assert.ok(existsSync(path));

		const closing = [];
		assert.equal(closeDatabase(DB, closing), true);
		assert.ok(closing.length >= 1, 'the environment close is a promise the caller has to await');
		assert.notEqual(rootStore.status, 'open');
		await Promise.all(closing);
		assert.equal(rootStore.status, 'closed');

		const Again = define();
		await Again.put({ id: 2 });
		await dropDatabase(DB);
		assert.ok(!existsSync(path), 'the environment file is unlinked once its close has settled');
		assert.equal(getDatabases()[DB], undefined);
	});
});
