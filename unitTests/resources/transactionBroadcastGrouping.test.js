// Transaction delimiting in the broadcaster is engine-aware: RocksDB entries committed together
// share the log key while their record versions may differ (a source fill's version can be a
// source-reported lastModified); LMDB's localTime is a per-entry audit key, so there the shared
// version delimits the transaction. These drive the real same-thread aftercommit path.
require('../testUtils');
const assert = require('node:assert');
const { EventEmitter } = require('node:events');
const { addSubscription } = require('#src/resources/transactionBroadcast');
const { waitFor } = require('../waitFor.js');

function makeFakeStores(path, reusableIterable) {
	const auditStore = new EventEmitter();
	auditStore.env = {};
	auditStore.reusableIterable = reusableIterable;
	const primaryStore = { path, tableId: 1 };
	return { primaryStore, auditStore };
}

function subscribeCollecting(table) {
	const events = [];
	const subscription = addSubscription(
		table,
		null,
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

describe('transactionBroadcast transaction grouping', () => {
	it('groups RocksDB entries by the shared log key even when record versions differ', async function () {
		const table = makeFakeStores('/fake/broadcast-grouping-rocks', true);
		const { events, subscription } = subscribeCollecting(table);
		try {
			const logKey = Date.now();
			table.auditStore.emit('aftercommit', [
				{ type: 'put', tableId: 1, recordId: 'a', version: logKey, recordVersion: logKey, localTime: logKey },
				// a source fill in the same commit: backdated record version, same log key
				{
					type: 'put',
					tableId: 1,
					recordId: 'b',
					version: logKey - 5000,
					recordVersion: logKey - 5000,
					localTime: logKey,
				},
			]);
			await waitFor(() => events.length === 3, { message: 'both entries and the end_txn should be delivered' });
			assert.deepEqual(events, [
				{ id: 'a', type: 'put', beginTxn: true },
				{ id: 'b', type: 'put', beginTxn: undefined },
				{ id: null, type: 'end_txn', beginTxn: true },
			]);
		} finally {
			subscription.end();
		}
	});

	it('groups LMDB entries by the shared version across distinct per-entry audit keys', async function () {
		const table = makeFakeStores('/fake/broadcast-grouping-lmdb', false);
		const { events, subscription } = subscribeCollecting(table);
		try {
			const version = Date.now();
			table.auditStore.emit('aftercommit', [
				{ type: 'put', tableId: 1, recordId: 'c', version, localTime: version + 1 },
				{ type: 'put', tableId: 1, recordId: 'd', version, localTime: version + 2 },
			]);
			await waitFor(() => events.length === 3, { message: 'both entries and the end_txn should be delivered' });
			assert.deepEqual(events, [
				{ id: 'c', type: 'put', beginTxn: true },
				{ id: 'd', type: 'put', beginTxn: undefined },
				{ id: null, type: 'end_txn', beginTxn: true },
			]);
		} finally {
			subscription.end();
		}
	});
});
