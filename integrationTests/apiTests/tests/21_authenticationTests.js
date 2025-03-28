import { describe, it } from 'node:test';
import assert from 'node:assert';
import request from 'supertest';
import { envUrl, generic, headers } from '../config/envConfig.js';

describe('21. Authentication Tests', () => {
	//Authentication Tests Folder

	it('Describe all with valid credentials', async () => {
		const response = await request(envUrl).post('').set(headers).send({ operation: 'describe_all' }).expect(200);
	});

	it('Describe all with invalid password', async () => {
		const response = await request(envUrl)
			.post('')
			.set({
				'Authorization': 'Basic ' + Buffer.from(generic.username + ':' + 'thisIsNotMyPassword').toString('base64'),
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
				'Authorization': 'Basic ' + Buffer.from('thisIsNotMyUsername' + ':' + generic.password).toString('base64'),
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
			.expect((r) => {
				console.log('this is only for prod config, not dev. in dev mode it works without auth, so test fails');
				assert.ok(r.text.includes('Must login'));
			})
			.expect(401);
	});

	it('Create auth token with valid credentials', async () => {
		const response = await request(envUrl)
			.post('')
			.set(headers)
			.send({
				operation: 'create_authentication_tokens',
				username: `${generic.username}`,
				password: `${generic.password}`,
			})
			.expect((r) => assert.ok(r.body.hasOwnProperty('operation_token')))
			.expect((r) => assert.ok(r.body.operation_token))
			.expect(200);
		generic.my_operation_token = response.body.operation_token;
	});

	it('Describe all with valid auth token', async () => {
		const response = await request(envUrl)
			.post('')
			.set('Content-Type', 'application/json')
			.set('Authorization', `Bearer ${generic.my_operation_token}`)
			.send({ operation: 'describe_all' })
			.expect((r) => assert.ok(Object.keys(r.body).length > 0))
			.expect(200);
	});

	it('Create auth token with invalid credentials', async () => {
		const response = await request(envUrl)
			.post('')
			.set(headers)
			.send({ operation: 'create_authentication_tokens', username: `${generic.username}`, password: '' })
			.expect((r) => assert.ok(JSON.stringify(r.body).includes('invalid credentials')))
			.expect(401);
	});

	it('Create auth token with invalid credentials 2', async () => {
		const response = await request(envUrl)
			.post('')
			.set(headers)
			.send({ operation: 'create_authentication_tokens', username: '', password: `${generic.password}` })
			.expect((r) => assert.ok(JSON.stringify(r.body).includes('invalid credentials')))
			.expect(401);
	});

	it('Create auth token with invalid credentials 3', async () => {
		const response = await request(envUrl)
			.post('')
			.set(headers)
			.send({ operation: 'create_authentication_tokens', username: 'wrongusername', password: 'wrongpassword' })
			.expect((r) => assert.ok(JSON.stringify(r.body).includes('invalid credentials')))
			.expect(401);
	});

	it('Create auth token with empty credentials', async () => {
		const response = await request(envUrl)
			.post('')
			.set(headers)
			.send({ operation: 'create_authentication_tokens', username: '', password: '' })
			.expect((r) => assert.ok(JSON.stringify(r.body).includes('invalid credentials')))
			.expect(401);
	});
});
