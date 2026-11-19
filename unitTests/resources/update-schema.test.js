const { setupTestDBPath } = require('../testUtils');
const { loadGQLSchema } = require('#src/resources/graphql');
const assert = require('assert');
const test_data = require('../testData');
const { transaction } = require('#src/resources/transaction');
const { IndexRebuildingError } = require('#src/utility/errors/hdbError');
describe('Update Schema', () => {
	before(async function () {
		setupTestDBPath();
		await loadGQLSchema(`
		type SchemaChanges @table {
			id: Int @primaryKey
			state: String
			city: String
		}`);
	});
	it('Add some records and then index them', async function () {
		await transaction((context) => {
			return Promise.all(test_data.map((record) => tables.SchemaChanges.put(record, context)));
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
		// the in-progress-index error is a distinct, retryable type so callers can tell it apart
		// from a permanent failure rather than mis-handling the generic 503 (#1355)
		assert(caught_error instanceof IndexRebuildingError, 'expected an IndexRebuildingError while the index builds');
		assert.equal(caught_error.statusCode, 503);
		assert.equal(caught_error.code, 'INDEX_REBUILDING');
		assert.equal(caught_error.retryable, true);
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
	it('rejects moving the primary key on a table that already has records (studio#1199)', async function () {
		// SchemaChanges is populated by the tests above and keyed by `id`. Moving @primaryKey to a
		// different attribute must be rejected: the storage key isn't re-pointed, so it would leave
		// describe reporting the new key while every record stays keyed by `id`.
		let caught;
		try {
			await loadGQLSchema(`
			type SchemaChanges @table {
				id: Int
				state: String @primaryKey
				city: String @indexed
			}`);
		} catch (error) {
			caught = error;
		}
		assert(caught, 'expected changing the primary key to throw');
		assert(caught.message.includes('primary key'), `expected a primary-key error, got: ${caught && caught.message}`);
		assert.equal(caught.statusCode, 400);
		// The real primary key must be left untouched.
		assert.equal(tables.SchemaChanges.primaryKey, 'id');
	});
	after(async function () {
		// Wait for any pending indexing to finish so no LMDB read transactions
		// remain open when the next test suite calls resetDatabases()/close().
		await tables.SchemaChanges?.indexingOperation;
	});
});
