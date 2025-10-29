import { describe, it, before, after } from 'mocha';
import { createTestSandbox, cleanupTestSandbox, waitUntilDefined } from '../testUtils';
import { loadGQLSchema } from '@/resources/graphql';
import assert from 'node:assert/strict';
import testData from '../testData.json';
import { transaction } from '@/resources/transaction';
import { tables } from '@/resources/databases';

describe('Update Schema', () => {
	before(async function () {
		createTestSandbox();
		await loadGQLSchema(`
		type SchemaChanges @table {
			id: Int @primaryKey
			state: String
			city: String
		}`);
	});

	after(cleanupTestSandbox);

	it('Add some records and then index them', async function () {
		await waitUntilDefined(tables.SchemaChanges);
		await transaction((context) => {
			testData.map((record) => tables.SchemaChanges.put(record, context));
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
