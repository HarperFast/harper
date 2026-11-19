'use strict';

const testUtils = require('../testUtils');
testUtils.preTestPrep();

const assert = require('node:assert');
const { randomBytes, randomUUID } = require('node:crypto');
const {
	existsSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	renameSync,
	rmSync,
	statSync,
	writeFileSync,
} = require('node:fs');
const { tmpdir } = require('node:os');
const { basename, join, relative } = require('node:path');
const { Readable } = require('node:stream');
const { JOB_STATUS_ENUM, SYSTEM_TABLE_NAMES } = require('#src/utility/hdbTerms');
const {
	closeDatabase,
	getDatabases,
	openRocksDatabase,
	resetDatabases,
	resolveDatabasePath,
	table,
} = require('#src/resources/databases');
const { createBlob, getBlobPathsForDatabaseName } = require('#src/resources/blob');
const { setAnalyticsEnabled } = require('#src/resources/analytics/write');
const { setMainIsWorker } = require('#src/server/threads/manageThreads');
const { getOperationFunction } = require('#src/server/serverHelpers/serverUtilities');
const {
	backupDirForDatabase,
	createBackup,
	createBackupStream,
	restoreBackup,
	validateRestoreBackup,
} = require('#src/dataLayer/rocksdbBackup');
const {
	restoreArchiveOffline,
	restoreBackupFromUpload,
	resumeArchiveRestoreOffline,
	restoreStagedArchive,
	stageArchive,
} = require('#src/dataLayer/restoreArchive');
const { acquireExtractionLock, extractionLockPath } = require('#src/dataLayer/archiveExtractionLock');
const { mintStagingId, readStagedRecord, STAGED_SUFFIX, writeStagedRecord } = require('#src/dataLayer/archiveStaging');
const { resumeRestartRestore } = require('#src/dataLayer/restoreIntent');
const env = require('#src/utility/environment/environmentManager');
const {
	RESTORE_META_DIR,
	acquireRestoreLock,
	markRestoreDestructive,
	releaseRestoreLock,
	restoreMarkerPresent,
	restoringMarkerPath,
	restoreMetaKey,
} = require('#src/dataLayer/restoreMarker');
const {
	newRestoreReceipt,
	readRestoreReceipt,
	restoreReceiptPath,
	writeRestoreReceipt,
} = require('#src/dataLayer/restoreReceipt');
const { recoverRestoresAtStartup, resetStartupRecoveryForTesting } = require('#src/dataLayer/restorePublication');
const { DeferredJobCompletion } = require('#src/server/jobs/deferredJobCompletion');
const { reconcileInterruptedJobs, settleAbandonedJob } = require('#src/server/jobs/jobOwnership');
const restoreChildRunnerModule = require('#js/dataLayer/restoreChildRunner');
const archiveStagingModule = require('#js/dataLayer/archiveStaging');
const { waitFor } = require('../waitFor.js');
const { runRestoreChild } = restoreChildRunnerModule;

const describeUnlessLmdb = process.env.HARPER_STORAGE_ENGINE === 'lmdb' ? describe.skip : describe;

// The code under test reads these exports through their module objects at call time, so assigning one
// reaches it (the compiled build only, hence `#js`). Returns the function that puts the original back.
function replaceExport(module, name, replacement) {
	const original = module[name];
	module[name] = replacement;
	return () => {
		module[name] = original;
	};
}

const SU = { hdb_user: { username: 'admin', role: { permission: { super_user: true } } } };
const BLOB_BYTES = 20000; // over the file-storage threshold, so the blob lives in a blob root

describeUnlessLmdb('restore_backup from a get_backup archive', function () {
	this.timeout(180000);
	let sequence = 0;
	const databases = [];
	const seededJobs = [];
	const scratch = mkdtempSync(join(tmpdir(), 'harper.unit-test.restore-archive-'));
	let savedSafeMode;

	before(async function () {
		testUtils.setupTestDBPath();
		setMainIsWorker(true);
		setAnalyticsEnabled(false);
		await testUtils.ensureSystemTables();
		savedSafeMode = process.env.HARPER_SAFE_MODE;
	});

	afterEach(function () {
		if (savedSafeMode === undefined) delete process.env.HARPER_SAFE_MODE;
		else process.env.HARPER_SAFE_MODE = savedSafeMode;
		resetStartupRecoveryForTesting();
		assert.strictEqual(existsSync(extractionLockPath()), false, 'every extraction released its lock');
	});

	after(async function () {
		setAnalyticsEnabled(true);
		for (const id of seededJobs)
			await jobTable()
				.delete(id)
				.catch(() => {});
		for (const name of databases) {
			await closeDatabase(name).catch(() => {});
			const dir = resolveDatabasePath(name);
			rmSync(restoreReceiptPath(dir), { force: true });
			rmSync(restoringMarkerPath(dir), { force: true });
			for (const root of getBlobPathsForDatabaseName(name)) rmSync(root, { recursive: true, force: true });
			rmSync(backupDirForDatabase(name), { recursive: true, force: true });
		}
		rmSync(scratch, { recursive: true, force: true });
	});

	function jobTable() {
		return getDatabases().system[SYSTEM_TABLE_NAMES.JOB_TABLE_NAME];
	}

	function definition(database) {
		return {
			table: 'Items',
			database,
			attributes: [
				{ name: 'id', isPrimaryKey: true },
				{ name: 'label', indexed: true },
				{ name: 'data', type: 'Blob' },
			],
		};
	}

	async function putWithBlob(Items, id, label, bytes) {
		const data = await createBlob(bytes);
		await Items.put({ id, label, data });
		await data.written;
	}

	async function snapshot(Items) {
		const records = {};
		for await (const record of Items.search([])) {
			records[record.id] = {
				label: record.label,
				data: record.data ? Buffer.from(await record.data.arrayBuffer()).toString('base64') : undefined,
			};
		}
		return records;
	}

	async function archiveOf(Items, name) {
		const chunks = [];
		for await (const chunk of createBackupStream(Items.primaryStore.rootStore, name, true)) chunks.push(chunk);
		return Buffer.concat(chunks);
	}

	/**
	 * A database with an index and a file-backed blob, archived with get_backup, then changed so the live
	 * state differs from the archive in every record.
	 */
	async function seededDatabase() {
		const name = `restore_archive_${process.pid}_${++sequence}`;
		databases.push(name);
		const Items = table(definition(name));
		await putWithBlob(Items, 'a', 'archived', randomBytes(BLOB_BYTES));
		await Items.put({ id: 'only-in-archive', label: 'archived' });
		await Items.primaryStore.rootStore.flush();
		await Items.indices.label.flush?.();
		const archived = await snapshot(Items);
		const archive = await archiveOf(Items, name);
		await putWithBlob(Items, 'a', 'live', randomBytes(BLOB_BYTES));
		await Items.delete('only-in-archive');
		await Items.put({ id: 'only-live', label: 'live' });
		await Items.primaryStore.rootStore.flush();
		return { name, dir: resolveDatabasePath(name), archive, archived, live: await snapshot(Items) };
	}

	async function seedJob() {
		const id = randomUUID();
		seededJobs.push(id);
		await jobTable().put({
			id,
			type: 'restore_backup',
			status: JOB_STATUS_ENUM.IN_PROGRESS,
			start_datetime: Date.now(),
			created_datetime: Date.now(),
		});
		return id;
	}

	async function asJob(jobId, run) {
		const saved = process.env.PROCESS_NAME;
		process.env.PROCESS_NAME = `JOB-${jobId}`;
		try {
			return await run();
		} finally {
			if (saved === undefined) delete process.env.PROCESS_NAME;
			else process.env.PROCESS_NAME = saved;
		}
	}

	/**
	 * The operation as the HTTP worker runs it, with the job queued and then run as its job worker would:
	 * `executeJob` validates the job request as job creation does and records what it would queue.
	 */
	async function uploadAndRun(name, archive, options = {}) {
		const jobId = await seedJob();
		let queued;
		const response = await restoreBackupFromUpload(
			{ ...SU, operation: 'restore_backup', database: name, ...options, payload: Readable.from([archive]) },
			async (json) => {
				await validateRestoreBackup(json);
				queued = json;
				return { message: `Starting job with id ${jobId}`, job_id: jobId };
			}
		);
		assert.strictEqual(queued.payload, undefined, 'the job row never holds the upload');
		return { jobId, response, queued, result: await asJob(jobId, () => restoreBackup(queued)) };
	}

	async function requestRestore(name, options) {
		const jobId = await seedJob();
		const request = { ...SU, operation: 'restore_backup', database: name, ...options };
		await validateRestoreBackup(request);
		return { jobId, result: await asJob(jobId, () => restoreBackup(request)) };
	}

	function loadedItems(name) {
		resetDatabases();
		return getDatabases()[name]?.Items;
	}

	async function boot(name) {
		await closeDatabase(name);
		resetStartupRecoveryForTesting();
		return recoverRestoresAtStartup();
	}

	/** Every staging area left for a database, in its storage root and its blob paths. */
	function stagingLeft(name) {
		const dir = resolveDatabasePath(name);
		const key = restoreMetaKey(dir) + STAGED_SUFFIX;
		const locations = [join(dir, '..'), ...getBlobPathsForDatabaseName(name).map((root) => join(root, '..'))];
		return locations
			.map((location) => join(location, RESTORE_META_DIR, key))
			.filter((path) => existsSync(path))
			.flatMap((path) => readdirSync(path).map((id) => join(path, id)));
	}

	/** A refused upload is answered first; its staging is removed, and then the extraction lock released, after. */
	function refusedUploadRemoved(name) {
		return waitFor(() => stagingLeft(name).length === 0 && !existsSync(extractionLockPath()), {
			timeout: 30000,
			message: () => `left: ${JSON.stringify(stagingLeft(name))}, lock held: ${existsSync(extractionLockPath())}`,
		});
	}

	function receiptOf(dir) {
		const read = readRestoreReceipt(dir);
		assert.strictEqual(read.kind, 'valid', `expected a readable receipt, found ${JSON.stringify(read)}`);
		return read.receipt;
	}

	function filesUnder(root, predicate) {
		const found = [];
		const visit = (directory) => {
			for (const entry of readdirSync(directory, { withFileTypes: true })) {
				const path = join(directory, entry.name);
				if (entry.isDirectory()) visit(path);
				else if (predicate(path)) found.push(path);
			}
		};
		if (existsSync(root)) visit(root);
		return found;
	}

	function partsOf(stagingDir) {
		const record = readStagedRecord(stagingDir);
		return { record, engine: record.parts[0], blobs: record.parts.filter((part) => part.kind === 'blobs') };
	}

	describe('online', function () {
		it('replaces the database with the archive, blobs included, installing the staged files without copying them', async function () {
			const fixture = await seededDatabase();
			const installed = {};
			// the inodes the staged proof left, against those the swap installed
			const restoreRunner = replaceExport(
				restoreChildRunnerModule,
				'runRestoreChild',
				async (command, args, options) => {
					if (command !== 'apply-and-prove') return runRestoreChild(command, args, options);
					const { engine, blobs } = partsOf(args.stagingDir);
					const inodes = (root, predicate) =>
						new Map(filesUnder(root, predicate).map((path) => [relative(root, path), statSync(path).ino]));
					const stagedTables = inodes(engine.staged, (path) => path.endsWith('.sst'));
					const stagedBlobs = inodes(blobs[0].staged, () => true);
					assert.ok(
						stagedTables.size > 0 && stagedBlobs.size > 0,
						'precondition: a table file and a blob file are staged'
					);
					const evidence = await runRestoreChild(command, args, options);
					// before anything reopens the database here, which may compact the table files away
					const tables = inodes(engine.destination, (path) => path.endsWith('.sst'));
					installed.tables = [...stagedTables]
						.filter(([path]) => tables.has(path))
						.map(([path, ino]) => [ino, tables.get(path)]);
					const blobFiles = inodes(blobs[0].destination, () => true);
					installed.blobs = [...stagedBlobs].map(([path, ino]) => [ino, blobFiles.get(path)]);
					return evidence;
				}
			);
			let outcome;
			try {
				outcome = await uploadAndRun(fixture.name, fixture.archive);
			} finally {
				restoreRunner();
			}

			assert.match(outcome.response.archive_sha256, /^[0-9a-f]{64}$/);
			assert.strictEqual(outcome.result.archive_sha256, outcome.response.archive_sha256);
			assert.strictEqual(outcome.result.restored_from, 'upload');
			assert.strictEqual(outcome.result.backup_id, undefined);
			assert.strictEqual(outcome.result.blob_integrity, 'verified');
			assert.deepStrictEqual(await snapshot(loadedItems(fixture.name)), fixture.archived);
			assert.ok(installed.tables.length > 0, 'a staged table file is installed');
			for (const [staged, live] of [...installed.tables, ...installed.blobs]) assert.strictEqual(live, staged);
			assert.strictEqual(readRestoreReceipt(fixture.dir).kind, 'absent');
			assert.strictEqual(restoreMarkerPresent(fixture.dir), false);
			assert.deepStrictEqual(stagingLeft(fixture.name), [], 'the staging, replaced generation included, is gone');
			assert.strictEqual(
				existsSync(join(backupDirForDatabase(fixture.name), 'meta')),
				false,
				'no repository was needed'
			);
		});

		it('restores into a database that does not exist yet', async function () {
			const fixture = await seededDatabase();
			const name = `${fixture.name}_new`;
			databases.push(name);
			await uploadAndRun(name, fixture.archive);
			assert.deepStrictEqual(await snapshot(loadedItems(name)), fixture.archived);
			assert.deepStrictEqual(stagingLeft(name), []);
		});

		it('leaves the database serving and unchanged, and no staging, when the archive is corrupt', async function () {
			const fixture = await seededDatabase();
			const Items = getDatabases()[fixture.name].Items;
			const truncated = fixture.archive.subarray(0, fixture.archive.length - 100);
			await assert.rejects(uploadAndRun(fixture.name, truncated), (error) => error.statusCode === 400);
			await refusedUploadRemoved(fixture.name);
			const pinned = 'f'.repeat(64);
			await assert.rejects(
				uploadAndRun(fixture.name, fixture.archive, { sha256: pinned }),
				/not the f+ the request pinned/
			);
			assert.deepStrictEqual(await snapshot(Items), fixture.live);
			await refusedUploadRemoved(fixture.name);
			assert.strictEqual(readRestoreReceipt(fixture.dir).kind, 'absent');
		});

		it('fails the staged proof on a corrupted block of a secondary-index store, before the database is touched', async function () {
			const fixture = await seededDatabase();
			const Items = getDatabases()[fixture.name].Items;
			const { stagingDir } = await stageArchive(Readable.from([fixture.archive]), {
				databaseName: fixture.name,
				databaseDir: fixture.dir,
				blobRoots: getBlobPathsForDatabaseName(fixture.name),
				acceptIncompatible: false,
				restoredFrom: 'upload',
			});
			const { engine } = partsOf(stagingDir);
			// a table file names its column family in its properties block
			const indexTables = filesUnder(engine.staged, (path) => path.endsWith('.sst')).filter((path) => {
				const contents = readFileSync(path);
				// the catalogue's table file holds the index's name as a key, and names its own family
				return contents.includes('Items/label') && !contents.includes('__dbis__');
			});
			assert.strictEqual(indexTables.length, 1, 'precondition: the index store is in a table file of its own');
			const contents = readFileSync(indexTables[0]);
			// the first data block starts the file; the primary store never reads it
			contents[8] ^= 0xff;
			writeFileSync(indexTables[0], contents);

			await assert.rejects(
				restoreStagedArchive(
					{
						databaseName: fixture.name,
						databaseDir: fixture.dir,
						stagingId: basename(stagingDir),
						acceptUnverifiedBlobs: false,
					},
					() => assert.fail('a failed proof publishes nothing')
				),
				// the store scan finds it, unless the engine's own flush or compaction reads the block first
				/could not read its store 'Items\/label'|block checksum mismatch/
			);
			assert.deepStrictEqual(stagingLeft(fixture.name), [], 'a failed proof removes its staging');
			assert.deepStrictEqual(await snapshot(Items), fixture.live, 'the target was never closed');
		});

		it('reads a column family no table opens, and fails the proof when that family is damaged', async function () {
			const fixture = await seededDatabase();
			const Items = getDatabases()[fixture.name].Items;
			// what a table drop that never finished leaves: a family the catalogue no longer names
			const leftover = openRocksDatabase(Items.primaryStore.rootStore.path, { name: 'leftover_family' });
			for (let i = 0; i < 100; i++) leftover.putSync(`leftover-${i}`, { i });
			await leftover.flush();
			leftover.close();
			const archive = await archiveOf(Items, fixture.name);
			const stage = () =>
				stageArchive(Readable.from([archive]), {
					databaseName: fixture.name,
					databaseDir: fixture.dir,
					blobRoots: getBlobPathsForDatabaseName(fixture.name),
					acceptIncompatible: false,
					restoredFrom: 'upload',
				});

			const whole = await stage();
			await runRestoreChild('prove-staged', { stagingDir: whole.stagingDir, databaseName: fixture.name });
			const proven = readStagedRecord(whole.stagingDir);
			assert.strictEqual(proven.state, 'proven');
			assert.ok(proven.evidence.stores_read.includes('leftover_family'), JSON.stringify(proven.evidence.stores_read));
			assert.ok(proven.evidence.stores_read.includes('Items/label'), 'and the index store');
			for (const area of stagingLeft(fixture.name)) rmSync(area, { recursive: true, force: true });

			const damaged = await stage();
			const { engine } = partsOf(damaged.stagingDir);
			const familyTables = filesUnder(engine.staged, (path) => path.endsWith('.sst')).filter((path) =>
				readFileSync(path).includes('leftover_family')
			);
			assert.strictEqual(familyTables.length, 1, 'precondition: the family is in a table file of its own');
			const contents = readFileSync(familyTables[0]);
			contents[8] ^= 0xff;
			writeFileSync(familyTables[0], contents);
			await assert.rejects(
				runRestoreChild('prove-staged', { stagingDir: damaged.stagingDir, databaseName: fixture.name }),
				// RocksDB itself may meet the damaged block first, when the proof's stamp flushes on close
				/could not read its store 'leftover_family'|block checksum mismatch/
			);
			for (const area of stagingLeft(fixture.name)) rmSync(area, { recursive: true, force: true });
		});

		it('proves the staged blobs, never the live blob roots', async function () {
			const fixture = await seededDatabase();
			const liveRoot = getBlobPathsForDatabaseName(fixture.name)[0];
			const { stagingDir } = await stageArchive(Readable.from([fixture.archive]), {
				databaseName: fixture.name,
				databaseDir: fixture.dir,
				blobRoots: getBlobPathsForDatabaseName(fixture.name),
				acceptIncompatible: false,
				restoredFrom: 'upload',
			});
			const { blobs } = partsOf(stagingDir);
			const stagedBlob = filesUnder(blobs[0].staged, () => true)[0];
			// the live root lacks the file the archive references, so a proof reading the live roots fails
			rmSync(join(liveRoot, relative(blobs[0].staged, stagedBlob)), { force: true });
			const before = filesUnder(liveRoot, () => true).map((path) => [
				path,
				statSync(path).mtimeMs,
				readFileSync(path).toString('base64'),
			]);

			await runRestoreChild('prove-staged', { stagingDir, databaseName: fixture.name });

			const proven = readStagedRecord(stagingDir);
			assert.strictEqual(proven.state, 'proven');
			assert.strictEqual(proven.evidence.blobs.blob_integrity, 'verified');
			assert.ok(proven.evidence.blobs.references > 0);
			const after = filesUnder(liveRoot, () => true).map((path) => [
				path,
				statSync(path).mtimeMs,
				readFileSync(path).toString('base64'),
			]);
			assert.deepStrictEqual(after, before, 'the live blob root is byte-for-byte untouched');
			for (const area of stagingLeft(fixture.name)) rmSync(area, { recursive: true, force: true });
		});

		it('reports a failed staged proof as the archive, which has replaced nothing yet', async function () {
			const fixture = await seededDatabase();
			const { stagingDir } = await stageArchive(Readable.from([fixture.archive]), {
				databaseName: fixture.name,
				databaseDir: fixture.dir,
				blobRoots: getBlobPathsForDatabaseName(fixture.name),
				acceptIncompatible: false,
				restoredFrom: 'upload',
			});
			const { blobs } = partsOf(stagingDir);
			rmSync(filesUnder(blobs[0].staged, () => true)[0]);

			await assert.rejects(runRestoreChild('prove-staged', { stagingDir, databaseName: fixture.name }), (error) => {
				assert.strictEqual(error.statusCode, 409);
				assert.match(
					error.message,
					/^The extracted \S+ database references blob files the archive does not contain .*to restore it anyway$/
				);
				return true;
			});
			for (const area of stagingLeft(fixture.name)) rmSync(area, { recursive: true, force: true });
		});

		it('refuses up front, with 507, an upload larger than the space beside the database', async function () {
			const fixture = await seededDatabase();
			const payload = Readable.from([fixture.archive]);
			payload.requestContentLength = 2 ** 60;
			await assert.rejects(
				restoreBackupFromUpload({ ...SU, database: fixture.name, payload }, () => assert.fail('nothing is queued')),
				(error) => error.statusCode === 507 && /more than the \d+ this restore may use/.test(error.message)
			);
			assert.strictEqual(payload.readableDidRead, false, 'not a byte of it was read');
			await refusedUploadRemoved(fixture.name);
		});

		it('answers a refused upload before its staging is removed, and admits the next once it is', async function () {
			const fixture = await seededDatabase();
			let openGate;
			const gate = new Promise((resolve) => (openGate = resolve));
			let removals = 0;
			const { removeStagingArea } = archiveStagingModule;
			const removal = replaceExport(archiveStagingModule, 'removeStagingArea', async (areas) => {
				removals++;
				await gate;
				return removeStagingArea(areas);
			});
			try {
				const pinned = 'f'.repeat(64);
				const refused = assert.rejects(
					uploadAndRun(fixture.name, fixture.archive, { sha256: pinned }),
					/not the f+ the request pinned/
				);
				await Promise.race([
					refused,
					new Promise((_, reject) =>
						setTimeout(() => reject(new Error('the refusal waited for its staging to be removed')), 20000)
					),
				]);
				assert.strictEqual(removals, 1);
				assert.notDeepStrictEqual(stagingLeft(fixture.name), [], 'precondition: the removal is still pending');
				await assert.rejects(uploadAndRun(fixture.name, fixture.archive), (error) => error.statusCode === 409);
			} finally {
				openGate();
				removal();
			}
			await refusedUploadRemoved(fixture.name);
			const { result } = await uploadAndRun(fixture.name, fixture.archive);
			assert.strictEqual(result.restored_from, 'upload');
		});

		it('charges an admission with the archives staged since the quota report, until they are removed', async function () {
			const fixture = await seededDatabase();
			const stage = () =>
				stageArchive(Readable.from([fixture.archive]), {
					databaseName: fixture.name,
					databaseDir: fixture.dir,
					blobRoots: getBlobPathsForDatabaseName(fixture.name),
					acceptIncompatible: false,
					restoredFrom: 'upload',
				});
			const { record } = await stage();
			const payload = record.archive.payload_bytes;
			for (const area of stagingLeft(fixture.name)) rmSync(area, { recursive: true, force: true });
			const quotaReport = join(env.get('rootPath'), 'quota-status.json');
			const quotaBytes = 64 * 1024 ** 3;
			const reserve = Math.floor(quotaBytes * 0.05);
			// room for one extraction and a half
			const usedBytes = quotaBytes - reserve - Math.floor(payload * 1.5);
			const report = (updatedAt) => writeFileSync(quotaReport, JSON.stringify({ usedBytes, quotaBytes, updatedAt }));
			const before = Date.now() - 1000;
			report(before);
			try {
				await stage();
				// the report predates the first archive, so it cannot count it
				await assert.rejects(stage(), (error) => error.statusCode === 507);
				// a report taken since counts it
				report(Date.now());
				await stage();
				report(before);
				await assert.rejects(stage(), (error) => error.statusCode === 507);
				// removed archives no longer occupy the quota
				for (const area of stagingLeft(fixture.name)) rmSync(area, { recursive: true, force: true });
				await stage();
			} finally {
				rmSync(quotaReport, { force: true });
				for (const area of stagingLeft(fixture.name)) rmSync(area, { recursive: true, force: true });
			}
		});

		it('refuses a second upload while one is being extracted, before reading it', async function () {
			const fixture = await seededDatabase();
			const release = await acquireExtractionLock(mintStagingId(), []);
			try {
				const payload = Readable.from([fixture.archive]);
				await assert.rejects(
					restoreBackupFromUpload({ ...SU, database: fixture.name, payload }, () => assert.fail('nothing is queued')),
					(error) => error.statusCode === 409
				);
			} finally {
				release();
			}
			assert.deepStrictEqual(stagingLeft(fixture.name), []);
		});
	});

	describe('an interrupted archive restore', function () {
		/**
		 * Runs an upload whose child installs only the database directory and then dies, as a crash between
		 * the renames would leave it: the marker is published, the old generation is moved aside, the engine
		 * part is installed, and the blob root is still staged.
		 */
		async function interruptAfterEnginePart(fixture) {
			const restoreRunner = replaceExport(
				restoreChildRunnerModule,
				'runRestoreChild',
				async (command, args, options) => {
					if (command !== 'apply-and-prove') return runRestoreChild(command, args, options);
					options.beforeDestruction();
					const { engine } = partsOf(args.stagingDir);
					renameSync(engine.destination, engine.previous);
					renameSync(engine.staged, engine.destination);
					throw new Error('The restore child running apply-and-prove exited on SIGKILL without a result');
				}
			);
			try {
				await assert.rejects(
					uploadAndRun(fixture.name, fixture.archive),
					// a status, so the CLI prints the guidance alone and not a stack trace of its wrapper
					(error) => error.statusCode === 500 && /resume=true/.test(error.message)
				);
			} finally {
				restoreRunner();
			}
		}

		it('is finished by resume=true from its staging, with no upload, and refuses a new restore meanwhile', async function () {
			const fixture = await seededDatabase();
			await createBackup({ database: fixture.name });
			await interruptAfterEnginePart(fixture);
			const receipt = receiptOf(fixture.dir);
			assert.deepStrictEqual(
				{ state: receipt.state, route: receipt.route, version: receipt.version, kind: receipt.source_kind },
				{ state: 'applying', route: 'online', version: 2, kind: 'staged_tree' }
			);
			assert.strictEqual(restoreMarkerPresent(fixture.dir), true);
			assert.strictEqual(loadedItems(fixture.name), undefined, 'the half-swapped database stays blocked');
			assert.notDeepStrictEqual(stagingLeft(fixture.name), [], 'the receipt keeps its staging');

			await assert.rejects(
				uploadAndRun(fixture.name, fixture.archive),
				(error) => error.statusCode === 409 && /resume=true/.test(error.message) && /cancel=true/.test(error.message)
			);
			await assert.rejects(requestRestore(fixture.name, {}), (error) => error.statusCode === 409);
			// a restart resume that finds it, as one routed before the record changed would, leaves it alone
			await assert.rejects(resumeRestartRestore(fixture.name, fixture.dir, 'job'), (error) => error.statusCode === 404);
			assert.strictEqual(receiptOf(fixture.dir).route, 'online');

			const { result } = await requestRestore(fixture.name, { resume: true });

			assert.strictEqual(result.restored_from, 'upload');
			assert.deepStrictEqual(await snapshot(loadedItems(fixture.name)), fixture.archived);
			assert.strictEqual(readRestoreReceipt(fixture.dir).kind, 'absent');
			assert.strictEqual(restoreMarkerPresent(fixture.dir), false);
			assert.deepStrictEqual(stagingLeft(fixture.name), []);
		});

		it('tells the job its process left unfinished to resume or cancel, not that its outcome is unknown', async function () {
			const fixture = await seededDatabase();
			await interruptAfterEnginePart(fixture);
			const jobId = receiptOf(fixture.dir).job_id;

			// the process having died mid-swap, the next boot: recovery keeps the record, then the sweep runs
			await boot(fixture.name);
			await reconcileInterruptedJobs();

			const job = await jobTable().get(jobId);
			assert.strictEqual(job.status, JOB_STATUS_ENUM.ERROR);
			assert.ok(
				job.message.endsWith(
					`exited before it finished. Its restore of database '${fixture.name}' from an archive is unfinished: finish it with restore_backup database=${fixture.name} resume=true, or withdraw it with cancel=true.`
				),
				job.message
			);
			assert.doesNotMatch(job.message, /outcome is unknown/);

			await requestRestore(fixture.name, { resume: true });
			assert.strictEqual(readRestoreReceipt(fixture.dir).kind, 'absent');
		});

		/**
		 * An upload whose job worker died after claiming the target and before its child announced the purge:
		 * the receipt names the proven staging, nothing is replaced and no marker is published.
		 */
		async function claimThenDie(fixture) {
			const jobId = await seedJob();
			const { stagingDir } = await stageArchive(Readable.from([fixture.archive]), {
				databaseName: fixture.name,
				databaseDir: fixture.dir,
				blobRoots: getBlobPathsForDatabaseName(fixture.name),
				acceptIncompatible: false,
				restoredFrom: 'upload',
			});
			await restoreStagedArchive(
				{
					databaseName: fixture.name,
					databaseDir: fixture.dir,
					stagingId: basename(stagingDir),
					acceptUnverifiedBlobs: false,
				},
				async (staged) => {
					const lock = acquireRestoreLock(fixture.dir);
					try {
						writeRestoreReceipt(lock, {
							...newRestoreReceipt({
								route: 'online',
								state: 'applying',
								database: fixture.name,
								database_path: fixture.dir,
								source_database: fixture.name,
								backup_dir: backupDirForDatabase(fixture.name),
								source_kind: 'staged_tree',
								staging_dir: staged.stagingDir,
								restored_from: staged.restoredFrom,
								archive_sha256: staged.archiveSha256,
								job_id: jobId,
								options: { accept_unverified_blobs: false, accept_incompatible_backup: false },
							}),
							attempts: 1,
						});
					} finally {
						releaseRestoreLock(lock);
					}
				}
			);
			return jobId;
		}

		it('keeps its record and staging when a resume stops before replacing anything, so it can be resumed again', async function () {
			const fixture = await seededDatabase();
			const jobId = await claimThenDie(fixture);
			assert.strictEqual(restoreMarkerPresent(fixture.dir), false);

			assert.strictEqual(await settleAbandonedJob(jobId), true);
			const job = await jobTable().get(jobId);
			assert.ok(
				job.message.endsWith(
					`its worker thread exited before it finished. Its restore of database '${fixture.name}' from an archive stopped before replacing anything: finish it with restore_backup database=${fixture.name} resume=true, or withdraw it with cancel=true, as the next Harper startup also does.`
				),
				job.message
			);

			const restoreRunner = replaceExport(
				restoreChildRunnerModule,
				'runRestoreChild',
				async (command, args, options) => {
					if (command !== 'apply-and-prove') return runRestoreChild(command, args, options);
					// the marker reaches the disk and its flush fails, so destruction is never announced
					markRestoreDestructive({ dbPath: fixture.dir });
					throw new Error('refused before the purge');
				}
			);
			try {
				await assert.rejects(
					requestRestore(fixture.name, { resume: true }),
					(error) =>
						error.statusCode === 500 &&
						error.message.endsWith(
							'resume=true tries again, and the next Harper startup withdraws it): refused before the purge'
						)
				);
			} finally {
				restoreRunner();
			}

			const kept = receiptOf(fixture.dir);
			assert.deepStrictEqual(
				{ state: kept.state, attempts: kept.attempts, last_error: kept.last_error },
				{ state: 'applying', attempts: 2, last_error: 'refused before the purge' }
			);
			assert.strictEqual(restoreMarkerPresent(fixture.dir), false);
			assert.notDeepStrictEqual(stagingLeft(fixture.name), [], 'the record keeps its staging');
			assert.strictEqual(
				loadedItems(fixture.name),
				undefined,
				'which still reserves the database, as before the resume'
			);

			const { result } = await requestRestore(fixture.name, { resume: true });

			assert.strictEqual(result.restored_from, 'upload');
			assert.deepStrictEqual(await snapshot(loadedItems(fixture.name)), fixture.archived);
			assert.strictEqual(readRestoreReceipt(fixture.dir).kind, 'absent');
			assert.deepStrictEqual(stagingLeft(fixture.name), []);
		});

		it('still tells that job after a resume with Harper stopped, which has no job of its own, fails too', async function () {
			const fixture = await seededDatabase();
			await interruptAfterEnginePart(fixture);
			const jobId = receiptOf(fixture.dir).job_id;
			await closeDatabase(fixture.name);
			const restoreRunner = replaceExport(
				restoreChildRunnerModule,
				'runRestoreChild',
				async (command, args, options) => {
					if (command !== 'apply-and-prove') return runRestoreChild(command, args, options);
					throw new Error('the blob root is still read-only');
				}
			);
			try {
				await assert.rejects(resumeArchiveRestoreOffline(fixture.name), /\(restore_backup resume=true to recover\)/);
			} finally {
				restoreRunner();
			}
			const kept = receiptOf(fixture.dir);
			assert.deepStrictEqual({ route: kept.route, job: kept.job_id }, { route: 'offline', job: undefined });
			await assert.rejects(
				uploadAndRun(fixture.name, fixture.archive),
				(error) => error.statusCode === 409 && error.message.includes(`job ${jobId}`)
			);

			await boot(fixture.name);
			await reconcileInterruptedJobs();

			const job = await jobTable().get(jobId);
			assert.ok(
				job.message.endsWith(
					`is unfinished: finish it with restore_backup database=${fixture.name} resume=true, or withdraw it with cancel=true.`
				),
				job.message
			);

			await resumeArchiveRestoreOffline(fixture.name);
			assert.deepStrictEqual(await snapshot(loadedItems(fixture.name)), fixture.archived);
			assert.strictEqual(readRestoreReceipt(fixture.dir).kind, 'absent');
		});

		it('after a cancel, is taken over by the next restore, which removes its staging when it publishes', async function () {
			const fixture = await seededDatabase();
			await createBackup({ database: fixture.name });
			await interruptAfterEnginePart(fixture);
			const { result: cancelled } = await requestRestore(fixture.name, { cancel: true });
			assert.strictEqual(cancelled.result.still_blocked, true);
			const abandoned = receiptOf(fixture.dir);
			assert.strictEqual(abandoned.state, 'terminal');
			await assert.rejects(
				requestRestore(fixture.name, { resume: true }),
				(error) => error.statusCode === 404 && /no archive restore was interrupted/.test(error.message)
			);
			const left = stagingLeft(fixture.name);
			assert.notDeepStrictEqual(left, [], 'the terminal receipt keeps its staging');

			let inherited;
			const restoreRunner = replaceExport(
				restoreChildRunnerModule,
				'runRestoreChild',
				async (command, args, options) => {
					if (command === 'apply-and-prove') inherited = receiptOf(fixture.dir).superseded_staging_dirs;
					return runRestoreChild(command, args, options);
				}
			);
			try {
				await requestRestore(fixture.name, {});
			} finally {
				restoreRunner();
			}

			assert.deepStrictEqual(inherited, [abandoned.staging_dir]);
			assert.deepStrictEqual(
				await snapshot(loadedItems(fixture.name)),
				fixture.live,
				'the managed backup took the live state'
			);
			assert.strictEqual(readRestoreReceipt(fixture.dir).kind, 'absent');
			assert.deepStrictEqual(stagingLeft(fixture.name), [], 'the successor removed what it took over, with no restart');
		});

		it('is finished by a restart retry of the same swap after only the engine part was installed', async function () {
			const fixture = await seededDatabase();
			await requestRestoreOnRestart(fixture);
			// the first attempt installs the engine part and dies
			const restoreRunner = replaceExport(
				restoreChildRunnerModule,
				'runRestoreChild',
				async (command, args, options) => {
					if (command !== 'apply-and-prove') return runRestoreChild(command, args, options);
					options.beforeDestruction();
					const { engine } = partsOf(args.stagingDir);
					renameSync(engine.destination, engine.previous);
					renameSync(engine.staged, engine.destination);
					throw new Error('The restore child running apply-and-prove exited on SIGKILL without a result');
				}
			);
			try {
				await boot(fixture.name);
			} finally {
				restoreRunner();
			}
			assert.strictEqual(receiptOf(fixture.dir).attempts, 1);
			assert.strictEqual(restoreMarkerPresent(fixture.dir), true);

			await boot(fixture.name);

			assert.strictEqual(readRestoreReceipt(fixture.dir).kind, 'absent');
			assert.deepStrictEqual(await snapshot(loadedItems(fixture.name)), fixture.archived);
			assert.deepStrictEqual(stagingLeft(fixture.name), []);
		});
	});

	async function requestRestoreOnRestart(fixture, options = {}) {
		const outcome = await uploadAndRun(fixture.name, fixture.archive, { on_restart: true, ...options });
		assert.ok(outcome.result instanceof DeferredJobCompletion);
		return outcome;
	}

	describe('on_restart=true', function () {
		it('records a pending receipt naming the proven staging, and the next startup swaps it in', async function () {
			const fixture = await seededDatabase();
			const { jobId } = await requestRestoreOnRestart(fixture);
			const receipt = receiptOf(fixture.dir);
			assert.deepStrictEqual(
				{ route: receipt.route, state: receipt.state, kind: receipt.source_kind, source_pin_id: receipt.source_pin_id },
				{ route: 'on_restart', state: 'pending', kind: 'staged_tree', source_pin_id: undefined }
			);
			assert.strictEqual(readStagedRecord(receipt.staging_dir).state, 'proven');

			await boot(fixture.name);

			assert.deepStrictEqual(await snapshot(loadedItems(fixture.name)), fixture.archived);
			assert.strictEqual(readRestoreReceipt(fixture.dir).kind, 'absent');
			assert.deepStrictEqual(stagingLeft(fixture.name), []);
			// the rollback copy of what it replaced, in the database's own repository
			assert.ok(existsSync(join(backupDirForDatabase(fixture.name), 'meta')));
			assert.strictEqual((await jobTable().get(jobId)).status, JOB_STATUS_ENUM.COMPLETE);
		});

		it("reports the archive's database and the checks it waived, as the immediate route does", async function () {
			const fixture = await seededDatabase();
			const name = `${fixture.name}_clone`;
			databases.push(name);
			const { jobId } = await requestRestoreOnRestart({ name, archive: fixture.archive });
			const receipt = receiptOf(resolveDatabasePath(name));
			assert.strictEqual(receipt.source_database, fixture.name);
			// what accept_incompatible_backup records when it admits a manifest from a newer major
			const waived = ['archive schema 99 is newer than this Harper reads'];
			writeStagedRecord(receipt.staging_dir, { ...readStagedRecord(receipt.staging_dir), waived });

			await boot(name);

			const job = await jobTable().get(jobId);
			assert.strictEqual(job.status, JOB_STATUS_ENUM.COMPLETE);
			assert.strictEqual(job.result.source_database, fixture.name);
			assert.deepStrictEqual(job.result.compatibility_waived, waived);
			assert.deepStrictEqual(await snapshot(loadedItems(name)), fixture.archived);
		});

		it('is withdrawn whole by cancel=true before it began, staging included', async function () {
			const fixture = await seededDatabase();
			await requestRestoreOnRestart(fixture, { retain_previous: false });
			assert.notDeepStrictEqual(stagingLeft(fixture.name), []);
			await requestRestore(fixture.name, { cancel: true });
			assert.strictEqual(readRestoreReceipt(fixture.dir).kind, 'absent');
			assert.deepStrictEqual(stagingLeft(fixture.name), []);
			assert.deepStrictEqual(await snapshot(loadedItems(fixture.name)), fixture.live);
		});
	});

	describe('offline', function () {
		it('stages, proves and publishes an archive file with Harper stopped', async function () {
			const fixture = await seededDatabase();
			const file = join(scratch, `${fixture.name}.tar.gz`);
			writeFileSync(file, fixture.archive);
			await closeDatabase(fixture.name);
			const result = await restoreArchiveOffline({ database: fixture.name }, file);
			assert.strictEqual(result.restored_from, file);
			assert.strictEqual(result.restored_to, fixture.dir);
			assert.deepStrictEqual(await snapshot(loadedItems(fixture.name)), fixture.archived);
			assert.deepStrictEqual(stagingLeft(fixture.name), []);
		});

		it('reports an archive file it cannot open as the archive, leaving no staging', async function () {
			if (process.platform === 'win32' || process.getuid?.() === 0) this.skip();
			const fixture = await seededDatabase();
			const file = join(scratch, `${fixture.name}-unreadable.tar.gz`);
			writeFileSync(file, fixture.archive, { mode: 0 });
			await closeDatabase(fixture.name);
			await assert.rejects(
				restoreArchiveOffline({ database: fixture.name }, file),
				(error) => error.statusCode === 400 && /Cannot read the archive '.*': EACCES/.test(error.message)
			);
			assert.deepStrictEqual(stagingLeft(fixture.name), []);
		});
	});

	describe('request validation', function () {
		const refusals = [
			[{ backup_id: 1 }, /names a managed backup/],
			[{ immutable_source: true }, /applies to a backup repository/],
			[{ target_database: 'other' }, /omit 'target_database'/],
			[{ allow_engine_only: true }, /omit 'allow_engine_only'/],
			[{ resume: true }, /without an archive/],
			[{ cancel: true }, /without an archive/],
			[{ sha256: 'abc' }, /64 hexadecimal/],
			[{ retain_previous: false }, /applies only with 'on_restart'/],
			[{ database: 'system' }, /stop the server and run: harper restore_backup database=system file=<archive>$/],
		];
		for (const [fields, refusal] of refusals) {
			it(`refuses ${JSON.stringify(fields)} before reading the upload`, async function () {
				const payload = Readable.from([Buffer.from('never read')]);
				await assert.rejects(
					restoreBackupFromUpload({ ...SU, database: 'refused', ...fields, payload }, () =>
						assert.fail('nothing is queued')
					),
					refusal
				);
				assert.strictEqual(payload.readableDidRead, false);
			});
		}

		it('refuses a sha256 on a request that uploads no archive, which would check nothing', async function () {
			const sha256 = 'a'.repeat(64);
			for (const fields of [{}, { backup_id: 1 }, { on_restart: true }, { resume: true }, { cancel: true }]) {
				const request = { ...SU, operation: 'restore_backup', database: 'refused', sha256, ...fields };
				await assert.rejects(validateRestoreBackup(request), /this request uploads none/, JSON.stringify(fields));
				await assert.rejects(restoreBackup(request), /this request uploads none/, JSON.stringify(fields));
			}
		});

		it('refuses a database in the legacy LMDB layout, a directory of per-table files, online and offline', async function () {
			const name = `restore_archive_legacy_${process.pid}`;
			const dir = resolveDatabasePath(name);
			require('node:fs').mkdirSync(dir, { recursive: true });
			writeFileSync(join(dir, 'Items.mdb'), 'lmdb');
			try {
				const payload = Readable.from([Buffer.from('never read')]);
				await assert.rejects(
					restoreBackupFromUpload({ ...SU, database: name, payload }, () => assert.fail('nothing is queued')),
					/uses the LMDB storage engine/
				);
				assert.strictEqual(payload.readableDidRead, false);
				const file = join(scratch, `${name}.tar.gz`);
				writeFileSync(file, 'never read');
				await assert.rejects(restoreArchiveOffline({ database: name }, file), /uses the LMDB storage engine/);
				assert.ok(existsSync(join(dir, 'Items.mdb')), 'nothing was replaced');
			} finally {
				rmSync(dir, { recursive: true, force: true });
			}
		});

		it('refuses a caller that is not a super user, and a payload that is not an upload', async function () {
			await assert.rejects(
				restoreBackupFromUpload(
					{ hdb_user: { role: { permission: {} } }, database: 'x', payload: Readable.from([]) },
					() => assert.fail('nothing is queued')
				),
				(error) => error.statusCode === 403
			);
			await assert.rejects(
				restoreBackupFromUpload({ ...SU, database: 'x', payload: 'aGVsbG8=' }, () => assert.fail('nothing is queued')),
				/multipart upload/
			);
		});

		it('refuses a staging_id from a client on every path, and a queued one that names no staging', async function () {
			const { operation_function } = getOperationFunction({ operation: 'restore_backup' });
			await assert.rejects(
				operation_function({ ...SU, operation: 'restore_backup', database: 'x', staging_id: mintStagingId() }),
				/set by the server/
			);
			await assert.rejects(
				operation_function({
					...SU,
					operation: 'restore_backup',
					database: 'x',
					staging_id: mintStagingId(),
					payload: Readable.from([]),
				}),
				/set by the server/
			);
			await assert.rejects(
				validateRestoreBackup({ ...SU, operation: 'restore_backup', database: 'x', staging_id: mintStagingId() }),
				(error) => error.statusCode === 410
			);
			await assert.rejects(
				validateRestoreBackup({ ...SU, operation: 'restore_backup', database: 'x', staging_id: '../../etc' }),
				/does not name a staged archive/
			);
		});
	});
});
