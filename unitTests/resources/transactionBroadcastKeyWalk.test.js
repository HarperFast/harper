// The broadcaster walks a changed key up its '/' hierarchy to notify ancestor subscribers. A key
// rooted at '/' used to make that walk spin forever (harper#2687), seizing the worker. These drive
// the real same-thread aftercommit path with leading-slash keys.
require('../testUtils');
const assert = require('node:assert');
const { EventEmitter } = require('node:events');
const { addSubscription } = require('#src/resources/transactionBroadcast');
const { waitFor } = require('../waitFor.js');

function makeFakeStores(path) {
	const auditStore = new EventEmitter();
	auditStore.env = {};
	auditStore.reusableIterable = true;
	const primaryStore = { path, tableId: 1 };
	return { primaryStore, auditStore };
}

function subscribeCollecting(table, key) {
	const events = [];
	const subscription = addSubscription(
		table,
		key,
		(recordId, auditRecord, timestamp, beginTxn) => {
			events.push({ id: recordId, type: auditRecord.type, beginTxn });
		},
		0,
		{ crossThreads: false }
	);
	subscription.includeDescendants = true;
	subscription.supportsTransactions = true;
	return { events, subscription };
}

function putEntries(...recordIds) {
	const logKey = Date.now();
	return recordIds.map((recordId) => ({ type: 'put', tableId: 1, recordId, version: logKey, txnLogKey: logKey }));
}

describe('transactionBroadcast key-hierarchy walk', () => {
	it('terminates for keys rooted at "/" and still reaches the whole-table subscriber', async function () {
		const table = makeFakeStores('/fake/broadcast-key-walk-root');
		const { events, subscription } = subscribeCollecting(table, null);
		try {
			table.auditStore.emit('aftercommit', putEntries('/foo', '/', '//x', 'a/b'));
			await waitFor(() => events.length === 5, { message: 'all four puts and the end_txn should be delivered' });
			assert.deepEqual(
				events.map((event) => event.id),
				['/foo', '/', '//x', 'a/b', null]
			);
			assert.equal(events[4].type, 'end_txn');
		} finally {
			subscription.end();
		}
	});

	it('notifies a subscriber on the root key exactly once per leading-slash record', async function () {
		const table = makeFakeStores('/fake/broadcast-key-walk-root-key');
		const { events, subscription } = subscribeCollecting(table, '/');
		try {
			table.auditStore.emit('aftercommit', putEntries('/foo', 'unrelated/key'));
			await waitFor(() => events.length === 2, { message: 'one put for the root ancestor and the end_txn' });
			assert.deepEqual(events, [
				{ id: '/foo', type: 'put', beginTxn: true },
				{ id: null, type: 'end_txn', beginTxn: true },
			]);
		} finally {
			subscription.end();
		}
	});
});
