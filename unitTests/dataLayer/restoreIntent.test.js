'use strict';

const testUtils = require('../testUtils');
testUtils.preTestPrep();

const assert = require('node:assert');
const { randomBytes, randomUUID } = require('node:crypto');
const { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } = require('node:fs');

const { dirname, join } = require('node:path');
const { writeUnsupportedTableFormat } = require('./fixtures/backupFiles.js');
const { tryFileLock, fileLockRelease } = require('../rocksdbBindings.mts').rocksdbBindings();
const env = require('#src/utility/environment/environmentManager');
const { CONFIG_PARAMS, JOB_STATUS_ENUM, SYSTEM_TABLE_NAMES } = require('#src/utility/hdbTerms');
const {
	closeDatabase,
	database,
	getDatabases,
	resetDatabases,
	resolveDatabasePath,
	table,
} = require('#src/resources/databases');
const { createBlob, getBlobPathsForDatabaseName } = require('#src/resources/blob');
const { setAnalyticsEnabled } = require('#src/resources/analytics/write');
const { setMainIsWorker } = require('#src/server/threads/manageThreads');
const {
	backupDirForDatabase,
	cancelRestartRestoreOffline,
	createBackup,
	createPreRestoreBackup,
	deleteBackupOffline,
	listBackups,
	listBackupsInDir,
	purgeBackupsOffline,
	restoreBackup,
	restoreBackupOffline,
	validateRestoreBackup,
} = require('#src/dataLayer/rocksdbBackup');
const backupManifestModule = require('#js/dataLayer/backupManifest');
const { readBackupManifest, writeBackupManifest } = backupManifestModule;
const blobBackupModule = require('#js/dataLayer/blobBackup');
const { blobSnapshotDir, fsyncTree } = blobBackupModule;
const { readBackupPins } = require('#src/dataLayer/backupRepository');
const { dropSchema } = require('#src/dataLayer/schema');
const { ResourceBridge } = require('#src/dataLayer/harperBridge/ResourceBridge');
const {
	acquireRestoreLock,
	checkRestoreState,
	droppingMarkerPath,
	markRestoreDestructive,
	restoringMarkerPath,
	releaseRestoreLock,
	restoreLockHeldExclusively,
	restoreLockPath,
	restoreMarkerPresent,
	restoreSourceId,
} = require('#src/dataLayer/restoreMarker');
const restoreReceiptModule = require('#js/dataLayer/restoreReceipt');
const { readRestoreReceipt, restoreReceiptPath, writeRestoreReceipt } = restoreReceiptModule;
const {
	jobsOwnedByRestoreReceipts,
	recoverRestoresAtStartup,
	resetStartupRecoveryForTesting,
	unpublishedRestoreBlocksComponents,
} = require('#src/dataLayer/restorePublication');
const restoreChildRunnerModule = require('#js/dataLayer/restoreChildRunner');
const { restoreChildSlotLockPath, runRestoreChild } = restoreChildRunnerModule;
const { reconcileInterruptedJobs, settleAbandonedJob } = require('#src/server/jobs/jobOwnership');
const { DeferredJobCompletion } = require('#src/server/jobs/deferredJobCompletion');
const restartModule = require('#js/bin/restart');
const storageReclamationModule = require('#js/server/storageReclamation');

const describeUnlessLmdb = process.env.HARPER_STORAGE_ENGINE === 'lmdb' ? describe.skip : describe;

// The code under test reads these exports through their module objects at call time, so assigning one
// reaches it — in the compiled build only, since a source ES module's exports are read-only, which is
// why the replaced modules are required through `#js`. Returns the function that puts the original back.
function replaceExport(module, name, replacement) {
	const original = module[name];
	module[name] = replacement;
	return () => {
		module[name] = original;
	};
}

const UNCONFIRMED_REMOVAL =
	"The restore record's removal could not be confirmed durable; if a power loss brings the restore back, cancel it again with restore_backup cancel=true";
const SU = { hdb_user: { username: 'admin', role: { permission: { super_user: true } } } };
const BLOB_BYTES = 20000; // over the file-storage threshold, so the blob lives in a blob root

describeUnlessLmdb('restore_backup on_restart', function () {
	this.timeout(180000);
	let sequence = 0;
	const databases = [];
	const seededJobs = [];
	const testDirs = [];
	let savedSafeMode;

	before(async function () {
		testUtils.setupTestDBPath();
		setMainIsWorker(true);
		// An analytics flush declares its table, and the rescan that follows reopens every database under
		// the storage path, including one a test has just closed to stand in for a restarted process.
		setAnalyticsEnabled(false);
		await testUtils.ensureSystemTables();
		savedSafeMode = process.env.HARPER_SAFE_MODE;
	});

	beforeEach(function () {
		testDirs.length = 0;
	});

	afterEach(function () {
		if (savedSafeMode === undefined) delete process.env.HARPER_SAFE_MODE;
		else process.env.HARPER_SAFE_MODE = savedSafeMode;
		// what a boot's recovery recorded belongs to that boot
		resetStartupRecoveryForTesting();
		// the safe-mode decision scans every receipt, so one a failed test leaves would fail every later test
		for (const dir of testDirs) {
			rmSync(restoreReceiptPath(dir), { force: true });
			rmSync(restoringMarkerPath(dir), { force: true });
		}
	});

	after(async function () {
		setAnalyticsEnabled(true);
		for (const id of seededJobs)
			await jobTable()
				.delete(id)
				.catch(() => {});
		for (const name of databases) {
			await closeDatabase(name).catch(() => {});
			rmSync(restoreReceiptPath(resolveDatabasePath(name)), { force: true });
			for (const root of getBlobPathsForDatabaseName(name)) rmSync(root, { recursive: true, force: true });
			rmSync(backupDirForDatabase(name), { recursive: true, force: true });
		}
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

	/** Every record, with its blob's exact bytes. */
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

	/**
	 * A real Harper database — a table with an index and a file-backed blob, written through the Table
	 * API — backed up through create_backup, then changed so the live state differs from every backup in
	 * every record.
	 */
	async function seededDatabase({ backups = 1 } = {}) {
		const name = `restore_intent_${process.pid}_${++sequence}`;
		databases.push(name);
		const Items = table(definition(name));
		const backupIds = [];
		const backedUp = [];
		for (let round = 0; round < backups; round++) {
			await putWithBlob(Items, 'a', `backed-up-${round}`, randomBytes(BLOB_BYTES));
			await Items.put({ id: `only-in-backup-${round}`, label: `backed-up-${round}` });
			await Items.primaryStore.rootStore.flush();
			backedUp.push(await snapshot(Items));
			backupIds.push((await createBackup({ database: name })).backup_id);
		}
		await putWithBlob(Items, 'a', 'live', randomBytes(BLOB_BYTES));
		for (let round = 0; round < backups; round++) await Items.delete(`only-in-backup-${round}`);
		await Items.put({ id: 'only-live', label: 'live' });
		await Items.primaryStore.rootStore.flush();
		const live = await snapshot(Items);
		testDirs.push(resolveDatabasePath(name));
		return {
			name,
			dir: resolveDatabasePath(name),
			backupDir: backupDirForDatabase(name),
			backupIds,
			backedUp,
			live,
		};
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
	async function requestRestore(name, options = {}) {
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

	/** What a restarted process looks like to the hook: nothing holds the database, and the latch is fresh. */
	async function boot(name) {
		await closeDatabase(name);
		resetStartupRecoveryForTesting();
		return recoverRestoresAtStartup();
	}

	/** Whether the ordinary loader, rescanning, opens the database — and its Items table if it does. */
	function loadedItems(name) {
		resetDatabases();
		return getDatabases()[name]?.Items;
	}

	/** What this thread serves now, with no rescan: what stays loaded until something reloads it. */
	function servedItems(name) {
		return getDatabases()[name]?.Items;
	}

	function receiptOf(dir) {
		const read = readRestoreReceipt(dir);
		assert.strictEqual(read.kind, 'valid', `expected a readable receipt, found ${JSON.stringify(read)}`);
		return read.receipt;
	}

	async function job(id) {
		return jobTable().get(id);
	}

	function pinsOf(fixture) {
		return readBackupPins(fixture.backupDir).map(({ pin_id, backup_id }) => ({ pin_id, backup_id }));
	}

	/** Makes a backup fail verification (a table format this build cannot open); returns the undo. */
	function breakBackup(fixture, backupId) {
		const saved = new Map();
		for (const name of readdirSync(join(fixture.backupDir, 'shared_checksum'))) {
			const path = join(fixture.backupDir, 'shared_checksum', name);
			saved.set(path, readFileSync(path));
		}
		const metaPath = join(fixture.backupDir, 'meta', String(backupId));
		saved.set(metaPath, readFileSync(metaPath));
		writeUnsupportedTableFormat(fixture.backupDir, backupId);
		return () => {
			for (const [path, contents] of saved) writeFileSync(path, contents);
		};
	}

	/**
	 * A backup whose catalogue declares an index it has no column family for: it verifies, so the restore
	 * gets past its purge, and the proof refuses it there. The live database keeps its sound catalogue.
	 */
	async function unprovableBackup(fixture) {
		const catalogue = database({ database: fixture.name, table: 'Items' }).dbisDb;
		catalogue.putSync('Items/unbacked', { name: 'unbacked', indexed: true });
		try {
			return (await createBackup({ database: fixture.name })).backup_id;
		} finally {
			catalogue.removeSync('Items/unbacked');
		}
	}

	/**
	 * Makes every receipt write for this database fail, as a real write does: a directory sits where the
	 * write opens its temp file. Returns the undo.
	 */
	function failReceiptWrites(fixture) {
		const tempPath = `${restoreReceiptPath(fixture.dir)}-tmp`;
		mkdirSync(join(tempPath, 'occupied'), { recursive: true });
		return () => rmSync(tempPath, { recursive: true, force: true });
	}

	/**
	 * Makes a receipt write or removal for this database that `when(receipt)` picks take effect and then throw, as
	 * one does when the directory flush after its rename or unlink fails. Returns the undo.
	 */
	function flushFailsAfter(fixture, name, when = () => true) {
		const original = restoreReceiptModule[name];
		return replaceExport(restoreReceiptModule, name, (lock, ...args) => {
			const result = original(lock, ...args);
			if (lock.dbPath === fixture.dir && when(...args)) {
				throw Object.assign(new Error('EIO: i/o error, fsync'), { code: 'EIO' });
			}
			return result;
		});
	}

	/** The receipt as a crash at a later transition would have left it, written under the target's lock. */
	function rewriteReceipt(dir, fields, { marker = false } = {}) {
		const lock = acquireRestoreLock(dir);
		try {
			const current = receiptOf(dir);
			lock.source = restoreSourceId(current.backup_dir);
			if (marker) markRestoreDestructive(lock);
			return writeRestoreReceipt(lock, { ...current, ...fields });
		} finally {
			releaseRestoreLock(lock);
		}
	}

	describe('request', function () {
		it('records a pending receipt and a pin that outlives the restart, and defers the job', async function () {
			const fixture = await seededDatabase();
			const [backupId] = fixture.backupIds;
			const { jobId, result } = await requestRestore(fixture.name, { on_restart: true });

			assert.ok(result instanceof DeferredJobCompletion);
			assert.strictEqual(result.owner, 'restore-intent');
			assert.strictEqual(typeof result.afterRecorded, 'function', 'the restart follows the recorded deferral');
			const receipt = receiptOf(fixture.dir);
			assert.strictEqual(result.result.operation_id, receipt.operation_id);
			assert.deepStrictEqual(
				{
					route: receipt.route,
					state: receipt.state,
					backup_id: receipt.backup_id,
					job_id: receipt.job_id,
					retain_previous: receipt.retain_previous,
					attempts: receipt.attempts,
					requested_by: receipt.requested_by,
				},
				{
					route: 'on_restart',
					state: 'pending',
					backup_id: backupId,
					job_id: jobId,
					retain_previous: true,
					attempts: 0,
					requested_by: 'admin',
				}
			);
			assert.strictEqual(receipt.source_pin_id, `restore-intent-${receipt.operation_id}`);
			assert.deepStrictEqual(pinsOf(fixture), [{ pin_id: receipt.source_pin_id, backup_id: backupId }]);
			assert.strictEqual(
				readBackupPins(fixture.backupDir)[0].database_path,
				fixture.dir,
				'the pin names the database, so it lapses with its marker'
			);
			assert.strictEqual(checkRestoreState(fixture.dir), 'pending');

			// The restarted process: no marker exists yet and nothing holds the lock, so only the receipt
			// keeps the pin live and the database out of discovery.
			await closeDatabase(fixture.name);
			assert.strictEqual(restoreMarkerPresent(fixture.dir), false);
			assert.strictEqual(loadedItems(fixture.name), undefined, 'a pending restart restore blocks discovery');
			await assert.rejects(deleteBackupOffline(fixture.name, backupId), (error) => error.statusCode === 409);
			await assert.rejects(purgeBackupsOffline(fixture.name, 0), (error) => error.statusCode === 409);
			assert.ok((await listBackupsInDir(fixture.backupDir)).some((backup) => backup.backupId === backupId));

			await restoreBackup({ ...SU, database: fixture.name, cancel: true });
		});

		it('keeps serving the open database through a rescan before the restart, and through a cancel then', async function () {
			const fixture = await seededDatabase();
			const Items = getDatabases()[fixture.name].Items;
			await requestRestore(fixture.name, { on_restart: true, retain_previous: false });

			// every thread rescans on a schema event, and one can land before the restart does
			assert.ok(loadedItems(fixture.name), 'the reservation unloaded a database this thread holds open');
			assert.strictEqual((await Items.get('a')).label, 'live');

			const { result } = await restoreBackup({ ...SU, database: fixture.name, cancel: true });

			assert.strictEqual(result.restarting, false);
			assert.match(result.message, /loads normally/);
			assert.deepStrictEqual(await snapshot(loadedItems(fixture.name)), fixture.live);
			assert.strictEqual((await Items.get('a')).label, 'live');
		});

		it('still unloads an open database whose restore record cannot be read, or whose replacement has begun', async function () {
			const unreadable = await seededDatabase();
			await requestRestore(unreadable.name, { on_restart: true, retain_previous: false });
			writeFileSync(restoreReceiptPath(unreadable.dir), '{"version":1,"state":');
			assert.strictEqual(loadedItems(unreadable.name), undefined, 'what it reserves, or for whom, is unknown');
			await restoreBackup({ ...SU, database: unreadable.name, cancel: true });

			const begun = await seededDatabase();
			await requestRestore(begun.name, { on_restart: true, retain_previous: false });
			rewriteReceipt(begun.dir, { state: 'applying', attempts: 1 }, { marker: true });
			assert.strictEqual(loadedItems(begun.name), undefined, 'a marker means the directory may be partial');
		});

		it('asks for a drained restart once the job row records the deferral', async function () {
			const fixture = await seededDatabase();
			// a real restart would tear this process down
			const restarts = [];
			const restoreRestart = replaceExport(restartModule, 'restart', async (...args) => {
				restarts.push(args);
			});
			try {
				const { result } = await requestRestore(fixture.name, { on_restart: true, retain_previous: false });
				assert.deepStrictEqual(restarts, [], 'not before the job row says where the job went');

				result.afterRecorded();

				assert.deepStrictEqual(restarts, [[{ operation: 'restart', drain: true }]]);
			} finally {
				restoreRestart();
			}
			await restoreBackup({ ...SU, database: fixture.name, cancel: true });
		});

		it('keeps a job worker exit from settling a job its receipt still owns, and settles one no receipt names', async function () {
			const fixture = await seededDatabase();
			const { jobId } = await requestRestore(fixture.name, { on_restart: true, retain_previous: false });
			assert.strictEqual(await settleAbandonedJob(jobId), false, 'the pending receipt owns the job');
			assert.strictEqual((await job(jobId)).status, JOB_STATUS_ENUM.IN_PROGRESS);

			// a crash between the receipt and the row, then a cancel: the row says deferred, but nothing owns it
			const orphan = await seedJob();
			assert.strictEqual(await settleAbandonedJob(orphan), true);
			assert.strictEqual((await job(orphan)).status, JOB_STATUS_ENUM.ERROR);
			await restoreBackup({ ...SU, database: fixture.name, cancel: true });
		});

		it("keeps a half-replaced target blocked and pinned when a supersede's job cannot record it", async function () {
			const fixture = await seededDatabase({ backups: 2 });
			const [first, second] = fixture.backupIds;
			await requestRestore(fixture.name, { on_restart: true, backup_id: first, retain_previous: false });
			await closeDatabase(fixture.name);
			rewriteReceipt(fixture.dir, { state: 'applying', attempts: 1 }, { marker: true });
			const { result } = await requestRestore(fixture.name, { on_restart: true, backup_id: second });
			const pinsBefore = pinsOf(fixture);

			// what the job worker runs when the row write fails
			await result.onNotRecorded();

			const kept = receiptOf(fixture.dir);
			assert.strictEqual(kept.state, 'terminal');
			assert.strictEqual(restoreMarkerPresent(fixture.dir), true);
			assert.deepStrictEqual(pinsOf(fixture), pinsBefore, 'every source stays pinned');
			assert.strictEqual(unpublishedRestoreBlocksComponents(), fixture.name);
			await restoreBackupOffline(fixture.name, first);
		});

		it('withdraws a pending restore that never began when its job cannot record it', async function () {
			const fixture = await seededDatabase();
			const { result } = await requestRestore(fixture.name, { on_restart: true, retain_previous: false });

			await result.onNotRecorded();

			assert.strictEqual(readRestoreReceipt(fixture.dir).kind, 'absent');
			assert.deepStrictEqual(pinsOf(fixture), []);
			assert.strictEqual(checkRestoreState(fixture.dir), 'clear');
		});

		it('defers the job when its receipt took effect but could not be flushed, so the job still owns the restore', async function () {
			const fixture = await seededDatabase();
			const restoreWrite = flushFailsAfter(fixture, 'writeRestoreReceipt', (receipt) => receipt.state === 'pending');
			let result;
			try {
				({ result } = await requestRestore(fixture.name, { on_restart: true, retain_previous: false }));
			} finally {
				restoreWrite();
			}

			assert.ok(result instanceof DeferredJobCompletion, 'the restore it recorded runs at the restart it asks for');
			const receipt = receiptOf(fixture.dir);
			assert.strictEqual(receipt.operation_id, result.result.operation_id);
			assert.strictEqual(receipt.state, 'pending');

			// and the deferral keeps its withdrawal, should the job row not record it
			await result.onNotRecorded();
			assert.strictEqual(readRestoreReceipt(fixture.dir).kind, 'absent');
			assert.deepStrictEqual(pinsOf(fixture), []);
		});

		it('resumes when its receipt took effect but could not be flushed, and fails when it never took effect', async function () {
			const fixture = await seededDatabase();
			await requestRestore(fixture.name, { on_restart: true, retain_previous: false });
			await closeDatabase(fixture.name);
			const stopped = rewriteReceipt(fixture.dir, { state: 'terminal', pre_terminal_state: 'pending', attempts: 3 });

			const repair = failReceiptWrites(fixture);
			try {
				await assert.rejects(requestRestore(fixture.name, { resume: true }), (error) => error.code === 'EISDIR');
			} finally {
				repair();
			}
			assert.deepStrictEqual(receiptOf(fixture.dir), stopped, 'the stopped restore is not taken for the resumed one');

			const restoreWrite = flushFailsAfter(fixture, 'writeRestoreReceipt');
			let resumed;
			try {
				resumed = await requestRestore(fixture.name, { resume: true });
			} finally {
				restoreWrite();
			}
			assert.ok(resumed.result instanceof DeferredJobCompletion);
			const receipt = receiptOf(fixture.dir);
			assert.deepStrictEqual(
				{ state: receipt.state, attempts: receipt.attempts, job_id: receipt.job_id },
				{ state: 'pending', attempts: 0, job_id: resumed.jobId }
			);
			await restoreBackup({ ...SU, database: fixture.name, cancel: true });
		});

		it('withdraws it once a momentary holder of its lock lets go, instead of leaving it to a later restart', async function () {
			const fixture = await seededDatabase();
			const { result } = await requestRestore(fixture.name, { on_restart: true, retain_previous: false });
			// what a thread opening the database, or a pin-liveness probe, holds for a moment
			let holder = tryFileLock(restoreLockPath(fixture.dir), true);
			assert.ok(holder);
			const release = () => {
				if (holder) fileLockRelease(holder);
				holder = 0;
			};
			const releaseLater = setTimeout(release, 200);
			try {
				await result.onNotRecorded();
			} finally {
				clearTimeout(releaseLater);
				release();
			}

			assert.strictEqual(readRestoreReceipt(fixture.dir).kind, 'absent');
			assert.deepStrictEqual(pinsOf(fixture), []);
		});

		it('gives up on the withdrawal at its deadline when the lock stays held, leaving the receipt to cancel', async function () {
			const fixture = await seededDatabase();
			const { result } = await requestRestore(fixture.name, { on_restart: true, retain_previous: false });
			const holder = tryFileLock(restoreLockPath(fixture.dir), true);
			assert.ok(holder);
			try {
				await result.onNotRecorded();
			} finally {
				fileLockRelease(holder);
			}

			assert.strictEqual(receiptOf(fixture.dir).state, 'pending');
			await restoreBackup({ ...SU, database: fixture.name, cancel: true });
		});

		it('restarts after withdrawing a resumed restore of a database this boot held, so it loads', async function () {
			const fixture = await seededDatabase();
			await requestRestore(fixture.name, { on_restart: true, retain_previous: false });
			const repair = failReceiptWrites(fixture);
			try {
				await boot(fixture.name);
			} finally {
				repair();
			}
			const { result } = await requestRestore(fixture.name, { resume: true });
			const restarts = [];
			const restoreRestart = replaceExport(restartModule, 'restart', async (...args) => {
				restarts.push(args);
			});
			try {
				await result.onNotRecorded();
			} finally {
				restoreRestart();
			}

			assert.strictEqual(readRestoreReceipt(fixture.dir).kind, 'absent');
			assert.deepStrictEqual(restarts, [[{ operation: 'restart', drain: true }]]);
		});

		it('still restarts after a withdrawal whose removal took effect but could not be flushed', async function () {
			const fixture = await seededDatabase();
			await requestRestore(fixture.name, { on_restart: true, retain_previous: false });
			const repair = failReceiptWrites(fixture);
			try {
				await boot(fixture.name);
			} finally {
				repair();
			}
			const { result } = await requestRestore(fixture.name, { resume: true });
			const restarts = [];
			const restoreRestart = replaceExport(restartModule, 'restart', async (...args) => {
				restarts.push(args);
			});
			const restoreRemoval = flushFailsAfter(fixture, 'removeRestoreReceipt');
			try {
				await result.onNotRecorded();
			} finally {
				restoreRemoval();
				restoreRestart();
			}

			assert.strictEqual(readRestoreReceipt(fixture.dir).kind, 'absent');
			assert.deepStrictEqual(pinsOf(fixture), []);
			assert.deepStrictEqual(restarts, [[{ operation: 'restart', drain: true }]]);
		});

		it("leaves a resumed restore to its new job when the older job's row cannot record the deferral", async function () {
			const fixture = await seededDatabase();
			const original = await requestRestore(fixture.name, { on_restart: true, retain_previous: false });
			const resumed = await requestRestore(fixture.name, { resume: true });

			await original.result.onNotRecorded();

			const kept = receiptOf(fixture.dir);
			assert.strictEqual(kept.state, 'pending');
			assert.strictEqual(kept.job_id, resumed.jobId);
			assert.deepStrictEqual(pinsOf(fixture), [{ pin_id: kept.source_pin_id, backup_id: kept.backup_id }]);
			await restoreBackup({ ...SU, database: fixture.name, cancel: true });
		});

		it('answers drop_database, create_backup and get_backup for the reserved database with the restore, not a 404', async function () {
			const fixture = await seededDatabase();
			await requestRestore(fixture.name, { on_restart: true, retain_previous: false });
			await closeDatabase(fixture.name);
			assert.strictEqual(loadedItems(fixture.name), undefined, 'precondition: reserved, so not loaded');

			for (const attempt of [
				() => dropSchema({ database: fixture.name }),
				() => createBackup({ ...SU, database: fixture.name }),
				() => new ResourceBridge().getBackup({ database: fixture.name }),
			]) {
				await assert.rejects(
					attempt(),
					(error) => error.statusCode === 409 && /reserved by a restore that has not finished/.test(error.message)
				);
			}
			assert.ok(existsSync(join(fixture.dir, 'CURRENT')), 'nothing was dropped');
			await restoreBackup({ ...SU, database: fixture.name, cancel: true });
		});

		it('refuses a database whose drop has begun, as every restore claim does', async function () {
			const fixture = await seededDatabase();
			await closeDatabase(fixture.name);
			const dropping = droppingMarkerPath(fixture.dir);
			mkdirSync(join(dropping, '..'), { recursive: true });
			writeFileSync(dropping, 'a drop in progress');
			try {
				await assert.rejects(
					requestRestore(fixture.name, { on_restart: true }),
					(error) => error.statusCode === 409 && /incomplete drop/.test(error.message)
				);
				assert.strictEqual(readRestoreReceipt(fixture.dir).kind, 'absent');
			} finally {
				rmSync(dropping, { force: true });
			}
		});

		it('names the database, never its directory, when another claim holds it', async function () {
			const fixture = await seededDatabase();
			const [backupId] = fixture.backupIds;
			const { jobId } = await requestRestore(fixture.name, { on_restart: true, retain_previous: false });
			const refusedByName = (options) =>
				assert.rejects(
					restoreBackup({ ...SU, database: fixture.name, ...options }),
					(error) => {
						assert.strictEqual(error.statusCode, 409);
						assert.strictEqual(error.name, 'BackupInProgressError');
						assert.ok(error.message.includes(`'${fixture.name}'`), error.message);
						assert.ok(!error.message.includes(fixture.dir), error.message);
						return true;
					},
					JSON.stringify(options)
				);
			let held = acquireRestoreLock(fixture.dir);
			try {
				for (const options of [{ on_restart: true, retain_previous: false }, { resume: true }, { cancel: true }]) {
					await refusedByName(options);
				}
			} finally {
				releaseRestoreLock(held);
			}
			// a committed receipt is finished before any new claim, under the same lock
			await closeDatabase(fixture.name);
			rewriteReceipt(fixture.dir, { state: 'committed', attempts: 1 }, { marker: true });
			held = acquireRestoreLock(fixture.dir);
			try {
				await refusedByName({ on_restart: true, retain_previous: false });
				await refusedByName({ backup_id: backupId });
			} finally {
				releaseRestoreLock(held);
			}
			await boot(fixture.name);
			assert.strictEqual((await job(jobId)).status, JOB_STATUS_ENUM.COMPLETE);
		});

		it('starts the boot in safe mode while a restore record cannot be read', async function () {
			const fixture = await seededDatabase();
			await requestRestore(fixture.name, { on_restart: true, retain_previous: false });
			writeFileSync(restoreReceiptPath(fixture.dir), '{"version":1,"state":');
			try {
				assert.ok(unpublishedRestoreBlocksComponents(), 'what it would have restored, or how far, is unknown');
			} finally {
				await restoreBackup({ ...SU, database: fixture.name, cancel: true });
			}
			assert.strictEqual(unpublishedRestoreBlocksComponents(), undefined);
		});

		it('refuses on a node with replication peers, recording nothing', async function () {
			const fixture = await seededDatabase();
			const nodes = getDatabases().system[SYSTEM_TABLE_NAMES.NODE_TABLE_NAME];
			await nodes.put({ name: 'restore-intent-peer' });
			try {
				await assert.rejects(
					restoreBackup({ ...SU, database: fixture.name, on_restart: true }),
					(error) => error.statusCode === 409 && /restore-intent-peer/.test(error.message)
				);
			} finally {
				await nodes.delete('restore-intent-peer');
			}
			const savedRoutes = env.get(CONFIG_PARAMS.REPLICATION_ROUTES);
			env.setProperty(CONFIG_PARAMS.REPLICATION_ROUTES, [{ hostname: 'peer.example', port: 9933 }]);
			try {
				await assert.rejects(
					restoreBackup({ ...SU, database: fixture.name, on_restart: true }),
					(error) => error.statusCode === 409 && /peer\.example/.test(error.message)
				);
			} finally {
				env.setProperty(CONFIG_PARAMS.REPLICATION_ROUTES, savedRoutes);
			}
			assert.strictEqual(readRestoreReceipt(fixture.dir).kind, 'absent');
			assert.deepStrictEqual(pinsOf(fixture), []);
			assert.strictEqual(checkRestoreState(fixture.dir), 'clear');
		});

		it('refuses option combinations that cannot mean one restore', async function () {
			const fixture = await seededDatabase();
			for (const [options, pattern] of [
				[{ resume: true, cancel: true }, /'resume' and 'cancel'/],
				[{ resume: true, backup_id: 1 }, /omit 'backup_id'/],
				[{ cancel: true, backup_id: 1 }, /omit 'backup_id'/],
				[{ resume: true, on_restart: true }, /omit 'backup_id' and 'on_restart'/],
				[{ immutable_source: true, on_restart: true }, /'immutable_source'/],
				[{ retain_previous: false }, /'retain_previous' applies only with 'on_restart'/],
				[{ target_database: `${fixture.name}_copy`, on_restart: true }, /'target_database'/],
				[{ on_restart: 'yes' }, /on_restart/],
				[{ resume: true, accept_unverified_blobs: true }, /'accept_unverified_blobs'.*on_restart=true/],
				[{ resume: true, allow_engine_only: false }, /'allow_engine_only'.*on_restart=true/],
				[{ cancel: true, accept_incompatible_backup: true }, /'cancel' takes no 'accept_incompatible_backup'/],
				[{ cancel: true, immutable_source: true }, /'immutable_source'/],
			]) {
				await assert.rejects(
					restoreBackup({ ...SU, database: fixture.name, ...options }),
					(error) => error.statusCode === 400 && pattern.test(error.message),
					JSON.stringify(options)
				);
			}
			for (const options of [{ resume: true }, { cancel: true }]) {
				await assert.rejects(
					restoreBackup({ ...SU, database: fixture.name, ...options }),
					(error) => error.statusCode === 404,
					`${JSON.stringify(options)} with no restart restore recorded`
				);
			}
			assert.strictEqual(readRestoreReceipt(fixture.dir).kind, 'absent');
		});

		it('answers resume and cancel at submission as the job would, writing nothing for a database that does not exist', async function () {
			const fixture = await seededDatabase();
			const missing = `restore_intent_missing_${process.pid}`;
			const refusal = (promise) =>
				promise.then(
					() => assert.fail('expected a refusal'),
					(error) => ({ statusCode: error.statusCode, message: error.message })
				);
			for (const options of [{ resume: true }, { cancel: true }]) {
				const atSubmission = await refusal(validateRestoreBackup({ ...SU, database: missing, ...options }));
				assert.strictEqual(atSubmission.statusCode, 404, JSON.stringify(options));
				assert.ok(atSubmission.message.includes(`'${missing}'`), atSubmission.message);
				assert.deepStrictEqual(
					await refusal(validateRestoreBackup({ ...SU, database: fixture.name, ...options })),
					await refusal(restoreBackup({ ...SU, database: fixture.name, ...options })),
					JSON.stringify(options)
				);
			}
			await assert.rejects(
				cancelRestartRestoreOffline({ database: missing, cancel: true }),
				(error) => error.statusCode === 404,
				'with Harper stopped too'
			);
			await assert.rejects(
				cancelRestartRestoreOffline({ database: fixture.name }),
				(error) => error.statusCode === 400 && /'cancel' must be true/.test(error.message)
			);
			assert.strictEqual(existsSync(restoreLockPath(resolveDatabasePath(missing))), false);
		});
	});

	describe('the startup hook', function () {
		it('takes a pre-restore backup, publishes the backup exactly, and settles the job', async function () {
			const fixture = await seededDatabase();
			const { jobId } = await requestRestore(fixture.name, { on_restart: true });
			const { operation_id: operationId } = receiptOf(fixture.dir);
			// each write replaces the receipt file, so only the writes themselves show every state it passed through
			const written = [];
			const restoreWrite = replaceExport(restoreReceiptModule, 'writeRestoreReceipt', (lock, receipt) => {
				written.push(receipt);
				return writeRestoreReceipt(lock, receipt);
			});
			let owned;
			try {
				owned = await boot(fixture.name);
			} finally {
				restoreWrite();
			}

			const states = written
				.filter((receipt) => receipt.database_path === fixture.dir)
				.map((receipt) => receipt.state)
				.filter((state, index, all) => state !== all[index - 1]);
			assert.deepStrictEqual(states, ['pending', 'applying', 'committed']);
			assert.deepStrictEqual([...owned], []);
			assert.strictEqual(readRestoreReceipt(fixture.dir).kind, 'absent');
			assert.strictEqual(restoreMarkerPresent(fixture.dir), false);
			assert.deepStrictEqual(pinsOf(fixture), [], 'the source and pre-restore pins are both released');

			const Items = loadedItems(fixture.name);
			assert.ok(Items, 'the loader opens the published database');
			assert.deepStrictEqual(await snapshot(Items), fixture.backedUp[0]);

			const settled = await job(jobId);
			assert.strictEqual(settled.status, JOB_STATUS_ENUM.COMPLETE);
			assert.strictEqual(settled.deferred_to ?? null, null);
			assert.strictEqual(settled.result.backup_id, fixture.backupIds[0]);
			const preRestoreId = settled.result.pre_restore_backup_id;
			assert.ok(Number.isInteger(preRestoreId) && preRestoreId !== fixture.backupIds[0]);
			assert.strictEqual((await readBackupManifest(fixture.backupDir, preRestoreId)).pre_restore_for, operationId);
			const listed = await listBackups({ ...SU, database: fixture.name });
			assert.ok(listed.some((backup) => backup.backup_id === preRestoreId));

			// The rollback copy is an ordinary backup now, and holds exactly what the restore replaced.
			const copy = `${fixture.name}_pre`;
			databases.push(copy);
			await restoreBackupOffline(fixture.name, preRestoreId, copy);
			assert.deepStrictEqual(await snapshot(table(definition(copy))), fixture.live);
		});

		it('takes no pre-restore backup with retain_previous=false', async function () {
			const fixture = await seededDatabase();
			const { jobId } = await requestRestore(fixture.name, { on_restart: true, retain_previous: false });
			assert.strictEqual(receiptOf(fixture.dir).retain_previous, false);

			await boot(fixture.name);

			assert.deepStrictEqual(
				(await listBackupsInDir(fixture.backupDir)).map((backup) => backup.backupId),
				fixture.backupIds
			);
			const settled = await job(jobId);
			assert.strictEqual(settled.status, JOB_STATUS_ENUM.COMPLETE);
			assert.strictEqual(settled.result.pre_restore_backup_id, undefined);
			assert.deepStrictEqual(await snapshot(loadedItems(fixture.name)), fixture.backedUp[0]);
		});

		it("flushes the rollback copy's blob snapshot before its manifest marks it complete", async function () {
			const fixture = await seededDatabase();
			await requestRestore(fixture.name, { on_restart: true });
			await closeDatabase(fixture.name);
			const { operation_id: operationId } = receiptOf(fixture.dir);
			const events = [];
			const restoreFsync = replaceExport(blobBackupModule, 'fsyncTree', async (root) => {
				events.push(['fsync', root]);
				return fsyncTree(root);
			});
			const restoreManifest = replaceExport(backupManifestModule, 'writeBackupManifest', async (dir, id, ...rest) => {
				events.push(['manifest', id]);
				return writeBackupManifest(dir, id, ...rest);
			});
			let id;
			try {
				id = await createPreRestoreBackup(fixture.name, fixture.dir, fixture.backupDir, operationId);
			} finally {
				restoreFsync();
				restoreManifest();
			}
			assert.deepStrictEqual(events, [
				['fsync', blobSnapshotDir(fixture.backupDir, id)],
				['manifest', id],
			]);
			await restoreBackup({ ...SU, database: fixture.name, cancel: true });
		});

		it('adopts a pre-restore backup a crash left unjournaled instead of taking another', async function () {
			const fixture = await seededDatabase();
			const { jobId } = await requestRestore(fixture.name, { on_restart: true });
			await closeDatabase(fixture.name);
			// The crash: the backup completed, but the process died before its id reached the receipt.
			const { operation_id: operationId } = rewriteReceipt(fixture.dir, { pre_restore_started_at: Date.now() });
			const adopted = await createPreRestoreBackup(fixture.name, fixture.dir, fixture.backupDir, operationId);
			const before = (await listBackupsInDir(fixture.backupDir)).map((backup) => backup.backupId);

			await boot(fixture.name);

			assert.deepStrictEqual(
				(await listBackupsInDir(fixture.backupDir)).map((backup) => backup.backupId),
				before,
				'no second pre-restore backup'
			);
			const settled = await job(jobId);
			assert.strictEqual(settled.status, JOB_STATUS_ENUM.COMPLETE);
			assert.strictEqual(settled.result.pre_restore_backup_id, adopted);
			assert.deepStrictEqual(await snapshot(loadedItems(fixture.name)), fixture.backedUp[0]);
		});

		it('keeps a failed attempt blocked and owned, and completes it on the next boot', async function () {
			const fixture = await seededDatabase();
			const [backupId] = fixture.backupIds;
			const { jobId } = await requestRestore(fixture.name, { on_restart: true, retain_previous: false });
			const repair = breakBackup(fixture, backupId);

			const owned = await boot(fixture.name);

			assert.deepStrictEqual([...owned], [jobId]);
			const failed = receiptOf(fixture.dir);
			assert.strictEqual(failed.state, 'applying');
			assert.strictEqual(failed.attempts, 1);
			assert.match(failed.last_error, /failed verification/);
			// refused before the purge, so nothing marks the target: the receipt alone keeps it blocked
			assert.strictEqual(restoreMarkerPresent(fixture.dir), false);
			assert.strictEqual(checkRestoreState(fixture.dir), 'pending');
			assert.strictEqual(loadedItems(fixture.name), undefined, 'the name stays blocked');
			assert.deepStrictEqual(pinsOf(fixture), [{ pin_id: failed.source_pin_id, backup_id: backupId }]);
			assert.strictEqual(unpublishedRestoreBlocksComponents(), undefined, 'nothing was replaced, so components load');
			// the interrupted-job sweep that follows the hook leaves the job to its receipt
			await reconcileInterruptedJobs(owned);
			assert.strictEqual((await job(jobId)).status, JOB_STATUS_ENUM.IN_PROGRESS);
			// the set a boot falls back to when recovery throws names the same job
			const named = jobsOwnedByRestoreReceipts();
			assert.deepStrictEqual([...named], [jobId]);
			await reconcileInterruptedJobs(named);
			assert.strictEqual((await job(jobId)).status, JOB_STATUS_ENUM.IN_PROGRESS);

			repair();
			assert.deepStrictEqual([...(await boot(fixture.name))], []);
			assert.deepStrictEqual([...jobsOwnedByRestoreReceipts()], []);

			assert.strictEqual(readRestoreReceipt(fixture.dir).kind, 'absent');
			assert.strictEqual(restoreMarkerPresent(fixture.dir), false);
			assert.strictEqual((await job(jobId)).status, JOB_STATUS_ENUM.COMPLETE);
			assert.deepStrictEqual(await snapshot(loadedItems(fixture.name)), fixture.backedUp[0]);
		});

		it('starts the next boot in safe mode once an attempt took its rollback copy, so nothing writes past it', async function () {
			const fixture = await seededDatabase();
			const { jobId } = await requestRestore(fixture.name, { on_restart: true, retain_previous: true });
			// fails the attempt after its rollback copy and before the restore process touches the target; corrupting
			// the source instead would let the copy's backup engine discard it as corrupt
			const restoreRunner = replaceExport(restoreChildRunnerModule, 'runRestoreChild', async (command, ...args) => {
				if (command !== 'pre-restore-backup') throw new Error('simulated failure before the purge');
				return runRestoreChild(command, ...args);
			});
			try {
				await boot(fixture.name);
			} finally {
				restoreRunner();
			}

			const failed = receiptOf(fixture.dir);
			assert.ok(Number.isInteger(failed.pre_restore_backup_id), 'precondition: the rollback copy was taken');
			assert.strictEqual(restoreMarkerPresent(fixture.dir), false, 'precondition: refused before the purge');
			assert.strictEqual(
				unpublishedRestoreBlocksComponents(),
				fixture.name,
				'a component that opens the database itself could write past the copy the next attempt replaces it with'
			);

			await boot(fixture.name);
			assert.strictEqual(
				unpublishedRestoreBlocksComponents(),
				undefined,
				`the retry did not publish: ${JSON.stringify(readRestoreReceipt(fixture.dir))}`
			);
			assert.strictEqual((await job(jobId)).status, JOB_STATUS_ENUM.COMPLETE);
			assert.deepStrictEqual(await snapshot(loadedItems(fixture.name)), fixture.backedUp[0]);
		});

		it('starts the boot in safe mode once a rollback copy has started, even before the receipt records it', async function () {
			const fixture = await seededDatabase();
			await requestRestore(fixture.name, { on_restart: true, retain_previous: true });
			await closeDatabase(fixture.name);
			// what a pin or receipt write failing after the copy finished leaves: the next attempt adopts that copy
			rewriteReceipt(fixture.dir, { attempts: 1, pre_restore_started_at: Date.now() });

			assert.strictEqual(unpublishedRestoreBlocksComponents(), fixture.name);
			await restoreBackup({ ...SU, database: fixture.name, cancel: true });
			assert.strictEqual(unpublishedRestoreBlocksComponents(), undefined);
		});

		it('starts the next boot in safe mode once an attempt failed past its purge, until a restore publishes', async function () {
			const fixture = await seededDatabase();
			const [good] = fixture.backupIds;
			const unprovable = await unprovableBackup(fixture);
			await requestRestore(fixture.name, { on_restart: true, backup_id: unprovable, retain_previous: false });

			await boot(fixture.name);

			const failed = receiptOf(fixture.dir);
			assert.strictEqual(failed.state, 'applying', 'one attempt of three: not terminal');
			assert.strictEqual(restoreMarkerPresent(fixture.dir), true, 'the proof failed after the purge');
			assert.strictEqual(
				unpublishedRestoreBlocksComponents(),
				fixture.name,
				'a component that opens the database itself would read the unproved generation'
			);

			// a supersede to a sound backup is how the operator recovers
			await requestRestore(fixture.name, { on_restart: true, backup_id: good });
			await boot(fixture.name);
			assert.strictEqual(unpublishedRestoreBlocksComponents(), undefined);
			assert.deepStrictEqual(await snapshot(loadedItems(fixture.name)), fixture.backedUp[0]);
		});

		it('says a retry whose backup fails verification leaves the target an earlier attempt began replacing', async function () {
			const fixture = await seededDatabase();
			const [good] = fixture.backupIds;
			const unprovable = await unprovableBackup(fixture);
			await requestRestore(fixture.name, { on_restart: true, backup_id: unprovable, retain_previous: false });
			await boot(fixture.name);
			assert.strictEqual(restoreMarkerPresent(fixture.dir), true, 'precondition: the first attempt purged the target');

			const repair = breakBackup(fixture, unprovable);
			try {
				await boot(fixture.name);
			} finally {
				repair();
			}

			const failed = receiptOf(fixture.dir);
			assert.strictEqual(failed.attempts, 2);
			assert.match(failed.last_error, /failed verification, so database '\w+' still holds an earlier restore/);
			assert.doesNotMatch(failed.last_error, /did not modify/);

			await requestRestore(fixture.name, { on_restart: true, backup_id: good });
			await boot(fixture.name);
			assert.deepStrictEqual(await snapshot(loadedItems(fixture.name)), fixture.backedUp[0]);
		});

		it('goes terminal without another attempt when the last one killed the process', async function () {
			const fixture = await seededDatabase();
			const { jobId } = await requestRestore(fixture.name, { on_restart: true, retain_previous: false });
			await closeDatabase(fixture.name);
			// three attempts started and none recorded an outcome: each one took the process down
			rewriteReceipt(fixture.dir, { attempts: 3 });

			assert.deepStrictEqual([...(await boot(fixture.name))], []);

			const terminal = receiptOf(fixture.dir);
			assert.strictEqual(terminal.state, 'terminal');
			assert.strictEqual(terminal.attempts, 3, 'no fourth attempt');
			assert.match(terminal.last_error, /did not finish/);
			assert.strictEqual((await job(jobId)).status, JOB_STATUS_ENUM.ERROR);
			assert.strictEqual(unpublishedRestoreBlocksComponents(), fixture.name);
			await restoreBackup({ ...SU, database: fixture.name, cancel: true });
		});

		it('goes terminal when the live database cannot be backed up, and replaces it once told to keep no copy', async function () {
			const fixture = await seededDatabase();
			const [backupId] = fixture.backupIds;
			await requestRestore(fixture.name, { on_restart: true, backup_id: backupId });
			await closeDatabase(fixture.name);
			// the most common reason to restore: the live database no longer opens
			writeFileSync(join(fixture.dir, 'CURRENT'), 'MANIFEST-999999\n');

			await boot(fixture.name);

			const terminal = receiptOf(fixture.dir);
			assert.strictEqual(terminal.state, 'terminal', 'retrying would reopen the same directory');
			assert.strictEqual(terminal.attempts, 1);
			assert.match(terminal.last_error, /retain_previous=false/);
			assert.strictEqual(restoreMarkerPresent(fixture.dir), false, 'nothing was replaced');

			await requestRestore(fixture.name, { on_restart: true, backup_id: backupId, retain_previous: false });
			await boot(fixture.name);
			assert.strictEqual(readRestoreReceipt(fixture.dir).kind, 'absent');
			assert.deepStrictEqual(await snapshot(loadedItems(fixture.name)), fixture.backedUp[0]);
		});

		for (const [cause, options, fail, expectedError] of [
			[
				'the node has replication peers',
				{ retain_previous: false },
				() => {
					const savedRoutes = env.get(CONFIG_PARAMS.REPLICATION_ROUTES);
					env.setProperty(CONFIG_PARAMS.REPLICATION_ROUTES, [{ hostname: 'peer.example', port: 9933 }]);
					return () => env.setProperty(CONFIG_PARAMS.REPLICATION_ROUTES, savedRoutes);
				},
				/peer\.example/,
			],
			[
				'the live database cannot be backed up',
				{},
				(fixture) => {
					const currentPath = join(fixture.dir, 'CURRENT');
					const current = readFileSync(currentPath);
					writeFileSync(currentPath, 'MANIFEST-999999\n');
					return () => writeFileSync(currentPath, current);
				},
				/retain_previous=false/,
			],
		]) {
			it(`can resume a restore that went terminal on its last attempt because ${cause}, when that write could not be flushed`, async function () {
				const fixture = await seededDatabase();
				const [backupId] = fixture.backupIds;
				const { jobId } = await requestRestore(fixture.name, { on_restart: true, backup_id: backupId, ...options });
				await closeDatabase(fixture.name);
				// the last attempt, so a failure recorded twice would be terminal both times
				rewriteReceipt(fixture.dir, { attempts: 2 });
				const repair = fail(fixture);
				let flushFailed = false;
				const restoreWrite = flushFailsAfter(
					fixture,
					'writeRestoreReceipt',
					(receipt) => receipt.state === 'terminal' && !flushFailed && (flushFailed = true)
				);
				try {
					await boot(fixture.name);
				} finally {
					restoreWrite();
					repair();
				}

				assert.ok(flushFailed, 'precondition: the terminal write took effect, then threw');
				const terminal = receiptOf(fixture.dir);
				assert.strictEqual(terminal.state, 'terminal');
				assert.strictEqual(terminal.pre_terminal_state, 'pending');
				assert.strictEqual(terminal.attempts, 3);
				assert.match(terminal.last_error, expectedError, 'the reason, not the flush failure');
				assert.strictEqual((await job(jobId)).status, JOB_STATUS_ENUM.ERROR);

				const resumed = await requestRestore(fixture.name, { resume: true });
				assert.strictEqual(receiptOf(fixture.dir).state, 'pending');
				await boot(fixture.name);
				assert.strictEqual((await job(resumed.jobId)).status, JOB_STATUS_ENUM.COMPLETE);
				assert.deepStrictEqual(await snapshot(loadedItems(fixture.name)), fixture.backedUp[0]);
			});
		}

		it('keeps a rollback copy its child completed before failing, instead of stopping the restore', async function () {
			const fixture = await seededDatabase();
			const { jobId } = await requestRestore(fixture.name, { on_restart: true });
			let completed;
			// the child published the copy's manifest, then died before it reported the result
			const restoreRunner = replaceExport(restoreChildRunnerModule, 'runRestoreChild', async (command, ...args) => {
				const result = await runRestoreChild(command, ...args);
				if (command !== 'pre-restore-backup') return result;
				completed = result.backupId;
				throw new Error('The restore child running pre-restore-backup exited on SIGKILL without a result');
			});
			try {
				assert.deepStrictEqual([...(await boot(fixture.name))], []);
			} finally {
				restoreRunner();
			}

			assert.ok(Number.isInteger(completed), 'precondition: the child completed the copy');
			assert.strictEqual(
				readRestoreReceipt(fixture.dir).kind,
				'absent',
				`the restore finished: ${JSON.stringify(readRestoreReceipt(fixture.dir))}`
			);
			const settled = await job(jobId);
			assert.strictEqual(settled.status, JOB_STATUS_ENUM.COMPLETE);
			assert.strictEqual(settled.result.pre_restore_backup_id, completed);
			assert.deepStrictEqual(
				(await listBackupsInDir(fixture.backupDir)).map((backup) => backup.backupId),
				[...fixture.backupIds, completed],
				'no second copy'
			);
			assert.deepStrictEqual(await snapshot(loadedItems(fixture.name)), fixture.backedUp[0]);
		});

		it('counts a refused pre-restore backup as an attempt to retry, not a terminal failure', async function () {
			const fixture = await seededDatabase();
			const { jobId } = await requestRestore(fixture.name, { on_restart: true });
			// an offline backup verification, say, holds the instance's one restore child slot
			const slot = tryFileLock(restoreChildSlotLockPath());
			assert.notStrictEqual(slot, 0, 'precondition: the slot is free');
			try {
				await boot(fixture.name);
			} finally {
				fileLockRelease(slot);
			}

			const failed = receiptOf(fixture.dir);
			assert.strictEqual(failed.state, 'pending');
			assert.strictEqual(failed.attempts, 1);
			assert.match(failed.last_error, /retry once it finishes/);
			assert.doesNotMatch(failed.last_error, /retain_previous=false/);
			assert.strictEqual((await job(jobId)).status, JOB_STATUS_ENUM.IN_PROGRESS);

			await boot(fixture.name);
			const settled = await job(jobId);
			assert.strictEqual(settled.status, JOB_STATUS_ENUM.COMPLETE);
			assert.ok(Number.isInteger(settled.result.pre_restore_backup_id), 'the retry kept its rollback copy');
			assert.deepStrictEqual(await snapshot(loadedItems(fixture.name)), fixture.backedUp[0]);
		});

		it('settles a terminal restore whose job settle never landed, instead of leaving the job to its receipt', async function () {
			const fixture = await seededDatabase();
			const { jobId } = await requestRestore(fixture.name, { on_restart: true, retain_previous: false });
			await closeDatabase(fixture.name);
			rewriteReceipt(fixture.dir, { state: 'terminal', last_error: 'out of attempts' });
			assert.strictEqual((await job(jobId)).status, JOB_STATUS_ENUM.IN_PROGRESS, 'precondition');

			assert.deepStrictEqual([...(await boot(fixture.name))], [], 'no longer owned, so the sweep may take it');

			assert.strictEqual((await job(jobId)).status, JOB_STATUS_ENUM.ERROR);
			await restoreBackup({ ...SU, database: fixture.name, cancel: true });
		});

		it('only finishes a committed receipt, never applying it again', async function () {
			const fixture = await seededDatabase();
			const { jobId } = await requestRestore(fixture.name, { on_restart: true, retain_previous: false });
			await closeDatabase(fixture.name);
			// The crash: committed (the generation on disk is the published one), marker not yet cleared.
			rewriteReceipt(fixture.dir, { state: 'committed', attempts: 1 }, { marker: true });
			assert.strictEqual(checkRestoreState(fixture.dir), 'incomplete');

			assert.deepStrictEqual([...(await boot(fixture.name))], []);

			assert.strictEqual(readRestoreReceipt(fixture.dir).kind, 'absent');
			assert.strictEqual(restoreMarkerPresent(fixture.dir), false);
			assert.deepStrictEqual(pinsOf(fixture), []);
			assert.strictEqual((await job(jobId)).status, JOB_STATUS_ENUM.COMPLETE);
			assert.deepStrictEqual(
				await snapshot(loadedItems(fixture.name)),
				fixture.live,
				'what the directory held when the commit was found survives'
			);
		});

		it('keeps the job of a committed restore from the sweep a boot falls back to, until the receipt settles it', async function () {
			const fixture = await seededDatabase();
			const { jobId } = await requestRestore(fixture.name, { on_restart: true, retain_previous: false });
			await closeDatabase(fixture.name);
			rewriteReceipt(fixture.dir, { state: 'committed', attempts: 1 }, { marker: true });

			const owned = jobsOwnedByRestoreReceipts();
			assert.ok(owned.has(jobId), 'a committed receipt settles its job before it is removed');
			await reconcileInterruptedJobs(owned);
			assert.strictEqual((await job(jobId)).status, JOB_STATUS_ENUM.IN_PROGRESS);
			assert.strictEqual(await settleAbandonedJob(jobId), false);

			await boot(fixture.name);
			assert.strictEqual((await job(jobId)).status, JOB_STATUS_ENUM.COMPLETE);
			assert.strictEqual(jobsOwnedByRestoreReceipts().has(jobId), false);

			// an online attempt that did not commit leaves its job to the process that ran it, or to the sweep
			const online = await seededDatabase();
			const onlineJob = await requestRestore(online.name, { on_restart: true, retain_previous: false });
			await closeDatabase(online.name);
			rewriteReceipt(online.dir, { route: 'online', state: 'applying', attempts: 1 }, { marker: true });
			assert.strictEqual(jobsOwnedByRestoreReceipts().has(onlineJob.jobId), false);
			await restoreBackupOffline(online.name, online.backupIds[0]);
		});

		it('moves to terminal at the attempt limit, and resume carries it on from where it stopped', async function () {
			const fixture = await seededDatabase();
			const [backupId] = fixture.backupIds;
			const { jobId } = await requestRestore(fixture.name, { on_restart: true, retain_previous: false });
			const repair = breakBackup(fixture, backupId);
			const { max_attempts: maxAttempts } = receiptOf(fixture.dir);
			assert.strictEqual(maxAttempts, 3);

			for (let attempt = 1; attempt < maxAttempts; attempt++) {
				assert.deepStrictEqual([...(await boot(fixture.name))], [jobId]);
				assert.strictEqual(receiptOf(fixture.dir).attempts, attempt);
				assert.strictEqual(receiptOf(fixture.dir).state, 'applying');
				assert.strictEqual(Boolean(unpublishedRestoreBlocksComponents()), false);
			}
			assert.strictEqual(process.env.HARPER_SAFE_MODE, savedSafeMode);
			await boot(fixture.name);

			const terminal = receiptOf(fixture.dir);
			assert.strictEqual(terminal.state, 'terminal');
			assert.strictEqual(terminal.pre_terminal_state, 'applying');
			assert.strictEqual(terminal.attempts, maxAttempts);
			const failedJob = await job(jobId);
			assert.strictEqual(failedJob.status, JOB_STATUS_ENUM.ERROR);
			assert.match(failedJob.message, /failed verification/);
			// what loadRootComponents reads right after recovery, before anything else, to start in safe mode
			assert.strictEqual(unpublishedRestoreBlocksComponents(), fixture.name);
			assert.strictEqual(loadedItems(fixture.name), undefined);
			// a terminal receipt is not retried
			await boot(fixture.name);
			assert.strictEqual(receiptOf(fixture.dir).attempts, maxAttempts);

			const resumed = await requestRestore(fixture.name, { resume: true });
			assert.ok(resumed.result instanceof DeferredJobCompletion);
			const reset = receiptOf(fixture.dir);
			assert.deepStrictEqual(
				{
					state: reset.state,
					attempts: reset.attempts,
					last_error: reset.last_error,
					pre_terminal_state: reset.pre_terminal_state,
					job_id: reset.job_id,
					operation_id: reset.operation_id,
				},
				{
					state: 'applying',
					attempts: 0,
					last_error: undefined,
					pre_terminal_state: undefined,
					job_id: resumed.jobId,
					operation_id: terminal.operation_id,
				}
			);
			assert.strictEqual(Boolean(unpublishedRestoreBlocksComponents()), false);

			repair();
			await boot(fixture.name);
			assert.strictEqual((await job(resumed.jobId)).status, JOB_STATUS_ENUM.COMPLETE);
			assert.strictEqual((await job(jobId)).status, JOB_STATUS_ENUM.ERROR, 'the terminal job keeps its outcome');
			assert.deepStrictEqual(await snapshot(loadedItems(fixture.name)), fixture.backedUp[0]);
		});

		it('supersedes a pending restore with a different backup, taking its own rollback copy since it inherits none', async function () {
			const fixture = await seededDatabase({ backups: 2 });
			const [first, second] = fixture.backupIds;
			const original = await requestRestore(fixture.name, { on_restart: true, backup_id: first });
			const { operation_id: originalOperation, source_pin_id: originalPin } = receiptOf(fixture.dir);

			const replacement = await requestRestore(fixture.name, { on_restart: true, backup_id: second });

			const receipt = receiptOf(fixture.dir);
			assert.notStrictEqual(receipt.operation_id, originalOperation);
			assert.strictEqual(receipt.superseded_from, originalOperation);
			assert.strictEqual(
				receipt.retain_previous,
				true,
				'the displaced restore never ran, so it took no copy to inherit'
			);
			assert.strictEqual(receipt.backup_id, second);
			assert.strictEqual(receipt.job_id, replacement.jobId);
			assert.strictEqual(receipt.source_pin_id, `restore-intent-${receipt.operation_id}`);
			assert.notStrictEqual(receipt.source_pin_id, originalPin, 'each restore pins its source under its own id');
			assert.deepStrictEqual(
				pinsOf(fixture).sort((a, b) => a.backup_id - b.backup_id),
				[
					{ pin_id: originalPin, backup_id: first },
					{ pin_id: receipt.source_pin_id, backup_id: second },
				],
				"the superseded restore's source stays pinned until its successor proves its own"
			);
			assert.deepStrictEqual(receipt.superseded_pin_ids, [originalPin]);
			const supersededJob = await job(original.jobId);
			assert.strictEqual(supersededJob.status, JOB_STATUS_ENUM.ERROR);
			assert.strictEqual(supersededJob.message, `Superseded by job ${replacement.jobId}`);

			await boot(fixture.name);

			const settled = await job(replacement.jobId);
			assert.strictEqual(settled.status, JOB_STATUS_ENUM.COMPLETE);
			assert.ok(Number.isInteger(settled.result.pre_restore_backup_id), 'the live generation was kept');
			assert.deepStrictEqual(
				(await listBackupsInDir(fixture.backupDir)).map((backup) => backup.backupId),
				[...fixture.backupIds, settled.result.pre_restore_backup_id]
			);
			assert.deepStrictEqual(pinsOf(fixture), [], 'the displaced source retires once its successor commits');
			assert.deepStrictEqual(await snapshot(loadedItems(fixture.name)), fixture.backedUp[1]);
		});

		it('supersedes a restore that already took its rollback copy without asking for room for another', async function () {
			const fixture = await seededDatabase({ backups: 2 });
			const [first, second] = fixture.backupIds;
			const noRoom = () =>
				replaceExport(storageReclamationModule, 'getStorageSpaceStats', async () => ({
					available: 0,
					free: 0,
					size: 0,
					basis: 'filesystem',
				}));
			let restoreSpace = noRoom();
			try {
				await assert.rejects(
					requestRestore(fixture.name, { on_restart: true, backup_id: first }),
					(error) => error.statusCode === 507
				);
			} finally {
				restoreSpace();
			}
			assert.strictEqual(readRestoreReceipt(fixture.dir).kind, 'absent', 'refused before anything is recorded');
			assert.deepStrictEqual(pinsOf(fixture), []);

			await requestRestore(fixture.name, { on_restart: true, backup_id: first });
			const restoreRunner = replaceExport(restoreChildRunnerModule, 'runRestoreChild', async (command, ...args) => {
				if (command !== 'pre-restore-backup') throw new Error('simulated failure before the purge');
				return runRestoreChild(command, ...args);
			});
			try {
				await boot(fixture.name);
			} finally {
				restoreRunner();
			}
			const { pre_restore_backup_id: copy } = receiptOf(fixture.dir);
			assert.ok(Number.isInteger(copy), 'precondition: the attempt took its rollback copy');

			// the copy left too little room for a second one, which the supersede does not take
			restoreSpace = noRoom();
			let replacement;
			try {
				replacement = await requestRestore(fixture.name, { on_restart: true, backup_id: second });
			} finally {
				restoreSpace();
			}

			const receipt = receiptOf(fixture.dir);
			assert.strictEqual(receipt.retain_previous, false);
			assert.strictEqual(receipt.pre_restore_backup_id, copy);
			await boot(fixture.name);
			assert.strictEqual((await job(replacement.jobId)).status, JOB_STATUS_ENUM.COMPLETE);
			assert.deepStrictEqual(await snapshot(loadedItems(fixture.name)), fixture.backedUp[1]);
		});

		it('keeps a superseded restore and its pinned source when its successor cannot record its receipt', async function () {
			const fixture = await seededDatabase({ backups: 2 });
			const [first, second] = fixture.backupIds;
			const original = await requestRestore(fixture.name, { on_restart: true, backup_id: first });
			const pending = receiptOf(fixture.dir);

			const repair = failReceiptWrites(fixture);
			try {
				await assert.rejects(
					requestRestore(fixture.name, { on_restart: true, backup_id: second }),
					(error) => error.code === 'EISDIR'
				);
			} finally {
				repair();
			}

			assert.deepStrictEqual(receiptOf(fixture.dir), pending, 'the superseded restore is still the one recorded');
			assert.ok(
				pinsOf(fixture).some((pin) => pin.pin_id === pending.source_pin_id && pin.backup_id === first),
				`its source is still pinned: ${JSON.stringify(pinsOf(fixture))}`
			);
			await assert.rejects(deleteBackupOffline(fixture.name, first), (error) => error.statusCode === 409);
			assert.strictEqual(
				(await job(original.jobId)).status,
				JOB_STATUS_ENUM.IN_PROGRESS,
				'and its job is not superseded'
			);

			await boot(fixture.name);
			assert.strictEqual((await job(original.jobId)).status, JOB_STATUS_ENUM.COMPLETE);
			assert.deepStrictEqual(await snapshot(loadedItems(fixture.name)), fixture.backedUp[0]);
		});

		it('releases its claim when it cannot count the attempt, and runs it at the next boot', async function () {
			const fixture = await seededDatabase();
			const { jobId } = await requestRestore(fixture.name, { on_restart: true, retain_previous: false });
			const pending = receiptOf(fixture.dir);

			const repair = failReceiptWrites(fixture);
			let owned;
			try {
				owned = await boot(fixture.name);
			} finally {
				repair();
			}

			assert.deepStrictEqual([...owned], [jobId]);
			assert.deepStrictEqual(receiptOf(fixture.dir), pending, 'neither counted nor started');
			assert.strictEqual(restoreLockHeldExclusively(fixture.dir), false, 'the claim is not left held');

			assert.deepStrictEqual([...(await boot(fixture.name))], []);
			assert.strictEqual(readRestoreReceipt(fixture.dir).kind, 'absent');
			assert.strictEqual((await job(jobId)).status, JOB_STATUS_ENUM.COMPLETE);
			assert.deepStrictEqual(await snapshot(loadedItems(fixture.name)), fixture.backedUp[0]);
		});

		it('never counts a failure to finish a committed restore as a failed attempt', async function () {
			const fixture = await seededDatabase();
			const { jobId } = await requestRestore(fixture.name, { on_restart: true, retain_previous: false });
			const { max_attempts: maxAttempts } = receiptOf(fixture.dir);
			await closeDatabase(fixture.name);
			// the last attempt the limit allows, so a miscounted failure would make it terminal
			rewriteReceipt(fixture.dir, { attempts: maxAttempts - 1 });
			// the receipt's own removal is the last finishing step; the job row is written by then
			// it shares a directory with the marker cleared just before it, so a real fault cannot reach it alone
			let removals = 0;
			const restoreRemoval = replaceExport(restoreReceiptModule, 'removeRestoreReceipt', () => {
				removals++;
				throw new Error('the restore metadata directory is unavailable');
			});
			let owned;
			try {
				owned = await boot(fixture.name);
			} finally {
				restoreRemoval();
			}

			assert.ok(removals > 0, 'precondition: the finish failed');
			const receipt = receiptOf(fixture.dir);
			assert.strictEqual(receipt.state, 'committed', 'a published restore is only ever finished');
			assert.strictEqual(receipt.last_error, undefined);
			assert.strictEqual(Boolean(unpublishedRestoreBlocksComponents()), false);
			assert.strictEqual(process.env.HARPER_SAFE_MODE, savedSafeMode);
			assert.deepStrictEqual([...owned], [jobId], 'the job stays with its receipt, not the interrupted-job sweep');
			assert.strictEqual((await job(jobId)).status, JOB_STATUS_ENUM.COMPLETE, 'the restore did not fail');
			assert.deepStrictEqual(await snapshot(loadedItems(fixture.name)), fixture.backedUp[0]);

			await boot(fixture.name);
			assert.strictEqual(readRestoreReceipt(fixture.dir).kind, 'absent');
			assert.strictEqual((await job(jobId)).status, JOB_STATUS_ENUM.COMPLETE);
		});

		it('never turns a commit that took effect before its flush failed into a failed attempt', async function () {
			const fixture = await seededDatabase();
			const { jobId } = await requestRestore(fixture.name, { on_restart: true, retain_previous: false });
			const { max_attempts: maxAttempts } = receiptOf(fixture.dir);
			await closeDatabase(fixture.name);
			// the last attempt the limit allows, so a miscounted failure would make it terminal
			rewriteReceipt(fixture.dir, { attempts: maxAttempts - 1 });
			const restoreWrite = flushFailsAfter(fixture, 'writeRestoreReceipt', (receipt) => receipt.state === 'committed');
			let owned;
			try {
				owned = await boot(fixture.name);
			} finally {
				restoreWrite();
			}

			const receipt = receiptOf(fixture.dir);
			assert.strictEqual(receipt.state, 'committed', 'a committed restore is only ever finished');
			assert.strictEqual(receipt.pre_terminal_state, undefined);
			assert.strictEqual(receipt.last_error, undefined);
			assert.strictEqual(Boolean(unpublishedRestoreBlocksComponents()), false);
			assert.deepStrictEqual([...owned], [jobId], 'the job stays with its receipt, not the interrupted-job sweep');
			assert.strictEqual((await job(jobId)).status, JOB_STATUS_ENUM.IN_PROGRESS, 'the restore did not fail');

			assert.deepStrictEqual([...(await boot(fixture.name))], []);
			assert.strictEqual(readRestoreReceipt(fixture.dir).kind, 'absent');
			assert.strictEqual(restoreMarkerPresent(fixture.dir), false);
			assert.strictEqual((await job(jobId)).status, JOB_STATUS_ENUM.COMPLETE);
			assert.deepStrictEqual(await snapshot(loadedItems(fixture.name)), fixture.backedUp[0]);
		});

		for (const [what, remove] of [
			['removed', (fixture, backupId) => deleteBackupOffline(fixture.name, backupId)],
			[
				'left with a manifest but no engine backup',
				(fixture, backupId) => rmSync(join(fixture.backupDir, 'meta', String(backupId))),
			],
		]) {
			it(`fails the attempt, pinning nothing, when its rollback copy is ${what} before it is pinned`, async function () {
				const fixture = await seededDatabase();
				const { jobId } = await requestRestore(fixture.name, { on_restart: true });
				let removed;
				// nothing pins the copy between its child finishing and the pin; the removal is placed in that window
				const restoreRunner = replaceExport(restoreChildRunnerModule, 'runRestoreChild', async (command, ...args) => {
					const result = await runRestoreChild(command, ...args);
					if (command === 'pre-restore-backup') {
						removed = result.backupId;
						await remove(fixture, removed);
					}
					return result;
				});
				let owned;
				try {
					owned = await boot(fixture.name);
				} finally {
					restoreRunner();
				}

				assert.ok(Number.isInteger(removed), 'precondition: the attempt took a rollback copy');
				assert.deepStrictEqual([...owned], [jobId]);
				const failed = receiptOf(fixture.dir);
				assert.strictEqual(failed.attempts, 1);
				assert.match(
					failed.last_error,
					new RegExp(`pre-restore backup ${removed} .* was removed before it could be pinned`)
				);
				assert.strictEqual(failed.pre_restore_backup_id, undefined);
				assert.strictEqual(failed.pre_restore_pin_id, undefined);
				assert.deepStrictEqual(pinsOf(fixture), [{ pin_id: failed.source_pin_id, backup_id: fixture.backupIds[0] }]);
				assert.strictEqual(restoreMarkerPresent(fixture.dir), false, 'refused before the purge');
				assert.strictEqual((await job(jobId)).status, JOB_STATUS_ENUM.IN_PROGRESS);

				await restoreBackup({ ...SU, database: fixture.name, cancel: true });
				assert.deepStrictEqual(await snapshot(loadedItems(fixture.name)), fixture.live, 'nothing was replaced');
			});
		}

		for (const [scenario, prepare] of [
			[
				'an earlier restore left the database half-replaced',
				(fixture) => {
					const lock = acquireRestoreLock(fixture.dir);
					try {
						markRestoreDestructive(lock);
					} finally {
						releaseRestoreLock(lock);
					}
					for (const name of readdirSync(fixture.dir)) {
						if (name !== 'LOCK') rmSync(join(fixture.dir, name), { recursive: true, force: true });
					}
				},
			],
			['the database directory is gone', (fixture) => rmSync(fixture.dir, { recursive: true, force: true })],
		]) {
			it(`publishes without a rollback copy when ${scenario}, since there is no generation to keep`, async function () {
				const fixture = await seededDatabase();
				await closeDatabase(fixture.name);
				prepare(fixture);

				const { jobId } = await requestRestore(fixture.name, { on_restart: true });
				await boot(fixture.name);

				assert.strictEqual(
					readRestoreReceipt(fixture.dir).kind,
					'absent',
					`the restore finished: ${JSON.stringify(readRestoreReceipt(fixture.dir))}`
				);
				const settled = await job(jobId);
				assert.strictEqual(settled.status, JOB_STATUS_ENUM.COMPLETE);
				assert.strictEqual(settled.result.pre_restore_backup_id, undefined);
				assert.deepStrictEqual(await snapshot(loadedItems(fixture.name)), fixture.backedUp[0]);
			});
		}
	});

	describe('cancel', function () {
		it('from pending: unblocks the database, releases the pin and fails the job', async function () {
			const fixture = await seededDatabase();
			const { jobId } = await requestRestore(fixture.name, { on_restart: true });
			const { operation_id: operationId } = receiptOf(fixture.dir);

			const { result, afterRecorded } = await restoreBackup({ ...SU, database: fixture.name, cancel: true });

			assert.strictEqual(result.cancelled, operationId);
			assert.strictEqual(result.still_blocked, false);
			assert.strictEqual(result.restarting, false, 'no boot has held it, so components already have it');
			assert.strictEqual(afterRecorded, undefined);
			assert.match(result.message, /loads normally/);
			assert.doesNotMatch(result.message, /confirmed durable/);
			assert.strictEqual(readRestoreReceipt(fixture.dir).kind, 'absent');
			assert.strictEqual(checkRestoreState(fixture.dir), 'clear');
			assert.deepStrictEqual(pinsOf(fixture), []);
			const cancelled = await job(jobId);
			assert.strictEqual(cancelled.status, JOB_STATUS_ENUM.ERROR);
			assert.strictEqual(cancelled.message, 'Cancelled');
			assert.deepStrictEqual(
				await snapshot(servedItems(fixture.name)),
				fixture.live,
				'still served with no rescan or restart, so nothing needs one'
			);
			assert.deepStrictEqual(await snapshot(loadedItems(fixture.name)), fixture.live, 'nothing was replaced');
		});

		it('with Harper stopped: withdraws the restore without a restart, leaving its job to the next start', async function () {
			const fixture = await seededDatabase();
			const { jobId } = await requestRestore(fixture.name, { on_restart: true });
			const { operation_id: operationId } = receiptOf(fixture.dir);
			await closeDatabase(fixture.name);
			// a counted attempt is what makes the online cancel restart
			rewriteReceipt(fixture.dir, { attempts: 1 });
			const restarts = [];
			const restoreRestart = replaceExport(restartModule, 'restart', async (...args) => {
				restarts.push(args);
			});
			let result;
			try {
				result = await cancelRestartRestoreOffline({ database: fixture.name, cancel: true });
			} finally {
				restoreRestart();
			}

			assert.deepStrictEqual(
				{ cancelled: result.cancelled, still_blocked: result.still_blocked, restarting: result.restarting },
				{ cancelled: operationId, still_blocked: false, restarting: false }
			);
			assert.match(result.message, new RegExp(`job ${jobId}`));
			assert.doesNotMatch(result.message, /confirmed durable/);
			assert.deepStrictEqual(restarts, []);
			assert.strictEqual(readRestoreReceipt(fixture.dir).kind, 'absent');
			assert.deepStrictEqual(pinsOf(fixture), []);
			assert.strictEqual((await job(jobId)).status, JOB_STATUS_ENUM.IN_PROGRESS, 'the CLI leaves the job row alone');

			await reconcileInterruptedJobs(await boot(fixture.name));
			const settled = await job(jobId);
			assert.strictEqual(settled.status, JOB_STATUS_ENUM.ERROR);
			assert.match(settled.message, /interrupted/);
			assert.deepStrictEqual(await snapshot(loadedItems(fixture.name)), fixture.live, 'nothing was replaced');
		});

		it('with Harper stopped: a cancel that lands after the boot scanned the receipt is not undone', async function () {
			const fixtures = [await seededDatabase(), await seededDatabase()];
			const jobs = [];
			for (const fixture of fixtures) {
				jobs.push((await requestRestore(fixture.name, { on_restart: true, retain_previous: false })).jobId);
				await closeDatabase(fixture.name);
			}
			// whichever restore the boot runs first, the other is cancelled while it runs, after the scan
			let cancelled;
			const restoreChild = replaceExport(
				restoreChildRunnerModule,
				'runRestoreChild',
				async (command, args, options) => {
					if (cancelled === undefined) {
						cancelled = fixtures.findIndex((fixture) => fixture.name !== args.databaseName);
						await cancelRestartRestoreOffline({ database: fixtures[cancelled].name, cancel: true });
					}
					return runRestoreChild(command, args, options);
				}
			);
			let owned;
			try {
				resetStartupRecoveryForTesting();
				owned = await recoverRestoresAtStartup();
			} finally {
				restoreChild();
			}
			const restored = 1 - cancelled;

			assert.strictEqual(
				readRestoreReceipt(fixtures[cancelled].dir).kind,
				'absent',
				'the scanned copy is not written back'
			);
			assert.deepStrictEqual([...owned], [], 'no receipt names the cancelled job any longer');
			await reconcileInterruptedJobs(owned);
			assert.strictEqual((await job(jobs[cancelled])).status, JOB_STATUS_ENUM.ERROR);
			assert.strictEqual((await job(jobs[restored])).status, JOB_STATUS_ENUM.COMPLETE);
			assert.deepStrictEqual(await snapshot(loadedItems(fixtures[cancelled].name)), fixtures[cancelled].live);
			assert.deepStrictEqual(await snapshot(loadedItems(fixtures[restored].name)), fixtures[restored].backedUp[0]);
		});

		it('with Harper stopped: refuses a restore over a pending one, naming only the way out that works offline', async function () {
			const fixture = await seededDatabase();
			const [backupId] = fixture.backupIds;
			await requestRestore(fixture.name, { on_restart: true, retain_previous: false });
			await assert.rejects(
				restoreBackup({ ...SU, database: fixture.name, backup_id: backupId }),
				(error) => error.statusCode === 409 && /pending restart restore.*resume=true, cancel=true/.test(error.message)
			);
			await closeDatabase(fixture.name);

			await assert.rejects(restoreBackupOffline(fixture.name, backupId), (error) => {
				assert.strictEqual(error.statusCode, 409);
				assert.match(error.message, /pending restart restore/);
				assert.match(error.message, /cancel=true/);
				assert.doesNotMatch(error.message, /resume=true|on_restart=true/);
				return true;
			});
			await assert.rejects(
				cancelRestartRestoreOffline({ database: fixture.name, cancel: true, backup_id: backupId }),
				(error) => error.statusCode === 400 && /omit 'backup_id'/.test(error.message)
			);

			await cancelRestartRestoreOffline({ database: fixture.name, cancel: true });
			await restoreBackupOffline(fixture.name, backupId);
			assert.deepStrictEqual(await snapshot(loadedItems(fixture.name)), fixture.backedUp[0]);
		});

		it('restarts when this boot latched restore safe mode before counting an attempt', async function () {
			const fixture = await seededDatabase();
			await requestRestore(fixture.name, { on_restart: true });
			await closeDatabase(fixture.name);
			assert.strictEqual(receiptOf(fixture.dir).attempts, 0, 'precondition: no attempt was counted');
			const saved = process.env.HARPER_SAFE_MODE;
			process.env.HARPER_SAFE_MODE = 'restore-unpublished';
			try {
				const { result, afterRecorded } = await restoreBackup({ ...SU, database: fixture.name, cancel: true });

				assert.strictEqual(result.restarting, true, 'components were kept off, so only a restart loads them');
				assert.strictEqual(typeof afterRecorded, 'function');
			} finally {
				if (saved === undefined) delete process.env.HARPER_SAFE_MODE;
				else process.env.HARPER_SAFE_MODE = saved;
			}
		});

		it('restarts when this boot held the database without counting an attempt or entering safe mode', async function () {
			const fixture = await seededDatabase();
			await requestRestore(fixture.name, { on_restart: true, retain_previous: false });
			const repair = failReceiptWrites(fixture);
			try {
				await boot(fixture.name);
			} finally {
				repair();
			}
			assert.strictEqual(receiptOf(fixture.dir).attempts, 0, 'precondition: no attempt was counted');
			assert.strictEqual(unpublishedRestoreBlocksComponents(), undefined, 'precondition: no safe mode');

			const { result, afterRecorded } = await restoreBackup({ ...SU, database: fixture.name, cancel: true });

			assert.strictEqual(result.restarting, true, 'the boot loaded components without it, and nothing reloads it');
			assert.strictEqual(typeof afterRecorded, 'function');
			assert.strictEqual(servedItems(fixture.name), undefined, 'until the restart, nothing loads it');
			assert.deepStrictEqual(await snapshot(loadedItems(fixture.name)), fixture.live, 'the restarted process does');

			const requestedSince = await seededDatabase();
			await requestRestore(requestedSince.name, { on_restart: true, retain_previous: false });
			const later = await restoreBackup({ ...SU, database: requestedSince.name, cancel: true });
			assert.strictEqual(later.result.restarting, false, 'requested after this boot started, so never held');
			assert.deepStrictEqual(await snapshot(servedItems(requestedSince.name)), requestedSince.live, 'and still served');
		});

		it('does not restart while another restore would start Harper without components, and names it', async function () {
			const [held, stopped] = [await seededDatabase(), await seededDatabase()];
			for (const fixture of [held, stopped]) {
				await requestRestore(fixture.name, { on_restart: true, retain_previous: false });
				await closeDatabase(fixture.name);
			}
			rewriteReceipt(stopped.dir, { state: 'terminal', attempts: 3 });
			const repair = failReceiptWrites(held);
			try {
				resetStartupRecoveryForTesting();
				await recoverRestoresAtStartup();
			} finally {
				repair();
			}
			assert.strictEqual(unpublishedRestoreBlocksComponents(), stopped.name, 'precondition');
			// what loadRootComponents latches for this boot
			process.env.HARPER_SAFE_MODE = 'restore-unpublished';

			const first = await restoreBackup({ ...SU, database: held.name, cancel: true });

			assert.strictEqual(first.result.restarting, false, 'the next boot would start in safe mode all the same');
			assert.strictEqual(first.afterRecorded, undefined);
			assert.match(first.result.message, new RegExp(`the restore of '${stopped.name}'`));
			assert.match(first.result.message, /restarts by itself once no restore keeps components off/);
			assert.strictEqual(getDatabases()[held.name], undefined, 'nothing has loaded it yet');

			const last = await restoreBackup({ ...SU, database: stopped.name, cancel: true });

			assert.strictEqual(last.result.restarting, true, 'nothing keeps components off any longer');
			assert.strictEqual(typeof last.afterRecorded, 'function');
			assert.strictEqual(unpublishedRestoreBlocksComponents(), undefined);
			assert.deepStrictEqual(await snapshot(loadedItems(held.name)), held.live, 'the restarted process loads both');
			assert.deepStrictEqual(await snapshot(loadedItems(stopped.name)), stopped.live);
		});

		it('keeps the source pinned when the receipt cannot be removed, so a pending restore never loses its source', async function () {
			const fixture = await seededDatabase();
			await requestRestore(fixture.name, { on_restart: true });
			const before = pinsOf(fixture);
			assert.strictEqual(before.length, 1, 'precondition: the source is pinned');
			await closeDatabase(fixture.name);

			const restoreRemoval = replaceExport(restoreReceiptModule, 'removeRestoreReceipt', () => {
				throw new Error('the restore metadata directory is unavailable');
			});
			try {
				await assert.rejects(
					restoreBackup({ ...SU, database: fixture.name, cancel: true }),
					/restore metadata directory is unavailable/
				);
			} finally {
				restoreRemoval();
			}

			assert.strictEqual(readRestoreReceipt(fixture.dir).kind, 'valid', 'the receipt is still there');
			assert.deepStrictEqual(pinsOf(fixture), before, 'and so is the pin that protects its source');
		});

		it('finishes the cancel, restart included, when its removal took effect but could not be flushed', async function () {
			const fixture = await seededDatabase();
			const { jobId } = await requestRestore(fixture.name, { on_restart: true, retain_previous: false });
			const repair = failReceiptWrites(fixture);
			try {
				await boot(fixture.name);
			} finally {
				repair();
			}

			const restoreRemoval = flushFailsAfter(fixture, 'removeRestoreReceipt');
			let cancelled;
			try {
				cancelled = await restoreBackup({ ...SU, database: fixture.name, cancel: true });
			} finally {
				restoreRemoval();
			}

			assert.strictEqual(cancelled.result.restarting, true, 'the boot that held it loaded components without it');
			assert.strictEqual(typeof cancelled.afterRecorded, 'function');
			assert.ok(cancelled.result.message.endsWith(`. ${UNCONFIRMED_REMOVAL}`), cancelled.result.message);
			assert.strictEqual(readRestoreReceipt(fixture.dir).kind, 'absent');
			assert.deepStrictEqual(pinsOf(fixture), []);
			assert.strictEqual((await job(jobId)).message, 'Cancelled');

			const offline = await seededDatabase();
			await requestRestore(offline.name, { on_restart: true, retain_previous: false });
			await closeDatabase(offline.name);
			const offlineRemoval = flushFailsAfter(offline, 'removeRestoreReceipt');
			let offlineResult;
			try {
				offlineResult = await cancelRestartRestoreOffline({ database: offline.name, cancel: true });
			} finally {
				offlineRemoval();
			}
			assert.match(offlineResult.message, /is marked failed when Harper starts/);
			assert.ok(offlineResult.message.endsWith(`. ${UNCONFIRMED_REMOVAL}`), offlineResult.message);
			assert.strictEqual(readRestoreReceipt(offline.dir).kind, 'absent');

			const unreadable = await seededDatabase();
			await requestRestore(unreadable.name, { on_restart: true });
			await closeDatabase(unreadable.name);
			writeFileSync(restoreReceiptPath(unreadable.dir), '{"version":1,"state":');
			const unreadableRemoval = flushFailsAfter(unreadable, 'removeUnreadableRestoreReceipt');
			try {
				cancelled = await restoreBackup({ ...SU, database: unreadable.name, cancel: true });
			} finally {
				unreadableRemoval();
			}
			assert.strictEqual(cancelled.result.restarting, true);
			assert.strictEqual(typeof cancelled.afterRecorded, 'function');
			// a read can fail transiently, so what a power loss brings back may be a readable pending restore
			assert.ok(cancelled.result.message.endsWith(`. ${UNCONFIRMED_REMOVAL}`), cancelled.result.message);
			assert.strictEqual(readRestoreReceipt(unreadable.dir).kind, 'absent');

			const unreadableOffline = await seededDatabase();
			await requestRestore(unreadableOffline.name, { on_restart: true });
			await closeDatabase(unreadableOffline.name);
			writeFileSync(restoreReceiptPath(unreadableOffline.dir), '{"version":1,"state":');
			const unreadableOfflineRemoval = flushFailsAfter(unreadableOffline, 'removeUnreadableRestoreReceipt');
			try {
				offlineResult = await cancelRestartRestoreOffline({ database: unreadableOffline.name, cancel: true });
			} finally {
				unreadableOfflineRemoval();
			}
			assert.ok(offlineResult.message.endsWith(`. ${UNCONFIRMED_REMOVAL}`), offlineResult.message);
			assert.strictEqual(readRestoreReceipt(unreadableOffline.dir).kind, 'absent');
		});

		it('from applying before the purge: removes the receipt and unblocks the untouched database', async function () {
			const fixture = await seededDatabase();
			const [backupId] = fixture.backupIds;
			const { jobId } = await requestRestore(fixture.name, { on_restart: true, retain_previous: false });
			const repair = breakBackup(fixture, backupId);
			await boot(fixture.name);
			repair();
			assert.strictEqual(receiptOf(fixture.dir).state, 'applying');
			assert.strictEqual(restoreMarkerPresent(fixture.dir), false, 'verification refused before the purge');

			const { result, afterRecorded } = await restoreBackup({ ...SU, database: fixture.name, cancel: true });

			assert.strictEqual(result.still_blocked, false);
			assert.strictEqual(result.restarting, true, 'the boot that held it loaded components without it');
			assert.strictEqual(typeof afterRecorded, 'function', 'the restart runs once the job row records the cancel');
			assert.match(result.message, /restarting so '[^']+' and the components that use it load/);
			assert.strictEqual(readRestoreReceipt(fixture.dir).kind, 'absent');
			assert.strictEqual(checkRestoreState(fixture.dir), 'clear');
			assert.deepStrictEqual(pinsOf(fixture), []);
			assert.strictEqual((await job(jobId)).status, JOB_STATUS_ENUM.ERROR);
			assert.strictEqual(servedItems(fixture.name), undefined, 'until the restart, nothing loads it');
			assert.deepStrictEqual(await snapshot(loadedItems(fixture.name)), fixture.live, 'nothing was replaced');
		});

		it('from applying after the purge: keeps the marker, the source pin and the rollback copy pin until a restore succeeds', async function () {
			const fixture = await seededDatabase();
			const [backupId] = fixture.backupIds;
			const unprovable = await unprovableBackup(fixture);
			const { jobId } = await requestRestore(fixture.name, { on_restart: true, backup_id: unprovable });
			await boot(fixture.name);
			const failed = receiptOf(fixture.dir);
			assert.strictEqual(failed.state, 'applying');
			assert.match(failed.last_error, /Items\/unbacked/);
			assert.strictEqual(restoreMarkerPresent(fixture.dir), true, 'precondition: the purge began');
			const preRestoreId = failed.pre_restore_backup_id;
			assert.ok(Number.isInteger(preRestoreId), 'precondition: a rollback copy was taken');

			const { result, afterRecorded } = await restoreBackup({ ...SU, database: fixture.name, cancel: true });

			assert.strictEqual(result.still_blocked, true);
			assert.strictEqual(result.restarting, false, 'a restart would only boot into safe mode again');
			assert.strictEqual(afterRecorded, undefined);
			const kept = receiptOf(fixture.dir);
			assert.strictEqual(kept.state, 'terminal', 'kept as terminal, so components stay off the unproved generation');
			assert.strictEqual(unpublishedRestoreBlocksComponents(), fixture.name);
			assert.strictEqual(checkRestoreState(fixture.dir), 'incomplete');
			assert.strictEqual((await job(jobId)).status, JOB_STATUS_ENUM.ERROR);
			const pins = readBackupPins(fixture.backupDir);
			assert.deepStrictEqual(
				pins
					.map(({ pin_id, backup_id, database_path }) => ({ pin_id, backup_id, database_path }))
					.sort((a, b) => a.backup_id - b.backup_id),
				[
					{ pin_id: failed.source_pin_id, backup_id: unprovable, database_path: fixture.dir },
					{ pin_id: failed.pre_restore_pin_id, backup_id: preRestoreId, database_path: fixture.dir },
				].sort((a, b) => a.backup_id - b.backup_id)
			);
			for (const id of [unprovable, preRestoreId]) {
				await assert.rejects(
					deleteBackupOffline(fixture.name, id),
					(error) => error.statusCode === 409,
					`backup ${id}`
				);
			}

			// an ordinary restore takes the terminal one over and recovers it, retiring its pins on commit
			await restoreBackupOffline(fixture.name, backupId);
			assert.strictEqual(readRestoreReceipt(fixture.dir).kind, 'absent');
			assert.strictEqual(unpublishedRestoreBlocksComponents(), undefined);
			assert.deepStrictEqual(await snapshot(loadedItems(fixture.name)), fixture.backedUp[0]);
			await deleteBackupOffline(fixture.name, preRestoreId);
			await deleteBackupOffline(fixture.name, unprovable);
		});

		it('refuses a committed receipt, which only needs finishing', async function () {
			const fixture = await seededDatabase();
			const { jobId } = await requestRestore(fixture.name, { on_restart: true, retain_previous: false });
			await closeDatabase(fixture.name);
			rewriteReceipt(fixture.dir, { state: 'committed', attempts: 1 }, { marker: true });

			for (const step of [validateRestoreBackup, restoreBackup]) {
				await assert.rejects(
					step({ ...SU, database: fixture.name, cancel: true }),
					(error) => error.statusCode === 409 && /cannot be cancelled/.test(error.message),
					step.name
				);
			}
			assert.strictEqual(receiptOf(fixture.dir).state, 'committed');

			await boot(fixture.name);
			assert.strictEqual((await job(jobId)).status, JOB_STATUS_ENUM.COMPLETE);
		});

		it('keeps components off a half-replaced database after its unreadable record is cancelled', async function () {
			const fixture = await seededDatabase();
			await requestRestore(fixture.name, { on_restart: true, retain_previous: false });
			await closeDatabase(fixture.name);
			rewriteReceipt(fixture.dir, { state: 'applying', attempts: 1 }, { marker: true });
			writeFileSync(restoreReceiptPath(fixture.dir), '{"version":1,"state":');

			const { result } = await restoreBackup({ ...SU, database: fixture.name, cancel: true });

			assert.strictEqual(result.still_blocked, true);
			const kept = receiptOf(fixture.dir);
			assert.strictEqual(kept.state, 'terminal', 'a readable record takes the place of the one removed');
			assert.strictEqual(kept.record_lost, true);
			assert.strictEqual(restoreMarkerPresent(fixture.dir), true, 'the target was being replaced');
			assert.strictEqual(unpublishedRestoreBlocksComponents(), fixture.name, 'so the boot still starts in safe mode');
			await assert.rejects(
				restoreBackup({ ...SU, database: fixture.name, resume: true }),
				(error) => error.statusCode === 404,
				'it names no backup to resume'
			);
			await restoreBackupOffline(fixture.name, fixture.backupIds[0]);
			assert.strictEqual(readRestoreReceipt(fixture.dir).kind, 'absent');
			assert.strictEqual(unpublishedRestoreBlocksComponents(), undefined);
		});

		it('blocks only its own database on a marker an older version left without a record', async function () {
			const fixture = await seededDatabase();
			await closeDatabase(fixture.name);
			// what v5.3.6 leaves when a restore fails past its purge: the marker, and no receipt
			const lock = acquireRestoreLock(fixture.dir);
			try {
				lock.source = restoreSourceId(fixture.backupDir);
				markRestoreDestructive(lock);
			} finally {
				releaseRestoreLock(lock);
			}

			assert.strictEqual(readRestoreReceipt(fixture.dir).kind, 'absent');
			assert.strictEqual(unpublishedRestoreBlocksComponents(), undefined, 'every other component still loads');
			assert.strictEqual(checkRestoreState(fixture.dir), 'incomplete');
			assert.strictEqual(loadedItems(fixture.name), undefined, 'the database itself stays blocked');
			await restoreBackupOffline(fixture.name, fixture.backupIds[0]);
			assert.strictEqual(restoreMarkerPresent(fixture.dir), false);
			assert.deepStrictEqual(await snapshot(loadedItems(fixture.name)), fixture.backedUp[0]);
		});

		it('keeps components off the target when a restore that took over a terminal restart restore fails', async function () {
			const fixture = await seededDatabase();
			const unprovable = await unprovableBackup(fixture);
			await requestRestore(fixture.name, { on_restart: true, retain_previous: false });
			await closeDatabase(fixture.name);
			rewriteReceipt(fixture.dir, { state: 'terminal', attempts: 3 }, { marker: true });

			await assert.rejects(restoreBackupOffline(fixture.name, unprovable), /rerun restore_backup to recover/);

			const taken = receiptOf(fixture.dir);
			assert.strictEqual(taken.route, 'offline');
			assert.ok(taken.superseded_from, 'the takeover keeps the restart trail');
			assert.strictEqual(unpublishedRestoreBlocksComponents(), fixture.name);
			await restoreBackupOffline(fixture.name, fixture.backupIds[0]);
			assert.strictEqual(unpublishedRestoreBlocksComponents(), undefined);
		});

		it('restarts once an ordinary restore publishes the last restore that kept components off', async function () {
			const fixtures = [await seededDatabase(), await seededDatabase()];
			for (const fixture of fixtures) {
				await requestRestore(fixture.name, { on_restart: true, retain_previous: false });
				await closeDatabase(fixture.name);
				rewriteReceipt(fixture.dir, { state: 'terminal', attempts: 3 }, { marker: true });
			}
			// what loadRootComponents latches for this boot
			process.env.HARPER_SAFE_MODE = 'restore-unpublished';
			const restarts = [];
			const restoreRestart = replaceExport(restartModule, 'restart', async (...args) => {
				restarts.push(args);
			});
			try {
				const [first, last] = fixtures;
				const kept = await requestRestore(first.name, { backup_id: first.backupIds[0] });
				assert.strictEqual(kept.result.restarting, undefined, 'the other restore still keeps components off');
				assert.strictEqual(kept.result.afterRecorded, undefined);

				const { jobId, result } = await requestRestore(last.name, { backup_id: last.backupIds[0] });
				assert.strictEqual(result.result?.restarting, true);
				assert.deepStrictEqual(restarts, [], 'not before the job row records the restore');
				result.afterRecorded();
				assert.deepStrictEqual(restarts, [[{ operation: 'restart', drain: true }]]);
				assert.strictEqual((await job(jobId)).status, JOB_STATUS_ENUM.COMPLETE);
				assert.deepStrictEqual(await snapshot(loadedItems(last.name)), last.backedUp[0]);
			} finally {
				restoreRestart();
			}
		});

		it('restarts once an ordinary restore that fails before replacing anything drops the last restore that kept components off', async function () {
			const fixture = await seededDatabase();
			const [backupId] = fixture.backupIds;
			await requestRestore(fixture.name, { on_restart: true, retain_previous: false });
			await closeDatabase(fixture.name);
			rewriteReceipt(fixture.dir, { state: 'terminal', attempts: 3 });
			process.env.HARPER_SAFE_MODE = 'restore-unpublished';
			const restarts = [];
			const restoreRestart = replaceExport(restartModule, 'restart', async (...args) => {
				restarts.push(args);
			});
			const repair = breakBackup(fixture, backupId);
			try {
				let failure;
				await assert.rejects(requestRestore(fixture.name, { backup_id: backupId }), (error) => {
					failure = error;
					return true;
				});
				assert.strictEqual(readRestoreReceipt(fixture.dir).kind, 'absent', 'precondition: nothing blocks now');
				assert.strictEqual(restoreMarkerPresent(fixture.dir), false, 'precondition: nothing was replaced');
				assert.deepStrictEqual(restarts, [], 'not before the job row records the failure');
				failure.afterRecorded();
				assert.deepStrictEqual(restarts, [[{ operation: 'restart', drain: true }]]);
			} finally {
				repair();
				restoreRestart();
			}
		});

		it('refuses a restore over a record that cannot be read, telling a client how to remove it and never where it is', async function () {
			const fixture = await seededDatabase();
			const [backupId] = fixture.backupIds;
			await requestRestore(fixture.name, { on_restart: true, retain_previous: false });
			const receiptPath = restoreReceiptPath(fixture.dir);
			// a read error's own message names the file; a mode cannot deny the read on Windows, or to root
			if (process.platform !== 'win32' && process.getuid?.() !== 0) {
				chmodSync(receiptPath, 0o000);
				try {
					await assert.rejects(restoreBackup({ ...SU, database: fixture.name, backup_id: backupId }), (error) => {
						assert.strictEqual(error.statusCode, 409);
						assert.match(error.message, /cannot be read \(EACCES\).*restore_backup cancel=true/);
						assert.ok(!error.message.includes(dirname(fixture.dir)), error.message);
						return true;
					});
				} finally {
					chmodSync(receiptPath, 0o600);
				}
			}
			writeFileSync(receiptPath, '{"version":1,"state":');
			await assert.rejects(
				restoreBackup({ ...SU, database: fixture.name, backup_id: backupId }),
				(error) => error.statusCode === 409 && /cannot be read \(not valid JSON\).*cancel=true/.test(error.message)
			);
			await closeDatabase(fixture.name);
			await assert.rejects(
				restoreBackupOffline(fixture.name, backupId),
				(error) => error.statusCode === 409 && error.message.includes(restoreReceiptPath(fixture.dir))
			);
			await restoreBackup({ ...SU, database: fixture.name, cancel: true });
		});

		it('removes a receipt that cannot be read', async function () {
			const fixture = await seededDatabase();
			await requestRestore(fixture.name, { on_restart: true });
			await closeDatabase(fixture.name);
			writeFileSync(restoreReceiptPath(fixture.dir), '{"version":1,"state":');
			assert.strictEqual(checkRestoreState(fixture.dir), 'pending', 'an unreadable receipt fails closed');

			const { result, afterRecorded } = await restoreBackup({ ...SU, database: fixture.name, cancel: true });

			assert.strictEqual(result.cancelled, 'unreadable restore record');
			assert.strictEqual(result.still_blocked, false);
			assert.strictEqual(result.restarting, true, 'an unreadable record cannot say whether a boot held it');
			assert.strictEqual(typeof afterRecorded, 'function');
			assert.strictEqual(readRestoreReceipt(fixture.dir).kind, 'absent');
			assert.deepStrictEqual(await snapshot(loadedItems(fixture.name)), fixture.live);
		});
	});
});
