import assert from 'node:assert/strict';
import { req } from './request.js';

export async function isDevEnv() {
	const getConfig = await req()
		.send({ operation: 'get_configuration' })
		.expect((r) => {
			assert.ok(r.body.authentication, r.text);
		})
		.expect(200);
	return getConfig.body.authentication.authorizeLocal;
}