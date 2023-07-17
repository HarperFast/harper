require('../test_utils');
const assert = require('assert');
const { getMockLMDBPath } = require('../test_utils');
const { table } = require('../../resources/databases');
const { Resource } = require('../../resources/Resource');
describe('Caching', () => {
	let CachingTable,
		source_requests = 0;
	before(async function () {
		getMockLMDBPath();
		CachingTable = table({
			table: 'CachingTable',
			database: 'test',
			expiration: 0.01,
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
	});
	it('Can interact with cached data', async function () {
		source_requests = 0;
		let result = await CachingTable.get(23);
		assert.equal(result.id, 23);
		assert.equal(result.id, 'name ' + 23);
	});
});
