import { describe, it } from 'node:test';
import { dropSchema } from '../utils/schema.js';
import assert from 'node:assert/strict';
import { req } from '../utils/request.js';

describe('0. Environment Cleanup', () => {
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
