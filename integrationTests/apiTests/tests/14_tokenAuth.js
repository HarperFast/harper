import { describe, it } from 'node:test';
import assert from 'node:assert';
import request from 'supertest';
import { envUrl, generic, headers } from '../config/envConfig.js';

describe('14. Token Auth', () => {
	//Token Auth Folder

	it('Call create_authentication_tokens no username/pw', async () => {
		const response = await request(envUrl)
			.post('')
			.set(headers)
			.send({ operation: 'create_authentication_tokens' })
			.expect((r) => assert.ok(r.body['error'] === 'username is required'))
			.expect(400);
	});

	it('Call create_authentication_tokens no pw', async () => {
		const response = await request(envUrl)
			.post('')
			.set(headers)
			.send({ operation: 'create_authentication_tokens', username: `${generic.username}` })
			.expect((r) => assert.ok(r.body['error'] === 'password is required'))
			.expect(400);
	});

	it('Call create_authentication_tokens bad credentials', async () => {
		const response = await request(envUrl)
			.post('')
			.set(headers)
			.send({ operation: 'create_authentication_tokens', username: 'baduser', password: 'bad' })
			.expect((r) => assert.ok(r.body['error'] === 'invalid credentials'))
			.expect(401);
	});

	it('Call create_authentication_tokens happy path', async () => {
		const response = await request(envUrl)
			.post('')
			.set(headers)
			.send({
				operation: 'create_authentication_tokens',
				username: `${generic.username}`,
				password: `${generic.password}`,
			})
			.expect((r) => {
				let attributes = ['operation_token', 'refresh_token'];
				attributes.forEach((attribute) => {
					assert.ok(r.body[attribute] != undefined);
				});
				generic.operation_token = r.body.operation_token;
				generic.refresh_token = r.body.refresh_token;
			})
			.expect(200);
	});

	it('test search_by_hash with valid jwt', async () => {
		const response = await request(envUrl)
			.post('')
			.set(headers)
			.send({
				operation: 'search_by_hash',
				schema: `${generic.schema}`,
				table: `${generic.emps_tb}`,
				hash_attribute: `${generic.emps_id}`,
				hash_values: [1],
				get_attributes: ['*'],
			})
			.expect((r) => assert.ok(r.body.length == 1, 'Expected response message length to eql 1'))
			.expect((r) => assert.ok(r.body[0].employeeid == 1))
			.expect(200);
	});

	it('test search_by_hash with invalid jwt', async () => {
		const response = await request(envUrl)
			.post('')
			.set(headers)
			.send({
				operation: 'search_by_hash',
				schema: `${generic.schema}`,
				table: `${generic.emps_tb}`,
				hash_attribute: `${generic.emps_id}`,
				hash_values: [1],
				get_attributes: ['*'],
			})
			.expect((r) => assert.ok(r.body.error == 'invalid token'))
			.expect(401);
	});

	it('test refresh_operation_token with correct token', async () => {
		const response = await request(envUrl)
			.post('')
			.set(headers)
			.send({ operation: 'refresh_operation_token' })
			.expect((r) => {
				let attributes = ['operation_token'];
				attributes.forEach((attribute) => {
					assert.ok(r.body[attribute] != undefined);
				});
				generic.operation_token = r.body.operation_token;
			})
			.expect(200);
	});

	it('test refresh_operation_token with incorrect token', async () => {
		const response = await request(envUrl)
			.post('')
			.set(headers)
			.send({ operation: 'refresh_operation_token' })
			.expect((r) => assert.ok(r.body.error == 'invalid token'))
			.expect(401);
	});
});
