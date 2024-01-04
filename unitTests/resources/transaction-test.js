require('../test_utils');
const assert = require('assert');
const { getMockLMDBPath } = require('../test_utils');
const { table } = require('../../resources/databases');
const { setMainIsWorker } = require('../../server/threads/manageThreads');
const { transaction } = require('../../resources/transaction');
const {
	setNATSReplicator,
	setPublishToStream,
	publishToStream,
	setSubscription,
} = require('../../server/nats/natsReplicator');
const { resolve } = require('path');

// might want to enable an iteration with NATS being assigned as a source
describe('Transactions', () => {
	let TxnTest, TxnTest2, TxnTest3;
	let published_messages = [];
	let natsPublishToStream = publishToStream;
	let natsSetSubscription = setSubscription;
	let test_subscription;

	before(async function () {
		getMockLMDBPath();
		setMainIsWorker(true);
		TxnTest = table({
			table: 'TxnTest',
			database: 'test',
			attributes: [{ name: 'id', isPrimaryKey: true }, { name: 'name' }, { name: 'count' }],
		});
		setPublishToStream(
			(subject, stream, header, message) => {
				published_messages.push(message);
			},
			(database, table, subscription) => {
				test_subscription = subscription;
			}
		);
		setNATSReplicator('TxnTest', 'test', TxnTest);
		TxnTest2 = table({
			table: 'TxnTest2',
			database: 'test',
			attributes: [{ name: 'id', isPrimaryKey: true }, { name: 'name' }],
		});
		TxnTest3 = table({
			table: 'TxnTest3',
			database: 'test2',
			attributes: [{ name: 'id', isPrimaryKey: true }, { name: 'name' }],
		});
	});
	after(() => {
		setPublishToStream(natsPublishToStream, natsSetSubscription); // restore
	});
	it('Can run txn', async function () {
		const context = {};
		await transaction(context, () => {
			TxnTest.put(42, { name: 'the answer' }, context);
		});
		assert.equal((await TxnTest.get(42)).name, 'the answer');
	});
	it('Do not allow write after txn commits', async function () {
		const context = {};
		await transaction(context, () => {});
		let error;
		try {
			TxnTest.put(42, { name: 'wrong answer' }, context);
		} catch (e) {
			error = e;
		}
		assert(error.message?.includes('Can not'));
	});
	it('Can run txn with three tables and two databases', async function () {
		const context = {};
		let start = Date.now();
		await transaction(context, () => {
			TxnTest.put(7, { name: 'a prime' }, context);
			TxnTest2.put(13, { name: 'a bigger prime' }, context);
			TxnTest3.put(14, { name: 'not a prime' }, context);
		});
		assert.equal((await TxnTest.get(7)).name, 'a prime');
		assert.equal((await TxnTest2.get(13)).name, 'a bigger prime');
		assert.equal((await TxnTest3.get(14)).name, 'not a prime');
		let last_txn;
		for await (let entry of TxnTest.getHistory(start)) {
			last_txn = entry;
		}
		assert.equal(last_txn.id, 7);
		let last_txn2;
		for await (let entry of TxnTest2.getHistory(start)) {
			last_txn2 = entry;
		}
		assert.equal(last_txn2.id, 13);
		assert.equal(last_txn.version, last_txn2.version);
	});
	describe('Testing updates', () => {
		it('Can update with addTo and set', async function () {
			const context = {};
			await transaction(context, () => {
				TxnTest.put(45, { name: 'a counter', count: 1 }, context);
			});
			assert.equal((await TxnTest.get(45)).name, 'a counter');
			await transaction((txn) => {
				let counter = TxnTest.get(45, txn);
				counter.addTo('count', 1);
			});
			let entity = await TxnTest.get(45);
			assert.equal(entity.count, 2);
			// concurrently, to ensure the incrementation is really correct:
			let promises = [];
			for (let i = 0; i < 3; i++) {
				promises.push(
					transaction(async (txn) => {
						let counter = TxnTest.get(45, txn);
						await new Promise((resolve) => setTimeout(resolve, 1));
						counter.addTo('count', 3);
						counter.set('new prop ' + i, 'new value ' + i);
					})
				);
			}
			await Promise.all(promises);
			entity = await TxnTest.get(45);
			assert.equal(entity.count, 11);
			// all three properties should be added even though no single update did this
			assert.equal(entity.get('new prop 0'), 'new value 0');
			assert.equal(entity.get('new prop 1'), 'new value 1');
			assert.equal(entity.get('new prop 2'), 'new value 2');
		});
		it('Can update with patch', async function () {
			const context = {};
			await transaction(context, () => {
				TxnTest.put(45, { name: 'a counter', count: 1 }, context);
			});
			let entity = await TxnTest.get(45);
			published_messages = [];
			assert.equal(entity.name, 'a counter');
			assert.equal(entity.get('count'), 1);
			assert.equal(entity.get('new prop 0'), undefined);
			await TxnTest.patch(45, { count: { __op__: 'add', value: 2 } });
			entity = await TxnTest.get(45);
			assert.equal(entity.count, 3);
			assert.equal(published_messages.length, 1);
			assert.equal(published_messages[0].operation, 'patch');
			assert.equal(published_messages[0].records[0].count.__op__, 'add');
			// concurrently, to ensure the incrementation is really correct:
			let promises = [];
			for (let i = 0; i < 3; i++) {
				promises.push(TxnTest.patch(45, { count: { __op__: 'add', value: -2 }, ['new prop ' + i]: 'new value ' + i }));
			}
			await Promise.all(promises);
			entity = await TxnTest.get(45);
			assert.equal(entity.count, -3);
			// all three properties should be added even though no single update did this
			assert.equal(entity.get('new prop 0'), 'new value 0');
			assert.equal(entity.get('new prop 1'), 'new value 1');
			assert.equal(entity.get('new prop 2'), 'new value 2');
			assert.equal(published_messages.length, 4);
		});

		it('Can merge replication updates', async function () {
			const context = {};
			await transaction(context, () => {
				TxnTest.put(45, { name: 'a counter', count: 1 }, context);
			});
			let entity = await TxnTest.get(45);
			assert.equal(entity.name, 'a counter');
			assert.equal(entity.get('count'), 1);
			assert.equal(entity.get('new prop 0'), undefined);
			published_messages = [];
			await new Promise((resolve) => setTimeout(resolve, 20));
			await TxnTest.patch(45, { count: { __op__: 'add', value: 2 }, propertyA: 'valueA' });
			entity = await TxnTest.get(45);
			assert.equal(entity.count, 3);
			assert.equal(entity.get('propertyA'), 'valueA');
			assert.equal(published_messages.length, 1);
			assert.equal(published_messages[0].operation, 'patch');
			await new Promise((resolve) => {
				// send an update from the past, which should be merged into the current state but not overwrite it
				test_subscription.send({
					type: 'patch',
					id: 45,
					timestamp: published_messages[0].__origin.timestamp - 10,
					table: 'TxnTest',
					value: { count: { __op__: 'add', value: 2 }, propertyA: 'should not change', propertyB: 'valueB' },
					onCommit: resolve,
				});
			});
			entity = await TxnTest.get(45);
			// all three properties should be added even though no single update did this
			assert.equal(entity.count, 5);
			assert.equal(entity.get('propertyA'), 'valueA');
			assert.equal(entity.get('propertyB'), 'valueB');
		});
	});
});
