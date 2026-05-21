/**
 * Token authentication integration tests.
 *
 * Ported from legacy `apiTests/tests/14_tokenAuth.mjs`. Validates:
 * - `create_authentication_tokens` happy path + missing/invalid-credential
 *   paths
 * - bearer-token search (`search_by_hash` with `Authorization: Bearer <op>`)
 * - `refresh_operation_token` with valid and invalid refresh tokens
 *
 * Self-contained: each suite seeds a minimal `northnwd.employees` table
 * with `employeeid: 1` so the bearer-token search has a deterministic
 * record to fetch. The legacy version inherited this from
 * `2_dataLoad.mjs`, but the new layout owns its own data.
 *
 * The integration framework starts Harper on a loopback IP, which gets
 * auto-authorized when `authentication.authorizeLocal` is true (the
 * default). The legacy test branched on `isDevEnv()` to handle both
 * configurations; we preserve that branching since the framework's
 * default config controls which mode applies.
 *
 * `refresh_operation_token` is skipped on Bun: the operation hangs
 * indefinitely under Harper-on-Bun. Tracked in issue #697.
 */
import { suite, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { startHarper, teardownHarper } from '@harperfast/integration-testing';
import { createApiClient } from './utils/client.mjs';

const SCHEMA = 'northnwd';
const TABLE = 'employees';
const PRIMARY_KEY = 'employeeid';

// refresh_operation_token hangs indefinitely on Harper-on-Bun (issue #697)
const skipOnBun = process.env.HARPER_RUNTIME === 'bun';

suite('Token authentication', (ctx) => {
	let client;
	let admin;
	let operationToken;
	let refreshToken;
	let authorizeLocal;

	before(async () => {
		await startHarper(ctx, { config: {}, env: {} });
		client = createApiClient(ctx.harper);
		admin = ctx.harper.admin;

		// Discover which auth-local mode the framework is configured with so
		// the no-credentials assertion below can branch correctly.
		const config = await client.req().send({ operation: 'get_configuration' }).expect(200);
		authorizeLocal = config.body.authentication?.authorizeLocal === true;

		// Seed a single employees row so the bearer-token search has a record.
		await client.req().send({ operation: 'create_schema', schema: SCHEMA }).expect(200);
		await client
			.req()
			.send({ operation: 'create_table', schema: SCHEMA, table: TABLE, hash_attribute: PRIMARY_KEY })
			.expect(200);
		await client
			.req()
			.send({
				operation: 'insert',
				schema: SCHEMA,
				table: TABLE,
				records: [{ employeeid: 1, firstname: 'Test', lastname: 'Employee' }],
			})
			.expect(200);
	});

	after(async () => {
		await teardownHarper(ctx);
	});

	test('create_authentication_tokens with no credentials reflects authorizeLocal mode', async () => {
		const r = await request(client.operationsURL)
			.post('')
			.set({ 'Content-Type': 'application/json' })
			.send({ operation: 'create_authentication_tokens' });
		if (authorizeLocal) {
			// Loopback caller is auto-authorized → mints a token.
			assert.equal(r.status, 200, r.text);
			assert.notEqual(r.body.operation_token, undefined, r.text);
		} else {
			assert.equal(r.status, 401, r.text);
			assert.equal(r.body.error, 'Must login', r.text);
		}
	});

	test('create_authentication_tokens with no password returns 401', async () => {
		await request(client.operationsURL)
			.post('')
			.set({ 'Content-Type': 'application/json' })
			.send({ operation: 'create_authentication_tokens', username: admin.username })
			.expect((r) => assert.equal(r.body.error, 'invalid credentials', r.text))
			.expect(401);
	});

	test('create_authentication_tokens with bad credentials returns 401', async () => {
		await request(client.operationsURL)
			.post('')
			.set({ 'Content-Type': 'application/json' })
			.send({
				operation: 'create_authentication_tokens',
				username: 'baduser',
				password: 'bad',
				bypass_auth: true,
			})
			.expect((r) => assert.equal(r.body.error, 'invalid credentials', r.text))
			.expect(401);
	});

	test('create_authentication_tokens happy path returns operation + refresh tokens', async () => {
		const response = await request(client.operationsURL)
			.post('')
			.set({ 'Content-Type': 'application/json' })
			.send({
				operation: 'create_authentication_tokens',
				username: admin.username,
				password: admin.password,
			})
			.expect(200);

		assert.notEqual(response.body.operation_token, undefined, response.text);
		assert.notEqual(response.body.refresh_token, undefined, response.text);
		operationToken = response.body.operation_token;
		refreshToken = response.body.refresh_token;
	});

	test('search_by_hash with valid JWT returns the seeded record', async () => {
		await request(client.operationsURL)
			.post('')
			.set('Content-Type', 'application/json')
			.set('Authorization', `Bearer ${operationToken}`)
			.send({
				operation: 'search_by_hash',
				schema: SCHEMA,
				table: TABLE,
				primary_key: PRIMARY_KEY,
				hash_values: [1],
				get_attributes: ['*'],
			})
			.expect((r) => assert.equal(r.body.length, 1, r.text))
			.expect((r) => assert.equal(r.body[0][PRIMARY_KEY], 1, r.text))
			.expect(200);
	});

	test('search_by_hash with invalid JWT returns 401', async () => {
		await request(client.operationsURL)
			.post('')
			.set('Content-Type', 'application/json')
			.set('Authorization', 'Bearer BAD_TOKEN')
			.send({
				operation: 'search_by_hash',
				schema: SCHEMA,
				table: TABLE,
				primary_key: PRIMARY_KEY,
				hash_values: [1],
				get_attributes: ['*'],
			})
			.expect((r) => assert.ok(r.text.includes('"error":"invalid token"'), r.text))
			.expect(401);
	});

	test(
		'refresh_operation_token with valid refresh token mints a new operation token',
		{ skip: skipOnBun },
		async () => {
			const response = await request(client.operationsURL)
				.post('')
				.set('Content-Type', 'application/json')
				.set('Authorization', `Bearer ${refreshToken}`)
				.send({ operation: 'refresh_operation_token' })
				.expect(200);

			assert.notEqual(response.body.operation_token, undefined, response.text);
			operationToken = response.body.operation_token;
		}
	);

	test('refresh_operation_token with invalid token returns 401', { skip: skipOnBun }, async () => {
		await request(client.operationsURL)
			.post('')
			.set('Content-Type', 'application/json')
			.set('Authorization', 'Bearer bad token')
			.send({ operation: 'refresh_operation_token' })
			.expect((r) => assert.ok(r.text.includes('invalid token'), r.text))
			.expect(401);
	});

	test('create_authentication_tokens with basic-auth current user works', async () => {
		const response = await client.req().send({ operation: 'create_authentication_tokens' }).expect(200);
		assert.notEqual(response.body.operation_token, undefined, response.text);
		assert.notEqual(response.body.refresh_token, undefined, response.text);
	});
});
