const { setupTestDBPath } = require('../testUtils');
const { loadGQLSchema } = require('#src/resources/graphql');
const harperBridge = require('#src/dataLayer/harperBridge/harperBridge').default;
const { transaction } = require('#src/resources/transaction');
const assert = require('node:assert');

// The Operations API `delete` is guarded up front by deleteValidator, but the SQL `DELETE` path
// (sqlTranslator/deleteTranslator.ts) and other internal callers reach ResourceBridge.deleteRecords
// directly with only `records`/`ids`/`hash_values` set -- never touching the validator. A null
// primary key there would be coerced into a whole-collection target and silently delete every row,
// so the bridge guards each id itself. These exercise that guard directly (studio#1199).
describe('ResourceBridge.deleteRecords rejects a null primary key', () => {
	before(async () => {
		setupTestDBPath();
		await loadGQLSchema(`
		type NullPkDelete @table {
			id: Int @primaryKey
			name: String
		}`);
		await transaction((context) =>
			Promise.all([
				tables.NullPkDelete.put({ id: 1, name: 'a' }, context),
				tables.NullPkDelete.put({ id: 2, name: 'b' }, context),
			])
		);
	});

	function recordCount() {
		let count = 0;
		for (const _entry of tables.NullPkDelete.primaryStore.getRange({ start: true })) count++;
		return count;
	}

	const cases = [
		['hash_values', { schema: 'data', table: 'NullPkDelete', hash_values: [null] }],
		['ids', { schema: 'data', table: 'NullPkDelete', ids: [null] }],
		// The SQL DELETE shape: records whose primary-key attribute is unset map to a null id.
		['records missing the primary key', { schema: 'data', table: 'NullPkDelete', records: [{ name: 'c' }] }],
	];

	for (const [label, deleteObj] of cases) {
		it(`throws for ${label} and deletes nothing`, async () => {
			await assert.rejects(() => harperBridge.deleteRecords(deleteObj), /Invalid primary key of null/);
			assert.strictEqual(recordCount(), 2, 'no records should have been deleted');
		});
	}

	it('still deletes normally by a real primary key (the guard does not block valid ids)', async () => {
		const result = await harperBridge.deleteRecords({ schema: 'data', table: 'NullPkDelete', hash_values: [2] });
		assert.deepStrictEqual(result.deleted_hashes, [2]);
		assert.deepStrictEqual(result.skipped_hashes, []);
	});

	after(async () => {
		await tables.NullPkDelete?.indexingOperation;
	});
});
