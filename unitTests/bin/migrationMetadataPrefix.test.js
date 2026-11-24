// Regression guard for HarperFast/harper#2012: the LMDB→RocksDB migration must write each
// record with the [8-byte version][flags word] metadata prefix. The #1307 opt-out guard read
// `this.useVersions` off the migration target's plain msgpackr encoder (undefined), so every
// migrated record was stored prefix-less: no version, and point reads returned prototype-less
// plain objects (scans repaired the prototype, hiding it from search-based tests).
const fs = require('fs-extra');
const assert = require('node:assert');
const path = require('path');
const { table } = require('#src/resources/databases');
const { setMainIsWorker } = require('#src/server/threads/manageThreads');
const { get: envGet } = require('#src/utility/environment/environmentManager');
const { CONFIG_PARAMS } = require('#src/utility/hdbTerms');

const { setupTestDBPath } = require('../testUtils');
const copyDB = require('#src/bin/copyDb');
const { RocksDatabase } = require('../rocksdbBindings.mts').rocksdbBindings();
const { RecordEncoder, RecordObject, VERSION_REUSED } = require('#src/resources/RecordEncoder');
const { PrimaryRocksDatabase } = require('#src/resources/PrimaryRocksDatabase');

const isLMDB = (process.env.HARPER_STORAGE_ENGINE || envGet(CONFIG_PARAMS.STORAGE_ENGINE)) === 'lmdb';

describe('migration: records carry the version/metadata prefix (#2012)', function () {
	let rootPath, targetPath, Tbl;
	const sourceVersions = new Map();
	let steppedBack;

	before(async function () {
		// this.skip() (not a bare return in the describe body) so the gate is visible as pending
		if (!isLMDB) return this.skip();
		rootPath = setupTestDBPath();
		setMainIsWorker(true);
		Tbl = table({
			table: 'PrefixGuard',
			database: 'pgtest',
			attributes: [{ name: 'id', isPrimaryKey: true }, { name: 'name' }, { name: 'rank' }],
		});
		await Tbl.put({ id: 'a', name: 'alpha', rank: 1 });
		await Tbl.put({ id: 'b', name: 'beta', rank: 2 });
		await Tbl.put({ id: 'c', name: 'gamma', rank: 3 });
		for (const id of ['a', 'b', 'c']) {
			sourceVersions.set(id, Tbl.primaryStore.getEntry(id).version);
		}
		const now = Date.now() + 300;
		const merge = { rank: { __op__: 'add', value: 1 } };
		await Tbl.put({ id: 'd', name: 'delta', rank: 4 }, { timestamp: now - 100 });
		await Tbl.patch('d', merge, { timestamp: now });
		await Tbl.patch('d', merge, { timestamp: now - 50 });
		steppedBack = Tbl.primaryStore.getEntry('d');

		targetPath = path.join(rootPath, 'rocks-migrated-prefix', 'pgtest');
		await fs.remove(targetPath);
		await copyDB.copyDbToRocks(Tbl.primaryStore.rootStore, 'pgtest', targetPath);
	});

	after(async function () {
		if (rootPath) await fs.remove(path.join(rootPath, 'rocks-migrated-prefix'));
	});

	it('migrated record bytes start with the 8-byte version prefix', function () {
		const cf = RocksDatabase.open(targetPath, { name: 'PrefixGuard/', encoding: false });
		try {
			for (const id of ['a', 'b', 'c']) {
				const raw = cf.getBinarySync(id);
				assert(raw, `record ${id} missing from migrated CF`);
				// float64 of a current-era ms timestamp starts with 0x42
				assert.strictEqual(raw[0], 0x42, `record ${id} first byte ${raw[0]} — metadata prefix missing`);
			}
		} finally {
			cf.close();
		}
	});

	it('migrated records point-read with record prototype and source version via the runtime path', function () {
		const root = RocksDatabase.open(targetPath, {});
		const cf = new PrimaryRocksDatabase(targetPath, {
			name: 'PrefixGuard/',
			encoder: { Encoder: RecordEncoder },
			sharedStructuresKey: Symbol.for('structures'),
		}).open();
		cf.initStore(root);
		try {
			for (const id of ['a', 'b', 'c']) {
				const entry = cf.getEntry(id);
				assert(entry?.value, `record ${id} missing via getEntry`);
				assert.strictEqual(entry.value.name, { a: 'alpha', b: 'beta', c: 'gamma' }[id]);
				assert(entry.value instanceof RecordObject, `record ${id} decoded without the record prototype`);
				assert.strictEqual(entry.version, sourceVersions.get(id), `record ${id} lost its source version`);
			}
		} finally {
			cf.close();
			root.close();
		}
	});

	it('leaves the reused-version flags of the source store behind', function () {
		assert.ok(steppedBack.metadataFlags & VERSION_REUSED, 'the source row stepped back');
		const root = RocksDatabase.open(targetPath, {});
		const cf = new PrimaryRocksDatabase(targetPath, {
			name: 'PrefixGuard/',
			encoder: { Encoder: RecordEncoder },
			sharedStructuresKey: Symbol.for('structures'),
		}).open();
		cf.initStore(root);
		try {
			const entry = cf.getEntry('d');
			assert.strictEqual(entry.version, steppedBack.version);
			assert.strictEqual(entry.value.rank, 6);
			assert.strictEqual(entry.metadataFlags & VERSION_REUSED, 0);
		} finally {
			cf.close();
			root.close();
		}
	});
});
