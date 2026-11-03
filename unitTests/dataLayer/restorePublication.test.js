'use strict';

const testUtils = require('../testUtils');
testUtils.preTestPrep();

const assert = require('node:assert');
const { randomBytes, randomUUID } = require('node:crypto');
const { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join, resolve } = require('node:path');
const { writeUnsupportedTableFormat } = require('./fixtures/backupFiles.js');
const env = require('#src/utility/environment/environmentManager');
const { CONFIG_PARAMS, JOB_STATUS_ENUM, SYSTEM_TABLE_NAMES } = require('#src/utility/hdbTerms');
const {
	closeDatabase,
	databaseRoots,
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
	restoreBackup,
	restoreBackupOffline,
	restorePinId,
} = require('#src/dataLayer/rocksdbBackup');
const { backupPinsDir, readBackupPins } = require('#src/dataLayer/backupRepository');
const {
	acquireRestoreLock,
	checkRestoreState,
	markRestoreDestructive,
	releaseRestoreLock,
	restoreMarkerPresent,
	restoreSourceId,
	restoringMarkerPath,
} = require('#src/dataLayer/restoreMarker');
const restoreReceiptModule = require('#js/dataLayer/restoreReceipt');
const { readRestoreReceipt, restoreReceiptPath, writeRestoreReceipt } = restoreReceiptModule;
const {
	finishCommittedRestoresBeforeStartup,
	finishOutstandingRestore,
	recoverRestoresAtStartup,
	resetStartupRecoveryForTesting,
	scanRestoreReceipts,
} = require('#src/dataLayer/restorePublication');
const restoreChildRunnerModule = require('#js/dataLayer/restoreChildRunner');
const { runRestoreChild } = restoreChildRunnerModule;

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

describeUnlessLmdb('restore publication', function () {
	this.timeout(180000);
	let sequence = 0;
	const databases = [];
	const seededJobs = [];

	before(async function () {
		testUtils.setupTestDBPath();
		setMainIsWorker(true);
		// An analytics flush declares its table, and the rescan that follows reopens every database under
		// the storage path, including one a test has just closed to stand in for a restarted process.
		setAnalyticsEnabled(false);
		await testUtils.ensureSystemTables();
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
	 * API — backed up through create_backup, then changed so the live state differs from the backup in
	 * every record.
	 */
	async function seededDatabase() {
		const name = `restore_publication_${process.pid}_${++sequence}`;
		databases.push(name);
		const Items = table(definition(name));
		await putWithBlob(Items, 'a', 'backed-up', randomBytes(BLOB_BYTES));
		await Items.put({ id: 'only-in-backup', label: 'backed-up' });
		await Items.primaryStore.rootStore.flush();
		const backedUp = await snapshot(Items);
		const backupId = (await createBackup({ database: name })).backup_id;
		await putWithBlob(Items, 'a', 'live', randomBytes(BLOB_BYTES));
		await Items.delete('only-in-backup');
		await Items.put({ id: 'only-live', label: 'live' });
		await Items.primaryStore.rootStore.flush();
		const live = await snapshot(Items);
		return {
			name,
			dir: resolveDatabasePath(name),
			backupDir: backupDirForDatabase(name),
			backupId,
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
	function breakBackup(fixture, backupId = fixture.backupId) {
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
	 * Runs a restore whose child proves the backup and whose publication then fails: nothing runs between
	 * the proof and the commit, so a directory put in the marker's place there makes clearing it, the
	 * publication step, fail as a real unlink does. Leaves a committed receipt, the marker and the source
	 * pin, exactly as a crash on the committed side of the boundary does.
	 */
	async function plantCommittedRestore(fixture, { withJob = false } = {}) {
		const markerPath = restoringMarkerPath(fixture.dir);
		let marker;
		const restoreRunner = replaceExport(restoreChildRunnerModule, 'runRestoreChild', async (...args) => {
			const evidence = await runRestoreChild(...args);
			marker = readFileSync(markerPath);
			rmSync(markerPath);
			mkdirSync(join(markerPath, 'occupied'), { recursive: true });
			return evidence;
		});
		let jobId;
		try {
			if (withJob) {
				await assert.rejects(
					requestRestore(fixture.name, { backup_id: fixture.backupId }).then((outcome) => {
						jobId = outcome.jobId;
					}),
					/was applied and proven but could not be published/
				);
				jobId = seededJobs[seededJobs.length - 1];
			} else {
				await closeDatabase(fixture.name);
				await assert.rejects(
					restoreBackupOffline(fixture.name, fixture.backupId),
					/was applied and proven but could not be published/
				);
			}
		} finally {
			restoreRunner();
		}
		rmSync(markerPath, { recursive: true });
		writeFileSync(markerPath, marker);
		assert.strictEqual(receiptOf(fixture.dir).state, 'committed');
		assert.strictEqual(restoreMarkerPresent(fixture.dir), true);
		return { jobId };
	}

	describe('the publication boundary', function () {
		it('reports a proven restore whose marker could not be cleared as unpublished, and the next claim publishes it', async function () {
			const fixture = await seededDatabase();
			await plantCommittedRestore(fixture);

			assert.strictEqual(loadedItems(fixture.name), undefined, 'the marker still blocks it');

			await finishOutstandingRestore(fixture.dir);

			assert.strictEqual(readRestoreReceipt(fixture.dir).kind, 'absent');
			assert.strictEqual(restoreMarkerPresent(fixture.dir), false);
			assert.deepStrictEqual(pinsOf(fixture), []);
			assert.deepStrictEqual(await snapshot(loadedItems(fixture.name)), fixture.backedUp);
		});

		it('releases the blob fence as a replaced generation when an online restore commits but cannot publish', async function () {
			const fixture = await seededDatabase();
			const signalling = require('#js/utility/signalling');
			const signalSchemaChange = signalling.signalSchemaChange;
			const restoreSignals = [];
			// restoreBackup reads it through the module object; recorded, then passed on to the real one
			const restoreSignalling = replaceExport(signalling, 'signalSchemaChange', (message) => {
				if (message?.restorePhase) restoreSignals.push([message.restorePhase, message.generationReplaced]);
				return signalSchemaChange(message);
			});
			try {
				await plantCommittedRestore(fixture, { withJob: true });
			} finally {
				restoreSignalling();
			}

			// the replaced generation's queued unlinks must not survive into the next restore of it
			assert.deepStrictEqual(restoreSignals, [
				['close', true],
				['reload', true],
			]);

			await finishOutstandingRestore(fixture.dir);
			assert.strictEqual(readRestoreReceipt(fixture.dir).kind, 'absent');
		});

		it('completes the job only after the reload broadcast has returned', async function () {
			const fixture = await seededDatabase();
			const signalling = require('#js/utility/signalling');
			const signalSchemaChange = signalling.signalSchemaChange;
			const statusAtReload = [];
			let jobId;
			const restoreSignalling = replaceExport(signalling, 'signalSchemaChange', async (message) => {
				if (message?.restorePhase === 'reload') {
					statusAtReload.push((await job(jobId)).status);
					statusAtReload.push(receiptOf(fixture.dir).state);
				}
				return signalSchemaChange(message);
			});
			try {
				jobId = await seedJob();
				const saved = process.env.PROCESS_NAME;
				process.env.PROCESS_NAME = `JOB-${jobId}`;
				try {
					await restoreBackup({ ...SU, database: fixture.name, backup_id: fixture.backupId });
				} finally {
					if (saved === undefined) delete process.env.PROCESS_NAME;
					else process.env.PROCESS_NAME = saved;
				}
			} finally {
				restoreSignalling();
			}

			assert.deepStrictEqual(statusAtReload, [JOB_STATUS_ENUM.IN_PROGRESS, 'committed']);
			assert.strictEqual((await job(jobId)).status, JOB_STATUS_ENUM.COMPLETE);
			assert.strictEqual(readRestoreReceipt(fixture.dir).kind, 'absent');
			assert.deepStrictEqual(await snapshot(loadedItems(fixture.name)), fixture.backedUp);
		});

		it('reloads a recovered restore into a new target before completing its job, though the retry refuses the target', async function () {
			const fixture = await seededDatabase();
			const target = `${fixture.name}_copy`;
			databases.push(target);
			const targetDir = resolveDatabasePath(target);
			const markerPath = restoringMarkerPath(targetDir);
			let marker;
			// as in plantCommittedRestore: the proof succeeds, then clearing the marker fails as a real unlink does
			const breakPublication = replaceExport(restoreChildRunnerModule, 'runRestoreChild', async (...args) => {
				const evidence = await runRestoreChild(...args);
				marker = readFileSync(markerPath);
				rmSync(markerPath);
				mkdirSync(join(markerPath, 'occupied'), { recursive: true });
				return evidence;
			});
			let jobId;
			try {
				jobId = await seedJob();
				const saved = process.env.PROCESS_NAME;
				process.env.PROCESS_NAME = `JOB-${jobId}`;
				try {
					await assert.rejects(
						restoreBackup({ ...SU, database: fixture.name, backup_id: fixture.backupId, target_database: target }),
						/was applied and proven but could not be published/
					);
				} finally {
					if (saved === undefined) delete process.env.PROCESS_NAME;
					else process.env.PROCESS_NAME = saved;
				}
			} finally {
				breakPublication();
			}
			rmSync(markerPath, { recursive: true });
			writeFileSync(markerPath, marker);
			assert.strictEqual(receiptOf(targetDir).state, 'committed');
			assert.strictEqual(getDatabases()[target], undefined, 'precondition: no thread has the unpublished target');

			const signalling = require('#js/utility/signalling');
			const signalSchemaChange = signalling.signalSchemaChange;
			const order = [];
			const watchSignals = replaceExport(signalling, 'signalSchemaChange', async (message) => {
				if (message?.restorePhase === 'reload' && message.schema === target) {
					order.push(`reload (job ${(await job(jobId)).status})`);
				}
				return signalSchemaChange(message);
			});
			try {
				// the retry finishes the committed restore first, then refuses the now-populated target
				await assert.rejects(
					restoreBackup({ ...SU, database: fixture.name, backup_id: fixture.backupId, target_database: target }),
					/already exists/
				);
			} finally {
				watchSignals();
			}

			assert.deepStrictEqual(
				order,
				[`reload (job ${JOB_STATUS_ENUM.IN_PROGRESS})`],
				'reloaded once, before the job completed'
			);
			assert.strictEqual((await job(jobId)).status, JOB_STATUS_ENUM.COMPLETE);
			assert.strictEqual(readRestoreReceipt(targetDir).kind, 'absent');
			assert.strictEqual(restoreMarkerPresent(targetDir), false);
			assert.ok(getDatabases()[target]?.Items, 'the reload made the restored target available without a rescan');
		});

		it('removes its receipt before its pin when it fails before destroying anything', async function () {
			const fixture = await seededDatabase();
			await closeDatabase(fixture.name);
			const repair = breakBackup(fixture);
			const pinFile = join(backupPinsDir(fixture.backupDir), `${restorePinId(fixture.dir)}.json`);
			// The claim has pinned the source by the time it starts the child: a directory put in the pin's
			// place there makes releasing the pin fail as a real unlink does.
			const restoreRunner = replaceExport(restoreChildRunnerModule, 'runRestoreChild', (...args) => {
				rmSync(pinFile);
				mkdirSync(join(pinFile, 'occupied'), { recursive: true });
				return runRestoreChild(...args);
			});
			try {
				await assert.rejects(restoreBackupOffline(fixture.name, fixture.backupId), /failed verification/);
			} finally {
				restoreRunner();
				repair();
			}

			try {
				assert.ok(existsSync(pinFile), 'precondition: releasing the pin failed');
				assert.strictEqual(
					readRestoreReceipt(fixture.dir).kind,
					'absent',
					'no applying receipt reserves the database the restore never touched'
				);
				assert.strictEqual(checkRestoreState(fixture.dir), 'clear');
			} finally {
				rmSync(pinFile, { recursive: true, force: true });
			}
			assert.deepStrictEqual(await snapshot(loadedItems(fixture.name)), fixture.live);
		});
	});

	describe('a rerun from another backup', function () {
		it("keeps the interrupted attempt's source pinned until its own source proves, then retires it", async function () {
			const fixture = await seededDatabase();
			const first = fixture.backupId;
			const second = (await createBackup({ database: fixture.name })).backup_id;
			await closeDatabase(fixture.name);
			// an attempt from the first backup dies after its marker: the target is destroyed and blocked
			const died = replaceExport(restoreChildRunnerModule, 'runRestoreChild', async (command, args, options) => {
				options.beforeDestruction();
				throw new Error('the restoring process died after the purge');
			});
			try {
				await assert.rejects(restoreBackupOffline(fixture.name, first), /died after the purge/);
			} finally {
				died();
			}
			assert.strictEqual(checkRestoreState(fixture.dir), 'incomplete');
			assert.deepStrictEqual(pinsOf(fixture), [{ pin_id: restorePinId(fixture.dir), backup_id: first }]);

			// a rerun from a backup that fails verification must not cost the blocked database its first source
			const repair = breakBackup(fixture, second);
			try {
				await assert.rejects(restoreBackupOffline(fixture.name, second), /failed verification/);
			} finally {
				repair();
			}
			assert.deepStrictEqual(
				pinsOf(fixture),
				[{ pin_id: restorePinId(fixture.dir), backup_id: first }],
				'the first source stays pinned while the target is blocked; the refused one, never applied, is not'
			);
			const receipt = receiptOf(fixture.dir);
			assert.deepStrictEqual(receipt.superseded_pin_ids, [restorePinId(fixture.dir)]);
			assert.strictEqual(receipt.source_pin_id, undefined);
			assert.strictEqual(receipt.backup_id, second, 'the rerun owns the claim it inherited');

			// a rerun that proves retires every pin
			await restoreBackupOffline(fixture.name, second);
			assert.deepStrictEqual(pinsOf(fixture), []);
			assert.strictEqual(readRestoreReceipt(fixture.dir).kind, 'absent');
			assert.deepStrictEqual(
				await snapshot(loadedItems(fixture.name)),
				fixture.live,
				'the second backup holds the live data'
			);
		});
	});

	describe('startup discovery', function () {
		// SCHEMAS_DATA_PATH places the data database where getDatabases looks for it; recovery must look there too
		it('scans SCHEMAS_DATA_PATH for receipts, so an unfinished restore of data there is found', function () {
			const dataRoot = mkdtempSync(join(tmpdir(), 'harper.unit-test.schemas-data-path-'));
			const savedDataPath = process.env.SCHEMAS_DATA_PATH;
			const savedDatabases = env.get(CONFIG_PARAMS.DATABASES);
			process.env.SCHEMAS_DATA_PATH = dataRoot;
			try {
				assert.ok(databaseRoots().includes(resolve(dataRoot)), JSON.stringify(databaseRoots()));
				const dataDir = join(dataRoot, 'data');
				const lock = acquireRestoreLock(dataDir);
				try {
					writeRestoreReceipt(lock, {
						...restoreReceiptModule.newRestoreReceipt({
							route: 'offline',
							state: 'applying',
							database: 'data',
							database_path: dataDir,
							source_database: 'data',
							backup_dir: join(dataRoot, 'backups'),
							backup_id: 1,
							options: {},
						}),
					});
				} finally {
					releaseRestoreLock(lock);
				}
				assert.ok(
					scanRestoreReceipts().some(
						({ file, read }) => file.startsWith(dataRoot) && read.receipt?.state === 'applying'
					)
				);
			} finally {
				if (savedDataPath === undefined) delete process.env.SCHEMAS_DATA_PATH;
				else process.env.SCHEMAS_DATA_PATH = savedDataPath;
				env.setProperty(CONFIG_PARAMS.DATABASES, savedDatabases);
				rmSync(dataRoot, { recursive: true, force: true });
			}
			assert.ok(!databaseRoots().includes(resolve(dataRoot)));
		});
	});

	describe('finishCommittedRestoresBeforeStartup', function () {
		it('finishes a committed receipt with no job from its files alone, and leaves one with a job to the hook', async function () {
			const withoutJob = await seededDatabase();
			const withJob = await seededDatabase();
			await plantCommittedRestore(withoutJob);
			const { jobId } = await plantCommittedRestore(withJob, { withJob: true });
			await closeDatabase(withJob.name);
			assert.strictEqual(receiptOf(withoutJob.dir).job_id, undefined);
			assert.strictEqual(receiptOf(withJob.dir).job_id, jobId);

			await finishCommittedRestoresBeforeStartup();

			assert.strictEqual(readRestoreReceipt(withoutJob.dir).kind, 'absent');
			assert.strictEqual(restoreMarkerPresent(withoutJob.dir), false);
			assert.deepStrictEqual(pinsOf(withoutJob), []);
			assert.strictEqual(receiptOf(withJob.dir).state, 'committed', 'its job row needs system, which is not open yet');
			assert.strictEqual(restoreMarkerPresent(withJob.dir), true);

			await boot(withJob.name);
			assert.strictEqual(readRestoreReceipt(withJob.dir).kind, 'absent');
			assert.strictEqual((await job(jobId)).status, JOB_STATUS_ENUM.COMPLETE);
			assert.deepStrictEqual(await snapshot(loadedItems(withJob.name)), withJob.backedUp);
		});

		/**
		 * What a restore's process leaves when it dies after recording its claim and before its child marks
		 * the target: the receipt and source pin as they stood when the child was started, and no lock.
		 */
		async function abandonClaim(fixture, route) {
			const receiptFile = restoreReceiptPath(fixture.dir);
			const pinFile = join(backupPinsDir(fixture.backupDir), `${restorePinId(fixture.dir)}.json`);
			let left;
			// a living process releases its claim on the way out; only these files are what a dead one leaves
			const restoreRunner = replaceExport(restoreChildRunnerModule, 'runRestoreChild', async () => {
				left = { receipt: readFileSync(receiptFile), pin: readFileSync(pinFile) };
				throw new Error('the restoring process died');
			});
			try {
				if (route === 'offline') await closeDatabase(fixture.name);
				await assert.rejects(
					route === 'offline'
						? restoreBackupOffline(fixture.name, fixture.backupId)
						: restoreBackup({ ...SU, database: fixture.name, backup_id: fixture.backupId }),
					/the restoring process died/
				);
			} finally {
				restoreRunner();
			}
			await closeDatabase(fixture.name);
			writeFileSync(receiptFile, left.receipt);
			writeFileSync(pinFile, left.pin);
			const receipt = receiptOf(fixture.dir);
			assert.deepStrictEqual([receipt.route, receipt.state], [route, 'applying']);
			assert.strictEqual(receipt.source_pin_id, restorePinId(fixture.dir));
			assert.strictEqual(restoreMarkerPresent(fixture.dir), false);
			assert.strictEqual(checkRestoreState(fixture.dir), 'pending', 'precondition: the claim reserves the database');
			return receipt;
		}

		for (const route of ['online', 'offline']) {
			it(`drops an ${route} restore abandoned before it marked its target, with its pin, beside a committed one it finishes`, async function () {
				const abandoned = await seededDatabase();
				const committed = await seededDatabase();
				const receipt = await abandonClaim(abandoned, route);
				assert.deepStrictEqual(pinsOf(abandoned), [
					{ pin_id: restorePinId(abandoned.dir), backup_id: receipt.backup_id },
				]);
				assert.strictEqual(loadedItems(abandoned.name), undefined, 'precondition: the claim blocks discovery');
				await plantCommittedRestore(committed);
				await closeDatabase(abandoned.name);

				await finishCommittedRestoresBeforeStartup();

				assert.strictEqual(readRestoreReceipt(abandoned.dir).kind, 'absent');
				assert.deepStrictEqual(pinsOf(abandoned), []);
				assert.strictEqual(checkRestoreState(abandoned.dir), 'clear');
				assert.strictEqual(readRestoreReceipt(committed.dir).kind, 'absent', 'a committed receipt is still finished');
				assert.strictEqual(restoreMarkerPresent(committed.dir), false);
				assert.deepStrictEqual(await snapshot(loadedItems(abandoned.name)), abandoned.live, 'loads as it was');
				assert.deepStrictEqual(await snapshot(loadedItems(committed.name)), committed.backedUp);
			});
		}

		it('keeps an abandoned claim whose target is marked, since its destruction may have begun', async function () {
			const fixture = await seededDatabase();
			const receipt = await abandonClaim(fixture, 'offline');
			const lock = acquireRestoreLock(fixture.dir);
			try {
				lock.source = restoreSourceId(fixture.backupDir);
				markRestoreDestructive(lock);
			} finally {
				releaseRestoreLock(lock);
			}

			await finishCommittedRestoresBeforeStartup();

			assert.deepStrictEqual(receiptOf(fixture.dir), receipt);
			assert.deepStrictEqual(pinsOf(fixture), [{ pin_id: restorePinId(fixture.dir), backup_id: receipt.backup_id }]);
			assert.strictEqual(checkRestoreState(fixture.dir), 'incomplete');

			// a rerun recovers it, as it would any interrupted restore
			await restoreBackupOffline(fixture.name, receipt.backup_id);
			assert.deepStrictEqual(await snapshot(loadedItems(fixture.name)), fixture.backedUp);
		});

		it('keeps a marker-less applying claim whose lock is held, since a restore is running', async function () {
			const fixture = await seededDatabase();
			const receipt = await abandonClaim(fixture, 'offline');
			const running = acquireRestoreLock(fixture.dir);
			try {
				await finishCommittedRestoresBeforeStartup();
				assert.deepStrictEqual(receiptOf(fixture.dir), receipt);
				assert.deepStrictEqual(pinsOf(fixture), [{ pin_id: restorePinId(fixture.dir), backup_id: receipt.backup_id }]);
			} finally {
				releaseRestoreLock(running);
			}

			await boot(fixture.name);
			assert.strictEqual(
				readRestoreReceipt(fixture.dir).kind,
				'absent',
				'the startup hook drops it once nothing holds it'
			);
			assert.deepStrictEqual(pinsOf(fixture), []);
			assert.deepStrictEqual(await snapshot(loadedItems(fixture.name)), fixture.live, 'loads as it was');
		});

		it('settles every other receipt when one cannot be settled', async function () {
			const blocked = await seededDatabase();
			const abandoned = await seededDatabase();
			await plantCommittedRestore(blocked);
			await abandonClaim(abandoned, 'offline');

			const holder = acquireRestoreLock(blocked.dir);
			try {
				await finishCommittedRestoresBeforeStartup();
			} finally {
				releaseRestoreLock(holder);
			}

			assert.strictEqual(receiptOf(blocked.dir).state, 'committed', 'precondition: its lock was held');
			assert.strictEqual(readRestoreReceipt(abandoned.dir).kind, 'absent');
			assert.deepStrictEqual(pinsOf(abandoned), []);

			await finishCommittedRestoresBeforeStartup();
			assert.strictEqual(readRestoreReceipt(blocked.dir).kind, 'absent');
			assert.strictEqual(restoreMarkerPresent(blocked.dir), false);
		});
	});
});

describe('recoverRestoresAtStartup latch', function () {
	const databasesModule = require('#js/resources/databases');

	afterEach(function () {
		resetStartupRecoveryForTesting();
	});

	it('returns the same completion on a second call', async function () {
		resetStartupRecoveryForTesting();
		const first = recoverRestoresAtStartup();
		assert.strictEqual(recoverRestoresAtStartup(), first);
		await first;
	});

	it('rejects again, rather than resolving, when the first scan failed', async function () {
		const original = databasesModule.databaseRoots;
		const failure = new Error('simulated scan failure');
		databasesModule.databaseRoots = () => {
			throw failure;
		};
		try {
			resetStartupRecoveryForTesting();
			await assert.rejects(recoverRestoresAtStartup(), failure);
			databasesModule.databaseRoots = original;
			await assert.rejects(recoverRestoresAtStartup(), failure);
		} finally {
			databasesModule.databaseRoots = original;
		}
	});
});
