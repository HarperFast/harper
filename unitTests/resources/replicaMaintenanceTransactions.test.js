require('../testUtils');
const assert = require('node:assert');
const { setupTestDBPath } = require('../testUtils');
const { waitFor } = require('../waitFor.js');
const { table, openReplicaDeadlineStore } = require('#src/resources/databases');
const { transaction } = require('#src/resources/transaction');
const { setMainIsWorker } = require('#js/server/threads/manageThreads');
const { server } = require('#src/server/Server');
const { DatabaseTransaction, getTxnExpiration, setTxnExpiration } = require('#src/resources/DatabaseTransaction');

describe('Replica maintenance transaction lifetime', function () {
	this.timeout(10000);
	let Records, Foreign, tracked;

	before(function () {
		if (process.env.HARPER_STORAGE_ENGINE === 'lmdb') this.skip();
		setupTestDBPath();
		setMainIsWorker(true);
		tracked = setTxnExpiration(getTxnExpiration());
		Records = table({
			database: 'test',
			table: 'ReplicaMaintenanceTransactions',
			audit: true,
			attributes: [{ name: 'id', isPrimaryKey: true }, { name: 'name', indexed: true }, { name: 'body' }],
		});
		Foreign = table({
			database: 'test',
			table: 'ReplicaMaintenanceForeign',
			attributes: [{ name: 'id', isPrimaryKey: true }],
		});
		Records.dbisDB.putSync([Symbol.for('residency_by_id'), 123], ['resident-a']);
	});

	async function stub(id) {
		const context = {};
		await transaction(context, async () => {
			const resource = await Records.getResource(id, context, { ensureLoaded: false });
			resource._writeInvalidate(id, { name: 'indexed' }, { residencyId: 123 });
		});
		return Records.primaryStore.getEntry(id);
	}

	async function admit(entry) {
		assert.equal(
			await Records._storeReplica(entry, {
				key: entry.key,
				value: { id: entry.key, name: 'indexed', body: 'complete' },
				version: entry.version,
				originNode: server.hostname,
			}),
			true
		);
	}

	function retainedSince(before) {
		return [...tracked].filter((txn) => !before.has(txn) && txn.db === Records.primaryStore);
	}

	it('does not retain a read transaction wrapper after admitting a replica', async () => {
		const entry = await stub('admitted');
		const before = new Set(tracked);
		const foreign = new DatabaseTransaction();
		foreign.db = Foreign.primaryStore;
		foreign.getReadTxn();
		try {
			await admit(entry);
			assert.ok(tracked.has(foreign), 'the capture includes an unrelated live transaction');
			assert.equal(retainedSince(before).length, 0, 'replica admission left a wrapper in the transaction monitor');
		} finally {
			foreign.abort();
		}
	});

	it('does not retain a read transaction wrapper after removing an orphan deadline', async () => {
		await admit(await stub('orphan-holder'));
		const store = openReplicaDeadlineStore(
			Records.primaryStore.rootStore,
			Records.tableName,
			Records.dbisDB.getSync(Records.tableName + '/')?.generation
		);
		await store.put('ghost', Date.now() - 1);
		const before = new Set(tracked);
		Records.setTTLExpiration({ replicaExpiration: 0.2 });
		await waitFor(() => store.getSync('ghost') === undefined, { message: 'the sweep removes the orphan deadline' });
		assert.equal(retainedSince(before).length, 0, 'orphan cleanup left a wrapper in the transaction monitor');
	});
});
