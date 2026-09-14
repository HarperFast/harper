'use strict';

// An interrupted drop is finished by the next rescan, which deletes the database directory. That
// deletion is the one thing drop_database refuses to perform while a handle it does not manage is
// open — and the refusal's own close broadcast is what runs the rescan, so a recovery that skipped
// the same check would destroy the database the refusal had just preserved.

require('../testUtils');
const assert = require('node:assert');
const { existsSync, mkdirSync, rmSync, writeFileSync } = require('node:fs');
const { dirname, join } = require('node:path');
const { setupTestDBPath } = require('../testUtils');
const {
	table,
	database,
	dropDatabase,
	getDatabases,
	resetDatabases,
	closeDatabase,
	databases,
} = require('#src/resources/databases');
const { beginDrop, abandonDrop, restoringMarkerPath } = require('#src/dataLayer/restoreMarker');
const { RocksDatabase } = require('@harperfast/rocksdb-js');
const environment = require('#src/utility/environment/environmentManager');
const { CONFIG_PARAMS } = require('#src/utility/hdbTerms');

describe('interrupted drop recovery', function () {
	before(function () {
		setupTestDBPath();
	});

	it('leaves the database alone while this process still has it open', async function () {
		this.timeout(30000);
		const DB = 'interrupteddrop';
		const T = table({
			table: 'rows',
			database: DB,
			attributes: [{ attribute: 'id', isPrimaryKey: true }],
		});
		getDatabases();
		const rootStore = T.primaryStore.rootStore;
		if (!(rootStore instanceof RocksDatabase)) return this.skip();
		const dbPath = rootStore.path;

		// what a crashed drop leaves behind: its marker, with the lifecycle lock free again
		abandonDrop(beginDrop(dbPath));
		assert.ok(existsSync(restoringMarkerPath(dbPath)), 'sanity: the interrupted drop left its marker');

		resetDatabases();

		assert.ok(existsSync(dbPath), 'the rescan must not delete a database this process holds open');
		assert.ok(existsSync(restoringMarkerPath(dbPath)), 'and the marker stays, so a later scan can finish it');

		closeDatabase(DB);
		resetDatabases();

		assert.ok(!existsSync(dbPath), 'once nothing holds it, the next scan finishes the drop');
		assert.ok(!existsSync(restoringMarkerPath(dbPath)), 'and the marker goes with the database');
		assert.strictEqual(databases[DB], undefined, 'a dropped database does not come back from the scan');
	});

	it('refuses an on-demand open it would otherwise finish the drop under', function () {
		this.timeout(30000);
		const DB = 'interrupteddrop2';
		const T = table({
			table: 'rows',
			database: DB,
			attributes: [{ attribute: 'id', isPrimaryKey: true }],
		});
		getDatabases();
		const rootStore = T.primaryStore.rootStore;
		if (!(rootStore instanceof RocksDatabase)) return this.skip();
		const dbPath = rootStore.path;

		// a handle Harper does not manage, which is what a component holding its own RocksDatabase
		// looks like to the registry; this thread's own handles go, so the open below takes the
		// on-demand path (create_table/create_database and friends) rather than the cached store
		const unmanaged = RocksDatabase.open(dbPath);
		try {
			closeDatabase(DB);
			abandonDrop(beginDrop(dbPath));

			assert.throws(
				() => database({ database: DB, table: null }),
				(error) => error.statusCode === 409 && /held open/.test(error.message)
			);
			assert.ok(existsSync(dbPath), 'the directory it was about to reopen is still there');
		} finally {
			unmanaged.close();
			// nothing holds it now, so this finishes the drop and leaves the name clean
			resetDatabases();
		}
	});

	it('uses a pre-existing marker manifest when an online drop resumes after blob-path drift', async function () {
		this.timeout(30000);
		const DB = 'interrupteddropmanifest';
		const configuredBefore = environment.get(CONFIG_PARAMS.STORAGE_BLOBPATHS);
		const firstVolume = join(dirname(setupTestDBPath()), 'drop-manifest-volume-a');
		const secondVolume = join(dirname(setupTestDBPath()), 'drop-manifest-volume-b');
		environment.setProperty(CONFIG_PARAMS.STORAGE_BLOBPATHS, [firstVolume]);
		const T = table({
			table: 'rows',
			database: DB,
			attributes: [{ attribute: 'id', isPrimaryKey: true }],
		});
		const rootStore = T.primaryStore.rootStore;
		if (!(rootStore instanceof RocksDatabase)) {
			environment.setProperty(CONFIG_PARAMS.STORAGE_BLOBPATHS, configuredBefore);
			return this.skip();
		}
		const originalRoot = join(firstVolume, DB);
		const repointedRoot = join(secondVolume, DB);
		mkdirSync(originalRoot, { recursive: true });
		mkdirSync(repointedRoot, { recursive: true });
		writeFileSync(join(originalRoot, 'old-blob'), 'old');
		writeFileSync(join(repointedRoot, 'new-blob'), 'new');
		abandonDrop(beginDrop(rootStore.path, { database: rootStore.path, blobRoots: [originalRoot] }));
		environment.setProperty(CONFIG_PARAMS.STORAGE_BLOBPATHS, [secondVolume]);

		try {
			await dropDatabase(DB);
			assert.ok(!existsSync(originalRoot), 'the original drop target is removed');
			assert.ok(existsSync(repointedRoot), 'the newly configured root is untouched');
		} finally {
			environment.setProperty(CONFIG_PARAMS.STORAGE_BLOBPATHS, configuredBefore);
			closeDatabase(DB);
			rmSync(firstVolume, { recursive: true, force: true });
			rmSync(secondVolume, { recursive: true, force: true });
		}
	});
});
