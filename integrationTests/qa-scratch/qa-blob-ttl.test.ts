/**
 * QA-P281-TTL — Blob file lifecycle under TTL eviction (exploratory).
 *
 * Prior work (P-281) confirmed blob files are unlinked on explicit record
 * replace/delete. This test covers the UNTESTED corner: when a record expires
 * via TTL (@table(expiration: 5)), does the eviction scan also unlink the blob
 * FILE on disk, or is it orphaned?
 *
 * Probes:
 *  Q-RDB  RocksDB 4-worker TTL: 5 records × ~200KB blob each. After TTL eviction
 *         (rows gone), count remaining blob files. Expected: 0. Defect: >0.
 *
 *  Q-LMDB LMDB 4-worker TTL: same scenario. Expected: 0. Defect: >0.
 *
 *  Q-REPL Replace-then-expire: write v1, replace with v2 (old file should be
 *         unlinked on overwrite), let v2 TTL-expire. Counts: 0 expected; 1 = only
 *         the replace-unlink worked (eviction leak); 2 = both leaked.
 *
 * EXPLORATORY: hard-fail on confirmed blob orphan (file count > 0 after eviction
 * and a settling window). Log counts explicitly so the output is unambiguous.
 *
 * Reproduction:
 *   npm run build
 *   npm run test:integration -- "integrationTests/qa-scratch/qa-blob-ttl.test.ts"
 * Harper SHA: 1b45db9ea (main)
 */

import { suite, test, before, after } from 'node:test';
import { ok, strictEqual } from 'node:assert/strict';
import { resolve, join } from 'node:path';
import { readdir, stat } from 'node:fs/promises';
import { setTimeout as sleep } from 'node:timers/promises';
import request from 'supertest';
import { setupHarperWithFixture, teardownHarper, type ContextWithHarper } from '@harperfast/integration-testing';
// @ts-expect-error utils/client.mjs has no type declarations; runtime resolves fine
import { createApiClient } from '../apiTests/utils/client.mjs';

const FIXTURE_PATH = resolve(import.meta.dirname, 'qa-blob-ttl');

// TTL is 5s; eviction scan runs every 1.25s (cleanupInterval = expiration/4).
// On a loaded CI box the scan may lag; poll generously before concluding a record is gone.
const ROW_GONE_POLL_MS = 120_000;
const ROW_POLL_INTERVAL_MS = 500;

// After rows are gone, wait an additional margin for any async blob unlinks.
const BLOB_SETTLE_MS = Number(process.env.QA_BLOB_SETTLE_MS) || 5_000;

const skipSuite = process.platform === 'win32';

/** Recursively count files under a directory tree. */
async function countFiles(dir: string): Promise<number> {
	let count = 0;
	async function walk(d: string) {
		let entries;
		try {
			entries = await readdir(d, { withFileTypes: true });
		} catch {
			return; // dir not created yet
		}
		for (const e of entries) {
			if (e.isDirectory()) {
				await walk(join(d, e.name));
			} else {
				try {
					await stat(join(d, e.name));
					count++;
				} catch {
					// raced with unlink
				}
			}
		}
	}
	await walk(dir);
	return count;
}

/**
 * Poll until all N record IDs return 404 (row evicted), or throw after maxMs.
 * Returns the time elapsed.
 */
async function waitForRowsGone(
	httpURL: string,
	headers: Record<string, string>,
	ids: string[],
	maxMs: number
): Promise<number> {
	const start = Date.now();
	const deadline = start + maxMs;
	while (Date.now() < deadline) {
		const checks = await Promise.all(
			ids.map((id) =>
				fetch(`${httpURL}/BlobTtlTest/${id}`, { headers, signal: AbortSignal.timeout(3_000) })
					.then((r) => r.status)
					.catch(() => -1)
			)
		);
		if (checks.every((s) => s === 404)) return Date.now() - start;
		await sleep(ROW_POLL_INTERVAL_MS);
	}
	throw new Error(`Rows not evicted within ${maxMs}ms`);
}

/** Run one full TTL-eviction probe and return blob counts before/after. */
async function runProbe(
	ctx: ContextWithHarper,
	engine: string,
	blobDir: string,
	N: number
): Promise<{ beforeCount: number; afterCount: number; evictedMs: number }> {
	const client = createApiClient(ctx.harper);
	const httpURL = ctx.harper.httpURL;
	const headers = { ...client.headers, 'Content-Type': 'application/json' };

	// Readiness probe: wait until BlobTtlTest route is up.
	{
		const deadline = Date.now() + 60_000;
		while (Date.now() < deadline) {
			try {
				const r = await fetch(`${httpURL}/BlobTtlTest/`, {
					headers: { Authorization: client.headers['Authorization'] },
					signal: AbortSignal.timeout(3_000),
				});
				if (r.status !== 404) break;
			} catch {
				// not ready yet
			}
			await sleep(250);
		}
	}

	const ids = Array.from({ length: N }, (_, i) => `ttl-probe-${engine}-${i}`);

	// Insert N records with distinct blob seeds.
	for (const id of ids) {
		await request(httpURL)
			.post('/BlobTtlRes/')
			.set(headers)
			.send({ action: 'store', id, seed: id })
			.expect(200);
	}
	// Brief settle so all blob writes flush to disk.
	await sleep(1_000);

	const beforeCount = await countFiles(blobDir);

	// Wait for TTL eviction to remove all rows.
	const evictedMs = await waitForRowsGone(httpURL, headers, ids, ROW_GONE_POLL_MS);

	// Extra settling window for async blob file unlinks.
	await sleep(BLOB_SETTLE_MS);

	const afterCount = await countFiles(blobDir);

	return { beforeCount, afterCount, evictedMs };
}

// ── RocksDB 4-worker suite ──────────────────────────────────────────────────

suite('QA-P281-TTL blob file lifecycle [rocksdb 4-worker]', { skip: skipSuite }, (ctx: ContextWithHarper) => {
	const findings: string[] = [];
	let blobDir: string;
	const N = 5;

	before(async () => {
		await setupHarperWithFixture(ctx, FIXTURE_PATH, {
			config: { threads: { count: 4 } },
			env: {},
		});
		// Default blob root: {dataRootDir}/blobs/{databaseName}
		// The fixture's schema uses the default "data" database.
		blobDir = join(ctx.harper.dataRootDir, 'blobs', 'data');
	});

	after(async () => {
		await teardownHarper(ctx);
		console.log('\n[QA-P281-TTL rocksdb 4-worker] FINDINGS');
		for (const f of findings) console.log('  ' + f);
	});

	test('Q-RDB: blob files gone after TTL eviction', { timeout: 180_000 }, async () => {
		const { beforeCount, afterCount, evictedMs } = await runProbe(ctx, 'rocksdb', blobDir, N);
		findings.push(
			`RocksDB 4-worker: blobs before=${beforeCount}, after=${afterCount} (rows gone after ${evictedMs}ms)`
		);
		if (afterCount === 0) {
			findings.push('RocksDB VERDICT: blob files unlinked on TTL eviction (EXPECTED)');
		} else {
			findings.push(
				`RocksDB VERDICT: DEFECT — ${afterCount} blob file(s) orphaned after TTL eviction (expected 0)`
			);
		}
		console.log(`RocksDB 4-worker: blobs before=${beforeCount}, after=${afterCount}`);
		strictEqual(afterCount, 0, `RocksDB TTL eviction left ${afterCount} blob file(s) orphaned on disk`);
	});

	test('Q-REPL: replace-then-expire leaves 0 blob files', { timeout: 180_000 }, async () => {
		const client = createApiClient(ctx.harper);
		const httpURL = ctx.harper.httpURL;
		const headers = { ...client.headers, 'Content-Type': 'application/json' };
		const id = 'replace-then-expire-rocksdb';

		await request(httpURL)
			.post('/BlobTtlRes/')
			.set(headers)
			.send({ action: 'replace', id })
			.expect(200);

		// Wait for the replace-unlink to settle (~500ms deletionDelay).
		await sleep(2_000);
		const beforeEvict = await countFiles(blobDir);

		await waitForRowsGone(httpURL, headers, [id], ROW_GONE_POLL_MS);
		await sleep(BLOB_SETTLE_MS);

		const afterEvict = await countFiles(blobDir);

		findings.push(`Replace test (rocksdb): blobs after eviction=${afterEvict} (before eviction=${beforeEvict})`);
		console.log(`Replace test: blobs after eviction=${afterEvict} (expected 0)`);

		if (afterEvict === 0) {
			findings.push('Replace VERDICT: both old and replacement blob files cleaned up (EXPECTED)');
		} else if (afterEvict === 1) {
			findings.push('Replace VERDICT: 1 blob leaked — replace-unlink fired but TTL eviction did not unlink');
		} else {
			findings.push(`Replace VERDICT: DEFECT — ${afterEvict} blobs leaked (replace-unlink AND TTL eviction both failed)`);
		}
		strictEqual(afterEvict, 0, `Replace-then-expire left ${afterEvict} blob file(s) on disk`);
	});
});

// ── LMDB 4-worker suite ────────────────────────────────────────────────────

suite('QA-P281-TTL blob file lifecycle [lmdb 4-worker]', { skip: skipSuite }, (ctx: ContextWithHarper) => {
	const findings: string[] = [];
	let blobDir: string;
	const N = 5;

	before(async () => {
		await setupHarperWithFixture(ctx, FIXTURE_PATH, {
			config: { threads: { count: 4 } },
			env: { HARPER_STORAGE_ENGINE: 'lmdb' },
		});
		blobDir = join(ctx.harper.dataRootDir, 'blobs', 'data');
	});

	after(async () => {
		await teardownHarper(ctx);
		console.log('\n[QA-P281-TTL lmdb 4-worker] FINDINGS');
		for (const f of findings) console.log('  ' + f);
	});

	test('Q-LMDB: blob files gone after TTL eviction', { timeout: 180_000 }, async () => {
		const { beforeCount, afterCount, evictedMs } = await runProbe(ctx, 'lmdb', blobDir, N);
		findings.push(
			`LMDB 4-worker: blobs before=${beforeCount}, after=${afterCount} (rows gone after ${evictedMs}ms)`
		);
		if (afterCount === 0) {
			findings.push('LMDB VERDICT: blob files unlinked on TTL eviction (EXPECTED)');
		} else {
			findings.push(
				`LMDB VERDICT: DEFECT — ${afterCount} blob file(s) orphaned after TTL eviction (expected 0)`
			);
		}
		console.log(`LMDB 4-worker: blobs before=${beforeCount}, after=${afterCount}`);
		strictEqual(afterCount, 0, `LMDB TTL eviction left ${afterCount} blob file(s) orphaned on disk`);
	});
});
