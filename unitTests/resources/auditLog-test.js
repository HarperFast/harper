require('../test_utils');
const assert = require('assert');
const { getMockLMDBPath } = require('../test_utils');
const { table } = require('../../resources/databases');
const { setAuditRetention } = require('../../resources/auditStore');
const { setMainIsWorker } = require('../../server/threads/manageThreads');
const { transaction } = require('../../resources/transaction');
// might want to enable an iteration with NATS being assigned as a source
//const { setNATSReplicator } = require('../../server/nats/natsReplicator');
describe('Audit log', () => {
	let AuditedTable;
	let events = [];
	let timer = 0;
	let return_value = true;
	let return_error;

	before(async function () {
		getMockLMDBPath();
		setMainIsWorker(true); // TODO: Should be default until changed
		AuditedTable = table({
			table: 'AuditedTable',
			attributes: [{ name: 'id', isPrimaryKey: true }, { name: 'name' }],
		});
		let subscription = await AuditedTable.subscribe({});

		subscription.on('data', (event) => {
			events.push(event);
		});
	});
	afterEach(function () {
		setAuditRetention(60000);
	});
	it('check log after writes and prune', async () => {
		events = [];
		await AuditedTable.put(1, { name: 'one' });
		await AuditedTable.put(2, { name: 'two' });
		await AuditedTable.put(2, { name: 'two-changed' });
		await AuditedTable.delete(1);
		assert.equal(AuditedTable.primaryStore.getEntry(1).value, null); // verify that there is a delete entry
		let results = [];
		for await (let entry of AuditedTable.getHistory()) {
			results.push(entry);
		}
		assert.equal(results.length, 4);
		assert.equal(events.length, 4);
		setAuditRetention(0.001, 1);
		AuditedTable.auditStore.scheduleAuditCleanup(1);
		await AuditedTable.put(3, { name: 'three' });
		await new Promise((resolve) => setTimeout(resolve, 20));
		results = [];
		for await (let entry of AuditedTable.getHistory()) {
			results.push(entry);
		}
		assert.equal(results.length, 0);
		assert.equal(AuditedTable.primaryStore.getEntry(1), undefined); // verify that the delete entry was removed
		// verify that the twice-written entry was not removed
		assert.equal(AuditedTable.primaryStore.getEntry(2)?.value?.name, 'two-changed');
	});
	it('write big key with big user name', async () => {
		const key = [];
		for (let i = 0; i < 10; i++) key.push('write big key with big user name');
		await AuditedTable.put(
			key,
			{ name: key },
			{
				user: { username: key.toString() },
			}
		);
		let history = await AuditedTable.getHistoryOfRecord(key);
		assert.equal(history.length, 1);
		await AuditedTable.delete(key);
		history = await AuditedTable.getHistoryOfRecord(key);
		assert.equal(history.length, 2);
		assert.equal(history[0].type, 'put');
		assert.equal(history[1].type, 'delete');
		assert.deepEqual(history[0].id, key);
		assert.deepEqual(history[1].id, key);
		assert.equal(history[0].user, key.toString());
		assert.deepEqual(history[0].value.id, key);
	});
});
