/**
 * Same-transaction write chains: several writes to one key inside ONE transaction must each apply
 * on top of the previous one (#1968, fixed by #1970). Before that fix, LMDB diffed every write in
 * the chain against the pre-transaction record, which broke the consumers asserted here:
 *
 *   1. A PATCH's merge base. Write 1 sets `a`, write 2 sets `b`; write 2 filled `a` from the
 *      pre-transaction record, so `a` reverted, and the `@indexed @computed` `sum` was indexed
 *      from the wrong record.
 *   2. Blob reclamation. Each write unlinks the blob of the record it replaces; diffing against the
 *      pre-transaction record orphaned every intermediate blob, one leaked file per extra write in
 *      the chain.
 *   3. A chain whose row another request committed to while the chain's transaction was open. The
 *      chain then committed its intermediate state (LOCKED) as the record.
 *
 * Every suite forces its engine through HARPER_STORAGE_ENGINE and asserts it took effect: the CI
 * integration workflow sets no engine, and LMDB is the engine the fix repaired. RocksDB was already
 * correct and runs as the second engine.
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

// above the 8 KiB threshold, so every blob is file-backed
const BLOB_SIZES = { A: 15000, B: 15001, C: 15002, D: 15003 };

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
					// unlinked by reclamation between readdir and stat
					if (err?.code !== 'ENOENT') throw err;
				}
			}
		}
	}
	await walk(dir);
	return n;
}

/**
 * Wait until `countFiles(dir)` reaches `expected`, or has not changed for `minStableMs` (longer than
 * the blob retention window, so a file still waiting out retention is not reported as a leak), or
 * `timeoutMs` runs out.
 */
async function waitForFileCount(
	dir: string,
	expected: number,
	{ timeoutMs = 20_000, intervalMs = 250, minStableMs = 6_000 } = {}
): Promise<{ count: number; timedOut: boolean; waitedMs: number }> {
	const start = Date.now();
	let count = await countFiles(dir);
	let stableSince = start;
	while (count !== expected && Date.now() - start < timeoutMs && Date.now() - stableSince < minStableMs) {
		await sleep(intervalMs);
		const next = await countFiles(dir);
		if (next !== count) stableSince = Date.now();
		count = next;
	}
	return { count, timedOut: Date.now() - start >= timeoutMs, waitedMs: Date.now() - start };
}

for (const engine of ENGINES) {
	suite(`same-transaction write chain [${engine}]`, { skip: skipSuite }, (ctx: ContextWithHarper) => {
		let client: ReturnType<typeof createApiClient>;
		let httpURL: string;

		before(async () => {
			await setupHarperWithFixture(ctx, FIXTURE_PATH, {
				// arm 3's handshake lives in one worker's memory
				config: { threads: { count: 1 } },
				env: { HARPER_STORAGE_ENGINE: engine },
			});
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

		test('1: a PATCH chain splitting fields across writes keeps both, and indexes @computed from both', async () => {
			await postOk('/ComputedSeed/', { id: 'comp-1', a: 1, b: 1 });
			await postOk('/ComputedChainWrite/', { id: 'comp-1', ops: [{ a: 100 }, { b: 200 }] });

			const v = await getJSON('/VerifyComputed/?id=comp-1');
			ok(v.present, 'record must be present');
			// sums of the seed (2), write 1 alone (101), write 2 on the pre-transaction record (201), final (300)
			const indexedBySum: Record<number, string[]> = {};
			for (const sum of [2, 101, 201, 300]) indexedBySum[sum] = (await getJSON(`/ComputedBySum/?sum=${sum}`)).ids;
			deepStrictEqual(
				{ record: { a: v.a, b: v.b, sum: v.sum }, indexedBySum },
				{ record: { a: 100, b: 200, sum: 300 }, indexedBySum: { 2: [], 101: [], 201: [], 300: ['comp-1'] } },
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
				settled.count,
				1,
				`expected only D's file after A, B and C were superseded; ${settled.count - 1} superseded ` +
					`blob file(s) remain after ${settled.waitedMs}ms (${settled.timedOut ? 'timed out' : 'count stopped changing'})`
			);

			const v = await getJSON('/VerifyBlobChain/?id=blob-1');
			ok(v.present, 'record must be present');
			strictEqual(v.tag, 'D');
			strictEqual(v.size, BLOB_SIZES.D);
			strictEqual(v.sha, shas[2], "the surviving blob must hold D's bytes");
		});

		test('3: a chain whose row another request commits to while it is open never commits its intermediate', async () => {
			await postOk('/WorkflowSeed/', { id: 'wf-1' });

			const chain = post('/TwoStepWrite/', { id: 'wf-1', owner: 'chain', maxWaitMs: 15_000 }).catch((error) => ({
				status: 0,
				body: String(error),
			}));
			const deadline = Date.now() + 10_000;
			while (!(await getJSON('/TwoStepState/?id=wf-1')).staged) {
				ok(Date.now() < deadline, 'the chain never staged its first write');
				await sleep(10);
			}
			// commit other writes to the row while the chain's transaction is open between its two writes
			const writers = await Promise.all(
				Array.from({ length: 5 }, (_, i) =>
					post('/SingleStepWrite/', { id: 'wf-1', newStatus: `WRITER_${i}`, owner: `writer_${i}` })
				)
			);
			strictEqual((await postOk('/TwoStepRelease/', { id: 'wf-1' })).released, true);
			const chainResult = await chain;
			const results = JSON.stringify({ chain: chainResult, writers });

			deepStrictEqual(chainResult, { status: 200, body: { won: true, released: true } }, results);
			ok(
				writers.some((w) => w.status === 200 && w.body?.won === true),
				`no writer committed while the chain was open: ${results}`
			);
			ok(
				writers.every((w) => w.body?.seenStatus !== 'LOCKED'),
				`a writer read the chain's uncommitted LOCKED: ${results}`
			);
			// Which of the chain and the writers wins is engine ordering (LMDB stamps a transaction at commit,
			// RocksDB at its start), not what this arm pins: the committed record is one whole write's
			// result, never the chain's intermediate.
			const candidates = [{ status: 'DONE', seq: 2, owner: 'chain' }];
			writers.forEach((w, i) => {
				if (w.body?.won !== false) candidates.push({ status: `WRITER_${i}`, seq: 1, owner: `writer_${i}` });
			});
			const final = await getJSON('/VerifyWorkflow/?id=wf-1');
			const committed = { status: final.status, seq: final.seq, owner: final.owner };
			ok(
				candidates.some((c) => JSON.stringify(c) === JSON.stringify(committed)),
				`committed ${JSON.stringify(committed)} is not one write's result; ${results}`
			);
		});
	});
}
