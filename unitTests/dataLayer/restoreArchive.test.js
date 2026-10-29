'use strict';

const testUtils = require('../testUtils.js');
const assert = require('node:assert');
const { createHash, randomUUID } = require('node:crypto');
const {
	appendFileSync,
	createWriteStream,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	statSync,
	symlinkSync,
	writeFileSync,
} = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { Readable } = require('node:stream');
const { pipeline } = require('node:stream/promises');
const { pack: tarPack } = require('tar-stream');
const { setTimeout: delay } = require('node:timers/promises');
const { waitFor } = require('../waitFor.js');
const { closeDatabase, getDatabases, resetDatabases, resolveDatabasePath, table } = require('#src/resources/databases');
const { JOB_STATUS_ENUM, SYSTEM_TABLE_NAMES } = require('#src/utility/hdbTerms');
const { createBlob, getBlobPathsForDatabaseName, getFilePathForBlob } = require('#src/resources/blob');
const { setMainIsWorker } = require('#src/server/threads/manageThreads');
const {
	backupDirForDatabase,
	createBackupStream,
	getBackupsRoot,
	createBackup,
	listBackups,
	listBackupsInDir,
	restoreBackup,
	restoreBackupOffline,
	validateRestoreBackup,
} = require('#src/dataLayer/rocksdbBackup');
const { readBackupManifest } = require('#src/dataLayer/backupManifest');
const { ARCHIVE_MANIFEST_ENTRY } = require('#src/dataLayer/backupArchiveManifest');
const { fileIdentity } = require('#src/utility/fileIdentity');
const { readRestoreReceipt, restoreReceiptPath } = require('#src/dataLayer/restoreReceipt');
const { restoreMarkerPresent } = require('#src/dataLayer/restoreMarker');
const { readBackupPins } = require('#src/dataLayer/backupRepository');
const { recoverRestoresAtStartup, resetStartupRecoveryForTesting } = require('#src/dataLayer/restoreIntent');
const { DeferredJobCompletion } = require('#src/server/jobs/deferredJobCompletion');
const restoreArchive = require('#src/dataLayer/restoreArchive');
const {
	IMPORT_STAGING_DIR,
	importStagingDir,
	resetImportStagingSweepForTesting,
	restoreBackupRequest,
	sweepImportStaging,
	sweepImportStagingAtStartup,
} = restoreArchive;

const describeUnlessLmdb = process.env.HARPER_STORAGE_ENGINE === 'lmdb' ? describe.skip : describe;
const SU = { hdb_user: { username: 'admin', role: { permission: { super_user: true } } } };
const SOURCE = 'importsource';
const IMPORTED = 'importrepo';
const FOREIGN = 'importforeign';
const RESTORED = 'importrestored';
const BLOB_BYTES = Buffer.alloc(20000, 'q'); // over the file-storage threshold, so it is a file in a blob root
const RECORDS = Array.from({ length: 40 }, (_, id) => ({ id, label: `item-${id % 5}`, pad: 'p'.repeat(64) }));

function sha256(path) {
	return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function stagingRoot(databaseName) {
	return join(backupDirForDatabase(databaseName), IMPORT_STAGING_DIR);
}

function stagingEntries(databaseName) {
	return existsSync(stagingRoot(databaseName)) ? readdirSync(stagingRoot(databaseName)) : [];
}

function serverFile(archivePath) {
	return { server_path: archivePath, server_path_identity: fileIdentity(statSync(archivePath)) };
}

// The code under test reads these through their module objects (or a class prototype) at call time, so
// assigning one reaches it. Returns the function that puts the original back.
function replaceProperty(owner, name, replacement) {
	const original = owner[name];
	owner[name] = replacement;
	return () => {
		owner[name] = original;
	};
}

function recordingCalls(implementation) {
	const calls = [];
	const recorder = (...args) => {
		calls.push(args);
		return implementation(...args);
	};
	recorder.calls = calls;
	return recorder;
}

// The repository as list_backups and the engine see it: an archive restore never touches the database's own.
async function repositoryState(databaseName) {
	const backupDir = backupDirForDatabase(databaseName);
	const engine = (await listBackupsInDir(backupDir)).map((backup) => backup.backupId);
	const manifests = existsSync(join(backupDir, 'manifests')) ? readdirSync(join(backupDir, 'manifests')) : [];
	const top = existsSync(backupDir) ? readdirSync(backupDir).filter((entry) => entry !== IMPORT_STAGING_DIR) : [];
	const listed = engine.length ? (await listBackups({ ...SU, database: databaseName })).map((b) => b.backup_id) : [];
	return { engine, manifests, top, listed };
}

// A plain tar's entries as [header offset, name, size] — enough to cut and splice entries.
function tarEntries(buffer) {
	const entries = [];
	for (let offset = 0; offset + 512 <= buffer.length;) {
		const header = buffer.subarray(offset, offset + 512);
		if (header.every((byte) => byte === 0)) break;
		const name = header.toString('utf8', 0, 100).split('\0')[0];
		const size = Number.parseInt(header.toString('ascii', 124, 136).replace(/\0.*$/, '').trim(), 8);
		entries.push({ offset, name, size });
		offset += 512 + Math.ceil(size / 512) * 512;
	}
	return entries;
}

function firstEntryManifest(tar) {
	const [first] = tarEntries(tar);
	assert.strictEqual(first.name, ARCHIVE_MANIFEST_ENTRY, 'precondition: get_backup puts its manifest first');
	return JSON.parse(tar.toString('utf8', first.offset + 512, first.offset + 512 + first.size));
}

async function packArchive(path, entries) {
	const pack = tarPack();
	const written = pipeline(pack, createWriteStream(path));
	for (const entry of entries) {
		await new Promise((resolve, reject) =>
			pack.entry(entry.header, entry.body, (error) => (error ? reject(error) : resolve()))
		);
	}
	pack.finalize();
	await written;
}

async function assertSameAsSource(Restored) {
	const Source = getDatabases()[SOURCE].Items;
	for (const record of RECORDS) {
		const restored = await Restored.get(record.id);
		const source = await Source.get(record.id);
		assert.deepStrictEqual(
			{ id: restored.id, label: restored.label, pad: restored.pad },
			{ id: source.id, label: source.label, pad: source.pad },
			`record ${record.id}`
		);
		assert.deepStrictEqual({ id: source.id, label: source.label, pad: source.pad }, record);
	}
	const restoredBlob = Buffer.from(await (await Restored.get('with-blob')).attachment.arrayBuffer());
	const sourceBlob = Buffer.from(await (await Source.get('with-blob')).attachment.arrayBuffer());
	assert.ok(restoredBlob.equals(sourceBlob) && restoredBlob.equals(BLOB_BYTES), "the blob bytes are the source's");
}

describeUnlessLmdb('restore_backup from an archive', function () {
	this.timeout(120000);
	const restoreChildRunner = require('#src/dataLayer/restoreChildRunner');
	const jobs = require('#src/server/jobs/jobs');
	let tempDir;
	let gzArchive;
	let tarArchive;
	let tarManifest;
	let blobRelativePath;
	let sequence = 0;
	const created = [];
	const seededJobs = [];

	function freshName() {
		const name = `restarc${process.pid}x${++sequence}`;
		created.push(name);
		return name;
	}

	// a live database that differs from the archive in every record and holds one the archive lacks
	async function seedTarget(name) {
		const Items = table({
			table: 'Items',
			database: name,
			attributes: [
				{ name: 'id', isPrimaryKey: true },
				{ name: 'label', indexed: true },
				{ name: 'pad' },
				{ name: 'attachment' },
			],
		});
		await Items.put({ id: 'junk', label: 'junk' });
		await Items.put({ id: 0, label: 'mutated', pad: 'mutated' });
		await Items.primaryStore.rootStore.flush();
		return Items;
	}

	async function assertRestored(name, { reload = false } = {}) {
		if (reload) resetDatabases();
		const Restored = await waitFor(() => getDatabases()[name]?.Items, {
			timeout: 10000,
			message: 'the restored database was never loaded',
		});
		assert.ok(!(await Restored.get('junk')), 'a record the archive lacks is gone');
		await assertSameAsSource(Restored);
	}

	async function assertTargetUntouched(name, repositoryBefore) {
		const dir = resolveDatabasePath(name);
		const Items = getDatabases()[name].Items;
		assert.strictEqual((await Items.get('junk')).label, 'junk', 'the target keeps its data');
		assert.strictEqual((await Items.get(0)).label, 'mutated');
		assert.strictEqual(readRestoreReceipt(dir).kind, 'absent', 'no receipt');
		assert.strictEqual(restoreMarkerPresent(dir), false, 'no marker');
		assert.deepStrictEqual(stagingEntries(name), [], 'staging is removed');
		assert.deepStrictEqual(await repositoryState(name), repositoryBefore, "the database's own repository is unchanged");
	}

	function jobTable() {
		return getDatabases().system[SYSTEM_TABLE_NAMES.JOB_TABLE_NAME];
	}

	async function seedJob() {
		const id = randomUUID();
		seededJobs.push(id);
		await jobTable().put({
			id,
			type: 'restore_backup',
			status: JOB_STATUS_ENUM.IN_PROGRESS,
			deferred_to: 'restore-intent',
			start_datetime: Date.now(),
			created_datetime: Date.now(),
		});
		return id;
	}

	/** restore_backup as its job worker runs it: currentJobId() reads the worker's process name. */
	async function requestRestore(name, options) {
		const jobId = await seedJob();
		const saved = process.env.PROCESS_NAME;
		process.env.PROCESS_NAME = `JOB-${jobId}`;
		try {
			return { jobId, result: await restoreBackup({ ...SU, database: name, ...options }) };
		} finally {
			if (saved === undefined) delete process.env.PROCESS_NAME;
			else process.env.PROCESS_NAME = saved;
		}
	}

	async function boot(name) {
		await closeDatabase(name);
		resetStartupRecoveryForTesting();
		return recoverRestoresAtStartup();
	}

	function receiptOf(dir) {
		const read = readRestoreReceipt(dir);
		assert.strictEqual(read.kind, 'valid', `expected a readable receipt, found ${JSON.stringify(read)}`);
		return read.receipt;
	}

	before(async function () {
		this.timeout(120000);
		await testUtils.ensureSystemTables();
		setMainIsWorker(true);
		tempDir = mkdtempSync(join(tmpdir(), 'harper.unit-test.restore-archive-'));
		const Items = table({
			table: 'Items',
			database: SOURCE,
			attributes: [
				{ name: 'id', isPrimaryKey: true },
				{ name: 'label', indexed: true },
				{ name: 'pad' },
				{ name: 'attachment' },
			],
		});
		for (const record of RECORDS) await Items.put(record);
		const blob = await createBlob(BLOB_BYTES);
		await Items.put({ id: 'with-blob', label: 'blob', attachment: blob });
		const blobPath = getFilePathForBlob(blob);
		await waitFor(() => existsSync(blobPath) && readFileSync(blobPath).length > BLOB_BYTES.length, {
			timeout: 10000,
			message: 'the blob was never written to its file',
		});
		blobRelativePath = blobPath.slice(getBlobPathsForDatabaseName(SOURCE)[0].length + 1);
		const rootStore = Items.primaryStore.rootStore;
		await rootStore.flush();
		gzArchive = join(tempDir, `${SOURCE}.tar.gz`);
		tarArchive = join(tempDir, `${SOURCE}.tar`);
		await pipeline(createBackupStream(rootStore, SOURCE, true), createWriteStream(gzArchive));
		await pipeline(createBackupStream(rootStore, SOURCE, false), createWriteStream(tarArchive));
		tarManifest = firstEntryManifest(readFileSync(tarArchive));
	});

	after(async function () {
		this.timeout(60000);
		for (const id of seededJobs)
			await jobTable()
				.delete(id)
				.catch(() => {});
		for (const name of [SOURCE, IMPORTED, FOREIGN, RESTORED, ...created]) {
			await closeDatabase(name).catch(() => {});
			rmSync(restoreReceiptPath(resolveDatabasePath(name)), { force: true });
			for (const root of getBlobPathsForDatabaseName(name)) rmSync(root, { recursive: true, force: true });
			rmSync(backupDirForDatabase(name), { recursive: true, force: true });
		}
		if (tempDir) rmSync(tempDir, { recursive: true, force: true });
	});

	describe('server_path', function () {
		it('restores the archive over a live database in place, adding nothing to its own repository', async function () {
			const name = freshName();
			await seedTarget(name);
			const archiveBefore = readFileSync(gzArchive);
			const repositoryBefore = await repositoryState(name);

			const result = await restoreBackup({ ...SU, database: name, ...serverFile(gzArchive) });

			assert.strictEqual(result.restored_from, gzArchive);
			assert.strictEqual(result.backup_id, undefined, 'a private staged repository has no id worth reporting');
			await assertRestored(name);
			assert.deepStrictEqual(await repositoryState(name), repositoryBefore);
			assert.deepStrictEqual(stagingEntries(name), []);
			assert.ok(readFileSync(gzArchive).equals(archiveBefore), 'the archive is left in place, unchanged');
		});

		it('restores a plain .tar into a database that does not exist locally', async function () {
			const name = freshName();
			assert.strictEqual(getDatabases()[name], undefined, 'precondition: no such local database');
			const result = await restoreBackup({ ...SU, database: name, ...serverFile(tarArchive) });
			assert.strictEqual(result.restored_from, tarArchive);
			await assertRestored(name);
			assert.deepStrictEqual(stagingEntries(name), []);
			assert.ok(
				existsSync(join(getBlobPathsForDatabaseName(name)[0], blobRelativePath)),
				'the archive blob is restored into the database blob root'
			);
		});

		it('restores into target_database and leaves the source database and its repository alone', async function () {
			const target = freshName();
			const repositoryBefore = await repositoryState(SOURCE);
			const result = await restoreBackup({
				...SU,
				database: SOURCE,
				target_database: target,
				...serverFile(gzArchive),
			});
			assert.strictEqual(result.restored_from, gzArchive);
			await assertRestored(target);
			assert.deepStrictEqual(await repositoryState(SOURCE), repositoryBefore);
			assert.deepStrictEqual(stagingEntries(SOURCE), []);
			assert.strictEqual(tarManifest.database, SOURCE);
			const Source = getDatabases()[SOURCE].Items;
			assert.strictEqual((await Source.get(0)).label, RECORDS[0].label, 'the source database is untouched');
		});

		it('refuses an archive whose sha256 does not match the pinned one, leaving the target untouched', async function () {
			const name = freshName();
			await seedTarget(name);
			const repositoryBefore = await repositoryState(name);
			await assert.rejects(
				restoreBackup({ ...SU, database: name, ...serverFile(gzArchive), sha256: 'ab'.repeat(32) }),
				(error) => error.statusCode === 400 && /sha256/.test(error.message)
			);
			await assertTargetUntouched(name, repositoryBefore);
			// the same pin, written in upper case, is the same digest
			const result = await restoreBackup({
				...SU,
				database: name,
				...serverFile(gzArchive),
				sha256: sha256(gzArchive).toUpperCase(),
			});
			assert.strictEqual(result.restored_from, gzArchive);
			await assertRestored(name);
		});

		it('refuses a pre-manifest archive unless accept_incompatible_backup', async function () {
			const tar = readFileSync(tarArchive);
			const [first, second] = tarEntries(tar);
			assert.strictEqual(first.name, ARCHIVE_MANIFEST_ENTRY);
			const stripped = join(tempDir, 'pre-manifest.tar');
			writeFileSync(stripped, tar.subarray(second.offset));
			const name = freshName();
			await seedTarget(name);
			const repositoryBefore = await repositoryState(name);

			await assert.rejects(
				restoreBackup({ ...SU, database: name, ...serverFile(stripped) }),
				(error) => error.statusCode === 400 && /first entry must be harper-backup\.json/.test(error.message)
			);
			await assertTargetUntouched(name, repositoryBefore);

			const result = await restoreBackup({
				...SU,
				database: name,
				...serverFile(stripped),
				accept_incompatible_backup: true,
			});
			assert.strictEqual(result.restored_from, stripped);
			await assertRestored(name);
			assert.deepStrictEqual(stagingEntries(name), []);
		});

		it('refuses an archive with a symlink entry, leaving the target untouched', async function () {
			const linked = join(tempDir, 'symlink.tar');
			await packArchive(linked, [
				{ header: { name: ARCHIVE_MANIFEST_ENTRY }, body: JSON.stringify(tarManifest) },
				{ header: { name: 'CURRENT' }, body: 'MANIFEST-000001\n' },
				{ header: { name: 'escape', type: 'symlink', linkname: '/etc/passwd' } },
			]);
			const name = freshName();
			await seedTarget(name);
			const repositoryBefore = await repositoryState(name);
			await assert.rejects(
				restoreBackup({ ...SU, database: name, ...serverFile(linked) }),
				(error) => error.statusCode === 400 && /symlink entry/.test(error.message)
			);
			await assertTargetUntouched(name, repositoryBefore);
		});

		it('refuses a truncated .tar.gz, leaving the target untouched', async function () {
			const gz = readFileSync(gzArchive);
			const truncated = join(tempDir, 'truncated.tar.gz');
			writeFileSync(truncated, gz.subarray(0, Math.floor(gz.length / 2)));
			const name = freshName();
			await seedTarget(name);
			const repositoryBefore = await repositoryState(name);
			await assert.rejects(restoreBackup({ ...SU, database: name, ...serverFile(truncated) }));
			await assertTargetUntouched(name, repositoryBefore);
		});

		describe('a path the request does not describe', function () {
			let restoreAddJob;
			let addedJobs;

			beforeEach(function () {
				addedJobs = [];
				restoreAddJob = replaceProperty(jobs, 'addJob', async (json) => {
					addedJobs.push(json);
					throw new Error('no job should be created');
				});
			});

			afterEach(function () {
				restoreAddJob?.();
			});

			async function assertRefusedBeforeAJob(fields) {
				await assert.rejects(
					restoreBackupRequest({ ...SU, operation: 'restore_backup', database: IMPORTED, ...fields }),
					(error) =>
						error.statusCode === 412 &&
						error.message.includes(`file=<path>`) &&
						error.message.includes(fields.server_path)
				);
				assert.deepStrictEqual(addedJobs, [], 'no job was created');
			}

			it('answers 412 for a path that does not exist', async function () {
				const gone = join(tempDir, 'gone.tar');
				writeFileSync(gone, 'x');
				const fields = serverFile(gone);
				rmSync(gone);
				await assertRefusedBeforeAJob(fields);
				await assertRefusedBeforeAJob({
					server_path: join(tempDir, 'never-existed.tar'),
					server_path_identity: { dev: 1, ino: 2, size: 3, mtime_ms: 4 },
				});
			});

			it('answers 412 for an identity that does not match the file', async function () {
				const { server_path, server_path_identity } = serverFile(gzArchive);
				await assertRefusedBeforeAJob({
					server_path,
					server_path_identity: { ...server_path_identity, size: server_path_identity.size + 1 },
				});
				await assertRefusedBeforeAJob({
					server_path,
					server_path_identity: { ...server_path_identity, ino: server_path_identity.ino + 1 },
				});
			});

			it('answers 412 for a directory', async function () {
				await assertRefusedBeforeAJob({
					server_path: tempDir,
					server_path_identity: fileIdentity(statSync(tempDir)),
				});
			});

			it('answers 412 from the job when the file changed after the request was accepted', async function () {
				const changing = join(tempDir, 'changing.tar.gz');
				writeFileSync(changing, readFileSync(gzArchive));
				const fields = serverFile(changing);
				appendFileSync(changing, 'x');
				const name = freshName();
				await seedTarget(name);
				const repositoryBefore = await repositoryState(name);
				await assert.rejects(
					restoreBackup({ ...SU, database: name, ...fields }),
					(error) => error.statusCode === 412 && error.message.includes('file=<path>')
				);
				await assertTargetUntouched(name, repositoryBefore);
			});
		});

		it('restores through a symlink when the identity is of its target', async function () {
			const link = join(tempDir, 'link.tar.gz');
			rmSync(link, { force: true });
			try {
				symlinkSync(gzArchive, link);
			} catch (error) {
				// Windows needs Developer Mode or an elevated token to create a symlink
				if (process.platform === 'win32' && error.code === 'EPERM') this.skip();
				throw error;
			}
			const name = freshName();
			const fields = { server_path: link, server_path_identity: fileIdentity(statSync(gzArchive)) };
			const result = await restoreBackup({ ...SU, database: name, ...fields });
			assert.strictEqual(result.restored_from, link);
			await assertRestored(name);
		});

		describe('a failure after the target was destroyed', function () {
			it('keeps the staged archive for the rerun, and releases it once the rerun publishes', async function () {
				const name = freshName();
				await seedTarget(name);
				const dir = resolveDatabasePath(name);
				const realRun = restoreChildRunner.runRestoreChild;
				const restoreRunner = replaceProperty(restoreChildRunner, 'runRestoreChild', (command, args, options) => {
					if (command !== 'apply-and-prove') return realRun(command, args, options);
					options.beforeDestruction();
					return Promise.reject(new Error('apply failed after the purge'));
				});
				try {
					await assert.rejects(
						restoreBackup({ ...SU, database: name, ...serverFile(gzArchive) }),
						/apply failed after the purge/
					);
				} finally {
					restoreRunner();
				}

				assert.strictEqual(restoreMarkerPresent(dir), true, 'the target stays blocked');
				const failed = receiptOf(dir);
				assert.strictEqual(failed.restored_from, gzArchive);
				const [firstId] = stagingEntries(name);
				assert.strictEqual(stagingEntries(name).length, 1, 'the only source of the restore survives');
				const firstStaging = join(stagingRoot(name), firstId);
				assert.strictEqual(failed.backup_dir, firstStaging);
				assert.strictEqual(failed.source_kind, 'staged_tree');
				assert.ok(existsSync(join(firstStaging, 'tree', 'CURRENT')), 'its staged tree is intact');
				assert.strictEqual(readBackupPins(firstStaging).length > 0, true, 'a pin keeps it');

				resetImportStagingSweepForTesting();
				sweepImportStagingAtStartup();
				assert.deepStrictEqual(stagingEntries(name), [firstId], 'a startup sweep keeps a pinned staging area');

				const result = await restoreBackup({ ...SU, database: name, ...serverFile(gzArchive) });
				assert.strictEqual(result.restored_from, gzArchive);
				await assertRestored(name);
				assert.deepStrictEqual(stagingEntries(name), [], "the earlier attempt's staging is released too");
				assert.strictEqual(readRestoreReceipt(dir).kind, 'absent');
				assert.strictEqual(restoreMarkerPresent(dir), false);
			});
		});

		describe('on_restart', function () {
			it('keeps the staged archive through the job and a startup sweep, then restores it on boot with a rollback in the real repository', async function () {
				const name = freshName();
				await seedTarget(name);
				const dir = resolveDatabasePath(name);
				const realRepository = backupDirForDatabase(name);
				const repositoryBefore = await repositoryState(name);

				const { jobId, result } = await requestRestore(name, { on_restart: true, ...serverFile(gzArchive) });

				assert.ok(result instanceof DeferredJobCompletion);
				const receipt = receiptOf(dir);
				assert.strictEqual(receipt.state, 'pending');
				assert.strictEqual(receipt.route, 'on_restart');
				assert.strictEqual(receipt.restored_from, gzArchive);
				assert.strictEqual(receipt.rollback_dir, realRepository);
				const [stagingId] = stagingEntries(name);
				assert.strictEqual(stagingEntries(name).length, 1);
				assert.strictEqual(receipt.backup_dir, join(stagingRoot(name), stagingId));
				assert.strictEqual(receipt.source_kind, 'staged_tree');
				assert.ok(existsSync(join(receipt.backup_dir, 'tree', 'CURRENT')));
				assert.deepStrictEqual(
					await repositoryState(name),
					repositoryBefore,
					'nothing is added to it before the restart'
				);

				await closeDatabase(name);
				resetImportStagingSweepForTesting();
				sweepImportStagingAtStartup();
				assert.deepStrictEqual(
					stagingEntries(name),
					[stagingId],
					'a pending receipt keeps its staging through the sweep'
				);
				resetDatabases();

				await boot(name);

				assert.strictEqual(readRestoreReceipt(dir).kind, 'absent');
				await assertRestored(name, { reload: true });
				assert.deepStrictEqual(stagingEntries(name), [], 'staging is released once the restore published');
				const settled = await jobTable().get(jobId);
				assert.strictEqual(settled.status, JOB_STATUS_ENUM.COMPLETE);
				assert.strictEqual(settled.result.restored_from, gzArchive);
				assert.strictEqual(settled.result.backup_id, undefined);

				const rollbackId = settled.result.pre_restore_backup_id;
				assert.ok(Number.isInteger(rollbackId), 'a rollback copy was taken');
				assert.strictEqual(
					(await readBackupManifest(realRepository, rollbackId)).pre_restore_for,
					receipt.operation_id
				);
				const listed = await listBackups({ ...SU, database: name });
				assert.deepStrictEqual(
					listed.map((backup) => backup.backup_id),
					[rollbackId]
				);

				await restoreBackup({ ...SU, database: name, backup_id: rollbackId });
				const Items = await waitFor(() => getDatabases()[name]?.Items, { message: 'the database never reloaded' });
				assert.strictEqual((await Items.get('junk')).label, 'junk', 'the pre-restore data is back');
				assert.strictEqual((await Items.get(0)).label, 'mutated');
				assert.ok(!(await Items.get('with-blob')));
			});

			it('fails the attempt without marking the target when the staged tree changed after the request', async function () {
				const name = freshName();
				await seedTarget(name);
				const dir = resolveDatabasePath(name);
				await requestRestore(name, { on_restart: true, ...serverFile(gzArchive) });
				const treeDir = join(receiptOf(dir).backup_dir, 'tree');
				const [sst] = readdirSync(treeDir)
					.filter((file) => file.endsWith('.sst'))
					.sort((a, b) => statSync(join(treeDir, b)).size - statSync(join(treeDir, a)).size);
				const bytes = readFileSync(join(treeDir, sst));
				bytes[Math.floor(bytes.length / 2)] ^= 0xff;
				writeFileSync(join(treeDir, sst), bytes);

				await boot(name);

				const receipt = receiptOf(dir);
				assert.ok(receipt.attempts >= 1);
				assert.ok(receipt.last_error.includes(sst), receipt.last_error);
				assert.strictEqual(restoreMarkerPresent(dir), false, 'the target was never marked');
				assert.ok(await restoreBackup({ ...SU, database: name, cancel: true }));
				resetDatabases();
				const Items = await waitFor(() => getDatabases()[name]?.Items, {
					timeout: 10000,
					message: 'the target never reloaded',
				});
				assert.strictEqual((await Items.get('junk')).label, 'junk', 'the live data is unchanged');
				assert.strictEqual((await Items.get(0)).label, 'mutated');
			});

			it('removes the staging of a cancelled restore', async function () {
				const name = freshName();
				await seedTarget(name);
				const dir = resolveDatabasePath(name);
				await requestRestore(name, { on_restart: true, ...serverFile(gzArchive) });
				assert.strictEqual(stagingEntries(name).length, 1);

				const cancelled = await restoreBackup({ ...SU, database: name, cancel: true });

				assert.ok(cancelled);
				assert.strictEqual(readRestoreReceipt(dir).kind, 'absent');
				assert.deepStrictEqual(stagingEntries(name), []);
				const Items = getDatabases()[name].Items;
				assert.strictEqual((await Items.get('junk')).label, 'junk', 'the live database is untouched');
			});
		});

		describe('offline', function () {
			it('restores a closed database from the file, leaving no staging', async function () {
				const name = freshName();
				await seedTarget(name);
				await closeDatabase(name);
				const archiveBefore = readFileSync(gzArchive);

				const result = await restoreBackupOffline(
					name,
					undefined,
					undefined,
					undefined,
					undefined,
					undefined,
					undefined,
					gzArchive
				);

				assert.strictEqual(result.restored_from, gzArchive);
				await assertRestored(name, { reload: true });
				assert.deepStrictEqual(stagingEntries(name), []);
				assert.ok(readFileSync(gzArchive).equals(archiveBefore));
			});
		});
	});

	describe('a multipart upload', function () {
		const jobRunner = require('#src/server/jobs/jobRunner');
		let restoreParseMessage;
		let queued;
		let name;

		beforeEach(async function () {
			queued = [];
			name = freshName();
			await seedTarget(name);
			// the job thread, run in this thread: what the job sees when it starts, then the job itself
			restoreParseMessage = replaceProperty(jobRunner, 'parseMessage', async (message) => {
				const stagingDir = message.json.staging_id && importStagingDir(name, message.json.staging_id);
				const read = (file) => stagingDir && existsSync(join(stagingDir, file)) && readFileSync(join(stagingDir, file));
				const seen = {
					json: message.json,
					owner: read('owner.json') && JSON.parse(read('owner.json')),
					archive: read('archive'),
				};
				queued.push(seen);
				seen.result = await restoreBackup(message.json).catch((error) => error);
			});
		});

		afterEach(function () {
			restoreParseMessage?.();
		});

		const upload = (fields, payload = Readable.from([readFileSync(gzArchive)])) =>
			restoreBackupRequest({ ...SU, operation: 'restore_backup', database: name, ...fields, payload });

		it('spools the raw bytes to staging, hands staging to the restore before queuing it, and restores from it', async function () {
			const repositoryBefore = await repositoryState(name);
			const queuedJob = await upload({});
			assert.strictEqual(queued.length, 1);
			const [{ json, owner, archive, result }] = queued;
			assert.ok(!(result instanceof Error), result?.stack);
			assert.deepStrictEqual(owner, { owner: 'import', import_id: json.staging_id }, 'owned by the job before it ran');
			assert.ok(archive.equals(readFileSync(gzArchive)), 'the raw upload, not inflated');
			assert.strictEqual(json.upload_digest, sha256(gzArchive));
			assert.strictEqual(json.payload, undefined, 'the stream is never part of the job request');

			const row = await getDatabases().system.hdb_job.get(queuedJob.job_id);
			assert.strictEqual(row.request.staging_id, json.staging_id);
			assert.strictEqual(row.request.payload, undefined);

			assert.strictEqual(result.restored_from, 'upload');
			assert.strictEqual(result.backup_id, undefined);
			await assertRestored(name);
			assert.deepStrictEqual(stagingEntries(name), [], 'the spool is removed after the job');
			assert.deepStrictEqual(await repositoryState(name), repositoryBefore);
		});

		it('refuses an invalid request before spooling anything', async function () {
			for (const fields of [
				{ sha256: 'not-a-digest' },
				{ accept_incompatible_backup: 'yes' },
				{ url: 'https://example.com/a.tar.gz' },
				{ backup_id: 1 },
				{ immutable_source: true },
				{ declared_size: -1 },
			]) {
				await assert.rejects(upload(fields), (error) => error.statusCode === 400, JSON.stringify(fields));
				assert.deepStrictEqual(stagingEntries(name), [], `nothing staged for ${JSON.stringify(fields)}`);
			}
			assert.strictEqual(queued.length, 0);
		});

		it('refuses a declared size larger than the staging device has free, before writing', async function () {
			await assert.rejects(upload({ declared_size: Number.MAX_SAFE_INTEGER }), (error) => error.statusCode === 507);
			assert.deepStrictEqual(stagingEntries(name), []);
		});

		it('removes a spool whose upload fails part way', async function () {
			const broken = new Readable({
				read() {
					this.push(readFileSync(gzArchive).subarray(0, 4096));
					this.destroy(new Error('connection reset'));
				},
			});
			await assert.rejects(upload({}, broken), /connection reset/);
			assert.deepStrictEqual(stagingEntries(name), []);
			assert.strictEqual(queued.length, 0);
		});

		it('removes the spool when the job cannot be queued', async function () {
			const restoreAddJob = replaceProperty(jobs, 'addJob', async () => {
				throw new Error('job table unavailable');
			});
			try {
				await assert.rejects(upload({}), /job table unavailable/);
			} finally {
				restoreAddJob();
			}
			assert.deepStrictEqual(stagingEntries(name), []);
		});

		it('removes the spool of an upload that fails before destruction', async function () {
			const truncated = readFileSync(gzArchive).subarray(0, 4096);
			const repositoryBefore = await repositoryState(name);
			await upload({}, Readable.from([truncated]));
			assert.ok(queued[0].result instanceof Error, 'the job failed');
			await assertTargetUntouched(name, repositoryBefore);
		});

		// staging_id names the directory the job removes when it finishes; from a client it would name any directory
		it('refuses a client-supplied staging_id or upload_digest instead of treating it as a staged upload', async function () {
			const victim = join(getBackupsRoot(), 'importvictim');
			mkdirSync(victim, { recursive: true });
			writeFileSync(join(victim, 'keep'), 'keep');
			try {
				const outcomes = [];
				for (const fields of [
					{ staging_id: '../../importvictim' },
					{ staging_id: randomUUID() },
					{ upload_digest: 'ab'.repeat(32) },
				]) {
					outcomes.push(
						await restoreBackupRequest({ ...SU, operation: 'restore_backup', database: name, ...fields }).then(
							() => 'queued',
							(error) => error
						)
					);
				}
				assert.ok(existsSync(join(victim, 'keep')), 'nothing outside staging is removed');
				for (const outcome of outcomes) {
					assert.ok(outcome.statusCode === 400 && /staging_id/.test(outcome.message), String(outcome));
				}
				assert.strictEqual(queued.length, 0, 'no job is queued');
			} finally {
				rmSync(victim, { recursive: true, force: true });
			}
		});
	});

	describe('a pull from a URL', function () {
		const { SAFE_FETCH_TEST_TRANSPORT } = require('#src/utility/safeFetch');
		const serveArchive = (req, res) => res.end(readFileSync(gzArchive));
		let server;
		let port;
		let requests;
		let caCert;
		let handler;

		before(async function () {
			const mkcert = require('mkcert');
			const ca = await mkcert.createCA({
				organization: 'import test CA',
				countryCode: 'US',
				state: 'X',
				locality: 'X',
				validity: 1,
			});
			const cert = await mkcert.createCert({
				ca: { key: ca.key, cert: ca.cert },
				domains: ['127.0.0.1', 'localhost'],
				validity: 1,
			});
			caCert = ca.cert;
			requests = 0;
			server = require('node:https').createServer({ key: cert.key, cert: cert.cert }, (req, res) => {
				requests++;
				handler(req, res);
			});
			await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
			port = server.address().port;
		});

		after(() => {
			server?.closeAllConnections();
			return new Promise((resolve) => (server ? server.close(resolve) : resolve()));
		});

		beforeEach(function () {
			handler = serveArchive;
		});

		afterEach(function () {
			rmSync(backupDirForDatabase(IMPORTED), { recursive: true, force: true });
		});

		// What the child runs, in-process: the pull is capped at the staging device's room before a byte
		// lands, and what it fetched is charged to the ledger the tally and extraction reserve against.
		describe('bounded by the disk ledger', function () {
			const safeFetch = require('#src/utility/safeFetch');
			const { DiskLedger } = require('#src/dataLayer/diskLedger');
			const { stageArchive } = require('#src/dataLayer/archiveStaging');
			const SHA = 'a'.repeat(64);
			let restores;
			let root;

			beforeEach(function () {
				restores = [];
				root = mkdtempSync(join(tmpdir(), 'harper.unit-test.import-pull-'));
			});

			afterEach(function () {
				for (const restore of (restores ?? []).reverse()) restore();
				if (root) rmSync(root, { recursive: true, force: true });
			});

			// no network and no full disk in a unit test: the fetch, the S3 read and the device's room stand in
			const replace = (owner, name, replacement) => {
				restores.push(replaceProperty(owner, name, replacement));
				return replacement;
			};

			const pull = () =>
				stageArchive({
					databaseName: IMPORTED,
					acceptIncompatible: false,
					restoredFrom: 'test',
					stagingDir: join(root, 'staging'),
					url: 'https://backups.example.com/db.tar.gz',
					sha256: SHA,
				});

			for (const [room, maxBytes] of [
				[123_456_789, 123_456_789],
				[-4096, 0],
			]) {
				it(`passes maxBytes ${maxBytes} when the staging device has ${room} bytes of room`, async function () {
					replace(DiskLedger.prototype, 'remaining', async () => ({ bytes: room, inodes: 1000, basis: 'quota' }));
					const fetch = replace(
						safeFetch,
						'safeFetchToFile',
						recordingCalls(async () => {
							throw new Error('no network in a unit test');
						})
					);
					await assert.rejects(pull(), /no network/);
					assert.strictEqual(fetch.calls.length, 1);
					const [url, destination, options] = fetch.calls[0];
					assert.strictEqual(url, 'https://backups.example.com/db.tar.gz');
					assert.strictEqual(destination, join(root, 'staging', 'archive'));
					assert.strictEqual(options.maxBytes, maxBytes);
					assert.strictEqual(options.sha256, SHA, 'the pinned digest is checked as the bytes arrive');
				});
			}

			it('meters an S3 pull into the ledger as it lands', async function () {
				const aws = require('#src/utility/AWS/AWSConnector');
				replace(aws, 'getFileStreamFromS3', async () =>
					Readable.from([Buffer.from('not '), Buffer.from('an archive')])
				);
				const debit = replace(
					DiskLedger.prototype,
					'debit',
					recordingCalls(async () => {})
				);
				await assert.rejects(
					stageArchive({
						databaseName: IMPORTED,
						acceptIncompatible: false,
						restoredFrom: 'test',
						stagingDir: join(root, 'staging'),
						s3: {
							bucket: 'b',
							key: 'k',
							region: 'r',
							credentials: { accessKeyId: 'AKIAEXAMPLE', secretAccessKey: 'secret' },
						},
						sha256: SHA,
					})
				);
				assert.strictEqual(readFileSync(join(root, 'staging', 'archive'), 'utf8'), 'not an archive');
				assert.deepStrictEqual(debit.calls[0]?.slice(0, 2), [join(root, 'staging', 'archive'), 14]);
			});

			it('charges the fetched bytes to the staging device before reading them', async function () {
				replace(DiskLedger.prototype, 'remaining', async () => ({ bytes: 1e9, inodes: 1000, basis: 'quota' }));
				const debit = replace(
					DiskLedger.prototype,
					'debit',
					recordingCalls(async () => {})
				);
				replace(safeFetch, 'safeFetchToFile', async (_url, destination, options) => {
					writeFileSync(destination, 'not an archive');
					options.onBytes(14);
					return { bytes: 14 };
				});
				await assert.rejects(pull());
				assert.deepStrictEqual(debit.calls, [[join(root, 'staging'), 14]]);
			});

			// A real https transfer from the local server; only the ledger's refusal stands in for a full device.
			it('charges a pull as it lands, and stops it once the staging device refuses a charge', async function () {
				const BATCH = 8 * 1024 * 1024;
				const ROOM = 12 * 1024 * 1024;
				const TOTAL = 64 * 1024 * 1024;
				let served = 0;
				let servedAll = false;
				handler = (req, res) => {
					res.writeHead(200, { 'content-length': TOTAL });
					const chunk = Buffer.alloc(1024 * 1024, 'p');
					const pump = () => {
						while (served < TOTAL) {
							served += chunk.length;
							if (!res.write(chunk)) return res.once('drain', pump);
						}
						servedAll = true;
						res.end();
					};
					pump();
				};
				const realFetch = safeFetch.safeFetchToFile;
				replace(safeFetch, 'safeFetchToFile', (url, destination, options) =>
					realFetch(url, destination, {
						...options,
						[SAFE_FETCH_TEST_TRANSPORT]: { trustedAddresses: ['127.0.0.1'], ca: caCert },
					})
				);
				let charged = 0;
				const debit = replace(
					DiskLedger.prototype,
					'debit',
					recordingCalls(async (_path, bytes) => {
						if (charged + bytes > ROOM) {
							throw Object.assign(new Error('Insufficient storage on the staging volume'), { statusCode: 507 });
						}
						charged += bytes;
					})
				);

				await assert.rejects(
					stageArchive({
						databaseName: IMPORTED,
						acceptIncompatible: false,
						restoredFrom: 'test',
						stagingDir: join(root, 'staging'),
						url: `https://127.0.0.1:${port}/db.tar.gz`,
					}),
					(error) => error.statusCode === 507 && /Insufficient storage/.test(error.message)
				);
				// a batch closes on the chunk that reaches it
				const inBatches = debit.calls.every(
					([path, bytes]) => path === join(root, 'staging') && bytes >= BATCH && bytes < BATCH + 1024 * 1024
				);
				assert.ok(
					inBatches && debit.calls.length === 2,
					`charged in batches as the bytes land, the second refused: ${JSON.stringify(debit.calls)}`
				);
				assert.strictEqual(servedAll, false, `the transfer was cut short, not finished (${served} of ${TOTAL} served)`);
			});

			// S3's header wait is bounded by the 5 minute idle timeout: a manual clock in a worker stands in for it.
			it('fails an S3 pull with 504 when S3 never answers', async function () {
				const { Worker } = require('node:worker_threads');
				const IDLE_MS = 5 * 60 * 1000;
				const worker = new Worker(
					`
					const { workerData, parentPort } = require('node:worker_threads');
					require(workerData.aws).getFileStreamFromS3 = () => new Promise(() => {});
					const { stageArchive } = require(workerData.archiveStaging);
					const pending = new Map();
					let now = 0;
					globalThis.setTimeout = (callback, ms = 0, ...args) => {
						const handle = { ref: () => handle, unref: () => handle, hasRef: () => true };
						pending.set(handle, { at: now + ms, callback, args });
						parentPort.postMessage({ type: 'timer', ms });
						return handle;
					};
					globalThis.clearTimeout = (handle) => pending.delete(handle);
					parentPort.on('message', (message) => {
						if (message?.type !== 'advance') return;
						now += message.ms;
						for (const [handle, timer] of [...pending].sort((a, b) => a[1].at - b[1].at)) {
							if (timer.at > now || !pending.delete(handle)) continue;
							timer.callback(...timer.args);
						}
					});
					stageArchive(workerData.args).then(
						() => parentPort.postMessage({ type: 'outcome' }),
						(error) => parentPort.postMessage({ type: 'outcome', message: error.message, statusCode: error.statusCode })
					);
					`,
					{
						eval: true,
						workerData: {
							aws: require.resolve('#src/utility/AWS/AWSConnector'),
							archiveStaging: require.resolve('#src/dataLayer/archiveStaging'),
							args: {
								databaseName: IMPORTED,
								acceptIncompatible: false,
								restoredFrom: 'test',
								stagingDir: join(root, 'staging'),
								s3: {
									bucket: 'b',
									key: 'k',
									region: 'r',
									credentials: { accessKeyId: 'AKIAEXAMPLE', secretAccessKey: 'secret' },
								},
							},
						},
					}
				);
				const timers = [];
				let outcome;
				worker.on('message', (message) => {
					if (message?.type === 'timer') timers.push(message.ms);
					else if (message?.type === 'outcome') outcome = message;
				});
				try {
					await waitFor(() => timers.includes(IDLE_MS), {
						timeout: 30000,
						message: () => `the S3 request was never bounded: ${JSON.stringify({ timers, outcome })}`,
					});
					worker.postMessage({ type: 'advance', ms: IDLE_MS - 1 });
					await delay(200);
					assert.strictEqual(outcome, undefined, 'still waiting just inside the bound');
					worker.postMessage({ type: 'advance', ms: 1 });
					await waitFor(() => outcome, { timeout: 5000, message: 'the S3 wait never timed out' });
					assert.strictEqual(outcome.statusCode, 504);
					assert.match(outcome.message, /S3 did not answer for b\/k/);
				} finally {
					await worker.terminate();
				}
			});
		});

		it('keeps a presigned URL out of the job row, and hands it whole to the job worker', async function () {
			const { Worker } = require('node:worker_threads');
			const { JOB_TRANSIENT_ENV } = require('#src/server/jobs/jobRunner');
			const manageThreads = require('#src/server/threads/manageThreads');
			const signed = 'https://backups.example.com/exports/db.tar.gz?X-Amz-Signature=sekrit-token';
			// no job worker is started from this thread: what runJob would start it with is recorded, and the
			// real job worker is then run below with exactly that
			const started = [];
			const restoreStart = replaceProperty(manageThreads, 'startWorker', (path, options) =>
				started.push({ path, options })
			);
			let queued;
			try {
				queued = await restoreBackupRequest({ ...SU, operation: 'restore_backup', database: IMPORTED, url: signed });
			} finally {
				restoreStart();
			}

			const row = JSON.parse(JSON.stringify(await getDatabases().system.hdb_job.get(queued.job_id)));
			assert.strictEqual(row.request.url, 'https://backups.example.com/exports/db.tar.gz');
			assert.ok(!JSON.stringify(row).includes('sekrit'), 'nothing of the query is persisted');
			assert.strictEqual(started.length, 1);
			const { env } = started[0].options;
			assert.deepStrictEqual(JSON.parse(env[JOB_TRANSIENT_ENV]), { url: signed });

			// The job worker, reading that row, with its dispatch stubbed to report the request it would run.
			const worker = new Worker(
				`
				const { workerData, parentPort } = require('node:worker_threads');
				const jobs = require(workerData.jobs);
				const serverUtilities = require(workerData.serverUtilities);
				const application = require(workerData.application);
				jobs.getJobById = async () => [workerData.row];
				jobs.updateJob = async () => {};
				application.getEnvBuiltInComponents = () => [];
				serverUtilities.getOperationFunction = () => ({
					job_operation_function: async (request) =>
						parentPort.postMessage({
							type: 'ran',
							url: request.url,
							transientLeft: process.env[workerData.transientEnv],
						}),
				});
				require(workerData.jobProcess);
				`,
				{
					eval: true,
					env,
					workerData: {
						row,
						transientEnv: JOB_TRANSIENT_ENV,
						jobs: require.resolve('#src/server/jobs/jobs'),
						serverUtilities: require.resolve('#src/server/serverHelpers/serverUtilities'),
						application: require.resolve('#src/components/Application'),
						jobProcess: require.resolve('#src/server/jobs/jobProcess'),
					},
				}
			);
			let ran;
			const errors = [];
			worker.on('message', (message) => {
				if (message?.type === 'ran') ran = message;
			});
			worker.on('error', (error) => errors.push(error));
			try {
				await waitFor(() => ran || errors.length > 0, { timeout: 30000, message: 'the job worker never ran the job' });
			} finally {
				await worker.terminate();
			}
			assert.deepStrictEqual(errors, []);
			assert.strictEqual(ran.url, signed, 'the job runs with the URL the operator sent');
			assert.strictEqual(ran.transientLeft, undefined, 'and drops it from its environment once read');
		});

		// An end-to-end https pull needs safeFetch's Symbol-keyed test transport to trust loopback, which a
		// JSON operation (and so the child's IPC arguments) cannot carry; safeFetch.test.js covers the fetch.
		for (const host of ['127.0.0.1', 'localhost']) {
			it(`refuses a loopback source (${host}) by policy, naming only the redacted URL`, async function () {
				const url = `https://${host}:${port}/exports/db.tar.gz?X-Amz-Signature=sekrit-token#frag`;
				const error = await restoreBackup({ ...SU, database: IMPORTED, url }).then(
					() => assert.fail('a loopback pull must be refused'),
					(error) => error
				);
				assert.strictEqual(error.statusCode, 400, error.message);
				assert.ok(error.message.includes(`https://${host}:${port}/exports/db.tar.gz`), error.message);
				assert.ok(!/sekrit|X-Amz|frag/.test(error.message), error.message);
				assert.strictEqual(requests, 0, 'nothing connects to a denied address');
				assert.deepStrictEqual(stagingEntries(IMPORTED), []);
				assert.deepStrictEqual(await repositoryState(IMPORTED), { engine: [], manifests: [], top: [], listed: [] });
			});
		}
	});

	describe('S3 credentials', function () {
		const restoreChildRunner = require('#src/dataLayer/restoreChildRunner');
		const jobRunner = require('#src/server/jobs/jobRunner');
		const { databases } = require('#src/resources/databases');
		const { registerSecretCustody, clearSecretCustody } = require('#src/resources/secretDecryptor');
		const { resolveProcessSecret } = require('#src/components/secretOperations');
		const PLAINTEXT = JSON.stringify({ accessKeyId: 'AKIAEXAMPLE', secretAccessKey: 'plaintext-secret-key' });
		const rows = new Map([
			['S3_CREDS', { name: 'S3_CREDS', processEnv: true, envelope: 'envelope:S3_CREDS' }],
			['NOT_JSON', { name: 'NOT_JSON', processEnv: true, envelope: 'envelope:NOT_JSON' }],
			['SCOPED', { name: 'SCOPED', processEnv: false, grants: ['app'], envelope: 'envelope:SCOPED' }],
		]);
		const plaintexts = { S3_CREDS: PLAINTEXT, NOT_JSON: 'not-json-plaintext', SCOPED: PLAINTEXT };
		let restores;
		let priorTable;

		// no S3 and no job thread in a unit test: the child and the job runner stand in
		const replace = (owner, name, replacement) => {
			restores.push(replaceProperty(owner, name, replacement));
			return replacement;
		};

		beforeEach(function () {
			restores = [];
			priorTable = databases.system.hdb_secret;
			databases.system.hdb_secret = { get: async (name) => rows.get(name) };
			registerSecretCustody({ decrypt: (envelope) => plaintexts[envelope.slice('envelope:'.length)] });
		});

		afterEach(function () {
			for (const restore of (restores ?? []).reverse()) restore();
			databases.system.hdb_secret = priorTable;
			clearSecretCustody();
			rmSync(backupDirForDatabase(IMPORTED), { recursive: true, force: true });
		});

		it('resolves only a processEnv secret, and only with custody', async function () {
			assert.strictEqual(await resolveProcessSecret('S3_CREDS'), PLAINTEXT);
			await assert.rejects(resolveProcessSecret('SCOPED'), (error) => error.statusCode === 403);
			await assert.rejects(resolveProcessSecret('MISSING'), (error) => error.statusCode === 404);
			clearSecretCustody();
			await assert.rejects(resolveProcessSecret('S3_CREDS'), (error) => error.statusCode === 503);
		});

		const s3 = (secret) => ({
			bucket: 'backups',
			key: 'db/archive.tar.gz',
			region: 'us-east-1',
			credentials: { secret },
		});

		it('hands the resolved keys only to the child, leaving the job request with the secret name', async function () {
			let childArgs;
			replace(restoreChildRunner, 'runRestoreChild', async (_command, args) => {
				childArgs = args;
				mkdirSync(args.stagingDir, { recursive: true });
				throw new Error('S3 is not reachable from a unit test');
			});
			const request = { ...SU, database: IMPORTED, s3: s3('S3_CREDS') };
			await assert.rejects(restoreBackup(request), /not reachable/);
			assert.deepStrictEqual(request.s3, s3('S3_CREDS'), 'the job request is not rewritten with the plaintext');
			assert.deepStrictEqual(childArgs.s3, {
				bucket: 'backups',
				key: 'db/archive.tar.gz',
				region: 'us-east-1',
				credentials: JSON.parse(PLAINTEXT),
			});
			assert.strictEqual(childArgs.restoredFrom, 's3://backups/db/archive.tar.gz');
			assert.deepStrictEqual(stagingEntries(IMPORTED), []);
		});

		it('gives the stage child 30 hours, past the day a pull alone may take', async function () {
			const child = replace(
				restoreChildRunner,
				'runRestoreChild',
				recordingCalls(async (_command, args) => {
					mkdirSync(args.stagingDir, { recursive: true });
					throw new Error('no child in a unit test');
				})
			);
			await assert.rejects(restoreBackup({ ...SU, database: IMPORTED, s3: s3('S3_CREDS') }), /no child/);
			assert.strictEqual(child.calls.length, 1);
			assert.strictEqual(child.calls[0][2]?.timeoutMs, 30 * 60 * 60 * 1000);
		});

		it('refuses a scoped secret or one that is not a key pair, without echoing its value', async function () {
			const child = replace(
				restoreChildRunner,
				'runRestoreChild',
				recordingCalls(async () => {
					throw new Error('must not run');
				})
			);
			await assert.rejects(
				restoreBackup({ ...SU, database: IMPORTED, s3: s3('SCOPED') }),
				(error) => error.statusCode === 403
			);
			await assert.rejects(
				restoreBackup({ ...SU, database: IMPORTED, s3: s3('NOT_JSON') }),
				(error) =>
					error.statusCode === 400 && /NOT_JSON/.test(error.message) && !/not-json-plaintext/.test(error.message)
			);
			assert.strictEqual(child.calls.length, 0);
		});

		// A job worker without custody asks the main thread; a reply that never comes must not leave the
		// job IN_PROGRESS forever. Fake timers stand in for the 30s deadline.
		it('fails the job with 504 when the main thread never answers the secret request', async function () {
			const { Worker } = require('node:worker_threads');
			const worker = new Worker(
				`
				const { workerData, parentPort } = require('node:worker_threads');
				const { stageArchiveForRestore } = require(workerData.restoreArchive);
				// a manual clock: the deadline reads the global setTimeout when it is armed
				const pending = new Map();
				let now = 0;
				globalThis.setTimeout = (callback, ms = 0, ...args) => {
					const handle = { ref: () => handle, unref: () => handle, hasRef: () => true };
					pending.set(handle, { at: now + ms, callback, args });
					return handle;
				};
				globalThis.clearTimeout = (handle) => pending.delete(handle);
				parentPort.on('message', (message) => {
					if (message?.type !== 'advance') return;
					now += message.ms;
					for (const [handle, timer] of [...pending].sort((a, b) => a[1].at - b[1].at)) {
						if (timer.at > now || !pending.delete(handle)) continue;
						timer.callback(...timer.args);
					}
				});
				stageArchiveForRestore(workerData.request, workerData.request.database).then(
					() => parentPort.postMessage({ type: 'outcome' }),
					(error) => parentPort.postMessage({ type: 'outcome', message: error.message, statusCode: error.statusCode })
				);
				`,
				{
					eval: true,
					workerData: {
						restoreArchive: require.resolve('#src/dataLayer/restoreArchive'),
						request: { ...SU, database: IMPORTED, s3: s3('S3_CREDS') },
					},
				}
			);
			const requests = [];
			let outcome;
			worker.on('message', (message) => {
				if (message?.type === 'import_secret_request') requests.push(message);
				else if (message?.type === 'outcome') outcome = message;
			});
			try {
				await waitFor(() => requests.length === 1, {
					timeout: 30000,
					message: 'the worker never asked for the secret',
				});
				assert.strictEqual(requests[0].name, 'S3_CREDS');
				worker.postMessage({ type: 'advance', ms: 29_999 });
				await delay(200);
				assert.strictEqual(outcome, undefined, 'still waiting just inside the deadline');
				worker.postMessage({ type: 'advance', ms: 1 });
				await waitFor(() => outcome, { timeout: 5000, message: 'the secret request never timed out' });
				assert.strictEqual(outcome.statusCode, 504);
				assert.match(outcome.message, /did not resolve secret 'S3_CREDS' in time/);
			} finally {
				await worker.terminate();
			}
		});

		it('persists only the secret name in the job row', async function () {
			replace(jobRunner, 'parseMessage', async () => undefined);
			const { job_id } = await restoreBackupRequest({
				...SU,
				operation: 'restore_backup',
				database: IMPORTED,
				s3: s3('S3_CREDS'),
			});
			const row = await getDatabases().system.hdb_job.get(job_id);
			assert.deepStrictEqual(row.request.s3, s3('S3_CREDS'));
			assert.ok(!JSON.stringify(row).includes('plaintext-secret-key'));
		});
	});

	describe('staging sweeps', function () {
		const manageThreads = require('#src/server/threads/manageThreads');
		const DB = 'importsweep';

		function area(name, owner) {
			const dir = join(stagingRoot(DB), name);
			mkdirSync(dir, { recursive: true });
			if (owner) writeFileSync(join(dir, 'owner.json'), JSON.stringify(owner));
			return dir;
		}

		beforeEach(function () {
			area('imported', { owner: 'import', import_id: 'imported' });
			area('thread-7', { owner: 'thread', thread_id: 7, process_instance: manageThreads.processIncarnation });
			area('thread-8', { owner: 'thread', thread_id: 8, process_instance: manageThreads.processIncarnation });
			area('earlier-process', { owner: 'thread', thread_id: 7, process_instance: 'an-earlier-process' });
			// a url, s3 or server_path import in flight: its staging has no owner record
			area('in-flight-pull');
		});

		afterEach(function () {
			rmSync(backupDirForDatabase(DB), { recursive: true, force: true });
		});

		it('on a thread exit, removes only the staging that thread was still writing', function () {
			assert.strictEqual(restoreArchive.sweepExitedThreadStaging(7), 1);
			assert.deepStrictEqual(stagingEntries(DB).sort(), ['earlier-process', 'imported', 'in-flight-pull', 'thread-8']);
		});

		it('keeps every area the predicate claims and never removes .staging', function () {
			assert.strictEqual(
				sweepImportStaging(() => true),
				0
			);
			assert.strictEqual(stagingEntries(DB).length, 5);
			assert.strictEqual(
				sweepImportStaging(() => false),
				5
			);
			assert.ok(existsSync(stagingRoot(DB)), '.staging itself stays');
		});

		it('at startup removes every area, once per process', function () {
			resetImportStagingSweepForTesting();
			sweepImportStagingAtStartup();
			assert.deepStrictEqual(stagingEntries(DB), []);
			area('later');
			sweepImportStagingAtStartup();
			assert.deepStrictEqual(stagingEntries(DB), ['later'], 'a later call is a no-op');
		});
	});
});

describe('restore_backup archive validation', function () {
	const WITH_BACKUP = 'restarcvalidationbackup';
	const ok = { ...SU, database: 'importvalidation' };
	const s3 = { bucket: 'b', key: 'k', region: 'us-east-1', credentials: { secret: 'S3_CREDS' } };
	const identity = { dev: 1, ino: 2, size: 3, mtime_ms: 4.5 };
	const serverPath = join(tmpdir(), 'a.tar');
	const filler = { server_path: serverPath, server_path_identity: identity };
	const accepted = [
		{ ...filler },
		{ url: 'https://example.com/a.tar.gz?X-Amz-Signature=x' },
		{ s3 },
		{ s3: { bucket: 'b', key: 'k', credentials: { secret: 'S3_CREDS' } } },
		{ ...filler, declared_size: 0, sha256: 'A'.repeat(64), accept_incompatible_backup: true },
		{ ...filler, on_restart: true },
		{ ...filler, retain_previous: false, on_restart: true },
		{ staging_id: randomUUID() },
	];
	for (const fields of accepted) {
		it(`accepts ${JSON.stringify(fields)}`, async function () {
			await validateRestoreBackup({ ...ok, ...fields });
		});
	}

	after(async function () {
		await closeDatabase(WITH_BACKUP).catch(() => {});
		rmSync(backupDirForDatabase(WITH_BACKUP), { recursive: true, force: true });
	});

	(process.env.HARPER_STORAGE_ENGINE === 'lmdb' ? it.skip : it)(
		'still validates a restore with no archive against the latest backup',
		async function () {
			const name = WITH_BACKUP;
			const Items = table({
				table: 'Items',
				database: name,
				attributes: [{ name: 'id', isPrimaryKey: true }],
			});
			await Items.put({ id: 1 });
			await Items.primaryStore.rootStore.flush();
			await assert.rejects(
				validateRestoreBackup({ ...SU, database: name }),
				(error) => error.statusCode === 404 && /has no backup to restore.*pass file=<path>/.test(error.message)
			);
			await createBackup({ database: name });
			await validateRestoreBackup({ ...SU, database: name });
		}
	);

	const refused = [
		['two archives', { ...filler, url: 'https://example.com/a.tar' }, /takes one archive/],
		['a url and an s3 archive', { url: 'https://example.com/a.tar', s3 }, /takes one archive/],
		['an archive and a backup_id', { ...filler, backup_id: 1 }, /managed backup/],
		['an archive and immutable_source', { ...filler, immutable_source: true }, /immutable_source/],
		['an archive and resume', { ...filler, resume: true }, /'resume' and 'cancel'/],
		['an archive and cancel', { ...filler, cancel: true }, /'resume' and 'cancel'/],
		['on_restart with a target_database', { ...filler, on_restart: true, target_database: 'other' }, /target_database/],
		['a relative server_path', { ...filler, server_path: 'a.tar' }, /server_path/],
		['a non-string server_path', { ...filler, server_path: 7 }, /server_path/],
		['a server_path without an identity', { server_path: serverPath }, /server_path_identity/],
		[
			'an identity missing a key',
			{ ...filler, server_path_identity: { dev: 1, ino: 2, size: 3 } },
			/server_path_identity/,
		],
		[
			'an identity with an extra key',
			{ ...filler, server_path_identity: { ...identity, extra: 1 } },
			/server_path_identity/,
		],
		[
			'an identity with a non-number',
			{ ...filler, server_path_identity: { ...identity, size: '3' } },
			/server_path_identity/,
		],
		['an identity and no source', { server_path_identity: identity }, /only for a 'server_path'/],
		[
			'an identity beside another source',
			{ url: 'https://example.com/a.tar', server_path_identity: identity },
			/only for a 'server_path'/,
		],
		['an http url', { url: 'http://example.com/a.tar' }, /https/],
		['a non-string url', { url: 7 }, /https/],
		['an s3 that is not an object', { s3: 'bucket/key' }, /bucket and a key/],
		['an s3 with no key', { s3: { bucket: 'b' } }, /bucket and a key/],
		// the job could only refuse it after its row exists
		['an s3 with no credentials', { s3: { bucket: 'b', key: 'k' } }, /credentials: \{ secret/],
		['an s3 with null credentials', { s3: { bucket: 'b', key: 'k', credentials: null } }, /credentials: \{ secret/],
		['an s3 with an endpoint', { s3: { ...s3, endpoint: 'http://169.254.169.254' } }, /inline keys are refused/],
		['inline s3 keys', { s3: { ...s3, aws_access_key_id: 'AK', aws_secret_access_key: 'SK' } }, /inline keys/],
		[
			'inline credentials',
			{ s3: { ...s3, credentials: { accessKeyId: 'AK', secretAccessKey: 'SK' } } },
			/inline keys are refused/,
		],
		['a secret beside inline keys', { s3: { ...s3, credentials: { secret: 'n', secretAccessKey: 'SK' } } }, /inline/],
		['a credentials string', { s3: { ...s3, credentials: 'S3_CREDS' } }, /inline keys are refused/],
		['a negative declared_size', { ...filler, declared_size: -1 }, /declared_size/],
		['a fractional declared_size', { ...filler, declared_size: 1.5 }, /declared_size/],
		['a string declared_size', { ...filler, declared_size: '10' }, /declared_size/],
		['a short sha256', { ...filler, sha256: 'abc' }, /sha256/],
		['a non-hex sha256', { ...filler, sha256: 'g'.repeat(64) }, /sha256/],
		['a non-boolean accept_incompatible_backup', { ...filler, accept_incompatible_backup: 'true' }, /boolean/],
		['a database that escapes the backups root', { ...filler, database: '../system' }, /database/i],
		['a staging_id that is a path', { staging_id: '../../elsewhere' }, /staging_id/],
	];
	for (const [label, fields, pattern] of refused) {
		it(`refuses ${label} with a 400`, async function () {
			await assert.rejects(
				validateRestoreBackup({ ...ok, ...fields }),
				(error) => error.statusCode === 400 && pattern.test(error.message)
			);
		});
	}

	it('never echoes a URL query in a refusal', async function () {
		await assert.rejects(
			validateRestoreBackup({ ...ok, url: 'http://example.com/a.tar?X-Amz-Signature=sekrit' }),
			(error) => !error.message.includes('sekrit')
		);
	});

	const nonSuperUsers = {
		'a non-super_user role': { super_user: false },
		'a role with restore_backup in its operations allowlist': { super_user: false, operations: ['restore_backup'] },
	};
	for (const [label, permission] of Object.entries(nonSuperUsers)) {
		it(`refuses ${label} with a 403, in the validator and the handler`, async function () {
			const request = {
				hdb_user: { username: 'joe', role: { permission } },
				database: 'x',
				server_path: serverPath,
				server_path_identity: identity,
			};
			await assert.rejects(validateRestoreBackup(request), (error) => error.statusCode === 403);
			await assert.rejects(
				restoreBackupRequest({ ...request, operation: 'restore_backup' }),
				(error) => error.statusCode === 403
			);
		});
	}
});

describe('restore_backup operation logging', function () {
	const serverUtilities = require('#src/server/serverHelpers/serverUtilities');

	it('drops url, s3 and payload from a restore_backup body, whatever their case', function () {
		const body = {
			operation: 'restore_backup',
			database: 'db',
			server_path: '/a.tar',
			url: 'https://example.com/a?X-Amz-Signature=sekrit',
			URL: 'https://example.com/a?X-Amz-Signature=sekrit',
			s3: { bucket: 'b', key: 'k', credentials: { secret: 'S3_CREDS' } },
			payload: Readable.from([]),
		};
		assert.deepStrictEqual(serverUtilities.redactForOperationLog(body), {
			operation: 'restore_backup',
			database: 'db',
			server_path: '/a.tar',
		});
		const other = { operation: 'csv_url_load', url: 'https://example.com/a.csv' };
		assert.deepStrictEqual(serverUtilities.redactForOperationLog(other), other, 'only restore_backup drops url');
	});

	describe("executeJob's created-job log (real log file)", function () {
		const { pinLogConfig } = require('../logConfigFixture.js');
		const harperLogger = require('#src/utility/logging/harper_logger');
		const jobs = require('#src/server/jobs/jobs');
		const jobRunner = require('#src/server/jobs/jobRunner');
		let restoreLogConfig;
		let originalLogLevel;

		before(function () {
			restoreLogConfig = pinLogConfig({ level: 'info' });
			originalLogLevel = harperLogger.logLevel;
			harperLogger.logLevel = 'info';
		});

		after(function () {
			harperLogger.logLevel = originalLogLevel;
			restoreLogConfig?.();
		});

		it('logs the job id and type, not the request that carries a presigned URL', async function () {
			const marker = randomUUID();
			const request = {
				operation: 'restore_backup',
				database: 'db',
				url: 'https://example.com/a.tar.gz?X-Amz-Signature=sekrit-presigned',
			};
			const logPath = harperLogger.getLogFilePath();
			const offset = existsSync(logPath) ? readFileSync(logPath, 'utf8').length : 0;

			// the job row and the job thread stand in, so only executeJob's own log is in play
			const restores = [
				replaceProperty(jobs, 'addJob', async () => ({
					createdJob: { id: marker, type: 'restore_backup', request },
				})),
				replaceProperty(jobRunner, 'parseMessage', async () => undefined),
			];
			try {
				// the loaded module, not a fresh copy: re-requiring it rebinds server.operation and
				// server.registerOperation to the copy for every later test
				assert.strictEqual((await serverUtilities.executeJob(request)).job_id, marker);
			} finally {
				for (const restore of restores) restore();
			}

			const written = await waitFor(
				() => {
					if (!existsSync(logPath)) return undefined;
					const tail = readFileSync(logPath, 'utf8').slice(offset);
					return tail.includes(marker) ? tail : undefined;
				},
				{ message: 'the addJob result entry was never written' }
			);
			assert.match(written, /addJob result/);
			assert.ok(!written.includes('sekrit-presigned'), written);
		});
	});
});

describe('restore_backup CLI', function () {
	const http = require('node:http');
	const busboy = require('busboy');
	const cliOperations = require('#src/bin/cliOperations');
	let server;
	let target;
	let received;
	let requests;
	let jsonStatus;
	let tempDir;
	let originalExit;
	let originalConsoleError;
	let originalConsoleLog;

	before(async function () {
		tempDir = mkdtempSync(join(tmpdir(), 'harper.unit-test.import-cli-'));
		server = http.createServer((req, res) => {
			const finish = (record, status, body) => {
				received = record;
				requests.push(record);
				res.writeHead(status, { 'content-type': 'application/json' });
				res.end(JSON.stringify(body));
			};
			const started = { message: 'Starting job', job_id: 'job-1' };
			if ((req.headers['content-type'] ?? '').startsWith('application/json')) {
				const chunks = [];
				req.on('data', (chunk) => chunks.push(chunk));
				req.on('end', () => {
					const record = { headers: req.headers, json: JSON.parse(Buffer.concat(chunks).toString('utf8')) };
					finish(record, jsonStatus, jsonStatus === 200 ? started : { error: 'not the same file' });
				});
				return;
			}
			const parts = [];
			const parser = busboy({ headers: req.headers });
			parser.on('field', (name, value) => parts.push({ kind: 'field', name, value }));
			parser.on('file', (name, stream, info) => {
				const chunks = [];
				stream.on('data', (chunk) => chunks.push(chunk));
				stream.on('end', () => parts.push({ kind: 'file', name, info, bytes: Buffer.concat(chunks) }));
			});
			parser.on('close', () => finish({ headers: req.headers, parts }, 200, started));
			req.pipe(parser);
		});
		await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
		target = `http://127.0.0.1:${server.address().port}`;
	});

	after(async function () {
		if (server) await new Promise((resolve) => server.close(resolve));
		if (tempDir) rmSync(tempDir, { recursive: true, force: true });
	});

	beforeEach(function () {
		received = undefined;
		requests = [];
		jsonStatus = 200;
		originalExit = process.exit;
		process.exit = (code) => {
			throw new Error(`process.exit(${code})`);
		};
		originalConsoleError = console.error;
		originalConsoleLog = console.log;
		console.error = () => {};
		console.log = () => {};
	});

	afterEach(function () {
		process.exit = originalExit;
		console.error = originalConsoleError;
		console.log = originalConsoleLog;
	});

	const send = (file) =>
		cliOperations.cliOperations(
			{ operation: 'restore_backup', database: 'db', file, target, auth_username: 'admin', auth_password: 'pw' },
			true
		);

	describe('with a local target', function () {
		it('sends the path and its identity as JSON, not the bytes', async function () {
			const archive = join(tempDir, 'local.tar');
			writeFileSync(archive, Buffer.alloc(3000, 'l'));
			await send(archive);
			assert.strictEqual(requests.length, 1);
			assert.match(received.headers['content-type'], /^application\/json/);
			assert.strictEqual(received.json.operation, 'restore_backup');
			assert.strictEqual(received.json.server_path, archive);
			assert.deepStrictEqual(received.json.server_path_identity, fileIdentity(statSync(archive)));
			assert.strictEqual(received.parts, undefined, 'no multipart payload');
			for (const local of ['file', '_uploadInstead', '_uploadFile', '_multipart', 'auth_password']) {
				assert.strictEqual(received.json[local], undefined, `${local} is not sent`);
			}
		});

		it('uploads the archive when the server answers 412', async function () {
			const archive = join(tempDir, 'moved.tar.gz');
			writeFileSync(archive, Buffer.alloc(500, 'm'));
			jsonStatus = 412;
			await send(archive);
			assert.strictEqual(requests.length, 2);
			assert.strictEqual(requests[0].json.server_path, archive);
			const [, upload] = requests;
			assert.match(upload.headers['content-type'], /^multipart\/form-data; boundary=/);
			const fields = Object.fromEntries(upload.parts.filter((p) => p.kind === 'field').map((p) => [p.name, p.value]));
			assert.strictEqual(fields.declared_size, '500');
			for (const local of ['server_path', 'server_path_identity', 'file']) {
				assert.strictEqual(fields[local], undefined, `${local} is not sent`);
			}
			const [file] = upload.parts.filter((part) => part.kind === 'file');
			assert.strictEqual(file.name, 'payload');
			assert.ok(file.bytes.equals(readFileSync(archive)));
		});
	});

	describe('isLocalTarget', function () {
		for (const local of ['http://localhost:9925/', 'http://127.0.0.1:9925', 'http://[::1]:9925', 'localhost:9925']) {
			it(`is true for ${local}`, function () {
				assert.strictEqual(cliOperations.isLocalTarget(local), true);
			});
		}
		for (const remote of ['https://example.com', 'http://10.0.0.5:9925', 'http://0.0.0.0:9925', 'http://']) {
			it(`is false for ${remote}`, function () {
				assert.strictEqual(cliOperations.isLocalTarget(remote), false);
			});
		}
	});

	// 0.0.0.0 reaches this machine's server without being named localhost or 127.x
	(process.platform === 'win32' ? describe.skip : describe)('with a non-local target', function () {
		beforeEach(function () {
			target = `http://0.0.0.0:${server.address().port}`;
		});
		afterEach(function () {
			target = `http://127.0.0.1:${server.address().port}`;
		});

		it('uploads a plain tar as the last multipart part, declaring its size', async function () {
			const archive = join(tempDir, 'db.tar');
			writeFileSync(archive, Buffer.alloc(3000, 't'));
			await send(archive);
			assert.match(received.headers['content-type'], /^multipart\/form-data; boundary=/);
			const kinds = received.parts.map((part) => part.kind);
			assert.deepStrictEqual(kinds.slice(-1), ['file'], 'the file part comes last');
			assert.ok(kinds.slice(0, -1).every((kind) => kind === 'field'));
			const fields = Object.fromEntries(received.parts.filter((p) => p.kind === 'field').map((p) => [p.name, p.value]));
			assert.strictEqual(fields.operation, 'restore_backup');
			assert.strictEqual(fields.database, 'db');
			assert.strictEqual(fields.declared_size, '3000');
			for (const local of ['file', 'auth_password', 'target', '_uploadFile', '_multipart']) {
				assert.strictEqual(fields[local], undefined, `${local} is not sent`);
			}
			const [file] = received.parts.filter((part) => part.kind === 'file');
			assert.strictEqual(file.name, 'payload');
			assert.strictEqual(file.info.filename, 'db.tar');
			assert.strictEqual(file.info.mimeType, 'application/x-tar');
			assert.ok(file.bytes.equals(readFileSync(archive)));
		});

		// the server compares declared_size with the bytes it spools, which for a compressed archive are its own
		it("declares a compressed archive's own size, the bytes the server spools", async function () {
			const archive = join(tempDir, 'db.tar.gz');
			writeFileSync(archive, Buffer.alloc(100, 'g'));
			await send(archive);
			const fields = Object.fromEntries(received.parts.filter((p) => p.kind === 'field').map((p) => [p.name, p.value]));
			assert.strictEqual(fields.declared_size, '100');
			const [file] = received.parts.filter((part) => part.kind === 'file');
			assert.strictEqual(file.info.mimeType, 'application/gzip');
			assert.ok(file.bytes.equals(readFileSync(archive)));
		});

		it('keeps a declared_size the operator passed', async function () {
			const archive = join(tempDir, 'db.tar.gz');
			writeFileSync(archive, Buffer.alloc(100, 'g'));
			await cliOperations.cliOperations(
				{
					operation: 'restore_backup',
					database: 'db',
					file: archive,
					declared_size: 4096,
					target,
					auth_username: 'admin',
					auth_password: 'pw',
				},
				true
			);
			const fields = Object.fromEntries(received.parts.filter((p) => p.kind === 'field').map((p) => [p.name, p.value]));
			assert.strictEqual(fields.declared_size, '4096');
		});
	});
});

describe('releaseArchiveStaging', function () {
	let root;

	beforeEach(function () {
		root = mkdtempSync(join(tmpdir(), 'harper.unit-test.release-staging-'));
	});

	afterEach(function () {
		if (root) rmSync(root, { recursive: true, force: true });
	});

	function stagingUnder() {
		const dir = join(root, 'x', '.staging', randomUUID());
		mkdirSync(dir, { recursive: true });
		writeFileSync(join(dir, 'marker'), 'x');
		return dir;
	}

	it('keeps a managed repository that sits under a .staging parent', function () {
		const dir = stagingUnder();
		restoreArchive.releaseArchiveStaging({ backup_dir: dir });
		assert.ok(existsSync(join(dir, 'marker')));
	});

	it('removes an unpinned staged tree', function () {
		const dir = stagingUnder();
		restoreArchive.releaseArchiveStaging({ backup_dir: dir, source_kind: 'staged_tree' });
		assert.ok(!existsSync(dir));
	});
});
