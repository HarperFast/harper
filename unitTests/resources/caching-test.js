require('../test_utils');
const assert = require('assert');
const { getMockLMDBPath } = require('../test_utils');
const { table } = require('../../resources/databases');
const { Resource } = require('../../resources/Resource');
const { setMainIsWorker } = require('../../server/threads/manageThreads');
const { transaction } = require('../../resources/transaction');
describe('Caching', () => {
	let CachingTable,
		source_requests = 0;
	let events = [];
	before(async function () {
		getMockLMDBPath();
		setMainIsWorker(true);
		CachingTable = table({
			table: 'CachingTable',
			database: 'test',
			attributes: [{ name: 'id', isPrimaryKey: true }, { name: 'name' }],
		});
		class Source extends Resource {
			get() {
				return new Promise((resolve) =>
					setImmediate(() => {
						source_requests++;
						resolve({
							id: this.getId(),
							name: 'name ' + this.getId(),
						});
					})
				);
			}
		}
		CachingTable.sourcedFrom(Source);
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

	it('Cache invalidation triggers updates', async function () {
		await new Promise((resolve) => setTimeout(resolve, 10));
		CachingTable.setTTLExpiration(50);
		source_requests = 0;
		events = [];
		await transaction(async (context) => {
			let result = await CachingTable.get(23, context);
			assert.equal(result.id, 23);
			assert.equal(result.name, 'name ' + 23);
			assert.equal(source_requests, 1);
			result.invalidate();
		});
		let result = await CachingTable.get(23, context);
		await new Promise((resolve) => setTimeout(resolve, 20));
		assert.equal(result.id, 23);
		assert.equal(source_requests, 2);
		assert.equal(events.length, 2);
	});
});
