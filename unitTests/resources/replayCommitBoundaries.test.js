require('../testUtils');
const assert = require('node:assert');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { readFileSync, rmSync } = require('node:fs');
const { setupTestDBPath } = require('../testUtils');
const { table, databases, database } = require('#src/resources/databases');
const { transaction } = require('#src/resources/transaction');
const { replayLogs } = require('#src/resources/replayLogs');
const { REPLAY_NO_PROGRESS_COUNT_LIMIT } = require('#src/resources/replayLogsGuards');
const { DatabaseTransaction } = require('#src/resources/DatabaseTransaction');
const { RequestTarget } = require('#src/resources/RequestTarget');
const { getIdOfRemoteNode } = require('#src/resources/nodeIdMapping');
const env = require('#src/utility/environment/environmentManager');
const terms = require('#src/utility/hdbTerms');
const { setMainIsWorker } = require('#js/server/threads/manageThreads');

const describeUnlessLmdb = process.env.HARPER_STORAGE_ENGINE === 'lmdb' ? describe.skip : describe;

// Call-through observers: replay transactions are internal to replayLogs, and a commit boundary is
// not otherwise observable before the process runs out of heap.
function spyOnReplayTransactions(onCommit) {
	const outcomes = [];
	const { directCommitSync, abort } = DatabaseTransaction.prototype;
	DatabaseTransaction.prototype.directCommitSync = function () {
		if (this.isReplay) {
			onCommit?.(this);
			const writes = this.writes.length;
			const result = directCommitSync.call(this);
			outcomes.push({ transaction: this, outcome: 'committed', writes });
			return result;
		}
		return directCommitSync.call(this);
	};
	DatabaseTransaction.prototype.abort = function (...args) {
		if (this.isReplay && !outcomes.some((entry) => entry.transaction === this))
			outcomes.push({ transaction: this, outcome: 'aborted', writes: this.writes.length });
		return abort.apply(this, args);
	};
	outcomes.restore = () => {
		DatabaseTransaction.prototype.directCommitSync = directCommitSync;
		DatabaseTransaction.prototype.abort = abort;
	};
	return outcomes;
}

async function replayStream(entries, { truncatedVersions = new Set(), elected = true, onCommit } = {}) {
	const stagedIn = new Map();
	let unlocked = false;
	const stubTable = {
		tableId: 7,
		getResource(target, context) {
			return {
				_writeUpdate(id) {
					stagedIn.set(id, context.transaction);
				},
				save() {},
			};
		},
	};
	const stubStore = {
		databaseName: 'stub-boundaries',
		tryLock: () => true,
		unlock: () => (unlocked = true),
		auditStore: {
			getRange: () =>
				Object.assign(
					entries.map(({ id, key, endTxn, tableId = 7, logName = 'local' }) => ({
						type: 'put',
						tableId,
						recordId: id,
						version: key,
						txnLogKey: key,
						endTxn,
						logName,
						extendedType: 17,
						getValue: () => ({ id }),
					})),
					{ corruptFrameStop: { breaks: truncatedVersions.size, truncatedVersions } }
				),
		},
	};
	const outcomes = spyOnReplayTransactions(onCommit);
	let failure;
	try {
		await replayLogs(stubStore, { Stub: stubTable }, elected);
	} catch (error) {
		failure = error;
	} finally {
		outcomes.restore();
	}
	const groups = [];
	for (const [id, txn] of stagedIn) {
		const group = groups.find((candidate) => candidate.transaction === txn);
		if (group) group.ids.push(id);
		else
			groups.push({
				transaction: txn,
				ids: [id],
				outcome: outcomes.find((entry) => entry.transaction === txn)?.outcome,
			});
	}
	return { groups: groups.map(({ ids, outcome }) => ({ ids, outcome })), failure, unlocked };
}

async function runCrashChild(args) {
	const child = spawn(process.execPath, [path.join(__dirname, 'replayCommitBoundaries-crash.js'), ...args], {
		stdio: ['ignore', 'ignore', 'pipe'],
	});
	let stderr = '';
	child.stderr.on('data', (chunk) => (stderr += chunk));
	const timer = setTimeout(() => child.kill('SIGTERM'), 60000);
	try {
		return await new Promise((resolve, reject) => {
			child.once('error', reject);
			child.once('exit', (code, signal) => resolve({ code, signal, stderr }));
		});
	} finally {
		clearTimeout(timer);
	}
}

describeUnlessLmdb('replay commits once per native transaction (harper#2161)', () => {
	let dbPath;
	before(function () {
		dbPath = setupTestDBPath();
		setMainIsWorker(true);
	});

	it('replays native commits that share a log key as separate transactions, never splitting one', async function () {
		const SameKey = table({
			table: 'SameKeyCommits',
			database: 'replaysamekey',
			attributes: [{ name: 'id', isPrimaryKey: true }, { name: 'n' }],
		});
		// A replication receiver stamps every apply with the origin's log key, so each re-delivery of a
		// source transaction is a new native commit at the same key.
		const logKey = Date.now();
		await transaction({ timestamp: logKey }, () => SameKey.put({ id: 'a', n: 1 }));
		await transaction({ timestamp: logKey }, async () => {
			await SameKey.put({ id: 'b', n: 2 });
			await SameKey.put({ id: 'c', n: 3 });
		});
		await transaction({ timestamp: logKey }, () => SameKey.put({ id: 'd', n: 4 }));

		const logged = [...SameKey.auditStore.getRange({ start: 0, end: Infinity })].filter(
			(entry) => entry.txnLogKey === logKey
		);
		assert.deepStrictEqual(
			logged.map(({ recordId, endTxn }) => [recordId, endTxn]),
			[
				['a', true],
				['b', false],
				['c', true],
				['d', true],
			],
			'each native commit ends with its own endTxn marker'
		);

		const outcomes = spyOnReplayTransactions();
		try {
			await replayLogs(database({ database: 'replaysamekey', table: undefined }), databases.replaysamekey, true);
		} finally {
			outcomes.restore();
		}
		assert.deepStrictEqual(
			outcomes
				.filter(({ transaction }) => transaction.timestamp === logKey)
				.map(({ outcome, writes }) => [outcome, writes]),
			[
				['committed', 1],
				['committed', 2],
				['committed', 1],
			]
		);
		for (const [id, n] of [
			['a', 1],
			['b', 2],
			['c', 3],
			['d', 4],
		]) {
			assert.strictEqual((await SameKey.get(id))?.n, n);
		}
	});

	it('keeps each commit contiguous when two logs hold commits at the same key', async function () {
		const TwoLogs = table({
			table: 'TwoLogCommits',
			database: 'replaytwologs',
			attributes: [{ name: 'id', isPrimaryKey: true }, { name: 'n' }],
		});
		TwoLogs.auditStore.ensureLogExists('peer-a');
		const peerId = getIdOfRemoteNode('peer-a', TwoLogs.auditStore);
		const logKey = Date.now();
		// Applies records the way the replay and replication paths do, so `nodeId` routes the audit
		// entry to that origin's log.
		const commit = (records, nodeId) => {
			const context = { timestamp: logKey };
			return transaction(context, () => {
				for (const record of records) {
					const target = new RequestTarget();
					target.id = null;
					const resource = TwoLogs.getResource(target, context, {});
					resource._writeUpdate(record.id, record, true, { context, nodeId, version: logKey });
					resource.save();
				}
			});
		};
		// interleaved in time across the two logs
		await commit(
			[
				{ id: 'l1', n: 1 },
				{ id: 'l2', n: 2 },
			],
			0
		);
		await commit(
			[
				{ id: 'p1', n: 3 },
				{ id: 'p2', n: 4 },
			],
			peerId
		);
		await commit([{ id: 'l3', n: 5 }], 0);
		await commit([{ id: 'p3', n: 6 }], peerId);

		const merged = [...TwoLogs.auditStore.getRange({ start: 0, end: Infinity, includeLogName: true })]
			.filter((entry) => entry.txnLogKey === logKey)
			.map(({ logName, recordId }) => `${logName}:${recordId}`);
		assert.deepStrictEqual(
			[...merged].sort(),
			['local:l1', 'local:l2', 'local:l3', 'peer-a:p1', 'peer-a:p2', 'peer-a:p3'],
			'every entry at the key comes back from the aggregate range'
		);
		const logSwitches = merged.filter(
			(entry, index) => index > 0 && entry.split(':')[0] !== merged[index - 1].split(':')[0]
		).length;
		assert.strictEqual(logSwitches, 1, `one log's run at a key is never interleaved with another's: ${merged}`);

		const outcomes = spyOnReplayTransactions();
		try {
			await replayLogs(database({ database: 'replaytwologs', table: undefined }), databases.replaytwologs, true);
		} finally {
			outcomes.restore();
		}
		assert.deepStrictEqual(
			outcomes
				.filter(({ transaction }) => transaction.timestamp === logKey)
				.map(({ outcome, writes }) => `${outcome}:${writes}`)
				.sort(),
			['committed:1', 'committed:1', 'committed:2', 'committed:2']
		);
	});

	it('recovers same-key commits one at a time after a crash, through the real database open', async function () {
		const crashDir = path.join(dbPath, 'replay-commit-crash');
		rmSync(crashDir, { recursive: true, force: true });
		const sharedPath = path.join(crashDir, 'shared');
		const markerPath = path.join(crashDir, 'marker');
		const written = await runCrashChild([
			path.join(crashDir, 'writer-root'),
			sharedPath,
			'crashreplay',
			'Rows',
			markerPath,
			'write',
		]);
		assert.strictEqual(
			written.signal,
			'SIGKILL',
			`the writer should kill itself (exit ${written.code}): ${written.stderr}`
		);
		const logKey = readFileSync(markerPath, 'utf8');

		const replayed = await runCrashChild([
			path.join(crashDir, 'replayer-root'),
			sharedPath,
			'crashreplay',
			'Rows',
			markerPath,
			'replay',
			logKey,
		]);
		assert.strictEqual(replayed.code, 0, replayed.stderr);
		const { commits, rows } = JSON.parse(readFileSync(markerPath, 'utf8'));
		assert.deepStrictEqual(commits, [1, 2, 1], 'boot replay commits each native commit as its own transaction');
		assert.deepStrictEqual(rows, { a: 1, b: 2, c: 3, d: 4 });
	});

	it('discards only the torn commit, keeping a complete commit at the same key', async function () {
		const { groups } = await replayStream(
			[
				{ id: 'a', key: 5, endTxn: false },
				{ id: 'b', key: 5, endTxn: true },
				{ id: 'c', key: 5, endTxn: false },
			],
			{ truncatedVersions: new Set([5]) }
		);
		assert.deepStrictEqual(groups, [
			{ ids: ['a', 'b'], outcome: 'committed' },
			{ ids: ['c'], outcome: 'aborted' },
		]);
	});

	it('discards a torn commit even when another log continues at the same key', async function () {
		const { groups } = await replayStream(
			[
				{ id: 'a', key: 5, endTxn: false, logName: 'origin' },
				{ id: 'b', key: 5, endTxn: true, logName: 'via-peer' },
			],
			{ truncatedVersions: new Set([5]) }
		);
		assert.deepStrictEqual(groups, [
			{ ids: ['a'], outcome: 'aborted' },
			{ ids: ['b'], outcome: 'committed' },
		]);
	});

	it('discards the open commit when a boot replay stops for lack of progress inside it', async function () {
		const stream = [{ id: 'a', key: 5, endTxn: false }];
		// a dropped table's entries, enough to trip the no-progress bound before the commit's end
		for (let i = 0; i <= REPLAY_NO_PROGRESS_COUNT_LIMIT; i++)
			stream.push({ id: 'x' + i, key: 5, endTxn: false, tableId: 99 });
		stream.push({ id: 'end', key: 5, endTxn: true, tableId: 99 });
		const { groups, failure } = await replayStream(stream, { elected: false });
		assert.strictEqual(failure, undefined);
		assert.deepStrictEqual(groups, [{ ids: ['a'], outcome: 'aborted' }]);
	});

	it('ends a commit at an endTxn marker carried by a skipped entry', async function () {
		const { groups } = await replayStream([
			{ id: 'a', key: 5, endTxn: false },
			// a table this node no longer has: skipped, but it still closes its native commit
			{ id: 'dropped', key: 5, endTxn: true, tableId: 99 },
			{ id: 'b', key: 5, endTxn: true },
		]);
		assert.deepStrictEqual(groups, [
			{ ids: ['a'], outcome: 'committed' },
			{ ids: ['b'], outcome: 'committed' },
		]);
	});

	it('closes an ended commit before a skipped first entry of the next one', async function () {
		const { groups } = await replayStream([
			{ id: 'a', key: 5, endTxn: true },
			{ id: 'dropped', key: 5, endTxn: false, tableId: 99 },
			{ id: 'b', key: 5, endTxn: true },
		]);
		assert.deepStrictEqual(groups, [
			{ ids: ['a'], outcome: 'committed' },
			{ ids: ['b'], outcome: 'committed' },
		]);
	});

	it('still delimits entries without endTxn markers by log key', async function () {
		const { groups } = await replayStream([
			{ id: 'a', key: 5, endTxn: false },
			{ id: 'b', key: 5, endTxn: false },
			{ id: 'c', key: 6, endTxn: false },
		]);
		assert.deepStrictEqual(groups, [
			{ ids: ['a', 'b'], outcome: 'committed' },
			{ ids: ['c'], outcome: 'committed' },
		]);
	});

	describe('a commit failure at a native commit boundary', () => {
		const stream = [
			{ id: 'a', key: 5, endTxn: true },
			{ id: 'b', key: 5, endTxn: true },
		];
		// The native commit is the one seam with no real failure to provoke; failing it runs
		// directCommitSync's own cleanup.
		const failFirst = () => {
			let failed = false;
			return (replayTransaction) => {
				if (failed) return;
				failed = true;
				replayTransaction.transaction = {
					commitSync() {
						throw new Error('simulated commit failure');
					},
					abort() {},
				};
			};
		};

		it('rejects an elected replay and releases its lock', async function () {
			const { groups, failure, unlocked } = await replayStream(stream, { onCommit: failFirst() });
			assert.match(failure?.message ?? '', /simulated commit failure/);
			assert.strictEqual(unlocked, true, 'a failed strict replay must release the lock for a retry');
			assert.deepStrictEqual(
				groups.map(({ ids }) => ids),
				[['a']],
				'nothing after the failed commit is staged'
			);
		});

		it('logs and continues a boot replay with the next commit', async function () {
			const { groups, failure } = await replayStream(stream, { elected: false, onCommit: failFirst() });
			assert.strictEqual(failure, undefined);
			assert.deepStrictEqual(groups, [
				{ ids: ['a'], outcome: 'aborted' },
				{ ids: ['b'], outcome: 'committed' },
			]);
		});
	});

	it('aborts on the wall-clock budget only right after a whole commit', async function () {
		const configured = env.get(terms.CONFIG_PARAMS.REPLICATION_REPLAYTIMEOUT);
		env.setProperty(terms.CONFIG_PARAMS.REPLICATION_REPLAYTIMEOUT, 1);
		try {
			const { groups, failure } = await replayStream(
				[
					{ id: 'a', key: 5, endTxn: false },
					{ id: 'b', key: 5, endTxn: true },
					{ id: 'c', key: 5, endTxn: true },
				],
				{
					onCommit: () => {
						const until = performance.now() + 5;
						while (performance.now() < until);
					},
				}
			);
			assert.match(failure?.message ?? '', /wall-clock time limit/);
			assert.deepStrictEqual(groups, [{ ids: ['a', 'b'], outcome: 'committed' }]);
		} finally {
			env.setProperty(terms.CONFIG_PARAMS.REPLICATION_REPLAYTIMEOUT, configured);
		}
	});
});
