/**
 * PrimaryRocksDatabase record-caching integration tests.
 * Exercises cache invalidation correctness, write-then-read under load, and
 * rapid write-read-write cycles at the HTTP/REST layer with multi-worker Harper.
 *
 * S1 reads through CacheRecordOnWorker (record-caching/resources.js) until every configured worker
 * has answered (utils/connectionPerRequest.ts): each worker holds its own cache, and a plain REST
 * GET cannot say which one served it. S2 keeps its own 200-wide fan-out, which already spreads
 * across the pool.
 *
 * Skipped on LMDB (PrimaryRocksDatabase is RocksDB-only).
 */
import { suite, test, before, after } from 'node:test';
import { strictEqual } from 'node:assert';
import { resolve } from 'node:path';
import { setupHarperWithFixture, teardownHarper, type ContextWithHarper } from '@harperfast/integration-testing';
// @ts-expect-error no type declarations
import { createApiClient } from './../apiTests/utils/client.mjs';
import { setTimeout as sleep } from 'node:timers/promises';
import {
	WORKER_COUNT,
	assertEveryWorkerStarted,
	NO_FULL_WORKER_COVERAGE,
	NO_MULTI_WORKER_HTTP,
} from './recordCachingWorkers.ts';
import { fetchOnNewConnection, observeEveryWorker } from '../utils/connectionPerRequest.ts';

const FIXTURE_PATH = resolve(import.meta.dirname, 'record-caching');
const SKIP = process.env.HARPER_STORAGE_ENGINE === 'lmdb';

interface Rec {
	id: string;
	name: string;
	counter: number;
}

interface WorkerCacheView {
	threadId: number;
	exists: boolean;
	/** The per-worker cache entry a point-GET consults. */
	cached: Rec | null;
	/** The same id through Table's read semantics on that worker. */
	read: Rec | null;
}

async function readCacheOnWorker(httpURL: string, authHeader: string, id: string): Promise<WorkerCacheView> {
	const r = await fetchOnNewConnection(`${httpURL}/CacheRecordOnWorker/?id=${encodeURIComponent(id)}`, {
		headers: { Authorization: authHeader },
	});
	if (r.status !== 200) throw new Error(`CacheRecordOnWorker ${id} returned ${r.status}`);
	return r.json() as Promise<WorkerCacheView>;
}

function readCacheOnEveryWorker(httpURL: string, authHeader: string, id: string): Promise<WorkerCacheView[]> {
	return observeEveryWorker(
		() => readCacheOnWorker(httpURL, authHeader, id),
		(view) => view.threadId,
		{
			workerCount: WORKER_COUNT,
		}
	);
}

async function putRecord(
	httpURL: string,
	authHeader: string,
	id: string,
	name: string,
	counter: number
): Promise<void> {
	const r = await fetch(`${httpURL}/CacheRecord/${encodeURIComponent(id)}`, {
		method: 'PUT',
		headers: { 'Content-Type': 'application/json', 'Authorization': authHeader },
		body: JSON.stringify({ id, name, counter }),
	});
	if (r.status !== 200 && r.status !== 201 && r.status !== 204) {
		throw new Error(`PUT ${id} returned ${r.status}`);
	}
}

async function getRecord(
	httpURL: string,
	authHeader: string,
	id: string
): Promise<{ id: string; name: string; counter: number } | null> {
	const r = await fetch(`${httpURL}/CacheRecord/${encodeURIComponent(id)}`, {
		headers: { Authorization: authHeader },
	});
	if (r.status === 404) return null;
	if (r.status !== 200) throw new Error(`GET ${id} returned ${r.status}`);
	return r.json() as Promise<{ id: string; name: string; counter: number }>;
}

async function waitForTable(httpURL: string, authHeader: string): Promise<void> {
	const deadline = Date.now() + 60_000;
	while (Date.now() < deadline) {
		try {
			const r = await fetch(`${httpURL}/CacheRecord/probe`, { headers: { Authorization: authHeader } });
			// 404 = route registered, record just doesn't exist; any non-5xx means server is up
			if (r.status < 500) return;
		} catch {
			/* not ready yet */
		}
		await sleep(200);
	}
}

// ── Scenario 1 & 2: 4-worker cache invalidation + load ──────────────────────

suite('record-caching [rocksdb] 4-worker', { skip: SKIP || NO_MULTI_WORKER_HTTP }, (ctx: ContextWithHarper) => {
	let httpURL: string;
	let authHeader: string;

	before(async () => {
		await setupHarperWithFixture(ctx, FIXTURE_PATH, {
			config: { logging: { console: true, level: 'error' }, threads: { count: WORKER_COUNT } },
		});
		const client = createApiClient(ctx.harper);
		httpURL = ctx.harper.httpURL;
		authHeader = client.headers.Authorization;
		await waitForTable(httpURL, authHeader);
		await assertEveryWorkerStarted(ctx);
	});

	after(async () => {
		await teardownHarper(ctx);
	});

	test(
		'S1 cache invalidation: a PUT must not leave a stale cached value on ANY worker',
		{ skip: NO_FULL_WORKER_COVERAGE },
		async () => {
			const id = 's1-record';
			await putRecord(httpURL, authHeader, id, 'original', 1);

			// Warm every worker's cache, so the update below has a stale entry to invalidate everywhere.
			for (const view of await readCacheOnEveryWorker(httpURL, authHeader, id)) {
				strictEqual(view.cached?.name, 'original', `worker ${view.threadId} did not warm with the original value`);
			}

			await putRecord(httpURL, authHeader, id, 'updated', 2);

			const first = await getRecord(httpURL, authHeader, id);
			strictEqual(first?.name, 'updated', 'GET after PUT must not return stale cached value');
			strictEqual(first?.counter, 2, 'counter must reflect the update');

			for (const view of await readCacheOnEveryWorker(httpURL, authHeader, id)) {
				strictEqual(view.cached?.name, 'updated', `worker ${view.threadId} still caches a stale name`);
				strictEqual(view.cached?.counter, 2, `worker ${view.threadId} still caches a stale counter`);
				strictEqual(view.read?.name, 'updated', `worker ${view.threadId} still reads a stale name through Table`);
				strictEqual(view.read?.counter, 2, `worker ${view.threadId} still reads a stale counter through Table`);
			}
		}
	);

	test(
		'S2 write-then-read under load: 50 records × 200 reads all return correct values',
		{ timeout: 60_000 },
		async () => {
			const COUNT = 50;
			const READS = 200;

			// Seed 50 records
			await Promise.all(
				Array.from({ length: COUNT }, (_, i) => putRecord(httpURL, authHeader, `s2-rec-${i}`, `name-${i}`, i))
			);

			// 200 reads cycling through the 50 ids
			const errors: string[] = [];
			await Promise.all(
				Array.from({ length: READS }, async (_, i) => {
					const idx = i % COUNT;
					const rec = await getRecord(httpURL, authHeader, `s2-rec-${idx}`);
					if (rec?.name !== `name-${idx}`) {
						errors.push(`s2-rec-${idx}: expected name-${idx}, got ${rec?.name}`);
					}
					if (rec?.counter !== idx) {
						errors.push(`s2-rec-${idx}: expected counter=${idx}, got ${rec?.counter}`);
					}
				})
			);

			strictEqual(errors.length, 0, `Read errors:\n${errors.slice(0, 10).join('\n')}`);
		}
	);
});

// ── Scenario 3: single-worker rapid write-read-write cycles ─────────────────

suite(
	'record-caching [rocksdb] single-worker',
	{ skip: SKIP || process.platform === 'win32' },
	(ctx: ContextWithHarper) => {
		let httpURL: string;
		let authHeader: string;

		before(async () => {
			await setupHarperWithFixture(ctx, FIXTURE_PATH, {
				config: { logging: { console: true, level: 'error' } },
				env: {},
			});
			const client = createApiClient(ctx.harper);
			httpURL = ctx.harper.httpURL;
			authHeader = client.headers.Authorization;
			await waitForTable(httpURL, authHeader);
		});

		after(async () => {
			await teardownHarper(ctx);
		});

		test(
			'S3 rapid write-read-write: each PUT immediately visible via GET (30 iterations)',
			{ timeout: 60_000 },
			async () => {
				const id = 's3-record';
				for (let i = 0; i < 30; i++) {
					await putRecord(httpURL, authHeader, id, `iter-${i}`, i);
					const rec = await getRecord(httpURL, authHeader, id);
					strictEqual(rec?.name, `iter-${i}`, `iteration ${i}: GET returned stale name`);
					strictEqual(rec?.counter, i, `iteration ${i}: GET returned stale counter`);
				}
			}
		);
	}
);
