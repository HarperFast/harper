import assert from 'node:assert/strict';
import { setTimeout } from 'node:timers/promises';
import { req } from './request.js';


export async function restartWithTimeout(timeout) {
	await setTimeout(1000);
	await req()
		.send({ operation: 'restart' })
		.expect((r) => assert.ok(r.body.message.includes('Restarting'), r.text))
		.expect(200);
	await setTimeout(timeout);
}

export async function restartServiceHttpWorkersWithTimeout(timeout) {
	await setTimeout(1000);
	await req()
		.send({
			operation: 'restart_service',
			service: 'http_workers'
		})
		.expect((r) => assert.ok(r.body.message.includes('Restarting http_workers'), r.text))
		.expect(200);
	await setTimeout(timeout);
}