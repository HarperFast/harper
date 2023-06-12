const { getMockLMDBPath } = require('../test_utils');
const { handleFile } = require('../../resources/graphql');
const assert = require('assert');
const test_data = require('../testData');
describe('Update Schema', () => {
	let workers, server;
	before(async function () {
		this.timeout(15000);
		let path = getMockLMDBPath();
		handleFile(`
		type SchemaChanges @table {
			id: ID @primaryKey
			state: String
			city: String
		}`);
	});
	it('Add some records and then index them', async function () {
		await tables.SchemaChanges.transact((table) => {
			test_data.map((record) => table.create(record));
		});
		let caught_error;
		try {
			tables.SchemaChanges.search([{ attribute: 'state', value: 'UT' }]);
		} catch (error) {
			caught_error = error;
		}
		assert(caught_error?.message.includes('not indexed'));
		handleFile(`
		type SchemaChanges @table {
			id: ID @primaryKey
			state: String @indexed
			city: String @indexed
		}`);
		try {
			tables.SchemaChanges.search([{ attribute: 'state', value: 'UT' }]);
		} catch (error) {
			caught_error = error;
		}
		assert(caught_error?.message.includes('not indexed yet'));
		await tables.SchemaChanges.indexingOperation;
		for await (let record of tables.SchemaChanges.search([{ attribute: 'state', value: 'UT' }])) {
			console.log(record);
		}
	});
});
