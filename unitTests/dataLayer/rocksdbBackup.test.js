'use strict';

const assert = require('node:assert');
const { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } = require('node:fs');
const { dirname, join } = require('node:path');
const { tmpdir } = require('node:os');
const { spawn } = require('node:child_process');
const { extract } = require('tar-stream');
const { RocksDatabase } = require('@harperfast/rocksdb-js');
const {
	backupDirForDatabase,
	createBackupOffline,
	deleteBackup,
	deleteBackupOffline,
	getBackupsRoot,
	listBackups,
	listBackupsInDir,
	listBackupsOffline,
	purgeBackups,
	purgeBackupsOffline,
	restoreBackup,
	restoreBackupOffline,
	validateCreateBackup,
	validateDatabaseName,
	validateRestoreBackup,
	validateVerifyBackup,
	verifyBackupOffline,
	createBackupStream,
} = require('#src/dataLayer/rocksdbBackup');
const blobBackupModule = require('#src/dataLayer/blobBackup');
const { blobSnapshotDir } = blobBackupModule;
const { deleteBackupManifest, isBackupComplete } = require('#src/dataLayer/backupManifest');
const { getBlobPathsForDatabaseName } = require('#src/resources/blob');

// managed-backup ops self-enforce super_user (see requireSuperUser in rocksdbBackup.ts); requests
// in the online-operation tests below must therefore carry a super_user role.
const SU = { hdb_user: { role: { permission: { super_user: true } } } };
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
		// blob roots resolve outside storageDir (under the hdb base / configured blobPaths), so clean
		// them explicitly for every database name these tests touch
		for (const name of [DB_NAME, `${DB_NAME}-restored`, `${DB_NAME}-occupied`, `${DB_NAME}-blobs`]) {
			for (const root of getBlobPathsForDatabaseName(name)) rmSync(root, { recursive: true, force: true });
			rmSync(backupDirForDatabase(name), { recursive: true, force: true });
		}
		if (savedStoragePath === undefined) delete process.env.STORAGE_PATH;
		else process.env.STORAGE_PATH = savedStoragePath;
		rmSync(storageDir, { recursive: true, force: true });
		rmSync(backupDirForDatabase(DB_NAME), { recursive: true, force: true });
	});

	// Write a blob file into a database's (first) blob root at the given fileId-style relative path.
	function writeBlobFile(dbName, relPath, contents) {
		const root = getBlobPathsForDatabaseName(dbName)[0];
		const full = join(root, relPath);
		mkdirSync(dirname(full), { recursive: true });
		writeFileSync(full, contents);
		return full;
	}

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
			assert.deepStrictEqual(Object.keys(exposed[0]).sort(), ['backup_id', 'blobs', 'file_count', 'size', 'timestamp']);
			assert.strictEqual(exposed[0].backup_id, 1);
			assert.ok(exposed[0].file_count >= 1, 'file_count should be mapped from numberFiles');

			const verified = await verifyBackupOffline(DB_NAME, 1, true);
			assert.deepStrictEqual(verified, { database: DB_NAME, backup_id: 1, ok: true, blobs: true });

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
			const lock = beginRestore(databaseDir);
			try {
				await assert.rejects(createBackupOffline(DB_NAME), (error) => error.statusCode === 409);
			} finally {
				completeRestore(lock);
			}
		});
	});

	describe('online restore_backup validation', function () {
		it('rejects database=system with a pointer at running it offline', async function () {
			for (const fn of [validateRestoreBackup, restoreBackup]) {
				await assert.rejects(
					fn({ database: 'system', ...SU }),
					(error) => error.statusCode === 400 && /restore_backup database=system/.test(error.message)
				);
			}
		});

		it('rejects target_database instead of silently restoring in place', async function () {
			for (const fn of [validateRestoreBackup, restoreBackup]) {
				await assert.rejects(
					fn({ database: DB_NAME, target_database: 'copy', ...SU }),
					(error) => error.statusCode === 400 && /target_database/.test(error.message)
				);
			}
		});
	});

	// These are whole-database administrative ops and must never be reachable by a non-super_user,
	// even if a super_user places them in a role's `operations` allowlist (operation_authorization
	// gate-2 would otherwise authorize the delegation without a table-permission check). The auth
	// gate for the job ops (create/verify/restore) lives in their request-context validators.
	describe('super_user enforcement', function () {
		const gates = [
			['list_backups', listBackups],
			['delete_backup', deleteBackup],
			['purge_backups', purgeBackups],
			['create_backup', validateCreateBackup],
			['verify_backup', validateVerifyBackup],
			['restore_backup', validateRestoreBackup],
		];
		for (const [name, fn] of gates) {
			it(`rejects ${name} for a non-super_user role`, async function () {
				const nonSU = { database: DB_NAME, hdb_user: { role: { permission: { super_user: false } } } };
				await assert.rejects(
					fn(nonSU),
					(error) => error.statusCode === 403 && /restricted to super_user/.test(error.message)
				);
			});
			it(`rejects ${name} when no user is present`, async function () {
				await assert.rejects(
					fn({ database: DB_NAME }),
					(error) => error.statusCode === 403 && /restricted to super_user/.test(error.message)
				);
			});
		}
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

	describe('blob snapshots (managed backup)', function () {
		const BLOB_DB = `${DB_NAME}-blobs`;
		const blobDbDir = () => join(storageDir, BLOB_DB);
		const BLOB_REL = join('abc', 'def', 'ghi');

		function writeBlobDbRecord() {
			const database = RocksDatabase.open(blobDbDir());
			try {
				database.putSync('rec', { blob: BLOB_REL });
			} finally {
				database.close();
			}
		}

		afterEach(async function () {
			const before = await listBackupsInDir(backupDirForDatabase(BLOB_DB));
			if (before.length > 0) await purgeBackupsOffline(BLOB_DB, 0);
			for (const root of getBlobPathsForDatabaseName(BLOB_DB)) rmSync(root, { recursive: true, force: true });
			rmSync(blobDbDir(), { recursive: true, force: true });
		});

		it('captures blobs by default and restores them, including a blob deleted after the backup', async function () {
			this.timeout(30000);
			writeBlobDbRecord();
			writeBlobFile(BLOB_DB, BLOB_REL, 'blob-payload');

			const created = await createBackupOffline(BLOB_DB);
			assert.strictEqual(created.blobs, true, 'blobs should be captured by default');
			const backupDir = backupDirForDatabase(BLOB_DB);
			const snapshotFile = join(blobSnapshotDir(backupDir, created.backup_id), '0', BLOB_REL);
			assert.strictEqual(readFileSync(snapshotFile, 'utf8'), 'blob-payload', 'blob must be in the snapshot');

			// a backup writes restore instructions and a blob-layout doc into the repository
			const backupReadme = readFileSync(join(backupDir, 'README.md'), 'utf8');
			assert.match(backupReadme, new RegExp(`restore_backup database=${BLOB_DB}`));
			assert.ok(existsSync(join(backupDir, 'blobs', 'README.md')), 'blobs/ should carry a layout README');

			// delete the live blob after the backup, then restore in place — the blob must come back
			rmSync(join(getBlobPathsForDatabaseName(BLOB_DB)[0], BLOB_REL));
			await restoreBackupOffline(BLOB_DB, created.backup_id);
			assert.strictEqual(
				readFileSync(join(getBlobPathsForDatabaseName(BLOB_DB)[0], BLOB_REL), 'utf8'),
				'blob-payload',
				'a blob deleted after the backup must be restored'
			);
		});

		it('exclude_blobs produces an engine-only backup with no blob snapshot', async function () {
			this.timeout(30000);
			writeBlobDbRecord();
			writeBlobFile(BLOB_DB, BLOB_REL, 'blob-payload');

			const created = await createBackupOffline(BLOB_DB, true);
			assert.strictEqual(created.blobs, false);
			assert.ok(
				!existsSync(blobSnapshotDir(backupDirForDatabase(BLOB_DB), created.backup_id)),
				'no blob snapshot should be written when blobs are excluded'
			);
		});

		it('delete_backup and purge_backups remove the corresponding blob snapshots', async function () {
			this.timeout(30000);
			writeBlobDbRecord();
			writeBlobFile(BLOB_DB, BLOB_REL, 'payload-1');
			const first = await createBackupOffline(BLOB_DB);
			writeBlobFile(BLOB_DB, BLOB_REL, 'payload-2');
			const second = await createBackupOffline(BLOB_DB);
			const backupDir = backupDirForDatabase(BLOB_DB);

			assert.ok(existsSync(blobSnapshotDir(backupDir, first.backup_id)));
			assert.ok(existsSync(blobSnapshotDir(backupDir, second.backup_id)));

			await deleteBackupOffline(BLOB_DB, first.backup_id);
			assert.ok(!existsSync(blobSnapshotDir(backupDir, first.backup_id)), 'delete_backup must drop its blob snapshot');
			assert.ok(existsSync(blobSnapshotDir(backupDir, second.backup_id)), 'the surviving backup keeps its snapshot');

			await purgeBackupsOffline(BLOB_DB, 0);
			assert.ok(
				!existsSync(blobSnapshotDir(backupDir, second.backup_id)),
				'purge_backups must drop remaining snapshots'
			);
		});
	});

	describe('completion manifest', function () {
		const MDB = `${DB_NAME}-manifest`;
		const mdbDir = () => join(storageDir, MDB);

		afterEach(function () {
			rmSync(backupDirForDatabase(MDB), { recursive: true, force: true });
			rmSync(mdbDir(), { recursive: true, force: true });
			for (const root of getBlobPathsForDatabaseName(MDB)) rmSync(root, { recursive: true, force: true });
		});

		it('marks a finished backup complete, and hides / refuses one whose manifest is missing', async function () {
			this.timeout(30000);
			const db = RocksDatabase.open(mdbDir());
			try {
				db.putSync('k', 1);
			} finally {
				db.close();
			}
			const created = await createBackupOffline(MDB);
			const backupDir = backupDirForDatabase(MDB);
			assert.ok(isBackupComplete(backupDir, created.backup_id), 'a finished backup must have a manifest');
			assert.strictEqual((await listBackupsOffline(MDB)).length, 1);

			// simulate a failed/mid-flight create: the engine backup exists but the manifest does not
			await deleteBackupManifest(backupDir, created.backup_id);

			// hidden from the usable listing...
			assert.strictEqual((await listBackupsOffline(MDB)).length, 0, 'an incomplete backup must not be listed');
			// ...rejected as incomplete (409) by verify and by restoring that specific id...
			await assert.rejects(verifyBackupOffline(MDB, created.backup_id, false), (error) => error.statusCode === 409);
			await assert.rejects(restoreBackupOffline(MDB, created.backup_id), (error) => error.statusCode === 409);
			// ...and restoring "latest" finds no complete backup (404)
			await assert.rejects(restoreBackupOffline(MDB), (error) => error.statusCode === 404);
		});

		it('rolls back the engine backup, blob snapshot, and manifest when the blob snapshot fails', async function () {
			this.timeout(30000);
			const db = RocksDatabase.open(mdbDir());
			try {
				db.putSync('k', 1);
			} finally {
				db.close();
			}
			// force the blob-snapshot phase of finalizeBackup to fail
			const original = blobBackupModule.snapshotBlobs;
			blobBackupModule.snapshotBlobs = () => Promise.reject(new Error('snapshot boom'));
			try {
				await assert.rejects(createBackupOffline(MDB), /snapshot boom/);
			} finally {
				blobBackupModule.snapshotBlobs = original;
			}
			const backupDir = backupDirForDatabase(MDB);
			// the incomplete backup must be fully rolled back: no engine backup, no manifest, no snapshot
			assert.strictEqual((await listBackupsInDir(backupDir)).length, 0, 'engine backup must be rolled back');
			assert.ok(!isBackupComplete(backupDir, 1), 'no manifest should remain');
			assert.ok(!existsSync(blobSnapshotDir(backupDir, 1)), 'no partial blob snapshot should remain');
		});
	});

	describe('createBackupStream with blobs', function () {
		async function extractTarNames(stream) {
			const names = new Map();
			const ex = extract();
			const done = new Promise((resolve, reject) => {
				ex.on('entry', (header, entryStream, next) => {
					const chunks = [];
					entryStream.on('data', (c) => chunks.push(c));
					entryStream.on('end', () => {
						names.set(header.name, Buffer.concat(chunks));
						next();
					});
					entryStream.resume();
				});
				ex.on('finish', resolve);
				ex.on('error', reject);
			});
			stream.pipe(ex);
			await done;
			return names;
		}

		it('includes blob files alongside the database files in a valid tar', async function () {
			this.timeout(30000);
			const STREAM_DB = `${DB_NAME}-blobs`;
			const streamDbDir = join(storageDir, STREAM_DB);
			const database = RocksDatabase.open(streamDbDir);
			try {
				database.putSync('rec', { blob: 'x' });
			} finally {
				database.close();
			}
			const blobRel = join('111', '222', '333');
			writeBlobFile(STREAM_DB, blobRel, 'streamed-blob');

			const store = RocksDatabase.open(streamDbDir);
			try {
				const stream = createBackupStream(store, STREAM_DB, false, false);
				const entries = await extractTarNames(stream);
				// the archive holds both the RocksDB files and the blob, and is a single valid tar
				assert.ok(
					[...entries.keys()].some((name) => name === 'CURRENT'),
					'expected RocksDB CURRENT entry'
				);
				const blobEntry = `blobs/0/${blobRel.split(require('node:path').sep).join('/')}`;
				assert.ok(entries.has(blobEntry), `expected blob entry ${blobEntry}, got: ${[...entries.keys()].join(', ')}`);
				assert.strictEqual(entries.get(blobEntry).toString('utf8'), 'streamed-blob');
				// tar entry names are always POSIX-separated (no Windows backslashes leaking in)
				for (const name of entries.keys()) {
					assert.ok(!name.includes('\\'), `tar entry name must not contain a backslash: ${name}`);
				}
				// the archive carries the generated, self-documenting READMEs
				assert.ok(entries.has('README.md'), 'archive should include a top-level README');
				assert.match(entries.get('README.md').toString('utf8'), /get_backup/);
				assert.ok(entries.has('blobs/README.md'), 'archive should include a blobs layout README');
				assert.match(entries.get('blobs/README.md').toString('utf8'), /rootIndex/);
			} finally {
				store.close();
				rmSync(streamDbDir, { recursive: true, force: true });
				for (const root of getBlobPathsForDatabaseName(STREAM_DB)) rmSync(root, { recursive: true, force: true });
			}
		});

		it('exclude_blobs streams an engine-only tar (no blobs/ entries)', async function () {
			this.timeout(30000);
			const store = RocksDatabase.open(databaseDir);
			try {
				const stream = createBackupStream(store, DB_NAME, false, true);
				const entries = await extractTarNames(stream);
				assert.ok(
					![...entries.keys()].some((name) => name.startsWith('blobs/')),
					'engine-only tar must have no blobs/'
				);
			} finally {
				store.close();
			}
		});
	});

	describe('offline restore lock probe (two-process)', function () {
		it('refuses to restore a database another process holds open (real rocksdb-js LOCK error)', async function () {
			this.timeout(30000);
			writeRecords([['alpha', { n: 1 }]]);
			const created = await createBackupOffline(DB_NAME);

			// hold the database open in a separate process, as a running Harper would
			const bindingPath = require.resolve('@harperfast/rocksdb-js');
			const child = spawn(process.execPath, [
				'-e',
				`const { RocksDatabase } = require(${JSON.stringify(bindingPath)});` +
					`const db = RocksDatabase.open(${JSON.stringify(databaseDir)});` +
					`process.stdout.write('OPEN\\n');` +
					`setTimeout(() => { db.close(); process.exit(0); }, 15000);`,
			]);
			try {
				await new Promise((resolve, reject) => {
					let buf = '';
					child.stdout.on('data', (d) => {
						buf += d.toString();
						if (buf.includes('OPEN')) resolve();
					});
					child.once('error', reject);
					child.once('exit', (code) => reject(new Error(`child exited early (${code})`)));
				});
				await assert.rejects(
					restoreBackupOffline(DB_NAME, created.backup_id),
					(error) => error.statusCode === 409 && /open by a running Harper process/.test(error.message)
				);
			} finally {
				child.kill('SIGKILL');
				await purgeBackupsOffline(DB_NAME, 0);
			}
		});
	});
});
