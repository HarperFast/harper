/**
 * Regression test for harper#664: `describe_table` on a `schema_defined: true` table only
 * ever reported the declared attributes, even when stored records carried additional fields
 * -- with no signal that the schema and the data disagreed.
 *
 * `schema_defined: true` intentionally does not auto-register attributes discovered from
 * writes (that's the dynamic-table behavior, gated by `schema_defined: false`), and tables
 * are not implicitly `sealed`, so writes with undeclared fields succeed silently. The fix
 * doesn't change that scoping -- it makes the mismatch visible via a new
 * `undeclared_attributes` field on the `describe_table` response.
 */
import { suite, test, before, after } from 'node:test';
import assert from 'node:assert';
import { startHarper, teardownHarper } from '@harperfast/integration-testing';
import { createApiClient } from './utils/client.mjs';

suite('describe_table surfaces undeclared attributes on schema_defined tables', (ctx) => {
	let client;

	before(async () => {
		await startHarper(ctx, { config: {}, env: {} });
		client = createApiClient(ctx.harper);
	});

	after(async () => {
		await teardownHarper(ctx);
	});

	test('create schema_defined table with only a primary key declared', async () => {
		await client
			.req()
			.send({
				operation: 'create_table',
				database: 'load_test',
				table: 'Account',
				primary_key: 'id',
				attributes: [{ name: 'id', is_primary_key: true }],
			})
			.expect(200);
	});

	test('insert a record with attributes beyond the declared schema', async () => {
		await client
			.req()
			.send({
				operation: 'insert',
				database: 'load_test',
				table: 'Account',
				records: [{ id: '1', name: 'Alice', email: 'alice@example.com' }],
			})
			.expect((r) => assert.equal(r.body.inserted_hashes.length, 1, r.text))
			.expect(200);
	});

	test('describe_table reports schema_defined: true with only the declared attribute', async () => {
		const res = await client
			.req()
			.send({ operation: 'describe_table', database: 'load_test', table: 'Account' })
			.expect(200);
		assert.equal(res.body.schema_defined, true);
		const attributeNames = res.body.attributes.map((attribute) => attribute.attribute);
		assert.deepEqual(attributeNames, ['id'], 'the declared schema is unchanged by the undeclared write');
	});

	test('describe_table surfaces the undeclared attributes actually present in data', async () => {
		const res = await client
			.req()
			.send({ operation: 'describe_table', database: 'load_test', table: 'Account' })
			.expect(200);
		assert.deepEqual(
			[...res.body.undeclared_attributes].sort(),
			['email', 'name'],
			'name/email were written but never declared, so describe_table must flag them, not silently drop them'
		);
	});

	test('describe_table with skip_record_count omits the undeclared-attribute scan', async () => {
		const res = await client
			.req()
			.send({ operation: 'describe_table', database: 'load_test', table: 'Account', skip_record_count: true })
			.expect(200);
		assert.equal(res.body.undeclared_attributes, undefined);
	});
});
