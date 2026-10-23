'use strict';

const testUtils = require('../testUtils');
testUtils.preTestPrep();

const assert = require('node:assert');
const { randomBytes, randomUUID } = require('node:crypto');
const { readdirSync, readFileSync, rmSync, writeFileSync } = require('node:fs');
const { join } = require('node:path');
const sinon = require('sinon');
const { writeUnsupportedTableFormat } = require('./fixtures/backupFiles.js');
const env = require('#src/utility/environment/environmentManager');
const { CONFIG_PARAMS, JOB_STATUS_ENUM, SYSTEM_TABLE_NAMES } = require('#src/utility/hdbTerms');
const { closeDatabase, getDatabases, resetDatabases, resolveDatabasePath, table } = require('#src/resources/databases');
const { createBlob, getBlobPathsForDatabaseName } = require('#src/resources/blob');
const { setAnalyticsEnabled } = require('#src/resources/analytics/write');
const { setMainIsWorker } = require('#js/server/threads/manageThreads');
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
	restorePinId,
} = require('#src/dataLayer/rocksdbBackup');
const { readBackupManifest } = require('#src/dataLayer/backupManifest');
const { readBackupPins } = require('#src/dataLayer/backupRepository');
const {
	acquireRestoreLock,
	checkRestoreState,
	markRestoreDestructive,
	releaseRestoreLock,
	restoreMarkerPresent,
	restoreSourceId,
} = require('#src/dataLayer/restoreMarker');
const restoreReceiptModule = require('#src/dataLayer/restoreReceipt');
const { readRestoreReceipt, restoreReceiptPath, writeRestoreReceipt } = restoreReceiptModule;
const {
	finishCommittedRestoresBeforeStartup,
	recoverRestoresAtStartup,
	resetStartupRecoveryForTesting,
	terminalRestoreExists,
} = require('#src/dataLayer/restoreIntent');
const { reconcileInterruptedJobs } = require('#src/server/jobs/jobOwnership');
const { DeferredJobCompletion } = require('#src/server/jobs/deferredJobCompletion');
const restartModule = require('#src/bin/restart');

const describeUnlessLmdb = process.env.HARPER_STORAGE_ENGINE === 'lmdb' ? describe.skip : describe;
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
		sinon.restore();
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
			assert.deepStrictEqual(pinsOf(fixture), [{ pin_id: restorePinId(fixture.dir), backup_id: backupId }]);
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
			const restart = sinon.stub(restartModule, 'restart').resolves();
			const { result } = await requestRestore(fixture.name, { on_restart: true, retain_previous: false });
			assert.ok(restart.notCalled, 'not before the job row says where the job went');

			result.afterRecorded();

			assert.ok(restart.calledOnceWithExactly({ operation: 'restart', drain: true }));
			await restoreBackup({ ...SU, database: fixture.name, cancel: true });
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
			const writes = sinon.spy(restoreReceiptModule, 'writeRestoreReceipt');

			const owned = await boot(fixture.name);

			const states = writes
				.getCalls()
				.filter((call) => call.args[1].database_path === fixture.dir)
				.map((call) => call.args[1].state)
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
			assert.strictEqual(restoreMarkerPresent(fixture.dir), true);
			assert.strictEqual(checkRestoreState(fixture.dir), 'incomplete');
			assert.strictEqual(loadedItems(fixture.name), undefined, 'the name stays blocked');
			assert.deepStrictEqual(pinsOf(fixture), [{ pin_id: restorePinId(fixture.dir), backup_id: backupId }]);
			// the interrupted-job sweep that follows the hook leaves the job to its receipt
			await reconcileInterruptedJobs(owned);
			assert.strictEqual((await job(jobId)).status, JOB_STATUS_ENUM.IN_PROGRESS);

			repair();
			assert.deepStrictEqual([...(await boot(fixture.name))], []);

			assert.strictEqual(readRestoreReceipt(fixture.dir).kind, 'absent');
			assert.strictEqual(restoreMarkerPresent(fixture.dir), false);
			assert.strictEqual((await job(jobId)).status, JOB_STATUS_ENUM.COMPLETE);
			assert.deepStrictEqual(await snapshot(loadedItems(fixture.name)), fixture.backedUp[0]);
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
				assert.strictEqual(terminalRestoreExists(), false);
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
			assert.strictEqual(process.env.HARPER_SAFE_MODE, 'restore-terminal', 'the rest of this boot is safe mode');
			// what the next boot's loadRootComponents reads, before anything else, to start in safe mode
			assert.strictEqual(terminalRestoreExists(), true);
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
			assert.strictEqual(terminalRestoreExists(), false);

			repair();
			await boot(fixture.name);
			assert.strictEqual((await job(resumed.jobId)).status, JOB_STATUS_ENUM.COMPLETE);
			assert.strictEqual((await job(jobId)).status, JOB_STATUS_ENUM.ERROR, 'the terminal job keeps its outcome');
			assert.deepStrictEqual(await snapshot(loadedItems(fixture.name)), fixture.backedUp[0]);
		});

		it('supersedes a pending restore with a different backup, which takes no rollback copy', async function () {
			const fixture = await seededDatabase({ backups: 2 });
			const [first, second] = fixture.backupIds;
			const original = await requestRestore(fixture.name, { on_restart: true, backup_id: first });
			const { operation_id: originalOperation } = receiptOf(fixture.dir);

			const replacement = await requestRestore(fixture.name, { on_restart: true, backup_id: second });

			const receipt = receiptOf(fixture.dir);
			assert.notStrictEqual(receipt.operation_id, originalOperation);
			assert.strictEqual(receipt.superseded_from, originalOperation);
			assert.strictEqual(receipt.retain_previous, false);
			assert.strictEqual(receipt.backup_id, second);
			assert.strictEqual(receipt.job_id, replacement.jobId);
			assert.deepStrictEqual(pinsOf(fixture), [{ pin_id: restorePinId(fixture.dir), backup_id: second }]);
			const supersededJob = await job(original.jobId);
			assert.strictEqual(supersededJob.status, JOB_STATUS_ENUM.ERROR);
			assert.strictEqual(supersededJob.message, `Superseded by job ${replacement.jobId}`);

			await boot(fixture.name);

			assert.deepStrictEqual(
				(await listBackupsInDir(fixture.backupDir)).map((backup) => backup.backupId),
				fixture.backupIds
			);
			assert.strictEqual((await job(replacement.jobId)).status, JOB_STATUS_ENUM.COMPLETE);
			assert.deepStrictEqual(await snapshot(loadedItems(fixture.name)), fixture.backedUp[1]);
		});

		it('never counts a failure to finish a committed restore as a failed attempt', async function () {
			const fixture = await seededDatabase();
			const { jobId } = await requestRestore(fixture.name, { on_restart: true, retain_previous: false });
			const { max_attempts: maxAttempts } = receiptOf(fixture.dir);
			await closeDatabase(fixture.name);
			// the last attempt the limit allows, so a miscounted failure would make it terminal
			rewriteReceipt(fixture.dir, { attempts: maxAttempts - 1 });
			// the receipt's own removal is the last finishing step; the job row is written by then
			const removal = sinon
				.stub(restoreReceiptModule, 'removeRestoreReceipt')
				.throws(new Error('the restore metadata directory is unavailable'));

			const owned = await boot(fixture.name);

			assert.ok(removal.called, 'precondition: the finish failed');
			const receipt = receiptOf(fixture.dir);
			assert.strictEqual(receipt.state, 'committed', 'a published restore is only ever finished');
			assert.strictEqual(receipt.last_error, undefined);
			assert.strictEqual(terminalRestoreExists(), false);
			assert.strictEqual(process.env.HARPER_SAFE_MODE, savedSafeMode);
			assert.deepStrictEqual([...owned], [jobId], 'the job stays with its receipt, not the interrupted-job sweep');
			assert.strictEqual((await job(jobId)).status, JOB_STATUS_ENUM.COMPLETE, 'the restore did not fail');
			assert.deepStrictEqual(await snapshot(loadedItems(fixture.name)), fixture.backedUp[0]);

			removal.restore();
			await boot(fixture.name);
			assert.strictEqual(readRestoreReceipt(fixture.dir).kind, 'absent');
			assert.strictEqual((await job(jobId)).status, JOB_STATUS_ENUM.COMPLETE);
		});

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

		it('from applying: removes the receipt but says the marker keeps the database blocked', async function () {
			const fixture = await seededDatabase();
			const [backupId] = fixture.backupIds;
			const { jobId } = await requestRestore(fixture.name, { on_restart: true, retain_previous: false });
			const repair = breakBackup(fixture, backupId);
			await boot(fixture.name);
			repair();
			assert.strictEqual(receiptOf(fixture.dir).state, 'applying');

			const result = await restoreBackup({ ...SU, database: fixture.name, cancel: true });

			assert.strictEqual(result.still_blocked, true);
			assert.strictEqual(readRestoreReceipt(fixture.dir).kind, 'absent');
			assert.strictEqual(checkRestoreState(fixture.dir), 'incomplete');
			assert.deepStrictEqual(pinsOf(fixture), []);
			assert.strictEqual((await job(jobId)).status, JOB_STATUS_ENUM.ERROR);

			// an ordinary restore still recovers it
			await restoreBackupOffline(fixture.name, backupId);
			assert.deepStrictEqual(await snapshot(loadedItems(fixture.name)), fixture.backedUp[0]);
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

	describe('finishCommittedRestoresBeforeStartup', function () {
		it('finishes a committed receipt with no job from its files alone, and leaves one with a job to the hook', async function () {
			const withoutJob = await seededDatabase();
			const withJob = await seededDatabase();
			await restoreBackup({ ...SU, database: withoutJob.name, on_restart: true, retain_previous: false });
			const { jobId } = await requestRestore(withJob.name, { on_restart: true, retain_previous: false });
			for (const fixture of [withoutJob, withJob]) {
				await closeDatabase(fixture.name);
				rewriteReceipt(fixture.dir, { state: 'committed', attempts: 1 }, { marker: true });
			}
			assert.strictEqual(receiptOf(withoutJob.dir).job_id, undefined);

			await finishCommittedRestoresBeforeStartup();

			assert.strictEqual(readRestoreReceipt(withoutJob.dir).kind, 'absent');
			assert.strictEqual(restoreMarkerPresent(withoutJob.dir), false);
			assert.deepStrictEqual(pinsOf(withoutJob), []);
			assert.strictEqual(receiptOf(withJob.dir).state, 'committed', 'its job row needs system, which is not open yet');
			assert.strictEqual(restoreMarkerPresent(withJob.dir), true);

			await boot(withJob.name);
			assert.strictEqual(readRestoreReceipt(withJob.dir).kind, 'absent');
			assert.strictEqual((await job(jobId)).status, JOB_STATUS_ENUM.COMPLETE);
		});
	});
});
