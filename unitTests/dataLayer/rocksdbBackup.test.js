'use strict';

const assert = require('node:assert');
const { existsSync, mkdtempSync, rmSync } = require('node:fs');
const { join } = require('node:path');
const { tmpdir } = require('node:os');
const { RocksDatabase } = require('@harperfast/rocksdb-js');
const {
	backupDirForDatabase,
	createBackupOffline,
	deleteBackupOffline,
	getBackupsRoot,
	listBackupsInDir,
	listBackupsOffline,
	purgeBackupsOffline,
	restoreBackup,
	restoreBackupOffline,
	validateDatabaseName,
	validateRestoreBackup,
	verifyBackupOffline,
	createBackupStream,
} = require('#src/dataLayer/rocksdbBackup');
const { beginRestore, completeRestore, checkRestoreState } = require('#src/dataLayer/restoreMarker');

const DB_NAME = 'rocksdb-backup-unit-test';

describe('rocksdbBackup', function () {
	let storageDir;
	let databaseDir;
	let savedStoragePath;

	before(function () {
		storageDir = mkdtempSync(join(tmpdir(), 'harper.unit-test.rocksdb-backup-'));
		// resolveDatabasePath honors STORAGE_PATH, so databases created here resolve to this dir
		savedStoragePath = process.env.STORAGE_PATH;
		process.env.STORAGE_PATH = storageDir;
		databaseDir = join(storageDir, DB_NAME);
	});

	after(function () {
		if (savedStoragePath === undefined) delete process.env.STORAGE_PATH;
		else process.env.STORAGE_PATH = savedStoragePath;
		rmSync(storageDir, { recursive: true, force: true });
		rmSync(backupDirForDatabase(DB_NAME), { recursive: true, force: true });
	});

	function writeRecords(records) {
		const database = RocksDatabase.open(databaseDir);
		try {
			for (const [key, value] of records) {
				database.putSync(key, value);
			}
		} finally {
			database.close();
		}
	}

	describe('validateDatabaseName', function () {
		it('accepts ordinary names', function () {
			validateDatabaseName('data');
			validateDatabaseName('my_db-2');
			validateDatabaseName('my.db');
		});

		it('rejects traversal and separator names', function () {
			for (const name of ['..', '.', 'a/b', 'a\\b', '', 'a\0b', 42, undefined]) {
				assert.throws(
					() => validateDatabaseName(name),
					(error) => error.statusCode === 400
				);
			}
		});
	});

	describe('backupDirForDatabase', function () {
		it('confines the backup directory to the backups root', function () {
			assert.strictEqual(backupDirForDatabase(DB_NAME), join(getBackupsRoot(), DB_NAME));
		});
	});

	describe('listBackupsInDir', function () {
		it('returns [] for a directory that does not exist yet', async function () {
			assert.deepStrictEqual(await listBackupsInDir(join(storageDir, 'no-such-dir')), []);
		});
	});

	describe('offline backup lifecycle', function () {
		it('createBackupOffline errors descriptively when there is no database', async function () {
			await assert.rejects(createBackupOffline('no-such-database'), (error) => error.statusCode === 404);
		});

		it('creates, lists, verifies, restores, deletes, and purges backups', async function () {
			this.timeout(30000);
			writeRecords([
				['alpha', { n: 1 }],
				['beta', { n: 2 }],
			]);

			const first = await createBackupOffline(DB_NAME);
			assert.strictEqual(first.database, DB_NAME);
			assert.strictEqual(first.backup_id, 1);
			assert.ok(first.size > 0, 'size should come from the backups.list match');
			assert.ok(first.timestamp !== undefined);

			writeRecords([['gamma', { n: 3 }]]);
			const second = await createBackupOffline(DB_NAME);
			assert.strictEqual(second.backup_id, 2);

			const backupDir = backupDirForDatabase(DB_NAME);
			const listed = await listBackupsInDir(backupDir);
			assert.deepStrictEqual(
				listed.map((backup) => backup.backupId),
				[1, 2]
			);

			// the exposed list is snake_case (backup_id/file_count), not the binding's camelCase
			const exposed = await listBackupsOffline(DB_NAME);
			assert.deepStrictEqual(Object.keys(exposed[0]).sort(), ['backup_id', 'file_count', 'size', 'timestamp']);
			assert.strictEqual(exposed[0].backup_id, 1);
			assert.ok(exposed[0].file_count >= 1, 'file_count should be mapped from numberFiles');

			const verified = await verifyBackupOffline(DB_NAME, 1, true);
			assert.deepStrictEqual(verified, { database: DB_NAME, backup_id: 1, ok: true });

			// restore the first backup into a separate target database directory
			const restored = await restoreBackupOffline(DB_NAME, 1, `${DB_NAME}-restored`);
			assert.strictEqual(restored.backup_id, 1);
			const restoredDir = join(storageDir, `${DB_NAME}-restored`);
			assert.strictEqual(restored.restored_to, restoredDir);
			assert.strictEqual(checkRestoreState(restoredDir), 'clear');
			const restoredDb = RocksDatabase.open(restoredDir);
			try {
				assert.deepStrictEqual(restoredDb.getSync('alpha'), { n: 1 });
				assert.strictEqual(restoredDb.getSync('gamma'), undefined, 'backup 1 predates gamma');
			} finally {
				restoredDb.close();
			}

			// restore latest (no backup_id) in place over the source database
			const latestRestore = await restoreBackupOffline(DB_NAME);
			assert.strictEqual(latestRestore.backup_id, 2);
			assert.strictEqual(checkRestoreState(databaseDir), 'clear');
			const inPlaceDb = RocksDatabase.open(databaseDir);
			try {
				assert.deepStrictEqual(inPlaceDb.getSync('gamma'), { n: 3 });
			} finally {
				inPlaceDb.close();
			}

			const deleted = await deleteBackupOffline(DB_NAME, 1);
			assert.deepStrictEqual(deleted, { ok: true });
			assert.deepStrictEqual(
				(await listBackupsInDir(backupDir)).map((backup) => backup.backupId),
				[2]
			);

			const purged = await purgeBackupsOffline(DB_NAME, 0);
			assert.deepStrictEqual(purged, { deleted: 1, remaining: 0 });
		});

		it('errors with 404 for unknown backup ids and empty repositories', async function () {
			await assert.rejects(verifyBackupOffline(DB_NAME, 999, false), (error) => error.statusCode === 404);
			await assert.rejects(deleteBackupOffline(DB_NAME, 999), (error) => error.statusCode === 404);
			await assert.rejects(purgeBackupsOffline(DB_NAME, 1), (error) => error.statusCode === 404);
			await assert.rejects(restoreBackupOffline(DB_NAME, 999), (error) => error.statusCode === 404);
		});

		it('rejects invalid backup ids and keep counts', async function () {
			await assert.rejects(deleteBackupOffline(DB_NAME, 'one'), (error) => error.statusCode === 400);
			await assert.rejects(purgeBackupsOffline(DB_NAME, -1), (error) => error.statusCode === 400);
		});

		it('rejects a non-boolean verify_checksum instead of silently skipping the checksum pass', async function () {
			await assert.rejects(
				verifyBackupOffline(DB_NAME, 1, 'true'),
				(error) => error.statusCode === 400 && /verify_checksum/.test(error.message)
			);
		});

		it('refuses to restore into an existing, non-empty target_database', async function () {
			this.timeout(30000);
			writeRecords([['alpha', { n: 1 }]]);
			await createBackupOffline(DB_NAME);
			// first restore into a fresh target succeeds and leaves a non-empty database there…
			await restoreBackupOffline(DB_NAME, undefined, `${DB_NAME}-occupied`);
			// …so a second restore into the same target must be rejected, not purge it
			await assert.rejects(
				restoreBackupOffline(DB_NAME, undefined, `${DB_NAME}-occupied`),
				(error) => error.statusCode === 400 && /already exists/.test(error.message)
			);
			await purgeBackupsOffline(DB_NAME, 0);
		});

		it('refuses to back up a database with an incomplete restore pending', async function () {
			this.timeout(30000);
			writeRecords([['alpha', { n: 1 }]]);
			const token = beginRestore(databaseDir);
			try {
				await assert.rejects(createBackupOffline(DB_NAME), (error) => error.statusCode === 409);
			} finally {
				completeRestore(databaseDir, token);
			}
		});
	});

	describe('online restore_backup validation', function () {
		it('rejects database=system with a pointer at running it offline', async function () {
			for (const fn of [validateRestoreBackup, restoreBackup]) {
				await assert.rejects(
					fn({ database: 'system' }),
					(error) => error.statusCode === 400 && /restore_backup database=system/.test(error.message)
				);
			}
		});

		it('rejects target_database instead of silently restoring in place', async function () {
			for (const fn of [validateRestoreBackup, restoreBackup]) {
				await assert.rejects(
					fn({ database: DB_NAME, target_database: 'copy' }),
					(error) => error.statusCode === 400 && /target_database/.test(error.message)
				);
			}
		});
	});

	describe('createBackupStream', function () {
		it('streams a tar of the database with download headers and no server compression', async function () {
			this.timeout(30000);
			writeRecords([['alpha', { n: 1 }]]);
			const database = RocksDatabase.open(databaseDir);
			try {
				const stream = createBackupStream(database, DB_NAME, false);
				assert.strictEqual(stream.noCompression, true);
				assert.strictEqual(stream.headers.get('content-type'), 'application/x-tar');
				assert.strictEqual(stream.headers.get('content-disposition'), `attachment; filename="${DB_NAME}.tar"`);
				let bytes = 0;
				for await (const chunk of stream) {
					bytes += chunk.length;
				}
				// a tar stream ends with the two-zero-block end-of-archive marker, so any complete
				// archive is at least 1024 bytes and 512-byte aligned
				assert.ok(bytes >= 1024, `expected a complete tar, got ${bytes} bytes`);
				assert.strictEqual(bytes % 512, 0, 'tar streams are 512-byte aligned');
			} finally {
				database.close();
			}
		});

		it('sanitizes quotes and backslashes in the content-disposition filename', async function () {
			this.timeout(30000);
			const database = RocksDatabase.open(databaseDir);
			try {
				const stream = createBackupStream(database, 'we"ird\\name', false);
				assert.strictEqual(stream.headers.get('content-disposition'), 'attachment; filename="we_ird_name.tar"');
				stream.destroy();
			} finally {
				database.close();
			}
		});

		it('labels a gzipped stream as application/gzip', async function () {
			this.timeout(30000);
			const database = RocksDatabase.open(databaseDir);
			try {
				const stream = createBackupStream(database, DB_NAME, true);
				assert.strictEqual(stream.headers.get('content-type'), 'application/gzip');
				assert.strictEqual(stream.headers.get('content-disposition'), `attachment; filename="${DB_NAME}.tar.gz"`);
				const chunks = [];
				for await (const chunk of stream) {
					chunks.push(chunk);
				}
				const body = Buffer.concat(chunks);
				// gzip magic bytes
				assert.strictEqual(body[0], 0x1f);
				assert.strictEqual(body[1], 0x8b);
			} finally {
				database.close();
			}
		});
	});

	describe('backup directory hygiene', function () {
		it('backups land under the configured backups root, not next to the database', async function () {
			this.timeout(30000);
			writeRecords([['alpha', { n: 1 }]]);
			await createBackupOffline(DB_NAME);
			assert.ok(existsSync(backupDirForDatabase(DB_NAME)));
			assert.ok(!existsSync(join(databaseDir, 'backups')));
			await purgeBackupsOffline(DB_NAME, 0);
		});
	});
});
