import { describe, it } from 'node:test';
import assert from 'node:assert';
import request from 'supertest';
import { envUrl, testData, headers } from '../config/envConfig.js';
import { isDevEnv } from '../utils/env.js';

describe('21. Authentication Tests', () => {
	//Authentication Tests Folder

	it('Describe all with valid credentials', async () => {
		const response = await request(envUrl).post('').set(headers).send({ operation: 'describe_all' }).expect(200);
	});

	it('Describe all with invalid password', async () => {
		const response = await request(envUrl)
			.post('')
			.set({
				'Authorization': 'Basic ' + Buffer.from(testData.username + ':' + 'thisIsNotMyPassword').toString('base64'),
				'Content-Type': 'application/json',
			})
			.send({ operation: 'describe_all' })
			.expect((r) => assert.ok(r.text.includes('Login failed')))
			.expect(401);
	});

	it('Describe all with invalid username', async () => {
		const response = await request(envUrl)
			.post('')
			.set({
				'Authorization': 'Basic ' + Buffer.from('thisIsNotMyUsername' + ':' + testData.password).toString('base64'),
				'Content-Type': 'application/json',
			})
			.send({ operation: 'describe_all' })
			.expect((r) => assert.ok(r.text.includes('Login failed')))
			.expect(401);
	});

	it('Describe all with empty credentials', async () => {
		const response = await request(envUrl)
			.post('')
			.set({
				'Authorization': 'Basic ' + Buffer.from('' + ':' + '').toString('base64'),
				'Content-Type': 'application/json',
			})
			.send({ operation: 'describe_all' })
			.expect((r) => {
				assert.ok(r.text.includes('Must login'));
			})
			.expect(401);
	});

	it('Describe all with long credentials', async () => {
		const response = await request(envUrl)
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
		const response = await request(envUrl)
			.post('')
			.set({ 'Content-Type': 'application/json' })
			.send({ operation: 'describe_all' })
			.expect(async (r) => {
				if (await isDevEnv()) {
					assert.ok((Object.keys(r.body).length > 0), r.text);
					assert.ok(r.status == 200, r.text);
				} else {
					assert.ok(r.text.includes('Must login'));
					assert.ok(r.status == 401, r.text);
				}
			})
	});

	it('Create auth token with valid credentials', async () => {
		const response = await request(envUrl)
			.post('')
			.set(headers)
			.send({
				operation: 'create_authentication_tokens',
				username: `${testData.username}`,
				password: `${testData.password}`,
			})
			.expect((r) => assert.ok(r.body.hasOwnProperty('operation_token'), r.text))
			.expect((r) => assert.ok(r.body.operation_token, r.text))
			.expect(200);
		testData.my_operation_token = response.body.operation_token;
	});

	it('Describe all with valid auth token', async () => {
		const response = await request(envUrl)
			.post('')
			.set('Content-Type', 'application/json')
			.set('Authorization', `Bearer ${testData.my_operation_token}`)
			.send({ operation: 'describe_all' })
			.expect((r) => assert.ok(Object.keys(r.body).length > 0, r.text))
			.expect(200);
	});

	it('Create auth token with invalid credentials', async () => {
		const response = await request(envUrl)
			.post('')
			.set('Content-Type', 'application/json')
			.send({ operation: 'create_authentication_tokens', username: `${testData.username}`, password: '' })
			.expect((r) => assert.ok(JSON.stringify(r.body).includes("'password' is not allowed to be empty"), r.text))
			.expect(400);
	});

	it('Create auth token with invalid credentials 2', async () => {
		const response = await request(envUrl)
			.post('')
			.set('Content-Type', 'application/json')
			.send({ operation: 'create_authentication_tokens', username: '', password: `${testData.password}` })
			.expect((r) => assert.ok(JSON.stringify(r.body).includes("'username' is not allowed to be empty"), r.text))
			.expect(400);
	});

	it('Create auth token with invalid credentials 3', async () => {
		const response = await request(envUrl)
			.post('')
			.set('Content-Type', 'application/json')
			.send({ operation: 'create_authentication_tokens', username: 'wrongusername', password: 'wrongpassword' })
			.expect((r) => assert.ok(JSON.stringify(r.body).includes('invalid credentials'), r.text))
			.expect(401);
	});

	it('Create auth token with empty credentials', async () => {
		const response = await request(envUrl)
			.post('')
			.set('Content-Type', 'application/json')
			.send({ operation: 'create_authentication_tokens', username: '', password: '' })
			.expect(async (r) => {
				if (await isDevEnv()) {
					assert.ok(JSON.stringify(r.body).includes("'username' is not allowed to be empty. 'password' is not allowed to be empty"), r.text);
					assert.ok(r.status == 400, r.text);
				} else {
					assert.ok(JSON.stringify(r.body).includes("Must login"), r.text);
					assert.ok(r.status == 401, r.text);
				}
			})
	});
});
