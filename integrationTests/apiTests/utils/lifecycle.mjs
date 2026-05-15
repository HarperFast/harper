import assert from 'node:assert/strict';
import { setTimeout } from 'node:timers/promises';

const DEFAULT_HTTP_WORKERS_TIMEOUT_MS = 15000;

/**
 * Trigger `restart_service http_workers` and wait long enough for the workers
 * to come back online. Bound to a per-test client so each suite can drive its
 * own instance.
 *
 * @param {ReturnType<import('./client.mjs').createApiClient>} client
 * @param {number} [timeoutMs]
 */
export async function restartHttpWorkers(client, timeoutMs = DEFAULT_HTTP_WORKERS_TIMEOUT_MS) {
	await setTimeout(1000);
	await client
		.req()
		.send({ operation: 'restart_service', service: 'http_workers' })
		.expect((r) => assert.ok(r.body.message.includes('Restarting http_workers'), r.text))
		.expect(200);
	await setTimeout(timeoutMs);
}
