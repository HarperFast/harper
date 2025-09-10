import { describe, it, beforeEach } from 'node:test';
import { dropSchema } from '../utils/schema.mjs';
import assert from 'node:assert/strict';
import { req } from '../utils/request.mjs';
import { timestamp } from '../utils/timestamp.mjs';

describe('0. Environment Cleanup', () => {
	beforeEach(timestamp);

	it('Environment Cleanup', async () => {
		const response = await req().send({
			operation: 'describe_all',
		});
		for (const key of Object.keys(response.body)) {
			await dropSchema(key, false);
		}
		await req()
			.send({
				operation: 'describe_all',
			})
			.expect((r) => {
				const keys = Object.keys(r.body);
				assert.equal(keys.length, 0, r.text);
			})
			.expect(200);
	});
});
