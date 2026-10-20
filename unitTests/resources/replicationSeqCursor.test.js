const assert = require('assert');
const { setupTestDBPath, stubMethod } = require('../testUtils');
const { table } = require('#src/resources/databases');
const { setMainIsWorker } = require('#src/server/threads/manageThreads');
const { waitFor } = require('../waitFor');
const { suspendDatabaseCommits } = require('#src/resources/DatabaseTransaction');
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
		const restorePutSync = stubMethod(dbisDB, 'putSync', function (key, value, options) {
			if (isSeqKey(key)) {
				if (options?.transaction) {
					staged.push({ key, value, transaction: options.transaction });
					onStage?.(options.transaction);
				} else blocking.push({ key, value });
			}
			return originalPutSync.apply(this, arguments);
		});
		const restorePut = stubMethod(dbisDB, 'put', function (key, value) {
			if (isSeqKey(key)) blocking.push({ key, value });
			return originalPut.apply(this, arguments);
		});
		return {
			staged,
			blocking,
			restore() {
				restorePutSync();
				restorePut();
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

	it('merges per-origin cursors attached at commit, even when the sequence does not advance', async function () {
		let release;
		const held = new Promise((resolve) => (release = resolve));
		const now = Date.now();
		const endTxn = (localTime, cursors) => {
			const event = { type: 'end_txn', localTime, timestamp: localTime, remoteNodeIds: [44] };
			event.onCommit = () => {
				event.originCursors = cursors;
			};
			return event;
		};
		const ReplicatedTable = makeReplicatedTable(
			'SeqCursorOriginTable',
			[
				{ type: 'put', id: 1, value: { id: 1, name: 'first' }, timestamp: now },
				endTxn(now, [[7, now - 5]]),
				{ type: 'put', id: 2, value: { id: 2, name: 'second' }, timestamp: now },
				endTxn(now, [
					[7, now - 10],
					[8, now],
				]),
				{ type: 'put', id: 3, value: { id: 3, name: 'third' }, timestamp: now },
				endTxn(now, [[8, now - 1]]),
				{ type: 'put', id: 4, value: { id: 4, name: 'fourth' }, timestamp: now + 1 },
				endTxn(now + 1, []),
			],
			held
		);
		const spy = spyOnCursorWrites(ReplicatedTable);
		try {
			await waitFor(() => readCursor(ReplicatedTable, 44)?.seqId === now + 1, {
				timeout: 5000,
				message: 'the last frame recorded its sequence id',
			});
			const cursor = readCursor(ReplicatedTable, 44);
			assert.deepEqual(
				cursor.nodes.map((node) => ({ ...node })),
				[
					{ id: 7, originLogKey: now - 5 },
					{ id: 8, originLogKey: now },
				]
			);
			assert.equal(spy.staged.length, 3, 'a frame that advances nothing writes no cursor');
		} finally {
			spy.restore();
			release();
		}
	});

	it('merges certified origin floors apart from the applied cursors, writing on a floor-only rise', async function () {
		let release;
		const held = new Promise((resolve) => (release = resolve));
		const now = Date.now();
		const txnStream = {};
		const endTxn = (localTime, cursors, floors, withoutOnFailure = false) => {
			const event = { type: 'end_txn', localTime, timestamp: localTime, remoteNodeIds: [46], txnStream };
			if (!withoutOnFailure) event.onFailure = () => false;
			event.onCommit = () => {
				event.originCursors = cursors;
				event.originFloors = floors;
			};
			return event;
		};
		const ReplicatedTable = makeReplicatedTable(
			'SeqCursorFloorTable',
			[
				{ type: 'put', id: 1, value: { id: 1, name: 'first' }, timestamp: now },
				endTxn(now, [[7, now - 5]], [[7, now - 20, true]]),
				endTxn(now, undefined, [[7, now - 10, false]]),
				endTxn(now, undefined, [[7, now - 10, true]]),
				endTxn(now, undefined, [
					[7, now - 15, true],
					[8, now - 30, false],
				]),
				endTxn(now, undefined, [[8, now - 30, false]]),
				endTxn(now, undefined, [[8, now - 1, true]], true),
				endTxn(now, undefined, [[8, NaN, true]]),
				{ type: 'put', id: 2, value: { id: 2, name: 'second' }, timestamp: now + 1 },
				endTxn(now + 1, undefined, undefined),
			],
			held
		);
		const spy = spyOnCursorWrites(ReplicatedTable);
		try {
			await waitFor(() => readCursor(ReplicatedTable, 46)?.seqId === now + 1, {
				timeout: 5000,
				message: 'the frame after the floor frames recorded its sequence id',
			});
			const cursor = readCursor(ReplicatedTable, 46);
			assert.deepEqual(
				cursor.nodes.map((node) => ({ ...node })),
				[
					{ id: 7, originLogKey: now - 5, closedFloor: now - 10, relayable: true },
					{ id: 8, closedFloor: now - 30, relayable: false },
				]
			);
			assert.equal(
				spy.staged.length,
				5,
				'an unchanged floor, a stream without onFailure and a malformed floor each write no cursor'
			);
		} finally {
			spy.restore();
			release();
		}
	});

	it('merges checkpoint-grade qualifiers, route marks and revocations, each on an update of its own', async function () {
		let release;
		const held = new Promise((resolve) => (release = resolve));
		const now = Date.now();
		const txnStream = {};
		const update = (fields) => ({
			type: 'end_txn',
			localTime: now,
			timestamp: now,
			remoteNodeIds: [51],
			txnStream,
			onFailure: () => false,
			...fields,
		});
		const floors = (list) => {
			const event = update({});
			event.onCommit = () => {
				event.originFloors = list;
			};
			return event;
		};
		const ReplicatedTable = makeReplicatedTable(
			'SeqCursorQualifierTable',
			[
				{ type: 'put', id: 1, value: { id: 1, name: 'first' }, timestamp: now },
				floors([[9, now - 20, true, 'gen-1', true]]),
				// a marks-only update reaches the row: a floor-only resume start, then a hole
				update({ originRouteStates: [[9, now - 25, undefined, undefined, 'gen-1']] }),
				update({ originRouteStates: [[9, now - 24, undefined, undefined, 'gen-1']] }),
				// a mark derived under another generation is ignored
				update({ originRouteStates: [[9, now - 30, undefined, undefined, 'gen-0']] }),
				update({ originRouteStates: [[9, undefined, undefined, true]] }),
				// a completed copy makes the route whole again
				update({ originRouteStates: [[9, undefined, false, undefined]] }),
				// a revocation for another generation is ignored; one for the row's clears the floor and sticks
				update({ originFloorRevocations: [[9, 'gen-0']] }),
				update({ originFloorRevocations: [[9, 'gen-1']] }),
				floors([[9, now - 5, true, 'gen-1', true]]),
				// a new origin generation starts the origin over
				floors([[9, now - 3, true, 'gen-2', true]]),
				floors([[9, now - 2, true, 'gen-2', true]]),
				{ type: 'put', id: 2, value: { id: 2, name: 'second' }, timestamp: now + 1 },
				update({ localTime: now + 1, timestamp: now + 1 }),
			],
			held
		);
		try {
			await waitFor(() => readCursor(ReplicatedTable, 51)?.seqId === now + 1, {
				timeout: 5000,
				message: 'the frame after the qualifier updates recorded its sequence id',
			});
			const [state] = readCursor(ReplicatedTable, 51).nodes;
			assert.deepEqual(
				{ ...state },
				{
					id: 9,
					closedFloor: now - 2,
					relayable: true,
					originGeneration: 'gen-2',
					fullCoverage: true,
					certifiedFrom: undefined,
					partialHistory: false,
					hole: undefined,
					floorRevoked: undefined,
				}
			);
		} finally {
			release();
		}
	});

	it('repairs a scalar whose write failed, on a repeat frame whose origin cursors did not change', async function () {
		let release;
		const held = new Promise((resolve) => (release = resolve));
		const now = Date.now();
		const endTxn = (localTime) => {
			const event = { type: 'end_txn', localTime, timestamp: localTime, remoteNodeIds: [45] };
			event.onCommit = () => {
				event.originCursors = [[7, now - 5]];
			};
			return event;
		};
		const ReplicatedTable = makeReplicatedTable(
			'SeqCursorRepairTable',
			[
				{ type: 'put', id: 1, value: { id: 1, name: 'first' }, timestamp: now },
				endTxn(now),
				{ type: 'put', id: 2, value: { id: 2, name: 'second' }, timestamp: now + 1 },
				endTxn(now + 1),
				{ type: 'put', id: 3, value: { id: 3, name: 'third' }, timestamp: now + 1 },
				endTxn(now + 1),
			],
			held
		);
		let staged = 0;
		const spy = spyOnCursorWrites(ReplicatedTable, (transaction) => {
			if (++staged !== 2) return;
			transaction.commit = () =>
				Promise.reject(Object.assign(new Error('forced cursor commit failure'), { code: 'ERR_BUSY' }));
		});
		try {
			await waitFor(() => readCursor(ReplicatedTable, 45)?.seqId === now + 1, {
				timeout: 5000,
				message: 'the repeat frame repaired the scalar',
			});
			assert.equal(staged, 3);
		} finally {
			spy.restore();
			release();
		}
	});

	it('continues replication after teardown denies a cursor commit', async function () {
		let release;
		const held = new Promise((resolve) => (release = resolve));
		const now = Date.now();
		const ReplicatedTable = makeReplicatedTable(
			'SeqCursorSuspendedTable',
			[
				{ type: 'put', id: 1, value: { id: 1, name: 'first' }, timestamp: now },
				{ type: 'end_txn', localTime: now, timestamp: now, remoteNodeIds: [43] },
				{ type: 'put', id: 2, value: { id: 2, name: 'second' }, timestamp: now + 1 },
				{ type: 'end_txn', localTime: now + 1, timestamp: now + 1, remoteNodeIds: [43] },
			],
			held
		);
		let suspension;
		let denyNext = true;
		const spy = spyOnCursorWrites(ReplicatedTable, (transaction) => {
			if (!denyNext) return;
			denyNext = false;
			suspension = suspendDatabaseCommits([ReplicatedTable.primaryStore.rootStore]);
			const abort = transaction.abort.bind(transaction);
			transaction.abort = () => {
				try {
					return abort();
				} finally {
					suspension.release();
				}
			};
		});
		try {
			await waitFor(() => readCursor(ReplicatedTable, 43)?.seqId === now + 1, {
				timeout: 5000,
				message: 'replication resumed after the cursor commit was denied',
			});
			assert.equal(spy.staged.length, 2, 'the apply loop should advance to the next transaction');
		} finally {
			suspension?.release();
			spy.restore();
			release();
		}
	});
});
