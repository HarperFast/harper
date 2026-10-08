'use strict';

const assert = require('node:assert');
const fs = require('node:fs');
const {
	chmodSync,
	existsSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	renameSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} = fs;
const { dirname, join } = require('node:path');
const { tmpdir } = require('node:os');
const { spawn } = require('node:child_process');
const { syncBuiltinESMExports } = require('node:module');
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
	restorePinId,
	validateCreateBackup,
	validateDatabaseName,
	validateRestoreBackup,
	validateVerifyBackup,
	verifyBackup,
	assertBackupStillPresent,
	verifyBackupOffline,
	createBackupStream,
} = require('#src/dataLayer/rocksdbBackup');
const blobBackupModule = require('#src/dataLayer/blobBackup');
const { blobSnapshotDir } = blobBackupModule;
const { deleteBackupManifest, isBackupComplete } = require('#src/dataLayer/backupManifest');
const backupManifestModule = require('#src/dataLayer/backupManifest');
const { getBlobPathsForDatabaseName } = require('#src/resources/blob');

// managed-backup ops self-enforce super_user (see requireSuperUser in rocksdbBackup.ts); requests
// in the online-operation tests below must therefore carry a super_user role.
const SU = { hdb_user: { role: { permission: { super_user: true } } } };
const {
	abandonRestore,
	beginRestore,
	completeRestore,
	checkRestoreState,
	restoreReplacedPath,
	restoreStagingPath,
} = require('#src/dataLayer/restoreMarker');
const { pinBackup, readBackupPins, unpinBackup, withBackupRepositoryLock } = require('#src/dataLayer/backupRepository');
const { backups } = require('@harperfast/rocksdb-js');
const { closeLoadedDatabases } = require('#src/resources/databases');
const {
	ARCHIVE_MANIFEST_ENTRY,
	ARCHIVE_SCHEMA_VERSION,
	assertArchiveRestorable,
	parseArchiveManifest,
} = require('#src/dataLayer/backupArchiveManifest');
const { readBackupManifest } = require('#src/dataLayer/backupManifest');

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
		for (const name of [
			DB_NAME,
			`${DB_NAME}-restored`,
			`${DB_NAME}-occupied`,
			`${DB_NAME}-blobs`,
			`${DB_NAME}-interrupted`,
			`${DB_NAME}-foreign`,
		]) {
			for (const root of getBlobPathsForDatabaseName(name)) rmSync(root, { recursive: true, force: true });
			rmSync(backupDirForDatabase(name), { recursive: true, force: true });
		}
		if (savedStoragePath === undefined) delete process.env.STORAGE_PATH;
		else process.env.STORAGE_PATH = savedStoragePath;
		rmSync(storageDir, { recursive: true, force: true });
		rmSync(backupDirForDatabase(DB_NAME), { recursive: true, force: true });
	});

	// Write a blob file into a database's (first) blob root at the given fileId-style relative path,
	// shaped the way resources/blob.ts writes one: an 8-byte header (type in the top 16 bits, body
	// length in the low 48) then the body. A snapshot only captures complete blobs, so a headerless
	// fixture would be skipped.
	function writeBlobFile(dbName, relPath, contents) {
		const root = getBlobPathsForDatabaseName(dbName)[0];
		const full = join(root, relPath);
		mkdirSync(dirname(full), { recursive: true });
		const body = Buffer.from(contents);
		const header = Buffer.alloc(8);
		header.writeUInt16BE(0, 0); // UNCOMPRESSED
		header.writeUIntBE(body.length, 2, 6);
		writeFileSync(full, Buffer.concat([header, body]));
		return full;
	}

	function readBlobBody(path) {
		return readFileSync(path).subarray(8).toString('utf8');
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

		// An interrupted restore leaves its target populated and marked. Refusing the rerun on occupancy
		// grounds wedges it for good: drop_database refuses a marked directory too, and the marker keeps
		// the pin live, so every purge of the source the rerun needs 409s as well.
		it('reruns an interrupted restore into the same target instead of wedging it', async function () {
			this.timeout(30000);
			const TARGET = `${DB_NAME}-interrupted`;
			writeRecords([['alpha', { n: 1 }]]);
			const first = await createBackupOffline(DB_NAME);
			await restoreBackupOffline(DB_NAME, first.backup_id, TARGET);

			const targetDir = join(storageDir, TARGET);
			const backupDir = backupDirForDatabase(DB_NAME);
			// leave the target exactly as a killed restore would: populated, marked, its source pinned
			await withBackupRepositoryLock(backupDir, DB_NAME, async () => {
				pinBackup(backupDir, restorePinId(targetDir), first.backup_id, 'an interrupted restore', targetDir);
			});
			// abandon, not hold: the lock must be free, or the rerun is refused for contention instead
			abandonRestore(beginRestore(targetDir));
			assert.strictEqual(readBackupPins(backupDir).length, 1, 'precondition: the interrupted restore holds its source');

			try {
				const second = await createBackupOffline(DB_NAME);
				await assert.doesNotReject(restoreBackupOffline(DB_NAME, second.backup_id, TARGET));
				assert.strictEqual(checkRestoreState(targetDir), 'clear', 'the rerun must clear the marker it inherited');
				assert.deepStrictEqual(readBackupPins(backupDir), [], 'and release the pin that was blocking every purge');
			} finally {
				rmSync(targetDir, { recursive: true, force: true });
				await purgeBackupsOffline(DB_NAME, 0).catch(() => {});
			}
		});

		it("refuses a marked target when the marker is not this source's own interrupted restore", async function () {
			this.timeout(30000);
			const TARGET = `${DB_NAME}-foreign`;
			writeRecords([['alpha', { n: 1 }]]);
			const first = await createBackupOffline(DB_NAME);
			await restoreBackupOffline(DB_NAME, first.backup_id, TARGET);

			const targetDir = join(storageDir, TARGET);
			const backupDir = backupDirForDatabase(DB_NAME);
			// a marker with no pin in THIS source's repository: debris of a restore out of some other
			// repository. The marker records only the directory name, so it is not proof of ownership,
			// and purging on the strength of it would destroy a database this source never claimed.
			abandonRestore(beginRestore(targetDir));
			assert.deepStrictEqual(readBackupPins(backupDir), [], 'precondition: this source claims nothing here');

			try {
				await assert.rejects(restoreBackupOffline(DB_NAME, first.backup_id, TARGET), (error) =>
					/already exists/.test(error.message)
				);
			} finally {
				completeRestore(beginRestore(targetDir));
				rmSync(targetDir, { recursive: true, force: true });
				await purgeBackupsOffline(DB_NAME, 0).catch(() => {});
			}
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

	// harper#2965: a backup this build cannot read must be refused before the destination is touched,
	// and a publication interrupted between its renames must never cost the only copy of the database.
	describe('restore staging', function () {
		const STAGED = `${DB_NAME}-staged`;
		const stagedDir = () => join(storageDir, STAGED);
		const RECORDS = Array.from({ length: 500 }, (_, i) => [`k${i}`, { i, pad: 'x'.repeat(100) }]);

		afterEach(async function () {
			// a refused online restore reloads the database it left intact, in this process too
			await closeLoadedDatabases();
			if (checkRestoreState(stagedDir()) !== 'clear') completeRestore(beginRestore(stagedDir()));
			rmSync(stagedDir(), { recursive: true, force: true });
			rmSync(backupDirForDatabase(STAGED), { recursive: true, force: true });
			rmSync(restoreStagingPath(stagedDir()), { recursive: true, force: true });
			rmSync(restoreReplacedPath(stagedDir()), { recursive: true, force: true });
		});

		async function seed() {
			const database = RocksDatabase.open(stagedDir());
			try {
				await database.transaction(async (transaction) => {
					transaction.useLog('audit').addEntry(Buffer.from('entry'));
					for (const [key, value] of RECORDS) transaction.putSync(key, value);
				});
				await database.flush();
			} finally {
				database.close();
			}
			const { backup_id: backupId } = await createBackupOffline(STAGED);
			// diverge from the backup, so "intact" cannot be satisfied by a restore that happened to succeed
			const after = RocksDatabase.open(stagedDir());
			try {
				after.putSync('after-backup', { kept: true });
			} finally {
				after.close();
			}
			return backupId;
		}

		function assertNoDebris() {
			for (const path of [restoreStagingPath(stagedDir()), restoreReplacedPath(stagedDir())]) {
				assert.ok(!existsSync(path), `${path} must not be left behind`);
			}
		}

		function assertDestinationIntact() {
			assert.strictEqual(checkRestoreState(stagedDir()), 'clear', 'a refused restore must not leave a marker');
			const database = RocksDatabase.open(stagedDir());
			try {
				assert.deepStrictEqual(database.getSync('k7'), RECORDS[7][1]);
				assert.deepStrictEqual(database.getSync('after-backup'), { kept: true }, 'the pre-restore data must survive');
			} finally {
				database.close();
			}
			assertNoDebris();
		}

		function assertRestoredFromBackup() {
			const database = RocksDatabase.open(stagedDir());
			try {
				assert.deepStrictEqual(database.getSync('k7'), RECORDS[7][1]);
				assert.strictEqual(database.getSync('after-backup'), undefined, 'the restore took effect');
			} finally {
				database.close();
			}
		}

		// RocksDB's backup meta records a crc32c per file, verified as the file is copied out.
		function crc32c(buffer) {
			let crc = 0xffffffff;
			for (const byte of buffer) {
				crc ^= byte;
				for (let bit = 0; bit < 8; bit++) crc = crc & 1 ? (crc >>> 1) ^ 0x82f63b78 : crc >>> 1;
			}
			return (crc ^ 0xffffffff) >>> 0;
		}

		// A table whose footer declares a format_version this build does not know — what a newer
		// binding's table format looks like to this one — with its checksum re-recorded, so the copy
		// succeeds and only an open by this build can refuse it.
		function writeUnsupportedTableFormat(backupId) {
			const backupDir = backupDirForDatabase(STAGED);
			const sst = readdirSync(join(backupDir, 'shared_checksum')).find((name) => name.endsWith('.sst'));
			assert.ok(sst, 'precondition: the backup holds a table file');
			const sstPath = join(backupDir, 'shared_checksum', sst);
			const contents = readFileSync(sstPath);
			contents.writeUInt32LE(99, contents.length - 12);
			writeFileSync(sstPath, contents);
			const metaPath = join(backupDir, 'meta', String(backupId));
			const meta = readFileSync(metaPath, 'utf8');
			const entry = new RegExp(`^(shared_checksum/${sst} crc32 )\\d+$`, 'm');
			assert.match(meta, entry);
			writeFileSync(metaPath, meta.replace(entry, `$1${crc32c(contents)}`));
		}

		function writeUnsupportedLogVersion(backupId) {
			const store = join(backupDirForDatabase(STAGED), 'transaction_logs', String(backupId), 'audit');
			const log = readdirSync(store).find((name) => name.endsWith('.txnlog'));
			const contents = readFileSync(join(store, log));
			contents[4] = 99;
			writeFileSync(join(store, log), contents);
		}

		function corruptBackupFile(backupId) {
			const privateDir = join(backupDirForDatabase(STAGED), 'private', String(backupId));
			const manifest = readdirSync(privateDir).find((name) => name.startsWith('MANIFEST-'));
			const contents = readFileSync(join(privateDir, manifest));
			contents.fill(0x5a, 0, Math.min(contents.length, 64));
			writeFileSync(join(privateDir, manifest), contents);
		}

		const restores = {
			offline: (backupId) => restoreBackupOffline(STAGED, backupId),
			online: (backupId) => restoreBackup({ ...SU, database: STAGED, backup_id: backupId }),
		};
		const unreadable = [
			['a corrupt backup', corruptBackupFile, /checksum/i],
			['a table format this build cannot open', writeUnsupportedTableFormat, /format_version 99/],
			['a transaction log format this build cannot read', writeUnsupportedLogVersion, /version: 99/],
		];
		for (const [mode, restore] of Object.entries(restores)) {
			for (const [label, damage, signature] of unreadable) {
				it(`${mode}: refuses ${label} without touching the destination`, async function () {
					this.timeout(30000);
					const backupId = await seed();
					damage(backupId);
					await assert.rejects(
						restore(backupId),
						(error) => signature.test(error.message) && /was not modified/.test(error.message)
					);
					assertDestinationIntact();
				});
			}

			it(`${mode}: puts the database back when publication fails after moving it aside`, async function () {
				this.timeout(30000);
				const backupId = await seed();
				const realRename = fs.renameSync;
				fs.renameSync = (from, to) => {
					if (from === restoreStagingPath(stagedDir()))
						throw Object.assign(new Error('injected EXDEV'), { code: 'EXDEV' });
					return realRename(from, to);
				};
				// under TypeStrip the module binds the ESM builtin export, which only this re-syncs
				syncBuiltinESMExports();
				try {
					await assert.rejects(restore(backupId), /injected EXDEV/);
				} finally {
					fs.renameSync = realRename;
					syncBuiltinESMExports();
				}
				assertDestinationIntact();
			});
		}

		it('keeps the database directory mode across the swap', async function () {
			if (process.platform === 'win32') this.skip();
			this.timeout(30000);
			const backupId = await seed();
			chmodSync(stagedDir(), 0o700);
			await restoreBackupOffline(STAGED, backupId);
			assertRestoredFromBackup();
			assert.strictEqual(lstatSync(stagedDir()).mode & 0o777, 0o700);
			assertNoDebris();
		});

		// Nothing was displaced, so only the published engine says the destination changed; the marker
		// has to outlive a blob restore that fails after it.
		it('keeps the marker when a restore into a new target fails after publication', async function () {
			this.timeout(30000);
			const backupId = await seed();
			const TARGET = `${STAGED}-target`;
			const targetDir = join(storageDir, TARGET);
			const realRestoreBlobs = blobBackupModule.restoreBlobSnapshot;
			blobBackupModule.restoreBlobSnapshot = async () => {
				throw new Error('injected blob failure');
			};
			try {
				await assert.rejects(restoreBackupOffline(STAGED, backupId, TARGET), /injected blob failure/);
				assert.strictEqual(checkRestoreState(targetDir), 'incomplete');
			} finally {
				blobBackupModule.restoreBlobSnapshot = realRestoreBlobs;
				completeRestore(beginRestore(targetDir));
				rmSync(targetDir, { recursive: true, force: true });
				rmSync(restoreStagingPath(targetDir), { recursive: true, force: true });
				for (const root of getBlobPathsForDatabaseName(TARGET)) rmSync(root, { recursive: true, force: true });
			}
		});

		it('refuses a backup that would not fit beside the database before staging anything', async function () {
			this.timeout(30000);
			const backupId = await seed();
			const realStatfs = fs.statfsSync;
			fs.statfsSync = (path, ...rest) => ({ ...realStatfs(path, ...rest), bavail: 1, bsize: 4096 });
			syncBuiltinESMExports();
			try {
				for (const restore of Object.values(restores)) {
					await assert.rejects(
						restore(backupId),
						(error) => error.statusCode === 507 && /was not modified/.test(error.message)
					);
					assertDestinationIntact();
				}
			} finally {
				fs.statfsSync = realStatfs;
				syncBuiltinESMExports();
			}
		});

		it('refuses a database directory that is a mount point before staging anything', async function () {
			this.timeout(30000);
			const backupId = await seed();
			const realStat = fs.statSync;
			fs.statSync = (path, ...rest) => {
				const stats = realStat(path, ...rest);
				return path === stagedDir()
					? Object.assign(Object.create(Object.getPrototypeOf(stats)), stats, { dev: stats.dev + 1 })
					: stats;
			};
			syncBuiltinESMExports();
			try {
				await assert.rejects(
					restoreBackupOffline(STAGED, backupId),
					(error) => error.statusCode === 400 && /mount point/.test(error.message)
				);
			} finally {
				fs.statSync = realStat;
				syncBuiltinESMExports();
			}
			assertDestinationIntact();
		});

		it('refuses a symlinked database directory before staging anything', async function () {
			this.timeout(30000);
			const backupId = await seed();
			const realDir = `${stagedDir()}-real`;
			renameSync(stagedDir(), realDir);
			symlinkSync(realDir, stagedDir(), 'dir');
			try {
				await assert.rejects(
					restoreBackupOffline(STAGED, backupId),
					(error) => error.statusCode === 400 && /symbolic link/.test(error.message)
				);
				assert.ok(lstatSync(stagedDir()).isSymbolicLink(), 'the link is untouched');
				assert.strictEqual(checkRestoreState(stagedDir()), 'clear');
				assertNoDebris();
			} finally {
				rmSync(stagedDir(), { force: true });
				renameSync(realDir, stagedDir());
			}
		});

		// Killed between moving the database aside and publishing its replacement: the database path is
		// empty and `.replaced` is the only copy of it.
		async function killBetweenRenames(backupId) {
			const child = spawn(
				process.execPath,
				[
					'-e',
					`
				const fs = require('node:fs');
				const env = require(${JSON.stringify(require.resolve('#src/utility/environment/environmentManager'))});
				env.initSync();
				env.setProperty('storage.backupPath', ${JSON.stringify(getBackupsRoot())});
				const rename = fs.renameSync;
				fs.renameSync = (from, to) => {
					rename(from, to);
					if (to.endsWith('.replaced')) process.kill(process.pid, 'SIGKILL');
				};
				require('node:module').syncBuiltinESMExports();
				const backup = require(${JSON.stringify(require.resolve('#src/dataLayer/rocksdbBackup'))});
				backup.restoreBackupOffline(${JSON.stringify(STAGED)}, ${backupId})
					.then(() => process.exit(2), (error) => { console.error(error); process.exit(3); });
			`,
				],
				{ timeout: 20000, env: { ...process.env, STORAGE_PATH: storageDir } }
			);
			let stderr = '';
			child.stderr.on('data', (data) => {
				stderr += data;
			});
			const signal = await new Promise((resolve, reject) => {
				child.once('error', reject);
				child.once('exit', (code, exitSignal) =>
					exitSignal ? resolve(exitSignal) : reject(new Error(`child exited ${code}: ${stderr}`))
				);
			});
			assert.strictEqual(signal, 'SIGKILL');
			assert.strictEqual(checkRestoreState(stagedDir()), 'incomplete');
			assert.ok(!existsSync(stagedDir()), 'precondition: killed with the database moved aside');
			assert.ok(existsSync(restoreReplacedPath(stagedDir())));
		}

		it('keeps the moved-aside database through a failed rerun', async function () {
			this.timeout(60000);
			const good = await seed();
			await killBetweenRenames(good);
			corruptBackupFile(good);
			await assert.rejects(restoreBackupOffline(STAGED, good), /was not modified/);
			assert.strictEqual(checkRestoreState(stagedDir()), 'incomplete', 'a failed recovery keeps the marker');
			assert.ok(existsSync(restoreReplacedPath(stagedDir())), 'and the only copy of the database');
		});

		it('reruns a publication interrupted between its renames, keeping the moved-aside mode', async function () {
			this.timeout(60000);
			const backupId = await seed();
			chmodSync(stagedDir(), 0o700);
			await killBetweenRenames(backupId);
			await restoreBackupOffline(STAGED, backupId);
			assert.strictEqual(checkRestoreState(stagedDir()), 'clear');
			assertRestoredFromBackup();
			if (process.platform !== 'win32') assert.strictEqual(lstatSync(stagedDir()).mode & 0o777, 0o700);
			assertNoDebris();
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
			assert.strictEqual(readBlobBody(snapshotFile), 'blob-payload', 'blob must be in the snapshot');

			// a backup writes restore instructions and a blob-layout doc into the repository
			const backupReadme = readFileSync(join(backupDir, 'README.md'), 'utf8');
			assert.match(backupReadme, new RegExp(`restore_backup database=${BLOB_DB}`));
			assert.ok(existsSync(join(backupDir, 'blobs', 'README.md')), 'blobs/ should carry a layout README');

			// delete the live blob after the backup, then restore in place — the blob must come back
			rmSync(join(getBlobPathsForDatabaseName(BLOB_DB)[0], BLOB_REL));
			await restoreBackupOffline(BLOB_DB, created.backup_id);
			assert.strictEqual(
				readBlobBody(join(getBlobPathsForDatabaseName(BLOB_DB)[0], BLOB_REL)),
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

		it('does not publish a complete backup when a configured blob root is not a directory', async function () {
			this.timeout(30000);
			writeBlobDbRecord();
			const root = getBlobPathsForDatabaseName(BLOB_DB)[0];
			mkdirSync(dirname(root), { recursive: true });
			writeFileSync(root, 'not-a-directory');

			await assert.rejects(createBackupOffline(BLOB_DB), (error) => error.code === 'ENOTDIR');
			assert.deepStrictEqual(await listBackupsInDir(backupDirForDatabase(BLOB_DB)), []);
		});

		it('refuses an in-place restore of an engine-only backup while the database still has blobs', async function () {
			this.timeout(30000);
			writeBlobDbRecord();
			writeBlobFile(BLOB_DB, BLOB_REL, 'blob-payload');
			const created = await createBackupOffline(BLOB_DB, true);

			await assert.rejects(
				restoreBackupOffline(BLOB_DB, created.backup_id),
				(error) => error.statusCode === 400 && /allow_engine_only/.test(error.message)
			);
			// nothing destructive ran: the blob and the database are untouched
			assert.strictEqual(readBlobBody(join(getBlobPathsForDatabaseName(BLOB_DB)[0], BLOB_REL)), 'blob-payload');
			assert.strictEqual(checkRestoreState(blobDbDir()), 'clear');
		});

		it('allows the same restore when the operator opts in, and records the opt-in', async function () {
			this.timeout(30000);
			writeBlobDbRecord();
			writeBlobFile(BLOB_DB, BLOB_REL, 'blob-payload');
			const created = await createBackupOffline(BLOB_DB, true);

			const restored = await restoreBackupOffline(BLOB_DB, created.backup_id, undefined, true);
			assert.strictEqual(restored.allow_engine_only, true);
			// the live blob is deliberately left in place — that is what the opt-in accepts
			assert.strictEqual(readBlobBody(join(getBlobPathsForDatabaseName(BLOB_DB)[0], BLOB_REL)), 'blob-payload');
		});

		it('refuses an engine-only restore with no opt-in even when the database has no blobs', async function () {
			this.timeout(30000);
			writeBlobDbRecord();
			const created = await createBackupOffline(BLOB_DB, true);

			// Empty roots do not make this safe: the id counter re-seeds from the roots, so it hands out
			// 1 again and the next blob lands on a path the restored records already reference.
			await assert.rejects(
				restoreBackupOffline(BLOB_DB, created.backup_id),
				(error) => error.statusCode === 400 && /allow_engine_only/.test(error.message)
			);
		});

		it('allows it once the operator opts in, and reports the opt-in back', async function () {
			this.timeout(30000);
			writeBlobDbRecord();
			const created = await createBackupOffline(BLOB_DB, true);

			const restored = await restoreBackupOffline(BLOB_DB, created.backup_id, undefined, true);
			assert.strictEqual(restored.backup_id, created.backup_id);
			assert.strictEqual(restored.allow_engine_only, true);
		});

		it('refuses an engine-only restore into a new database too', async function () {
			this.timeout(30000);
			writeBlobDbRecord();
			writeBlobFile(BLOB_DB, BLOB_REL, 'blob-payload');
			const created = await createBackupOffline(BLOB_DB, true);
			const target = `${BLOB_DB}-copy`;

			try {
				// A fresh target's roots are empty for the same reason, so it is exposed to the same
				// id reissue -- naming a new database is not an escape hatch.
				await assert.rejects(
					restoreBackupOffline(BLOB_DB, created.backup_id, target),
					(error) => error.statusCode === 400 && /allow_engine_only/.test(error.message)
				);
			} finally {
				rmSync(join(storageDir, target), { recursive: true, force: true });
				for (const root of getBlobPathsForDatabaseName(target)) rmSync(root, { recursive: true, force: true });
			}
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

	describe('repository operations without a loaded database', function () {
		// These tests run with no database loaded into Harper at all, which is the state an operator is
		// in after a failed restore (blocked by its marker) or before an import creates the database.
		const ORPHAN = `${DB_NAME}-orphan`;
		const MISSING = `${DB_NAME}-never-existed`;

		afterEach(async function () {
			// The online operations reach getDatabases(), whose scan opens every database under
			// STORAGE_PATH — including the fixtures other tests in this file expect to be closed.
			await closeLoadedDatabases();
			rmSync(join(storageDir, ORPHAN), { recursive: true, force: true });
			rmSync(backupDirForDatabase(ORPHAN), { recursive: true, force: true });
			for (const suffix of ['delete', 'purge']) {
				rmSync(backupDirForDatabase(`${MISSING}-${suffix}`), { recursive: true, force: true });
			}
		});

		async function seedOrphanRepository() {
			const database = RocksDatabase.open(join(storageDir, ORPHAN));
			try {
				database.putSync('rec', { value: 1 });
			} finally {
				database.close();
			}
			return createBackupOffline(ORPHAN);
		}

		it('lists, verifies, deletes and purges a repository whose database is not loaded', async function () {
			this.timeout(30000);
			const created = await seedOrphanRepository();

			const listed = await listBackups({ ...SU, database: ORPHAN });
			assert.deepStrictEqual(
				listed.map((backup) => backup.backup_id),
				[created.backup_id]
			);

			const verified = await verifyBackup({ ...SU, database: ORPHAN, backup_id: created.backup_id });
			assert.strictEqual(verified.ok, true);

			const second = await createBackupOffline(ORPHAN);
			assert.deepStrictEqual(await purgeBackups({ ...SU, database: ORPHAN, keep_count: 1 }), {
				deleted: 1,
				remaining: 1,
			});
			assert.deepStrictEqual(await deleteBackup({ ...SU, database: ORPHAN, backup_id: second.backup_id }), {
				ok: true,
			});
			assert.deepStrictEqual(await listBackups({ ...SU, database: ORPHAN }), []);
		});

		it('still 404s for a name that is neither a loaded database nor a repository', async function () {
			await assert.rejects(
				listBackups({ ...SU, database: MISSING }),
				(error) => error.statusCode === 404 && /no backup repository/.test(error.message)
			);
		});

		it('does not create a repository when offline delete or purge targets a missing one', async function () {
			for (const [suffix, operation] of [
				['delete', (name) => deleteBackupOffline(name, 1)],
				['purge', (name) => purgeBackupsOffline(name, 0)],
			]) {
				const databaseName = `${MISSING}-${suffix}`;
				const backupDir = backupDirForDatabase(databaseName);
				await assert.rejects(operation(databaseName), (error) => error.statusCode === 404);
				assert.ok(!existsSync(backupDir), `${suffix} must not create ${backupDir}`);
			}
			// the 404 must still be there the second time round, and still name a missing repository
			await assert.rejects(
				listBackups({ ...SU, database: `${MISSING}-delete` }),
				(error) => error.statusCode === 404 && /no backup repository/.test(error.message)
			);
		});
	});

	describe('backup pins', function () {
		const PINNED = `${DB_NAME}-pinned`;

		afterEach(async function () {
			if (checkRestoreState(join(storageDir, PINNED)) !== 'clear') {
				completeRestore(beginRestore(join(storageDir, PINNED)));
			}
			rmSync(join(storageDir, PINNED), { recursive: true, force: true });
			rmSync(backupDirForDatabase(PINNED), { recursive: true, force: true });
		});

		async function seedTwoBackups() {
			const database = RocksDatabase.open(join(storageDir, PINNED));
			try {
				database.putSync('rec', { value: 1 });
			} finally {
				database.close();
			}
			const first = await createBackupOffline(PINNED);
			const second = await createBackupOffline(PINNED);
			return { first, second };
		}

		for (const mode of ['online', 'offline']) {
			it(`protects the source after ${mode} restore dies immediately after publishing its marker`, async function () {
				this.timeout(30000);
				const { first } = await seedTwoBackups();
				const child = spawn(
					process.execPath,
					[
						'-e',
						`
					const fs = require('node:fs');
					const { dirname } = require('node:path');
					const env = require(${JSON.stringify(require.resolve('#src/utility/environment/environmentManager'))});
					env.initSync();
					env.setProperty('storage.backupPath', ${JSON.stringify(getBackupsRoot())});
					const { fsyncDirectory } = require(${JSON.stringify(require.resolve('#src/utility/durableFile'))});
					const rename = fs.renameSync;
					fs.renameSync = (from, to) => {
						rename(from, to);
						if (to.endsWith('.restoring')) {
							fsyncDirectory(dirname(to));
							process.kill(process.pid, 'SIGKILL');
						}
					};
					require('node:module').syncBuiltinESMExports();
					const backup = require(${JSON.stringify(require.resolve('#src/dataLayer/rocksdbBackup'))});
					const operation = ${JSON.stringify(mode)} === 'offline'
						? backup.restoreBackupOffline(${JSON.stringify(PINNED)}, ${first.backup_id})
						: backup.restoreBackup({ database: ${JSON.stringify(PINNED)}, backup_id: ${first.backup_id} });
					operation.then(() => process.exit(2), error => { console.error(error); process.exit(3); });
				`,
					],
					{ timeout: 15000 }
				);
				let stderr = '';
				child.stderr.on('data', (data) => {
					stderr += data;
				});
				try {
					const signal = await new Promise((resolve, reject) => {
						child.once('error', reject);
						child.once('exit', (code, signal) =>
							signal ? resolve(signal) : reject(new Error(`child exited ${code}: ${stderr}`))
						);
					});
					assert.strictEqual(signal, 'SIGKILL');
					assert.strictEqual(checkRestoreState(join(storageDir, PINNED)), 'incomplete');
					await assert.rejects(deleteBackupOffline(PINNED, first.backup_id), (error) => error.statusCode === 409);
					await assert.rejects(purgeBackupsOffline(PINNED, 0), (error) => error.statusCode === 409);
				} finally {
					child.kill('SIGKILL');
				}
			});
		}

		for (const operation of ['delete', 'purge']) {
			for (const [module, method] of [
				[blobBackupModule, 'purgeBlobSnapshots'],
				[backupManifestModule, 'purgeBackupManifests'],
			]) {
				for (const engineFails of [false, true]) {
					it(`${operation} propagates ${engineFails ? 'the engine error on dual failure' : method + ' failure after engine success'}`, async function () {
						this.timeout(30000);
						const { first } = await seedTwoBackups();
						const cleanupError = new Error('injected cleanup failure');
						const engineError = new Error('injected engine failure');
						const originalCleanup = module[method];
						const originalEngine = backups[operation];
						let cleanupAttempted = false;
						module[method] = async () => {
							cleanupAttempted = true;
							throw cleanupError;
						};
						if (engineFails)
							backups[operation] = async () => {
								throw engineError;
							};
						try {
							await assert.rejects(
								operation === 'delete' ? deleteBackupOffline(PINNED, first.backup_id) : purgeBackupsOffline(PINNED, 0),
								(error) => error === (engineFails ? engineError : cleanupError)
							);
							assert.ok(cleanupAttempted);
							const remaining = await listBackupsInDir(backupDirForDatabase(PINNED));
							assert.strictEqual(
								remaining.some((backup) => backup.backupId === first.backup_id),
								engineFails
							);
						} finally {
							module[method] = originalCleanup;
							backups[operation] = originalEngine;
						}
					});
				}
			}
		}

		it('refuses to delete a backup something is depending on', async function () {
			this.timeout(30000);
			const { first } = await seedTwoBackups();
			const backupDir = backupDirForDatabase(PINNED);
			pinBackup(backupDir, 'restore-pending', first.backup_id, 'restore pending restart');

			await assert.rejects(
				deleteBackupOffline(PINNED, first.backup_id),
				(error) => error.statusCode === 409 && /restore pending restart/.test(error.message)
			);
			// and the backup is still there
			assert.ok((await listBackupsInDir(backupDir)).some((backup) => backup.backupId === first.backup_id));

			unpinBackup(backupDir, 'restore-pending');
			assert.deepStrictEqual(await deleteBackupOffline(PINNED, first.backup_id), { ok: true });
		});

		it('refuses to report an unreadable repository as empty', async function () {
			// an empty listing is what reconcileHarperManagedBackupFiles reads as "keep nothing", so
			// answering [] for a repository that is merely unreadable licenses deleting every manifest
			// and blob snapshot in it
			if (process.platform === 'win32' || process.getuid?.() === 0) this.skip();
			const { first } = await seedTwoBackups();
			assert.ok(first.backup_id);
			const backupDir = backupDirForDatabase(PINNED);
			chmodSync(backupDir, 0o000);
			try {
				await assert.rejects(listBackupsInDir(backupDir), (error) => error.code === 'EACCES');
			} finally {
				chmodSync(backupDir, 0o700);
			}
		});

		it('refuses a purge that would remove a pinned backup, and removes nothing', async function () {
			this.timeout(30000);
			const { first } = await seedTwoBackups();
			const backupDir = backupDirForDatabase(PINNED);
			pinBackup(backupDir, 'restore-pending', first.backup_id, 'restore pending restart');

			await assert.rejects(
				purgeBackupsOffline(PINNED, 1),
				(error) => error.statusCode === 409 && new RegExp(`backup ${first.backup_id}`).test(error.message)
			);
			assert.strictEqual((await listBackupsInDir(backupDir)).length, 2, 'a refused purge must remove nothing');
		});

		it('keeps the newest keep_count by id, and reports what it actually removed', async function () {
			this.timeout(30000);
			const { first, second } = await seedTwoBackups();
			const third = await createBackupOffline(PINNED);
			const backupDir = backupDirForDatabase(PINNED);

			const purged = await purgeBackupsOffline(PINNED, 1);

			assert.deepStrictEqual(purged, { deleted: 2, remaining: 1 }, 'counted from what survives, under the lock');
			assert.deepStrictEqual(
				(await listBackupsInDir(backupDir)).map((backup) => backup.backupId),
				[third.backup_id]
			);
			assert.ok(![first.backup_id, second.backup_id].some((id) => id === third.backup_id));
		});

		it('holds the management lock across the engine backup, not just the finalization', async function () {
			this.timeout(30000);
			const database = RocksDatabase.open(join(storageDir, PINNED));
			try {
				database.putSync('rec', { n: 1 });
			} finally {
				database.close();
			}
			const backupDir = backupDirForDatabase(PINNED);

			let created;
			await withBackupRepositoryLock(
				backupDir,
				PINNED,
				async () => {
					created = createBackupOffline(PINNED);
					created.catch(() => {}); // settled below; this only keeps an early failure unhandled-free
					await new Promise((resolve) => setTimeout(resolve, 750));
					assert.deepStrictEqual(
						await listBackupsInDir(backupDir),
						[],
						'the engine backup must not be created while another operation holds the lock'
					);
				},
				true
			);

			await created;
			assert.strictEqual((await listBackupsInDir(backupDir)).length, 1, 'and it proceeds once the lock is free');
		});

		it('refuses to publish a backup the engine no longer has by the time it finalizes', async function () {
			this.timeout(30000);
			const { first } = await seedTwoBackups();
			const backupDir = backupDirForDatabase(PINNED);

			// what finalization faces when a writer outside the management lock removes the backup: the
			// id it holds no longer exists
			await assertBackupStillPresent(backupDir, first.backup_id, PINNED);
			await backups.delete(backupDir, first.backup_id);
			await assert.rejects(
				assertBackupStillPresent(backupDir, first.backup_id, PINNED),
				(error) => error.statusCode === 404 && /removed while it was being finalized/.test(error.message)
			);
		});

		// The check above is only worth having if finalizeBackup runs it. This covers the post-snapshot
		// call — the one that decides whether a manifest gets published for engine files that are gone.
		// The pre-snapshot call only saves wasted copying, and no test distinguishes its absence.
		it('does not publish a manifest when the engine backup disappears mid-finalization', async function () {
			this.timeout(30000);
			const database = RocksDatabase.open(join(storageDir, PINNED));
			try {
				database.putSync('rec', { n: 1 });
			} finally {
				database.close();
			}
			// stand in for a writer outside Harper's management lock removing the backup under us
			const original = blobBackupModule.snapshotBlobs;
			blobBackupModule.snapshotBlobs = async (dir) => {
				for (const backup of await listBackupsInDir(dir)) await backups.delete(dir, backup.backupId);
			};
			try {
				await assert.rejects(
					createBackupOffline(PINNED),
					(error) => error.statusCode === 404 && /removed while it was being finalized/.test(error.message)
				);
			} finally {
				blobBackupModule.snapshotBlobs = original;
			}
			assert.deepStrictEqual(
				await listBackupsOffline(PINNED),
				[],
				'no backup may be published for missing engine files'
			);
		});

		it('sweeps blob snapshots the engine no longer has, whatever removed them', async function () {
			this.timeout(30000);
			const { first, second } = await seedTwoBackups();
			const backupDir = backupDirForDatabase(PINNED);
			// an engine backup removed without Harper's cleanup — what a delete that threw partway
			// through leaves behind
			await backups.delete(backupDir, first.backup_id);
			assert.ok(existsSync(blobSnapshotDir(backupDir, first.backup_id)), 'precondition: snapshot is orphaned');

			await deleteBackupOffline(PINNED, second.backup_id);

			assert.ok(
				!existsSync(blobSnapshotDir(backupDir, first.backup_id)),
				'an orphaned snapshot must not keep charging the quota'
			);
		});

		it('releases its claim on the source once a restore finishes', async function () {
			this.timeout(30000);
			const { second } = await seedTwoBackups();
			const backupDir = backupDirForDatabase(PINNED);

			await restoreBackupOffline(PINNED, second.backup_id);
			assert.deepStrictEqual(readBackupPins(backupDir), [], 'a finished restore must not hold the backup');
		});

		it('allows a purge that keeps every pinned backup', async function () {
			this.timeout(30000);
			const { second } = await seedTwoBackups();
			const backupDir = backupDirForDatabase(PINNED);
			pinBackup(backupDir, 'restore-pending', second.backup_id, 'restore pending restart');

			const purged = await purgeBackupsOffline(PINNED, 1);
			assert.strictEqual(purged.remaining, 1);
			assert.ok((await listBackupsInDir(backupDir)).some((backup) => backup.backupId === second.backup_id));
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

	describe('managed backup provenance', function () {
		const PROV_DB = `${DB_NAME}-provenance`;

		afterEach(async function () {
			await closeLoadedDatabases();
			rmSync(join(storageDir, PROV_DB), { recursive: true, force: true });
			rmSync(backupDirForDatabase(PROV_DB), { recursive: true, force: true });
			for (const root of getBlobPathsForDatabaseName(PROV_DB)) rmSync(root, { recursive: true, force: true });
		});

		it('records what produced a managed backup in its completion manifest', async function () {
			this.timeout(30000);
			const database = RocksDatabase.open(join(storageDir, PROV_DB));
			try {
				database.putSync('rec', { n: 1 });
			} finally {
				database.close();
			}
			const created = await createBackupOffline(PROV_DB);

			const manifest = await readBackupManifest(backupDirForDatabase(PROV_DB), created.backup_id);
			assert.strictEqual(manifest.blobs, true);
			assert.ok(manifest.producer, 'a managed backup should record its producer');
			assert.strictEqual(manifest.producer.database, PROV_DB);
			assert.ok(manifest.producer.harper_version);
			assertArchiveRestorable(manifest.producer);
		});

		// The capability list is only worth recording if something refuses on it, and the `latest` path
		// is the half that can silently skip the check by rebuilding the manifest instead of reading it.
		for (const [label, restoreArgs] of [
			['an explicitly requested backup', (id) => [PROV_DB, id]],
			['the latest backup', () => [PROV_DB, undefined]],
		]) {
			it(`refuses to restore ${label} whose producer requires a capability this build lacks`, async function () {
				this.timeout(30000);
				const database = RocksDatabase.open(join(storageDir, PROV_DB));
				try {
					database.putSync('rec', { n: 1 });
				} finally {
					database.close();
				}
				const created = await createBackupOffline(PROV_DB);
				const backupDir = backupDirForDatabase(PROV_DB);

				const manifestFile = join(backupDir, 'manifests', `${created.backup_id}.json`);
				const stored = JSON.parse(readFileSync(manifestFile, 'utf8'));
				stored.producer.requires = [...stored.producer.requires, 'blob-encryption-v2'];
				writeFileSync(manifestFile, JSON.stringify(stored));

				const sentinel = join(storageDir, PROV_DB, 'CURRENT');
				assert.ok(existsSync(sentinel), 'precondition: the destination database is on disk');

				await assert.rejects(
					validateRestoreBackup({ ...SU, database: PROV_DB, backup_id: restoreArgs(created.backup_id)[1] }),
					(error) => error.statusCode === 400 && /blob-encryption-v2/.test(error.message),
					'incompatible backups must be refused before submitting a restore job'
				);
				await assert.rejects(
					restoreBackupOffline(...restoreArgs(created.backup_id)),
					(error) => error.statusCode === 400 && /blob-encryption-v2/.test(error.message)
				);
				assert.ok(existsSync(sentinel), 'the destination must not be purged by a refused restore');
			});
		}

		// a hand-edited or truncated producer must surface the manifest error, not a TypeError from the
		// capability check reading `requires` off it
		it('reports a malformed producer as a manifest error rather than crashing the restore', async function () {
			this.timeout(30000);
			const database = RocksDatabase.open(join(storageDir, PROV_DB));
			try {
				database.putSync('rec', { n: 1 });
			} finally {
				database.close();
			}
			const created = await createBackupOffline(PROV_DB);

			const manifestFile = join(backupDirForDatabase(PROV_DB), 'manifests', `${created.backup_id}.json`);
			const stored = JSON.parse(readFileSync(manifestFile, 'utf8'));
			delete stored.producer.requires;
			writeFileSync(manifestFile, JSON.stringify(stored));

			await assert.rejects(
				restoreBackupOffline(PROV_DB, created.backup_id),
				(error) => error.statusCode === 400 && /requires/.test(error.message)
			);
		});

		// `producer: null` is present-but-unreadable, not absent. Harper only ever writes the key
		// alongside a value, so this is the malformed case and must not take the legacy path.
		it('refuses a producer key that is present but null rather than treating it as legacy', async function () {
			this.timeout(30000);
			const database = RocksDatabase.open(join(storageDir, PROV_DB));
			try {
				database.putSync('rec', { n: 1 });
			} finally {
				database.close();
			}
			const created = await createBackupOffline(PROV_DB);

			const manifestFile = join(backupDirForDatabase(PROV_DB), 'manifests', `${created.backup_id}.json`);
			const stored = JSON.parse(readFileSync(manifestFile, 'utf8'));
			stored.producer = null;
			writeFileSync(manifestFile, JSON.stringify(stored));

			await assert.rejects(
				restoreBackupOffline(PROV_DB, created.backup_id),
				(error) => error.statusCode === 400 && /archive_schema_version/.test(error.message)
			);
		});

		it('still restores a backup whose completion manifest predates the producer field', async function () {
			this.timeout(30000);
			const database = RocksDatabase.open(join(storageDir, PROV_DB));
			try {
				database.putSync('rec', { n: 1 });
			} finally {
				database.close();
			}
			const created = await createBackupOffline(PROV_DB);

			const manifestFile = join(backupDirForDatabase(PROV_DB), 'manifests', `${created.backup_id}.json`);
			const stored = JSON.parse(readFileSync(manifestFile, 'utf8'));
			delete stored.producer;
			writeFileSync(manifestFile, JSON.stringify(stored));

			await restoreBackupOffline(PROV_DB, created.backup_id);
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

		async function extractTarOrder(stream) {
			const chunks = [];
			for await (const chunk of stream) chunks.push(chunk);
			const archive = Buffer.concat(chunks);
			const order = [];
			for (let offset = 0; offset + 512 <= archive.length;) {
				const header = archive.subarray(offset, offset + 512);
				// Stop at the first end marker; tar-stream's extractor accepts intervening zero headers.
				if (header.every((byte) => byte === 0)) return order;
				order.push(header.toString('utf8', 0, 100).split('\0')[0]);
				const sizeField = header.toString('ascii', 124, 136).replace(/\0.*$/, '').trim();
				assert.match(sizeField, /^[0-7]+$/, 'tar entry size must be octal');
				const size = Number.parseInt(sizeField, 8);
				offset += 512 + Math.ceil(size / 512) * 512;
				assert.ok(offset <= archive.length, 'tar entry must not extend past the archive');
			}
			assert.fail('tar archive must have an end marker');
		}

		it('makes the manifest the first entry of an archive with blobs', async function () {
			this.timeout(30000);
			const MANIFEST_DB = `${DB_NAME}-archive-manifest`;
			const dir = join(storageDir, MANIFEST_DB);
			const seed = RocksDatabase.open(dir);
			try {
				seed.putSync('rec', { blob: 'x' });
			} finally {
				seed.close();
			}
			writeBlobFile(MANIFEST_DB, join('111', '222', '333'), 'whole-blob');

			const store = RocksDatabase.open(dir);
			try {
				const order = await extractTarOrder(createBackupStream(store, MANIFEST_DB, false, false));
				assert.strictEqual(order[0], ARCHIVE_MANIFEST_ENTRY, 'a reader must identify the archive after a few KB');
				assert.ok(order.includes('blobs/0/111/222/333'), 'blob entries must precede the first end marker');
				assert.strictEqual(order.at(-1), 'README.md', 'the final entry must precede the first end marker');

				const entries = await extractTarNames(createBackupStream(store, MANIFEST_DB, false, false));
				const manifest = parseArchiveManifest(entries.get(ARCHIVE_MANIFEST_ENTRY).toString('utf8'));
				assert.strictEqual(manifest.archive_schema_version, ARCHIVE_SCHEMA_VERSION);
				assert.strictEqual(manifest.database, MANIFEST_DB);
				assert.strictEqual(manifest.blobs, true);
				assert.strictEqual(manifest.blob_root_count, getBlobPathsForDatabaseName(MANIFEST_DB).length);
				assertArchiveRestorable(manifest);
				assert.ok(entries.has('README.md'));
			} finally {
				store.close();
				rmSync(dir, { recursive: true, force: true });
				for (const root of getBlobPathsForDatabaseName(MANIFEST_DB)) rmSync(root, { recursive: true, force: true });
			}
		});

		// In-process this proves nothing: destroying the response stream emits 'close' on it whether or
		// not the native producer was torn down, and the leaked producer is a native thread, so it is
		// invisible to `process.getActiveResourcesInfo()` too. The observable is that a process with
		// nothing left to do actually exits.
		it('stops the engine-only producer when the consumer aborts', async function () {
			this.timeout(60000);
			const child = spawn(process.execPath, [join(__dirname, 'backupStreamAbort-fixture.cjs')], {
				cwd: join(__dirname, '..', '..'),
				stdio: ['ignore', 'pipe', 'pipe'],
			});
			let stderr = '';
			child.stderr.on('data', (chunk) => (stderr += chunk));
			const exited = new Promise((resolve, reject) => {
				child.on('error', reject);
				child.on('exit', (code, signal) => resolve({ code, signal }));
			});
			const timer = setTimeout(() => child.kill('SIGKILL'), 30000);
			let result;
			try {
				result = await exited;
			} finally {
				clearTimeout(timer);
			}
			assert.strictEqual(
				result.signal,
				null,
				'the backup producer was left waiting on a stream nobody will ever read again'
			);
			assert.strictEqual(result.code, 0, `abort fixture failed: ${stderr}`);
		});

		it('makes the manifest the first entry of an engine-only archive too, and says so', async function () {
			this.timeout(30000);
			const MANIFEST_DB = `${DB_NAME}-archive-manifest-engine`;
			const dir = join(storageDir, MANIFEST_DB);
			const seed = RocksDatabase.open(dir);
			try {
				seed.putSync('rec', { n: 1 });
			} finally {
				seed.close();
			}

			const store = RocksDatabase.open(dir);
			try {
				const order = await extractTarOrder(createBackupStream(store, MANIFEST_DB, false, true));
				assert.strictEqual(order[0], ARCHIVE_MANIFEST_ENTRY);
				assert.strictEqual(order.at(-1), 'README.md', 'the final entry must precede the first end marker');

				const entries = await extractTarNames(createBackupStream(store, MANIFEST_DB, false, true));
				const manifest = parseArchiveManifest(entries.get(ARCHIVE_MANIFEST_ENTRY).toString('utf8'));
				assert.strictEqual(manifest.blobs, false);
				assert.strictEqual(manifest.blob_root_count, 0);
				assert.deepStrictEqual(manifest.requires, ['rocksdb-stream-backup']);
				assert.ok(
					![...entries.keys()].some((name) => name.startsWith('blobs/')),
					'exclude_blobs must still carry no blob entries'
				);
			} finally {
				store.close();
				rmSync(dir, { recursive: true, force: true });
			}
		});

		it('packs a PENDING marker for an incomplete blob, keeping the tar valid', async function () {
			this.timeout(30000);
			const MARKER_DB = `${DB_NAME}-blob-marker`;
			const markerDbDir = join(storageDir, MARKER_DB);
			const database = RocksDatabase.open(markerDbDir);
			try {
				database.putSync('rec', { blob: 'x' });
			} finally {
				database.close();
			}
			const wholeRel = join('111', '222', '333');
			const partialRel = join('111', '222', '334');
			writeBlobFile(MARKER_DB, wholeRel, 'whole-blob');
			// A write still in flight: the header claims more than the body holds.
			const partialHeader = Buffer.alloc(8);
			partialHeader.writeUInt16BE(0, 0);
			partialHeader.writeUIntBE(9999, 2, 6);
			const partialFull = join(getBlobPathsForDatabaseName(MARKER_DB)[0], partialRel);
			mkdirSync(dirname(partialFull), { recursive: true });
			writeFileSync(partialFull, Buffer.concat([partialHeader, Buffer.from('partial')]));

			const store = RocksDatabase.open(markerDbDir);
			try {
				const entries = await extractTarNames(createBackupStream(store, MARKER_DB, false, false));
				const toPosix = (rel) => rel.split(require('node:path').sep).join('/');
				const partialEntry = `blobs/0/${toPosix(partialRel)}`;
				assert.strictEqual(
					entries
						.get(`blobs/0/${toPosix(wholeRel)}`)
						.subarray(8)
						.toString('utf8'),
					'whole-blob'
				);
				assert.ok(entries.has(partialEntry), 'the incomplete blob id must still be present in the archive');
				const marker = entries.get(partialEntry);
				assert.strictEqual(marker.readUInt16BE(0), 0xfe, 'expected a PENDING marker');
				// a wrong pack.entry size corrupts the whole tar, so the declared size must match the body
				assert.strictEqual(marker.length, 8 + marker.readUIntBE(2, 6));
			} finally {
				store.close();
			}
		});

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
				assert.strictEqual(entries.get(blobEntry).subarray(8).toString('utf8'), 'streamed-blob');
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
			const backupDir = backupDirForDatabase(DB_NAME);

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
				assert.deepStrictEqual(readBackupPins(backupDir), [], 'a refused restore must release its source pin');
			} finally {
				child.kill('SIGKILL');
				await purgeBackupsOffline(DB_NAME, 0);
			}
		});
	});
});
