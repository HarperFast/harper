/**
 * QA-890 — streaming error contract around the first yield.
 *
 * This extends qa886-uws-sse.test.ts's raw-socket-capture shape (same RawCapture technique --
 * a manual net.Socket, not http.request, so chunk-framing bytes and the exact close mechanism
 * are visible) across THREE streaming surfaces so the SSE finding can be checked for whether
 * it's SSE-specific or systemic:
 *
 *   - sse           : subscription-style `static async *connect()` (Accept: text/event-stream)
 *   - ndjson        : `get()` returns an async generator (Accept: application/x-ndjson)
 *   - iterable-rest : the SAME generator resource (Accept: application/json / default) --
 *                     content negotiation alone picks ndjson vs plain-JSON-array serialization
 *
 * ...crossed with throw-point (immediate | delayed | mid-stream) and server (node | uws).
 *
 * Reproduction:
 *   Node: npm run test:integration -- "integrationTests/server/stream-error-contract.test.ts"
 *   uWS:  HARPER_UWS_HTTP=1 npm run test:integration -- "integrationTests/server/stream-error-contract.test.ts"
 *   Bun:  HARPER_RUNTIME=bun npm run test:integration -- "integrationTests/server/stream-error-contract.test.ts"
 *
 * Each run prints a per-case capture table to stdout.
 */
import { suite, test, before, after } from 'node:test';
import { deepStrictEqual, ok, strictEqual } from 'node:assert';
import { resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import net from 'node:net';
import http from 'node:http';
import { URL } from 'node:url';
import { setupHarperWithFixture, teardownHarper, type ContextWithHarper } from '@harperfast/integration-testing';
// @ts-expect-error utils/client.mjs has no type declarations; runtime resolves fine
import { createApiClient } from '../apiTests/utils/client.mjs';

const FIXTURE_PATH = resolve(import.meta.dirname, 'stream-error-contract');
const skipSuite = process.platform === 'win32';
const VARIANT = process.env.HARPER_UWS_HTTP === '1' ? 'uws' : 'node';

type Client = ReturnType<typeof createApiClient>;

// ── Raw socket capture (same technique as qa886-uws-sse.test.ts) ───────────────────────────

interface RawCapture {
	variant: string;
	caseName: string;
	surface: string;
	throwPoint: string;
	status: number | null;
	headers: Record<string, string>;
	chunked: boolean;
	chunkSizes: number[];
	sawTerminalChunk: boolean;
	decodedBody: string;
	totalBytes: number;
	socketEvents: string[];
	durationMs: number;
}

function parseHttpRaw(buf: Buffer): {
	status: number | null;
	headers: Record<string, string>;
	chunked: boolean;
	sawTerminalChunk: boolean;
	decodedBody: string;
	chunkSizes: number[];
} {
	const headerEnd = buf.indexOf('\r\n\r\n');
	if (headerEnd === -1) {
		return { status: null, headers: {}, chunked: false, sawTerminalChunk: false, decodedBody: '', chunkSizes: [] };
	}
	const headerText = buf.subarray(0, headerEnd).toString('latin1');
	const bodyRaw = buf.subarray(headerEnd + 4);
	const lines = headerText.split('\r\n');
	const parsedStatus = Number.parseInt(lines[0]?.split(' ')[1] ?? '', 10);
	const status = Number.isSafeInteger(parsedStatus) ? parsedStatus : null;
	const headers: Record<string, string> = {};
	for (const l of lines.slice(1)) {
		const idx = l.indexOf(':');
		if (idx === -1) continue;
		headers[l.slice(0, idx).toLowerCase()] = l.slice(idx + 1).trim();
	}
	const chunked = (headers['transfer-encoding'] ?? '').toLowerCase().includes('chunked');
	if (!chunked) {
		return { status, headers, chunked, sawTerminalChunk: false, decodedBody: bodyRaw.toString('utf8'), chunkSizes: [] };
	}
	let offset = 0;
	let decoded = '';
	let sawTerminalChunk = false;
	const chunkSizes: number[] = [];
	while (offset < bodyRaw.length) {
		const lineEnd = bodyRaw.indexOf('\r\n', offset);
		if (lineEnd === -1) break;
		const sizeHex = bodyRaw.subarray(offset, lineEnd).toString('latin1').trim().split(';')[0];
		const size = Number.parseInt(sizeHex, 16);
		if (!Number.isSafeInteger(size) || size < 0) break;
		chunkSizes.push(size);
		if (size === 0) {
			sawTerminalChunk = true;
			break;
		}
		const dataStart = lineEnd + 2;
		const dataEnd = dataStart + size;
		if (dataEnd > bodyRaw.length) break;
		decoded += bodyRaw.subarray(dataStart, dataEnd).toString('utf8');
		offset = dataEnd + 2;
	}
	return { status, headers, chunked, sawTerminalChunk, decodedBody: decoded, chunkSizes };
}

function rawCapture(
	restBase: string,
	path: string,
	acceptHeader: string,
	authHeader: string,
	surface: string,
	throwPoint: string,
	opts: { timeoutMs?: number; http10?: boolean; connection?: string; acceptEncoding?: string; method?: string } = {}
): Promise<RawCapture> {
	const timeoutMs = opts.timeoutMs ?? 15_000;
	const url = new URL(restBase);
	const host = url.hostname;
	const port = Number.parseInt(url.port, 10) || (url.protocol === 'https:' ? 443 : 80);
	const caseName = `${surface}/${throwPoint}`;

	return new Promise((resolvePromise) => {
		const start = Date.now();
		const chunks: Buffer[] = [];
		const socketEvents: string[] = [];
		let settled = false;

		const socket = net.createConnection({ host, port }, () => {
			const connection = opts.connection ?? (opts.http10 ? undefined : 'close');
			const req =
				`${opts.method ?? 'GET'} ${path} HTTP/${opts.http10 ? '1.0' : '1.1'}\r\n` +
				`Host: ${host}:${port}\r\n` +
				`Accept: ${acceptHeader}\r\n` +
				`Authorization: ${authHeader}\r\n` +
				(connection ? `Connection: ${connection}\r\n` : '') +
				(opts.acceptEncoding ? `Accept-Encoding: ${opts.acceptEncoding}\r\n` : '') +
				`\r\n`;
			socket.write(req);
		});

		const timer = setTimeout(() => {
			socketEvents.push('CLIENT_TIMEOUT');
			socket.destroy();
		}, timeoutMs);

		const finish = () => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			const raw = Buffer.concat(chunks);
			const parsed = parseHttpRaw(raw);
			resolvePromise({
				variant: VARIANT,
				caseName,
				surface,
				throwPoint,
				status: parsed.status,
				headers: parsed.headers,
				chunked: parsed.chunked,
				chunkSizes: parsed.chunkSizes,
				sawTerminalChunk: parsed.sawTerminalChunk,
				decodedBody: parsed.decodedBody,
				totalBytes: raw.length,
				socketEvents,
				durationMs: Date.now() - start,
			});
		};

		socket.on('data', (d: Buffer) => {
			chunks.push(d);
			socketEvents.push(`data(+${d.length}B @${Date.now() - start}ms)`);
		});
		socket.on('end', () => socketEvents.push(`end (peer FIN) @${Date.now() - start}ms`));
		socket.on('close', (hadError: boolean) => {
			socketEvents.push(`close(hadError=${hadError}) @${Date.now() - start}ms`);
			finish();
		});
		socket.on('error', (err: any) => {
			let detail: string;
			try {
				detail = err?.code ?? err?.message ?? String(err);
			} catch {
				detail = 'unreadable error';
			}
			socketEvents.push(`error: ${detail} @${Date.now() - start}ms`);
		});
	});
}

// Fix-agnostic invariant for the pre-first-yield arms: whatever the eventual status contract turns
// out to be, the server must terminate the request itself -- never leave the client hanging until
// its own timeout. Asserting the observed status/byte shape here would pin today's divergence
// (F-275) into CI; the shape is logged instead, and the PR body tracks it.
function assertServerTerminated(cap: RawCapture) {
	ok(
		!cap.socketEvents.includes('CLIENT_TIMEOUT'),
		`${cap.caseName}: client timed out -- the server never terminated the request (headers: ${JSON.stringify(cap.headers)})`
	);
	ok(
		cap.socketEvents.some((e) => e.startsWith('close(')),
		`${cap.caseName}: connection never closed (events: ${cap.socketEvents.join(', ')})`
	);
}

function captureKeepAliveReuse(
	restBase: string,
	path: string,
	acceptHeader: string,
	authHeader: string,
	timeoutMs = 10_000
): Promise<{ responses: number; serverClosedEarly: boolean }> {
	const url = new URL(restBase);
	const host = url.hostname;
	const port = Number.parseInt(url.port, 10) || (url.protocol === 'https:' ? 443 : 80);
	const request =
		`GET ${path} HTTP/1.1\r\n` +
		`Host: ${host}:${port}\r\n` +
		`Accept: ${acceptHeader}\r\n` +
		`Authorization: ${authHeader}\r\n` +
		`Connection: keep-alive\r\n` +
		`\r\n`;

	return new Promise((resolvePromise) => {
		let raw = '';
		let sentSecond = false;
		let settled = false;
		const socket = net.createConnection({ host, port }, () => socket.write(request));
		const finish = (serverClosedEarly: boolean) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			socket.destroy();
			resolvePromise({ responses: raw.split('HTTP/1.1 200').length - 1, serverClosedEarly });
		};
		const timer = setTimeout(() => finish(false), timeoutMs);
		socket.on('data', (d: Buffer) => {
			raw += d.toString('latin1');
			const completeResponses = raw.split('0\r\n\r\n').length - 1;
			if (!sentSecond && completeResponses >= 1) {
				sentSecond = true;
				socket.write(request);
			} else if (sentSecond && completeResponses >= 2) finish(false);
		});
		socket.on('end', () => finish(!settled));
		socket.on('error', () => finish(false));
	});
}

function captureHeadKeepAliveReuse(
	restBase: string,
	headPath: string,
	authHeader: string,
	timeoutMs = 10_000
): Promise<{ responses: number; serverClosedEarly: boolean }> {
	const url = new URL(restBase);
	const host = url.hostname;
	const port = Number.parseInt(url.port, 10) || (url.protocol === 'https:' ? 443 : 80);
	const headRequest =
		`HEAD ${headPath} HTTP/1.1\r\n` +
		`Host: ${host}:${port}\r\n` +
		`Accept: application/x-ndjson\r\n` +
		`Accept-Encoding: br\r\n` +
		`Authorization: ${authHeader}\r\n` +
		`Connection: keep-alive\r\n\r\n`;
	const probeRequest =
		`GET /Probe/ HTTP/1.1\r\n` +
		`Host: ${host}:${port}\r\n` +
		`Accept: application/json\r\n` +
		`Authorization: ${authHeader}\r\n` +
		`Connection: close\r\n\r\n`;

	return new Promise((resolvePromise) => {
		let raw = '';
		let sentProbe = false;
		let settled = false;
		const socket = net.createConnection({ host, port }, () => socket.write(headRequest));
		const finish = (serverClosedEarly: boolean) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			socket.destroy();
			resolvePromise({ responses: raw.split('HTTP/1.1 200').length - 1, serverClosedEarly });
		};
		const timer = setTimeout(() => finish(false), timeoutMs);
		socket.on('data', (data: Buffer) => {
			raw += data.toString('latin1');
			if (!sentProbe && raw.includes('\r\n\r\n')) {
				sentProbe = true;
				socket.write(probeRequest);
			}
		});
		socket.on('end', () => finish(!sentProbe || raw.split('HTTP/1.1 200').length - 1 < 2));
		socket.on('error', () => finish(true));
	});
}

async function getProbeJson(restBase: string, authHeaders: Record<string, string>): Promise<any> {
	const url = new URL(`${restBase}/Probe/`);
	return new Promise((resolvePromise, reject) => {
		const req = http.request(
			url,
			{
				method: 'GET',
				headers: { ...authHeaders, Accept: 'application/json' },
				signal: AbortSignal.timeout(5000),
			} as any,
			(res) => {
				const chunks: Buffer[] = [];
				res.on('data', (d: Buffer) => chunks.push(d));
				res.on('end', () => {
					try {
						resolvePromise({ status: res.statusCode, ...JSON.parse(Buffer.concat(chunks).toString('utf8')) });
					} catch (e) {
						reject(e);
					}
				});
				res.on('error', reject);
			}
		);
		req.on('error', reject);
		req.end();
	});
}

function summarize(cap: RawCapture): string {
	return (
		`${cap.caseName.padEnd(24)} status=${String(cap.status).padEnd(5)} ` +
		`totalBytes=${String(cap.totalBytes).padEnd(6)} chunked=${String(cap.chunked).padEnd(5)} ` +
		`sawTerminalChunk=${String(cap.sawTerminalChunk).padEnd(5)} body=${JSON.stringify(cap.decodedBody.slice(0, 80))}`
	);
}

function decodedRecords(cap: RawCapture): any[] {
	if (cap.surface === 'sse') {
		return cap.decodedBody
			.split(/\r?\n/)
			.filter((line) => line.startsWith('data: '))
			.map((line) => JSON.parse(line.slice(6)));
	}
	if (cap.surface === 'ndjson') {
		return cap.decodedBody
			.split(/\r?\n/)
			.filter(Boolean)
			.map((line) => JSON.parse(line));
	}
	const records = JSON.parse(cap.decodedBody);
	ok(Array.isArray(records), `${cap.surface} response must be a JSON array`);
	return records;
}

// ── Suite ────────────────────────────────────────────────────────────────────────────────────

suite(
	`QA-890 stream-throw status: sse|ndjson|iterable-rest x pre-first-yield|mid-stream [variant=${VARIANT}]`,
	{ skip: skipSuite },
	(ctx: ContextWithHarper) => {
		let client: Client;
		let restBase = '';
		let authHeader = '';
		const captures: RawCapture[] = [];

		before(async () => {
			await setupHarperWithFixture(ctx, FIXTURE_PATH, {
				config: { threads: { count: 1 }, logging: { level: 'info' }, http: { compressionThreshold: 1200 } },
				env: {},
			});
			client = createApiClient(ctx.harper);
			restBase = client.restURL;
			authHeader = client.headers.Authorization as string;

			// Poll the probe route directly until non-404 -- do NOT call restartHttpWorkers() against a
			// pre-installed fixture, it races.
			const deadline = Date.now() + 30_000;
			let ready = false;
			while (Date.now() < deadline) {
				try {
					const p = await getProbeJson(restBase, { Authorization: authHeader });
					if (p.status !== 404) {
						ready = true;
						break;
					}
				} catch {
					/* not ready */
				}
				await sleep(250);
			}
			ok(ready, `Probe route never became ready within 30s at ${restBase}/Probe/`);
		});

		after(async () => {
			try {
				console.log(`\n[stream-error-contract][variant=${VARIANT}] RESULT TABLE`);
				for (const cap of captures) console.log(`  ${summarize(cap)}`);
			} finally {
				await teardownHarper(ctx);
			}
		});

		function assertMidStreamTermination(cap: RawCapture) {
			strictEqual(cap.status, 200, `${cap.surface} mid-stream response should start 200, got ${cap.status}`);
			const records = decodedRecords(cap);
			deepStrictEqual(records.slice(0, 2), [{ n: 0 }, { n: 1 }]);
			if (cap.surface === 'iterable-rest') {
				deepStrictEqual(records, [{ n: 0 }, { n: 1 }, { error: 'Error: QA890-iter-mid-stream' }]);
			} else {
				const source = cap.surface === 'sse' ? 'sse' : 'iter';
				deepStrictEqual(records, [{ n: 0 }, { n: 1 }, { error: 'Error', message: `QA890-${source}-mid-stream` }]);
			}
			strictEqual(cap.sawTerminalChunk, true, `${cap.surface} mid-stream response must complete its error record`);
			assertServerTerminated(cap);
		}

		function assertStartupError(cap: RawCapture, title: string) {
			strictEqual(cap.status, 500, `${cap.surface} immediate startup failure must return 500`);
			const [problem] = decodedRecords(cap);
			strictEqual(problem.status, 500);
			strictEqual(problem.code, 'Error');
			strictEqual(problem.title, title);
			assertServerTerminated(cap);
		}

		function assertDelayedError(cap: RawCapture, message: string) {
			strictEqual(cap.status, 200, `${cap.surface} delayed startup failure occurs after status commitment`);
			deepStrictEqual(decodedRecords(cap), [{ error: 'Error', message }]);
			strictEqual(cap.sawTerminalChunk, true, `${cap.surface} delayed error record must complete cleanly`);
			assertServerTerminated(cap);
		}

		function assertCleanCompletion(cap: RawCapture) {
			strictEqual(cap.status, 200, `expected 200, got ${cap.status}`);
			deepStrictEqual(decodedRecords(cap), [{ n: 0 }, { n: 1 }, { n: 2 }]);
			strictEqual(cap.sawTerminalChunk, true, `${cap.surface} clean response must include the terminal chunk`);
			assertServerTerminated(cap);
		}

		async function captureWithLifecycle(counterName: string, capture: () => Promise<RawCapture>) {
			const before = await getProbeJson(restBase, { Authorization: authHeader });
			strictEqual(before.status, 200, 'Probe/ must be available before a stream capture');
			const cap = await capture();
			const after = await getProbeJson(restBase, { Authorization: authHeader });
			strictEqual(after.status, 200, 'Probe/ must be available after a stream capture');
			strictEqual(after[counterName].opened - before[counterName].opened, 1, `${counterName} must open exactly once`);
			strictEqual(after[counterName].closed - before[counterName].closed, 1, `${counterName} must close exactly once`);
			return cap;
		}

		// ── Controls: clean completion baselines, one per surface ────────────────────────────────

		test('control: SseHealth clean completion', { timeout: 20_000 }, async () => {
			const cap = await captureWithLifecycle('sseHealth', () =>
				rawCapture(restBase, '/SseHealth/', 'text/event-stream', authHeader, 'sse', 'control')
			);
			captures.push(cap);
			assertCleanCompletion(cap);
		});

		test('control: IterHealth ndjson clean completion', { timeout: 20_000 }, async () => {
			const cap = await captureWithLifecycle('iterHealth', () =>
				rawCapture(restBase, '/IterHealth/', 'application/x-ndjson', authHeader, 'ndjson', 'control')
			);
			captures.push(cap);
			assertCleanCompletion(cap);
		});

		test('control: IterHealth iterable-rest (default json) clean completion', { timeout: 20_000 }, async () => {
			const cap = await captureWithLifecycle('iterHealth', () =>
				rawCapture(restBase, '/IterHealth/', 'application/json', authHeader, 'iterable-rest', 'control')
			);
			captures.push(cap);
			assertCleanCompletion(cap);
		});

		// A 1.0 response with no Content-Length is close-delimited whatever the client asked for
		for (const connection of [undefined, 'keep-alive']) {
			test(
				`control: IterHealth iterable-rest over HTTP/1.0${connection ? ` (Connection: ${connection})` : ''} clean completion`,
				{ timeout: 20_000, skip: VARIANT === 'uws' ? 'uWS does not serve HTTP/1.0 requests' : false },
				async () => {
					const cap = await captureWithLifecycle('iterHealth', () =>
						rawCapture(restBase, '/IterHealth/', 'application/json', authHeader, 'iterable-rest', 'control-http10', {
							http10: true,
							connection,
						})
					);
					captures.push(cap);
					strictEqual(cap.status, 200, `expected 200, got ${cap.status}`);
					deepStrictEqual(decodedRecords(cap), [{ n: 0 }, { n: 1 }, { n: 2 }]);
					assertServerTerminated(cap);
				}
			);
		}

		test('control: a keep-alive client is left connected and reuses the socket', { timeout: 20_000 }, async () => {
			const reuse = await captureKeepAliveReuse(restBase, '/IterHealth/', 'application/json', authHeader);
			strictEqual(reuse.serverClosedEarly, false, 'server closed a keep-alive connection after a streamed response');
			strictEqual(reuse.responses, 2, 'a keep-alive client must get both responses on one connection');
		});

		test('control: HEAD does not start or leak a streaming generator', { timeout: 20_000 }, async () => {
			const before = await getProbeJson(restBase, { Authorization: authHeader });
			const sse = await rawCapture(restBase, '/SseHealth/', 'text/event-stream', authHeader, 'sse', 'head', {
				method: 'HEAD',
			});
			const ndjson = await rawCapture(restBase, '/IterHealth/', 'application/x-ndjson', authHeader, 'ndjson', 'head', {
				method: 'HEAD',
				acceptEncoding: 'br',
			});
			const envelopeReuse = await captureHeadKeepAliveReuse(restBase, '/EnvelopeHead/', authHeader);
			await sleep(25);
			const after = await getProbeJson(restBase, { Authorization: authHeader });
			strictEqual(sse.status, 200);
			strictEqual(sse.decodedBody, '');
			strictEqual(ndjson.status, 200);
			strictEqual(ndjson.decodedBody, '');
			strictEqual(envelopeReuse.serverClosedEarly, false);
			strictEqual(envelopeReuse.responses, 2);
			strictEqual(after.sseHealth.opened, before.sseHealth.opened);
			strictEqual(after.iterHealth.closed, before.iterHealth.closed);
			strictEqual(after.envelopeHead.opened, before.envelopeHead.opened);
			strictEqual(after.envelopeHead.closed, before.envelopeHead.closed);
		});

		// ── Pre-first-yield throw: the core question ──────────────────────────────────────────────

		test('sse: pre-first-yield throw -- raw byte capture', { timeout: 20_000 }, async () => {
			const cap = await captureWithLifecycle('ssePreYield', () =>
				rawCapture(restBase, '/SsePreYield/', 'text/event-stream', authHeader, 'sse', 'pre-first-yield')
			);
			captures.push(cap);
			console.log(
				`[QA-890][sse/pre] status=${cap.status} totalBytes=${cap.totalBytes} socketEvents=\n  ${cap.socketEvents.join('\n  ')}`
			);
			assertStartupError(cap, 'QA890-sse-pre-yield');
		});

		test('ndjson: pre-first-yield throw -- raw byte capture', { timeout: 20_000 }, async () => {
			const cap = await captureWithLifecycle('iterPreYield', () =>
				rawCapture(restBase, '/IterPreYield/', 'application/x-ndjson', authHeader, 'ndjson', 'pre-first-yield')
			);
			captures.push(cap);
			console.log(
				`[QA-890][ndjson/pre] status=${cap.status} totalBytes=${cap.totalBytes} socketEvents=\n  ${cap.socketEvents.join('\n  ')}`
			);
			assertStartupError(cap, 'QA890-iter-pre-yield');
		});

		test('ndjson: startup error drops the abandoned stream compression header', { timeout: 20_000 }, async () => {
			const cap = await captureWithLifecycle('iterPreYield', () =>
				rawCapture(restBase, '/IterPreYield/', 'application/x-ndjson', authHeader, 'ndjson', 'pre-compressed', {
					acceptEncoding: 'br',
				})
			);
			captures.push(cap);
			assertStartupError(cap, 'QA890-iter-pre-yield');
			strictEqual(cap.headers['content-encoding'], undefined);
		});

		test('iterable-rest: pre-first-yield throw -- raw byte capture', { timeout: 20_000 }, async () => {
			const cap = await captureWithLifecycle('iterPreYield', () =>
				rawCapture(restBase, '/IterPreYield/', 'application/json', authHeader, 'iterable-rest', 'pre-first-yield')
			);
			captures.push(cap);
			console.log(
				`[QA-890][iterable-rest/pre] status=${cap.status} totalBytes=${cap.totalBytes} decodedBody=${cap.decodedBody}`
			);
			console.log(`[QA-890][iterable-rest/pre] socketEvents=\n  ${cap.socketEvents.join('\n  ')}`);
			assertServerTerminated(cap);
		});

		test('sse: delayed pre-first-yield throw becomes an error event', { timeout: 20_000 }, async () => {
			const cap = await captureWithLifecycle('sseDelayedError', () =>
				rawCapture(restBase, '/SseDelayedError/', 'text/event-stream', authHeader, 'sse', 'delayed-error')
			);
			captures.push(cap);
			assertDelayedError(cap, 'QA890-sse-delayed-error');
		});

		test('ndjson: delayed pre-first-yield throw becomes an error record', { timeout: 20_000 }, async () => {
			const cap = await captureWithLifecycle('iterDelayedError', () =>
				rawCapture(restBase, '/IterDelayedError/', 'application/x-ndjson', authHeader, 'ndjson', 'delayed-error')
			);
			captures.push(cap);
			assertDelayedError(cap, 'QA890-iter-delayed-error');
		});

		// ── Mid-stream throw: cheap contrast arm (already understood) ────────────────────────────

		test('sse: mid-stream throw (2 of 5) -- raw byte capture', { timeout: 20_000 }, async () => {
			const cap = await captureWithLifecycle('sseMidStream', () =>
				rawCapture(restBase, '/SseMidStream/', 'text/event-stream', authHeader, 'sse', 'mid-stream')
			);
			captures.push(cap);
			console.log(
				`[QA-890][sse/mid] status=${cap.status} totalBytes=${cap.totalBytes} sawTerminalChunk=${cap.sawTerminalChunk}`
			);
			assertMidStreamTermination(cap);
		});

		test('ndjson: mid-stream throw (2 of 5) -- raw byte capture', { timeout: 20_000 }, async () => {
			const cap = await captureWithLifecycle('iterMidStream', () =>
				rawCapture(restBase, '/IterMidStream/', 'application/x-ndjson', authHeader, 'ndjson', 'mid-stream')
			);
			captures.push(cap);
			console.log(
				`[QA-890][ndjson/mid] status=${cap.status} totalBytes=${cap.totalBytes} sawTerminalChunk=${cap.sawTerminalChunk}`
			);
			assertMidStreamTermination(cap);
		});

		test('iterable-rest: mid-stream throw (2 of 5) -- raw byte capture', { timeout: 20_000 }, async () => {
			const cap = await captureWithLifecycle('iterMidStream', () =>
				rawCapture(restBase, '/IterMidStream/', 'application/json', authHeader, 'iterable-rest', 'mid-stream')
			);
			captures.push(cap);
			console.log(
				`[QA-890][iterable-rest/mid] status=${cap.status} totalBytes=${cap.totalBytes} decodedBody=${cap.decodedBody}`
			);
			assertMidStreamTermination(cap);
		});

		test('Z: liveness canary -- worker survived every throw shape above', { timeout: 30_000 }, async () => {
			const health = await rawCapture(restBase, '/SseHealth/', 'text/event-stream', authHeader, 'sse', 'canary');
			assertCleanCompletion(health);

			const p = await getProbeJson(restBase, { Authorization: authHeader }).catch(() => null);
			console.log(`[QA-890][Z] probe counters: ${p ? JSON.stringify(p) : 'DEAD'}`);
			ok(p !== null, 'Harper must still respond to Probe/ after all streaming cases');
			strictEqual(p.status, 200, `Probe/ must 200, got ${p.status}`);
			for (const name of [
				'ssePreYield',
				'sseDelayedError',
				'sseMidStream',
				'sseHealth',
				'iterPreYield',
				'iterDelayedError',
				'iterMidStream',
				'iterHealth',
			]) {
				strictEqual(p[name]?.opened, p[name]?.closed, `${name} generator was not closed`);
			}
		});
	}
);
