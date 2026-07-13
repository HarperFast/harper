/**
 * Shared multi-worker helper for the record-caching integration tests.
 *
 * Harper does NOT honor a `HARPER_WORKER_COUNT` env var; worker count is set via
 * `config.threads.count`. Passing `env: { HARPER_WORKER_COUNT }` to setupHarperWithFixture
 * has no effect — the harness forces a single worker (`--THREADS_COUNT=1`), which silently
 * made the cross-worker cache-invalidation coverage vacuous. Read the env var here (so
 * `HARPER_WORKER_COUNT=N` still works from the CLI, matching read-snapshot-consistency.test.ts)
 * and translate it into config, then assert the running instance really has >1 worker so a
 * misconfiguration can't reduce these suites to a no-op again.
 */
import { ok } from 'node:assert';
import type { ContextWithHarper } from '@harperfast/integration-testing';

const parsedWorkerCount = Number(process.env.HARPER_WORKER_COUNT);
export const WORKER_COUNT = Number.isInteger(parsedWorkerCount) && parsedWorkerCount > 0 ? parsedWorkerCount : 4;

/**
 * Run `fn` over `items` with at most `limit` in flight at once. These suites issue fresh-
 * connection requests (no keep-alive) to spray across the worker pool; firing hundreds at
 * once via an unbounded Promise.all risks ephemeral-port/socket exhaustion on constrained CI
 * runners, so the large fan-outs (record creation, cache-warming) are bounded while the small
 * per-key bursts stay concurrent (that concurrency is the point of the cross-worker check).
 */
export async function mapBounded<T, R>(
	items: readonly T[],
	limit: number,
	fn: (item: T, index: number) => Promise<R>
): Promise<R[]> {
	const results = new Array<R>(items.length);
	let next = 0;
	async function worker(): Promise<void> {
		while (next < items.length) {
			const i = next++;
			results[i] = await fn(items[i], i);
		}
	}
	await Promise.all(Array.from({ length: Math.min(limit, items.length) }, () => worker()));
	return results;
}

/** Number of HTTP worker threads the running instance reports via system_information. */
export async function observedWorkerCount(ctx: ContextWithHarper): Promise<number> {
	const res = await fetch(ctx.harper.operationsAPIURL, {
		method: 'POST',
		headers: {
			'Authorization': `Basic ${Buffer.from(`${ctx.harper.admin.username}:${ctx.harper.admin.password}`).toString('base64')}`,
			'Content-Type': 'application/json',
		},
		body: JSON.stringify({ operation: 'system_information', attributes: ['threads'] }),
	});
	const body = (await res.json()) as { threads?: unknown };
	return Array.isArray(body.threads) ? body.threads.length : 0;
}

/** Fail loudly if the instance is running a single worker (cross-worker coverage would be vacuous). */
export async function assertMultiWorker(ctx: ContextWithHarper): Promise<void> {
	const count = await observedWorkerCount(ctx);
	ok(count >= 2, `expected >= 2 HTTP workers for cross-worker coverage, observed ${count} — suite would be vacuous`);
}
