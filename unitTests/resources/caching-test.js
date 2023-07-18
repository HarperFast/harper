require('../test_utils');
const assert = require('assert');
const { getMockLMDBPath } = require('../test_utils');
const { table } = require('../../resources/databases');
const { Resource } = require('../../resources/Resource');
const { setMainIsWorker } = require('../../server/threads/manageThreads');
const { transaction } = require('../../resources/transaction');
describe('Caching', () => {
	let CachingTable,
		IndexedCachingTable,
		source_requests = 0;
	let events = [];
	let timer = 0;
	before(async function () {
		getMockLMDBPath();
		setMainIsWorker(true); // TODO: Should be default until changed
		CachingTable = table({
			table: 'CachingTable',
			database: 'test',
			attributes: [{ name: 'id', isPrimaryKey: true }, { name: 'name' }],
		});
		IndexedCachingTable = table({
			table: 'IndexedCachingTable',
			database: 'test',
			attributes: [
				{ name: 'id', isPrimaryKey: true },
				{ name: 'name', indexed: true },
			],
		});
		class Source extends Resource {
			get() {
				return new Promise((resolve) =>
					setTimeout(() => {
						source_requests++;
						resolve({
							id: this.getId(),
							name: 'name ' + this.getId(),
						});
					}, timer)
				);
			}
		}
		CachingTable.sourcedFrom(Source);
		IndexedCachingTable.sourcedFrom(Source);
		let subscription = await CachingTable.subscribe({});

		subscription.on('data', (event) => {
			events.push(event);
		});
	});
	it('Can load cached data', async function () {
		source_requests = 0;
		events = [];
		CachingTable.setTTLExpiration(0.005);
		let result = await CachingTable.get(23);
		assert.equal(result.id, 23);
		assert.equal(result.name, 'name ' + 23);
		assert.equal(source_requests, 1);
		result = await CachingTable.get(23);
		assert.equal(result.id, 23);
		assert.equal(source_requests, 1);
		// let it expire
		await new Promise((resolve) => setTimeout(resolve, 10));
		result = await CachingTable.get(23);
		assert.equal(result.id, 23);
		assert.equal(result.name, 'name ' + 23);
		assert.equal(source_requests, 2);
		assert.equal(events.length, 0);
	});

	it('Cache stampede is handled', async function () {
		try {
			console.log('start stampede test')
			CachingTable.setTTLExpiration(0.01);
			await new Promise((resolve) => setTimeout(resolve, 15));
			source_requests = 0;
			events = [];
			timer = 10;
			CachingTable.get(23, context);
			await CachingTable.primaryStore.committed; // wait for the record to update to updating
			CachingTable.get(23, context);
			let result = await CachingTable.get(23, context);
			assert.equal(result.id, 23);
			assert.equal(result.name, 'name ' + 23);
			assert.equal(source_requests, 1);
		} finally {
			timer = 0;
		}
	});
	it('Cache invalidation triggers updates', async function () {
		await new Promise((resolve) => setTimeout(resolve, 10));
		CachingTable.setTTLExpiration(50);
		source_requests = 0;
		events = [];
		let result = await CachingTable.get(23, context);
		assert.equal(result.id, 23);
		assert.equal(result.name, 'name ' + 23);
		assert.equal(source_requests, 1);
		result.invalidate();
		await new Promise((resolve) => setTimeout(resolve, 20));
		result = await CachingTable.get(23, context);
		await new Promise((resolve) => setTimeout(resolve, 10));
		assert.equal(result.id, 23);
		assert.equal(source_requests, 2);
		assert.equal(events.length, 2);
	});
	it('Can load cached indexed data', async function () {
		source_requests = 0;
		events = [];
		IndexedCachingTable.setTTLExpiration(0.005);
		let result = await IndexedCachingTable.get(23);
		assert.equal(result.id, 23);
		assert.equal(result.name, 'name ' + 23);
		assert.equal(source_requests, 1);
		await new Promise((resolve) => setTimeout(resolve, 10));
		let results = [];
		for await (let record of IndexedCachingTable.search({ conditions: [{ attribute: 'name', value: 'name 23' }] })) {
			results.push(record);
		}
		assert.equal(results.length, 1);
		result = await CachingTable.get(23);
		assert.equal(result.id, 23);
		assert.equal(source_requests, 2);
		// let it expire
		await new Promise((resolve) => setTimeout(resolve, 10));
		result = await CachingTable.get(23);
		assert.equal(result.id, 23);
		assert.equal(result.name, 'name ' + 23);
		assert.equal(source_requests, 2);
		assert.equal(events.length, 0);
	});
});
