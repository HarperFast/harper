require('../test_utils');
const assert = require('assert');
const { getMockLMDBPath } = require('../test_utils');
const { table } = require('../../resources/databases');
const { setMainIsWorker } = require('../../server/threads/manageThreads');
const { transaction } = require('../../resources/transaction');
// might want to enable an iteration with NATS being assigned as a source
describe('Querying through Resource API', () => {
	let QueryTable;
	before(async function () {
		getMockLMDBPath();
		setMainIsWorker(true); // TODO: Should be default until changed
		QueryTable = table({
			table: 'QueryTable',
			database: 'test',
			attributes: [
				{ name: 'id', isPrimaryKey: true },
				{ name: 'name', indexed: true },
			],
		});
		for (let i = 0; i < 10; i++) {
			QueryTable.put({ id: 'id-' + i, name: i > 0 ? 'name-' + i : null });
		}
	});
	it('Query data in a table with not-equal', async function () {
		let results = [];
		for await (let record of QueryTable.search({
			conditions: [
				{ attribute: 'id', comparator: 'less_than_equal', value: 'id-1' },
				{ attribute: 'name', comparator: 'not_equal', value: null },
			],
		})) {
			results.push(record);
		}
		assert.equal(results.length, 1);
	});
	it('Query data in a table with greater_than_equal comparator', async function () {
		let results = [];
		for await (let record of QueryTable.search({
			conditions: [{ attribute: 'id', comparator: 'greater_than_equal', value: 'id-1' }],
		})) {
			results.push(record);
		}

		assert.equal(results.length, 9);
	});
	it('Query data in a table with bad comparator', async function () {
		let results = [];
		let caught_error;
		try {
			for await (let record of QueryTable.search({
				conditions: [{ attribute: 'id', comparator: 'great_than_equal', value: 'id-1' }],
			})) {
				results.push(record);
			}
		} catch (error) {
			caught_error = error;
		}
		assert(caught_error.message.includes('Unknown query comparator'));
	});
	it('Query data in a table with bad secondary comparator', async function () {
		let results = [];
		let caught_error;
		try {
			for await (let record of QueryTable.search({
				conditions: [
					{ attribute: 'id', value: 'id-1' },
					{ attribute: 'id', comparator: 'great_than_equal', value: 'id-1' },
				],
			})) {
				results.push(record);
			}
		} catch (error) {
			caught_error = error;
		}
		assert(caught_error.message.includes('Unknown query comparator'));
	});
	it('Prevent query data in a table with null', async function () {
		let results = [];
		let caught_error;
		try {
			for await (let record of QueryTable.search({
				conditions: [{ attribute: 'id', value: null }],
			})) {
				results.push(record);
			}
		} catch (error) {
			caught_error = error;
		}
		assert(caught_error.message.includes('Invalid value'));
	});
	it('Get with big key should fail', async function () {
		const key = [];
		for (let i = 0; i < 50; i++) key.push('testing a big key that is too big for HarperDB');
		let get_error;
		for (let i = 0; i < 5; i++) {
			get_error = null;
			try {
				let result;
				result = await QueryTable.get(key);
				console.log(result);
			} catch (error) {
				get_error = error;
			}
			assert(get_error.message.includes('key size is too large'));
		}
		for (let i = 0; i < 5; i++) {
			get_error = null;
			try {
				let result;
				result = await QueryTable.get(key.toString());
				console.log(result);
			} catch (error) {
				get_error = error;
			}
			assert(get_error.message.includes('key size is too large'));
		}
		let put_error;
		try {
			let result;
			result = await QueryTable.put(key, { name: 'should be too big' });
			console.log(result);
		} catch (error) {
			put_error = error;
		}
		assert(put_error.message.includes('key size is too large'));
	});
});
