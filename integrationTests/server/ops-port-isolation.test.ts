/**
 * Regression test for #1420.
 *
 * When an application config carries a port-less `operationsApi` block, loading it on the
 * main thread re-invokes the operations-API plugin with no port. Before the fix, `getPorts`
 * fell back to the app http ports, so the main thread bound them as operations-api servers
 * (noReusePort, no WebSocket upgrade handler). That locked the http worker threads out of
 * those ports (silently swallowed EADDRINUSE), leaving only the main thread's handler-less
 * socket — so every WebSocket upgrade was reset while plain HTTP kept working.
 *
 * This test boots Harper with such an app and asserts that a WebSocket upgrade on the app
 * http port still completes (HTTP 101). Without the fix the upgrade never completes.
 */
import { suite, test, before, after } from 'node:test';
import { ok, strictEqual } from 'node:assert/strict';
import { request } from 'node:http';
import { join } from 'node:path';

import { setupHarperWithFixture, teardownHarper, type ContextWithHarper } from '@harperfast/integration-testing';

const FIXTURE = join(import.meta.dirname, 'fixtures', 'ops-port-collision-app');

/** Attempt a WebSocket upgrade and resolve with the HTTP status code (101 on success). */
function wsUpgradeStatus(url: string): Promise<number> {
	return new Promise((resolve, reject) => {
		const req = request(url, {
			headers: {
				'Connection': 'Upgrade',
				'Upgrade': 'websocket',
				'Sec-WebSocket-Version': '13',
				'Sec-WebSocket-Key': 'dGhlIHNhbXBsZSBub25jZQ==',
			},
		});
		req.setTimeout(8000, () => req.destroy(new Error('ws upgrade timed out')));
		// A successful upgrade emits 'upgrade'; a handler-less server answers as a normal response.
		req.on('upgrade', (res, socket) => {
			// Avoid an unhandled 'error' crashing the test process if the socket faults on teardown.
			socket.on('error', () => {});
			socket.destroy();
			resolve(res.statusCode ?? 0);
		});
		req.on('response', (res) => {
			res.destroy();
			resolve(res.statusCode ?? 0);
		});
		req.on('error', reject);
		req.end();
	});
}

suite('REST WebSocket upgrade with a port-less app operationsApi block (#1420)', (ctx: ContextWithHarper) => {
	before(async () => {
		await setupHarperWithFixture(ctx, FIXTURE, {
			config: {
				threads: { count: 2 },
				mqtt: { webSocket: true },
			},
			env: {},
		});
	});

	after(async () => {
		await teardownHarper(ctx);
	});

	test('WebSocket upgrade on the app http port completes (101)', async () => {
		const status = await wsUpgradeStatus(ctx.harper.httpURL);
		strictEqual(status, 101, `expected WS upgrade to return 101, got ${status}`);
	});

	test('plain HTTP still responds on the app http port', async () => {
		// The bug's signature was "HTTP works, WS breaks"; assert HTTP is unaffected.
		const res = await fetch(ctx.harper.httpURL);
		ok(res.status > 0, 'expected an HTTP response on the app port');
	});

	test('operations API remains reachable on its own port', async () => {
		// Guards against an over-broad guard that would stop the ops API from binding.
		const res = await fetch(`${ctx.harper.operationsAPIURL}/health`);
		strictEqual(res.status, 200);
	});
});
