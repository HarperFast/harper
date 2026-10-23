require('../testUtils');
const assert = require('node:assert');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { cpSync, mkdtempSync, readdirSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { setupTestDBPath } = require('../testUtils');
const { closeDatabase, closeRestoredGeneration, openRestoredGeneration, table } = require('#src/resources/databases');
const { replayLogs } = require('#src/resources/replayLogs');
const auditStore = require('#src/resources/auditStore');
const { setMainIsWorker } = require('#js/server/threads/manageThreads');

const describeUnlessLmdb = process.env.HARPER_STORAGE_ENGINE === 'lmdb' ? describe.skip : describe;

// The replay loop driven over a stub log, as replayCommitBoundaries.test.js does: a stub is the only
// way to put an undecodable value or a torn commit in front of it deterministically.
function stubLog(entries, { truncatedVersions = new Set(), breaks = truncatedVersions.size, failedLogs } = {}) {
	const table = {
		tableId: 7,
		getResource: () => ({ _writeUpdate() {}, save() {} }),
	};
	const store = {
		databaseName: 'stub-restore-policy',
		tryLock: () => true,
		unlock: () => true,
		auditStore: {
			getRange: () =>
				Object.assign(
					entries.map(({ id, key = 5, endTxn = true, getValue = () => ({ id }) }) => ({
						type: 'put',
						tableId: 7,
						recordId: id,
						version: key,
						txnLogKey: key,
						endTxn,
						logName: 'local',
						extendedType: 17,
						getValue,
					})),
					{ corruptFrameStop: { breaks, truncatedVersions }, failedLogs }
				),
		},
	};
	return { store, tables: { Stub: table } };
}

function undecodable() {
	throw new RangeError('Unexpected end of MessagePack data');
}

describe('replayLogs restore policy over a stub log', function () {
	before(function () {
		setMainIsWorker(true);
	});

	it('resolves the summary of a log it replayed completely', async function () {
		const { store, tables } = stubLog([{ id: 'a' }, { id: 'b', key: 6 }]);
		assert.deepStrictEqual(await replayLogs(store, tables, { policy: 'restore' }), {
			writes: 2,
			skipped: 0,
			discardedWrites: 0,
		});
	});

	it('rejects an entry whose value cannot be decoded, which boot replay only skips', async function () {
		const entries = [{ id: 'a' }, { id: 'b', key: 6, getValue: undecodable }];
		const restore = stubLog(entries);
		await assert.rejects(
			replayLogs(restore.store, restore.tables, { policy: 'restore' }),
			/cannot be replayed completely: 1 undecodable entry\. The restore was not published/
		);
		const boot = stubLog(entries);
		assert.deepStrictEqual(await replayLogs(boot.store, boot.tables, { policy: 'boot' }), {
			writes: 1,
			skipped: 1,
			discardedWrites: 0,
		});
	});

	it('rejects a torn transaction, which boot replay discards and continues past', async function () {
		const entries = [{ id: 'whole' }, { id: 'torn', key: 6, endTxn: false }];
		const options = { truncatedVersions: new Set([6]) };
		const restore = stubLog(entries, options);
		await assert.rejects(replayLogs(restore.store, restore.tables, { policy: 'restore' }), (error) => {
			assert.match(error.message, /1 write\(s\) of a torn transaction/);
			assert.match(error.message, /a corrupt transaction-log frame/);
			return true;
		});
		const boot = stubLog(entries, options);
		assert.deepStrictEqual(await replayLogs(boot.store, boot.tables, false), {
			writes: 1,
			skipped: 0,
			discardedWrites: 1,
		});
	});

	it('rejects a corrupt frame even when it truncated no transaction', async function () {
		const { store, tables } = stubLog([{ id: 'a' }], { breaks: 1 });
		await assert.rejects(replayLogs(store, tables, { policy: 'restore' }), /a corrupt transaction-log frame/);
	});

	it('rejects a log file that could not be read', async function () {
		const { store, tables } = stubLog([{ id: 'a' }], { failedLogs: new Set(['peer-a']) });
		await assert.rejects(replayLogs(store, tables, { policy: 'restore' }), /unreadable transaction log peer-a/);
	});

	it('rejects rather than waits when the replay lock is already held', async function () {
		const { store, tables } = stubLog([{ id: 'a' }]);
		store.tryLock = () => false;
		await assert.rejects(replayLogs(store, tables, { policy: 'restore' }), /replay lock .* is already held/);
	});
});

describeUnlessLmdb('replayLogs restore policy over a restored database', function () {
	let dbPath;
	let tempDir;

	before(function () {
		dbPath = setupTestDBPath();
		setMainIsWorker(true);
		tempDir = mkdtempSync(path.join(tmpdir(), 'harper.unit-test.replay-restore-'));
	});

	after(function () {
		rmSync(tempDir, { recursive: true, force: true });
	});

	function runCrashChild(args) {
		const child = spawn(process.execPath, [path.join(__dirname, 'replayCommitBoundaries-crash.js'), ...args], {
			stdio: ['ignore', 'ignore', 'pipe'],
		});
		let stderr = '';
		child.stderr.on('data', (chunk) => (stderr += chunk));
		const timer = setTimeout(() => child.kill('SIGKILL'), 60000);
		return new Promise((resolve, reject) => {
			child.once('error', reject);
			child.once('exit', (code, signal) => {
				clearTimeout(timer);
				resolve({ code, signal, stderr });
			});
		});
	}

	it('replays the unflushed tail of a restored log and resolves its summary', async function () {
		const crashDir = path.join(dbPath, 'replay-restore-policy');
		rmSync(crashDir, { recursive: true, force: true });
		const storagePath = path.join(crashDir, 'storage');
		const written = await runCrashChild([
			path.join(crashDir, 'writer-root'),
			storagePath,
			'replayrestorepolicy',
			'Rows',
			path.join(crashDir, 'marker'),
			'write',
		]);
		assert.strictEqual(written.signal, 'SIGKILL', `the writer should kill itself: ${written.stderr}`);
		const restoredPath = path.join(storagePath, 'replayrestorepolicy');

		const generation = openRestoredGeneration(restoredPath, 'replayrestorepolicy');
		try {
			const summary = await replayLogs(generation.rootStore, generation.tables, { policy: 'restore' });
			assert.deepStrictEqual(summary, { writes: 4, skipped: 0, discardedWrites: 0 });
			const rows = {};
			for (const id of ['a', 'b', 'c', 'd']) rows[id] = (await generation.tables.Rows.get(id))?.n;
			assert.deepStrictEqual(rows, { a: 1, b: 2, c: 3, d: 4 });
		} finally {
			assert.deepStrictEqual(closeRestoredGeneration(restoredPath, generation), []);
		}
	});

	describe('log retention', function () {
		const SOURCE = 'replayretentionsource';
		let sourcePath;
		let originalRetention;

		before(async function () {
			const Logged = table({
				table: 'Logged',
				database: SOURCE,
				audit: true,
				attributes: [{ name: 'id', isPrimaryKey: true }, { name: 'n' }],
			});
			for (let n = 0; n < 5; n++) await Logged.put({ id: n, n });
			sourcePath = Logged.primaryStore.rootStore.path;
			await Logged.primaryStore.rootStore.flush();
			await closeDatabase(SOURCE);
			originalRetention = auditStore.auditRetention;
			// every log file of the source is older than this
			auditStore.setAuditRetention(1);
		});

		after(function () {
			auditStore.setAuditRetention(originalRetention);
		});

		function logFiles(root) {
			const logsDir = path.join(root, 'transaction_logs');
			return readdirSync(logsDir, { recursive: true }).filter((name) => String(name).endsWith('.txnlog'));
		}

		async function replayCopy(name, options) {
			const copy = path.join(tempDir, name);
			cpSync(sourcePath, copy, { recursive: true });
			const before = logFiles(copy);
			assert.ok(before.length > 0, 'precondition: the copy holds transaction-log files');
			const generation = openRestoredGeneration(copy, `replayretention${name}`);
			try {
				await replayLogs(generation.rootStore, generation.tables, options);
			} finally {
				closeRestoredGeneration(copy, generation);
			}
			return { before, after: logFiles(copy) };
		}

		it('keeps every restored log file, however old', async function () {
			const { before, after } = await replayCopy('restore', { policy: 'restore' });
			assert.deepStrictEqual(after.sort(), before.sort());
		});

		it('purges the same files under boot policy', async function () {
			const { before, after } = await replayCopy('boot', { elected: true });
			assert.ok(after.length < before.length, `expected a purge, still have ${after.length} of ${before.length}`);
		});
	});
});
