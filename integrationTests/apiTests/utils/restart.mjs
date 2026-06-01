import assert from 'node:assert/strict';
import { setTimeout as sleep } from 'node:timers/promises';
import { connect } from 'node:net';
import { req } from './request.mjs';
import { testData } from '../config/envConfig.mjs';

const POLL_INTERVAL_MS = 200;

/**
 * Poll a TCP port until it accepts a connection or the deadline is exceeded.
 *
 * @param {string} host
 * @param {number} port
 * @param {number} deadlineMs absolute timestamp to stop retrying
 */
async function waitForTcpPort(host, port, deadlineMs) {
	while (Date.now() < deadlineMs) {
		const connected = await new Promise((resolve) => {
			const socket = connect({ host, port });
			socket.setTimeout(2000);
			socket.on('connect', () => {
				socket.destroy();
				resolve(true);
			});
			socket.on('timeout', () => {
				socket.destroy();
				resolve(false);
			});
			socket.on('error', () => {
				socket.destroy();
				resolve(false);
			});
		});
		if (connected) return;
		await sleep(POLL_INTERVAL_MS);
	}
	throw new Error(`Port ${host}:${port} did not become reachable within the allotted timeout`);
}

/**
 * Poll a TCP port until connection is REFUSED (port closed) or the deadline is exceeded.
 * Used to confirm old workers have fully released the port before polling for new workers.
 *
 * @param {string} host
 * @param {number} port
 * @param {number} deadlineMs absolute timestamp to stop retrying
 */
async function waitForTcpPortClose(host, port, deadlineMs) {
	while (Date.now() < deadlineMs) {
		const connected = await new Promise((resolve) => {
			const socket = connect({ host, port });
			socket.setTimeout(2000);
			socket.on('connect', () => {
				socket.destroy();
				resolve(true);
			});
			socket.on('timeout', () => {
				socket.destroy();
				resolve(false);
			});
			socket.on('error', () => {
				socket.destroy();
				resolve(false);
			});
		});
		if (!connected) return;
		await sleep(POLL_INTERVAL_MS);
	}
	throw new Error(`Port ${host}:${port} did not close within the allotted timeout`);
}

/**
 * Issue a full `restart` operation and wait for the operations API to become
 * reachable again via an active TCP-connect poll on port 9925.
 *
 * Replaces a fixed `setTimeout(timeout)` — scales to slow CI runners.
 *
 * @param {number} [timeoutMs] overall readiness budget in ms (default: testData.restartTimeout)
 */
export async function restartWithTimeout(timeoutMs) {
	const budget = timeoutMs ?? testData.restartTimeout ?? 60000;
	await sleep(500);
	try {
		await req()
			.send({ operation: 'restart' })
			.expect((r) => assert.ok(r.body.message.includes('Restarting'), r.text))
			.expect(200);
	} catch (err) {
		// On Windows the server may reset/refuse the connection while shutting down
		// before the HTTP response is fully delivered. Both are valid "restart accepted"
		// signals — proceed with the TCP poll rather than throwing.
		const code = err.code ?? err.cause?.code;
		const codes = new Set(['ECONNRESET', 'ECONNREFUSED', 'ECONNABORTED', 'EPIPE']);
		if (!codes.has(code) && !(err instanceof AggregateError)) throw err;
	}

	// Brief pause so the process begins shutting down before we start polling.
	await sleep(1000);

	const host = testData.host.replace(/^https?:\/\//, '');
	const port = parseInt(testData.port, 10);
	await waitForTcpPort(host, port, Date.now() + budget);
}

/**
 * Issue `restart_service http_workers` and wait for the REST workers to be
 * accepting TCP connections on the REST port (9926) again.
 *
 * For tests that need a *specific component route* to be registered before
 * continuing, prefer using `restartHttpWorkers` from `./lifecycle.mjs` which
 * takes a `probePath` and polls for a non-404 HTTP response.
 *
 * Replaces a fixed `setTimeout(timeout)` — scales to slow CI runners.
 *
 * @param {number} [timeoutMs] overall readiness budget in ms (default: testData.restartHttpWorkersTimeout)
 */
export async function restartServiceHttpWorkersWithTimeout(timeoutMs) {
	const budget = timeoutMs ?? testData.restartHttpWorkersTimeout ?? 60000;
	await sleep(500);
	await req()
		.send({
			operation: 'restart_service',
			service: 'http_workers',
		})
		.expect((r) => assert.ok(r.body.message.includes('Restarting http_workers'), r.text))
		.expect(200);

	const host = testData.host.replace(/^https?:\/\//, '');
	const restPort = parseInt(testData.portRest, 10);

	const deadline = Date.now() + budget;

	// Phase 1: wait for old workers to fully release the port (avoids premature
	// detection of old workers still holding 9926 after the restart command).
	await waitForTcpPortClose(host, restPort, deadline);

	// Phase 2: wait for new workers to bind and accept connections.
	await waitForTcpPort(host, restPort, deadline);
}
