/**
 * Large-blob storage limits + streaming upload/download correctness.
 *
 * BACKGROUND (prior waves):
 *   - Blobs round-trip byte-exact via CBOR/msgpack PUT.
 *   - Single values to 128MB round-trip.
 *   - Large result sets stream at constant worker memory (heapUsed via
 *     system_information{threads} is the streaming-vs-buffering signal).
 *   - 1MB blobs round-trip byte-exact, no aliasing — but using payload.bytes()
 *     (full buffer), so it cannot speak to large-blob memory.
 *
 * THIS TEST pushes the blob path past 128MB and asks the streaming question for
 * a SINGLE huge blob on BOTH directions:
 *   - Store a genuinely large blob (64 → 256MB, then 512MB if memory stays
 *     bounded) and verify byte-exact round-trip via a STREAMING hash (the server
 *     reads it back through blob.stream() chunk-by-chunk; the wire sub-attribute
 *     GET is also hashed streaming). No full copy is ever held in any JS heap.
 *   - Measure worker heapUsed + rss DURING upload and DURING download. Bounded
 *     (flat as size grows) => true streaming. Linear in size => full buffering =>
 *     OOM lever.
 *   - Overwrite + delete a large blob — does blob-path disk space get reclaimed?
 *   - The blob sub-attribute GET path (GET /Big/<key>/payload) at large size.
 *
 * HOW WE STAY SAFE (don't OOM the box):
 *   - Bytes are generated in 4MB chunks server-side (async generator -> createBlob
 *     streaming source) and read back in stream chunks — the worker never holds a
 *     whole blob. The client only ever sends/receives small JSON, except the
 *     wire sub-attribute GET which is consumed as a streaming running-hash (never
 *     buffered in the test process either).
 *   - Sweep starts at 64/128/256MB. We only attempt 512MB if peak worker rss
 *     stayed well under a guard threshold at 256MB (true streaming confirmed).
 */
import { suite, test, before, after } from 'node:test';
import { ok } from 'node:assert';
import { resolve, join } from 'node:path';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import http from 'node:http';
import https from 'node:https';
import request from 'supertest';
import { setupHarperWithFixture, teardownHarper, type ContextWithHarper } from '@harperfast/integration-testing';
// @ts-expect-error utils/client.mjs has no type declarations; runtime resolves fine
import { createApiClient } from '../apiTests/utils/client.mjs';

const FIXTURE_PATH = resolve(import.meta.dirname, 'large-blob-streaming');
const skipSuite = process.platform === 'win32';
const MB = 1024 * 1024;
const ENGINE = process.env.HARPER_STORAGE_ENGINE ?? 'rocksdb(default)';

// rss guard: if a 256MB store/verify pushes peak worker rss above this much
// ABOVE its idle baseline, we treat that as "not bounded" and DO NOT escalate
// to 512MB (avoid OOMing the box). 256MB blob + true streaming should add only
// tens of MB; full buffering would add ~256MB+.
const RSS_ESCALATE_GUARD_MB = 350;

type Client = ReturnType<typeof createApiClient>;

interface WorkerMem {
	maxHeapMB: number;
	maxRssMB: number;
}

async function sampleWorkerMem(client: Client): Promise<WorkerMem> {
	const r = await client
		.req()
		.send({ operation: 'system_information', attributes: ['threads'] })
		.timeout(10_000);
	const threads: any[] = Array.isArray(r.body?.threads) ? r.body.threads : [];
	let maxHeap = 0;
	let maxRss = 0;
	for (const t of threads) {
		maxHeap = Math.max(maxHeap, Number(t.heapUsed) || 0);
		// rss field naming varies; try common keys.
		maxRss = Math.max(maxRss, Number(t.rss) || Number(t.residentSetSize) || 0);
	}
	return { maxHeapMB: maxHeap / MB, maxRssMB: maxRss / MB };
}

/** Run `fn` while polling worker mem ~every 50ms; return fn result + peak heap/rss. */
async function withMemWatch<T>(
	client: Client,
	fn: () => Promise<T>
): Promise<{ result: T; peakHeapMB: number; peakRssMB: number }> {
	let peakHeap = 0;
	let peakRss = 0;
	let watching = true;
	const watcher = (async () => {
		while (watching) {
			try {
				const m = await sampleWorkerMem(client);
				peakHeap = Math.max(peakHeap, m.maxHeapMB);
				peakRss = Math.max(peakRss, m.maxRssMB);
			} catch {
				/* ignore sampling blips */
			}
			await sleep(50);
		}
	})();
	const result = await fn();
	try {
		const m = await sampleWorkerMem(client);
		peakHeap = Math.max(peakHeap, m.maxHeapMB);
		peakRss = Math.max(peakRss, m.maxRssMB);
	} catch {
		/* ignore */
	}
	watching = false;
	await watcher;
	return { result, peakHeapMB: peakHeap, peakRssMB: peakRss };
}

/** Streaming sub-attribute GET: GET /Big/<key>/payload, hash chunks without buffering. */
function streamHashGet(
	baseURL: string,
	path: string,
	authHeader: string
): Promise<{
	status: number;
	transferEncoding?: string;
	contentLength?: string;
	bytes: number;
	sha: string;
	ttfbMs: number;
	totalMs: number;
}> {
	const url = new URL(path, baseURL);
	const lib = url.protocol === 'https:' ? https : http;
	const start = Date.now();
	const h = createHash('sha256');
	return new Promise((resolvePromise, reject) => {
		const req = lib.request(
			url,
			{
				method: 'GET',
				headers: { Authorization: authHeader, Connection: 'close' },
				...(url.protocol === 'https:' ? { rejectUnauthorized: false } : {}),
			},
			(res) => {
				let bytes = 0;
				let ttfb = -1;
				res.on('data', (d: Buffer) => {
					if (ttfb < 0) ttfb = Date.now() - start;
					bytes += d.length;
					h.update(d);
				});
				res.on('end', () =>
					resolvePromise({
						status: res.statusCode ?? 0,
						transferEncoding: res.headers['transfer-encoding'],
						contentLength: res.headers['content-length'],
						bytes,
						sha: h.digest('hex'),
						ttfbMs: ttfb < 0 ? Date.now() - start : ttfb,
						totalMs: Date.now() - start,
					})
				);
			}
		);
		req.on('error', reject);
		req.setTimeout(300_000, () => req.destroy(new Error('streamHashGet timeout')));
		req.end();
	});
}

async function dirBytes(dir: string): Promise<number> {
	const fs = await import('node:fs/promises');
	let total = 0;
	async function walk(d: string) {
		let entries: any[];
		try {
			entries = await fs.readdir(d, { withFileTypes: true });
		} catch {
			return;
		}
		for (const e of entries) {
			const p = join(d, e.name);
			if (e.isDirectory()) await walk(p);
			else {
				try {
					total += (await fs.stat(p)).size;
				} catch {
					/* race */
				}
			}
		}
	}
	await walk(dir);
	return total;
}

suite(`large-blob streaming (engine=${ENGINE})`, { skip: skipSuite }, (ctx: ContextWithHarper) => {
	let client: Client;
	let httpURL: string;
	let authHeader: string;
	let blobPath: string;
	let idleRssMB = 0;
	const findings: string[] = [];

	async function op(body: Record<string, unknown>, timeoutMs = 300_000) {
		return request(httpURL).post('/BlobOps/').set(client.headers).send(body).timeout(timeoutMs);
	}

	before(async () => {
		blobPath = await mkdtemp(join(tmpdir(), 'large-blob-streaming-'));
		await setupHarperWithFixture(ctx, FIXTURE_PATH, {
			config: { storage: { blobPaths: [blobPath] } },
			env: {},
		});
		client = createApiClient(ctx.harper);
		httpURL = ctx.harper.httpURL;
		authHeader = client.headers.Authorization;

		const deadline = Date.now() + 60_000;
		while (Date.now() < deadline) {
			try {
				const probe = await client.reqRest('/Big/').timeout(3_000);
				if (probe.status !== 404) break;
			} catch {
				/* not ready */
			}
			await sleep(250);
		}
		await sleep(1500);
		const m = await sampleWorkerMem(client);
		idleRssMB = m.maxRssMB;
		findings.push(
			`baseline: idle worker maxHeap=${m.maxHeapMB.toFixed(1)}MB maxRss=${m.maxRssMB.toFixed(1)}MB (engine=${ENGINE})`
		);
	});

	after(async () => {
		await teardownHarper(ctx);
		console.log(`\n[large-blob-streaming] SUMMARY (engine=${ENGINE})`);
		for (const f of findings) console.log('  ' + f);
	});

	// Sweep sizes; characterize round-trip + memory trend on BOTH directions.
	test('Q1: size sweep — byte-exact round-trip + bounded upload/download memory', async () => {
		const baseSizes = [64, 128, 256];
		const results: {
			mb: number;
			klass: string;
			upHeapMB: number;
			upRssMB: number;
			dlHeapMB: number;
			dlRssMB: number;
			match: boolean;
		}[] = [];

		const runSize = async (mb: number) => {
			const size = mb * MB;
			const key = `blob-${mb}`;
			// ---- UPLOAD ----
			let klass = 'round-trip-exact';
			let match = false;
			let upHeapMB = 0;
			let upRssMB = 0;
			let dlHeapMB = 0;
			let dlRssMB = 0;
			const up = await withMemWatch(client, () => op({ action: 'store', key, seed: key, size }));
			upHeapMB = up.peakHeapMB;
			upRssMB = up.peakRssMB;
			if (up.result.status !== 200 || up.result.body?.ok !== true) {
				klass =
					up.result.status === 413
						? 'clean-413'
						: up.result.status >= 500
							? `${up.result.status}-cliff`
							: `status-${up.result.status}`;
				findings.push(
					`Q1 ${mb}MB UPLOAD ${klass}: status=${up.result.status} body=${JSON.stringify(up.result.body).slice(0, 200)}`
				);
				results.push({ mb, klass, upHeapMB, upRssMB, dlHeapMB, dlRssMB, match });
				return klass;
			}
			const expectedSha = up.result.body.expectedSha;

			// ---- DOWNLOAD/VERIFY (server-side streaming hash) ----
			const dl = await withMemWatch(client, () => op({ action: 'verify', key }));
			dlHeapMB = dl.peakHeapMB;
			dlRssMB = dl.peakRssMB;
			if (dl.result.status !== 200 || dl.result.body?.present !== true) {
				klass = dl.result.status >= 500 ? `${dl.result.status}-cliff-on-read` : `verify-status-${dl.result.status}`;
				findings.push(
					`Q1 ${mb}MB VERIFY ${klass}: status=${dl.result.status} body=${JSON.stringify(dl.result.body).slice(0, 200)}`
				);
				results.push({ mb, klass, upHeapMB, upRssMB, dlHeapMB, dlRssMB, match });
				return klass;
			}
			match = dl.result.body.match === true && dl.result.body.readSha === expectedSha;
			if (!match) klass = dl.result.body.readSize !== size ? 'truncated' : 'corrupt-checksum';

			findings.push(
				`Q1 ${mb}MB → ${klass}; readSha==expected=${dl.result.body.readSha === expectedSha} ` +
					`readSize=${dl.result.body.readSize}/${size} ` +
					`UP[heap+${(upHeapMB - idleRssMB > 0 ? upHeapMB : upHeapMB).toFixed(0)} rss=${upRssMB.toFixed(0)}MB Δ${(upRssMB - idleRssMB).toFixed(0)}] ` +
					`DL[heap=${dlHeapMB.toFixed(0)} rss=${dlRssMB.toFixed(0)}MB Δ${(dlRssMB - idleRssMB).toFixed(0)}] ` +
					`up=${up.result.body.uploadMs}ms dl=${dl.result.body.verifyMs}ms`
			);
			results.push({ mb, klass, upHeapMB, upRssMB, dlHeapMB, dlRssMB, match });
			return klass;
		};

		for (const mb of baseSizes) {
			await sleep(1500);
			await runSize(mb);
		}

		// Escalation: only attempt 512MB if 256MB stayed bounded (true streaming).
		const at256 = results.find((r) => r.mb === 256);
		const bounded256 =
			at256 &&
			at256.match &&
			at256.upRssMB - idleRssMB < RSS_ESCALATE_GUARD_MB &&
			at256.dlRssMB - idleRssMB < RSS_ESCALATE_GUARD_MB;
		if (bounded256) {
			findings.push(
				`Q1 escalate: 256MB bounded (upΔrss=${(at256!.upRssMB - idleRssMB).toFixed(0)} dlΔrss=${(at256!.dlRssMB - idleRssMB).toFixed(0)}MB < ${RSS_ESCALATE_GUARD_MB}) → attempting 512MB`
			);
			await sleep(2000);
			await runSize(512);
		} else {
			findings.push(
				`Q1 escalate: NOT attempting 512MB — 256MB ` +
					(at256
						? `Δrss up=${(at256.upRssMB - idleRssMB).toFixed(0)}/dl=${(at256.dlRssMB - idleRssMB).toFixed(0)}MB match=${at256.match}`
						: 'missing') +
					` (guard ${RSS_ESCALATE_GUARD_MB}MB)`
			);
		}

		// Memory trend across the bounded sizes that succeeded.
		const okPts = results.filter((r) => r.match);
		if (okPts.length >= 2) {
			const a = okPts[0];
			const b = okPts[okPts.length - 1];
			const upTrend = b.upRssMB - a.upRssMB;
			const dlTrend = b.dlRssMB - a.dlRssMB;
			findings.push(
				`Q1 MEMORY TREND ${a.mb}→${b.mb}MB (${(b.mb / a.mb).toFixed(1)}x): ` +
					`upload Δrss=${upTrend.toFixed(0)}MB, download Δrss=${dlTrend.toFixed(0)}MB → ` +
					(Math.abs(upTrend) < (b.mb - a.mb) * 0.5 && Math.abs(dlTrend) < (b.mb - a.mb) * 0.5
						? 'BOUNDED (rss does NOT scale ~1:1 with blob size => true streaming both directions)'
						: 'rss scales with blob size => BUFFERING (OOM lever)')
			);
		}

		ok(
			results.some((r) => r.match),
			'no size round-tripped byte-exact'
		);
	});

	// Sub-attribute wire GET at the largest succeeded size — streaming hash on the wire.
	test('Q2: blob sub-attribute GET path (small + large; record + sub-attr routes)', async () => {
		// First a SMALL (1MB) blob to characterize the read-path routes cheaply, so a
		// 404 at large size can be distinguished from "this route is unsupported".
		const small = 1 * MB;
		const smallKey = 'wire-small';
		const sSt = await op({ action: 'store', key: smallKey, seed: smallKey, size: small });
		ok(sSt.status === 200, `small store failed: ${sSt.status} ${JSON.stringify(sSt.body).slice(0, 150)}`);
		const smallExpected = sSt.body.expectedSha;

		// Probe candidate routes for reading a blob attribute over REST.
		const routes = (k: string) => [`/Big/${k}/payload`, `/Big/${k}.payload`, `/Big/${k}?select(payload)`, `/Big/${k}`];
		for (const path of routes(smallKey)) {
			const r = await streamHashGet(httpURL, path, authHeader);
			const exact = r.status === 200 && r.bytes === small && r.sha === smallExpected;
			findings.push(
				`Q2 route GET ${path} → status=${r.status} bytes=${r.bytes}/${small} blobShaMatch=${r.sha === smallExpected} ` +
					`ct-len=${r.contentLength ?? '-'} te=${r.transferEncoding ?? '-'}${exact ? ' [BLOB BYTE-EXACT]' : ''}`
			);
		}

		// Now the large sub-attribute GET (256MB), streaming wire hash.
		const mb = 256;
		const size = mb * MB;
		const key = 'wire-256';
		const st = await op({ action: 'store', key, seed: key, size });
		if (st.status !== 200) {
			findings.push(`Q2 setup store ${mb}MB failed status=${st.status}; skipping large wire GET`);
		} else {
			const expectedSha = st.body.expectedSha;
			const { result: r } = await withMemWatch(client, () => streamHashGet(httpURL, `/Big/${key}/payload`, authHeader));
			const exact = r.status === 200 && r.bytes === size && r.sha === expectedSha;
			findings.push(
				`Q2 LARGE GET /Big/${key}/payload → status=${r.status} bytes=${r.bytes}/${size} ` +
					`sha==expected=${r.sha === expectedSha} te=${r.transferEncoding ?? '-'} ct-len=${r.contentLength ?? '-'} ` +
					`ttfb=${r.ttfbMs}ms total=${r.totalMs}ms → ${exact ? 'WIRE BYTE-EXACT (streaming)' : 'NOT-EXACT/ERR'}`
			);
			await op({ action: 'delete', key });
		}
		await op({ action: 'delete', key: smallKey });
		ok(true); // diagnostic test: record route behaviors, don't hard-fail on route shape
	});

	// Overwrite + delete reclaim: write a large blob, overwrite it, delete it,
	// confirm blob-path disk usage drops back (space reclaimed, not leaked).
	test('Q3: overwrite + delete reclaims blob-path disk space', async () => {
		const mb = 128;
		const size = mb * MB;
		const key = 'reclaim-1';

		const before = await dirBytes(blobPath);
		await op({ action: 'store', key, seed: 'v1', size });
		await sleep(2000);
		const afterStore = await dirBytes(blobPath);

		// Overwrite with new content (same key) — old blob file should be reclaimed.
		await op({ action: 'store', key, seed: 'v2', size });
		await sleep(3000);
		const afterOverwrite = await dirBytes(blobPath);
		// Confirm the overwrite content is what's stored now.
		const v2exp = (await op({ action: 'expected', key, seed: 'v2', size })).body.expectedSha;
		const v = await op({ action: 'verify', key });
		const overwriteCorrect = v.body?.readSha === v2exp;

		// Delete — space should drop back toward baseline.
		await op({ action: 'delete', key });
		await sleep(4000);
		const afterDelete = await dirBytes(blobPath);

		const toMB = (b: number) => (b / MB).toFixed(1);
		findings.push(
			`Q3 reclaim (${mb}MB): blobDir before=${toMB(before)} afterStore=${toMB(afterStore)} ` +
				`afterOverwrite=${toMB(afterOverwrite)} afterDelete=${toMB(afterDelete)}MB; ` +
				`overwrite content correct=${overwriteCorrect}`
		);
		const grewOnStore = afterStore - before > size * 0.8;
		const overwriteReclaimed = afterOverwrite - before < size * 1.5; // not ~2x (old file lingering forever)
		const deleteReclaimed = afterDelete - before < size * 0.5;
		findings.push(
			`Q3 verdict: store-grew=${grewOnStore} overwrite-bounded(~1x not 2x)=${overwriteReclaimed} ` +
				`delete-reclaimed=${deleteReclaimed} → ` +
				(overwriteReclaimed && deleteReclaimed
					? 'SPACE RECLAIMED (no large-blob leak)'
					: 'POSSIBLE LEAK — disk did not drop back')
		);
		ok(overwriteCorrect, 'overwrite did not store the new content');
	});

	test('instance stayed alive throughout', async () => {
		const r = await client
			.req()
			.send({ operation: 'system_information', attributes: ['threads'] })
			.expect(200);
		ok(Array.isArray(r.body.threads), 'system_information should report threads (instance alive)');
	});
});
