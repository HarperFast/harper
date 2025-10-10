import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { envUrl, testData } from '../config/envConfig.mjs';
import { isDevEnv } from '../utils/env.mjs';
import { req } from '../utils/request.mjs';
import { timestamp } from '../utils/timestamp.mjs';

describe('14. Token Auth', () => {
	beforeEach(timestamp);

	//Token Auth Folder

	it('Call create_authentication_tokens no username/pw', async () => {
		const r = await request(envUrl)
			.post('')
			.set({ 'Content-Type': 'application/json' })
			.send({ operation: 'create_authentication_tokens' });

		if (await isDevEnv()) {
			assert.equal(r.status, 200, r.text);
		} else {
			assert.equal(r.body['error'], 'Must login', r.text);
			assert.equal(r.status, 401, r.text);
		}
	});

	it('Call create_authentication_tokens no pw', () => {
		return request(envUrl)
			.post('')
			.set({ 'Content-Type': 'application/json' })
			.send({ operation: 'create_authentication_tokens', username: `${testData.username}` })
			.expect((r) => assert.equal(r.body['error'], 'invalid credentials', r.text))
			.expect(401);
	});

	it('Call create_authentication_tokens bad credentials', () => {
		return request(envUrl)
			.post('')
			.set({ 'Content-Type': 'application/json' })
			.send({
				operation: 'create_authentication_tokens',
				username: 'baduser',
				password: 'bad',
				bypass_auth: true,
			})
			.expect((r) => assert.equal(r.body['error'], 'invalid credentials', r.text))
			.expect(401);
	});

	it('Call create_authentication_tokens happy path', () => {
		return request(envUrl)
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
					assert.notEqual(r.body[attribute], undefined, r.text);
				});
				testData.operation_token = r.body.operation_token;
				testData.refresh_token = r.body.refresh_token;
			})
			.expect(200);
	});

	it('test search_by_hash with valid jwt', () => {
		return request(envUrl)
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
			.expect((r) => assert.equal(r.body.length, 1, r.text))
			.expect((r) => assert.equal(r.body[0].employeeid, 1, r.text))
			.expect(200);
	});

	it('test search_by_hash with invalid jwt', () => {
		return request(envUrl)
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

	it('test refresh_operation_token with correct token', () => {
		return request(envUrl)
			.post('')
			.set('Content-Type', 'application/json')
			.set('Authorization', `Bearer ${testData.refresh_token}`)
			.send({ operation: 'refresh_operation_token' })
			.expect((r) => {
				let attributes = ['operation_token'];
				attributes.forEach((attribute) => {
					assert.notEqual(r.body[attribute], undefined, r.text);
				});
				testData.operation_token = r.body.operation_token;
			})
			.expect(200);
	});

	it('test refresh_operation_token with incorrect token', () => {
		return request(envUrl)
			.post('')
			.set('Content-Type', 'application/json')
			.set('Authorization', 'Bearer bad token')
			.send({ operation: 'refresh_operation_token' })
			.expect((r) => assert.ok(r.text.includes('invalid token')))
			.expect(401);
	});

	it('Create token with current user', () => {
		return req()
			.send({ operation: 'create_authentication_tokens' })
			.expect((r) => {
				assert.notEqual(r.body.operation_token, undefined, r.text);
				assert.notEqual(r.body.refresh_token, undefined, r.text);
				testData.operation_token = r.body.operation_token;
				testData.refresh_token = r.body.refresh_token;
			})
			.expect(200);
	});
});
