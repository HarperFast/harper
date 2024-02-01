const { getMockLMDBPath } = require('../test_utils');
const { loadGQLSchema } = require('../../resources/graphql');
const assert = require('assert');
const test_data = require('../testData');
const { transaction } = require('../../resources/transaction');
describe('Update Schema', () => {
	before(async function () {
		getMockLMDBPath();
		await loadGQLSchema(`
		type SchemaChanges @table {
			id: Int @primaryKey
			state: String
			city: String
		}`);
	});
	it('Add some records and then index them', async function () {
		await transaction((context) => {
			test_data.map((record) => tables.SchemaChanges.put(record, context));
		});
		let caught_error;
		try {
			tables.SchemaChanges.search({
				allowFullScan: false,
				conditions: [{ attribute: 'state', value: 'UT' }],
			});
		} catch (error) {
			caught_error = error;
		}
		assert(caught_error?.message.includes('not indexed'));
		await loadGQLSchema(`
		type SchemaChanges @table {
			id: Int @primaryKey
			state: String @indexed
			city: String @indexed
		}`);
		caught_error = null;
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
	it('Schema change', async function () {
		await loadGQLSchema(`
		type SchemaChanges @table {
			id: Int @primaryKey
			state: String! @indexed
			city: String! @indexed
		}`);
		await loadGQLSchema(`
		type SchemaChanges @table {
			id: Int @primaryKey
			state: String @indexed
			city: String @indexed
		}`);
		const state_attribute = tables.SchemaChanges.attributes.find((a) => a.name === 'state');
		assert(state_attribute.nullable !== false);
	});
});
