require('../testUtils');
const assert = require('node:assert');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { readFileSync, rmSync } = require('node:fs');
const { setupTestDBPath } = require('../testUtils');
const { table, databases, database } = require('#src/resources/databases');
const { transaction } = require('#src/resources/transaction');
const { replayLogs } = require('#src/resources/replayLogs');
const { DatabaseTransaction } = require('#src/resources/DatabaseTransaction');
const env = require('#src/utility/environment/environmentManager');
const terms = require('#src/utility/hdbTerms');
const { setMainIsWorker } = require('#js/server/threads/manageThreads');

const describeUnlessLmdb = process.env.HARPER_STORAGE_ENGINE === 'lmdb' ? describe.skip : describe;

function spyOnReplayTransactions(onCommit) {
	const outcomes = [];
	const { directCommitSync } = DatabaseTransaction.prototype;
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
	outcomes.restore = () => {
		DatabaseTransaction.prototype.directCommitSync = directCommitSync;
	};
	return outcomes;
}

// The boot replay of a real database holds its `replayLogs` lock for the life of the process and
// its promise settles only on unlock, so a second replay of the same store releases the lock first
// and runs synchronously inside the lock callback.
function replayAgain(rootStore, tables) {
	rootStore.unlock('replayLogs');
	replayLogs(rootStore, tables);
}

// Only the cases a real log cannot produce (entries without an endTxn marker, a replay that outlives
// its wall-clock budget) run against a synthetic stream.
function replayStream(entries, { onCommit, onWrite } = {}) {
	const stagedIn = new Map();
	const stubTable = {
		tableId: 7,
		getResource(target, context) {
			return {
				_writeUpdate(id) {
					onWrite?.(id);
					stagedIn.set(id, context.transaction);
				},
				save() {},
			};
		},
	};
	const stubStore = {
		databaseName: 'stub-boundaries',
		tryLock: () => true,
		purgeLogs: () => [],
		auditStore: {
			getRange: () =>
				entries.map(({ id, key, endTxn, tableId = 7 }) => ({
					type: 'put',
					tableId,
					recordId: id,
					version: key,
					endTxn,
					extendedType: 17,
					getValue: () => ({ id }),
				})),
		},
	};
	const outcomes = spyOnReplayTransactions(onCommit);
	try {
		replayLogs(stubStore, { Stub: stubTable });
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
	return { groups: groups.map(({ ids, outcome }) => ({ ids, outcome })) };
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
			(entry) => entry.version === logKey
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
			replayAgain(database({ database: 'replaysamekey', table: undefined }), databases.replaysamekey);
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

	it('bounds a replay transaction to one native commit however many commits share the key', async function () {
		const ManyCommits = table({
			table: 'ManyCommits',
			database: 'replaymanycommits',
			attributes: [{ name: 'id', isPrimaryKey: true }, { name: 'n' }],
		});
		const logKey = Date.now();
		const commits = 300;
		for (let n = 0; n < commits; n++) {
			await transaction({ timestamp: logKey }, () => ManyCommits.put({ id: 'r' + n, n }));
		}

		const outcomes = spyOnReplayTransactions();
		try {
			replayAgain(database({ database: 'replaymanycommits', table: undefined }), databases.replaymanycommits);
		} finally {
			outcomes.restore();
		}
		const atKey = outcomes.filter(({ transaction }) => transaction.timestamp === logKey);
		assert.strictEqual(atKey.length, commits, 'one replay transaction per native commit');
		assert.deepStrictEqual(
			[...new Set(atKey.map(({ outcome, writes }) => `${outcome}:${writes}`))],
			['committed:1'],
			'no replay transaction stages more than its own commit'
		);
		for (let n = 0; n < commits; n += 37) {
			assert.strictEqual((await ManyCommits.get('r' + n))?.n, n);
		}
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

	it('replays many one-write commits at one key as one transaction each', function () {
		const commits = 5000;
		const stream = [];
		for (let i = 0; i < commits; i++) stream.push({ id: 'r' + i, key: 5, endTxn: true });
		const { groups } = replayStream(stream);
		assert.strictEqual(groups.length, commits);
		assert.deepStrictEqual([...new Set(groups.map(({ ids, outcome }) => `${outcome}:${ids.length}`))], ['committed:1']);
	});

	it('ends a commit at an endTxn marker carried by an entry replay skips', async function () {
		const attributes = [{ name: 'id', isPrimaryKey: true }, { name: 'n' }];
		const Kept = table({ table: 'KeptRows', database: 'replayskipped', attributes });
		const Dropped = table({ table: 'DroppedRows', database: 'replayskipped', attributes });
		const logKey = Date.now();
		// a commit whose last entry belongs to a table the replay does not know, then one whose first does
		await transaction({ timestamp: logKey }, async () => {
			await Kept.put({ id: 'a', n: 1 });
			await Dropped.put({ id: 'x', n: 0 });
		});
		await transaction({ timestamp: logKey }, async () => {
			await Dropped.put({ id: 'y', n: 0 });
			await Kept.put({ id: 'b', n: 2 });
		});
		await transaction({ timestamp: logKey }, () => Kept.put({ id: 'c', n: 3 }));
		const logged = [...Kept.auditStore.getRange({ start: 0, end: Infinity })]
			.filter((entry) => entry.version === logKey)
			.map(({ tableId, recordId, endTxn }) => [tableId === Kept.tableId ? 'kept' : 'dropped', recordId, endTxn]);
		assert.deepStrictEqual(logged, [
			['kept', 'a', false],
			['dropped', 'x', true],
			['dropped', 'y', false],
			['kept', 'b', true],
			['kept', 'c', true],
		]);

		const outcomes = spyOnReplayTransactions();
		try {
			replayAgain(database({ database: 'replayskipped', table: undefined }), { KeptRows: Kept });
		} finally {
			outcomes.restore();
		}
		assert.deepStrictEqual(
			outcomes
				.filter(({ transaction }) => transaction.timestamp === logKey)
				.map(({ outcome, writes }) => [outcome, writes]),
			[
				['committed', 1],
				['committed', 1],
				['committed', 1],
			],
			'a skipped last entry still closes its commit, and a skipped first entry opens none'
		);
	});

	it('still delimits entries without endTxn markers by log key', function () {
		const { groups } = replayStream([
			{ id: 'a', key: 5, endTxn: false },
			{ id: 'b', key: 5, endTxn: false },
			{ id: 'c', key: 6, endTxn: false },
		]);
		assert.deepStrictEqual(groups, [
			{ ids: ['a', 'b'], outcome: 'committed' },
			{ ids: ['c'], outcome: 'committed' },
		]);
	});

	it('aborts on the wall-clock budget only right after a whole commit', function () {
		const configured = env.get(terms.CONFIG_PARAMS.REPLICATION_REPLAYTIMEOUT);
		env.setProperty(terms.CONFIG_PARAMS.REPLICATION_REPLAYTIMEOUT, 1);
		try {
			const { groups } = replayStream(
				[
					{ id: 'a', key: 5, endTxn: false },
					{ id: 'b', key: 5, endTxn: true },
					{ id: 'c', key: 5, endTxn: true },
				],
				{
					// the budget is already spent while a's commit is still open: a per-entry check would
					// abort before b and tear the commit
					onWrite: (id) => {
						if (id !== 'a') return;
						const until = performance.now() + 5;
						while (performance.now() < until);
					},
				}
			);
			assert.deepStrictEqual(groups, [{ ids: ['a', 'b'], outcome: 'committed' }]);
		} finally {
			env.setProperty(terms.CONFIG_PARAMS.REPLICATION_REPLAYTIMEOUT, configured);
		}
	});
});
