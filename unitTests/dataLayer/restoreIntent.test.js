'use strict';

const testUtils = require('../testUtils');
testUtils.preTestPrep();

const assert = require('node:assert');
const { randomBytes, randomUUID } = require('node:crypto');
const { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } = require('node:fs');

const { join } = require('node:path');
const { writeUnsupportedTableFormat } = require('./fixtures/backupFiles.js');
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
	createBackup,
	createPreRestoreBackup,
	deleteBackupOffline,
	listBackups,
	listBackupsInDir,
	purgeBackupsOffline,
	restoreBackup,
	restoreBackupOffline,
} = require('#src/dataLayer/rocksdbBackup');
const backupManifestModule = require('#js/dataLayer/backupManifest');
const { readBackupManifest, writeBackupManifest } = backupManifestModule;
const blobBackupModule = require('#js/dataLayer/blobBackup');
const { blobSnapshotDir, fsyncTree } = blobBackupModule;
const { readBackupPins } = require('#src/dataLayer/backupRepository');
const {
	acquireRestoreLock,
	checkRestoreState,
	droppingMarkerPath,
	markRestoreDestructive,
	releaseRestoreLock,
	restoreLockHeldExclusively,
	restoreMarkerPresent,
	restoreSourceId,
} = require('#src/dataLayer/restoreMarker');
const restoreReceiptModule = require('#js/dataLayer/restoreReceipt');
const { readRestoreReceipt, restoreReceiptPath, writeRestoreReceipt } = restoreReceiptModule;
const {
	jobsNamedByUnfinishedRestores,
	recoverRestoresAtStartup,
	resetStartupRecoveryForTesting,
	unpublishedRestoreBlocksComponents,
} = require('#src/dataLayer/restorePublication');
const restoreChildRunnerModule = require('#js/dataLayer/restoreChildRunner');
const { runRestoreChild } = restoreChildRunnerModule;
const { reconcileInterruptedJobs, settleAbandonedJob } = require('#src/server/jobs/jobOwnership');
const { DeferredJobCompletion } = require('#src/server/jobs/deferredJobCompletion');
const restartModule = require('#js/bin/restart');

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

const SU = { hdb_user: { username: 'admin', role: { permission: { super_user: true } } } };
const BLOB_BYTES = 20000; // over the file-storage threshold, so the blob lives in a blob root

describeUnlessLmdb('restore_backup on_restart', function () {
	this.timeout(180000);
	let sequence = 0;
	const databases = [];
	const seededJobs = [];
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

	afterEach(function () {
		if (savedSafeMode === undefined) delete process.env.HARPER_SAFE_MODE;
		else process.env.HARPER_SAFE_MODE = savedSafeMode;
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
			result.onNotRecorded();

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

			result.onNotRecorded();

			assert.strictEqual(readRestoreReceipt(fixture.dir).kind, 'absent');
			assert.deepStrictEqual(pinsOf(fixture), []);
			assert.strictEqual(checkRestoreState(fixture.dir), 'clear');
		});

		it("leaves a resumed restore to its new job when the older job's row cannot record the deferral", async function () {
			const fixture = await seededDatabase();
			const original = await requestRestore(fixture.name, { on_restart: true, retain_previous: false });
			const resumed = await requestRestore(fixture.name, { resume: true });

			original.result.onNotRecorded();

			const kept = receiptOf(fixture.dir);
			assert.strictEqual(kept.state, 'pending');
			assert.strictEqual(kept.job_id, resumed.jobId);
			assert.deepStrictEqual(pinsOf(fixture), [{ pin_id: kept.source_pin_id, backup_id: kept.backup_id }]);
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
			const named = jobsNamedByUnfinishedRestores();
			assert.deepStrictEqual([...named], [jobId]);
			await reconcileInterruptedJobs(named);
			assert.strictEqual((await job(jobId)).status, JOB_STATUS_ENUM.IN_PROGRESS);

			repair();
			assert.deepStrictEqual([...(await boot(fixture.name))], []);
			assert.deepStrictEqual([...jobsNamedByUnfinishedRestores()], []);

			assert.strictEqual(readRestoreReceipt(fixture.dir).kind, 'absent');
			assert.strictEqual(restoreMarkerPresent(fixture.dir), false);
			assert.strictEqual((await job(jobId)).status, JOB_STATUS_ENUM.COMPLETE);
			assert.deepStrictEqual(await snapshot(loadedItems(fixture.name)), fixture.backedUp[0]);
		});

		it('starts the next boot in safe mode once an attempt took its rollback copy, so nothing writes past it', async function () {
			const fixture = await seededDatabase();
			const [backupId] = fixture.backupIds;
			const { jobId } = await requestRestore(fixture.name, { on_restart: true, retain_previous: true });
			const repair = breakBackup(fixture, backupId);

			await boot(fixture.name);

			const failed = receiptOf(fixture.dir);
			assert.ok(Number.isInteger(failed.pre_restore_backup_id), 'precondition: the rollback copy was taken');
			assert.strictEqual(restoreMarkerPresent(fixture.dir), false, 'precondition: refused before the purge');
			assert.strictEqual(
				unpublishedRestoreBlocksComponents(),
				fixture.name,
				'a component that opens the database itself could write past the copy the next attempt replaces it with'
			);

			repair();
			await boot(fixture.name);
			assert.strictEqual(unpublishedRestoreBlocksComponents(), undefined);
			assert.strictEqual((await job(jobId)).status, JOB_STATUS_ENUM.COMPLETE);
			assert.deepStrictEqual(await snapshot(loadedItems(fixture.name)), fixture.backedUp[0]);
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
			await closeDatabase(fixture.name);

			const result = await restoreBackup({ ...SU, database: fixture.name, cancel: true });

			assert.strictEqual(result.cancelled, operationId);
			assert.strictEqual(result.still_blocked, false);
			assert.strictEqual(readRestoreReceipt(fixture.dir).kind, 'absent');
			assert.strictEqual(checkRestoreState(fixture.dir), 'clear');
			assert.deepStrictEqual(pinsOf(fixture), []);
			const cancelled = await job(jobId);
			assert.strictEqual(cancelled.status, JOB_STATUS_ENUM.ERROR);
			assert.strictEqual(cancelled.message, 'Cancelled');
			assert.deepStrictEqual(await snapshot(loadedItems(fixture.name)), fixture.live, 'nothing was replaced');
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

		it('from applying before the purge: removes the receipt and unblocks the untouched database', async function () {
			const fixture = await seededDatabase();
			const [backupId] = fixture.backupIds;
			const { jobId } = await requestRestore(fixture.name, { on_restart: true, retain_previous: false });
			const repair = breakBackup(fixture, backupId);
			await boot(fixture.name);
			repair();
			assert.strictEqual(receiptOf(fixture.dir).state, 'applying');
			assert.strictEqual(restoreMarkerPresent(fixture.dir), false, 'verification refused before the purge');

			const result = await restoreBackup({ ...SU, database: fixture.name, cancel: true });

			assert.strictEqual(result.still_blocked, false);
			assert.strictEqual(readRestoreReceipt(fixture.dir).kind, 'absent');
			assert.strictEqual(checkRestoreState(fixture.dir), 'clear');
			assert.deepStrictEqual(pinsOf(fixture), []);
			assert.strictEqual((await job(jobId)).status, JOB_STATUS_ENUM.ERROR);
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

			const result = await restoreBackup({ ...SU, database: fixture.name, cancel: true });

			assert.strictEqual(result.still_blocked, true);
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

			await assert.rejects(
				restoreBackup({ ...SU, database: fixture.name, cancel: true }),
				(error) => error.statusCode === 409 && /cannot be cancelled/.test(error.message)
			);
			assert.strictEqual(receiptOf(fixture.dir).state, 'committed');

			await boot(fixture.name);
			assert.strictEqual((await job(jobId)).status, JOB_STATUS_ENUM.COMPLETE);
		});

		it('keeps components off a half-replaced database after its unreadable record is removed', async function () {
			const fixture = await seededDatabase();
			await requestRestore(fixture.name, { on_restart: true, retain_previous: false });
			await closeDatabase(fixture.name);
			rewriteReceipt(fixture.dir, { state: 'applying', attempts: 1 }, { marker: true });
			writeFileSync(restoreReceiptPath(fixture.dir), '{"version":1,"state":');

			await restoreBackup({ ...SU, database: fixture.name, cancel: true });

			assert.strictEqual(readRestoreReceipt(fixture.dir).kind, 'absent');
			assert.strictEqual(restoreMarkerPresent(fixture.dir), true, 'the target was being replaced');
			assert.ok(unpublishedRestoreBlocksComponents(), 'the marker alone still starts the boot in safe mode');
			await restoreBackupOffline(fixture.name, fixture.backupIds[0]);
			assert.strictEqual(unpublishedRestoreBlocksComponents(), undefined);
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

		it('removes a receipt that cannot be read', async function () {
			const fixture = await seededDatabase();
			await requestRestore(fixture.name, { on_restart: true });
			await closeDatabase(fixture.name);
			writeFileSync(restoreReceiptPath(fixture.dir), '{"version":1,"state":');
			assert.strictEqual(checkRestoreState(fixture.dir), 'pending', 'an unreadable receipt fails closed');

			const result = await restoreBackup({ ...SU, database: fixture.name, cancel: true });

			assert.strictEqual(result.cancelled, 'unreadable restore record');
			assert.strictEqual(result.still_blocked, false);
			assert.strictEqual(readRestoreReceipt(fixture.dir).kind, 'absent');
			assert.deepStrictEqual(await snapshot(loadedItems(fixture.name)), fixture.live);
		});
	});
});
