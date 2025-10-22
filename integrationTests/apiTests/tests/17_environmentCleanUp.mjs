import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout } from 'node:timers/promises';
import { req } from '../utils/request.mjs';
import { timestamp } from '../utils/timestamp.mjs';

describe('17. Environment Clean Up', () => {
	beforeEach(timestamp);
	
	//Environment Clean Up Folder

	it('drop schema northnwd', async () => {
		await req()
			.send({ operation: 'drop_schema', schema: 'northnwd' })
			.expect((r) => assert.ok(r.body.message.includes('successfully delete'), r.text))
			.expect(200);
		await setTimeout(1000);
	});

	it('VALIDATION Check Schema not found.', () => {
		return req()
			.send({ operation: 'describe_all' })
			.expect((r) => assert.ok(!r.body.hasOwnProperty('northnwd'), r.text))
			.expect(200);
	});

	it('drop schema dev', () => {
		return req()
			.send({ operation: 'drop_schema', schema: 'dev' })
			.expect((r) => assert.ok(r.body.message.includes('successfully delete'), r.text))
			.expect(200);
	});

	it('drop schema other', () => {
		return req()
			.send({ operation: 'drop_schema', schema: 'other' })
			.expect((r) => assert.ok(r.body.message.includes('successfully delete'), r.text))
			.expect(200);
	});

	it('drop schema another', () => {
		return req()
			.send({ operation: 'drop_schema', schema: 'another' })
			.expect((r) => assert.ok(r.body.message.includes('successfully delete'), r.text))
			.expect(200);
	});

	it('drop schema call', () => {
		return req()
			.send({ operation: 'drop_schema', schema: 'call' })
			.expect((r) => assert.ok(r.body.message.includes('successfully delete'), r.text))
			.expect(200);
	});

	it('drop schema test_delete_before (disabled)', () => {
		return req().send({ operation: 'drop_schema', schema: 'test_delete_before' }).expect(200);
	});
});
