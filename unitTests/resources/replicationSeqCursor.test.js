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

	it('reports a failed cursor commit to the end_txn that carried it, so its source re-sends what it attached', async function () {
		let release;
		const held = new Promise((resolve) => (release = resolve));
		const now = Date.now();
		const txnStream = {};
		const failures = [];
		const ReplicatedTable = makeReplicatedTable(
			'SeqCursorFailureReportTable',
			[
				{ type: 'put', id: 1, value: { id: 1, name: 'first' }, timestamp: now },
				{
					type: 'end_txn',
					localTime: now,
					timestamp: now,
					remoteNodeIds: [47],
					txnStream,
					onFailure: (error, position, afterCommit) => {
						failures.push({ error, afterCommit });
						return false;
					},
				},
				{ type: 'put', id: 3, value: { id: 3, name: 'repeat' }, timestamp: now },
				{ type: 'end_txn', localTime: now, timestamp: now, remoteNodeIds: [47], txnStream, onFailure: () => false },
				{ type: 'put', id: 2, value: { id: 2, name: 'second' }, timestamp: now + 1 },
				{
					type: 'end_txn',
					localTime: now + 1,
					timestamp: now + 1,
					remoteNodeIds: [47],
					txnStream,
					onFailure: () => false,
				},
			],
			held
		);
		let failNext = true;
		const spy = spyOnCursorWrites(ReplicatedTable, (transaction) => {
			if (!failNext) return;
			failNext = false;
			transaction.commit = () => Promise.reject(new Error('forced cursor commit failure'));
		});
		try {
			await waitFor(() => readCursor(ReplicatedTable, 47)?.seqId === now + 1, {
				timeout: 5000,
				message: 'the next cursor still records',
			});
			assert.equal(
				spy.staged.filter(({ value }) => value.seqId === now).length,
				2,
				'the repeated position wrote again'
			);
			assert.equal(failures.length, 1);
			assert.match(failures[0].error.message, /forced cursor commit failure/);
			assert.equal(failures[0].afterCommit, true, 'onCommit already ran, so the source must not release twice');
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

	it('records each generation an origin left on its direct route only, across level-1 certificates, keeping a reversal', async function () {
		let release;
		const held = new Promise((resolve) => (release = resolve));
		const now = Date.now();
		const txnStream = {};
		let localTime = now;
		const floors = (routeId, list) => {
			const event = {
				type: 'end_txn',
				localTime: ++localTime,
				timestamp: localTime,
				remoteNodeIds: [routeId],
				txnStream,
				onFailure: () => false,
			};
			event.onCommit = () => {
				event.originFloors = list;
			};
			return event;
		};
		const generations = Array.from({ length: 10 }, (_, index) => `gen-${index}`);
		const ReplicatedTable = makeReplicatedTable(
			'SeqCursorReplacedGenerationsTable',
			[
				{ type: 'put', id: 1, value: { id: 1, name: 'first' }, timestamp: now },
				floors(53, [
					[53, now - 20, true, 'gen-a', true],
					[21, now - 20, true, 'gen-a', true],
				]),
				floors(53, [
					[53, now - 19, true, 'gen-b', true],
					[21, now - 19, true, 'gen-b', true],
				]),
				floors(53, [[53, now - 18, true]]),
				floors(53, [[53, now - 17, true, 'gen-c', true]]),
				floors(56, [[56, now - 20, true, 'gen-a', true]]),
				floors(56, [[56, now - 19, true, 'gen-b', true]]),
				floors(56, [[56, now - 18, true]]),
				floors(56, [[56, now - 17, true, 'gen-b', true]]),
				floors(56, [[56, now - 16, true]]),
				floors(56, [[56, now - 15, true, 'gen-a', true]]),
				floors(58, [[58, now - 20, true, 'gen-a', true]]),
				floors(58, [[58, now - 10, true]]),
				floors(58, [[58, now - 15, true, 'gen-a', true]]),
				floors(57, [
					[57, now - 20, true, 'gen-a', true],
					[22, now - 20, true, 'gen-a', true],
				]),
				floors(57, [
					[57, now - 10, true],
					[22, now - 10, true],
				]),
				floors(57, [
					[57, now - 15, true, 'gen-b', true],
					[22, now - 15, true, 'gen-b', true],
				]),
				floors(54, [[54, now - 20, true, 'gen-a', true]]),
				floors(54, [[54, now - 19, true, 'gen-b', true]]),
				floors(54, [[54, now - 18, true, 'gen-a', true]]),
				...generations.map((generation, index) => floors(55, [[55, now - 16 + index, true, generation, true]])),
				// back to the oldest listed one: the transition that would drop it keeps it
				...generations
					.slice(0, 9)
					.map((generation, index) => floors(59, [[59, now - 30 + index, true, generation, true]])),
				floors(59, [[59, now - 20, true, 'gen-0', true]]),
			],
			held
		);
		try {
			await waitFor(() => readCursor(ReplicatedTable, 59)?.seqId === localTime, {
				timeout: 5000,
				message: 'the last generation change recorded its sequence id',
			});
			const node = (routeId, id) => readCursor(ReplicatedTable, routeId).nodes.find((state) => state.id === id);
			assert.equal(node(53, 53).originGeneration, 'gen-c');
			assert.deepEqual(node(53, 53).replacedGenerations, ['gen-a', 'gen-b']);
			assert.equal(node(53, 21).originGeneration, 'gen-b');
			assert.equal(node(53, 21).replacedGenerations, undefined, 'a relayed origin is no witness');
			assert.equal(node(54, 54).originGeneration, 'gen-a');
			assert.deepEqual(node(54, 54).replacedGenerations, ['gen-a', 'gen-b']);
			// returning to the generation it left is no transition, until the origin returns to one it replaced
			assert.equal(node(56, 56).originGeneration, 'gen-a');
			assert.deepEqual(node(56, 56).replacedGenerations, ['gen-a', 'gen-b']);
			assert.equal(node(56, 56).lastGeneration, undefined);
			assert.equal(node(58, 58).closedFloor, now - 15);
			for (const id of [57, 22]) {
				assert.equal(node(57, id).originGeneration, 'gen-b');
				assert.equal(node(57, id).closedFloor, now - 15);
			}
			assert.deepEqual(node(57, 57).replacedGenerations, ['gen-a']);
			assert.equal(node(57, 22).replacedGenerations, undefined);
			assert.equal(node(55, 55).originGeneration, 'gen-9');
			assert.deepEqual(node(55, 55).replacedGenerations, generations.slice(1, 9));
			assert.equal(node(59, 59).originGeneration, 'gen-0');
			assert.ok(node(59, 59).replacedGenerations.includes('gen-0'));
			assert.equal(node(59, 59).replacedGenerations.length, 8);
		} finally {
			release();
		}
	});

	it('clears a level-1 floor on a genless revocation and restores a level-2 route coverage from a route mark', async function () {
		let release;
		const held = new Promise((resolve) => (release = resolve));
		const now = Date.now();
		const txnStream = {};
		const update = (fields) => ({
			type: 'end_txn',
			localTime: now,
			timestamp: now,
			remoteNodeIds: [52],
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
			'SeqCursorLevelOneRevocationTable',
			[
				{ type: 'put', id: 1, value: { id: 1, name: 'first' }, timestamp: now },
				floors([
					[11, now - 20, true],
					[12, now - 20, true, 'gen-1', false],
					[13, now - 20, true, 'gen-1', true],
				]),
				// a level-2 route now certifying at level 1 drops its generation, so a later revocation clears it
				floors([[13, now - 18, true]]),
				update({ originFloorRevocations: [13] }),
				// a level-1 floor is cleared, not revoked, so a later certificate floors the route again
				update({ originFloorRevocations: [11] }),
				floors([[11, now - 15, false]]),
				// coverage comes back only for a level-2 row, and only through the mark's own element
				update({ originRouteStates: [[12, undefined, undefined, undefined, 'gen-1']] }),
				update({ originRouteStates: [[11, undefined, undefined, undefined, undefined, true]] }),
				update({ originRouteStates: [[12, undefined, undefined, undefined, 'gen-0', true]] }),
				update({ originRouteStates: [[12, undefined, undefined, undefined, 'gen-1', true]] }),
				{ type: 'put', id: 2, value: { id: 2, name: 'second' }, timestamp: now + 1 },
				update({ localTime: now + 1, timestamp: now + 1 }),
			],
			held
		);
		try {
			await waitFor(() => readCursor(ReplicatedTable, 52)?.seqId === now + 1, {
				timeout: 5000,
				message: 'the frame after the revocation and coverage updates recorded its sequence id',
			});
			const nodes = readCursor(ReplicatedTable, 52).nodes.map((node) => ({ ...node }));
			assert.deepEqual(
				nodes.find((node) => node.id === 11),
				{
					id: 11,
					closedFloor: now - 15,
					relayable: false,
				}
			);
			const downgraded = nodes.find((node) => node.id === 13);
			assert.equal(downgraded.closedFloor, undefined);
			assert.equal(downgraded.relayable, false);
			assert.equal(downgraded.originGeneration, undefined);
			const levelTwo = nodes.find((node) => node.id === 12);
			assert.equal(levelTwo.fullCoverage, true);
			assert.equal(levelTwo.floorRevoked, undefined);
			assert.equal(levelTwo.closedFloor, now - 20);
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

	it('writes the sequence id of a position whose earlier end_txn failed in its onCommit (harper#3669)', async function () {
		let release;
		const held = new Promise((resolve) => (release = resolve));
		const now = Date.now();
		const endTxn = (localTime, onCommit) => ({
			type: 'end_txn',
			localTime,
			timestamp: localTime,
			remoteNodeIds: [46],
			onCommit,
		});
		const ReplicatedTable = makeReplicatedTable(
			'SeqCursorFailedCommitTable',
			[
				{ type: 'put', id: 1, value: { id: 1, name: 'first' }, timestamp: now },
				endTxn(now),
				{ type: 'put', id: 2, value: { id: 2, name: 'second' }, timestamp: now + 1 },
				endTxn(now + 1, () => {
					throw new Error('forced onCommit failure');
				}),
				{ type: 'put', id: 3, value: { id: 3, name: 'third' }, timestamp: now + 1 },
				endTxn(now + 1),
			],
			held
		);
		try {
			await waitFor(() => readCursor(ReplicatedTable, 46)?.seqId === now + 1, {
				timeout: 5000,
				message: 'the repeat of the failed position recorded its sequence id',
			});
		} finally {
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
