import request from 'supertest';
import { envUrl, generic, headers } from '../config/envConfig.js';
import assert from 'node:assert';

export async function isDevEnv() {
	const getConfig = await request(envUrl)
		.post('')
		.set(headers)
		.send({ operation: 'get_configuration' })
		.expect((r) => {
			assert.ok(r.body.authentication);
		})
		.expect(200);
	return getConfig.body.authentication.authorizeLocal;
}