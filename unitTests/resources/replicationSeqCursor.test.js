const assert = require('assert');
const { setupTestDBPath } = require('../testUtils');
const { table } = require('#src/resources/databases');
const { setMainIsWorker } = require('#js/server/threads/manageThreads');
const { waitFor } = require('../waitFor');
require('#src/server/serverHelpers/serverUtilities');

// The replication apply loop records a per-peer resume cursor when it finishes applying a
// transaction. On RocksDB `dbisDb.put` is aliased to `putSync` (openRocksDatabase), so writing that
// cursor directly absorbs RocksDB write-stall back-pressure on the apply worker's event loop — a
// single call was measured blocking for 101s during bulk catch-up, which also stops the worker's
// keep-alives and gets the subscription torn down by the sender's watchdog (harper-pro#603). The
// cursor must therefore be staged into a transaction and committed through the natively-async path.
describe('replication sequence-cursor write (harper-pro#603)', () => {
	// RocksDB-only: on LMDB `put` is genuinely async, so the apply loop keeps using it directly.
	if (process.env.HARPER_STORAGE_ENGINE === 'lmdb') return;

	before(function () {
		setupTestDBPath();
		setMainIsWorker(true);
	});

	// A table fed only by an intermediate (replication) source that yields `events` in order, then
	// holds the subscription open until `held` resolves (so the apply loop stays alive for assertions).
	function makeReplicatedTable(name, events, held) {
		const ReplicatedTable = table({
			table: name,
			attributes: [{ name: 'id', isPrimaryKey: true }, { name: 'name' }],
		});
		ReplicatedTable.sourcedFrom(
			{
				subscribeOnThisThread() {
					return true;
				},
				async *subscribe() {
					for (const event of events) yield event;
					await held;
				},
			},
			{ intermediateSource: true }
		);
		return ReplicatedTable;
	}

	const SEQ = Symbol.for('seq');
	const isSeqKey = (key) => Array.isArray(key) && key[0] === SEQ;
	const readCursor = (Table, nodeId) => Table.dbisDB.getSync([SEQ, nodeId]);

	// Observe every cursor write: which ones were staged into a transaction (the async path) and
	// which went straight to the store as a blocking write (the regression this fix removes).
	// `put` is an own property aliased onto putSync at open time, so the two are spied separately.
	function spyOnCursorWrites(Table, onStage) {
		const dbisDB = Table.dbisDB;
		const staged = [];
		const blocking = [];
		const originalPutSync = dbisDB.putSync;
		const originalPut = dbisDB.put;
		dbisDB.putSync = function (key, value, options) {
			if (isSeqKey(key)) {
				if (options?.transaction) {
					staged.push({ key, value, transaction: options.transaction });
					onStage?.(options.transaction);
				} else blocking.push({ key, value });
			}
			return originalPutSync.apply(this, arguments);
		};
		dbisDB.put = function (key, value) {
			if (isSeqKey(key)) blocking.push({ key, value });
			return originalPut.apply(this, arguments);
		};
		return {
			staged,
			blocking,
			restore() {
				dbisDB.putSync = originalPutSync;
				dbisDB.put = originalPut;
			},
		};
	}

	it('stages the cursor into a transaction instead of writing it on the event loop', async function () {
		let release;
		const held = new Promise((resolve) => (release = resolve));
		const now = Date.now();
		const ReplicatedTable = makeReplicatedTable(
			'SeqCursorTable',
			[
				{ type: 'put', id: 1, value: { id: 1, name: 'replicated' }, timestamp: now },
				{ type: 'end_txn', localTime: now, timestamp: now, remoteNodeIds: [41] },
			],
			held
		);
		const spy = spyOnCursorWrites(ReplicatedTable);
		try {
			await waitFor(() => readCursor(ReplicatedTable, 41)?.seqId === now, {
				timeout: 5000,
				message: 'cursor recorded for the peer',
			});
			assert.equal(spy.blocking.length, 0, 'the cursor must never be written with a blocking store write');
			assert.equal(spy.staged.length, 1, 'the cursor must be staged into a transaction');
			assert.equal(spy.staged[0].value.seqId, now);
		} finally {
			spy.restore();
			release();
		}
	});

	it('aborts the cursor transaction when its commit fails, and keeps applying', async function () {
		let release;
		const held = new Promise((resolve) => (release = resolve));
		const now = Date.now();
		// two transactions: the first one's cursor commit is forced to fail, the second must still land
		const ReplicatedTable = makeReplicatedTable(
			'SeqCursorFailTable',
			[
				{ type: 'put', id: 1, value: { id: 1, name: 'first' }, timestamp: now },
				{ type: 'end_txn', localTime: now, timestamp: now, remoteNodeIds: [42] },
				{ type: 'put', id: 2, value: { id: 2, name: 'second' }, timestamp: now + 1 },
				{ type: 'end_txn', localTime: now + 1, timestamp: now + 1, remoteNodeIds: [42] },
			],
			held
		);
		const aborted = [];
		let failNext = true;
		// Fail only the first cursor transaction's commit, leaving the record transactions alone, and
		// record the abort. The stub never commits, so the wrapped abort is what releases the handle.
		const spy = spyOnCursorWrites(ReplicatedTable, (transaction) => {
			if (!failNext) return;
			failNext = false;
			transaction.commit = () =>
				Promise.reject(Object.assign(new Error('forced cursor commit failure'), { code: 'ERR_BUSY' }));
			const originalAbort = transaction.abort.bind(transaction);
			transaction.abort = () => {
				aborted.push(transaction);
				return originalAbort();
			};
		});
		try {
			await waitFor(async () => (await ReplicatedTable.get(2))?.name === 'second', {
				timeout: 5000,
				message: 'apply loop survived the failure',
			});
			assert.equal(aborted.length, 1, 'a failed cursor commit must abort its transaction rather than leak the handle');
			// the failed cursor is not recorded, but the loop is not wedged: the next one is
			await waitFor(() => readCursor(ReplicatedTable, 42)?.seqId === now + 1, {
				timeout: 5000,
				message: 'the next cursor still records',
			});
		} finally {
			spy.restore();
			release();
		}
	});
});
