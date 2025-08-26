import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { testData } from '../config/envConfig.js';
import { restartServiceHttpWorkersWithTimeout } from '../utils/restart.js';
import { req } from '../utils/request.js';

describe('17a. Add components for computed props, graphQL, and open api', () => {

	it('Add component for computed properties',  () => {
		return req()
			.send({ operation: 'add_component', project: 'computed' })
			.expect((r) => assert.ok(r.body.message.includes('Successfully added project: computed'), r.text))
			.expect(200);
	});

	it('Set Component File schema.graphql',  () => {
		return req()
			.send({
				operation: 'set_component_file',
				project: 'computed',
				file: 'schema.graphql',
				payload:
					'type Product @table @export { \n\t id: ID @primaryKey \n\t price: Float \n\t taxRate: Float \n\t totalPrice: Float @computed(from: "price + (price * taxRate)") @indexed \n\t notIndexedTotalPrice: Float @computed(from: "price + (price * taxRate)") \n\t jsTotalPrice: Float @computed @indexed \n } \n\n',
			})
			.expect((r) => assert.ok(r.body.message.includes('Successfully set component: schema.graphql'), r.text))
			.expect(200);
	});

	it('Set Component File resources.js',  () => {
		return req()
			.send({
				operation: 'set_component_file',
				project: 'computed',
				file: 'resources.js',
				payload:
					"tables.Product.setComputedAttribute('jsTotalPrice', (record) => { \n\t return record.price + (record.price * record.taxRate) \n }) \n\n",
			})
			.expect((r) => assert.ok(r.body.message.includes('Successfully set component: resources.js'), r.text))
			.expect(200);
	});



	it('Add component for graphql and rest tests',  () => {
		return req()
			.send({ operation: 'add_component', project: 'appGraphQL' })
			.expect((r) => {
				const res = JSON.stringify(r.body);
				assert.ok(res.includes('Successfully added project') || res.includes('Project already exists'), r.text);
			});
	});

	it('Set Component File schema.graphql',  () => {
		return req()
			.send({
				operation: 'set_component_file',
				project: 'appGraphQL',
				file: 'schema.graphql',
				payload:
					'type VariedProps @table @export { \n\t id: ID @primaryKey \n\t name: String @indexed \n } \n\n type SimpleRecord @table @export { \n\t id: ID @primaryKey \n\t name: String @indexed \n } \n\n type FourProp @table(audit: "1d", replicated: false) @export { \n\t id: ID @primaryKey \n\t name: String @indexed \n\t age: Int @indexed \n\t title: String \n\t birthday: Date @indexed \n\t ageInMonths: Int @computed @indexed \n\t nameTitle: Int @computed(from: "name + \' \' + title") \n } \n\n type Related @table @export(rest: true, mqtt: false) { \n\t id: ID @primaryKey \n\t name: String @indexed \n\t otherTable: [SubObject] @relationship(to: relatedId) \n\t subObject: SubObject @relationship(from: "subObjectId") \n\t subObjectId: ID @indexed \n } \n\n type ManyToMany @table @export(mqtt: true, rest: false) { \n\t id: ID @primaryKey \n\t name: String @indexed \n\t subObjectIds: [ID] @indexed \n\t subObjects: [SubObject] @relationship(from: "subObjectIds") \n } \n\n type HasTimeStampsNoPK @table @export { \n\t created: Float @createdTime \n\t updated: Float @updatedTime \n } \n\n type SomeObject { \n\t name: String \n } \n\n type SubObject @table(audit: false) @export { \n\t id: ID @primaryKey \n\t subObject: SomeObject \n\t subArray: [SomeObject] \n\t any: Any \n\t relatedId: ID @indexed \n\t related: Related @relationship(from: "relatedId") \n\t manyToMany: [ManyToMany] @relationship(to: subObjectIds) \n } \n\n type NestedIdObject @table @export {  \n\t id: [ID]! @primaryKey \n\t name: String \n } \n\n type SimpleCache @table { \n\t id: ID @primaryKey \n } \n\n type HasBigInt @table @export { \n\t id: BigInt @primaryKey \n\t name: String @indexed \n\t anotherBigint: BigInt \n } \n\n',
			})
			.expect((r) => assert.ok(r.body.message.includes('Successfully set component: schema.graphql'), r.text))
			.expect(200);
	});

	it('Set Component File config.yaml',  () => {
		return req()
			.send({
				operation: 'set_component_file',
				project: 'appGraphQL',
				file: 'config.yaml',
				payload:
					"rest: true\ngraphqlSchema:\n  files: '*.graphql'\njsResource:\n  files: resources.js\nstatic:\n  root: web\n  files: web/**\nroles:\n  files: roles.yaml\ngraphql: true",
			})
			.expect((r) => assert.ok(r.body.message.includes('Successfully set component: config.yaml'), r.text))
			.expect(200);
	});


	it('Add default component for openapi endpoint',  () => {
		return req()
			.send({ 'operation': 'add_component', 'project': 'myApp111' })
			.expect((r) => assert.ok(JSON.stringify(r.body).includes('Successfully added project') ||
				JSON.stringify(r.body).includes('Project already exists')))
	});



	it('Restart Service: http workers and wait',  () => {
		return restartServiceHttpWorkersWithTimeout(testData.restartTimeout);
	});

	it('Describe all',  () => {
		return req().send({ operation: 'describe_all' }).expect(200);
	});
});
