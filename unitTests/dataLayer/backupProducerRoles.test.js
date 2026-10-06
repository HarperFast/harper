'use strict';

const assert = require('node:assert');
const { mkdtempSync, rmSync } = require('node:fs');
const { join } = require('node:path');
const { tmpdir } = require('node:os');
const { RocksDatabase } = require('@harperfast/rocksdb-js');
const { backupDirForDatabase, createBackupOffline } = require('#src/dataLayer/rocksdbBackup');
const { readBackupManifest } = require('#src/dataLayer/backupManifest');
const { getBlobPathsForDatabaseName } = require('#src/resources/blob');
const { closeLoadedDatabases } = require('#src/resources/databases');
const { ensureSystemTables } = require('../testUtils.js');

// Its own file because seeding the system tables repoints config and loads the system database,
// which the two-process lock probe in rocksdbBackup.test.js cannot tolerate in the same run.
describe('backup producer roles', function () {
	const DB_NAME = 'backup-producer-roles-unit-test';
	let storageDir;
	let savedStoragePath;

	before(async function () {
		this.timeout(60000);
		// seed `system` into the per-PID root mocha.init.js manages, BEFORE pointing STORAGE_PATH at a
		// directory this file deletes: a `system` database under it would still be open at process
		// exit, and its flush would fail on files that are gone
		await ensureSystemTables();
		storageDir = mkdtempSync(join(tmpdir(), 'harper.unit-test.backup-producer-roles-'));
		savedStoragePath = process.env.STORAGE_PATH;
		process.env.STORAGE_PATH = storageDir;
	});

	after(async function () {
		this.timeout(30000);
		// createBackupOffline leaves the database loaded; deleting its files underneath an open handle
		// makes the flush at process exit fail, which mocha reports as a crash after a green run
		await closeLoadedDatabases();
		for (const root of getBlobPathsForDatabaseName(DB_NAME)) rmSync(root, { recursive: true, force: true });
		rmSync(backupDirForDatabase(DB_NAME), { recursive: true, force: true });
		if (savedStoragePath === undefined) delete process.env.STORAGE_PATH;
		else process.env.STORAGE_PATH = savedStoragePath;
		rmSync(storageDir, { recursive: true, force: true });
	});

	// super_user reaches every database without a per-database permission key, so a scan keyed only on
	// the database name reports the archive as having had no access roles at all.
	it('records a super_user role among the roles that granted access', async function () {
		this.timeout(30000);
		const database = RocksDatabase.open(join(storageDir, DB_NAME));
		try {
			database.putSync('rec', { n: 1 });
		} finally {
			database.close();
		}
		const created = await createBackupOffline(DB_NAME);

		const manifest = await readBackupManifest(backupDirForDatabase(DB_NAME), created.backup_id);
		assert.ok(manifest.producer.roles, 'the roles should have been enumerated');
		assert.ok(
			manifest.producer.roles.includes('super_user'),
			`expected super_user among ${JSON.stringify(manifest.producer.roles)}`
		);
	});
});
