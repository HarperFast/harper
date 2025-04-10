import assert from 'node:assert';
import request from 'supertest';
import { envUrl, headers } from '../config/envConfig.js';
import { setTimeout } from 'node:timers/promises';


export async function restartWithTimeout(timeout) {
	await setTimeout(1000);
	const response = await request(envUrl)
		.post('')
		.set(headers)
		.send({ operation: 'restart' })
		.expect((r) => assert.ok(r.body.message.includes('Restarting'), r.text))
		.expect(200);
	await setTimeout(timeout);
}