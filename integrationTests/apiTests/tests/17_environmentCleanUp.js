import { describe, it } from 'node:test';
import assert from 'node:assert';
import request from 'supertest';
import { envUrl, headers } from '../config/envConfig.js';
import { setTimeout } from 'node:timers/promises';

describe('17. Environment Clean Up', () => {
	//Environment Clean Up Folder

	it('drop schema northnwd', async () => {
		const response = await request(envUrl)
			.post('')
			.set(headers)
			.send({ operation: 'drop_schema', schema: 'northnwd' })
			.expect((r) => assert.ok(r.body.message.includes('successfully delete')))
			.expect(200);
		await setTimeout(1000);
	});

	it('VALIDATION Check Schema not found.', async () => {
		const response = await request(envUrl)
			.post('')
			.set(headers)
			.send({ operation: 'describe_all' })
			.expect((r) => assert.ok(!r.body.hasOwnProperty('northnwd')))
			.expect(200);
	});

	it('drop schema dev', async () => {
		const response = await request(envUrl)
			.post('')
			.set(headers)
			.send({ operation: 'drop_schema', schema: 'dev' })
			.expect((r) => assert.ok(r.body.message.includes('successfully delete')))
			.expect(200);
	});

	it('drop schema other', async () => {
		const response = await request(envUrl)
			.post('')
			.set(headers)
			.send({ operation: 'drop_schema', schema: 'other' })
			.expect((r) => assert.ok(r.body.message.includes('successfully delete')))
			.expect(200);
	});

	it('drop schema another', async () => {
		const response = await request(envUrl)
			.post('')
			.set(headers)
			.send({ operation: 'drop_schema', schema: 'another' })
			.expect((r) => assert.ok(r.body.message.includes('successfully delete')))
			.expect(200);
	});

	it('drop schema call', async () => {
		const response = await request(envUrl)
			.post('')
			.set(headers)
			.send({ operation: 'drop_schema', schema: 'call' })
			.expect((r) => assert.ok(r.body.message.includes('successfully delete')))
			.expect(200);
	});

	it('drop schema test_delete_before (disabled)', async () => {
		const response = await request(envUrl)
			.post('')
			.set(headers)
			.send({ operation: 'drop_schema', schema: 'test_delete_before' })
			.expect(200);
	});
});
