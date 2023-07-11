const { getMockLMDBPath } = require('../test_utils');
const { start } = require('../../resources/graphql');
const { table } = require('../../resources/databases');
const assert = require('assert');
const test_data = require('../testData');
const { transaction } = require('../../resources/transaction');
describe('Update Schema', () => {
	let workers, server;
	const { handleFile } = start({ ensureTable: table });
	before(async function () {
		let path = getMockLMDBPath();
		await handleFile(`
		type SchemaChanges @table {
			id: ID @primaryKey
			state: String
			city: String
		}`);
	});
	it('Add some records and then index them', async function () {
		await transaction((context) => {
			test_data.map((record) => tables.SchemaChanges.create(record, context));
		});
		let caught_error;
		try {
			tables.SchemaChanges.search({ conditions: [{ attribute: 'state', value: 'UT' }] });
		} catch (error) {
			caught_error = error;
		}
		//assert(caught_error?.message.includes('not indexed'));
		await handleFile(`
		type SchemaChanges @table {
			id: ID @primaryKey
			state: String @indexed
			city: String @indexed
		}`);
		try {
			tables.SchemaChanges.search({ conditions: [{ attribute: 'state', value: 'UT' }] });
		} catch (error) {
			caught_error = error;
		}
		assert(caught_error?.message.includes('not indexed yet'));
		await tables.SchemaChanges.indexingOperation;
		let records = [];
		for await (let record of tables.SchemaChanges.search({ conditions: [{ attribute: 'state', value: 'UT' }] })) {
			records.push(record);
		}
		assert.equal(records.length, 21);
	});
});
