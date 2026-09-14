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

	it('keeps an ordinary index handle when the same LMDB table is redefined', () => {
		setupTestDBPath();
		setMainIsWorker(true);
		const defineIndexed = () =>
			table({
				table: 'IndexedRows',
				database: 'lmdbindexreuse',
				attributes: [
					{ name: 'id', isPrimaryKey: true },
					{ name: 'value', indexed: true },
				],
			});
		const first = defineIndexed();
		assert.strictEqual(defineIndexed().indices.value, first.indices.value);
	});
});

/**
 * The drop also has to release what the open registered process-wide: a reclamation handler keyed
 * by the environment's path outlives the environment itself and would keep querying a deleted file.
 */
describe('LMDB drop releases the reclamation handler its open registered', () => {
	if (process.env.HARPER_STORAGE_ENGINE !== 'lmdb') return;

	it('deregisters the storage-reclamation handler the dropped environment registered', async function () {
		this.timeout(20_000);
		setupTestDBPath();
		setMainIsWorker(true);
		const { runReclamationHandlers, setAvailableSpaceRatioGetter } = require('#src/server/storageReclamation');
		const queried = [];
		setAvailableSpaceRatioGetter(async (path) => {
			queried.push(path);
			return 1;
		});
		try {
			const Reclaim = table({
				table: 'Reclaim',
				database: 'lmdbreclaim',
				attributes: [{ name: 'id', isPrimaryKey: true }],
			});
			const rootPath = Reclaim.primaryStore.rootStore.path;
			await runReclamationHandlers();
			assert.ok(queried.includes(rootPath), 'opening a database registers a reclamation handler for its root path');

			await dropDatabase('lmdbreclaim');
			queried.length = 0;
			await runReclamationHandlers();

			assert.ok(!queried.includes(rootPath), 'dropDatabase must drop the handler pinning the dropped environment');
		} finally {
			setAvailableSpaceRatioGetter();
		}
	});
});
