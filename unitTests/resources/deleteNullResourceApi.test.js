const { setupTestDBPath } = require('../testUtils');
const { loadGQLSchema } = require('#src/resources/graphql');
const { transaction } = require('#src/resources/transaction');
const assert = require('node:assert');

// The Resource API mirror of the studio#1199 bug class: `Table.delete(null)` (or undefined, or no
// argument) was normalized by transactional() into a whole-collection target with no conditions and
// silently deleted every record, returning true. A bare null id must throw; a deliberate delete-all
// still works through an explicit query object.
describe('Table.delete with a null/undefined id', () => {
	before(async () => {
		setupTestDBPath();
		await loadGQLSchema(`
		type NullIdResourceDelete @table {
			id: Int @primaryKey
			name: String
		}`);
		await transaction((context) =>
			Promise.all([
				tables.NullIdResourceDelete.put({ id: 1, name: 'a' }, context),
				tables.NullIdResourceDelete.put({ id: 2, name: 'b' }, context),
			])
		);
	});

	function recordCount() {
		// deletes leave tombstone entries in the primary store, so count only live values
		let count = 0;
		for (const entry of tables.NullIdResourceDelete.primaryStore.getRange({ start: true }))
			if (entry.value != null) count++;
		return count;
	}

	for (const [label, invoke] of [
		['null', () => tables.NullIdResourceDelete.delete(null)],
		['undefined', () => tables.NullIdResourceDelete.delete(undefined)],
		['no argument', () => tables.NullIdResourceDelete.delete()],
	]) {
		it(`throws for ${label} and deletes nothing`, () => {
			assert.throws(invoke, /is not allowed/);
			assert.strictEqual(recordCount(), 2, 'no records should have been deleted');
		});
	}

	it('still deletes normally by a real id', async () => {
		assert.strictEqual(await transaction((context) => tables.NullIdResourceDelete.delete(2, context)), true);
		await tables.NullIdResourceDelete.primaryStore.flushed;
		assert.strictEqual(recordCount(), 1);
	});

	it('still deletes the whole collection through an explicit query object', async () => {
		assert.strictEqual(await transaction((context) => tables.NullIdResourceDelete.delete({}, context)), true);
		await tables.NullIdResourceDelete.primaryStore.flushed;
		assert.strictEqual(recordCount(), 0);
	});

	after(async () => {
		await tables.NullIdResourceDelete?.indexingOperation;
	});
});
