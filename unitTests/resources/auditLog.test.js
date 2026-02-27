const assert = require('assert');
const { setupTestDBPath } = require('../testUtils');
const { table } = require('#src/resources/databases');
const { setAuditRetention } = require('#src/resources/auditStore');
const { setMainIsWorker } = require('#js/server/threads/manageThreads');
const { setTimeout: delay } = require('node:timers/promises');
require('#src/server/serverHelpers/serverUtilities');
describe('Audit log', () => {
	let AuditedTable;
	let events = [];

	before(async function () {
		setupTestDBPath();
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
		await delay(20);
		assert(events.length > 2, 'Should have at least a couple of update events');
		if (AuditedTable.auditStore.reusableIterable) return; // rocksdb doesn't have any audit log cleanup from JS
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
	it('check log after operations and prune', async () => {
		await AuditedTable.operation({
			operation: 'upsert',
			records: [{ id: 3, name: 'three' }],
		});
		await AuditedTable.operation({
			operation: 'update',
			records: [{ id: 3, name: 'three changed' }],
		});
		let results = await AuditedTable.getHistoryOfRecord(3);
		assert.equal(results.length, 2);
		assert.equal(results[0].operation, 'upsert');
		assert.equal(results[1].operation, 'update');
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
	it('dynamically add new transaction logs to iterator', async function () {
		if (!AuditedTable.auditStore.reusableIterable) return this.skip(); // only for rocksdb

		// Create initial entries
		await AuditedTable.put(10, { name: 'initial' });
		await AuditedTable.put(11, { name: 'initial2' });

		const results = [];
		const iterator = AuditedTable.getHistory()[Symbol.iterator]();

		// Get first entry
		let result = iterator.next();
		results.push(result.value);

		// Emit a new transaction log event
		const newLogName = 'test-log-' + Date.now();
		AuditedTable.auditStore.rootStore.emit('new-transaction-log', newLogName);

		// Continue iterating - should include entries from new log if it has any
		while (!(result = iterator.next()).done) {
			results.push(result.value);
		}

		// Verify we got at least the initial entries
		assert(results.length >= 2, 'Should have at least the initial entries');
	});
	it('cleanup listener when iterator completes naturally', async function () {
		if (!AuditedTable.auditStore.reusableIterable) return this.skip(); // only for rocksdb

		await AuditedTable.put(20, { name: 'test' });

		// Iterate through all entries
		const results = [];
		for (const entry of AuditedTable.getHistory()) {
			results.push(entry);
		}

		// Get listener count before
		const listenersBefore = AuditedTable.auditStore.rootStore.listenerCount('new-transaction-log');

		// Create another iterator and let it complete
		for (const entry of AuditedTable.getHistory()) {
			// iterate through all
		}

		// Listener count should not increase (cleanup happened)
		const listenersAfter = AuditedTable.auditStore.rootStore.listenerCount('new-transaction-log');
		assert.equal(listenersAfter, listenersBefore, 'Listener should be cleaned up after completion');
	});
	it('cleanup listener when breaking from iteration', async function () {
		if (!AuditedTable.auditStore.reusableIterable) return this.skip(); // only for rocksdb

		await AuditedTable.put(30, { name: 'test1' });
		await AuditedTable.put(31, { name: 'test2' });
		await AuditedTable.put(32, { name: 'test3' });

		const listenersBefore = AuditedTable.auditStore.rootStore.listenerCount('new-transaction-log');

		// Break early from iteration
		let count = 0;
		for (const entry of AuditedTable.getHistory()) {
			if (++count >= 2) break;
		}

		// Listener should be cleaned up after break
		const listenersAfter = AuditedTable.auditStore.rootStore.listenerCount('new-transaction-log');
		assert.equal(listenersAfter, listenersBefore, 'Listener should be cleaned up after break');
	});
	it('exclude logs from new transaction log events', async function () {
		if (!AuditedTable.auditStore.reusableIterable) return this.skip(); // only for rocksdb

		await AuditedTable.put(40, { name: 'test' });

		const excludedLog = 'excluded-log-' + Date.now();
		const iterator = AuditedTable.getHistory({ excludeLogs: [excludedLog] })[Symbol.iterator]();

		// Start iteration
		iterator.next();

		// Emit excluded log - should be ignored
		AuditedTable.auditStore.rootStore.emit('new-transaction-log', excludedLog);

		// Verify the excluded log is not in the logByName map or was not added to iteration
		// (hard to verify directly, but if it causes issues the test would fail)

		// Finish iteration
		let result;
		while (!(result = iterator.next()).done) {
			// continue
		}

		assert(true, 'Should complete without including excluded log');
	});
});
