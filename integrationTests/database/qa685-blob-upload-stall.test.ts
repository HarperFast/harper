/**
 * QA-685: partial Blob PUT bodies must leave unrelated writes available, records invisible, and
 * blob-file counts unchanged during one and four concurrent stalls and after client abort. Latency
 * is diagnostic only. Skips platforms without reliable full-worker HTTP distribution.
 *
 * These oracles hold by construction today: the REST layer buffers the whole request body before
 * decoding (server/serverHelpers/contentTypes.ts, streamToBuffer(stream).then(deserialize)), so a
 * partial CBOR body never reaches the decoder, the table, or saveBlob. A green run is therefore not
 * evidence that a stall was survived — it is a guard against a future streaming-decode or
 * synchronous-body-read change that would make one possible.
 *
 * The two HTTP servers differ on whether a stalled body survives the measurement window: the uWS
 * server reaps it after roughly ten seconds, the Node one holds it open. Only the pre-burst check
 * demands the socket still be in flight; after the burst a reap is accepted and logged, because it
 * is the safer of the two behaviours and not the property under test.
 *
 * https://github.com/HarperFast/harper/issues/1862
 */
import { suite, test, before, after } from 'node:test';
import { ok } from 'node:assert';
import { resolve, join } from 'node:path';
import { readFile, readdir, stat } from 'node:fs/promises';
import { setTimeout as sleep } from 'node:timers/promises';
import net from 'node:net';
import http from 'node:http';
import { encode as cborEncode } from 'cbor-x';
import { setupHarperWithFixture, teardownHarper, type ContextWithHarper } from '@harperfast/integration-testing';
import { NO_FULL_WORKER_COVERAGE } from './recordCachingWorkers.ts';
// @ts-expect-error no type declarations
import { createApiClient } from '../apiTests/utils/client.mjs';
// @ts-expect-error no type declarations
import { waitFor } from '../apiTests/utils/operations.mjs';

const FIXTURE_PATH = resolve(import.meta.dirname, 'qa685-blob-upload-stall');
const skipSuite = NO_FULL_WORKER_COVERAGE;

const WORKER_COUNT = 4;
const LANES = WORKER_COUNT;
const CONTROL_TIMEOUT_MS = 10_000;
const CONTROL_INTERVAL_MS = 20;
const BASELINE_MS = 5_000;
const DURING_SINGLE_MS = 15_000;
const DURING_QUAD_MS = 15_000;
const BLOB_PAYLOAD_LEN = 8 * 1024 * 1024;
const SENT_LEN = 2 * 1024 * 1024;

const findings: string[] = [];
function log(msg: string) {
	findings.push(msg);
	console.log('[QA-685] ' + msg);
}

interface StalledUpload {
	key: string;
	socket: net.Socket;
	declaredBytes: number;
	sentBytes: number;
	responseBytes: number;
	responseHead: string;
	closed: boolean;
	errored: Error | null;
	startedAt: number;
	endedAt: number | null;
}

function startStalledUpload(
	host: string,
	port: number,
	key: string,
	auth: string,
	fullBody: Buffer,
	sentLen: number
): Promise<StalledUpload> {
	return new Promise((resolveUpload, rejectUpload) => {
		const socket = new net.Socket();
		let connected = false;
		const state: StalledUpload = {
			key,
			socket,
			declaredBytes: fullBody.length,
			sentBytes: sentLen,
			responseBytes: 0,
			responseHead: '',
			closed: false,
			errored: null,
			startedAt: Date.now(),
			endedAt: null,
		};
		const markEnded = () => {
			if (state.endedAt === null) state.endedAt = Date.now();
		};
		socket.on('data', (d) => {
			state.responseBytes += d.length;
			if (state.responseHead.length < 256) state.responseHead += d.toString('latin1').slice(0, 256);
			markEnded();
		});
		socket.on('close', () => {
			state.closed = true;
			markEnded();
		});
		socket.on('error', (e) => {
			state.errored = e;
			markEnded();
			if (!connected) rejectUpload(e);
		});
		socket.connect(port, host, () => {
			connected = true;
			const hostHeader = host.includes(':') ? `[${host}]:${port}` : `${host}:${port}`;
			const hdr = [
				`PUT /MediaAsset/${key} HTTP/1.1`,
				`Host: ${hostHeader}`,
				`Authorization: ${auth}`,
				'Content-Type: application/cbor',
				`Content-Length: ${fullBody.length}`,
				'Connection: close',
				'',
				'',
			].join('\r\n');
			socket.write(hdr);
			socket.write(fullBody.subarray(0, sentLen));
			resolveUpload(state);
		});
	});
}

function putCompleteCbor(
	host: string,
	port: number,
	path: string,
	auth: string,
	body: Buffer,
	timeoutMs: number
): Promise<{ status: number; raw: string }> {
	return new Promise((resolveResponse) => {
		let settled = false;
		const finish = (result: { status: number; raw: string }) => {
			if (settled) return;
			settled = true;
			resolveResponse(result);
		};
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
			(response) => {
				const chunks: Buffer[] = [];
				response.on('data', (chunk: Buffer) => chunks.push(chunk));
				response.on('end', () =>
					finish({ status: response.statusCode ?? 0, raw: Buffer.concat(chunks).toString('utf8') })
				);
				response.on('close', () => {
					if (!response.complete) finish({ status: 0, raw: 'RESPONSE_ABORTED' });
				});
				response.on('error', (error) => finish({ status: 0, raw: error.message }));
			}
		);
		req.setTimeout(timeoutMs, () => {
			req.destroy(new Error('CLIENT_TIMEOUT'));
			finish({ status: 0, raw: 'CLIENT_TIMEOUT' });
		});
		req.on('error', (error) => finish({ status: 0, raw: error.message }));
		req.end(body);
	});
}

async function diskUsage(dir: string): Promise<{ files: number; bytes: number }> {
	let files = 0;
	let bytes = 0;
	async function walk(d: string) {
		let entries;
		try {
			entries = await readdir(d, { withFileTypes: true });
		} catch (error) {
			if (isEnoent(error)) return;
			throw error;
		}
		for (const e of entries) {
			const p = join(d, e.name);
			if (e.isDirectory()) await walk(p);
			else {
				try {
					bytes += (await stat(p)).size;
					files++;
				} catch (error) {
					if (!isEnoent(error)) throw error;
				}
			}
		}
	}
	await walk(dir);
	return { files, bytes };
}

function isEnoent(error: unknown): boolean {
	return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT';
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

function assertControlAvailability(stats: WriterStats, label: string) {
	ok(stats.okCount > 0, `${label} produced zero successful control writes`);
	ok(stats.errCount === 0, `${label} had control-write errors: ${JSON.stringify(stats.errorSamples)}`);
	ok(
		stats.threadCounts.size >= WORKER_COUNT,
		`${label} reached ${stats.threadCounts.size}, expected at least ${WORKER_COUNT} workers: ${statsSummary(stats)}`
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
		let logDir: string;
		let baselineStats: WriterStats | undefined;
		let duringSingleStats: WriterStats | undefined;
		let blobBaselineForSingle: { files: number; bytes: number } | undefined;
		const openSockets: net.Socket[] = [];

		function controlWrite(
			id: string,
			seq: number,
			writer: number
		): Promise<{ ok: boolean; elapsedMs: number; error?: string; threadId?: number }> {
			return new Promise((resolveWrite) => {
				const startedAt = Date.now();
				const body = JSON.stringify({ id, seq, writer });
				let settled = false;
				const finish = (result: { ok: boolean; elapsedMs: number; error?: string; threadId?: number }) => {
					if (settled) return;
					settled = true;
					resolveWrite(result);
				};
				const request = http.request(
					{
						host,
						port,
						path: '/ControlOps/',
						method: 'POST',
						agent: false,
						headers: {
							'Authorization': auth,
							'Content-Type': 'application/json',
							'Content-Length': Buffer.byteLength(body),
							'Connection': 'close',
						},
					},
					(response) => {
						const chunks: Buffer[] = [];
						response.on('data', (chunk: Buffer) => chunks.push(chunk));
						response.on('error', (error) =>
							finish({ ok: false, elapsedMs: Date.now() - startedAt, error: error.message })
						);
						response.on('end', () => {
							const elapsedMs = Date.now() - startedAt;
							if (response.statusCode !== 200) {
								finish({ ok: false, elapsedMs, error: `status ${response.statusCode ?? 0}` });
								return;
							}
							try {
								const result = JSON.parse(Buffer.concat(chunks).toString('utf8')) as {
									ok?: boolean;
									threadId?: number;
								};
								finish({ ok: result.ok === true, elapsedMs, threadId: result.threadId });
							} catch (error) {
								finish({ ok: false, elapsedMs, error: String(error) });
							}
						});
					}
				);
				request.setTimeout(CONTROL_TIMEOUT_MS, () => {
					request.destroy(new Error(`control write exceeded ${CONTROL_TIMEOUT_MS}ms`));
				});
				request.on('error', (error) => finish({ ok: false, elapsedMs: Date.now() - startedAt, error: error.message }));
				request.end(body);
			});
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
					await sleep(CONTROL_INTERVAL_MS);
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

		function isPending(upload: StalledUpload) {
			return (
				upload.declaredBytes > upload.sentBytes &&
				upload.responseBytes === 0 &&
				!upload.closed &&
				!upload.errored &&
				upload.endedAt === null
			);
		}

		function reapSummary(uploads: StalledUpload[]) {
			return uploads
				.filter((upload) => !isPending(upload))
				.map(
					(upload) =>
						`${upload.key} after ${upload.endedAt === null ? '?' : upload.endedAt - upload.startedAt}ms` +
						` (${upload.responseHead.split('\r\n')[0] || 'no response'})`
				)
				.join('; ');
		}

		/**
		 * The oracles that must hold whenever a partial body is outstanding: the key stays an exact
		 * 404, no blob file appears, and no partial upload is ever answered with a 2xx. `requirePending`
		 * additionally demands every socket still be in flight — true for the pre-burst check, because a
		 * measurement window that starts with nothing stalled is measuring nothing. It is false after the
		 * burst: whether the server reaps a stalled body mid-window is server-implementation detail (the
		 * uWS HTTP server does, the Node one does not), and reaping is the safer behaviour of the two.
		 */
		async function assertStalledUploadsInert(
			uploads: StalledUpload[],
			blobBaseline: { files: number; bytes: number },
			label: string,
			requirePending: boolean
		) {
			const statuses = await Promise.all(
				uploads.map(async (upload) => (await client.reqRest(`/MediaAsset/${upload.key}`).timeout(3_000)).status)
			);
			const currentDisk = await diskUsage(blobDir);
			const pendingCount = uploads.filter(isPending).length;
			const reaped = reapSummary(uploads);
			log(
				`${label}: statuses=${statuses.join(',')} pending=${pendingCount}/${uploads.length} ` +
					`blobFiles=${blobBaseline.files}->${currentDisk.files}${reaped ? ` reaped=[${reaped}]` : ''}`
			);
			ok(
				statuses.every((status) => status === 404),
				`${label}: incomplete upload did not remain an exact 404`
			);
			const accepted = uploads.filter((upload) => /^HTTP\/1\.[01] 2\d\d/.test(upload.responseHead));
			ok(
				accepted.length === 0,
				`${label}: a partial body was answered with success: ${accepted.map((upload) => `${upload.key} -> ${upload.responseHead.split('\r\n')[0]}`).join(', ')}`
			);
			ok(
				currentDisk.files === blobBaseline.files,
				`${label}: incomplete uploads created ${currentDisk.files - blobBaseline.files} blob file(s)`
			);
			if (requirePending)
				ok(
					pendingCount === uploads.length,
					`${label}: an incomplete upload responded, closed, or errored before the measurement window opened`
				);
		}

		before(async () => {
			await setupHarperWithFixture(ctx, FIXTURE_PATH, {
				config: { threads: { count: WORKER_COUNT }, logging: { root: 'log', level: 'info' } },
				env: {},
			});
			client = createApiClient(ctx.harper);
			const parsed = new URL(ctx.harper.httpURL);
			host =
				parsed.hostname.startsWith('[') && parsed.hostname.endsWith(']')
					? parsed.hostname.slice(1, -1)
					: parsed.hostname;
			port = parseInt(parsed.port || '80', 10);
			auth = client.headers.Authorization;
			dataRootDir = ctx.harper.dataRootDir;
			blobDir = join(dataRootDir, 'blobs');
			logDir = ctx.harper.logDir ?? join(dataRootDir, 'log');

			const deadline = Date.now() + 120_000;
			let ready = false;
			while (Date.now() < deadline) {
				try {
					const probe = await client.reqRest('/MediaAsset/').timeout(2_000);
					if (probe.status === 200) {
						ready = true;
						break;
					}
				} catch {}
				await sleep(250);
			}
			ok(ready, 'MediaAsset fixture route did not become ready within 120 seconds');
			log(`setup: httpURL=${ctx.harper.httpURL} dataRootDir=${dataRootDir} blobDir=${blobDir}`);
		});

		after(async () => {
			for (const s of openSockets) s.destroy();
			await teardownHarper(ctx);
			log('=== FINDINGS SUMMARY ===');
			for (const f of findings) console.log('[QA-685] ' + f);
		});

		test(
			'sanity: complete CBOR blob PUT creates a real file (validates blobDir + route + harness)',
			{ timeout: 30_000 },
			async () => {
				const beforeDisk = await diskUsage(blobDir);
				const payload = Buffer.alloc(BLOB_PAYLOAD_LEN, 0xab);
				const body = Buffer.from(
					cborEncode({ id: 'qa685-sanity', data: payload, contentType: 'image/jpeg', filename: 'sanity.jpg' })
				);
				const r = await putCompleteCbor(host, port, '/MediaAsset/qa685-sanity', auth, body, 20_000);
				const afterDisk = await diskUsage(blobDir);
				log(
					`SANITY complete CBOR blob PUT: status=${r.status}, blobDir files ${beforeDisk.files} -> ${afterDisk.files} (bytes ${beforeDisk.bytes} -> ${afterDisk.bytes})`
				);
				ok(r.status === 200 || r.status === 204, `sanity blob PUT failed: status=${r.status} body=${r.raw}`);
				ok(
					afterDisk.files > beforeDisk.files,
					`SANITY FAILED: a completed ${BLOB_PAYLOAD_LEN}-byte blob write created no file under ${blobDir}`
				);
			}
		);

		test('baseline: control-write latency with no stall in flight', { timeout: 20_000 }, async () => {
			const stats = await runControlBurst(BASELINE_MS, 'baseline');
			log(`BASELINE (${BASELINE_MS}ms): ${statsSummary(stats)}`);
			assertControlAvailability(stats, 'baseline');
			baselineStats = stats;
		});

		test('single stalled upload leaves unrelated writes available', { timeout: 50_000 }, async () => {
			const blobBaseline = await diskUsage(blobDir);
			const payload = Buffer.alloc(BLOB_PAYLOAD_LEN, 0xaa);
			const fullBody = Buffer.from(
				cborEncode({ id: 'qa685-single-stall', data: payload, contentType: 'video/mp4', filename: 'clip.mp4' })
			);
			const upload = await startStalledUpload(host, port, 'qa685-single-stall', auth, fullBody, SENT_LEN);
			openSockets.push(upload.socket);
			log(`single stall started: declared=${fullBody.length}B sent=${SENT_LEN}B`);

			await sleep(1_000);
			await assertStalledUploadsInert([upload], blobBaseline, 'single stall precondition', true);

			const duringStats = await runControlBurst(DURING_SINGLE_MS, 'during-single');
			log(`during single stall (${DURING_SINGLE_MS}ms): ${statsSummary(duringStats)}`);
			assertControlAvailability(duringStats, 'single stall');
			await assertStalledUploadsInert([upload], blobBaseline, 'single stall after control burst', false);
			duringSingleStats = duringStats;
			blobBaselineForSingle = blobBaseline;

			upload.socket.destroy();
			const afterStats = await runControlBurst(5_000, 'after-single');
			log(`after single-stall destroy: ${statsSummary(afterStats)}`);
			assertControlAvailability(afterStats, 'single-stall post-abort');

			ok(baselineStats, 'baseline test did not provide control statistics');
			const baseline = baselineStats;
			const baseMean = baseline.latencies.reduce((a, b) => a + b, 0) / baseline.latencies.length;
			const duringMean = duringStats.latencies.reduce((a, b) => a + b, 0) / duringStats.latencies.length;
			const afterMean = afterStats.latencies.reduce((a, b) => a + b, 0) / afterStats.latencies.length;
			log(
				`single-stall mean latency: before=${baseMean.toFixed(1)}ms during=${duringMean.toFixed(1)}ms after=${afterMean.toFixed(1)}ms`
			);
		});

		test('N=4 concurrent stalled uploads leave unrelated writes available', { timeout: 60_000 }, async () => {
			const blobBaseline = await diskUsage(blobDir);
			const uploads: StalledUpload[] = [];
			for (let i = 0; i < WORKER_COUNT; i++) {
				const payload = Buffer.alloc(BLOB_PAYLOAD_LEN, 0xbb + i);
				const key = `qa685-quad-${i}`;
				const fullBody = Buffer.from(
					cborEncode({ id: key, data: payload, contentType: 'video/mp4', filename: `clip-${i}.mp4` })
				);
				const upload = await startStalledUpload(host, port, key, auth, fullBody, SENT_LEN);
				openSockets.push(upload.socket);
				uploads.push(upload);
			}
			log(
				`started ${uploads.length} concurrent stalled uploads (keys: ${uploads.map((upload) => upload.key).join(', ')})`
			);

			await sleep(1_000);
			await assertStalledUploadsInert(uploads, blobBaseline, 'concurrent-stall precondition', true);

			const duringQuadStats = await runControlBurst(DURING_QUAD_MS, 'during-quad');
			log(`during 4x stall (${DURING_QUAD_MS}ms): ${statsSummary(duringQuadStats)}`);
			assertControlAvailability(duringQuadStats, 'four concurrent stalls');
			await assertStalledUploadsInert(uploads, blobBaseline, 'concurrent stalls after control burst', false);

			for (const upload of uploads) upload.socket.destroy();

			ok(duringSingleStats, 'single-stall test did not provide control statistics');
			ok(baselineStats, 'baseline test did not provide control statistics');
			const duringSingle = duringSingleStats;
			const baseline = baselineStats;
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
				`stall comparison: baseline=${baseMean.toFixed(1)}ms 1x=${singleMean.toFixed(1)}ms 4x=${quadMean.toFixed(1)}ms ` +
					`(p95: 1x=${singleP95} 4x=${quadP95}); throughput: 1x=${((duringSingle.count / DURING_SINGLE_MS) * 1000).toFixed(1)}req/s ` +
					`4x=${((duringQuadStats.count / DURING_QUAD_MS) * 1000).toFixed(1)}req/s`
			);
		});

		test(
			'client abort leaves no record or blob and ordinary writes remain available',
			{ timeout: 60_000 },
			async () => {
				ok(blobBaselineForSingle, 'single-stall test did not provide a blob baseline');
				const startBaseline = blobBaselineForSingle;
				const postDestroyDisk = await diskUsage(blobDir);
				log(
					`post-destroy blob disk usage: ${postDestroyDisk.files} files / ${(postDestroyDisk.bytes / 1024 / 1024).toFixed(2)}MB ` +
						`(delta vs pre-stall baseline = ${postDestroyDisk.files - startBaseline.files})`
				);
				ok(
					postDestroyDisk.files === startBaseline.files,
					`client abort left ${postDestroyDisk.files - startBaseline.files} blob file(s) from incomplete uploads`
				);

				for (const key of ['qa685-single-stall', 'qa685-quad-0', 'qa685-quad-1', 'qa685-quad-2', 'qa685-quad-3']) {
					const response = await client.reqRest(`/MediaAsset/${key}`).timeout(5_000);
					log(`post-abort GET /MediaAsset/${key}: status=${response.status}`);
					ok(
						response.status === 404,
						`incomplete upload ${key} returned ${response.status} instead of 404 after abort`
					);
				}

				const cleanup = await client
					.req()
					.send({ operation: 'cleanup_orphan_blobs', database: 'data' })
					.timeout(10_000);
				log(`cleanup_orphan_blobs response: status=${cleanup.status} body=${JSON.stringify(cleanup.body)}`);
				ok(cleanup.status === 200, `cleanup_orphan_blobs returned ${cleanup.status}`);
				const cleanupLog = await waitFor(
					async () => {
						try {
							return await readFile(join(logDir, 'hdb.log'), 'utf8');
						} catch (error) {
							if (!isEnoent(error)) throw error;
							return '';
						}
					},
					{
						until: (output: string) => output.includes('Cleaned Orphan Blobs from data'),
						timeoutSeconds: 15,
						intervalMs: 100,
					}
				);
				ok(cleanupLog.includes('Cleaned Orphan Blobs from data'), 'orphan blob cleanup did not finish within 15s');
				const afterCleanupDisk = await diskUsage(blobDir);
				ok(
					afterCleanupDisk.files === startBaseline.files,
					`blob file count changed after cleanup: ${startBaseline.files} -> ${afterCleanupDisk.files}`
				);

				const postAbortStats = await runControlBurst(5_000, 'post-abort');
				assertControlAvailability(postAbortStats, 'post-abort');
				ok(baselineStats, 'baseline test did not provide control statistics');
				const baseline = baselineStats;
				const baseMean = baseline.latencies.reduce((a, b) => a + b, 0) / baseline.latencies.length;
				const postAbortMean = postAbortStats.latencies.reduce((a, b) => a + b, 0) / postAbortStats.latencies.length;
				log(
					`post-abort mean latency: baseline=${baseMean.toFixed(1)}ms post-abort=${postAbortMean.toFixed(1)}ms — ${statsSummary(postAbortStats)}`
				);
			}
		);
	}
);
