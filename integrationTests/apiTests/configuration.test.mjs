/**
 * Configuration integration tests.
 *
 * Ported from legacy `apiTests/tests/12_configuration.mjs`. Validates:
 * - `create_attribute` / `drop_attribute` with secondary-index confirmation
 * - `get_configuration` shape (key sections present)
 * - `read_log` shape
 * - `set_configuration` round-trip and bad-data rejection
 * - Non-superuser role cannot call `get_configuration` (403)
 *
 * Self-contained setup: creates the `dev` schema and an `AttributeDropTest`
 * table (with a pre-existing `another_attribute`) in `before()` so the
 * drop-attribute test has something to drop. The `create_attr_test` table and
 * its `owner_id` attribute are created inline by the tests themselves.
 */
import { suite, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { startHarper, teardownHarper } from '@harperfast/integration-testing';
import { createApiClient } from './utils/client.mjs';

const SCHEMA = 'dev';
const ATTR_TEST_TABLE = 'create_attr_test';
const DROP_ATTR_TABLE = 'AttributeDropTest';
const SCHEMALESS_TABLE = 'MqttRetained';

const TEST_ROLE = 'test_dev_role';
const TEST_USER = 'test_user';
const TEST_PASS = 'TestPassword123!';

suite('Configuration', (ctx) => {
	let client;

	before(async () => {
		await startHarper(ctx, { config: {}, env: {} });
		client = createApiClient(ctx.harper);

		// Seed schema and the AttributeDropTest table with a pre-existing attribute
		// so the "Drop Attribute" test has something to drop.
		await client.req().send({ operation: 'create_schema', schema: SCHEMA }).expect(200);
		await client
			.req()
			.send({ operation: 'create_table', schema: SCHEMA, table: DROP_ATTR_TABLE, hash_attribute: 'id' })
			.expect(200);
		await client
			.req()
			.send({
				operation: 'create_attribute',
				schema: SCHEMA,
				table: DROP_ATTR_TABLE,
				attribute: 'another_attribute',
			})
			.expect(200);
	});

	after(async () => {
		await teardownHarper(ctx);
	});

	// ── create_attribute / secondary-index ──────────────────────────────────

	test('create_table for attribute tests', async () => {
		await client
			.req()
			.send({ operation: 'create_table', schema: SCHEMA, table: ATTR_TEST_TABLE, hash_attribute: 'id' })
			.expect((r) => assert.ok(r.body.message.includes('successfully created'), r.text))
			.expect(200);
	});

	test('create_attribute for secondary indexing', async () => {
		await client
			.req()
			.send({ operation: 'create_attribute', schema: SCHEMA, table: ATTR_TEST_TABLE, attribute: 'owner_id' })
			.expect((r) =>
				assert.equal(r.body.message, `attribute '${SCHEMA}.${ATTR_TEST_TABLE}.owner_id' successfully created.`, r.text)
			)
			.expect(200);
	});

	test('insert data for secondary indexing test', async () => {
		await client
			.req()
			.send({
				operation: 'insert',
				schema: SCHEMA,
				table: ATTR_TEST_TABLE,
				records: [
					{ id: 1, dog_name: 'Penny', age: 5, owner_id: 1 },
					{ id: 2, dog_name: 'Harper', age: 5, owner_id: 3 },
					{ id: 3, dog_name: 'Alby', age: 5, owner_id: 1 },
					{ id: 4, dog_name: 'Billy', age: 4, owner_id: 1 },
					{ id: 5, dog_name: 'Rose Merry', age: 6, owner_id: 2 },
					{ id: 6, dog_name: 'Kato', age: 4, owner_id: 2 },
					{ id: 7, dog_name: 'Simon', age: 1, owner_id: 2 },
					{ id: 8, dog_name: 'Gemma', age: 3, owner_id: 2 },
					{ id: 9, dog_name: 'Bode', age: 8 },
				],
			})
			.expect((r) => assert.equal(r.body.message, 'inserted 9 of 9 records', r.text))
			.expect(200);
	});

	test('secondary index on owner_id returns correct count', async () => {
		await client
			.req()
			.send({ operation: 'sql', sql: `select * from ${SCHEMA}.${ATTR_TEST_TABLE} where owner_id = 1` })
			.expect((r) => assert.equal(r.body.length, 3, r.text))
			.expect(200);
	});

	// ── AttributeDropTest ───────────────────────────────────────────────────

	test('describe_table AttributeDropTest before creating attribute', async () => {
		// `describe_table` response body has `{attributes: [...]}` — the top-level body
		// object will not have an `another_attribute` key, so `!r.body.another_attribute` is true.
		await client
			.req()
			.send({ operation: 'describe_table', table: DROP_ATTR_TABLE, schema: SCHEMA })
			.expect((r) => assert.ok(!r.body.another_attribute, r.text))
			.expect(200);
	});

	test('create_attribute adds created_attribute', async () => {
		await client
			.req()
			.send({
				operation: 'create_attribute',
				schema: SCHEMA,
				table: DROP_ATTR_TABLE,
				attribute: 'created_attribute',
			})
			.expect((r) =>
				assert.equal(
					r.body.message,
					`attribute '${SCHEMA}.${DROP_ATTR_TABLE}.created_attribute' successfully created.`,
					r.text
				)
			)
			.expect(200);
	});

	test('created_attribute appears in describe_table', async () => {
		await client
			.req()
			.send({ operation: 'describe_table', table: DROP_ATTR_TABLE, schema: SCHEMA })
			.expect((r) => {
				const found = r.body.attributes?.some((a) => a.attribute === 'created_attribute');
				assert.ok(found, r.text);
			})
			.expect(200);
	});

	test('create_attribute duplicate returns 400', async () => {
		await client
			.req()
			.send({
				operation: 'create_attribute',
				schema: SCHEMA,
				table: DROP_ATTR_TABLE,
				attribute: 'created_attribute',
			})
			.expect((r) =>
				assert.equal(
					r.body.error,
					`attribute 'created_attribute' already exists in ${SCHEMA}.${DROP_ATTR_TABLE}`,
					r.text
				)
			)
			.expect(400);
	});

	test('drop_attribute removes another_attribute', async () => {
		await client
			.req()
			.send({
				operation: 'drop_attribute',
				schema: SCHEMA,
				table: DROP_ATTR_TABLE,
				attribute: 'another_attribute',
			})
			.expect((r) => assert.equal(r.body.message, "successfully deleted attribute 'another_attribute'", r.text))
			.expect(200);
	});

	test('another_attribute is gone from describe_table', async () => {
		await client
			.req()
			.send({ operation: 'describe_table', table: DROP_ATTR_TABLE, schema: SCHEMA })
			.expect((r) => {
				const found = r.body.attributes?.some((a) => a.attribute === 'another_attribute');
				assert.ok(!found, r.text);
			})
			.expect(200);
	});

	// ── get_configuration / read_log ────────────────────────────────────────

	test('get_configuration returns expected top-level keys', async () => {
		await client
			.req()
			.send({ operation: 'get_configuration' })
			.expect((r) => {
				assert.ok(r.body.componentsRoot, r.text);
				assert.ok(r.body.logging, r.text);
				assert.ok(r.body.localStudio, r.text);
				assert.ok(r.body.operationsApi, r.text);
				assert.ok(r.body.operationsApi.network?.port, r.text);
				assert.ok(r.body.threads, r.text);
			})
			.expect(200);
	});

	test('read_log returns array with level/message/timestamp', async () => {
		await client
			.req()
			.send({ operation: 'read_log' })
			.expect((r) => {
				assert.ok(Array.isArray(r.body), r.text);
				assert.ok(r.body[0].hasOwnProperty('level'), r.text);
				assert.ok(r.body[0].hasOwnProperty('message'), r.text);
				assert.ok(r.body[0].hasOwnProperty('timestamp'), r.text);
			})
			.expect(200);
	});

	// ── set_configuration ───────────────────────────────────────────────────

	test('set_configuration accepts valid value', async () => {
		await client
			.req()
			.send({ operation: 'set_configuration', logging_rotation_maxSize: '12M' })
			.expect((r) =>
				assert.equal(
					r.body.message,
					'Configuration successfully set. You must restart Harper for new config settings to take effect.'
				)
			)
			.expect(200);
	});

	test('get_configuration reflects set_configuration change', async () => {
		await client
			.req()
			.send({ operation: 'get_configuration' })
			.expect((r) => assert.equal(r.body.logging.rotation.maxSize, '12M', r.text))
			.expect(200);
	});

	test('set_configuration rejects invalid value with 400', async () => {
		await client
			.req()
			.send({ operation: 'set_configuration', http_cors: 'spinach' })
			.expect((r) =>
				assert.equal(r.body.error, "Harper config file validation error: 'http.cors' must be a boolean", r.text)
			)
			.expect(400);
	});

	// ── non-superuser role restrictions ─────────────────────────────────────

	test('add non-SU role and user', async () => {
		await client
			.req()
			.send({ operation: 'add_role', role: TEST_ROLE, permission: { super_user: false } })
			.expect(200);
		await client
			.req()
			.send({
				operation: 'add_user',
				role: TEST_ROLE,
				username: TEST_USER,
				password: TEST_PASS,
				active: true,
			})
			.expect(200);
	});

	test('get_configuration as non-SU returns 403', async () => {
		const nonSuHeaders = {
			'Authorization': `Basic ${Buffer.from(`${TEST_USER}:${TEST_PASS}`).toString('base64')}`,
			'Content-Type': 'application/json',
		};
		await request(client.operationsURL)
			.post('')
			.set(nonSuHeaders)
			.send({ operation: 'get_configuration' })
			.expect((r) => {
				assert.equal(
					r.body.error,
					'This operation is not authorized due to role restrictions and/or invalid database items',
					r.text
				);
				assert.equal(r.body.unauthorized_access?.length, 1, r.text);
				assert.equal(
					r.body.unauthorized_access[0],
					"Operation 'getConfiguration' is restricted to 'super_user' roles",
					r.text
				);
			})
			.expect(403);
	});

	test('drop test user and role', async () => {
		await client
			.req()
			.send({ operation: 'drop_user', username: TEST_USER })
			.expect((r) => assert.equal(r.body.message, `${TEST_USER} successfully deleted`, r.text))
			.expect(200);
		await client
			.req()
			.send({ operation: 'drop_role', id: TEST_ROLE })
			.expect((r) => assert.equal(r.body.message, `${TEST_ROLE} successfully deleted`, r.text))
			.expect(200);
	});

	// ── schema-less table (no declared attributes) ───────────────────────────

	test('create schema-less table with no declared attributes', async () => {
		await client
			.req()
			.send({ operation: 'create_table', schema: SCHEMA, table: SCHEMALESS_TABLE, hash_attribute: 'id' })
			.expect((r) => assert.ok(r.body.message.includes('successfully created'), r.text))
			.expect(200);
	});

	test('schema-less table accepts insert with arbitrary fields', async () => {
		await client
			.req()
			.send({
				operation: 'insert',
				schema: SCHEMA,
				table: SCHEMALESS_TABLE,
				records: [
					{
						id: '/sensors/temperature/room1',
						payload: '{"temperature":22.5,"unit":"C"}',
						qos: 1,
						retained: true,
						timestamp: 1699000000000,
					},
				],
			})
			.expect((r) => assert.equal(r.body.message, 'inserted 1 of 1 records', r.text))
			.expect(200);
	});

	test('schema-less table stores and retrieves arbitrary fields', async () => {
		const r = await client
			.req()
			.send({ operation: 'sql', sql: `SELECT * FROM ${SCHEMA}.${SCHEMALESS_TABLE}` })
			.expect(200);
		assert.ok(Array.isArray(r.body), r.text);
		assert.equal(r.body.length, 1, r.text);
		const record = r.body[0];
		assert.equal(record.id, '/sensors/temperature/room1', r.text);
		assert.equal(record.payload, '{"temperature":22.5,"unit":"C"}', r.text);
		assert.equal(record.qos, 1, r.text);
		assert.equal(record.retained, true, r.text);
	});

	test('schema-less table upsert overwrites retained message for same id', async () => {
		await client
			.req()
			.send({
				operation: 'upsert',
				schema: SCHEMA,
				table: SCHEMALESS_TABLE,
				records: [
					{
						id: '/sensors/temperature/room1',
						payload: '{"temperature":23.0,"unit":"C"}',
						qos: 1,
						retained: true,
						timestamp: 1699001000000,
					},
				],
			})
			.expect((r) => assert.ok(r.body.upserted_hashes?.length === 1, r.text))
			.expect(200);

		const r = await client
			.req()
			.send({ operation: 'sql', sql: `SELECT * FROM ${SCHEMA}.${SCHEMALESS_TABLE}` })
			.expect(200);
		assert.equal(r.body.length, 1, `expected 1 retained record after upsert\n${r.text}`);
		assert.equal(r.body[0].payload, '{"temperature":23.0,"unit":"C"}', r.text);
	});
});
