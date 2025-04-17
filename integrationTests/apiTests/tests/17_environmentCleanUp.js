import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout } from 'node:timers/promises';
import { req } from '../utils/request.js';

describe('17. Environment Clean Up', () => {
	//Environment Clean Up Folder

	it('drop schema northnwd', async () => {
		await req()
			.send({ operation: 'drop_schema', schema: 'northnwd' })
			.expect((r) => assert.ok(r.body.message.includes('successfully delete'), r.text))
			.expect(200);
		await setTimeout(1000);
	});

	it('VALIDATION Check Schema not found.', async () => {
		await req()
			.send({ operation: 'describe_all' })
			.expect((r) => assert.ok(!r.body.hasOwnProperty('northnwd'), r.text))
			.expect(200);
	});

	it('drop schema dev', async () => {
		await req()
			.send({ operation: 'drop_schema', schema: 'dev' })
			.expect((r) => assert.ok(r.body.message.includes('successfully delete'), r.text))
			.expect(200);
	});

	it('drop schema other', async () => {
		await req()
			.send({ operation: 'drop_schema', schema: 'other' })
			.expect((r) => assert.ok(r.body.message.includes('successfully delete'), r.text))
			.expect(200);
	});

	it('drop schema another', async () => {
		await req()
			.send({ operation: 'drop_schema', schema: 'another' })
			.expect((r) => assert.ok(r.body.message.includes('successfully delete'), r.text))
			.expect(200);
	});

	it('drop schema call', async () => {
		await req()
			.send({ operation: 'drop_schema', schema: 'call' })
			.expect((r) => assert.ok(r.body.message.includes('successfully delete'), r.text))
			.expect(200);
	});

	it('drop schema test_delete_before (disabled)', async () => {
		await req()
			.send({ operation: 'drop_schema', schema: 'test_delete_before' })
			.expect(200);
	});
});
