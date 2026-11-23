// The catalog's Symbol-keyed rows sort below lmdb-js's default range start, so both catalog walks
// skipped them. A compaction keeps every one; a migration to RocksDB keeps the rows that hold without
// the transaction log it leaves behind. Both are read back through the runtime catalog codec, which
// reads a bare fixint of 32-63 as a struct header.
const fs = require('fs-extra');
const assert = require('node:assert');
const path = require('node:path');
const { open } = require('lmdb');
const { table } = require('#src/resources/databases');
const { setMainIsWorker } = require('#src/server/threads/manageThreads');
const { get: envGet } = require('#src/utility/environment/environmentManager');
const { CONFIG_PARAMS } = require('#src/utility/hdbTerms');
const copyDB = require('#src/bin/copyDb');
const OpenEnvironmentObject = require('#src/utility/lmdb/OpenEnvironmentObject').default;
const { OpenDBIObject } = require('#src/utility/lmdb/OpenDBIObject');
const { INTERNAL_DBIS_NAME } = require('#src/utility/lmdb/terms');
const { RocksDatabase } = require('../rocksdbBindings.mts').rocksdbBindings();
const { setupTestDBPath } = require('../testUtils');

const isLMDB = (process.env.HARPER_STORAGE_ENGINE || envGet(CONFIG_PARAMS.STORAGE_ENGINE)) === 'lmdb';
const DATABASE = 'catalogsymbols';
const RESIDENCY_ID = 70000;
const OWNERS = ['node-a', 'node-b'];
const NEXT_TABLE_ID = 50;
const SEQ_KEY = [Symbol.for('seq'), 3];
const SEQ_ROW = { seqId: 1234, nodes: [{ id: 3, seqId: 1234 }] };
const COPY_BOUND_KEY = [Symbol.for('copyBound'), 3, 1];
const COPY_BOUND_ROW = { at: 99 };

describe('catalog copies keep the Symbol-keyed rows', function () {
	let rootPath, Catalog, copyRoot;

	before(async function () {
		if (!isLMDB) return this.skip();
		rootPath = setupTestDBPath();
		setMainIsWorker(true);
		Catalog = table({
			table: 'CatalogSymbols',
			database: DATABASE,
			attributes: [
				{ name: 'id', isPrimaryKey: true },
				{ name: 'label', indexed: true },
			],
		});
		await Catalog.put({ id: 1, label: 'one' });
		const dbisDb = Catalog.dbisDB;
		dbisDb.putSync([Symbol.for('residency_by_id'), RESIDENCY_ID], OWNERS);
		dbisDb.putSync([Symbol.for('residency_by_set'), OWNERS.join(',')], RESIDENCY_ID);
		dbisDb.putSync(Symbol.for('next-table-id'), NEXT_TABLE_ID);
		dbisDb.putSync(SEQ_KEY, SEQ_ROW);
		dbisDb.putSync(COPY_BOUND_KEY, COPY_BOUND_ROW);
		copyRoot = path.join(rootPath, 'catalog-symbol-copies');
		await fs.remove(copyRoot);
	});

	after(async function () {
		if (copyRoot) await fs.remove(copyRoot);
	});

	it('a compaction copies every Symbol-keyed row', async function () {
		const targetPath = path.join(copyRoot, `${DATABASE}.mdb`);
		await copyDB.copyDb(DATABASE, targetPath, { blobs: 'preserve-source-roots' });
		const environment = open(new OpenEnvironmentObject(targetPath, false));
		try {
			const dbisDb = environment.openDB(INTERNAL_DBIS_NAME, new OpenDBIObject(false));
			dbisDb.encoder.useVersions = false;
			assert.deepStrictEqual(dbisDb.get([Symbol.for('residency_by_id'), RESIDENCY_ID]), OWNERS);
			assert.strictEqual(dbisDb.get([Symbol.for('residency_by_set'), OWNERS.join(',')]), RESIDENCY_ID);
			assert.strictEqual(dbisDb.get(Symbol.for('next-table-id')), NEXT_TABLE_ID);
			assert.deepStrictEqual(dbisDb.get(SEQ_KEY), SEQ_ROW);
			assert.deepStrictEqual(dbisDb.get(COPY_BOUND_KEY), COPY_BOUND_ROW);
			assert(dbisDb.get('CatalogSymbols/')?.isPrimaryKey, 'the table row did not decode');
		} finally {
			await environment.close();
		}
	});

	it('a migration copies the rows that do not depend on the transaction log', async function () {
		const targetPath = path.join(copyRoot, DATABASE);
		await copyDB.copyDbToRocks(Catalog.primaryStore.rootStore, DATABASE, targetPath);
		const dbisDb = RocksDatabase.open(targetPath, { ...new OpenDBIObject(false), name: INTERNAL_DBIS_NAME });
		try {
			dbisDb.encoder.useVersions = false;
			assert.deepStrictEqual(dbisDb.getSync([Symbol.for('residency_by_id'), RESIDENCY_ID]), OWNERS);
			assert.strictEqual(dbisDb.getSync([Symbol.for('residency_by_set'), OWNERS.join(',')]), RESIDENCY_ID);
			assert.strictEqual(dbisDb.getSync(Symbol.for('next-table-id')), NEXT_TABLE_ID);
			assert.strictEqual(dbisDb.getSync(SEQ_KEY), undefined);
			assert.strictEqual(dbisDb.getSync(COPY_BOUND_KEY), undefined);
			assert(dbisDb.getSync('CatalogSymbols/')?.isPrimaryKey, 'the table row did not decode');
		} finally {
			dbisDb.close();
		}
	});
});
