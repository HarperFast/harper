'use strict';

require('../testUtils');
const assert = require('node:assert');
const { execFileSync, fork } = require('node:child_process');
const { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { fileLockRelease, RocksDatabase, tryFileLock } = require('@harperfast/rocksdb-js');
const { setupTestDBPath } = require('../testUtils');
const { waitFor } = require('../waitFor.js');
const { writeUnsupportedTableFormat } = require('./fixtures/backupFiles.js');
const { closeDatabase, table } = require('#src/resources/databases');
const { setMainIsWorker } = require('#src/server/threads/manageThreads');
const { backupDirForDatabase, createBackupOffline } = require('#src/dataLayer/rocksdbBackup');
const { readBackupManifest } = require('#src/dataLayer/backupManifest');
const { acquireRestoreLock, releaseRestoreLock } = require('#src/dataLayer/restoreMarker');
const { newRestoreReceipt, writeRestoreReceipt } = require('#src/dataLayer/restoreReceipt');
const {
	restoreChildLockPath,
	restoreChildSlotLockPath,
	runRestoreChild,
} = require('#src/dataLayer/restoreChildRunner');

const isPosix = process.platform !== 'win32';
const describeUnlessLmdb = process.env.HARPER_STORAGE_ENGINE === 'lmdb' ? describe.skip : describe;
const CHILD_START_MS = 30000;
const HELD_CHILD_MAX_MS = 120000;
const SOURCE = 'restorechildsource';

function alive(pid) {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return error.code === 'EPERM';
	}
}

// The runner does not expose its child; find it among this process's children.
function restoreChildPids() {
	return execFileSync('ps', ['-A', '-o', 'pid=,ppid=,command='], { encoding: 'utf8' })
		.split('\n')
		.map((line) => line.trim().match(/^(\d+)\s+(\d+)\s+(.*)$/))
		.filter((match) => match && Number(match[2]) === process.pid && match[3].includes('restoreChild'))
		.map((match) => Number(match[1]));
}

function snapshotTree(root) {
	const files = {};
	for (const name of readdirSync(root, { recursive: true }).map(String).sort()) {
		try {
			files[name] = readFileSync(join(root, name), 'utf8');
		} catch (error) {
			if (error.code !== 'EISDIR') throw error;
			files[name] = '<dir>';
		}
	}
	return files;
}

describeUnlessLmdb('restore child', function () {
	this.timeout(120000);
	let tempDir;
	let backupDir;
	let backupId;
	let manifest;
	const held = new Set();

	before(async function () {
		setupTestDBPath();
		setMainIsWorker(true);
		tempDir = mkdtempSync(join(tmpdir(), 'harper.unit-test.restore-child-'));
		const Items = table({
			table: 'Items',
			database: SOURCE,
			attributes: [
				{ name: 'id', isPrimaryKey: true },
				{ name: 'label', indexed: true },
			],
		});
		for (let i = 0; i < 200; i++) await Items.put({ id: i, label: `item-${i % 7}`, pad: 'x'.repeat(100) });
		await Items.primaryStore.rootStore.flush();
		await closeDatabase(SOURCE);
		backupDir = backupDirForDatabase(SOURCE);
		({ backup_id: backupId } = await createBackupOffline(SOURCE));
		manifest = await readBackupManifest(backupDir, backupId);
	});

	afterEach(async function () {
		for (const child of held) child.kill('SIGKILL');
		await waitFor(() => [...held].every((child) => child.exitCode !== null || child.signalCode !== null), {
			timeout: CHILD_START_MS,
			message: 'a held child did not exit',
		});
		held.clear();
	});

	after(function () {
		if (tempDir) rmSync(tempDir, { recursive: true, force: true });
		if (backupDir) rmSync(backupDir, { recursive: true, force: true });
	});

	const verifyArgs = () => ({
		backupDir,
		backupId,
		manifest,
		databaseName: SOURCE,
		verifyWithChecksum: true,
		verifyTables: true,
	});

	const applyArgs = (databasePath) => ({
		databaseName: 'restorechildtarget',
		sourceDatabase: SOURCE,
		databasePath,
		backupDir,
		backupId,
		manifest,
		blobRoots: [join(tempDir, 'target-blobs')],
		probe: false,
		interrupted: false,
	});

	function targetWithSentinel(name) {
		const path = join(tempDir, name);
		mkdirSync(path, { recursive: true });
		writeFileSync(join(path, 'sentinel'), 'present before the child started');
		return path;
	}

	// A child started outside the runner, so a test controls when, and whether, it is authorized.
	async function startHeldChild({ slotLockPath = join(tempDir, `slot-${held.size}.lock`), targetLockPath } = {}) {
		const spec = {
			slotLockPath,
			targetLockPath,
			authorizeTimeoutMs: 600000,
			blockCacheSize: 8 * 1024 * 1024,
			writeBufferManagerSize: 8 * 1024 * 1024,
		};
		const child = fork(require.resolve('#src/dataLayer/restoreChild'), [], {
			env: { ...process.env, HARPER_RESTORE_CHILD_SPEC: JSON.stringify(spec) },
			stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
		});
		held.add(child);
		child.messages = [];
		child.on('message', (message) => child.messages.push(message));
		const deadline = setTimeout(() => child.kill('SIGKILL'), HELD_CHILD_MAX_MS);
		deadline.unref();
		child.exited = new Promise((resolve) =>
			child.once('exit', (code, signal) => {
				clearTimeout(deadline);
				resolve({ code, signal });
			})
		);
		await waitFor(() => child.messages.some((message) => message.type === 'ready'), {
			timeout: CHILD_START_MS,
			message: () => `the held child never reported ready: ${JSON.stringify(child.messages)}`,
		});
		return child;
	}

	// `asIfClaimed` writes the way a claimant would without taking the claim, for the cases where a
	// live child is exactly what makes every claim refuse.
	function writeReceipt(databasePath, fields = {}, { asIfClaimed = false } = {}) {
		const lock = asIfClaimed
			? { token: 0, dbPath: databasePath, preexisting: false }
			: acquireRestoreLock(databasePath);
		try {
			const receipt = newRestoreReceipt({
				route: 'online',
				state: 'applying',
				database: 'restorechildtarget',
				database_path: databasePath,
				source_database: SOURCE,
				backup_dir: backupDir,
				backup_id: backupId,
				options: {},
				...fields,
			});
			receipt.attempts = fields.attempts ?? 1;
			return writeRestoreReceipt(lock, receipt);
		} finally {
			if (!asIfClaimed) releaseRestoreLock(lock);
		}
	}

	describe('verify', function () {
		it('verifies a readable backup', async function () {
			assert.deepStrictEqual(await runRestoreChild('verify', verifyArgs()), { ok: true });
		});

		it('rejects a backup holding a table format this build cannot open, with the reason', async function () {
			const name = `${SOURCE}unsupported`;
			const Unsupported = table({ table: 'Rows', database: name, attributes: [{ name: 'id', isPrimaryKey: true }] });
			for (let i = 0; i < 200; i++) await Unsupported.put({ id: i, pad: 'y'.repeat(100) });
			await Unsupported.primaryStore.rootStore.flush();
			await closeDatabase(name);
			const unsupportedDir = backupDirForDatabase(name);
			try {
				const { backup_id: id } = await createBackupOffline(name);
				const sst = writeUnsupportedTableFormat(unsupportedDir, id);
				await assert.rejects(
					runRestoreChild('verify', {
						...verifyArgs(),
						backupDir: unsupportedDir,
						backupId: id,
						manifest: await readBackupManifest(unsupportedDir, id),
						databaseName: name,
					}),
					(error) => error.message.includes(sst) && /format_version 99/.test(error.message)
				);
			} finally {
				rmSync(unsupportedDir, { recursive: true, force: true });
			}
		});
	});

	describe('admission', function () {
		it('refuses a second child on the instance while one holds the slot, and admits once it is gone', async function () {
			const first = await startHeldChild({ slotLockPath: restoreChildSlotLockPath() });
			await assert.rejects(
				runRestoreChild('verify', verifyArgs()),
				(error) => error.statusCode === 409 && /Another restore or backup verification/.test(error.message)
			);
			first.kill('SIGKILL');
			await first.exited;
			assert.deepStrictEqual(await runRestoreChild('verify', verifyArgs()), { ok: true });
		});

		it('refuses a child for a database whose child-lifetime lock another child holds', async function () {
			const target = join(tempDir, 'locked-target');
			const first = await startHeldChild({ targetLockPath: restoreChildLockPath(target) });
			await assert.rejects(
				runRestoreChild('verify', verifyArgs(), { databasePath: target }),
				(error) =>
					error.statusCode === 409 && /A restore process for this database is still running/.test(error.message)
			);
			assert.deepStrictEqual(
				await runRestoreChild('verify', verifyArgs(), { databasePath: join(tempDir, 'other-target') }),
				{ ok: true },
				'the lock is per database'
			);
			first.kill('SIGKILL');
			await first.exited;
			assert.deepStrictEqual(await runRestoreChild('verify', verifyArgs(), { databasePath: target }), { ok: true });
		});
	});

	describe('receipt authorization', function () {
		it('exits without touching the target when the receipt it was started for is not on disk', async function () {
			const target = targetWithSentinel('no-receipt');
			const before = snapshotTree(target);
			await assert.rejects(
				runRestoreChild('apply-and-prove', applyArgs(target), {
					databasePath: target,
					receipt: { databasePath: target, operationId: 'never-written', attempt: 1 },
				}),
				/exited with code 77 without a result/
			);
			assert.deepStrictEqual(snapshotTree(target), before);
		});

		it("exits without touching the target when the receipt on disk is another operation's", async function () {
			const target = targetWithSentinel('other-receipt');
			writeReceipt(target);
			const before = snapshotTree(target);
			await assert.rejects(
				runRestoreChild('apply-and-prove', applyArgs(target), {
					databasePath: target,
					receipt: { databasePath: target, operationId: 'a-superseded-operation', attempt: 1 },
				}),
				/exited with code 77/
			);
			assert.deepStrictEqual(snapshotTree(target), before);
		});

		it('applies and proves the backup when the receipt names this attempt', async function () {
			const target = targetWithSentinel('authorized');
			const receipt = writeReceipt(target);
			const evidence = await runRestoreChild('apply-and-prove', applyArgs(target), {
				databasePath: target,
				receipt: { databasePath: target, operationId: receipt.operation_id, attempt: 1 },
			});
			assert.deepStrictEqual(evidence.tables, ['Items']);
			assert.strictEqual(evidence.required_stores.Items.length, 2, 'the primary store and the label index');
			assert.deepStrictEqual(evidence.replay, { writes: 0, skipped: 0, discardedWrites: 0 });
			assert.strictEqual(evidence.blobs.blob_integrity, 'verified');
			assert.deepStrictEqual(evidence.blobs.recordsScanned, { Items: 200 });
			assert.ok(!readdirSync(target).includes('sentinel'), 'the restore replaced the target');
		});
	});

	describe('accept_unverified_blobs', function () {
		function run(args, target) {
			const receipt = writeReceipt(target);
			return runRestoreChild('apply-and-prove', args, {
				databasePath: target,
				receipt: { databasePath: target, operationId: receipt.operation_id, attempt: 1 },
			});
		}

		it('still scans every record, so a waived restore of an undecodable record is refused', async function () {
			const name = `${SOURCE}undecodable`;
			const Rows = table({ table: 'Rows', database: name, attributes: [{ name: 'id', isPrimaryKey: true }] });
			for (const id of [1, 3]) await Rows.put({ id });
			await Rows.primaryStore.rootStore.flush();
			// the same column family, without Harper's record encoding, to store bytes no record decodes from
			const raw = RocksDatabase.open(Rows.primaryStore.rootStore.path, {
				name: Rows.primaryStore.name,
				encoding: 'binary',
			});
			try {
				raw.putSync(2, Buffer.from([0xc1, 0xc1, 0xc1]));
			} finally {
				raw.close();
			}
			await closeDatabase(name);
			const undecodableDir = backupDirForDatabase(name);
			try {
				const { backup_id: id } = await createBackupOffline(name);
				const args = {
					...applyArgs(targetWithSentinel('undecodable-target')),
					sourceDatabase: name,
					backupDir: undecodableDir,
					backupId: id,
					manifest: await readBackupManifest(undecodableDir, id),
					acceptUnverifiedBlobs: true,
				};
				await assert.rejects(run(args, args.databasePath), /Could not read record 2 of table Rows/);
			} finally {
				rmSync(undecodableDir, { recursive: true, force: true });
			}
		});

		it('records the waiver and the scan together for a backup that decodes', async function () {
			const target = targetWithSentinel('waived-target');
			const evidence = await run({ ...applyArgs(target), acceptUnverifiedBlobs: true }, target);
			assert.strictEqual(evidence.blobs.waived, true);
			assert.deepStrictEqual(evidence.blobs.recordsScanned, { Items: 200 });
		});
	});

	(isPosix ? describe : describe.skip)('bounded lifetime', function () {
		it('kills a child that outlives its timeout, and frees the slot', async function () {
			const pending = runRestoreChild('verify', verifyArgs(), { timeoutMs: 2000 });
			const settled = pending.then(
				() => 'resolved',
				(error) => error
			);
			const [pid] = await waitFor(() => restoreChildPids().length > 0 && restoreChildPids(), {
				timeout: CHILD_START_MS,
				interval: 5,
				message: 'the runner never started a child',
			});
			// a stopped child cannot finish, so only the timeout can end it
			process.kill(pid, 'SIGSTOP');
			const outcome = await settled;
			assert.match(outcome?.message ?? String(outcome), /did not finish within 2000ms/);
			await waitFor(() => !alive(pid), { timeout: CHILD_START_MS, message: `child ${pid} survived its timeout` });
			assert.deepStrictEqual(await runRestoreChild('verify', verifyArgs()), { ok: true });
		});

		it('kills a child whose destroying message arrives after the run settled, and never lets it destroy', async function () {
			const pidFile = join(tempDir, 'late-child.pid');
			let destructions = 0;
			// the child inherits the parent's runtime flags: this one preloads the late-messaging fixture
			const savedExecArgv = process.execArgv;
			process.execArgv = [...savedExecArgv, '--require', require.resolve('./fixtures/lateRestoreChild.cjs')];
			process.env.HARPER_LATE_CHILD_PID_FILE = pidFile;
			let pending;
			try {
				pending = runRestoreChild('verify', verifyArgs(), { beforeDestruction: () => destructions++ });
			} finally {
				process.execArgv = savedExecArgv;
				delete process.env.HARPER_LATE_CHILD_PID_FILE;
			}
			await assert.rejects(pending, (error) => error.statusCode === 409);
			const pid = Number(readFileSync(pidFile, 'utf8'));
			await waitFor(() => !alive(pid), { timeout: CHILD_START_MS, message: `late child ${pid} was never killed` });
			assert.strictEqual(destructions, 0, 'no marker for a child the runner had already given up on');
		});

		describe('a child stopped before its authorization arrives', function () {
			async function stoppedAuthorizedChild(target) {
				const receipt = writeReceipt(target);
				const child = await startHeldChild({ targetLockPath: restoreChildLockPath(target) });
				child.kill('SIGSTOP');
				child.send({
					type: 'authorize',
					command: 'apply-and-prove',
					args: applyArgs(target),
					receipt: { databasePath: target, operationId: receipt.operation_id, attempt: 1 },
				});
				return child;
			}

			it('exits without engine work once its receipt has been superseded', async function () {
				const target = targetWithSentinel('superseded-while-stopped');
				const before = snapshotTree(target);
				const child = await stoppedAuthorizedChild(target);
				// no claim can be taken while this child lives, but a receipt naming another operation is
				// what it must refuse to act on however it got there
				assert.throws(() => acquireRestoreLock(target), /a restore process for it is still running/);
				writeReceipt(target, { state: 'committed' }, { asIfClaimed: true });
				child.kill('SIGCONT');
				assert.deepStrictEqual(await child.exited, { code: 77, signal: null });
				assert.deepStrictEqual(
					child.messages.map((message) => message.type),
					['ready']
				);
				assert.deepStrictEqual(snapshotTree(target), before);
			});

			it('holds the database against a rerun while its parent is gone, and exits without engine work on resume', async function () {
				const target = targetWithSentinel('orphaned-while-stopped');
				const before = snapshotTree(target);
				const child = await stoppedAuthorizedChild(target);
				child.disconnect();
				const token = tryFileLock(restoreChildLockPath(target));
				if (token) fileLockRelease(token);
				assert.strictEqual(token, 0, 'a stopped child still holds the database');
				assert.throws(() => acquireRestoreLock(target), /a restore process for it is still running/);
				writeReceipt(target, { state: 'committed' }, { asIfClaimed: true });
				child.kill('SIGCONT');
				const { code } = await child.exited;
				assert.ok([70, 77].includes(code), `exited ${code}, not as an orphaned or unauthorized child`);
				assert.deepStrictEqual(snapshotTree(target), before);
				const released = tryFileLock(restoreChildLockPath(target));
				assert.ok(released, 'its exit released the database');
				fileLockRelease(released);
			});
		});
	});
});

describe('restore child exec arguments', function () {
	const { childExecArgv } = require('#src/dataLayer/restoreChildRunner');

	it('drops code the parent was told to evaluate, its heap size and its debugger, and keeps the rest', function () {
		assert.deepStrictEqual(
			childExecArgv([
				'--conditions=typestrip',
				'-e',
				'require("x")',
				'--eval=1',
				'-p',
				'2',
				'--print=3',
				'--max-old-space-size=8192',
				'--inspect=9229',
				'--enable-source-maps',
			]),
			['--conditions=typestrip', '--enable-source-maps']
		);
	});
});
