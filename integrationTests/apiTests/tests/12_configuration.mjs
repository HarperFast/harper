import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { envUrl, testData, headers, headersTestUser } from '../config/envConfig.mjs';
import { req, reqAsNonSU } from '../utils/request.mjs';

describe('12. Configuration', () => {
	//Configuration Folder

	//Create_Attribute tests

	it('Create table for tests', () => {
		return req()
			.send({ operation: 'create_table', schema: 'dev', table: 'create_attr_test', hash_attribute: 'id' })
			.expect((r) => assert.ok(r.body.message.includes('successfully created'), r.text))
			.expect(200);
	});

	it('Create Attribute for secondary indexing test', () => {
		return req()
			.send({ operation: 'create_attribute', schema: 'dev', table: 'create_attr_test', attribute: 'owner_id' })
			.expect((r) =>
				assert.equal(r.body.message, "attribute 'dev.create_attr_test.owner_id' successfully created.", r.text)
			)
			.expect(200);
	});

	it('Insert data for secondary indexing test', () => {
		return req()
			.send({
				operation: 'insert',
				schema: 'dev',
				table: 'create_attr_test',
				records: [
					{ id: 1, dog_name: 'Penny', age: 5, owner_id: 1 },
					{
						id: 2,
						dog_name: 'Harper',
						age: 5,
						owner_id: 3,
					},
					{ id: 3, dog_name: 'Alby', age: 5, owner_id: 1 },
					{
						id: 4,
						dog_name: 'Billy',
						age: 4,
						owner_id: 1,
					},
					{ id: 5, dog_name: 'Rose Merry', age: 6, owner_id: 2 },
					{
						id: 6,
						dog_name: 'Kato',
						age: 4,
						owner_id: 2,
					},
					{ id: 7, dog_name: 'Simon', age: 1, owner_id: 2 },
					{
						id: 8,
						dog_name: 'Gemma',
						age: 3,
						owner_id: 2,
					},
					{ id: 9, dog_name: 'Bode', age: 8 },
				],
			})
			.expect((r) => assert.equal(r.body.message, 'inserted 9 of 9 records', r.text))
			.expect(200);
	});

	it('Confirm attribute secondary indexing works', () => {
		return req()
			.send({ operation: 'sql', sql: 'select * from dev.create_attr_test where owner_id = 1' })
			.expect((r) => assert.equal(r.body.length, 3, r.text))
			.expect(200);
	});

	//Configuration Main Folder

	it('Describe table DropAttributeTest - attr not exist', () => {
		return req()
			.send({ operation: 'describe_table', table: 'AttributeDropTest', schema: 'dev' })
			.expect((r) => assert.ok(!r.body.another_attribute, r.text))
			.expect(200);
	});

	it('Create Attribute', () => {
		return req()
			.send({
				operation: 'create_attribute',
				schema: 'dev',
				table: 'AttributeDropTest',
				attribute: 'created_attribute',
			})
			.expect((r) =>
				assert.equal(
					r.body.message,
					"attribute 'dev.AttributeDropTest.created_attribute' successfully created.",
					r.text
				)
			)
			.expect(200);
	});

	it('Confirm created attribute', () => {
		return req()
			.send({ operation: 'describe_table', table: 'AttributeDropTest', schema: 'dev' })
			.expect((r) => {
				let found = false;
				r.body.attributes.forEach((attr) => {
					if (attr.attribute === 'created_attribute') {
						found = true;
					}
				});
				assert.ok(found, r.text);
			})
			.expect(200);
	});

	it('Create existing attribute', async () => {
		await req()
			.send({
				operation: 'create_attribute',
				schema: 'dev',
				table: 'AttributeDropTest',
				attribute: 'created_attribute',
			})
			.expect((r) =>
				assert.equal(r.body.error, "attribute 'created_attribute' already exists in dev.AttributeDropTest", r.text)
			)
			.expect(400);
	});

	it('Drop Attribute', () => {
		return req()
			.send({
				operation: 'drop_attribute',
				schema: 'dev',
				table: 'AttributeDropTest',
				attribute: 'another_attribute',
			})
			.expect((r) => {
				assert.equal(r.body.message, "successfully deleted attribute 'another_attribute'", r.text);
			})
			.expect(200);
	});

	it('Describe table Drop Attribute Test', async () => {
		await req()
			.send({ operation: 'describe_table', table: 'AttributeDropTest', schema: 'dev' })
			.expect((r) => {
				let found = false;
				r.body.attributes.forEach((attr) => {
					if (attr.attribute === 'another_attribute') {
						found = true;
					}
				});
				assert.ok(!found, r.text);
			})
			.expect(200);
	});

	it('Get Configuration', () => {
		return req()
			.send({ operation: 'get_configuration' })
			.expect((r) => {
				assert.ok(r.body.componentsRoot, r.text);
				assert.ok(r.body.logging, r.text);
				assert.ok(r.body.localStudio, r.text);
				assert.ok(r.body.operationsApi, r.text);
				assert.ok(r.body.operationsApi.network.port, r.text);
				assert.ok(r.body.threads, r.text);
			})
			.expect(200);
	});

	it('Read log', () => {
		return req()
			.send({ operation: 'read_log' })
			.expect((r) => {
				assert.ok(Array.isArray(r.body), r.text);
				assert.ok(r.body[0].hasOwnProperty('level'), r.text);
				assert.ok(r.body[0].hasOwnProperty('message'), r.text);
				assert.ok(r.body[0].hasOwnProperty('timestamp'), r.text);
			})
			.expect(200);
	});

	it('Set Configuration', () => {
		return req()
			.send({ operation: 'set_configuration', logging_rotation_maxSize: '12M' })
			.expect((r) =>
				assert.equal(
					r.body.message,
					'Configuration successfully set. You must restart HarperDB for new config settings to take effect.'
				)
			)
			.expect(200);
	});

	it('Confirm Configuration', () => {
		return req()
			.send({ operation: 'get_configuration' })
			.expect((r) => assert.equal(r.body.logging.rotation.maxSize, '12M', r.text))
			.expect(200);
	});

	it('Set Configuration Bad Data', () => {
		return req()
			.send({ operation: 'set_configuration', http_cors: 'spinach' })
			.expect((r) =>
				assert.equal(r.body.error, "HarperDB config file validation error: 'http.cors' must be a boolean", r.text)
			)
			.expect(400);
	});

	it('Add non-SU role', () => {
		return req()
			.send({ operation: 'add_role', role: 'test_dev_role', permission: { super_user: false } })
			.expect(200);
	});

	it('Add User with non-SU role', () => {
		return req()
			.send({
				operation: 'add_user',
				role: 'test_dev_role',
				username: 'test_user',
				password: `${testData.password}`,
				active: true,
			})
			.expect(200);
	});

	it('Get Configuration non-SU', () => {
		return reqAsNonSU(headersTestUser)
			.send({ operation: 'get_configuration' })
			.expect((r) => {
				assert.equal(
					r.body.error,
					'This operation is not authorized due to role restrictions and/or invalid database items',
					r.text
				);
				assert.equal(r.body.unauthorized_access.length, 1, r.text);
				assert.equal(
					r.body.unauthorized_access[0],
					"Operation 'getConfiguration' is restricted to 'super_user' roles",
					r.text
				);
			})
			.expect(403);
	});

	it('Drop test_user', () => {
		return req()
			.send({ operation: 'drop_user', username: 'test_user' })
			.expect((r) => assert.equal(r.body.message, 'test_user successfully deleted', r.text))
			.expect(200);
	});

	it('Drop_role - non-SU role', () => {
		return req()
			.send({ operation: 'drop_role', id: 'test_dev_role' })
			.expect((r) => assert.equal(r.body.message, 'test_dev_role successfully deleted', r.text))
			.expect(200);
	});

	it('Test local studio HTML is returned', () => {
		return request(envUrl)
			.get('')
			.set(headers)
			.set('content-type', 'text/html; charset=UTF-8')
			.set('Accept', '*/*')
			.set('Connection', 'keep-alive')
			.set('Accept-Encoding', 'gzip, deflate, br')
			.expect('content-type', 'text/html; charset=UTF-8')
			.expect((r) => {
				assert.ok(r.text.includes('<!doctype html>'), r.text);
				assert.ok(r.text.includes('Harper Studio'), r.text);
			})
			.expect(200);
	});
});
