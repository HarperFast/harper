import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { envUrl, testData } from '../config/envConfig.mjs';
import { isDevEnv } from '../utils/env.mjs';
import { req } from '../utils/request.mjs';
import { timestamp } from '../utils/timestamp.mjs';


describe('21. Authentication Tests', () => {
	beforeEach(timestamp);

	//Authentication Tests Folder

	it('Describe all with valid credentials', () => {
		return req().send({ operation: 'describe_all' }).expect(200);
	});

	it('Describe all with invalid password', () => {
		return request(envUrl)
			.post('')
			.set({
				'Authorization': `Basic ${Buffer.from(`${testData.username}:thisIsNotMyPassword`).toString('base64')}`,
				'Content-Type': 'application/json',
			})
			.send({ operation: 'describe_all' })
			.expect((r) => assert.ok(r.text.includes('Login failed')))
			.expect(401);
	});

	it('Describe all with invalid username', () => {
		return request(envUrl)
			.post('')
			.set({
				'Authorization': `Basic ${Buffer.from(`thisIsNotMyUsername:${testData.password}`).toString('base64')}`,
				'Content-Type': 'application/json',
			})
			.send({ operation: 'describe_all' })
			.expect((r) => assert.ok(r.text.includes('Login failed')))
			.expect(401);
	});

	it('Describe all with empty credentials', () => {
		return request(envUrl)
			.post('')
			.set({
				'Authorization': `Basic ${Buffer.from(`'':''`).toString('base64')}`,
				'Content-Type': 'application/json',
			})
			.send({ operation: 'describe_all' })
			.expect((r) => {
				assert.ok(r.text.includes('Must login') || r.text.includes('Login failed'), r.text);
			})
			.expect(401);
	});

	it('Describe all with long credentials', () => {
		return request(envUrl)
			.post('')
			.set({
				'Authorization':
					'Basic ' +
					Buffer.from(
						'sdkafkjsdkljsakdjsdkafkjsdkljsakdjsdkafkjsdkljsakdjsdkafkjsdkljsakdjsdkafkjsdkljsakdjsdkafkjsdkljsakdjsdkafkjsdkljsakdjsdkafkjsdkljsakdjsdkafkjsdkljsakdjsdkafkjsdkljsakdjsdkafkjsdkljsakdjsdkafkjsdkljsakdjsdkafkjsdkljsakdjsdkafkjsdkljsakdjsdkafkjsdkljsakdjsdkafkjsdkljsakdjsdkafkjsdkljsakdjsdkafkjsdkljsakdjsdkafkjsdkljsakdjsdkafkjsdkljsakdjsdkafkjsdkljsakdjsdkafkjsdkljsakdjsdkafkjsdkljsakdjsdkafkjsdkljsakdjsdkafkjsdkljsakdjsdkafkjsdkljsakdjsdkafkjsdkljsakdjsdkafkjsdkljsakdjsdkafkjsdkljsakdjsdkafkjsdkljsakdjsdkafkjsdkljsakdjsdkafkjsdkljsakdjsdkafkjsdkljsakdjsdkafkjsdkljsakdjsdkafkjsdkljsakdjsdkafkjsdkljsakdjsdkafkjsdkljsakdjsdkafkjsdkljsakdjsdkafkjsdkljsakdjsdkafkjsdkljsakdjsdkafkjsdkljsakdjsdkafkjsdkljsakdjsdkafkjsdkljsakdjsdkafkjsdkljsakdjsdkafkjsdkljsakdjsdkafkjsdkljsakdjsdkafkjsdkljsakdjsdkafkjsdkljsakdjsdkafkjsdkljsakdjsdkafkjsdkljsakdjsdkafkjsdkljsakdjsdkafkjsdkljsakdjsdkafkjsdkljsakdjsdkafkjsdkljsakdjsdkafkjsdkljsakdjsdkafkjsdkljsakdjsdkafkjsdkljsakdjsdkafkjsdkljsakdjsdkafkjsdkljsakdjsdkafkjsdkljsakdjsdkafkjsdkljsakdjsdkafkjsdkljsakdjsdkafkjsdkljsakdjsdkafkjsdkljsakdjsdkafkjsdkljsakdjsdkafkjsdkljsakdjsdkafkjsdkljsakdjsdkafkjsdkljsakdjsdkafkjsdkljsakdjsdkafkjsdkljsakdjsdkafkjsdkljsakdjsdkafkjsdkljsakdjsdkafkjsdkljsakdjsdkafkjsdkljsakdjsdkafkjsdkljsakdjsdkafkjsdkljsakdjsdkafkjsdkljsakdjsdkafkjsdkljsakdjsdkafkjsdkljsakdjsdkafkjsdkljsakdjsdkafkjsdkljsakdjsdkafkjsdkljsakdjsdkafkjsdkljsakdjsdkafkjsdkljsakdjsdkafkjsdkljsakdjsdkafkjsdkljsakdjsdkafkjsdkljsakdjsdkafkjsdkljsakdjsdkafkjsdkljsakdjsdkafkjsdkljsakdjsdkafkjsdkljsakdjsdkafkjsdkljsakdjsdkafkjsdkljsakdjsdkafkjsdkljsakdjsdkafkjsdkljsakdjsdkafkjsdkljsakdjsdkafkjsdkljsakdjsdkafkjsdkljsakdjsdkafkjsdkljsakdjsdkafkjsdkljsakdjsdkafkjsdkljsakdjsdkafkjsdkljsakdjsdkafkjsdkljsakdjsdkafkjsdkljsakdjsdkafkjsdkljsakdjsdkafkjsdkljsakdjsdkafkjsdkljsakdjsdkafkjsdkljsakdjsdkafkjsdkljsakdjsdkafkjsdkljsakdjsdkafkjsdkljsakdjsdkafkjsdkljsakdjsdkafkjsdkljsakdjsdkafkjsdkljsakdjsdkafkjsdkljsakdjsdkafkjsdkljsakdjsdkafkjsdkljsakdjsdkafkjsdkljsakdjsdkafkjsdkljsakdjsdkafkjsdkljsakdjsdkafkjsdkljsakdjsdkafkjsdkljsakdjsdkafkjsdkljsakdjsdkafkjsdkljsakdjsdkafkjsdkljsakdjsdkafkjsdkljsakdjsdkafkjsdkljsakdjsdkafkjsdkljsakdjsdkafkjsdkljsakdjsdkafkjsdkljsakdjsdkafkjsdkljsakdjsdkafkjsdkljsakdjsdkafkjsdkljsakdjsdkafkjsdkljsakdjsdkafkjsdkljsakdjsdkafkjsdkljsakdjsdkafkjsdkljsakdjsdkafkjsdkljsakdjsdkafkjsdkljsakdjsdkafkjsdkljsakdjsdkafkjsdkljsakdjsdkafkjsdkljsakdjsdkafkjsdkljsakdjsdkafkjsdkljsakdjsdkafkjsdkljsakdjsdkafkjsdkljsakdjsdkafkjsdkljsakdjsdkafkjsdkljsakdjsdkafkjsdkljsakdjsdkafkjsdkljsakdjsdkafkjsdkljsakdjsdkafkjsdkljsakdjsdkafkjsdkljsakdjsdkafkjsdkljsakdjsdkafkjsdkljsakdjsdkafkjsdkljsakdjsdkafkjsdkljsakdjsdkafkjsdkljsakdjsdkafkjsdkljsakdjsdkafkjsdkljsakdjsdkafkjsdkljsakdjsdkafkjsdkljsakdjsdkafkjsdkljsakdjsdkafkjsdkljsakdjsdkafkjsdkljsakdjsdkafkjsdkljsakdjsdkafkjsdkljsakdjsdkafkjsdkljsakdjsdkafkjsdkljsakdjsdkafkjsdkljsakdjsdkafkjsdkljsakdjsdkafkjsdkljsakdjsdkafkjsdkljsakdjsdkafkjsdkljsakdjsdkafkjsdkljsakdjsdkafkjsdkljsakdjsdkafkjsdkljsakdjsdkafkjsdkljsakdjsdkafkjsdkljsakdjsdkafkjsdkljsakdjsdkafkjsdkljsakdjsdkafkjsdkljsakdjsdkafkjsdkljsakdjsdkafkjsdkljsakdjsdkafkjsdkljsakdjsdkafkjsdkljsakdjsdkafkjsdkljsakdjsdkafkjsdkljsakdjsdkafkjsdkljsakdjsdkafkjsdkljsakdjsdkafkjsdkljsakdjsdkafkjsdkljsakdjsdkafkjsdkljsakdjsdkafkjsdkljsakdjsdkafkjsdkljsakdjsdkafkjsdkljsakdjsdkafkjsdkljsakdjsdkafkjsdkljsakdjsdkafkjsdkljsakdjsdkafkjsdkljsakdjsdkafkjsdkljsakdjsdkafkjsdkljsakdjsdkafkjsdkljsakdjsdkafkjsdkljsakdjsdkafkjsdkljsakdjsdkafkjsdkljsakdjsdkafkjsdkljsakdjsdkafkjsdkljsakdjsdkafkjsdkljsakdjsdkafkjsdkljsakdjsdkafkjsdkljsakdjsdkafkjsdkljsakdjsdkafkjsdkljsakdjsdkafkjsdkljsakdjsdkafkjsdkljsakdjsdkafkjsdkljsakdjsdkafkjsdkljsakdjsdkafkjsdkljsakdjsdkafkjsdkljsakdjsdkafkjsdkljsakdjsdkafkjsdkljsakdjsdkafkjsdkljsakdjsdkafkjsdkljsakdjsdkafkjsdkljsakdjsdkafkjsdkljsakdjsdkafkjsdkljsakdjsdkafkjsdkljsakdjsdkafkjsdkljsakdjsdkafkjsdkljsakdjsdkafkjsdkljsakdjsdkafkjsdkljsakdjsdkafkjsdkljsakdjsdkafkjsdkljsakdjsdkafkjsdkljsakdj' +
							':' +
							'sdkafkjsdkljsakdjsdkafkjsdkljsakdjsdkafkjsdkljsakdjsdkafkjsdkljsakdjsdkafkjsdkljsakdjsdkafkjsdkljsakdjsdkafkjsdkljsakdjsdkafkjsdkljsakdjsdkafkjsdkljsakdjsdkafkjsdkljsakdjsdkafkjsdkljsakdjsdkafkjsdkljsakdjsdkafksdkafkjsdkljsakdjsdkafkjsdkljsakdjsdkafkjsdkljsakdjsdkafkjsdkljsakdjsdkafkjsdkljsakdjsdkafkjsdkljsakdjsdkafkjsdkljsakdjsdkafkjsdkljsakdjsdkafkjsdkljsakdjsdkafkjsdkljsakdjsdkafkjsdkljsakdjsdkafkjsdkljsakdjsdkafkjsdkljsakdjsdkafkjsdkljsakdjsdkafkjsdkljsakdjsdkafkjsdkljsakdjsdkafkjsdkljsakdjsdkafkjsdkljsakdjsdkafkjsdkljsakdjsdkafkjsdkljsakdjsdkafkjsdkljsakdjsdkafkjsdkljsakdjsdkafkjsdkljsakdjsdkafkjsdkljsakdjsdkafkjsdkljsakdjsdkafkjsdkljsakdjsdkafkjsdkljsakdjsdkafkjsdkljsakdjsdkafkjsdkljsakdjsdkafkjsdkljsakdjsdkafkjsdkljsakdjsdkafkjsdkljsakdjsdkafkjsdkljsakdjsdkafkjsdkljsakdjsdkafkjsdkljsakdjsdkafkjsdkljsakdjsdkafkjsdkljsakdjsdkafkjsdkljsakdjsdkafkjsdkljsakdjjsdkljsakdjsdkafkjsdkljsakdjsdkafkjsdkljsakdjsdkafkjsdkljsakdjsdkafkjsdkljsakdjsdkafkjsdkljsakdjsdkafkjsdkljsakdjsdkafkjsdkljsakdjsdkafkjsdkljsakdjsdkafkjsdkljsakdjsdkafkjsdkljsakdjsdkafkjsdkljsakdjsdkafkjsdkljsakdjsdkafkjsdkljsakdjsdkafkjsdkljsakdjsdkafkjsdkljsakdjsdkafkjsdkljsakdjsdkafkjsdkljsakdjsdkafkjsdkljsakdjsdkafkjsdkljsakdjsdkafkjsdkljsakdjsdkafkjsdkljsakdjsdkafkjsdkljsakdjsdkafkjsdkljsakdjsdkafkjsdkljsakdjsdkafkjsdkljsakdjsdkafkjsdkljsakdjsdkafkjsdkljsakdjsdkafkjsdkljsakdjsdkafkjsdkljsakdjsdkafkjsdkljsakdjsdkafkjsdkljsakdjsdkafkjsdkljsakdjsdkafkjsdkljsakdjsdkafkjsdkljsakdjsdkafkjsdkljsakdjsdkafkjsdkljsakdjsdkafkjsdkljsakdjsdkafkjsdkljsakdjsdkafkjsdkljsakdjsdkafkjsdkljsakdjsdkafkjsdkljsakdjsdkafkjsdkljsakdjsdkafkjsdkljsakdjsdkafkjsdkljsakdjsdkafkjsdkljsakdjsdkafkjsdkljsakdjsdkafkjsdkljsakdjsdkafkjsdkljsakdjsdkafkjsdkljsakdjsdkafkjsdkljsakdjsdkafkjsdkljsakdjsdkafkjsdkljsakdjsdkafkjsdkljsakdjsdkafkjsdkljsakdjsdkafkjsdkljsakdjsdkafkjsdkljsakdjsdkafkjsdkljsakdjsdkafkjsdkljsakdjsdkafkjsdkljsakdjsdkafkjsdkljsakdjsdkafkjsdkljsakdjsdkafkjsdkljsakdjsdkafkjsdkljsakdjsdkafkjsdkljsakdjsdkafkjsdkljsakdjsdkafkjsdkljsakdjsdkafkjsdkljsakdjsdkafkjsdkljsakdjsdkafkjsdkljsakdjsdkafkjsdkljsakdjsdkafkjsdkljsakdjsdkafkjsdkljsakdjsdkafkjsdkljsakdjsdkafkjsdkljsakdjsdkafkjsdkljsakdjsdkafkjsdkljsakdjsdkafkjsdkljsakdjsdkafkjsdkljsakdjsdkafkjsdkljsakdjsdkafkjsdkljsakdjsdkafkjsdkljsakdjsdkafkjsdkljsakdjsdkafkjsdkljsakdjsdkafkjsdkljsakdjsdkafkjsdkljsakdjsdkafkjsdkljsakdjsdkafkjsdkljsakdjsdkafkjsdkljsakdjsdkafkjsdkljsakdjsdkafkjsdkljsakdjsdkafkjsdkljsakdjsdkafkjsdkljsakdjsdkafkjsdkljsakdjsdkafkjsdkljsakdjsdkafkjsdkljsakdjsdkafkjsdkljsakdjsdkafkjsdkljsakdjsdkafkjsdkljsakdjsdkafkjsdkljsakdjsdkafkjsdkljsakdjsdkafkjsdkljsakdjsdkafkjsdkljsakdjsdkafkjsdkljsakdjsdkafkjsdkljsakdjsdkafkjsdkljsakdjsdkafkjsdkljsakdjsdkafkjsdkljsakdjsdkafkjsdkljsakdjsdkafkjsdkljsakdjsdkafkjsdkljsakdjsdkafkjsdkljsakdjsdkafkjsdkljsakdjsdkafkjsdkljsakdjsdkafkjsdkljsakdjsdkafkjsdkljsakdjsdkafkjsdkljsakdjsdkafkjsdkljsakdjsdkafkjsdkljsakdjsdkafkjsdkljsakdjsdkafkjsdkljsakdjsdkafkjsdkljsakdjsdkafkjsdkljsakdjsdkafkjsdkljsakdjsdkafkjsdkljsakdjsdkafkjsdkljsakdjsdkafkjsdkljsakdjsdkafkjsdkljsakdjsdkafkjsdkljsakdjsdkafkjsdkljsakdjsdkafkjsdkljsakdjsdkafkjsdkljsakdjsdkafkjsdkljsakdjsdkafkjsdkljsakdjsdkafkjsdkljsakdjsdkafkjsdkljsakdjsdkafkjsdkljsakdjsdkafkjsdkljsakdjsdkafkjsdkljsakdjsdkafkjsdkljsakdjsdkafkjsdkljsakdjsdkafkjsdkljsakdjsdkafkjsdkljsakdjsdkafkjsdkljsakdjsdkafkjsdkljsakdjsdkafkjsdkljsakdjsdkafkjsdkljsakdjsdkafkjsdkljsakdjsdkafkjsdkljsakdjsdkafkjsdkljsakdjsdkafkjsdkljsakdjsdkafkjsdkljsakdjsdkafkjsdkljsakdjsdkafkjsdkljsakdjsdkafkjsdkljsakdjsdkafkjsdkljsakdjsdkafkjsdkljsakdjsdkafkjsdkljsakdjsdkafkjsdkljsakdjsdkafkjsdkljsakdjsdkafkjsdkljsakdjsdkafkjsdkljsakdjsdkafkjsdkljsakdjsdkafkjsdkljsakdjsdkafkjsdkljsakdjsdkafkjsdkljsakdjsdkafkjsdkljsakdjsdkafkjsdkljsakdjsdkafkjsdkljsakdjsdkafkjsdkljsakdjsdkafkjsdkljsakdjsdkafkjsdkljsakdjsdkafkjsdkljsakdjsdkafkjsdkljsakdjsdkafkjsdkljsakdjsdkafkjsdkljsakdjsdkafkjsdkljsakdjsdkafkjsdkljsakdjsdkafkjsdkljsakdjsdkafkjsdkljsakdjsdkafkjsdkljsakdjsdkafkjsdkljsakdjsdkafkjsdkljsakdjsdkafkjsdkljsakdjsdkafkjsdkljsakdjsdkafkjsdkljsakdjsdkafkjsdkljsakdjsdkafkjsdkljsakdjsdkafkjsdkljsakdjsdkafkjsdkljsakdjsdkafkjsdkljsakdjsdkafkjsdkljsakdjsdkafkjsdkljsakdjsdkafkjsdkljsakdjsdkafkjsdkljsakdjsdkafkjsdkljsakdjsdkafkjsdkljsakdjsdkafkjsdkljsakdjsdkafkjsdkljsakdjsdkafkjsdkljsakdjsdkafkjsdkljsakdjsdkafkjsdkljsakdjsdkafkjsdkljsakdjsdkafkjsdkljsakdjsdkafkjsdkljsakdjsdkafkjsdkljsakdjsdkafkjsdkljsakdjsdkafkjsdkljsakdjsdkafkjsdkljsakdjsdkafkjsdkljsakdjsdkafkjsdkljsakdjsdkafkjsdkljsakdjsdkafkjsdkljsakdjsdkafkjsdkljsakdjsdkafkjsdkljsakdjsdkafkjsdkljsakdjsdkafkjsdkljsakdjsdkafkjsdkljsakdjsdkafkjsdkljsakdjsdkafkjsdkljsakdjsdkafkjsdkljsakdjsdkafkjsdkljsakdjsdkafkjsdkljsakdjsdkafkjsdkljsakdjsdkafkjsdkljsakdjsdkafkjsdkljsakdjsdkafkjsdkljsakdjsdkafkjsdkljsakdjsdkafkjsdkljsakdjsdkafkjsdkljsakdjsdkafkjsdkljsakdjsdkafkjsdkljsakdjsdkafkjsdkljsakdjsdkafkjsdkljsakdjsdkafkjsdkljsakdjsdkafkjsdkljsakdjsdkafkjsdkljsakdjsdkafkjsdkljsakdjsdkafkjsdkljsakdjsdkafkjsdkljsakdjsdkafkjsdkljsakdjsdkafkjsdkljsakdjsdkafkjsdkljsakdjsdkafkjsdkljsakdjsdkafkjsdkljsakdjsdkafkjsdkljsakdjsdkafkjsdkljsakdjsdkafkjsdkljsakdjsdkafkjsdkljsakdjsdkafkjsdkljsakdjsdkafkjsdkljsakdjsdkafkjsdkljsakdjsdkafkjsdkljsakdjsdkafkjsdkljsakdjsdkafkjsdkljsakdjsdkafkjsdkljsakdjsdkafkjsdkljsakdjsdkafkjsdkljsakdjsdkafkjsdkljsakdjsdkafkjsdkljsakdjsdkafkjsdkljsakdjsdkafkjsdkljsakdjsdkafkjsdkljsakdjsdkafkjsdkljsakdjsdkafkjsdkljsakdjsdkafkjsdkljsakdjsdkafkjsdkljsakdjsdkafkjsdkljsakdjsdkafkjsdkljsakdjsdkafkjsdkljsakdjsdkafkjsdkljsakdjsdkafkjsdkljsakdjsdkafkjsdkljsakdjsdkafkjsdkljsakdjsdkafkjsdkljsakdjsdkafkjsdkljsakdjsdkafkjsdkljsakdjsdkafkjsdkljsakdjsdkafkjsdkljsakdjsdkafkjsdkljsakdjsdkafkjsdkljsakdjsdkafkjsdkljsakdjsdkafkjsdkljsakdjsdkafkjsdkljsakdjsdkafkjsdkljsakdjsdkafkjsdkljsakdjsdkafkjsdkljsakdjsdkafkjsdkljsakdjsdkafkjsdkljsakdjsdkafkjsdkljsakdjsdkafkjsdkljsakdjsdkafkjsdkljsakdjsdkafkjsdkljsakdjsdkafkjsdkljsakdjsdkafkjsdkljsakdjsdkafkjsdkljsakdjsdkafkjsdkljsakdjsdkafkjsdkljsakdjsdkafkjsdkljsakdjsdkafkjsdkljsakdj'
					).toString('base64'),
				'Content-Type': 'application/json',
			})
			.send({ operation: 'describe_all' })
			.expect((r) => assert.ok(r.text.includes('Login failed')))
			.expect(401);
	});

	it('Describe all without auth', async () => {
		const r = await request(envUrl)
			.post('')
			.set({ 'Content-Type': 'application/json' })
			.send({ operation: 'describe_all' });

		if (await isDevEnv()) {
			assert.ok(Object.keys(r.body).length > 0, r.text);
			assert.equal(r.status, 200, r.text);
		} else {
			assert.ok(r.text.includes('Must login'));
			assert.equal(r.status, 401, r.text);
		}
	});

	it('Create auth token with valid credentials', () => {
		return req()
			.send({
				operation: 'create_authentication_tokens',
				username: `${testData.username}`,
				password: `${testData.password}`,
			})
			.expect((r) => {
				assert.ok(r.body.hasOwnProperty('operation_token'), r.text);
				assert.ok(r.body.operation_token, r.text);
				testData.my_operation_token = r.body.operation_token;
			})
			.expect(200);
	});

	it('Describe all with valid auth token', () => {
		return request(envUrl)
			.post('')
			.set('Content-Type', 'application/json')
			.set('Authorization', `Bearer ${testData.my_operation_token}`)
			.send({ operation: 'describe_all' })
			.expect((r) => assert.ok(Object.keys(r.body).length > 0, r.text))
			.expect(200);
	});

	it('Create auth token with invalid credentials', () => {
		return request(envUrl)
			.post('')
			.set('Content-Type', 'application/json')
			.send({ operation: 'create_authentication_tokens', username: `${testData.username}`, password: '' })
			.expect((r) => assert.ok(JSON.stringify(r.body).includes("'password' is not allowed to be empty"), r.text))
			.expect(400);
	});

	it('Create auth token with invalid credentials 2', () => {
		return request(envUrl)
			.post('')
			.set('Content-Type', 'application/json')
			.send({ operation: 'create_authentication_tokens', username: '', password: `${testData.password}` })
			.expect((r) => assert.ok(JSON.stringify(r.body).includes("'username' is not allowed to be empty"), r.text))
			.expect(400);
	});

	it('Create auth token with invalid credentials 3', () => {
		return request(envUrl)
			.post('')
			.set('Content-Type', 'application/json')
			.send({ operation: 'create_authentication_tokens', username: 'wrongusername', password: 'wrongpassword' })
			.expect((r) => assert.ok(JSON.stringify(r.body).includes('invalid credentials'), r.text))
			.expect(401);
	});

	it('Create auth token with empty credentials', async () => {
		const r = await request(envUrl)
			.post('')
			.set('Content-Type', 'application/json')
			.send({ operation: 'create_authentication_tokens', username: '', password: '' });

		if (await isDevEnv()) {
			assert.ok(
				JSON.stringify(r.body).includes("'username' is not allowed to be empty. 'password' is not allowed to be empty"),
				r.text
			);
			assert.equal(r.status, 400, r.text);
		} else {
			assert.ok(JSON.stringify(r.body).includes('Must login'), r.text);
			assert.equal(r.status, 401, r.text);
		}
	});
});
