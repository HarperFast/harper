const assert = require('node:assert');
const { setupTestDBPath } = require('../testUtils');
const { table } = require('#src/resources/databases');
const {
	registerReplicatedApplyFailureListener: register,
	unregisterReplicatedApplyFailureListener: unregister,
} = require('#src/resources/replicatedApplyFailure');
const { getIdOfRemoteNode } = require('#src/resources/nodeIdMapping');
const { waitFor } = require('../waitFor');

const DATABASE = 'replicated-apply-origin-logs';
let serial = 0;

// harper#1162: one RocksDB transaction can append to only one transaction log, and a replicated frame
// can carry records whose origins resolve to different per-origin logs.
describe('replicated apply of a frame spanning origin logs', function () {
	this.timeout(10000);
	const failures = [];
	let failureGate;
	const listener = (failure) => {
		failures.push(failure);
		return failureGate?.promise;
	};
	let held;
	let done;

	before(function () {
		setupTestDBPath();
		const probe = fixture();
		if (typeof probe.Table.auditStore.loadLogs !== 'function') this.skip(); // per-origin logs are RocksDB-only
		register(DATABASE, listener);
	});
	after(() => unregister(DATABASE, listener));
	afterEach(async () => {
		failures.length = 0;
		failureGate?.resolve();
		failureGate = undefined;
		held?.resolve();
		await done?.promise;
		held = done = undefined;
	});

	function deferred() {
		let resolve;
		const promise = new Promise((yes) => (resolve = yes));
		return { promise, resolve };
	}

	function fixture() {
		const Table = table({
			database: DATABASE,
			table: `OriginLogs${++serial}`,
			attributes: [{ name: 'id', isPrimaryKey: true }],
			audit: true,
		});
		const auditStore = Table.auditStore;
		auditStore.loadLogs?.();
		// a node id for a fresh node name, with or without a transaction log of its own
		const node = (name, withLog = true) => {
			const nodeName = `${name}-${serial}`;
			if (withLog) auditStore.ensureLogExists(nodeName);
			return getIdOfRemoteNode(nodeName, auditStore);
		};
		return { Table, auditStore, node };
	}

	function start(Table, events) {
		held = deferred();
		done = deferred();
		const release = held.promise;
		const finished = done;
		Table.sourcedFrom(
			{
				subscribeOnThisThread: () => true,
				async *subscribe() {
					try {
						yield* events;
						await release;
					} finally {
						finished.resolve();
					}
				},
			},
			{ intermediateSource: true }
		);
	}

	function frame(records, via) {
		const timestamp = Date.now() + ++serial;
		const events = records.map(([id, nodeId], index) => ({
			type: 'put',
			id,
			value: { id },
			nodeId,
			viaNodeId: via,
			timestamp,
			version: timestamp,
			beginTxn: index === 0,
		}));
		const end = { type: 'end_txn', localTime: timestamp, remoteNodeIds: [via] };
		return { events: [...events, end], timestamp, end };
	}

	// Entries at `timestamp` in `nodeId`'s log, as [recordId, endTxn] in append order
	function logEntries(auditStore, nodeId, timestamp) {
		const entries = [];
		for (const entry of auditStore.getRange({ log: nodeId, start: timestamp, exactStart: true })) {
			if (entry.txnLogKey !== timestamp) break;
			entries.push([entry.recordId, entry.endTxn]);
		}
		return entries;
	}

	async function applied(Table, end, ids) {
		await waitFor(
			() =>
				failures.length > 0 || Table.dbisDB.getSync([Symbol.for('seq'), end.remoteNodeIds[0]])?.seqId === end.localTime,
			{ message: 'the frame commits and the cursor advances' }
		);
		assert.deepStrictEqual(
			failures.map((failure) => failure.error.message),
			[]
		);
		for (const id of ids) assert.ok(await Table.get(id), `${id} must be applied`);
	}

	it('commits records from two origin logs as one transaction per log', async () => {
		const { Table, auditStore, node } = fixture();
		const via = node('via');
		const originA = node('origin-a');
		const originB = node('origin-b');
		const { events, timestamp, end } = frame(
			[
				['a1', originA],
				['a2', originA],
				['b1', originB],
			],
			via
		);
		start(Table, events);
		await applied(Table, end, ['a1', 'a2', 'b1']);
		assert.deepStrictEqual(logEntries(auditStore, originA, timestamp), [
			['a1', false],
			['a2', true],
		]);
		assert.deepStrictEqual(logEntries(auditStore, originB, timestamp), [['b1', true]]);
		assert.deepStrictEqual(logEntries(auditStore, via, timestamp), []);
	});

	it('writes an interleaved origin as one transaction, never two under the same log key', async () => {
		const { Table, auditStore, node } = fixture();
		const via = node('via');
		const originA = node('origin-a');
		const originB = node('origin-b');
		const { events, timestamp, end } = frame(
			[
				['a1', originA],
				['b1', originB],
				['a2', originA],
				['b2', originB],
			],
			via
		);
		start(Table, events);
		await applied(Table, end, ['a1', 'b1', 'a2', 'b2']);
		assert.deepStrictEqual(logEntries(auditStore, originA, timestamp), [
			['a1', false],
			['a2', true],
		]);
		assert.deepStrictEqual(logEntries(auditStore, originB, timestamp), [
			['b1', false],
			['b2', true],
		]);
		const resumed = auditStore.getRange({
			start: timestamp,
			exactStart: true,
			resumeAfterExactStart: true,
			log: auditStore.nodeLogs[originA].name,
		});
		for (const _entry of resumed);
		assert.deepStrictEqual([...resumed.exactStartFailures], [], 'an exact resume at the frame key stays unambiguous');
	});

	// fail the commit of the apply transaction that `event` is staged in
	function failCommit(event, Table, failure) {
		event.finished = {
			then(resolve) {
				let txn = event.transaction;
				while (!txn.db && txn.next) txn = txn.next;
				txn.addWrite({
					key: `${event.id}-failure`,
					store: Table.primaryStore,
					deferSave: true,
					before: () => Promise.reject(failure),
					commit() {},
				});
				resolve();
			},
		};
	}

	for (const failed of [0, 1, 2]) {
		it(`holds the frame when log transaction ${failed + 1} of 3 fails, and still commits the others`, async () => {
			const { Table, node } = fixture();
			const via = node('via');
			const origins = [node('origin-a'), node('origin-b'), node('origin-c')];
			const ids = origins.map((_origin, index) => `part-${index}`);
			const records = ids.map((id, index) => [id, origins[index]]);
			const failing = frame(records, via);
			const failure = new Error(`part ${failed} commit failure`);
			failCommit(failing.events[failed], Table, failure);
			const unhandled = [];
			const onUnhandled = (reason) => unhandled.push(reason);
			process.on('unhandledRejection', onUnhandled);
			failureGate = deferred();
			try {
				// the same frame again, as a reconnect re-delivers it
				const redelivered = {
					events: frame(records, via).events.map((event) => ({
						...event,
						timestamp: failing.timestamp,
						version: failing.timestamp,
					})),
				};
				redelivered.events.at(-1).localTime = failing.end.localTime;
				start(Table, [...failing.events, ...redelivered.events]);
				await waitFor(() => failures.length > 0, { message: 'the failed part is reported' });
				assert.deepStrictEqual(
					failures.map(({ error, position }) => [error, position]),
					[[failure, failing.timestamp]]
				);
				for (const [index, id] of ids.entries())
					assert.equal(!!(await Table.get(id)), index !== failed, `${id} committed unless it failed`);
				assert.notEqual(
					Table.dbisDB.getSync([Symbol.for('seq'), via])?.seqId,
					failing.end.localTime,
					'the cursor must not advance past a frame with a failed part'
				);
				failures.length = 0;
				failureGate.resolve();
				await applied(Table, failing.end, ids);
				await new Promise(setImmediate);
				assert.deepStrictEqual(unhandled, []);
			} finally {
				process.off('unhandledRejection', onUnhandled);
			}
		});
	}

	it('applies a mixed-origin copy snapshot frame, which writes no audit entry', async () => {
		const { Table, auditStore, node } = fixture();
		const via = node('via');
		const { events, timestamp, end } = frame(
			[
				['copy-a', node('origin-a')],
				['copy-b', node('origin-b')],
			],
			via
		);
		for (const event of events) event.isCopyApply = event.type === 'put';
		start(Table, events);
		await applied(Table, end, ['copy-a', 'copy-b']);
		assert.deepStrictEqual(logEntries(auditStore, via, timestamp), []);
	});

	it('splits a record whose origin has no log, which falls back to the via log', async () => {
		const { Table, auditStore, node } = fixture();
		const via = node('via');
		const live = node('live');
		const removed = node('removed', false);
		const { events, timestamp, end } = frame(
			[
				['gone', removed],
				['kept', live],
			],
			via
		);
		start(Table, events);
		await applied(Table, end, ['gone', 'kept']);
		assert.deepStrictEqual(logEntries(auditStore, via, timestamp), [['gone', true]]);
		assert.deepStrictEqual(logEntries(auditStore, live, timestamp), [['kept', true]]);
	});

	it('keeps one transaction when differing origins resolve to the same log', async () => {
		const { Table, auditStore, node } = fixture();
		const via = node('via');
		const removed = node('removed', false);
		const { events, timestamp, end } = frame(
			[
				['from-removed', removed],
				['from-via', via],
				['from-removed-2', removed],
			],
			via
		);
		start(Table, events);
		await applied(Table, end, ['from-removed', 'from-via', 'from-removed-2']);
		assert.deepStrictEqual(logEntries(auditStore, via, timestamp), [
			['from-removed', false],
			['from-via', false],
			['from-removed-2', true],
		]);
	});
});
