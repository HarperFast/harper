import { describe, it } from 'node:test';
import assert from 'node:assert';
import request from 'supertest';
import { envUrl, testData, headers } from '../config/envConfig.js';
import { isDevEnv } from '../utils/env.js';

describe('14. Token Auth', () => {
	//Token Auth Folder

	it('Call create_authentication_tokens no username/pw', async () => {
		const response = await request(envUrl)
			.post('')
			.set({ 'Content-Type': 'application/json' })
			.send({ operation: 'create_authentication_tokens' })
			.expect(async (r) => {
				if (await isDevEnv()) {
					assert.ok(r.status == 200, r.text);
				} else {
					assert.ok(r.body['error'] === 'Must login', r.text);
					assert.ok(r.status == 401, r.text);
				}
			})
	});

	it('Call create_authentication_tokens no pw', async () => {
		const response = await request(envUrl)
			.post('')
			.set({ 'Content-Type': 'application/json' })
			.send({ operation: 'create_authentication_tokens', username: `${testData.username}` })
			.expect((r) => assert.ok(r.body['error'] === 'invalid credentials', r.text))
			.expect(401);
	});

	it('Call create_authentication_tokens bad credentials', async () => {
		const response = await request(envUrl)
			.post('')
			.set({ 'Content-Type': 'application/json' })
			.send({
				operation: 'create_authentication_tokens',
				username: 'baduser',
				password: 'bad',
				bypass_auth: true
			})
			.expect((r) => assert.ok(r.body['error'] === 'invalid credentials', r.text))
			.expect(401);
	});

	it('Call create_authentication_tokens happy path', async () => {
		const response = await request(envUrl)
			.post('')
			.set({ 'Content-Type': 'application/json' })
			.send({
				operation: 'create_authentication_tokens',
				username: `${testData.username}`,
				password: `${testData.password}`,
			})
			.expect((r) => {
				let attributes = ['operation_token', 'refresh_token'];
				attributes.forEach((attribute) => {
					assert.ok(r.body[attribute] !== undefined, r.text);
				});
				testData.operation_token = r.body.operation_token;
				testData.refresh_token = r.body.refresh_token;
			})
			.expect(200);
	});

	it('test search_by_hash with valid jwt', async () => {
		const response = await request(envUrl)
			.post('')
			.set('Content-Type', 'application/json')
			.set('Authorization', `Bearer ${testData.operation_token}`)
			.send({
				operation: 'search_by_hash',
				schema: `${testData.schema}`,
				table: `${testData.emps_tb}`,
				hash_attribute: `${testData.emps_id}`,
				hash_values: [1],
				get_attributes: ['*'],
			})
			.expect((r) => assert.ok(r.body.length == 1, r.text))
			.expect((r) => assert.ok(r.body[0].employeeid == 1, r.text))
			.expect(200);
	});

	it('test search_by_hash with invalid jwt', async () => {
		const response = await request(envUrl)
			.post('')
			.set('Content-Type', 'application/json')
			.set('Authorization', 'Bearer BAD_TOKEN')
			.send({
				operation: 'search_by_hash',
				schema: `${testData.schema}`,
				table: `${testData.emps_tb}`,
				hash_attribute: `${testData.emps_id}`,
				hash_values: [1],
				get_attributes: ['*'],
			})
			.expect((r) => assert.ok(r.text.includes('"error":"invalid token"')))
			.expect(401);
	});

	it('test refresh_operation_token with correct token', async () => {
		const response = await request(envUrl)
			.post('')
			.set('Content-Type', 'application/json')
			.set('Authorization', `Bearer ${testData.refresh_token}`)
			.send({ operation: 'refresh_operation_token' })
			.expect((r) => {
				let attributes = ['operation_token'];
				attributes.forEach((attribute) => {
					assert.ok(r.body[attribute] !== undefined, r.text);
				});
				testData.operation_token = r.body.operation_token;
			})
			.expect(200);
	});

	it('test refresh_operation_token with incorrect token', async () => {
		const response = await request(envUrl)
			.post('')
			.set('Content-Type', 'application/json')
			.set('Authorization', 'Bearer bad token')
			.send({ operation: 'refresh_operation_token' })
			.expect((r) => assert.ok(r.text.includes('invalid token')))
			.expect(401);
	});

	it('Create token with current user', async () => {
		const response = await request(envUrl)
			.post('')
			.set(headers)
			.send({ operation: 'create_authentication_tokens' })
			.expect((r) => {
				assert.ok(r.body.operation_token !== undefined, r.text);
				assert.ok(r.body.refresh_token !== undefined, r.text);
				testData.operation_token = r.body.operation_token;
				testData.refresh_token = r.body.refresh_token;
			})
			.expect(200);
	});

});
