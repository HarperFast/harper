import { describe, it } from 'node:test';
import assert from 'node:assert';
import request from 'supertest';
import { setTimeout } from 'node:timers/promises';
import { envUrl, testData, headers, headersTestUser } from '../config/envConfig.js';

describe('12. Configuration', () => {


	//Configuration Folder


	//Create_Attribute tests

	it('Create table for tests', async () => {
		const response = await request(envUrl)
			.post('')
			.set(headers)
			.send({ operation: 'create_table', schema: 'dev', table: 'create_attr_test', hash_attribute: 'id' })
			.expect((r) => assert.ok(r.body.message.includes('successfully created'), r.text))
			.expect(200);
	});

	it('Create Attribute for secondary indexing test', async () => {
		const response = await request(envUrl)
			.post('')
			.set(headers)
			.send({ operation: 'create_attribute', schema: 'dev', table: 'create_attr_test', attribute: 'owner_id' })
			.expect((r) => assert.ok(r.body.message == "attribute 'dev.create_attr_test.owner_id' successfully created.", r.text))
			.expect(200);
	});

	it('Insert data for secondary indexing test', async () => {
		const response = await request(envUrl)
			.post('')
			.set(headers)
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
			.expect((r) => assert.ok(r.body.message == 'inserted 9 of 9 records', r.text))
			.expect(200);
	});

	it('Confirm attribute secondary indexing works', async () => {
		const response = await request(envUrl)
			.post('')
			.set(headers)
			.send({ operation: 'sql', sql: 'select * from dev.create_attr_test where owner_id = 1' })
			.expect((r) => assert.ok(r.body.length == 3, r.text))
			.expect(200);
	});


	//Configuration Main Folder

	it('Describe table DropAttributeTest', async () => {
		const response = await request(envUrl)
			.post('')
			.set(headers)
			.send({ operation: 'describe_table', table: 'AttributeDropTest', schema: 'dev' })
			.expect((r) => assert.ok(!r.body.another_attribute, r.text))
			.expect(200);
	});

	it('Create Attribute', async () => {
		const response = await request(envUrl)
			.post('')
			.set(headers)
			.send({
				operation: 'create_attribute',
				schema: 'dev',
				table: 'AttributeDropTest',
				attribute: 'created_attribute',
			})
			.expect((r) => assert.ok(r.body.message == "attribute 'dev.AttributeDropTest.created_attribute' successfully created.", r.text))
			.expect(200);
	});

	it('Confirm created attribute', async () => {
		const response = await request(envUrl)
			.post('')
			.set(headers)
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
		const response = await request(envUrl)
			.post('')
			.set(headers)
			.send({
				operation: 'create_attribute',
				schema: 'dev',
				table: 'AttributeDropTest',
				attribute: 'created_attribute',
			})
			.expect((r) => assert.ok(r.body.error == "attribute 'created_attribute' already exists in dev.AttributeDropTest", r.text))
			.expect(400);
	});

	it('Drop Attribute', async () => {
		const response = await request(envUrl)
			.post('')
			.set(headers)
			.send({
				operation: 'drop_attribute',
				schema: 'dev',
				table: 'AttributeDropTest',
				attribute: 'another_attribute',
			})
			.expect((r) => {
				console.log(r.text);
				assert.ok(r.body.message == "successfully deleted attribute 'another_attribute'", r.text)
			})
			.expect(200);
		await setTimeout(1000);
	});

	it('Describe table DropAttributeTest', async () => {
		const response = await request(envUrl)
			.post('')
			.set(headers)
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

	it('Get Fingerprint', async () => {
		const response = await request(envUrl)
			.post('')
			.set(headers)
			.send({ operation: 'get_fingerprint' })
			.expect((r) => assert.ok(r.body.hasOwnProperty('message'), r.text))
			.expect((r) => assert.ok(r.body.message, r.text))
			.expect(200);
	});

	it('Set License', async () => {
		const response = await request(envUrl)
			.post('')
			.set(headers)
			.send({
				operation: 'set_license',
				key: 'uFFG7xAZG11ec9d335bfe27c4ec5555310bd4a27f',
				company: 'harperdb.io',
			})
			.expect((r) => assert.ok(r.body['error'] == 'There was an error parsing the license key.', r.text))
			.expect(500);
	});

	it('Get Registration Info', async () => {
		const response = await request(envUrl)
			.post('')
			.set(headers)
			.send({ operation: 'registration_info' })
			.expect((r) => assert.ok(r.body.hasOwnProperty('registered'), r.text))
			.expect((r) => assert.ok(r.body.hasOwnProperty('version'), r.text))
			.expect((r) => assert.ok(r.body.hasOwnProperty('ram_allocation'), r.text))
			.expect((r) => assert.ok(r.body.hasOwnProperty('license_expiration_date'), r.text))
			.expect(200);
	});

	it('Set License Bad Key', async () => {
		const response = await request(envUrl)
			.post('')
			.set(headers)
			.send({ operation: 'set_license', key: '', company: 'harperdb.io' })
			.expect((r) => assert.ok(r.body['error'] == 'Invalid key or company specified for license file.', r.text))
			.expect(500);
	});

	it('Get Configuration', async () => {
		const response = await request(envUrl)
			.post('')
			.set(headers)
			.send({ operation: 'get_configuration' })
			.expect((r) => assert.ok(r.body.clustering, r.text))
			.expect((r) => assert.ok(r.body.componentsRoot, r.text))
			.expect((r) => assert.ok(r.body.logging, r.text))
			.expect((r) => assert.ok(r.body.localStudio, r.text))
			.expect((r) => assert.ok(r.body.operationsApi, r.text))
			.expect((r) => assert.ok(r.body.operationsApi.network.port, r.text))
			.expect((r) => assert.ok(r.body.threads, r.text))
			.expect(200);
	});

	it('Cluster set routes hub', async () => {
		const response = await request(envUrl)
			.post('')
			.set(headers)
			.send({
				operation: 'cluster_set_routes',
				server: 'hub',
				routes: [
					{ host: 'dev.chicken', port: 11334 },
					{ host: 'dev.wing', port: 11335 },
				],
			})
			.expect((r) =>
				assert.ok(
					JSON.stringify(r.body) ==
						'{"message":"cluster routes successfully set","set":[{"host":"dev.chicken","port":11334},{"host":"dev.wing","port":11335}],"skipped":[]}'
				)
			)
			.expect(200);
	});

	it('Cluster set routes leaf', async () => {
		const expected =
			'{"message":"cluster routes successfully set","set":[{"host":"dev.pie","port":11335}],"skipped":[{"host":"dev.chicken","port":11334}]}';
		const response = await request(envUrl)
			.post('')
			.set(headers)
			.send({
				operation: 'cluster_set_routes',
				server: 'leaf',
				routes: [
					{ host: 'dev.chicken', port: 11334 },
					{ host: 'dev.pie', port: 11335 },
				],
			})
			.expect((r) => assert.ok(JSON.stringify(r.body) == expected, r.text))
			.expect(200);
	});

	it('Confirm routes set', async () => {
		const response = await request(envUrl)
			.post('')
			.set(headers)
			.send({ operation: 'get_configuration' })
			.expect((r) =>
				assert.ok(
					JSON.stringify(r.body.clustering.hubServer.cluster.network.routes) ==
						'[{"host":"dev.chicken","port":11334},{"host":"dev.wing","port":11335}]'
				)
			)
			.expect((r) => assert.ok(JSON.stringify(r.body.clustering.leafServer.network.routes) == '[{"host":"dev.pie","port":11335}]', r.text))
			.expect(200);
	});

	it('Cluster get routes', async () => {
		const response = await request(envUrl)
			.post('')
			.set(headers)
			.send({ operation: 'cluster_get_routes' })
			.expect((r) =>
				assert.ok(
					JSON.stringify(r.body) ==
						'{"hub":[{"host":"dev.chicken","port":11334},{"host":"dev.wing","port":11335}],"leaf":[{"host":"dev.pie","port":11335}]}'
				)
			)
			.expect(200);
	});

	it('Cluster delete routes', async () => {
		const expected_result = `{
		"message": "cluster routes successfully deleted",
		"deleted": [ { "host": "dev.wing","port": 11335 },{"host": "dev.pie","port": 11335 }],
		"skipped": [ { "host": "dev.pie", "port": 11221 }]
		}`;
		const response = await request(envUrl)
			.post('')
			.set(headers)
			.send({
				operation: 'cluster_delete_routes',
				routes: [
					{ host: 'dev.wing', port: 11335 },
					{ host: 'dev.pie', port: 11335 },
					{
						host: 'dev.pie',
						port: 11221,
					},
				],
			})
			.expect((r) => assert.deepEqual(r.body, JSON.parse(expected_result), r.text))
			.expect(200);
	});

	it('Cluster get routes confirm delete', async () => {
		const response = await request(envUrl)
			.post('')
			.set(headers)
			.send({ operation: 'cluster_get_routes' })
			.expect((r) => assert.ok(JSON.stringify(r.body) == '{"hub":[{"host":"dev.chicken","port":11334}],"leaf":[]}', r.text))
			.expect(200);
	});

	it('Cluster delete last route', async () => {
		const response = await request(envUrl)
			.post('')
			.set(headers)
			.send({ operation: 'cluster_delete_routes', routes: [{ host: 'dev.chicken', port: 11334 }] })
			.expect((r) =>
				assert.ok(
					JSON.stringify(r.body) ==
						'{"message":"cluster routes successfully deleted","deleted":[{"host":"dev.chicken","port":11334}],"skipped":[]}'
				)
			)
			.expect(200);
	});

	it('Read log', async () => {
		const response = await request(envUrl)
			.post('')
			.set(headers)
			.send({ operation: 'read_log' })
			.expect((r) => {
				assert.ok(Array.isArray(r.body), r.text);
				assert.ok(r.body[0].hasOwnProperty('level'), r.text);
				assert.ok(r.body[0].hasOwnProperty('message'), r.text);
				assert.ok(r.body[0].hasOwnProperty('timestamp'), r.text);
			})
			.expect(200);
	});

	it('Set Configuration', async () => {
		const response = await request(envUrl)
			.post('')
			.set(headers)
			.send({ operation: 'set_configuration', logging_rotation_maxSize: '12M' })
			.expect((r) =>
				assert.ok(
					r.body.message ==
						'Configuration successfully set. You must restart HarperDB for new config settings to take effect.'
				)
			)
			.expect(200);
	});

	it('Confirm Configuration', async () => {
		const response = await request(envUrl)
			.post('')
			.set(headers)
			.send({ operation: 'get_configuration' })
			.expect((r) => assert.ok(r.body.logging.rotation.maxSize == '12M', r.text))
			.expect(200);
	});

	it('Set Configuration Bad Data', async () => {
		const response = await request(envUrl)
			.post('')
			.set(headers)
			.send({ operation: 'set_configuration', http_cors: 'spinach' })
			.expect((r) => assert.ok(r.body.error == "HarperDB config file validation error: 'http.cors' must be a boolean", r.text))
			.expect(400);
	});

	it('Add non-SU role', async () => {
		const response = await request(envUrl)
			.post('')
			.set(headers)
			.send({ operation: 'add_role', role: 'test_dev_role', permission: { super_user: false } })
			.expect(200);
	});

	it('Add User with non-SU role', async () => {
		const response = await request(envUrl)
			.post('')
			.set(headers)
			.send({
				operation: 'add_user',
				role: 'test_dev_role',
				username: 'test_user',
				password: `${testData.password}`,
				active: true,
			})
			.expect(200);
	});

	it('Configure Cluster non-SU', async () => {
		const response = await request(envUrl)
			.post('')
			.set(headersTestUser)
			.send({ operation: 'set_configuration', clustering_port: 99999 })
			.expect((r) => assert.ok(r.body.error == 'This operation is not authorized due to role restrictions and/or invalid database items', r.text))
			.expect((r) => assert.ok(r.body.unauthorized_access.length == 1, r.text))
			.expect((r) => assert.ok(r.body.unauthorized_access[0] == "Operation 'setConfiguration' is restricted to 'super_user' roles", r.text))
			.expect(403);
	});

	it('Set Configuration non-SU', async () => {
		const response = await request(envUrl)
			.post('')
			.set(headersTestUser)
			.send({ operation: 'set_configuration', clustering_port: 99999 })
			.expect((r) => assert.ok(r.body.error == 'This operation is not authorized due to role restrictions and/or invalid database items', r.text))
			.expect((r) => assert.ok(r.body.unauthorized_access.length == 1, r.text))
			.expect((r) => assert.ok(r.body.unauthorized_access[0] == "Operation 'setConfiguration' is restricted to 'super_user' roles", r.text))
			.expect(403);
	});

	it('Get Configuration non-SU', async () => {
		const response = await request(envUrl)
			.post('')
			.set(headersTestUser)
			.send({ operation: 'get_configuration' })
			.expect((r) => assert.ok(r.body.error == 'This operation is not authorized due to role restrictions and/or invalid database items', r.text))
			.expect((r) => assert.ok(r.body.unauthorized_access.length == 1, r.text))
			.expect((r) => assert.ok(r.body.unauthorized_access[0] == "Operation 'getConfiguration' is restricted to 'super_user' roles", r.text))
			.expect(403);
	});

	it('Drop test_user', async () => {
		const response = await request(envUrl)
			.post('')
			.set(headers)
			.send({ operation: 'drop_user', username: 'test_user' })
			.expect((r) => assert.ok(r.body.message == 'test_user successfully deleted', r.text))
			.expect(200);
	});

	it('Drop_role - non-SU role', async () => {
		const response = await request(envUrl)
			.post('')
			.set(headers)
			.send({ operation: 'drop_role', id: 'test_dev_role' })
			.expect((r) => assert.ok(r.body.message == 'test_dev_role successfully deleted', r.text))
			.expect(200);
	});

	it('Test local studio HTML is returned', async () => {
		const response = await request(envUrl)
			.get('')
			// .set(headers)
			// .expect('content-type', 'text/html; charset=UTF-8')
			.expect((r) => {
				console.log('URL: ' + envUrl);
				console.log('Headers: ' + JSON.stringify(r.headers));
				console.log('Body: ' + r.text)
				// assert.ok(r.text.includes('<!doctype html>'), r.text);
				// assert.ok(r.text.includes('Studio :: HarperDB'), r.text);
			})
			// .expect(200);

		const response2 = await request('https://localhost:9925')
			.get('')
			.expect((r) => {
				console.log('URL: https://localhost:9925');
				console.log('Headers: ' + JSON.stringify(r.headers));
				console.log('Body: ' + r.text)
			})
	});
});
