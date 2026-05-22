/**
 * GraphQL integration tests.
 *
 * Ported from legacy `apiTests/tests/19_graphQlTests.mjs`. Validates:
 * - Shorthand / named / multi-resource queries
 * - `operationName` selection
 * - Query arguments: primary key, nullable variables, non-null variables with defaults
 * - Nested attribute queries and nested variable passing (sub-level and top-level)
 * - Fragment spreading: top-level, nested, multi-resource, inline, and per-field
 *
 * Self-contained: installs the `appGraphQL` component (Related + SubObject tables
 * with a @relationship) in `before`, seeds the canonical 5 Related rows and
 * 6 SubObject rows (id 0–5), then exercises the `/graphql` endpoint.
 *
 * Skipped on Windows: depends on `restart_service http_workers` after component
 * install, which crashes Harper on the Windows single-worker model
 * (HarperFast/harper#549).
 */
import { suite, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startHarper, teardownHarper } from '@harperfast/integration-testing';
import { createApiClient } from './utils/client.mjs';
import { installAppComponent } from './utils/components.mjs';

const SCHEMA_GRAPHQL =
	'type VariedProps @table @export { \n\t id: ID @primaryKey \n\t name: String @indexed \n } \n\n' +
	'type SimpleRecord @table @export { \n\t id: ID @primaryKey \n\t name: String @indexed \n } \n\n' +
	'type FourProp @table(audit: "1d", replicated: false) @export { \n\t id: ID @primaryKey \n\t name: String @indexed \n\t age: Int @indexed \n\t title: String \n\t birthday: Date @indexed \n\t ageInMonths: Int @computed @indexed \n\t nameTitle: Int @computed(from: "name + \' \' + title") \n } \n\n' +
	'type Related @table @export(rest: true, mqtt: false) { \n\t id: ID @primaryKey \n\t name: String @indexed \n\t otherTable: [SubObject] @relationship(to: relatedId) \n\t subObject: SubObject @relationship(from: "subObjectId") \n\t subObjectId: ID @indexed \n } \n\n' +
	'type ManyToMany @table @export(mqtt: true, rest: false) { \n\t id: ID @primaryKey \n\t name: String @indexed \n\t subObjectIds: [ID] @indexed \n\t subObjects: [SubObject] @relationship(from: "subObjectIds") \n } \n\n' +
	'type HasTimeStampsNoPK @table @export { \n\t created: Float @createdTime \n\t updated: Float @updatedTime \n } \n\n' +
	'type SomeObject { \n\t name: String \n } \n\n' +
	'type SubObject @table(audit: false) @export { \n\t id: ID @primaryKey \n\t subObject: SomeObject \n\t subArray: [SomeObject] \n\t any: Any \n\t relatedId: ID @indexed \n\t related: Related @relationship(from: "relatedId") \n\t manyToMany: [ManyToMany] @relationship(to: subObjectIds) \n } \n\n' +
	'type NestedIdObject @table @export {  \n\t id: [ID]! @primaryKey \n\t name: String \n } \n\n' +
	'type SimpleCache @table { \n\t id: ID @primaryKey \n } \n\n' +
	'type HasBigInt @table @export { \n\t id: BigInt @primaryKey \n\t name: String @indexed \n\t anotherBigint: BigInt \n } \n\n';

const CONFIG_YAML =
	"rest: true\ngraphqlSchema:\n  files: '*.graphql'\njsResource:\n  files: resources.js\nstatic:\n  root: web\n  files: web/**\nroles:\n  files: roles.yaml\ngraphql: true";

const RELATED_ROWS = [
	{ id: '1', name: 'name-1', nestedIdObjectId: ['a', '1'], subObjectId: '1' },
	{ id: '2', name: 'name-2', nestedIdObjectId: ['a', '2'], subObjectId: '2' },
	{ id: '3', name: 'name-3', nestedIdObjectId: ['a', '3'], subObjectId: '3' },
	{ id: '4', name: 'name-4', nestedIdObjectId: ['a', '4'], subObjectId: '4' },
	{ id: '5', name: 'name-5', nestedIdObjectId: ['a', '5'], subObjectId: '5' },
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

suite('GraphQL queries', { skip: skipSuite }, (ctx) => {
	let client;

	before(async () => {
		await startHarper(ctx, { config: {}, env: {} });
		client = createApiClient(ctx.harper);

		await installAppComponent(client, {
			project: 'appGraphQL',
			files: { 'schema.graphql': SCHEMA_GRAPHQL, 'config.yaml': CONFIG_YAML },
			probePath: '/Related/',
		});

		await client
			.req()
			.send({ operation: 'insert', table: 'SubObject', records: [{ id: '0', relatedId: '1', any: null }] })
			.expect((r) => assert.ok(r.body.message.includes('inserted 1 of 1 records'), r.text))
			.expect(200);

		await client
			.req()
			.send({ operation: 'insert', table: 'Related', records: RELATED_ROWS })
			.expect((r) => assert.ok(r.body.message.includes('inserted 5 of 5 records'), r.text))
			.expect(200);

		await client
			.req()
			.send({ operation: 'insert', table: 'SubObject', records: SUBOBJECT_ROWS.slice(1) })
			.expect((r) => assert.ok(r.body.message.includes('inserted 5 of 5 records'), r.text))
			.expect(200);
	});

	after(async () => {
		await teardownHarper(ctx);
	});

	test('shorthand query returns all Related rows in order', async () => {
		const r = await client.reqGraphQl().send({ query: '{ Related { id name } }' }).expect(200);
		assert.equal(r.body.data.Related.length, 5, r.text);
		r.body.data.Related.forEach((row, i) => {
			assert.equal(row.id, (i + 1).toString(), r.text);
		});
	});

	test('named query returns all Related rows in order', async () => {
		const r = await client.reqGraphQl().send({ query: 'query GetRelated { Related { id name } }' }).expect(200);
		assert.equal(r.body.data.Related.length, 5, r.text);
		r.body.data.Related.forEach((row, i) => {
			assert.equal(row.id, (i + 1).toString(), r.text);
		});
	});

	test('named query with operationName selects GetRelated', async () => {
		const r = await client
			.reqGraphQl()
			.send({ query: 'query GetRelated { Related { id, name } }', operationName: 'GetRelated' })
			.expect(200);
		assert.equal(r.body.data.Related.length, 5, r.text);
		r.body.data.Related.forEach((row, i) => {
			assert.equal(row.id, (i + 1).toString(), r.text);
		});
	});

	test('operationName selects GetSubObject from multi-operation document', async () => {
		const r = await client
			.reqGraphQl()
			.send({
				query: 'query GetRelated { Related { id, name } } query GetSubObject { SubObject { id relatedId } }',
				operationName: 'GetSubObject',
			})
			.expect(200);
		assert.equal(r.body.data.SubObject.length, 6, r.text);
		r.body.data.SubObject.forEach((row, i) => {
			assert.equal(row.id, i.toString(), r.text);
		});
	});

	test('query by primary key field', async () => {
		const r = await client.reqGraphQl().send({ query: '{ Related(id: "1") { id name } }' }).expect(200);
		assert.equal(r.body.data.Related[0].id, '1', r.text);
	});

	test('multi-resource query returns both tables', async () => {
		const r = await client
			.reqGraphQl()
			.send({ query: '{ Related { id name } SubObject { id relatedId } }' })
			.expect(200);
		assert.equal(r.body.data.Related.length, 5, r.text);
		r.body.data.Related.forEach((row, i) => {
			assert.equal(row.id, (i + 1).toString(), r.text);
		});
		assert.equal(r.body.data.SubObject.length, 6, r.text);
		r.body.data.SubObject.forEach((row, i) => {
			assert.equal(row.id, i.toString(), r.text);
		});
	});

	test('query by variable non-null no default', async () => {
		const r = await client
			.reqGraphQl()
			.send({ query: 'query Get($id: ID!) { Related(id: $id) { id name } }', variables: { id: '1' } })
			.expect(200);
		assert.equal(r.body.data.Related[0].id, '1', r.text);
	});

	test('query by variable non-null with default, with var provided', async () => {
		const r = await client
			.reqGraphQl()
			.send({ query: 'query Get($id: ID! = "1") { Related(id: $id) { id name } }', variables: { id: '1' } })
			.expect(200);
		assert.equal(r.body.data.Related[0].id, '1', r.text);
	});

	test('query by nullable var no default, no var → matches null record', async () => {
		const r = await client
			.reqGraphQl()
			.send({ query: 'query Get($any: Any) { SubObject(any: $any) { id any } }' })
			.expect(200);
		assert.equal(r.body.data.SubObject[0].id, '0', r.text);
	});

	test('query by nullable var with default, var overrides', async () => {
		const r = await client
			.reqGraphQl()
			.send({
				query: 'query Get($any: Any = "any-1") { SubObject(any: $any) { id any } }',
				variables: { any: 'any-2' },
			})
			.expect(200);
		assert.equal(r.body.data.SubObject[0].id, '2', r.text);
	});

	test('query by var with default, null var uses null → matches null record', async () => {
		const r = await client
			.reqGraphQl()
			.send({
				query: 'query Get($any: Any = "any-1") { SubObject(any: $any) { id any } }',
				variables: { any: null },
			})
			.expect(200);
		assert.equal(r.body.data.SubObject[0].id, '0', r.text);
	});

	test('query by nested attribute', async () => {
		const r = await client
			.reqGraphQl()
			.send({ query: '{ SubObject(related: { name: "name-2" }) { id any } }' })
			.expect(200);
		assert.equal(r.body.data.SubObject[0].id, '2', r.text);
	});

	test('query by multiple nested attributes', async () => {
		const r = await client
			.reqGraphQl()
			.send({ query: '{ SubObject(any: "any-1", related: { name: "name-1" }) { id any } }' })
			.expect(200);
		assert.equal(r.body.data.SubObject[0].id, '1', r.text);
	});

	test('query by nested attribute primary key', async () => {
		const r = await client.reqGraphQl().send({ query: '{ SubObject(related: { id: "2" }) { id any } }' }).expect(200);
		assert.equal(r.body.data.SubObject[0].id, '2', r.text);
	});

	test('query by doubly nested attribute', async () => {
		const r = await client
			.reqGraphQl()
			.send({ query: '{ SubObject(related: { subObject: { any: "any-3" } }) { id any } }' })
			.expect(200);
		assert.equal(r.body.data.SubObject[0].id, '3', r.text);
	});

	test('query by doubly nested attribute as var (sub-level)', async () => {
		const r = await client
			.reqGraphQl()
			.send({
				query: 'query Get($subObject: Any) { SubObject(related: { subObject: $subObject }) { id any } }',
				variables: { subObject: { any: 'any-3' } },
			})
			.expect(200);
		assert.equal(r.body.data.SubObject[0].id, '3', r.text);
	});

	test('query by doubly nested attribute as var (top-level)', async () => {
		const r = await client
			.reqGraphQl()
			.send({
				query: 'query Get($related: Any) { SubObject(related: $related) { id any } }',
				variables: { related: { subObject: { any: 'any-3' } } },
			})
			.expect(200);
		assert.equal(r.body.data.SubObject[0].id, '3', r.text);
	});

	test('query by nested attribute as var (sub-level)', async () => {
		const r = await client
			.reqGraphQl()
			.send({
				query: 'query Get($name: String) { SubObject(related: { name: $name }) { id any } }',
				variables: { name: 'name-2' },
			})
			.expect(200);
		assert.equal(r.body.data.SubObject[0].id, '2', r.text);
	});

	test('query by nested attribute as var (top-level)', async () => {
		const r = await client
			.reqGraphQl()
			.send({
				query: 'query Get($related: Any) { SubObject(related: $related) { id any } }',
				variables: { related: { name: 'name-2' } },
			})
			.expect(200);
		assert.equal(r.body.data.SubObject[0].id, '2', r.text);
	});

	test('query with top-level fragment', async () => {
		const r = await client
			.reqGraphQl()
			.send({ query: 'query Get { ...related } fragment related on Any { Related { id name } }' })
			.expect(200);
		assert.equal(r.body.data.Related.length, 5, r.text);
		r.body.data.Related.forEach((row, i) => {
			assert.equal(row.id, (i + 1).toString(), r.text);
		});
	});

	test('query with top-level nested fragment', async () => {
		const r = await client
			.reqGraphQl()
			.send({
				query:
					'query Get { ...related } fragment related on Any { ...nested } fragment nested on Any { Related { id name } }',
			})
			.expect(200);
		assert.equal(r.body.data.Related.length, 5, r.text);
		r.body.data.Related.forEach((row, i) => {
			assert.equal(row.id, (i + 1).toString(), r.text);
		});
	});

	test('query with top-level fragment for multi-resource', async () => {
		const r = await client
			.reqGraphQl()
			.send({
				query:
					'query Get { ...multiResourceFragment } fragment multiResourceFragment on Any { Related { id name } SubObject { id relatedId } }',
			})
			.expect(200);
		assert.equal(r.body.data.Related.length, 5, r.text);
		r.body.data.Related.forEach((row, i) => {
			assert.equal(row.id, (i + 1).toString(), r.text);
		});
		assert.equal(r.body.data.SubObject.length, 6, r.text);
		r.body.data.SubObject.forEach((row, i) => {
			assert.equal(row.id, i.toString(), r.text);
		});
	});

	test('query with inline fragment', async () => {
		const r = await client
			.reqGraphQl()
			.send({ query: 'query Get { Related(id: "1") { ...on Related { id name } } }' })
			.expect(200);
		assert.equal(r.body.data.Related[0].id, '1', r.text);
	});

	test('query with nested field fragments', async () => {
		const r = await client
			.reqGraphQl()
			.send({
				query:
					'query Get { Related(id: "2") { ...relatedFields otherTable { ...id } } } fragment relatedFields on Related { ...id name } fragment id on Any { id }',
			})
			.expect(200);
		assert.equal(r.body.data.Related[0].id, '2', r.text);
	});
});
