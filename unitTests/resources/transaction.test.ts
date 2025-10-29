import { describe, it, before, after } from 'mocha';
import assert from 'node:assert/strict';
import { createTestSandbox, cleanupTestSandbox } from '../testUtils';
import { table } from '@/resources/databases';
import { setMainIsWorker } from '@/server/threads/manageThreads';
import { transaction } from '@/resources/transaction';

describe('Transactions', () => {
	let TxnTest, TxnTest2, TxnTest3;

	before(async function () {
		createTestSandbox();
		setMainIsWorker(true);
		TxnTest = table({
			table: 'TxnTest',
			database: 'test',
			audit: true,
			attributes: [
				{ name: 'id', isPrimaryKey: true },
				{ name: 'name' },
				{ name: 'count' },
				{ name: 'countBigInt', type: 'BigInt' },
				{ name: 'countInt', type: 'Int' },
				{ name: 'computed', computed: true, indexed: true },
			],
		});
		TxnTest.setComputedAttribute('computed', (instance) => instance.name + ' computed');
		TxnTest2 = table({
			table: 'TxnTest2',
			database: 'test',
			audit: true,
			attributes: [{ name: 'id', isPrimaryKey: true }, { name: 'name' }],
		});
		TxnTest3 = table({
			table: 'TxnTest3',
			database: 'test2',
			attributes: [{ name: 'id', isPrimaryKey: true }, { name: 'name' }],
		});
	});

	after(cleanupTestSandbox);

	it('Can run txn', async function () {
		const context = {};
		await transaction(context, () => {
			TxnTest.put(42, { name: 'the answer' }, context);
		});
		let answer = await TxnTest.get(42);
		assert.equal(answer.name, 'the answer');
		assert.equal(answer.computed, 'the answer computed');
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
		for await (let entry of TxnTest.getHistory()) {
			console.log('entry', entry);
			last_txn = entry;
		}
		assert.equal(last_txn?.id, 7);
		let last_txn2;
		for await (let entry of TxnTest2.getHistory(start)) {
			last_txn2 = entry;
		}
		assert.equal(last_txn2.id, 13);
		assert.equal(last_txn.version, last_txn2.version);
	});

	it('Can run txn with commit in the middle', async function () {
		const context = {};
		let start = Date.now();
		await transaction(context, async () => {
			TxnTest.put(7, { name: 'seven' }, context);
			TxnTest2.put(13, { name: 'thirteen' }, context);
			await context.transaction.commit();
			assert.equal((await TxnTest.get(7, context)).name, 'seven');
			let entries = [];
			for await (let entry of TxnTest2.search([{ attribute: 'name', value: 'thirteen' }], context)) {
				entries.push(entry);
			}
			assert.equal(entries[0].name, 'thirteen');
			TxnTest3.put(14, { name: 'fourteen' }, context);
		});
	});

	describe('Testing updates', () => {
		it('Can update with addTo and set', async function () {
			const context = {};
			await transaction(context, () => {
				TxnTest.put(45, { name: 'a counter', count: 1, countInt: 100, countBigInt: 4611686018427388000n }, context);
			});
			assert.equal((await TxnTest.get(45)).name, 'a counter');
			await transaction(async (txn) => {
				let counter = await TxnTest.update(45, {}, txn);
				counter.addTo('count', 1);
				counter.addTo('countInt', 1);
				counter.addTo('countBigInt', 1n);
				assert(counter.getUpdatedTime() > 1);
			});
			let entity = await TxnTest.get(45);
			assert.equal(entity.count, 2);
			assert.equal(entity.countInt, 101);
			assert.equal(entity.countBigInt, 4611686018427388001n);
			assert.equal(entity.propertyA, undefined);
			// concurrently, to ensure the incrementation is really correct:
			let promises = [];
			for (let i = 0; i < 3; i++) {
				promises.push(
					transaction(async (txn) => {
						let counter = await TxnTest.update(45, {}, txn);
						await new Promise((resolve) => setTimeout(resolve, 1));
						counter.addTo('count', 3);
						counter.subtractFrom('countInt', 2);
						counter.addTo('countBigInt', 5);
						counter['new prop ' + i] = 'new value ' + i;
					})
				);
			}
			await Promise.all(promises);
			entity = await TxnTest.get(45);
			assert.equal(entity.count, 11);
			assert.equal(entity.countInt, 95);
			assert.equal(entity.countBigInt, 4611686018427388016n);
			// all three properties should be added even though no single update did this
			assert.equal(entity['new prop 0'], 'new value 0');
			assert.equal(entity['new prop 1'], 'new value 1');
			assert.equal(entity['new prop 2'], 'new value 2');
		});

		it('Can update with patch', async function () {
			const context = {};
			await transaction(context, () => {
				TxnTest.put(45, { name: 'a counter', count: 1 }, context);
			});
			let entity = await TxnTest.get(45);
			assert.equal(entity.name, 'a counter');
			assert.equal(entity.count, 1);
			assert.equal(entity['new prop 0'], undefined);
			await TxnTest.patch(45, { count: { __op__: 'add', value: 2 } });
			entity = await TxnTest.get(45);
			assert.equal(entity.count, 3);
			// concurrently, to ensure the incrementation is really correct:
			let promises = [];
			for (let i = 0; i < 3; i++) {
				promises.push(TxnTest.patch(45, { count: { __op__: 'add', value: -2 }, ['new prop ' + i]: 'new value ' + i }));
			}
			await Promise.all(promises);
			entity = await TxnTest.get(45);
			assert.equal(entity.count, -3);
			// all three properties should be added even though no single update did this
			assert.equal(entity['new prop 0'], 'new value 0');
			assert.equal(entity['new prop 1'], 'new value 1');
			assert.equal(entity['new prop 2'], 'new value 2');
			assert(entity.getUpdatedTime() > 1);
		});

		it('Can use update and get with different arguments', async function () {
			const context = {};
			await transaction(context, () => {
				TxnTest.put(45, { name: 'a counter', count: 1, countInt: 100, countBigInt: 4611686018427388000n }, context);
			});
			await transaction(async (txn) => {
				let updatable = await TxnTest.update(45, txn);
				updatable.count = 4;
			});
			await transaction(async (txn) => {
				assert.equal((await TxnTest.get(45, {}, txn)).count, 4);
			});
		});

		it('Apply out of order patch', async function () {
			const context = {};
			await transaction(context, () => {
				TxnTest.put(61, { name: 'original' }, context);
			});
			let now = Date.now();
			await TxnTest.patch(61, { name: 'newer' }, { timestamp: now + 10 });
			await TxnTest.patch(61, { name: 'older', count: 3 }, { timestamp: now + 4 });
			let record = await TxnTest.get(61);
			assert.equal(record.name, 'newer');
			assert.equal(record.count, 3);
		});

		it('Apply out of order patch and put', async function () {
			const context = {};
			await transaction(context, () => {
				TxnTest.put(61, { name: 'original' }, context);
			});
			let now = Date.now();
			await TxnTest.patch(61, { name: 'newer', count: 3 }, { timestamp: now + 10 });
			await TxnTest.put(61, { name: 'older' }, { timestamp: now + 4 });
			let record = await TxnTest.get(61);
			assert.equal(record.name, 'newer');
			assert.equal(record.count, 3);
		});

		it('Can update new object and addTo consecutively replication updates', async function () {
			class WithCountOnGet extends TxnTest {
				get() {
					if (!this.doesExist()) {
						this.update({ name: 'another counter' });
					}
					this.addTo('count', 1);
					return super.get();
				}
			}
			await WithCountOnGet.delete(67);
			let instance = await WithCountOnGet.get(67);
			assert.equal(instance.count, 1);
			instance = await WithCountOnGet.get(67);
			assert.equal(instance.count, 2);
		});
	});

	describe('Testing updates with loadAsInstance=false', () => {
		before(() => {
			TxnTest.loadAsInstance = false;
		});

		it('Can update with addTo and set', async function () {
			const context = {};
			await transaction(context, () => {
				TxnTest.put(45, { name: 'a counter', count: 1, countInt: 100, countBigInt: 4611686018427388000n }, context);
			});
			assert.equal((await TxnTest.get(45)).name, 'a counter');
			await transaction(async (txn) => {
				let counter = await TxnTest.update(45, {}, txn);
				counter.addTo('count', 1);
				counter.addTo('countInt', 1);
				counter.addTo('countBigInt', 1n);
				assert(counter.getUpdatedTime() > 1);
			});
			let entity = await TxnTest.get(45);
			assert.equal(entity.count, 2);
			assert.equal(entity.countInt, 101);
			assert.equal(entity.countBigInt, 4611686018427388001n);
			assert.equal(entity.propertyA, undefined);
			// concurrently, to ensure the incrementation is really correct:
			let promises = [];
			for (let i = 0; i < 3; i++) {
				promises.push(
					transaction(async (txn) => {
						let counter = await TxnTest.update(45, {}, txn);
						await new Promise((resolve) => setTimeout(resolve, 1));
						counter.addTo('count', 3);
						counter.subtractFrom('countInt', 2);
						counter.addTo('countBigInt', 5);
						counter['new prop ' + i] = 'new value ' + i;
					})
				);
			}
			await Promise.all(promises);
			entity = await TxnTest.get(45);
			assert.equal(entity.count, 11);
			assert.equal(entity.countInt, 95);
			assert.equal(entity.countBigInt, 4611686018427388016n);
			// all three properties should be added even though no single update did this
			assert.equal(entity['new prop 0'], 'new value 0');
			assert.equal(entity['new prop 1'], 'new value 1');
			assert.equal(entity['new prop 2'], 'new value 2');
		});

		it('Can use update and get with different arguments', async function () {
			const context = {};
			await transaction(context, () => {
				TxnTest.put(45, { name: 'a counter', count: 1, countInt: 100, countBigInt: 4611686018427388000n }, context);
			});
			await transaction(async (txn) => {
				let updatable = await TxnTest.update(45, txn);
				updatable.count = 4;
			});
			await transaction(async (txn) => {
				assert.equal((await TxnTest.get(45, {}, txn)).count, 4);
			});
		});

		it('Can update with patch', async function () {
			const context = {};
			await transaction(context, () => {
				TxnTest.put(45, { name: 'a counter', count: 1 }, context);
			});
			let entity = await TxnTest.get(45);
			assert.equal(entity.name, 'a counter');
			assert.equal(entity.count, 1);
			assert.equal(entity['new prop 0'], undefined);
			await TxnTest.patch(45, { count: { __op__: 'add', value: 2 } });
			entity = await TxnTest.get(45);
			assert.equal(entity.count, 3);
			// concurrently, to ensure the incrementation is really correct:
			let promises = [];
			for (let i = 0; i < 3; i++) {
				promises.push(TxnTest.patch(45, { count: { __op__: 'add', value: -2 }, ['new prop ' + i]: 'new value ' + i }));
			}
			await Promise.all(promises);
			entity = await TxnTest.get(45);
			assert.equal(entity.count, -3);
			// all three properties should be added even though no single update did this
			assert.equal(entity['new prop 0'], 'new value 0');
			assert.equal(entity['new prop 1'], 'new value 1');
			assert.equal(entity['new prop 2'], 'new value 2');
			assert(entity.getUpdatedTime() > 1);
		});
	});
});
