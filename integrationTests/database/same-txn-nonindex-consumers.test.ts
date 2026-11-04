/**
 * Regression anchor for harper#1970 ("fix(txn): apply repeat writes to a key on top of the
 * earlier write in the same transaction", merged 2026-07-28) -- the NON-INDEX consumer of the
 * prior entry: blob unlink decisions.
 *
 * Before the fix, resources/LMDBTransaction.ts commit() read `existingEntry` for EVERY buffered
 * write of a same-key multi-write transaction from the pre-transaction snapshot, so write N+1
 * never saw write N as its prior. The visible symptom for the secondary index was #1968
 * (orphaned index entries). The same stale prior fed RecordEncoder's blob-unlink diff
 * (`deleteBlobsInObject(existingEntry.value, retainedFileIds)`): for a same-key chain
 * A (committed) -> B -> C written in ONE transaction, the second write diffed A->C instead of
 * B->C, so the intermediate blob B was never scheduled for reclamation and leaked as an orphan
 * file on LMDB. RocksDB's DatabaseTransaction reads the prior through the live transaction and
 * was already correct, which makes it the in-suite control.
 *
 * Invariant pinned, engine-independent: a same-transaction overwrite chain leaves exactly ONE
 * live blob file (the last write's), every superseded intermediate is reclaimed, the record reads
 * back as the LAST write, and an on-demand `cleanup_orphan_blobs` sweep leaves the live file
 * alone. The on-disk oracle walks {dataRootDir}/blobs/<db>/ directly; the table lives in its own
 * database so that tree holds exclusively this spec's files.
 *
 * The AUDIT consumer of the same stale prior (the last audit entry must reconstruct the record's
 * live value) is deliberately NOT asserted here: it is pinned by its own candidate (the QA-848
 * audit-mechanism spec), so that invariant appears in exactly one test.
 *
 * Runs on the default engine (RocksDB) and with HARPER_STORAGE_ENGINE=lmdb, the engine the fix
 * repaired.
 *
 * Fails-on-base: with #1970 absent, A2 goes red on LMDB (2 files survive after settle: C plus
 * the leaked intermediate B) and stays green on RocksDB.
 *
 * Originating QA scenario: QA-845 (promote candidate P-604).
 */
import { suite, test, before, after } from 'node:test';
import { ok, strictEqual } from 'node:assert';
import { resolve, join } from 'node:path';
import { readdir, stat } from 'node:fs/promises';
import { setTimeout as sleep } from 'node:timers/promises';
import { setupHarperWithFixture, teardownHarper, type ContextWithHarper } from '@harperfast/integration-testing';
// @ts-expect-error utils/client.mjs has no type declarations; runtime resolves fine
import { createApiClient } from '../apiTests/utils/client.mjs';

const FIXTURE_PATH = resolve(import.meta.dirname, 'same-txn-nonindex-consumers');
const SCHEMA = 'sametxnblob';
const BLOB_TABLE = 'BlobChain';
const ENGINE = process.env.HARPER_STORAGE_ENGINE === 'lmdb' ? 'lmdb' : 'rocksdb';
const HARPER_CONFIG = {
	logging: { console: true, level: 'error' },
	storage: { engine: ENGINE },
};
const skipSuite = process.platform === 'win32';

// Sizes are distinct per write so a surviving file can be attributed to the write that produced it.
const SIZE_A = 20000;
const SIZE_B = 20001;
const SIZE_C = 20002;

/** Recursively count files + bytes under a blob storage tree ({dataRootDir}/blobs/{db}/{p}/{p}/{fileId}). */
async function diskUsage(dir: string): Promise<{ files: number; bytes: number }> {
	let files = 0;
	let bytes = 0;
	async function walk(d: string) {
		let entries;
		try {
			entries = await readdir(d, { withFileTypes: true });
		} catch {
			return; // dir not created yet, or already removed
		}
		for (const e of entries) {
			const p = join(d, e.name);
			if (e.isDirectory()) await walk(p);
			else {
				try {
					bytes += (await stat(p)).size;
					files++;
				} catch {
					/* raced with unlink */
				}
			}
		}
	}
	await walk(dir);
	return { files, bytes };
}

/**
 * Wait for the blob directory's file count to settle: `stableTicks` consecutive unchanged reads,
 * sampled for at least `minMs` (superseded files are reclaimed after the blob retention window,
 * not instantly), bounded by `maxMs`.
 */
async function waitForDiskSettle(
	dir: string,
	{ minMs = 3000, maxMs = 10_000, tickMs = 250, stableTicks = 3 } = {}
): Promise<{ files: number; bytes: number }> {
	const started = Date.now();
	let last = await diskUsage(dir);
	let stableCount = 0;
	while (Date.now() - started < maxMs) {
		await sleep(tickMs);
		const next = await diskUsage(dir);
		if (next.files === last.files) stableCount++;
		else stableCount = 0;
		last = next;
		if (Date.now() - started >= minMs && stableCount >= stableTicks) break;
	}
	return last;
}

suite(
	`same-transaction overwrite chain reclaims every intermediate blob (#1970) [${ENGINE}]`,
	{ skip: skipSuite },
	(ctx: ContextWithHarper) => {
		let client: ReturnType<typeof createApiClient>;
		let httpURL: string;
		const findings: string[] = [];

		before(async () => {
			await setupHarperWithFixture(ctx, FIXTURE_PATH, { config: HARPER_CONFIG, env: {} });
			client = createApiClient(ctx.harper);
			httpURL = ctx.harper.httpURL;
			// Poll for route readiness (component is pre-installed; no restart needed).
			const deadline = Date.now() + 120_000;
			while (Date.now() < deadline) {
				try {
					const probe = await client.reqRest('/VerifyChain/').timeout(2000);
					if (probe.status !== 404) break;
				} catch {
					/* not ready yet */
				}
				await sleep(250);
			}
		});

		after(async () => {
			await teardownHarper(ctx);
			console.log(`\n=== same-txn blob chain findings [${ENGINE}] ===\n${findings.map((f) => '  ' + f).join('\n')}\n`);
		});

		function postJSON(path: string, body: unknown): Promise<Response> {
			return fetch(`${httpURL}${path}`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json', 'Authorization': client.headers.Authorization },
				body: JSON.stringify(body),
			});
		}

		async function opRaw(body: Record<string, unknown>): Promise<{ status: number; body: any }> {
			const res = await fetch(client.operationsURL, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json', 'Authorization': client.headers.Authorization },
				body: JSON.stringify(body),
				signal: AbortSignal.timeout(30_000),
			});
			const text = await res.text();
			let parsed: any;
			try {
				parsed = JSON.parse(text);
			} catch {
				parsed = text;
			}
			return { status: res.status, body: parsed };
		}

		/** Post-commit read of the record via a SEPARATE request (no read-your-writes inside the chain's transaction). */
		async function verifyChain(id: string): Promise<{ present: boolean; tag?: string; size?: number; sha?: string }> {
			const res = await fetch(`${httpURL}/VerifyChain/?table=${BLOB_TABLE}&id=${id}`, {
				headers: { Authorization: client.headers.Authorization },
			});
			strictEqual(res.status, 200, `VerifyChain(${id}) should return 200`);
			return res.json();
		}

		function blobDir() {
			return join(ctx.harper.dataRootDir, 'blobs', SCHEMA);
		}

		let chainShas: string[] = [];

		test('A1: seed blob A in its own transaction -> exactly 1 file on disk (arms the disk oracle)', async () => {
			const r = await postJSON('/Seed/', { table: BLOB_TABLE, id: 'chain-1', size: SIZE_A, seed: 'A', tag: 'A' });
			strictEqual(r.status, 200, `Seed should succeed: ${await r.text()}`);
			const usage = await diskUsage(blobDir());
			findings.push(`[A1] after seed A: ${usage.files} file(s), ${usage.bytes}B`);
			strictEqual(usage.files, 1, `expected exactly 1 blob file after the seed write, got ${usage.files}`);
			ok(usage.bytes >= SIZE_A, `the seed blob must be file-backed (${usage.bytes}B on disk < ${SIZE_A}B written)`);
		});

		test('A2: same-txn chain B->C (2 writes, 1 transaction) leaves exactly 1 live blob file and reads back as C', async () => {
			const r = await postJSON('/ChainWrite/', {
				table: BLOB_TABLE,
				id: 'chain-1',
				ops: [
					{ seed: 'B', size: SIZE_B, tag: 'B' },
					{ seed: 'C', size: SIZE_C, tag: 'C' },
				],
			});
			const chainBody = await r.text();
			strictEqual(r.status, 200, `ChainWrite should succeed: ${chainBody}`);
			chainShas = (JSON.parse(chainBody) as { shas: string[] }).shas;
			strictEqual(chainShas.length, 2, 'ChainWrite must report one sha per write');

			// Own-value correctness first: the record reflects the LAST write regardless of any
			// unlink bookkeeping, read through a separate post-commit request.
			const v = await verifyChain('chain-1');
			findings.push(`[A2] VerifyChain(chain-1): ${JSON.stringify(v)}`);
			ok(v.present, 'record must still be present and readable after the chain write');
			strictEqual(v.tag, 'C', 'record must reflect the LAST write (tag C)');
			strictEqual(v.size, SIZE_C, `record blob size must match C's write (${SIZE_C})`);
			strictEqual(v.sha, chainShas[1], "record blob content must be C's bytes");

			// Disk oracle: every superseded file (A, then the intermediate B) must be reclaimed once
			// the retention window drains, leaving only C.
			const settled = await waitForDiskSettle(blobDir());
			findings.push(`[A2 ${ENGINE}] settled after chain write: ${settled.files} file(s), ${settled.bytes}B`);
			strictEqual(
				settled.files,
				1,
				`expected exactly 1 surviving blob file (the last write, C) after a same-transaction overwrite chain, ` +
					`got ${settled.files} -- a leaked intermediate means the second write diffed its blobs against the ` +
					`stale pre-transaction prior instead of the earlier write in the same transaction (#1970)`
			);
		});

		test('A3: cleanup_orphan_blobs leaves the live file alone (nothing to reclaim, nothing wrongly reclaimed)', async () => {
			const cleanupRes = await opRaw({ operation: 'cleanup_orphan_blobs', database: SCHEMA });
			findings.push(`[A3] cleanup_orphan_blobs: status=${cleanupRes.status} body=${JSON.stringify(cleanupRes.body)}`);
			strictEqual(cleanupRes.status, 200, `cleanup_orphan_blobs must be accepted: ${JSON.stringify(cleanupRes.body)}`);

			const settled = await waitForDiskSettle(blobDir(), { minMs: 2000, maxMs: 8000 });
			findings.push(`[A3] post-sweep: ${settled.files} file(s), ${settled.bytes}B`);
			strictEqual(settled.files, 1, `the sweep must leave exactly the live file, got ${settled.files}`);

			const v = await verifyChain('chain-1');
			ok(v.present, 'record must survive the orphan sweep');
			strictEqual(v.tag, 'C', 'record must still reflect the LAST write after the sweep');
			strictEqual(
				v.sha,
				chainShas[1],
				'the surviving file must still be readable as C (the sweep did not take a live blob)'
			);
		});
	}
);
