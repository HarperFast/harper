/**
 * Local application deployment test.
 *
 * Deploys an application from a fixture directory using the `payload` parameter of
 * the `deploy_component` Operations API call. Verifies that the application is
 * deployed correctly and can be accessed via HTTP.
 *
 */
import { suite, test, before, after } from 'node:test';
import { ok, strictEqual } from 'node:assert/strict';
import { join } from 'node:path';
import { existsSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';

import { startHarper, teardownHarper, targz, type ContextWithHarper } from '@harperfast/integration-testing';

suite('Local application deployment', (ctx: ContextWithHarper) => {
	before(async () => {
		await startHarper(ctx);
	});

	after(async () => {
		await teardownHarper(ctx);
	});

	test('verify Harper', async () => {
		const response = await fetch(`${ctx.harper.operationsAPIURL}/health`);
		strictEqual(response.status, 200);
		const body = await response.text();
		strictEqual(body, 'Harper is running.');
	});

	test('deploy application', async () => {
		const project = 'test-application';
		const payload = await targz(join(import.meta.dirname, 'fixture'));
		const response = await fetch(ctx.harper.operationsAPIURL, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({
				operation: 'deploy_component',
				project,
				payload,
				restart: true,
			}),
		});
		strictEqual(response.status, 200);
		const body = await response.json();
		strictEqual(body.message, 'Successfully deployed: test-application, restarting Harper');
		ok(
			typeof body.deployment_id === 'string' && /^[0-9a-f-]{36}$/i.test(body.deployment_id),
			`expected a UUID deployment_id, got ${body.deployment_id}`
		);
		// Poll until the deployed app is reachable. `restart: true` returns
		// before the new Harper process is listening, so a fixed sleep is
		// flaky — especially on Windows where the restart can take >5s.
		// Mirrors the pattern in deploy-from-github.test.ts.
		const deadline = Date.now() + 30_000;
		while (true) {
			try {
				const check = await fetch(ctx.harper.httpURL);
				if (check.status === 200) {
					await check.body?.cancel();
					break;
				}
				await check.body?.cancel();
			} catch {
				// server not yet accepting connections
			}
			if (Date.now() > deadline) throw new Error('Timed out waiting for application to be ready after restart');
			await sleep(250);
		}
		ok(existsSync(join(ctx.harper.dataRootDir, 'components', project)));
		ok(existsSync(join(ctx.harper.dataRootDir, 'harper-application-lock.json')));
	});

	test('access deployed application', async () => {
		const response = await fetch(ctx.harper.httpURL);
		strictEqual(response.status, 200);
		const body = await response.text();
		ok(body.includes('<h1>Hello, Harper!</h1>'));
	});

	test('throughput benchmark: Simple table PUT/GET', async (t) => {
		const base = `${ctx.harper.httpURL}/Simple`;
		const auth = `Basic ${Buffer.from(`${ctx.harper.admin.username}:${ctx.harper.admin.password}`).toString('base64')}`;
		const jsonHeaders = { 'Content-Type': 'application/json', 'Authorization': auth };
		const readHeaders = { Authorization: auth };

		const CONCURRENCY = 25;
		const TOTAL_REQUESTS = 20000;
		const READ_WRITE_RATIO = 20; // reads per write

		// Pre-populate records so GETs have data to hit
		const SEED_COUNT = 200;
		await Promise.all(
			Array.from({ length: SEED_COUNT }, (_, i) =>
				fetch(`${base}/${i}`, {
					method: 'PUT',
					headers: jsonHeaders,
					body: JSON.stringify({ name: `seed-${i}` }),
				}).then((r) => r.body?.cancel())
			)
		);

		const latencies: number[] = [];
		let errors = 0;
		let nextWriteId = SEED_COUNT;

		async function sendRequest(index: number): Promise<void> {
			const isWrite = index % (READ_WRITE_RATIO + 1) === 0;
			const t0 = performance.now();
			try {
				let res: Response;
				if (isWrite) {
					const id = nextWriteId++;
					res = await fetch(`${base}/${id}`, {
						method: 'PUT',
						headers: jsonHeaders,
						body: JSON.stringify({ name: `bench-${id}` }),
					});
				} else {
					const id = Math.floor(Math.random() * SEED_COUNT);
					res = await fetch(`${base}/${id}`, { headers: readHeaders });
				}
				if (!res.ok) errors++;
				await res.body?.cancel();
			} catch {
				errors++;
			}
			latencies.push(performance.now() - t0);
		}

		// Bounded concurrency dispatcher
		const startTime = performance.now();
		let dispatched = 0;
		const inflight = new Set<Promise<void>>();

		while (dispatched < TOTAL_REQUESTS || inflight.size > 0) {
			while (inflight.size < CONCURRENCY && dispatched < TOTAL_REQUESTS) {
				const p: Promise<void> = sendRequest(dispatched++).then(() => {
					inflight.delete(p);
				});
				inflight.add(p);
			}
			if (inflight.size > 0) await Promise.race(inflight);
		}

		const totalMs = performance.now() - startTime;

		latencies.sort((a, b) => a - b);
		const pct = (p: number) => latencies[Math.floor(latencies.length * p)].toFixed(1);
		const throughput = ((latencies.length / totalMs) * 1000).toFixed(1);

		t.diagnostic(`Benchmark: ${TOTAL_REQUESTS} requests, concurrency=${CONCURRENCY}, R:W=${READ_WRITE_RATIO}:1`);
		t.diagnostic(`  Throughput : ${throughput} req/s`);
		t.diagnostic(`  Total time : ${(totalMs / 1000).toFixed(2)}s`);
		t.diagnostic(`  Errors     : ${errors}`);
		t.diagnostic(`  Latency p50: ${pct(0.5)}ms`);
		t.diagnostic(`  Latency p95: ${pct(0.95)}ms`);
		t.diagnostic(`  Latency p99: ${pct(0.99)}ms`);

		strictEqual(errors, 0, `Expected 0 errors, got ${errors}`);
	});
});
