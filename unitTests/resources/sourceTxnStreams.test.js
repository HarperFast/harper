const assert = require('node:assert');
const { setupTestDBPath } = require('../testUtils');
const { table } = require('#src/resources/databases');
const { getIdOfRemoteNode } = require('#src/resources/nodeIdMapping');
const { waitFor } = require('../waitFor');

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

	it('applies untagged events positionally, as one default stream', async () => {
		const { Table } = start([put('d1', NOW + 5.1, { beginTxn: true }), put('d2', NOW + 5.1), { type: 'end_txn' }]);
		await waitFor(async () => (await recordIds(Table, ['d1', 'd2'])).length === 2);
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
});
