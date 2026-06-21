/**
 * Rolling HTTP restart — no whole-pool connection-refused gap (regression for #1417).
 *
 * Issue #1417: a rolling HTTP restart (`restartWorkers('http')`, reached via
 * `restart_service http_workers`, config hot-reload or deploy) was observed to
 * take the ENTIRE worker pool connection-refused for ~0.6–1.2s. The pool is meant
 * to stay available throughout — at most `maxWorkersDown` (default 1) workers down
 * at a time — but the old code shut each worker down *before* its replacement was
 * listening, so every worker had a downtime window and (via SO_REUSEPORT) clients
 * saw a burst of ECONNREFUSED smeared across the whole restart.
 *
 * The fix makes the restart genuinely overlapping: the replacement joins the
 * SO_REUSEPORT listener group and is accepting connections before the worker it
 * replaces is told to shut down, so capacity never dips and no connection is refused.
 *
 * Strategy:
 *   1. Boot Harper with several HTTP workers (a single worker would be vacuous).
 *   2. Drive continuous, fresh (non-keep-alive) HTTP connections at the HTTP port
 *      so the kernel spreads us across every worker and a closed listener surfaces
 *      as a real connection failure.
 *   3. Trigger `restart_service http_workers` mid-load.
 *   4. Assert NO connection was refused/dropped for the duration of the restart.
 *
 * Reproduction:
 *   npm run test:integration -- "integrationTests/server/rolling-restart.test.ts"
 */

import { suite, test, before, after } from 'node:test';
import { ok } from 'node:assert/strict';
import * as http from 'node:http';

import { startHarper, teardownHarper, type ContextWithHarper } from '@harperfast/integration-testing';

const WORKERS = 4; // >= 2 HTTP workers is the whole point — a single worker can't roll
const testsBun = process.env.HARPER_RUNTIME === 'bun';
// Windows supports only a single HTTP worker (no SO_REUSEPORT), so a rolling restart
// can't keep the pool up — see #549. Bun timing is unreliable for this in CI.
const skipSuite = process.platform === 'win32' || testsBun;

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms).unref());

function authHeader(ctx: ContextWithHarper) {
	return `Basic ${Buffer.from(`${ctx.harper.admin.username}:${ctx.harper.admin.password}`).toString('base64')}`;
}

interface ProbeResult {
	ok: boolean;
	/** error code on failure (e.g. ECONNREFUSED) */
	code?: string;
}

/**
 * Open ONE fresh TCP+HTTP connection (no keep-alive, so the kernel can spread us
 * across workers via SO_REUSEPORT) and resolve whether it was served. A refused or
 * dropped connection — the #1417 signature — resolves `{ ok: false, code }`.
 */
function probe(host: string, port: number): Promise<ProbeResult> {
	return new Promise((resolve) => {
		const req = http.request({ host, port, path: '/', method: 'GET', agent: false, timeout: 4000 }, (res) => {
			res.resume(); // drain
			res.on('end', () => resolve({ ok: true }));
		});
		req.on('error', (err: NodeJS.ErrnoException) => resolve({ ok: false, code: err.code ?? err.message }));
		req.on('timeout', () => {
			req.destroy();
			resolve({ ok: false, code: 'ETIMEDOUT' });
		});
		req.end();
	});
}

/** Live HTTP worker count via the operations API (best-effort, 0 on failure). */
async function observedWorkerCount(ctx: ContextWithHarper): Promise<number> {
	try {
		const res = await fetch(ctx.harper.operationsAPIURL, {
			method: 'POST',
			headers: { 'Authorization': authHeader(ctx), 'Content-Type': 'application/json' },
			body: JSON.stringify({ operation: 'system_information', attributes: ['threads'] }),
			signal: AbortSignal.timeout(5000),
		});
		const body = (await res.json()) as { threads?: unknown };
		return Array.isArray(body.threads) ? body.threads.length : 0;
	} catch {
		return 0;
	}
}

suite('Rolling HTTP restart keeps the pool available (#1417)', { skip: skipSuite }, (ctx: ContextWithHarper) => {
	before(async () => {
		await startHarper(ctx, { config: { threads: { count: WORKERS } }, env: {} } as any);
	});

	after(async () => {
		await teardownHarper(ctx);
	});

	test('restart_service http_workers refuses no connections', { timeout: 120_000 }, async () => {
		// Guard: confirm we really booted multiple workers — otherwise the test is vacuous.
		const workerCount = await observedWorkerCount(ctx);
		ok(workerCount >= 2, `expected >= 2 HTTP workers, observed ${workerCount} — test would be vacuous`);

		const url = new URL(ctx.harper.httpURL);
		const host = url.hostname;
		const port = Number(url.port);

		let probing = true;
		let successes = 0;
		const failures: ProbeResult[] = [];

		// Several concurrent probe loops, each opening back-to-back fresh connections,
		// give dense temporal coverage so a sub-second gap can't slip between samples.
		const CONCURRENCY = 6;
		const loops = Array.from({ length: CONCURRENCY }, async () => {
			while (probing) {
				const result = await probe(host, port);
				if (result.ok) successes++;
				else failures.push(result);
			}
		});

		// Warm-up: a steady pool must serve cleanly before we touch anything.
		await sleep(750);
		ok(
			failures.length === 0,
			`baseline (pre-restart) saw ${failures.length} failed connections: ${summarize(failures)}`
		);
		const baselineSuccesses = successes;
		ok(baselineSuccesses > 0, 'probe loop produced no successful baseline connections — harness problem');

		// Trigger the rolling restart and keep probing across it. The operations request
		// is served by a worker that is itself restarted, so its response is best-effort;
		// we treat the worker count returning to WORKERS as the authoritative "done" signal.
		fetch(ctx.harper.operationsAPIURL, {
			method: 'POST',
			headers: { 'Authorization': authHeader(ctx), 'Content-Type': 'application/json' },
			body: JSON.stringify({ operation: 'restart_service', service: 'http_workers' }),
			signal: AbortSignal.timeout(90_000),
		}).catch(() => {
			/* response may not return if its handling worker is recycled — fine */
		});

		// Wait for the restart to fully complete: the pool is back to WORKERS and stays
		// there across consecutive checks. Requires a minimum elapsed time so we don't
		// declare victory before the restart has actually begun.
		const restartDeadline = Date.now() + 90_000;
		const minElapsed = Date.now() + 3_000;
		let stable = 0;
		while (Date.now() < restartDeadline) {
			await sleep(500);
			const count = await observedWorkerCount(ctx);
			if (count >= WORKERS && Date.now() > minElapsed) {
				if (++stable >= 3) break;
			} else {
				stable = 0;
			}
		}

		// Drain a final window so any late refused connection in the tail is captured.
		await sleep(1000);
		probing = false;
		await Promise.all(loops);

		const total = successes + failures.length;
		const refused = failures.filter((f) => f.code === 'ECONNREFUSED');

		// The core #1417 regression: ECONNREFUSED means *nothing was listening* on the port —
		// the pool went unavailable. A correct overlapping restart never lets that happen, so
		// this is a hard zero. (Pre-fix this fired in the hundreds.)
		ok(
			refused.length === 0,
			`rolling restart refused ${refused.length} of ${total} connections (ECONNREFUSED) — ` +
				`the pool went unavailable during the restart: ${summarize(failures)}`
		);

		// Closing a SO_REUSEPORT listener under load can still RST a few connections already
		// sitting in that socket's kernel accept queue — unavoidable and unrelated to availability.
		// Tolerate a tiny fraction of those (this synthetic load runs at thousands of conn/s; a real
		// client never approaches it), but fail if drops become gross — that would signal a real gap.
		const dropRate = failures.length / total;
		ok(
			dropRate < 0.01,
			`rolling restart dropped ${failures.length} of ${total} connections (${(dropRate * 100).toFixed(2)}%) — ` +
				`above the transient-reset tolerance: ${summarize(failures)}`
		);

		// Sanity: the pool came back and is serving.
		ok((await observedWorkerCount(ctx)) >= 2, 'worker pool did not recover after the rolling restart');
	});
});

function summarize(failures: ProbeResult[]): string {
	const byCode = new Map<string, number>();
	for (const f of failures) byCode.set(f.code ?? 'unknown', (byCode.get(f.code ?? 'unknown') ?? 0) + 1);
	return [...byCode.entries()].map(([code, n]) => `${code}×${n}`).join(', ') || 'none';
}
