/**
 * Same-transaction write chains: several writes to one key inside ONE transaction must each apply
 * on top of the previous one (#1968, fixed by #1970). Before that fix, LMDB diffed every write in
 * the chain against the pre-transaction record, which broke two consumers asserted here:
 *
 *   1. A PATCH's merge base. Write 1 sets `a`, write 2 sets `b`; write 2 filled `a` from the
 *      pre-transaction record, so `a` reverted and the `@computed` `sum` derived from it was wrong
 *      (a=1 b=200 sum=201 instead of a=100 b=200 sum=300).
 *   2. Blob reclamation. Each write unlinks the blob of the record it replaces; diffing against the
 *      pre-transaction record orphaned every intermediate blob, one leaked file per extra write in
 *      the chain (3 files instead of 1 for a 3-write chain).
 *
 * Arm 3 races a 2-write chain (A -> LOCKED -> DONE) against single-step writers moving the same row
 * out of A. The chain's intermediate LOCKED must never be the committed state.
 *
 * Every suite forces its engine through HARPER_STORAGE_ENGINE and asserts it took effect: the CI
 * integration workflow sets no engine, and LMDB is the engine the fix repaired. RocksDB was already
 * correct and runs as the second engine.
 *
 * Fails on base: against 80ef45996 (the parent of #1970's first commit, rebuilt), the LMDB suite
 * fails the @computed and blob-chain arms; the RocksDB suite passes.
 *
 * Originating QA scenario: QA-849 (promote candidate P-609).
 */
import { suite, test, before, after } from 'node:test';
import { ok, strictEqual, deepStrictEqual } from 'node:assert';
import { resolve, join } from 'node:path';
import { readdir, stat } from 'node:fs/promises';
import { setTimeout as sleep } from 'node:timers/promises';
import { setupHarperWithFixture, teardownHarper, type ContextWithHarper } from '@harperfast/integration-testing';
// @ts-expect-error utils/client.mjs has no type declarations; runtime resolves fine
import { createApiClient } from '../apiTests/utils/client.mjs';

const FIXTURE_PATH = resolve(import.meta.dirname, 'same-txn-write-chain');
const DATABASE = 'sametxnchain';
const ENGINES = ['lmdb', 'rocksdb'] as const;
const skipSuite = process.platform === 'win32';

// Distinct sizes, all above the 8 KiB threshold so every blob is file-backed.
const BLOB_SIZES = { A: 15000, B: 15001, C: 15002, D: 15003 };

/** Recursively count files under a blob storage tree ({dataRootDir}/blobs/{db}/...). */
async function countFiles(dir: string): Promise<number> {
	let n = 0;
	async function walk(d: string) {
		let entries;
		try {
			entries = await readdir(d, { withFileTypes: true });
		} catch (err: any) {
			if (err?.code === 'ENOENT') return;
			throw err;
		}
		for (const e of entries) {
			const p = join(d, e.name);
			if (e.isDirectory()) await walk(p);
			else {
				try {
					await stat(p);
					n++;
				} catch (err: any) {
					if (err?.code !== 'ENOENT') throw err;
				}
			}
		}
	}
	await walk(dir);
	return n;
}

/**
 * Wait until `countFiles(dir)` reaches `expected`, or the count has not changed for `minStableMs`
 * (longer than the blob retention window, so superseded files that are merely waiting out retention
 * are not mistaken for leaks), or `timeoutMs` runs out.
 */
async function waitForFileCount(
	dir: string,
	expected: number,
	{ timeoutMs = 20_000, intervalMs = 250, minStableMs = 6_000 } = {}
): Promise<number> {
	const deadline = Date.now() + timeoutMs;
	let cur = await countFiles(dir);
	let stableSince = Date.now();
	while (cur !== expected && Date.now() < deadline && Date.now() - stableSince < minStableMs) {
		await sleep(intervalMs);
		const next = await countFiles(dir);
		if (next !== cur) stableSince = Date.now();
		cur = next;
	}
	return cur;
}

for (const engine of ENGINES) {
	suite(`same-transaction write chain [${engine}]`, { skip: skipSuite }, (ctx: ContextWithHarper) => {
		let client: ReturnType<typeof createApiClient>;
		let httpURL: string;

		before(async () => {
			await setupHarperWithFixture(ctx, FIXTURE_PATH, { env: { HARPER_STORAGE_ENGINE: engine } });
			client = createApiClient(ctx.harper);
			httpURL = ctx.harper.httpURL;
			const deadline = Date.now() + 60_000;
			while (Date.now() < deadline) {
				try {
					if ((await get('/StorageEngineInfo/')).status === 200) return;
				} catch {
					/* not ready yet */
				}
				await sleep(250);
			}
			throw new Error('StorageEngineInfo route never became ready within 60s');
		});

		after(async () => {
			await teardownHarper(ctx);
		});

		function get(path: string): Promise<Response> {
			return fetch(`${httpURL}${path}`, {
				headers: { Authorization: client.headers.Authorization },
				signal: AbortSignal.timeout(30_000),
			});
		}

		async function getJSON(path: string): Promise<any> {
			const res = await get(path);
			const text = await res.text();
			strictEqual(res.status, 200, `GET ${path} failed: ${text}`);
			return JSON.parse(text);
		}

		async function post(path: string, body: unknown): Promise<{ status: number; body: any }> {
			const res = await fetch(`${httpURL}${path}`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json', 'Authorization': client.headers.Authorization },
				body: JSON.stringify(body),
				signal: AbortSignal.timeout(30_000),
			});
			const text = await res.text();
			let parsed: any = text;
			try {
				parsed = JSON.parse(text);
			} catch {
				/* not JSON; keep the text for the assertion message */
			}
			return { status: res.status, body: parsed };
		}

		async function postOk(path: string, body: unknown): Promise<any> {
			const r = await post(path, body);
			strictEqual(r.status, 200, `POST ${path} failed: ${JSON.stringify(r.body)}`);
			return r.body;
		}

		test('0: the requested storage engine is the one in effect', async () => {
			const info = await getJSON('/StorageEngineInfo/');
			strictEqual(info.engine, engine, `engine in effect: ${JSON.stringify(info)}`);
		});

		test('1: a PATCH chain splitting fields across writes keeps both, and @computed derives from both', async () => {
			await postOk('/ComputedSeed/', { id: 'comp-1', a: 1, b: 1 });
			await postOk('/ComputedChainWrite/', { id: 'comp-1', ops: [{ a: 100 }, { b: 200 }] });

			const v = await getJSON('/VerifyComputed/?id=comp-1');
			ok(v.present, 'record must be present');
			deepStrictEqual(
				{ a: v.a, b: v.b, sum: v.sum },
				{ a: 100, b: 200, sum: 300 },
				'write 2 must merge onto write 1; a=1 means it merged onto the pre-transaction record'
			);
		});

		test('2: a 3-write blob chain reclaims every superseded blob, leaving only the last', async () => {
			const blobDir = join(ctx.harper.dataRootDir, 'blobs', DATABASE);
			await postOk('/BlobSeed/', { id: 'blob-1', seed: 'A', size: BLOB_SIZES.A, tag: 'A' });
			strictEqual(await countFiles(blobDir), 1, 'the seed write must produce exactly one blob file');

			const { shas } = await postOk('/BlobChainWrite/', {
				id: 'blob-1',
				ops: (['B', 'C', 'D'] as const).map((tag) => ({ seed: tag, size: BLOB_SIZES[tag], tag })),
			});
			strictEqual(shas.length, 3);

			const settled = await waitForFileCount(blobDir, 1);
			strictEqual(
				settled,
				1,
				`expected only D's file after A, B and C were superseded; ${settled - 1} superseded blob file(s) leaked`
			);

			const v = await getJSON('/VerifyBlobChain/?id=blob-1');
			ok(v.present, 'record must be present');
			strictEqual(v.tag, 'D');
			strictEqual(v.size, BLOB_SIZES.D);
			strictEqual(v.sha, shas[2], "the surviving blob must hold D's bytes");
		});

		test('3: a 2-write chain racing single-step writers never commits its intermediate state', async () => {
			const WRITERS = 5;
			await postOk('/CasSeed/', { id: 'cas-1' });

			const chain = post('/CasChainSlow/', { id: 'cas-1', owner: 'chain', delayMs: 500 });
			// land the racing writers while the chain's transaction is open between its two writes
			await sleep(100);
			const writers = await Promise.all(
				Array.from({ length: WRITERS }, (_, i) =>
					post('/CasAttempt/', { id: 'cas-1', newStatus: `WRITER_${i}`, owner: `writer_${i}` })
				)
			);
			const chainResult = await chain;
			const results = JSON.stringify({ chain: chainResult, writers });

			const final = await getJSON('/VerifyCas/?id=cas-1');
			ok(final.present, 'record must be present');
			// DONE (the chain committed last) or the status of a writer that may have committed; only a
			// writer that answered won:false (it saw the row already moved) is known not to have written
			const endStates = new Set(['DONE']);
			writers.forEach((w, i) => {
				if (!(w.status === 200 && w.body?.won === false)) endStates.add(`WRITER_${i}`);
			});
			ok(
				endStates.has(final.status),
				`final status ${final.status} is not a committed end state (${[...endStates]}); ${results}`
			);
			if (final.status === 'DONE') {
				deepStrictEqual({ seq: final.seq, owner: final.owner }, { seq: 2, owner: 'chain' });
			}
		});
	});
}
