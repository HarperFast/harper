/**
 * REST API integration tests against the `appGraphQL` component schema.
 *
 * Ported from legacy `apiTests/tests/20_restTests.mjs`. Exercises the REST
 * query syntax (`?key==value&select(...)`, nested attribute paths, etc.)
 * against the `Related` + `SubObject` types from the appGraphQL test schema.
 *
 * Self-contained: each suite installs its own `appGraphQL` component
 * (subset of the legacy 17a_addComponents schema — only the types this
 * suite reads) and seeds the canonical Related/SubObject rows the legacy
 * 19_graphQlTests inserted, then exercises the REST endpoints.
 *
 * Skipped on Windows: depends on `restart_service http_workers` after
 * component install, which crashes the Harper instance on Windows
 * (HarperFast/harper#549). Matches the per-suite skip pattern in
 * `headers.test.mjs`.
 */
import { suite, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { startHarper, teardownHarper } from '@harperfast/integration-testing';
import { createApiClient } from './utils/client.mjs';
import { installAppComponent } from './utils/components.mjs';

const SCHEMA_GRAPHQL = `
type Related @table @export(rest: true, mqtt: false) {
	id: ID @primaryKey
	name: String @indexed
	otherTable: [SubObject] @relationship(to: relatedId)
	subObject: SubObject @relationship(from: "subObjectId")
	subObjectId: ID @indexed
}

type SomeObject {
	name: String
}

type SubObject @table(audit: false) @export {
	id: ID @primaryKey
	subObject: SomeObject
	subArray: [SomeObject]
	any: Any
	relatedId: ID @indexed
	related: Related @relationship(from: "relatedId")
}
`;

const CONFIG_YAML = `rest: true
graphqlSchema:
  files: '*.graphql'
graphql: true
`;

const RELATED_ROWS = [
	{ id: '1', name: 'name-1', subObjectId: '1' },
	{ id: '2', name: 'name-2', subObjectId: '2' },
	{ id: '3', name: 'name-3', subObjectId: '3' },
	{ id: '4', name: 'name-4', subObjectId: '4' },
	{ id: '5', name: 'name-5', subObjectId: '5' },
];

const SUBOBJECT_ROWS = [
	{ id: '0', relatedId: '1', any: null },
	{ id: '1', relatedId: '1', any: 'any-1' },
	{ id: '2', relatedId: '2', any: 'any-2' },
	{ id: '3', relatedId: '3', any: 'any-3' },
	{ id: '4', relatedId: '4', any: 'any-4' },
	{ id: '5', relatedId: '5', any: 'any-5' },
];

const skipSuite = process.platform === 'win32';

suite('REST query syntax', { skip: skipSuite }, (ctx) => {
	let client;

	before(async () => {
		await startHarper(ctx, { config: {}, env: {} });
		client = createApiClient(ctx.harper);

		await installAppComponent(client, {
			project: 'appGraphQL',
			files: { 'schema.graphql': SCHEMA_GRAPHQL, 'config.yaml': CONFIG_YAML },
			probePath: '/Related/',
			restartTimeoutMs: 120000,
		});

		await client
			.req()
			.send({ operation: 'insert', table: 'Related', records: RELATED_ROWS })
			.expect((r) => assert.ok(r.body.message.includes('inserted 5 of 5 records'), r.text))
			.expect(200);

		await client
			.req()
			.send({ operation: 'insert', table: 'SubObject', records: SUBOBJECT_ROWS })
			.expect((r) => assert.ok(r.body.message.includes('inserted 6 of 6 records'), r.text))
			.expect(200);
	});

	after(async () => {
		await teardownHarper(ctx);
	});

	test('[rest] Named query Get Related', () => {
		return client
			.reqRest('/Related/?select(id,name)')
			.expect((r) => assert.equal(r.body.length, 5, r.text))
			.expect((r) => {
				r.body.forEach((row, i) => {
					assert.equal(row.id, (i + 1).toString(), r.text);
				});
			})
			.expect(200);
	});

	test('[rest] Named query Get SubObject', () => {
		return client
			.reqRest('/SubObject/?select(id,relatedId)')
			.expect((r) => assert.equal(r.body.length, 6, r.text))
			.expect((r) => {
				r.body.forEach((row, i) => {
					assert.equal(row.id, i.toString(), r.text);
				});
			})
			.expect(200);
	});

	test('[rest] Query by primary key field', () => {
		return client
			.reqRest('/Related/?id==1&select(id,name)')
			.expect((r) => assert.equal(r.body[0].id, '1', r.text))
			.expect(200);
	});

	test('[rest] Query by variable non null', () => {
		return client
			.reqRest('/Related/?id==2&select(id,name)')
			.expect((r) => assert.equal(r.body[0].id, '2', r.text))
			.expect(200);
	});

	test('[rest] Query by var nullable', () => {
		return client
			.reqRest('/SubObject/?any==any-2&select(id,any)')
			.expect((r) => assert.equal(r.body[0].id, '2', r.text))
			.expect(200);
	});

	test('[rest] Query by var with null var', () => {
		return client
			.reqRest('/SubObject/?any==null&select(id,any)')
			.expect((r) => assert.equal(r.body[0].id, '0', r.text))
			.expect((r) => assert.equal(r.body[0].any, null, r.text))
			.expect(200);
	});

	test('[rest] Query by nested attribute', () => {
		return client
			.reqRest('/SubObject/?related.name==name-2&select(id,any)')
			.expect((r) => assert.equal(r.body[0].id, '2', r.text))
			.expect(200);
	});

	test('[rest] Query by multiple nested attributes', () => {
		return client
			.reqRest('/SubObject/?any==any-2&related.name==name-2&select(id,any)')
			.expect((r) => assert.equal(r.body[0].id, '2', r.text))
			.expect(200);
	});

	test('[rest] Query by nested attribute primary key', () => {
		return client
			.reqRest('/SubObject/?related.id==2&select(id,any)')
			.expect((r) => assert.equal(r.body[0].id, '2', r.text))
			.expect(200);
	});

	test('[rest] Query by doubly nested attribute', () => {
		return client
			.reqRest('/SubObject/?related.subObject.any==any-2&select(id,any)')
			.expect((r) => assert.equal(r.body[0].id, '2', r.text))
			.expect(200);
	});

	test('[rest] Query with nested fragments', () => {
		return client
			.reqRest('/Related/?id==3')
			.expect((r) => assert.equal(r.body[0].id, '3', r.text))
			.expect(200);
	});

	test('[rest] Request POST with too large of body returns 413', () => {
		const bigProperty = Array(1000000).fill('this is a test');
		return request(client.restURL).post('/Related/').set(client.headers).send({ bigProperty }).expect(413);
	});
});
