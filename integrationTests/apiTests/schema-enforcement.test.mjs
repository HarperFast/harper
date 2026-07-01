/**
 * Schema enforcement integration tests.
 *
 * Validates:
 * - @sealed table rejects records that include undeclared fields (REST PUT and
 *   operations API insert both enforce the constraint with HTTP 400)
 * - [String] @indexed field supports element-level REST search — a query on the
 *   array attribute returns only records whose array contains that element
 *
 * Both require a component with a GraphQL schema, so each uses
 * installAppComponent + HTTP worker restart. Grouped in a single suite to share
 * the Harper instance and reduce startup cost.
 *
 * Skipped on Windows: restart_service http_workers crashes on the Windows
 * single-worker model (HarperFast/harper#549).
 */
import { suite, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { startHarper, teardownHarper } from '@harperfast/integration-testing';
import { createApiClient } from './utils/client.mjs';
import { installAppComponent } from './utils/components.mjs';

const skipSuite = process.platform === 'win32';

const CONFIG_YAML = "rest: true\ngraphqlSchema:\n  files: '*.graphql'\ngraphql: true\n";

// Only id, name, and count are declared — any other property must be rejected.
const SEALED_SCHEMA =
	'type SealedRecord @table @sealed @export {\n' +
	'\tid: ID @primaryKey\n' +
	'\tname: String\n' +
	'\tcount: Int\n' +
	'}\n';

// tags is a [String] @indexed array — element-level REST queries must work.
const TAGGED_SCHEMA =
	'type TaggedItem @table @export {\n' +
	'\tid: ID @primaryKey\n' +
	'\tlabel: String\n' +
	'\ttags: [String] @indexed\n' +
	'}\n';

suite('Schema enforcement features', { skip: skipSuite }, (ctx) => {
	let client;

	before(async () => {
		await startHarper(ctx, { config: {}, env: {} });
		client = createApiClient(ctx.harper);

		await installAppComponent(client, {
			project: 'sealedTest',
			files: { 'schema.graphql': SEALED_SCHEMA, 'config.yaml': CONFIG_YAML },
			probePath: '/SealedRecord/',
			restartTimeoutMs: 120000,
		});

		await installAppComponent(client, {
			project: 'taggedTest',
			files: { 'schema.graphql': TAGGED_SCHEMA, 'config.yaml': CONFIG_YAML },
			probePath: '/TaggedItem/',
			restartTimeoutMs: 120000,
		});

		await client
			.req()
			.send({
				operation: 'insert',
				table: 'TaggedItem',
				records: [
					{ id: '1', label: 'alpha-beta', tags: ['alpha', 'beta'] },
					{ id: '2', label: 'beta-gamma', tags: ['beta', 'gamma'] },
					{ id: '3', label: 'gamma-delta', tags: ['gamma', 'delta'] },
				],
			})
			.expect((r) => assert.ok(r.body.message?.includes('inserted 3 of 3 records'), r.text))
			.expect(200);
	});

	after(async () => {
		await teardownHarper(ctx);
	});

	// ── @sealed enforcement ────────────────────────────────────────────────────

	test('@sealed: PUT with declared fields only succeeds', async () => {
		await request(client.restURL)
			.put('/SealedRecord/1')
			.set(client.headers)
			.send({ id: '1', name: 'allowed', count: 5 })
			.expect(204);
	});

	test('@sealed: PUT with undeclared field is rejected with 400', async () => {
		await request(client.restURL)
			.put('/SealedRecord/2')
			.set(client.headers)
			.send({ id: '2', name: 'test', count: 3, extraField: 'not allowed' })
			.expect((r) => {
				assert.ok(r.text.includes('is not allowed'), `expected "is not allowed" in error body, got: ${r.text}`);
			})
			.expect(400);
	});

	test('@sealed: operations API insert with undeclared field is rejected with 400', async () => {
		await client
			.req()
			.send({
				operation: 'insert',
				table: 'SealedRecord',
				records: [{ id: '3', name: 'test', count: 1, hiddenField: 'forbidden' }],
			})
			.expect((r) => {
				assert.ok(r.text.includes('is not allowed'), `expected "is not allowed" in error body, got: ${r.text}`);
			})
			.expect(400);
	});

	// ── [String] @indexed — element-level REST search ──────────────────────────

	test('[String] @indexed: search by element shared by two records returns both', async () => {
		const r = await client.reqRest('/TaggedItem/?tags=beta').expect(200);
		assert.ok(Array.isArray(r.body), r.text);
		assert.equal(r.body.length, 2, `expected 2 records with tag "beta", got ${r.body.length}: ${r.text}`);
		const ids = r.body.map((item) => item.id).sort();
		assert.deepEqual(ids, ['1', '2'], r.text);
	});

	test('[String] @indexed: search by unique element returns single record', async () => {
		const r = await client.reqRest('/TaggedItem/?tags=alpha').expect(200);
		assert.ok(Array.isArray(r.body), r.text);
		assert.equal(r.body.length, 1, `expected 1 record with tag "alpha", got ${r.body.length}: ${r.text}`);
		assert.equal(r.body[0].id, '1', r.text);
	});

	test('[String] @indexed: search by element shared by second pair returns both', async () => {
		const r = await client.reqRest('/TaggedItem/?tags=gamma').expect(200);
		assert.ok(Array.isArray(r.body), r.text);
		assert.equal(r.body.length, 2, `expected 2 records with tag "gamma", got ${r.body.length}: ${r.text}`);
		const ids = r.body.map((item) => item.id).sort();
		assert.deepEqual(ids, ['2', '3'], r.text);
	});

	test('[String] @indexed: search by absent element returns empty array', async () => {
		const r = await client.reqRest('/TaggedItem/?tags=nope').expect(200);
		assert.ok(Array.isArray(r.body), r.text);
		assert.equal(r.body.length, 0, `expected 0 records for absent tag, got ${r.body.length}: ${r.text}`);
	});
});
