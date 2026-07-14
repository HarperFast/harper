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
 *
 * Also covers the metadata-leak guard: a caller whose role restricts
 * `attribute_permissions` on the table must never see `undeclared_attributes`, since those
 * attributes have no permission entry to check them against.
 */
import { suite, test, before, after } from 'node:test';
import assert from 'node:assert';
import { startHarper, teardownHarper } from '@harperfast/integration-testing';
import { createApiClient, createHeaders } from './utils/client.mjs';

const RESTRICTED_ROLE = 'account_attr_restricted_role';
const RESTRICTED_USERNAME = 'account_attr_restricted_user';

suite('describe_table surfaces undeclared attributes on schema_defined tables', (ctx) => {
	let client;
	let restrictedUserHeaders;

	before(async () => {
		await startHarper(ctx, { config: {}, env: {} });
		client = createApiClient(ctx.harper);
		restrictedUserHeaders = createHeaders(RESTRICTED_USERNAME, ctx.harper.admin.password);
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
			.expect((r) => assert.strictEqual(r.body.inserted_hashes.length, 1, r.text))
			.expect(200);
	});

	test('describe_table reports schema_defined: true with only the declared attribute', async () => {
		const res = await client
			.req()
			.send({ operation: 'describe_table', database: 'load_test', table: 'Account' })
			.expect(200);
		assert.strictEqual(res.body.schema_defined, true);
		const attributeNames = res.body.attributes.map((attribute) => attribute.attribute);
		assert.deepStrictEqual(attributeNames, ['id'], 'the declared schema is unchanged by the undeclared write');
	});

	test('describe_table surfaces the undeclared attributes actually present in data', async () => {
		const res = await client
			.req()
			.send({ operation: 'describe_table', database: 'load_test', table: 'Account' })
			.expect(200);
		assert.deepStrictEqual(
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
		assert.strictEqual(res.body.undeclared_attributes, undefined);
	});

	// Regression coverage for the metadata-leak guard: undeclared attributes have no
	// attribute_permissions entry at all, so a caller whose role restricts attribute_permissions
	// on this table must never see their names -- describe_table suppresses `undeclared_attributes`
	// entirely for such callers, rather than filtering it down to "permitted" undeclared attributes
	// (there's no permission entry to check them against). Only `id` is granted here; the
	// undeclared `name`/`email` attributes inserted above must not leak through this restricted role.
	test('add a role with attribute_permissions restricting the Account table', async () => {
		await client
			.req()
			.send({
				operation: 'add_role',
				role: RESTRICTED_ROLE,
				permission: {
					super_user: false,
					load_test: {
						tables: {
							Account: {
								read: true,
								insert: false,
								update: false,
								delete: false,
								attribute_permissions: [{ attribute_name: 'id', read: true, insert: false, update: false }],
							},
						},
					},
				},
			})
			.expect(200);
	});

	test('add a user bound to the attribute-permission-restricted role', async () => {
		await client
			.req()
			.send({
				operation: 'add_user',
				role: RESTRICTED_ROLE,
				username: RESTRICTED_USERNAME,
				password: ctx.harper.admin.password,
				active: true,
			})
			.expect(200);
	});

	test('describe_table as the attribute-permission-restricted role never surfaces undeclared_attributes', async () => {
		const res = await client
			.reqAs(restrictedUserHeaders)
			.send({ operation: 'describe_table', database: 'load_test', table: 'Account' })
			.expect(200);
		assert.strictEqual(
			Object.prototype.hasOwnProperty.call(res.body, 'undeclared_attributes'),
			false,
			'undeclared attributes have no attribute_permissions entry, so surfacing their names to a ' +
				'permission-restricted caller would leak attribute-name metadata that role cannot see'
		);
	});
});
