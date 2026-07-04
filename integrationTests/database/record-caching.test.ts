/**
 * PrimaryRocksDatabase record-caching integration tests.
 * Exercises cache invalidation correctness, write-then-read under load, and
 * rapid write-read-write cycles at the HTTP/REST layer with multi-worker Harper.
 * Skipped on LMDB (PrimaryRocksDatabase is RocksDB-only).
 */
import { suite, test, before, after } from 'node:test';
import { strictEqual } from 'node:assert/strict';
import { resolve } from 'node:path';
import { setupHarperWithFixture, teardownHarper, type ContextWithHarper } from '@harperfast/integration-testing';
// @ts-expect-error no type declarations
import { createApiClient } from './../apiTests/utils/client.mjs';
import { setTimeout as sleep } from 'node:timers/promises';

const FIXTURE_PATH = resolve(import.meta.dirname, 'record-caching');
const SKIP = process.env.HARPER_STORAGE_ENGINE === 'lmdb';

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

suite('record-caching [rocksdb] 4-worker', { skip: SKIP || process.platform === 'win32' }, (ctx: ContextWithHarper) => {
	let httpURL: string;
	let authHeader: string;

	before(async () => {
		await setupHarperWithFixture(ctx, FIXTURE_PATH, {
			config: { logging: { console: true, level: 'error' } },
			env: { HARPER_WORKER_COUNT: '4' },
		});
		const client = createApiClient(ctx.harper);
		httpURL = ctx.harper.httpURL;
		authHeader = client.headers.Authorization;
		await waitForTable(httpURL, authHeader);
	});

	after(async () => {
		await teardownHarper(ctx);
	});

	test('S1 cache invalidation: write→GET(warm)→PUT→GET must return updated value', async () => {
		const id = 's1-record';
		await putRecord(httpURL, authHeader, id, 'original', 1);
		const first = await getRecord(httpURL, authHeader, id);
		strictEqual(first?.name, 'original', 'first GET should return original value');

		await putRecord(httpURL, authHeader, id, 'updated', 2);
		const second = await getRecord(httpURL, authHeader, id);
		strictEqual(second?.name, 'updated', 'GET after PUT must not return stale cached value');
		strictEqual(second?.counter, 2, 'counter must reflect the update');
	});

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
