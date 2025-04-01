import { describe, it } from 'node:test';
import assert from 'node:assert';
import request from 'supertest';
import { envUrl, envUrlRest, generic, headers } from '../config/envConfig.js';
import { setTimeout } from 'node:timers/promises';

describe('19. GraphQL tests', () => {
	//GraphQL tests Folder

	it('Add component for graphql and rest tests', async () => {
		const response = await request(envUrl)
			.post('')
			.set(headers)
			.send({ operation: 'add_component', project: 'appGraphQL' })
			.expect((r) => {
				const res = JSON.stringify(r.body);
				assert.ok(res.includes('Successfully added project') || res.includes('Project already exists'));
			});
	});

  it('Add default component for openapi endpoint', async () => {
    const response = await request(envUrl)
      .post('')
      .set(headers)
      .send({ 'operation': 'add_component', 'project': 'myApp111' })
      .expect((r) => assert.ok(JSON.stringify(r.body).includes('Successfully added project') ||
        JSON.stringify(r.body).includes('Project already exists')))
      .expect(200);
  });

	it('Set Component File schema.graphql', async () => {
		const response = await request(envUrl)
			.post('')
			.set(headers)
			.send({
				operation: 'set_component_file',
				project: 'appGraphQL',
				file: 'schema.graphql',
				payload:
					'type VariedProps @table @export { \n\t id: ID @primaryKey \n\t name: String @indexed \n } \n\n type SimpleRecord @table @export { \n\t id: ID @primaryKey \n\t name: String @indexed \n } \n\n type FourProp @table(audit: "1d", replicated: false) @export { \n\t id: ID @primaryKey \n\t name: String @indexed \n\t age: Int @indexed \n\t title: String \n\t birthday: Date @indexed \n\t ageInMonths: Int @computed @indexed \n\t nameTitle: Int @computed(from: "name + \' \' + title") \n } \n\n type Related @table @export(rest: true, mqtt: false) { \n\t id: ID @primaryKey \n\t name: String @indexed \n\t otherTable: [SubObject] @relationship(to: relatedId) \n\t subObject: SubObject @relationship(from: "subObjectId") \n\t subObjectId: ID @indexed \n } \n\n type ManyToMany @table @export(mqtt: true, rest: false) { \n\t id: ID @primaryKey \n\t name: String @indexed \n\t subObjectIds: [ID] @indexed \n\t subObjects: [SubObject] @relationship(from: "subObjectIds") \n } \n\n type HasTimeStampsNoPK @table @export { \n\t created: Float @createdTime \n\t updated: Float @updatedTime \n } \n\n type SomeObject { \n\t name: String \n } \n\n type SubObject @table(audit: false) @export { \n\t id: ID @primaryKey \n\t subObject: SomeObject \n\t subArray: [SomeObject] \n\t any: Any \n\t relatedId: ID @indexed \n\t related: Related @relationship(from: "relatedId") \n\t manyToMany: [ManyToMany] @relationship(to: subObjectIds) \n } \n\n type NestedIdObject @table @export {  \n\t id: [ID]! @primaryKey \n\t name: String \n } \n\n type SimpleCache @table { \n\t id: ID @primaryKey \n } \n\n type HasBigInt @table @export { \n\t id: BigInt @primaryKey \n\t name: String @indexed \n\t anotherBigint: BigInt \n } \n\n type Conflicted1 @table @export(name: "Conflicted") { \n\t id: ID @primaryKey \n } \n\n type Conflicted2 @table @export(name: "Conflicted") { \n\t id: ID @primaryKey \n } \n\n',
			})
			.expect((r) => assert.ok(r.body.message.includes('Successfully set component: schema.graphql')))
			.expect(200);
	});

	it('Set Component File config.yaml', async () => {
		const response = await request(envUrl)
			.post('')
			.set(headers)
			.send({
				operation: 'set_component_file',
				project: 'appGraphQL',
				file: 'config.yaml',
				payload:
					"rest: true\ngraphqlSchema:\n  files: '*.graphql'\njsResource:\n  files: resources.js\nstatic:\n  root: web\n  files: web/**\nroles:\n  files: roles.yaml\ngraphql: true",
			})
			.expect((r) => assert.ok(r.body.message.includes('Successfully set component: config.yaml')))
			.expect(200);
	});

	it('Restart service and wait', async () => {
		const response = await request(envUrl)
			.post('')
			.set(headers)
			.send({ operation: 'restart' })
			.expect((r) => assert.ok(r.body.message.includes('Restarting')))
			.expect(200);
		await setTimeout(generic.restartTimeout);
	});

	it('Insert one null into SubObject', async () => {
		const response = await request(envUrl)
			.post('')
			.set(headers)
			.send({ operation: 'insert', table: 'SubObject', records: [{ id: '0', relatedId: '1', any: null }] })
			.expect((r) => assert.ok(r.body.message.includes('inserted 1 of 1 records')))
			.expect(200);
	});

	it('Insert into table Related', async () => {
		const response = await request(envUrl)
			.post('')
			.set(headers)
			.send({
				operation: 'insert',
				table: 'Related',
				records: [
					{ id: '1', name: 'name-1', nestedIdObjectId: ['a', '1'], subObjectId: '1' },
					{
						id: '2',
						name: 'name-2',
						nestedIdObjectId: ['a', '2'],
						subObjectId: '2',
					},
					{ id: '3', name: 'name-3', nestedIdObjectId: ['a', '3'], subObjectId: '3' },
					{
						id: '4',
						name: 'name-4',
						nestedIdObjectId: ['a', '4'],
						subObjectId: '4',
					},
					{ id: '5', name: 'name-5', nestedIdObjectId: ['a', '5'], subObjectId: '5' },
				],
			})
			.expect((r) => assert.ok(r.body.message.includes('inserted 5 of 5 records')))
			.expect(200);
	});

	it('Insert into table SubObject', async () => {
		const response = await request(envUrl)
			.post('')
			.set(headers)
			.send({
				operation: 'insert',
				table: 'SubObject',
				records: [
					{ id: '1', relatedId: '1', any: 'any-1' },
					{
						id: '2',
						relatedId: '2',
						any: 'any-2',
					},
					{ id: '3', relatedId: '3', any: 'any-3' },
					{ id: '4', relatedId: '4', any: 'any-4' },
					{
						id: '5',
						relatedId: '5',
						any: 'any-5',
					},
				],
			})
			.expect((r) => assert.ok(r.body.message.includes('inserted 5 of 5 records')))
			.expect(200);
	});

	it('Shorthand query', async () => {
		const response = await request(envUrlRest)
			.post('/graphql')
			.set(headers)
			.send({ query: '{ Related { id name } }' })
			.expect((r) => {
				assert.ok(r.body.data.Related.length == 5);
				r.body.data.Related.forEach((row, i) => {
					assert.ok(row.id == (i + 1).toString());
				});
			})
			.expect(200);
	});

	it('Named query', async () => {
		const response = await request(envUrlRest)
			.post('/graphql')
			.set(headers)
			.send({ query: 'query GetRelated { Related { id name } }' })
			.expect((r) => {
				assert.ok(r.body.data.Related.length == 5);
				r.body.data.Related.forEach((row, i) => {
					assert.ok(row.id == (i + 1).toString());
				});
			})
			.expect(200);
	});

	it('Named query with operationName', async () => {
		const response = await request(envUrlRest)
			.post('/graphql')
			.set(headers)
			.send({ query: 'query GetRelated { Related { id, name } }', operationName: 'GetRelated' })
			.expect((r) => {
				assert.ok(r.body.data.Related.length == 5);
				r.body.data.Related.forEach((row, i) => {
					assert.ok(row.id == (i + 1).toString());
				});
			})
			.expect(200);
	});

	it('Named query with operationName 2', async () => {
		const response = await request(envUrlRest)
			.post('/graphql')
			.set(headers)
			.send({
				query: 'query GetRelated { Related { id, name } } query GetSubObject { SubObject { id relatedId } }',
				operationName: 'GetSubObject',
			})
			.expect((r) => {
				assert.ok(r.body.data.SubObject.length == 6);
				r.body.data.SubObject.forEach((row, i) => {
					assert.ok(row.id == i.toString());
				});
			})
			.expect(200);
	});

	it('Query by primary key field', async () => {
		const response = await request(envUrlRest)
			.post('/graphql')
			.set(headers)
			.send({ query: '{ Related(id: "1") { id name } }' })
			.expect((r) => assert.ok(r.body.data.Related[0].id == '1'))
			.expect(200);
	});

	it('Multi resource query', async () => {
		const response = await request(envUrlRest)
			.post('/graphql')
			.set(headers)
			.send({ query: '{ Related { id name } SubObject { id relatedId } }' })
			.expect((r) => {
				assert.ok(r.body.data.Related.length == 5);
				r.body.data.Related.forEach((row, i) => {
					assert.ok(row.id == (i + 1).toString());
				});
				assert.ok(r.body.data.SubObject.length == 6);
				r.body.data.SubObject.forEach((row, i) => {
					assert.ok(row.id == i.toString());
				});
			})
			.expect(200);
	});

	it('Query by variable non null no default', async () => {
		const response = await request(envUrlRest)
			.post('/graphql')
			.set(headers)
			.send({ query: 'query Get($id: ID!) { Related(id: $id) { id name } }', variables: { id: '1' } })
			.expect((r) => assert.ok(r.body.data.Related[0].id == '1'))
			.expect(200);
	});

	it('Query by variable non null with default with var', async () => {
		const response = await request(envUrlRest)
			.post('/graphql')
			.set(headers)
			.send({ query: 'query Get($id: ID! = "1") { Related(id: $id) { id name } }', variables: { id: '1' } })
			.expect((r) => assert.ok(r.body.data.Related[0].id == '1'))
			.expect(200);
	});

	it('Query by var nullable no default no var', async () => {
		const response = await request(envUrlRest)
			.post('/graphql')
			.set(headers)
			.send({ query: 'query Get($any: Any) { SubObject(any: $any) { id any } }' })
			.expect((r) => assert.ok(r.body.data.SubObject[0].id == '0'))
			.expect(200);
	});

	it('Query by var nullable w default with var', async () => {
		const response = await request(envUrlRest)
			.post('/graphql')
			.set(headers)
			.send({
				query: 'query Get($any: Any = "any-1") { SubObject(any: $any) { id any } }',
				variables: { any: 'any-2' },
			})
			.expect((r) => assert.ok(r.body.data.SubObject[0].id == '2'))
			.expect(200);
	});

	it('Query by var w default with null var', async () => {
		const response = await request(envUrlRest)
			.post('/graphql')
			.set(headers)
			.send({
				query: 'query Get($any: Any = "any-1") { SubObject(any: $any) { id any } }',
				variables: { any: null },
			})
			.expect((r) => assert.ok(r.body.data.SubObject[0].id == '0'))
			.expect(200);
	});

	it('Query by nested attribute', async () => {
		const response = await request(envUrlRest)
			.post('/graphql')
			.set(headers)
			.send({ query: '{ SubObject(related: { name: "name-2" }) { id any } }' })
			.expect((r) => assert.ok(r.body.data.SubObject[0].id == '2'))
			.expect(200);
	});

	it('Query by multiple nested attributes', async () => {
		const response = await request(envUrlRest)
			.post('/graphql')
			.set(headers)
			.send({ query: '{ SubObject(any: "any-1", related: { name: "name-1" }) { id any } }' })
			.expect((r) => assert.ok(r.body.data.SubObject[0].id == '1'))
			.expect(200);
	});

	it('Query by nested attribute primary key', async () => {
		const response = await request(envUrlRest)
			.post('/graphql')
			.set(headers)
			.send({ query: '{ SubObject(related: { id: "2" }) { id any } }' })
			.expect((r) => assert.ok(r.body.data.SubObject[0].id == '2'))
			.expect(200);
	});

	it('Query by doubly nested attribute', async () => {
		const response = await request(envUrlRest)
			.post('/graphql')
			.set(headers)
			.send({ query: '{ SubObject(related: { subObject: { any: "any-3" } }) { id any } }' })
			.expect((r) => assert.ok(r.body.data.SubObject[0].id == '3'))
			.expect(200);
	});

	it('Query by doubly nested attribute as var sub level', async () => {
		const response = await request(envUrlRest)
			.post('/graphql')
			.set(headers)
			.send({
				query: 'query Get($subObject: Any) { SubObject(related: { subObject: $subObject }) { id any } }',
				variables: { subObject: { any: 'any-3' } },
			})
			.expect((r) => assert.ok(r.body.data.SubObject[0].id == '3'))
			.expect(200);
	});

	it('Query by doubly nested attribute as var top-level', async () => {
		const response = await request(envUrlRest)
			.post('/graphql')
			.set(headers)
			.send({
				query: 'query Get($related: Any) { SubObject(related: $related) { id any } }',
				variables: { related: { subObject: { any: 'any-3' } } },
			})
			.expect((r) => assert.ok(r.body.data.SubObject[0].id == '3'))
			.expect(200);
	});

	it('Query by nested attribute as var sub level', async () => {
		const response = await request(envUrlRest)
			.post('/graphql')
			.set(headers)
			.send({
				query: 'query Get($name: String) { SubObject(related: { name: $name }) { id any } }',
				variables: { name: 'name-2' },
			})
			.expect((r) => assert.ok(r.body.data.SubObject[0].id == '2'))
			.expect(200);
	});

	it('Query by nested attribute as var top level', async () => {
		const response = await request(envUrlRest)
			.post('/graphql')
			.set(headers)
			.send({
				query: 'query Get($related: Any) { SubObject(related: $related) { id any } }',
				variables: { related: { name: 'name-2' } },
			})
			.expect((r) => assert.ok(r.body.data.SubObject[0].id == '2'))
			.expect(200);
	});

	it('Query with top level fragment', async () => {
		const response = await request(envUrlRest)
			.post('/graphql')
			.set(headers)
			.send({ query: 'query Get { ...related } fragment related on Any { Related { id name } }' })
			.expect((r) => {
				assert.ok(r.body.data.Related.length == 5);
				r.body.data.Related.forEach((row, i) => {
					assert.ok(row.id == (i + 1).toString());
				});
			})
			.expect(200);
	});

	it('Query with top level nested fragment', async () => {
		const response = await request(envUrlRest)
			.post('/graphql')
			.set(headers)
			.send({
				query:
					'query Get { ...related } fragment related on Any { ...nested } fragment nested on Any { Related { id name } }',
			})
			.expect((r) => {
				assert.ok(r.body.data.Related.length == 5);
				r.body.data.Related.forEach((row, i) => {
					assert.ok(row.id == (i + 1).toString());
				});
			})
			.expect(200);
	});

	it('Query w top level fragment multi resource', async () => {
		const response = await request(envUrlRest)
			.post('/graphql')
			.set(headers)
			.send({
				query:
					'query Get { ...multiResourceFragment } fragment multiResourceFragment on Any { Related { id name } SubObject { id relatedId } }',
			})
			.expect((r) => {
				assert.ok(r.body.data.Related.length == 5);
				r.body.data.Related.forEach((row, i) => {
					assert.ok(row.id == (i + 1).toString());
				});
				assert.ok(r.body.data.SubObject.length == 6);
				r.body.data.SubObject.forEach((row, i) => {
					assert.ok(row.id == i.toString());
				});
			})
			.expect(200);
	});

	it('Query with inline fragment', async () => {
		const response = await request(envUrlRest)
			.post('/graphql')
			.set(headers)
			.send({ query: 'query Get { Related(id: "1") { ...on Related { id name } } }' })
			.expect((r) => assert.ok(r.body.data.Related[0].id == '1'))
			.expect(200);
	});

	it('Query with nested fragments', async () => {
		const response = await request(envUrlRest)
			.post('/graphql')
			.set(headers)
			.send({
				query:
					'query Get { Related(id: "2") { ...relatedFields otherTable { ...id } } } fragment relatedFields on Related { ...id name } fragment id on Any { id }',
			})
			.expect((r) => assert.ok(r.body.data.Related[0].id == '2'))
			.expect(200);
	});
});
