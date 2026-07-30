const assert = require('node:assert');
const schema = require('#src/dataLayer/schema');
const { table } = require('#src/resources/databases');

// harper#1016: a role's `permission` object keys per-database permissions by
// database name alongside named flags (super_user / cluster_user /
// structure_user / operations / _expandedOperations). A database named after one
// of those flags collides with it, so those names are rejected as database
// identifiers — at both the operations API (create_schema / create_table) and
// the schema-authoring path (graphql `@table(database:)` / programmatic table()).
const RESERVED = ['super_user', 'cluster_user', 'structure_user', 'operations', '_expandedOperations'];

describe('#1016 reserved database names', () => {
	for (const name of RESERVED) {
		it(`create_schema rejects reserved name '${name}'`, async () => {
			await assert.rejects(
				() => schema.createSchemaStructure({ operation: 'create_schema', schema: name }),
				/reserved name/,
				`create_schema accepted reserved name '${name}'`
			);
		});

		it(`create_table rejects reserved database '${name}'`, async () => {
			await assert.rejects(
				() => schema.createTableStructure({ operation: 'create_table', schema: name, table: 't', primary_key: 'id' }),
				/reserved name/,
				`create_table accepted reserved database '${name}'`
			);
		});

		it(`schema authoring (table()) rejects reserved database '${name}'`, () => {
			// graphql `@table(database:)` and programmatic table() funnel through here,
			// bypassing the operations-API validation. The check throws before any store IO.
			assert.throws(
				() => table({ database: name, table: 't', attributes: [{ name: 'id', isPrimaryKey: true }] }),
				/reserved name/,
				`table() accepted reserved database '${name}'`
			);
		});
	}

	// Validation-only control (review): calling `createSchemaStructure` with a nonexistent normal name
	// takes the successful creation path, so it created `my_normal_db` on whatever root the environment
	// was configured with and signalled a schema change — a unit test with a side effect on a developer
	// checkout. `validateDatabaseName` runs the same constraint the create paths run, without the IO.
	it('does not reject a non-reserved database name as reserved', () => {
		assert.strictEqual(schema.validateDatabaseName('my_normal_db'), undefined);
	});

	it('rejects a reserved name through the same validation, so the control above is meaningful', () => {
		for (const name of RESERVED) {
			assert.match(schema.validateDatabaseName(name).message, /reserved name/);
		}
	});
});
