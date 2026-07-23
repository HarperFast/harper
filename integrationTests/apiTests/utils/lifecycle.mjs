import assert from 'node:assert';
import { setTimeout } from 'node:timers/promises';
import { awaitJobCompleted } from './operations.mjs';

const DEFAULT_READINESS_TIMEOUT_MS = 60000;
const READINESS_POLL_INTERVAL_MS = 250;

/**
 * Poll `probePath` until it stops returning 404, i.e. until the route is registered and
 * being served. Any response in [200, 499] excluding 404 is treated as ready; 4xx
 * auth/validation responses are fine.
 *
 * Use this directly (without `restartHttpWorkers`) when the component/route is already
 * installed and only async post-boot route registration needs to be awaited — no worker
 * restart involved.
 *
 * @param {ReturnType<import('./client.mjs').createApiClient>} client
 * @param {string} probePath REST path that should be served by the component
 * @param {number} [timeoutMs] overall readiness budget (default 60s)
 */
export async function waitForRouteReady(client, probePath, timeoutMs = DEFAULT_READINESS_TIMEOUT_MS) {
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
		`Probe ${probePath} did not become ready within ${timeoutMs}ms ` +
			`(last status=${lastStatus ?? 'none'}, last error=${lastError?.message ?? 'none'})`
	);
}

/**
 * Trigger `restart_service http_workers` and wait for the restart to actually complete and
 * the REST workers (and any newly-registered component routes) to be serving traffic again.
 *
 * On return the old workers are gone: callers can assume every subsequent request is served
 * by a worker that will outlive the restart.
 *
 * `probePath` should be a REST route that returns a non-404 once the
 * just-installed component has registered its resources — typically the
 * route the test is about to exercise. Any response in [200, 499] excluding
 * 404 is treated as ready; 4xx auth/validation responses are fine.
 *
 * @param {ReturnType<import('./client.mjs').createApiClient>} client
 * @param {string} probePath REST path that should be served by the component
 * @param {number} [timeoutMs] overall readiness budget (default 60s)
 */
export async function restartHttpWorkers(client, probePath, timeoutMs = DEFAULT_READINESS_TIMEOUT_MS) {
	const { body } = await client
		.req()
		.send({ operation: 'restart_service', service: 'http_workers' })
		.expect((r) => assert.ok(r.body.message.includes('Restarting http_workers'), r.text))
		.expect(200);

	// `restart_service` is a job: this 200 only means the job THREAD was launched
	// (serverUtilities.executeJob -> jobRunner.runJob -> launchJobThread), not that any worker
	// has been touched. The real teardown lands ~1s later, and later still on a contended
	// runner. Waiting for the job to reach COMPLETE is what actually orders us *after* the
	// restart: the job thread only returns once the main thread has posted `restart-complete`
	// (bin/restart.ts), which it does after `restartWorkers('http')` has fully returned.
	// Without this gate the readiness probe below reports on the OLD workers and the restart
	// then kills them under the test that just started (#1833). The operations API is served
	// by the main thread, so it stays reachable while the http workers cycle.
	assert.ok(body.job_id, `restart_service returned no job_id: ${JSON.stringify(body)}`);
	await awaitJobCompleted(client, body.job_id, { timeoutSeconds: Math.ceil(timeoutMs / 1000) });

	try {
		await waitForRouteReady(client, probePath, timeoutMs);
	} catch (err) {
		throw new Error(err.message + ' after restart_service', { cause: err });
	}
}
