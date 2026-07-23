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

	it('does not reject a non-reserved database name as reserved', async () => {
		// A normal name must pass the reserved-name check. It may still fail later
		// (no schema metadata / bridge in this unit context) — just not as reserved.
		let err;
		try {
			await schema.createSchemaStructure({ operation: 'create_schema', schema: 'my_normal_db' });
		} catch (e) {
			err = e;
		}
		if (err) assert.doesNotMatch(err.message, /reserved name/);
	});
});
