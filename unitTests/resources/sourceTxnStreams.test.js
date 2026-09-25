const assert = require('node:assert');
const { setupTestDBPath } = require('../testUtils');
const { table } = require('#src/resources/databases');
const { getIdOfRemoteNode } = require('#src/resources/nodeIdMapping');
const { waitFor } = require('../waitFor');
const {
	registerReplicatedApplyFailureListener,
	unregisterReplicatedApplyFailureListener,
} = require('#src/resources/replicatedApplyFailure');

const DATABASE = 'source-txn-streams';
const NOW = Date.now();
const isRocksDB = process.env.HARPER_STORAGE_ENGINE !== 'lmdb';
let serial = 0;

describe('source transactions keyed by stream', function () {
	this.timeout(10000);
	const subscriptions = [];

	before(() => setupTestDBPath());
	afterEach(async () => {
		for (const { release, done } of subscriptions.splice(0)) {
			release();
			await done;
		}
	});

	function start(events) {
		const Table = table({
			database: DATABASE,
			table: `TxnStreams${++serial}`,
			attributes: [{ name: 'id', isPrimaryKey: true }],
			audit: true,
		});
		let release;
		const held = new Promise((resolve) => (release = resolve));
		let finish;
		const done = new Promise((resolve) => (finish = resolve));
		const applied = [];
		subscriptions.push({ release, done });
		Table.sourcedFrom(
			{
				subscribeOnThisThread: () => true,
				async *subscribe() {
					try {
						for (const event of typeof events === 'function' ? events(Table) : events) {
							yield event;
							applied.push(event);
						}
						await held;
					} finally {
						finish();
					}
				},
			},
			{ intermediateSource: true }
		);
		return { Table, applied };
	}

	function put(id, timestamp, extra = {}) {
		return { type: 'put', id, value: { id }, timestamp, version: timestamp, ...extra };
	}

	function logEntries(Table) {
		const entries = {};
		for (const entry of Table.auditStore.getRange({ start: 0, includeLogName: true })) {
			if (entry.recordId !== undefined)
				entries[entry.recordId] = { key: entry.txnLogKey ?? entry.version, log: entry.logName };
		}
		return entries;
	}

	async function recordIds(Table, ids) {
		const found = [];
		for (const id of ids) if (await Table.get(id)) found.push(id);
		return found;
	}

	it('keeps each stream in its own transaction when their events interleave', async () => {
		const streamA = {};
		const streamB = {};
		const { Table } = start([
			put('a1', NOW + 0.1, { beginTxn: true, txnStream: streamA }),
			put('b1', NOW + 1.1, { beginTxn: true, txnStream: streamB }),
			put('a2', NOW + 0.1, { txnStream: streamA }),
			put('b2', NOW + 1.1, { txnStream: streamB }),
			{ type: 'end_txn', txnStream: streamA },
			{ type: 'end_txn', txnStream: streamB },
		]);
		await waitFor(async () => (await recordIds(Table, ['a1', 'a2', 'b1', 'b2'])).length === 4);
		if (!isRocksDB) return;
		const entries = logEntries(Table);
		assert.deepEqual(
			['a1', 'a2', 'b1', 'b2'].map((id) => entries[id]?.key),
			[NOW + 0.1, NOW + 0.1, NOW + 1.1, NOW + 1.1]
		);
	});

	it("aborts only the aborting stream's open transaction", async () => {
		const streamA = {};
		const streamB = {};
		const { Table, applied } = start([
			put('a1', NOW + 2.1, { beginTxn: true, txnStream: streamA }),
			put('b1', NOW + 3.1, { beginTxn: true, txnStream: streamB }),
			{ type: 'abort_txn', txnStream: streamA },
			put('b2', NOW + 3.1, { txnStream: streamB }),
			{ type: 'end_txn', txnStream: streamB },
			put('after', NOW + 4.1),
		]);
		await waitFor(() => applied.length === 6);
		await waitFor(async () => (await recordIds(Table, ['after'])).length === 1);
		assert.deepEqual(await recordIds(Table, ['a1', 'b1', 'b2']), ['b1', 'b2']);
	});

	it('does not commit a write still pending when its stream aborts', async () => {
		const stream = {};
		let release;
		const pending = new Promise((resolve) => (release = resolve));
		const { Table, applied } = start(function* () {
			yield put('paused', NOW + 14.1, { beginTxn: true, txnStream: stream, finished: pending });
			yield { type: 'abort_txn', txnStream: stream };
			release();
			yield put('after-abort', NOW + 15.1);
		});
		await waitFor(() => applied.length === 3);
		await waitFor(async () => (await recordIds(Table, ['after-abort'])).length === 1);
		await new Promise((resolve) => setTimeout(resolve, 50));
		assert.deepEqual(await recordIds(Table, ['paused']), []);
	});

	function failingWrite(id, timestamp, extra) {
		return put(id, timestamp, {
			...extra,
			finished: {
				then(resolve, reject) {
					reject(new Error(`injected failure for ${id}`));
				},
			},
		});
	}

	it('holds the cursor and reports a failed earlier segment at the frame end_txn', async () => {
		const stream = {};
		const failures = [];
		let commits = 0;
		const { Table, applied } = start([
			failingWrite('seg-failed', NOW + 9.1, { beginTxn: true, txnStream: stream }),
			put('seg-ok', NOW + 9.1, { beginTxn: true, txnStream: stream }),
			{
				type: 'end_txn',
				txnStream: stream,
				localTime: NOW + 9.1,
				remoteNodeIds: [77],
				onFailure: (error, position) => failures.push([error.message, position]),
				onCommit: () => commits++,
			},
		]);
		await waitFor(() => applied.length === 3);
		await waitFor(() => failures.length === 1);
		assert.deepEqual(await recordIds(Table, ['seg-failed', 'seg-ok']), ['seg-ok']);
		assert.equal(Table.dbisDB.getSync([Symbol.for('seq'), 77]), undefined);
		assert.match(failures[0][0], /injected failure for seg-failed/);
		assert.equal(failures[0][1], NOW + 9.1);
		assert.equal(commits, 0);
	});

	it('records no cursor and runs no onCommit for a held stream after its failure', async () => {
		const stream = {};
		let laterCommits = 0;
		const { Table, applied } = start([
			failingWrite('held-failed', NOW + 11.1, { beginTxn: true, txnStream: stream }),
			{ type: 'end_txn', txnStream: stream, localTime: NOW + 11.1, remoteNodeIds: [79], onFailure: () => true },
			put('held-later', NOW + 12.1, { beginTxn: true, txnStream: stream }),
			{
				type: 'end_txn',
				txnStream: stream,
				localTime: NOW + 12.1,
				remoteNodeIds: [79],
				onCommit: () => laterCommits++,
			},
			put('other-stream', NOW + 13.1, { beginTxn: true, txnStream: {} }),
		]);
		await waitFor(() => applied.length === 5);
		await waitFor(async () => (await recordIds(Table, ['held-later'])).length === 1);
		assert.equal(laterCommits, 0);
		assert.equal(Table.dbisDB.getSync([Symbol.for('seq'), 79]), undefined);
	});

	for (const hold of [true, false]) {
		it(`${hold ? 'does not report' : 'reports'} a failed segment to apply-failure listeners when the source ${hold ? 'holds' : 'moves past'} it`, async () => {
			const reported = [];
			const listener = (failure) => reported.push(failure.position);
			registerReplicatedApplyFailureListener(DATABASE, listener);
			try {
				const stream = {};
				const decided = [];
				const position = NOW + (hold ? 16.1 : 17.1);
				const { applied } = start([
					failingWrite(`listener-${hold}`, position, { beginTxn: true, nodeId: 21, txnStream: stream }),
					put(`listener-ok-${hold}`, position, { beginTxn: true, nodeId: 21, txnStream: stream }),
					{ type: 'end_txn', txnStream: stream, onFailure: () => (decided.push(hold), hold) },
				]);
				await waitFor(() => applied.length === 3 && decided.length === 1);
				await new Promise((resolve) => setTimeout(resolve, 50));
				assert.deepEqual(reported, hold ? [] : [position]);
			} finally {
				unregisterReplicatedApplyFailureListener(DATABASE, listener);
			}
		});
	}

	it('reports a commit that fails at the end_txn', async () => {
		const stream = {};
		const failures = [];
		const { applied } = start([
			failingWrite('end-failed', NOW + 10.1, { beginTxn: true, txnStream: stream }),
			{
				type: 'end_txn',
				txnStream: stream,
				localTime: NOW + 10.1,
				remoteNodeIds: [78],
				onFailure: (error) => failures.push(error),
			},
		]);
		await waitFor(() => applied.length === 2);
		await waitFor(() => failures.length === 1);
	});

	it('applies untagged events positionally, as one default stream', async () => {
		const { Table } = start([put('d1', NOW + 5.1, { beginTxn: true }), put('d2', NOW + 5.1), { type: 'end_txn' }]);
		await waitFor(async () => (await recordIds(Table, ['d1', 'd2'])).length === 2);
		if (isRocksDB) assert.equal(logEntries(Table).d1.log, 'local');
	});

	(isRocksDB ? it : it.skip)("files an origin's entry in that origin's own log", async () => {
		const { Table } = start((Table) => {
			const originId = getIdOfRemoteNode('relayed-origin', Table.auditStore);
			const relayId = getIdOfRemoteNode('relay-peer', Table.auditStore);
			Table.auditStore.ensureLogExists('relay-peer');
			return [put('relayed', NOW + 6.1, { beginTxn: true, nodeId: originId, viaNodeId: relayId }), { type: 'end_txn' }];
		});
		await waitFor(() => logEntries(Table).relayed !== undefined);
		assert.equal(logEntries(Table).relayed.log, 'relayed-origin');
	});

	(isRocksDB ? it : it.skip)('rejects a relayed entry whose origin has no node name', async () => {
		const { Table, applied } = start((Table) => {
			const relayId = getIdOfRemoteNode('relay-peer', Table.auditStore);
			Table.auditStore.ensureLogExists('relay-peer');
			return [
				put('unnamed', NOW + 7.1, { beginTxn: true, nodeId: 4242, viaNodeId: relayId }),
				{ type: 'end_txn' },
				put('after-unnamed', NOW + 8.1),
			];
		});
		await waitFor(() => applied.length === 3);
		await waitFor(async () => (await recordIds(Table, ['after-unnamed'])).length === 1);
		assert.deepEqual(await recordIds(Table, ['unnamed']), []);
		assert.equal(logEntries(Table).unnamed, undefined);
	});
});
