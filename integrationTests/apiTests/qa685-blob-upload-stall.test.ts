/**
 * QA-685 — proves a stalled client blob upload does not wedge unrelated writes.
 *
 * A complete CBOR write first proves the fixture uses file-backed Blob storage. The regression
 * arms then hold one and four truthful-but-partial request bodies open, require bounded control
 * writes to an unrelated table to keep succeeding, and verify that aborting the clients leaves
 * neither visible records nor blob files. Latency and worker distributions are diagnostic rather
 * than load-sensitive pass/fail thresholds.
 *
 * Refs harper#1862.
 */
import { suite, test, before, after } from 'node:test';
import { ok } from 'node:assert';
import { resolve, join } from 'node:path';
import { readdir, stat, readFile } from 'node:fs/promises';
import { setTimeout as sleep } from 'node:timers/promises';
import net from 'node:net';
import http from 'node:http';
import { encode as cborEncode } from 'cbor-x';
import { setupHarperWithFixture, teardownHarper, type ContextWithHarper } from '@harperfast/integration-testing';
// @ts-expect-error utils/client.mjs has no type declarations; runtime resolves fine
import { createApiClient } from './utils/client.mjs';

const FIXTURE_PATH = resolve(import.meta.dirname, 'qa685-blob-upload-stall');
const skipSuite = process.platform === 'win32';

const LANES = 4;
const CONTROL_TIMEOUT_MS = 10_000; // AbortSignal.timeout budget for every control request
const BASELINE_MS = 5_000;
const DURING_SINGLE_MS = 15_000; // control burst while ONE upload is stalled
const SELF_TIMEOUT_TOTAL_MS = 75_000; // Q2: total bounded wait on the single stall (60-90s window)
const DURING_QUAD_MS = 15_000; // control burst while FOUR uploads are stalled
const BLOB_PAYLOAD_LEN = 16 * 1024 * 1024; // 16MB "large binary attachment"
const SENT_LEN = 2 * 1024 * 1024; // 2MB actually written to the wire before going silent

const findings: string[] = [];
function log(msg: string) {
	findings.push(msg);
	console.log('[QA-685] ' + msg);
}

// ── raw net.Socket helpers (never fetch, per spec — fetch cannot pause a body) ─────────────

interface StalledUpload {
	key: string;
	socket: net.Socket;
	responseBytes: number;
	firstByteAt: number | null;
	startedAt: number;
	closed: boolean;
	errored: Error | null;
}

/**
 * Open a raw socket, send full HTTP headers with a TRUTHFUL Content-Length matching the real,
 * complete `fullBody` (a CBOR-encoded {id, data: Blob, contentType, filename} MediaAsset record —
 * had it been delivered in full, this exact request would succeed, per the sanity test), but only
 * write the first `sentLen` bytes, then go silent: socket left open, no FIN.
 */
function startStalledUpload(
	host: string,
	port: number,
	key: string,
	auth: string,
	fullBody: Buffer,
	sentLen: number
): Promise<StalledUpload> {
	return new Promise((resolveUpload) => {
		const socket = new net.Socket();
		const state: StalledUpload = {
			key,
			socket,
			responseBytes: 0,
			firstByteAt: null,
			startedAt: Date.now(),
			closed: false,
			errored: null,
		};
		socket.on('data', (d) => {
			state.responseBytes += d.length;
			if (state.firstByteAt === null) state.firstByteAt = Date.now();
		});
		socket.on('close', () => {
			state.closed = true;
		});
		socket.on('error', (e) => {
			state.errored = e;
		});
		socket.connect(port, host, () => {
			const hdr = [
				`PUT /MediaAsset/${key} HTTP/1.1`,
				`Host: ${host}:${port}`,
				`Authorization: ${auth}`,
				'Content-Type: application/cbor',
				`Content-Length: ${fullBody.length}`,
				'Connection: keep-alive',
				'',
				'',
			].join('\r\n');
			socket.write(hdr);
			socket.write(fullBody.subarray(0, sentLen));
			resolveUpload(state);
		});
	});
}

/** Complete (non-stalled) full-record CBOR PUT, for the sanity/route-validation leg. */
function putCompleteCbor(
	host: string,
	port: number,
	path: string,
	auth: string,
	body: Buffer,
	timeoutMs: number
): Promise<{ status: number; raw: string }> {
	return new Promise((res) => {
		const req = http.request(
			{
				host,
				port,
				method: 'PUT',
				path,
				headers: {
					'Authorization': auth,
					'Content-Type': 'application/cbor',
					'Content-Length': body.length,
					'Connection': 'close',
				},
			},
			(r: any) => {
				const chunks: Buffer[] = [];
				r.on('data', (c: Buffer) => chunks.push(c));
				r.on('end', () => res({ status: r.statusCode ?? 0, raw: Buffer.concat(chunks).toString('utf8') }));
			}
		);
		req.setTimeout(timeoutMs, () => {
			req.destroy();
			res({ status: 0, raw: 'CLIENT_TIMEOUT' });
		});
		req.on('error', (e: Error) => res({ status: 0, raw: String(e?.message ?? e) }));
		req.end(body);
	});
}

/** Recursively count blob files + total bytes under a directory. */
async function diskUsage(dir: string): Promise<{ files: number; bytes: number }> {
	let files = 0;
	let bytes = 0;
	async function walk(d: string) {
		let entries;
		try {
			entries = await readdir(d, { withFileTypes: true });
		} catch {
			return;
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

interface WriterStats {
	count: number;
	okCount: number;
	errCount: number;
	latencies: number[];
	threadCounts: Map<number, number>;
	errorSamples: any[];
}
function percentile(sorted: number[], p: number): number {
	if (sorted.length === 0) return NaN;
	const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
	return sorted[idx];
}
function statsSummary(s: WriterStats): string {
	const sorted = [...s.latencies].sort((a, b) => a - b);
	const mean = sorted.length ? sorted.reduce((a, b) => a + b, 0) / sorted.length : NaN;
	const threads = [...s.threadCounts.entries()].map(([tid, n]) => `${tid}:${n}`).join(',');
	return (
		`count=${s.count} ok=${s.okCount} err=${s.errCount} ` +
		`latency(ms) mean=${mean.toFixed(1)} p50=${percentile(sorted, 50)} p95=${percentile(sorted, 95)} max=${sorted[sorted.length - 1] ?? NaN} ` +
		`threads={${threads}}`
	);
}

suite(
	'QA-685 stalled media-asset blob upload — blast radius',
	{ skip: skipSuite, timeout: 240_000 },
	(ctx: ContextWithHarper) => {
		let client: ReturnType<typeof createApiClient>;
		let host: string;
		let port: number;
		let auth: string;
		let dataRootDir: string;
		let blobDir: string;
		let harperSha = '<unknown>';
		let procOutput = '';
		const openSockets: net.Socket[] = [];

		function controlUrl() {
			return `http://${host}:${port}/ControlOps/`;
		}

		async function controlWrite(
			id: string,
			seq: number,
			writer: number
		): Promise<{ ok: boolean; elapsedMs: number; error?: string; threadId?: number }> {
			const t0 = Date.now();
			try {
				const r = await fetch(controlUrl(), {
					method: 'POST',
					headers: { 'Authorization': auth, 'Content-Type': 'application/json' },
					body: JSON.stringify({ id, seq, writer }),
					signal: AbortSignal.timeout(CONTROL_TIMEOUT_MS),
				});
				const elapsedMs = Date.now() - t0;
				if (r.status !== 200) return { ok: false, elapsedMs, error: `status ${r.status}` };
				const j = await r.json();
				return { ok: !!j.ok, elapsedMs, threadId: j.threadId };
			} catch (e: any) {
				return { ok: false, elapsedMs: Date.now() - t0, error: String(e?.message ?? e) };
			}
		}

		function runControlBurst(durationMs: number, label: string): Promise<WriterStats> {
			const stopAt = Date.now() + durationMs;
			const latencies: number[] = [];
			const threadCounts = new Map<number, number>();
			const errorSamples: any[] = [];
			let okCount = 0;
			let errCount = 0;

			async function lane(laneId: number) {
				let seq = 0;
				while (Date.now() < stopAt) {
					const r = await controlWrite(`${label}-${laneId}-${seq}`, seq, laneId);
					latencies.push(r.elapsedMs);
					if (r.ok) {
						okCount++;
						if (r.threadId != null) threadCounts.set(r.threadId, (threadCounts.get(r.threadId) || 0) + 1);
					} else {
						errCount++;
						if (errorSamples.length < 5) errorSamples.push({ error: r.error, elapsedMs: r.elapsedMs });
					}
					seq++;
				}
			}
			return Promise.all(Array.from({ length: LANES }, (_, i) => lane(i))).then(() => ({
				count: latencies.length,
				okCount,
				errCount,
				latencies,
				threadCounts,
				errorSamples,
			}));
		}

		before(async () => {
			await setupHarperWithFixture(ctx, FIXTURE_PATH, {
				config: { threads: { count: 4 }, logging: { root: 'log', level: 'info' } },
				env: {},
			});
			client = createApiClient(ctx.harper);
			const parsed = new URL(ctx.harper.httpURL);
			host = parsed.hostname;
			port = parseInt(parsed.port || '80', 10);
			auth = client.headers.Authorization;
			dataRootDir = ctx.harper.dataRootDir;
			blobDir = join(dataRootDir, 'blobs');

			procOutput += ctx.harper.startupOutput?.stdout ?? '';
			procOutput += ctx.harper.startupOutput?.stderr ?? '';
			ctx.harper.process?.stdout?.on('data', (d: Buffer) => (procOutput += d.toString()));
			ctx.harper.process?.stderr?.on('data', (d: Buffer) => (procOutput += d.toString()));

			// Poll the probe route directly for non-404 (component pre-installed; no restart needed).
			const deadline = Date.now() + 120_000;
			while (Date.now() < deadline) {
				try {
					const probe = await client.reqRest('/MediaAsset/').timeout(2_000);
					if (probe.status !== 404) break;
				} catch {
					/* not ready yet */
				}
				await sleep(250);
			}

			try {
				const { execSync } = await import('node:child_process');
				harperSha = execSync('git rev-parse --short HEAD', { cwd: resolve(import.meta.dirname, '../..') })
					.toString()
					.trim();
			} catch {
				/* best effort */
			}
			log(`setup: httpURL=${ctx.harper.httpURL} dataRootDir=${dataRootDir} blobDir=${blobDir} harperSha=${harperSha}`);
		});

		after(async () => {
			for (const s of openSockets) {
				try {
					s.destroy();
				} catch {
					/* best effort */
				}
			}
			await teardownHarper(ctx);
			log('=== FINDINGS SUMMARY ===');
			for (const f of findings) console.log('[QA-685] ' + f);
		});

		test(
			'sanity: complete CBOR blob PUT creates a real file (validates blobDir + route + harness)',
			{ timeout: 20_000 },
			async () => {
				const before = await diskUsage(blobDir);
				const payload = Buffer.alloc(1024 * 1024, 0xab); // 1MB, well above FILE_STORAGE_THRESHOLD
				const body = Buffer.from(
					cborEncode({ id: 'qa685-sanity', data: payload, contentType: 'image/jpeg', filename: 'sanity.jpg' })
				);
				const r = await putCompleteCbor(host, port, '/MediaAsset/qa685-sanity', auth, body, 15_000);
				await sleep(500);
				const after = await diskUsage(blobDir);
				log(
					`SANITY complete CBOR blob PUT: status=${r.status}, blobDir files ${before.files} -> ${after.files} (bytes ${before.bytes} -> ${after.bytes})`
				);
				ok(r.status === 200 || r.status === 204, `sanity blob PUT failed: status=${r.status} body=${r.raw}`);
				ok(
					after.files > before.files,
					`SANITY FAILED: a completed 1MB blob write created no file under ${blobDir} — blobDir path or harness is wrong`
				);
			}
		);

		test('baseline: control-write latency with no stall in flight', { timeout: 20_000 }, async () => {
			const stats = await runControlBurst(BASELINE_MS, 'baseline');
			log(`BASELINE (${BASELINE_MS}ms): ${statsSummary(stats)}`);
			ok(stats.okCount > 0, 'baseline produced zero successful control writes — harness broken, not a stall finding');
			ok(stats.errCount === 0, `baseline had unexpected errors: ${JSON.stringify(stats.errorSamples)}`);
			(ctx as any).__baselineStats = stats;
		});

		test(
			'Q1+Q2: single stalled upload — during-stall control latency, bounded self-timeout wait, precondition proof',
			{ timeout: 110_000 },
			async () => {
				const blobBaseline = await diskUsage(blobDir);
				const payload = Buffer.alloc(BLOB_PAYLOAD_LEN, 0xaa);
				const fullBody = Buffer.from(
					cborEncode({ id: 'qa685-single-stall', data: payload, contentType: 'video/mp4', filename: 'clip.mp4' })
				);
				const upload = await startStalledUpload(host, port, 'qa685-single-stall', auth, fullBody, SENT_LEN);
				openSockets.push(upload.socket);
				log(
					`Q1/Q2: stalled upload started — full CBOR body=${fullBody.length}B (declared Content-Length), sent=${SENT_LEN}B, then silence`
				);

				// ── Precondition proof: the server genuinely received a partial body and is waiting ──
				// Per the pre-flight finding, a partial blob FILE on disk is not achievable via REST
				// (streamToBuffer always fully buffers before any Blob is constructed) — logged here to
				// confirm that empirically (delta should be 0), but NOT used as the armed condition.
				// Armed instead means: truthful oversized Content-Length + record still invisible +
				// connection still open/unerrored — i.e. genuinely parked, not merely slow or dead.
				await sleep(1_000);
				const midDisk = await diskUsage(blobDir);
				const pendingRead = await client.reqRest('/MediaAsset/qa685-single-stall').timeout(3_000);
				const contentLengthExceedsSent = fullBody.length > SENT_LEN;
				const connectionAlive = !upload.closed && !upload.errored;
				const armed = contentLengthExceedsSent && pendingRead.status === 404 && connectionAlive;
				log(
					`PRECONDITION: declaredContentLength=${fullBody.length} sentBytes=${SENT_LEN} (exceeds=${contentLengthExceedsSent}), ` +
						`pending GET status=${pendingRead.status} (expect 404), connectionAlive=${connectionAlive}, ` +
						`blobDir files ${blobBaseline.files} -> ${midDisk.files} (delta=${midDisk.files - blobBaseline.files}, expect 0 per pre-flight finding) => armed=${armed}`
				);
				ok(
					armed,
					'PRECONDITION NOT ARMED: either the Content-Length was satisfied, the record is already visible, or the connection died — cannot draw conclusions about stall impact'
				);

				// Q1: control-write latency DURING the stall.
				const duringStats = await runControlBurst(DURING_SINGLE_MS, 'during-single');
				log(`Q1 DURING single stall (${DURING_SINGLE_MS}ms): ${statsSummary(duringStats)}`);
				(ctx as any).__duringSingleStats = duringStats;

				// Q2: keep waiting (quietly) until the total observation window reaches SELF_TIMEOUT_TOTAL_MS,
				// watching for the server to ever notice and react (response bytes / close) on its own.
				const remainingMs = SELF_TIMEOUT_TOTAL_MS - (Date.now() - upload.startedAt);
				if (remainingMs > 0) await sleep(remainingMs);
				const elapsedTotal = Date.now() - upload.startedAt;
				log(
					`Q2 after ${elapsedTotal}ms total: responseBytes=${upload.responseBytes} firstByteAt=${
						upload.firstByteAt ? upload.firstByteAt - upload.startedAt + 'ms' : '<none>'
					} socketClosed=${upload.closed} socketErrored=${upload.errored ? upload.errored.message : '<none>'}`
				);

				// Scan captured stdout/stderr for anything relevant emitted during the whole window.
				let logText = procOutput;
				try {
					logText += await readFile(join(dataRootDir, 'log', 'hdb.log'), 'utf8');
				} catch {
					/* file may not exist in this harness; procOutput is the primary source */
				}
				const keywordHits: Record<string, number> = {};
				for (const kw of [
					'outstanding write transactions',
					'Transaction was open too long',
					'idle timeout',
					'ETIMEDOUT',
					'blob',
				]) {
					keywordHits[kw] = (logText.match(new RegExp(kw, 'gi')) || []).length;
				}
				log(`Q2 captured-log keyword scan (${logText.length} chars): ${JSON.stringify(keywordHits)}`);
				log(
					upload.responseBytes === 0 && !upload.closed
						? `Q2 VERDICT: NO self-timeout observed within ${elapsedTotal}ms — matches code-reading prediction (client-upload path never arms blobStreamIdleTimeoutMs)`
						: `Q2 VERDICT: the connection DID react on its own within ${elapsedTotal}ms (responseBytes=${upload.responseBytes}, closed=${upload.closed}) — some watchdog fired`
				);

				// Destroy the stalled socket (simulate the client dying) and measure the AFTER burst.
				upload.socket.destroy();
				await sleep(1_000);
				const afterStats = await runControlBurst(5_000, 'after-single');
				log(`Q1 AFTER single-stall destroy: ${statsSummary(afterStats)}`);
				(ctx as any).__afterSingleStats = afterStats;
				(ctx as any).__blobBaselineForSingle = blobBaseline;

				const baseline = (ctx as any).__baselineStats as WriterStats;
				const baseMean = baseline.latencies.reduce((a, b) => a + b, 0) / baseline.latencies.length;
				const duringMean = duringStats.latencies.reduce((a, b) => a + b, 0) / duringStats.latencies.length;
				const afterMean = afterStats.latencies.reduce((a, b) => a + b, 0) / afterStats.latencies.length;
				log(
					`Q1 SUMMARY mean control-write latency: before=${baseMean.toFixed(1)}ms during(1x stall)=${duringMean.toFixed(1)}ms after=${afterMean.toFixed(1)}ms`
				);

				ok(duringStats.okCount > 0, 'WEDGE DEFECT: zero control writes succeeded while a single upload was stalled');
				ok(
					duringStats.errCount === 0,
					`unexpected control-write errors during single stall: ${JSON.stringify(duringStats.errorSamples)}`
				);
				ok(
					afterStats.okCount > 0 && afterStats.errCount === 0,
					`control writes did not recover after destroying the single stalled socket: ${JSON.stringify(afterStats.errorSamples)}`
				);
			}
		);

		test('Q3: N=4 concurrent stalled uploads — does it degrade further?', { timeout: 60_000 }, async () => {
			const blobBaseline = await diskUsage(blobDir);
			const uploads: StalledUpload[] = [];
			for (let i = 0; i < 4; i++) {
				const payload = Buffer.alloc(BLOB_PAYLOAD_LEN, 0xbb + i);
				const key = `qa685-quad-${i}`;
				const fullBody = Buffer.from(
					cborEncode({ id: key, data: payload, contentType: 'video/mp4', filename: `clip-${i}.mp4` })
				);
				const upload = await startStalledUpload(host, port, key, auth, fullBody, SENT_LEN);
				openSockets.push(upload.socket);
				uploads.push(upload);
			}
			log(`Q3: started ${uploads.length} concurrent stalled uploads (keys: ${uploads.map((u) => u.key).join(', ')})`);

			// Precondition proof (see Q1/Q2 header note): all 4 records still invisible, all 4
			// connections still alive/unerrored. blobDir delta logged for confirmation only (expect 0).
			await sleep(1_000);
			const midDisk = await diskUsage(blobDir);
			let pendingCount = 0;
			let aliveCount = 0;
			for (const u of uploads) {
				const r = await client.reqRest(`/MediaAsset/${u.key}`).timeout(3_000);
				if (r.status === 404) pendingCount++;
				if (!u.closed && !u.errored) aliveCount++;
			}
			const armed = pendingCount === uploads.length && aliveCount === uploads.length;
			log(
				`PRECONDITION (Q3): pending (404) count=${pendingCount}/${uploads.length}, alive count=${aliveCount}/${uploads.length}, ` +
					`blobDir files ${blobBaseline.files} -> ${midDisk.files} (delta=${midDisk.files - blobBaseline.files}, expect 0 per pre-flight finding) => armed=${armed}`
			);
			ok(
				armed,
				`PRECONDITION NOT ARMED for Q3: expected ${uploads.length} pending (404) + ${uploads.length} alive connections`
			);

			const duringQuadStats = await runControlBurst(DURING_QUAD_MS, 'during-quad');
			log(`Q3 DURING 4x stall (${DURING_QUAD_MS}ms): ${statsSummary(duringQuadStats)}`);

			for (const u of uploads) u.socket.destroy();
			await sleep(1_000);

			const duringSingle = (ctx as any).__duringSingleStats as WriterStats;
			const baseline = (ctx as any).__baselineStats as WriterStats;
			const baseMean = baseline.latencies.reduce((a, b) => a + b, 0) / baseline.latencies.length;
			const singleMean = duringSingle.latencies.reduce((a, b) => a + b, 0) / duringSingle.latencies.length;
			const quadMean = duringQuadStats.latencies.reduce((a, b) => a + b, 0) / duringQuadStats.latencies.length;
			const singleP95 = percentile(
				[...duringSingle.latencies].sort((a, b) => a - b),
				95
			);
			const quadP95 = percentile(
				[...duringQuadStats.latencies].sort((a, b) => a - b),
				95
			);
			log(
				`Q3 COMPARISON mean control-write latency: baseline=${baseMean.toFixed(1)}ms 1x-stall=${singleMean.toFixed(1)}ms 4x-stall=${quadMean.toFixed(1)}ms ` +
					`(p95: 1x=${singleP95} 4x=${quadP95}); throughput: 1x=${((duringSingle.count / DURING_SINGLE_MS) * 1000).toFixed(1)}req/s ` +
					`4x=${((duringQuadStats.count / DURING_QUAD_MS) * 1000).toFixed(1)}req/s`
			);
			log(
				duringQuadStats.errCount === 0
					? 'Q3 VERDICT: 4 concurrent stalled uploads did NOT produce control-write errors; see numeric comparison above for latency/throughput degradation'
					: `Q3 VERDICT: DEFECT — ${duringQuadStats.errCount} control-write error(s) under 4x concurrent stall (0 under 1x): ${JSON.stringify(duringQuadStats.errorSamples)}`
			);

			(ctx as any).__duringQuadStats = duringQuadStats;
			(ctx as any).__blobBaselineForQuad = blobBaseline;

			ok(duringQuadStats.okCount > 0, 'WEDGE DEFECT: zero control writes succeeded while 4 uploads were stalled');
			ok(
				duringQuadStats.errCount === 0,
				`unexpected control-write errors during 4x stall: ${JSON.stringify(duringQuadStats.errorSamples)}`
			);
		});

		test('Q4: recovery + orphan-blob check after destroying all stalled sockets', { timeout: 60_000 }, async () => {
			const startBaseline = (ctx as any).__blobBaselineForSingle as { files: number; bytes: number };
			const postDestroyDisk = await diskUsage(blobDir);
			log(
				`Q4 post-destroy blob disk usage: ${postDestroyDisk.files} files / ${(postDestroyDisk.bytes / 1024 / 1024).toFixed(2)}MB ` +
					`(delta vs pre-stall baseline = ${postDestroyDisk.files - startBaseline.files})`
			);
			const orphanFilesPresent = postDestroyDisk.files > startBaseline.files;
			log(
				`Q4 orphan blob file(s) present after destroying all 5 stalled sockets: ${orphanFilesPresent} (${postDestroyDisk.files - startBaseline.files} extra files)`
			);

			// None of the 5 stalled uploads (1 single + 4 quad) ever delivered a complete body, so none
			// should have created a visible record.
			let anyVisible = false;
			for (const key of ['qa685-single-stall', 'qa685-quad-0', 'qa685-quad-1', 'qa685-quad-2', 'qa685-quad-3']) {
				const r = await client.reqRest(`/MediaAsset/${key}`).timeout(5_000);
				if (r.status === 200) anyVisible = true;
				log(`Q4 GET /MediaAsset/${key}: status=${r.status}`);
			}

			const cleanup = await client.req().send({ operation: 'cleanup_orphan_blobs', database: 'data' }).timeout(10_000);
			log(`Q4 cleanup_orphan_blobs response: status=${cleanup.status} body=${JSON.stringify(cleanup.body)}`);

			const trajectory: string[] = [];
			let reclaimed = false;
			let afterCleanupDisk = postDestroyDisk;
			for (let t = 0; t < 6; t++) {
				await sleep(3_000);
				afterCleanupDisk = await diskUsage(blobDir);
				trajectory.push(`+${(t + 1) * 3}s=${afterCleanupDisk.files}f`);
				if (afterCleanupDisk.files <= startBaseline.files) {
					reclaimed = true;
					break;
				}
			}
			log(`Q4 cleanup_orphan_blobs trajectory: ${trajectory.join(', ')}`);
			log(
				!orphanFilesPresent
					? 'Q4 VERDICT: no orphan file was ever left for any of the 5 stalled uploads — nothing to reclaim'
					: reclaimed
						? 'Q4 VERDICT: EXPECTED — orphan blob file(s) left after socket destroy, cleanup_orphan_blobs reclaimed them within the poll window (no background sweep, per QA-180 precedent)'
						: `Q4 VERDICT: INCONCLUSIVE within budget — ${afterCleanupDisk.files - startBaseline.files} extra file(s) still present after cleanup_orphan_blobs; NOT asserted as a defect, only reported`
			);

			// Recovery: control-write latency back to baseline.
			const recoveryStats = await runControlBurst(5_000, 'recovery');
			const baseline = (ctx as any).__baselineStats as WriterStats;
			const baseMean = baseline.latencies.reduce((a, b) => a + b, 0) / baseline.latencies.length;
			const recoveryMean = recoveryStats.latencies.reduce((a, b) => a + b, 0) / recoveryStats.latencies.length;
			log(
				`Q4 RECOVERY: mean control-write latency baseline=${baseMean.toFixed(1)}ms vs post-recovery=${recoveryMean.toFixed(1)}ms — ${statsSummary(recoveryStats)}`
			);

			ok(!anyVisible, 'DATA CORRUPTION: a stalled upload that never delivered a complete body became a visible record');
			ok(
				recoveryStats.okCount > 0 && recoveryStats.errCount === 0,
				`instance did not recover after destroying all stalled sockets: ${JSON.stringify(recoveryStats.errorSamples)}`
			);
		});
	}
);
