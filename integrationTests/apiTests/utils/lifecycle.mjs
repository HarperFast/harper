import assert from 'node:assert/strict';
import { setTimeout } from 'node:timers/promises';

const DEFAULT_READINESS_TIMEOUT_MS = 60000;
const READINESS_POLL_INTERVAL_MS = 250;

/**
 * Trigger `restart_service http_workers` and wait for the REST workers (and
 * any newly-registered component routes) to be serving traffic again.
 *
 * `probePath` should be a REST route that returns a non-404 once the
 * just-installed component has registered its resources — typically the
 * route the test is about to exercise. Any response in [200, 499] excluding
 * 404 is treated as ready; 4xx auth/validation responses are fine.
 *
 * Replaces a fixed-duration sleep so the helper scales to slower
 * environments (Windows CI, contended runners).
 *
 * @param {ReturnType<import('./client.mjs').createApiClient>} client
 * @param {string} probePath REST path that should be served by the component
 * @param {number} [timeoutMs] overall readiness budget (default 60s)
 */
export async function restartHttpWorkers(client, probePath, timeoutMs = DEFAULT_READINESS_TIMEOUT_MS) {
	await client
		.req()
		.send({ operation: 'restart_service', service: 'http_workers' })
		.expect((r) => assert.ok(r.body.message.includes('Restarting http_workers'), r.text))
		.expect(200);

	// Give the supervisor a moment to actually tear down the existing workers
	// before polling, otherwise the first probe may hit a still-serving worker
	// that's about to die.
	await setTimeout(500);

	const deadline = Date.now() + timeoutMs;
	let lastStatus;
	let lastError;
	while (Date.now() < deadline) {
		try {
			const response = await client.reqRest(probePath).timeout(2000);
			lastStatus = response.status;
			if (response.status !== 404) return;
		} catch (err) {
			lastError = err;
		}
		await setTimeout(READINESS_POLL_INTERVAL_MS);
	}
	throw new Error(
		`Probe ${probePath} did not become ready within ${timeoutMs}ms after restart_service ` +
			`(last status=${lastStatus ?? 'none'}, last error=${lastError?.message ?? 'none'})`
	);
}
