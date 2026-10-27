/**
 * harper#2392 — a streamed JSON-array read that fails after its 200 head must not arrive as a
 * complete array.
 *
 * Realistic trigger: a client stops reading a large REST collection query for longer than
 * `storage.maxTransactionOpenTime`. The transaction monitor closes the stalled read iterators, and
 * when the client drains the scan resumes and throws `ReadSnapshotExpiredError`. The response must
 * then be cut off (no closing `]`, no chunked terminator) rather than end as a well-formed shorter
 * array with an `{"error": ...}` row.
 */
import { suite, test, before, after } from 'node:test';
import { ok, strictEqual, throws } from 'node:assert';
import { join, resolve } from 'node:path';
import { existsSync, readFileSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';
import net from 'node:net';
import { setupHarperWithFixture, teardownHarper, type ContextWithHarper } from '@harperfast/integration-testing';

const FIXTURE_PATH = resolve(import.meta.dirname, 'stream-snapshot-expiry');
const MAX_TXN_OPEN_MS = 1000;
const ROWS = 20_000;
// ~40 MB of response, several times what loopback socket buffers absorb, so a paused client stalls the scan
const PAD = 'x'.repeat(2000);
const SEED_BATCH = 1000;
const QUERY = '/StallRow/?group=g&select(id,pad)';

interface Capture {
	status: number | null;
	sawTerminalChunk: boolean;
	body: string;
	clientTimedOut: boolean;
}

function decodeChunked(raw: Buffer): Omit<Capture, 'clientTimedOut'> {
	const headerEnd = raw.indexOf('\r\n\r\n');
	if (headerEnd === -1) return { status: null, sawTerminalChunk: false, body: '' };
	const status = Number.parseInt(raw.subarray(0, headerEnd).toString('latin1').split(' ')[1], 10);
	const bodyRaw = raw.subarray(headerEnd + 4);
	const parts: Buffer[] = [];
	let offset = 0;
	let sawTerminalChunk = false;
	while (offset < bodyRaw.length) {
		const lineEnd = bodyRaw.indexOf('\r\n', offset);
		if (lineEnd === -1) break;
		const size = Number.parseInt(bodyRaw.subarray(offset, lineEnd).toString('latin1'), 16);
		if (!Number.isSafeInteger(size)) break;
		if (size === 0) {
			sawTerminalChunk = true;
			break;
		}
		const dataEnd = lineEnd + 2 + size;
		parts.push(bodyRaw.subarray(lineEnd + 2, Math.min(dataEnd, bodyRaw.length)));
		if (dataEnd > bodyRaw.length) break;
		offset = dataEnd + 2;
	}
	return { status, sawTerminalChunk, body: Buffer.concat(parts).toString('utf8') };
}

function stalledGet(
	httpURL: string,
	auth: string,
	opts: { pauseAfterBytes?: number; stallMs?: number; timeoutMs: number }
): Promise<Capture> {
	const url = new URL(httpURL);
	return new Promise((resolvePromise) => {
		const chunks: Buffer[] = [];
		let received = 0;
		let paused = false;
		let clientTimedOut = false;
		const socket = net.createConnection({ host: url.hostname, port: Number(url.port) }, () => {
			socket.write(
				`GET ${QUERY} HTTP/1.1\r\nHost: ${url.host}\r\nAccept: application/json\r\n` +
					`Authorization: ${auth}\r\nConnection: close\r\n\r\n`
			);
		});
		const timer = setTimeout(() => {
			clientTimedOut = true;
			socket.destroy();
		}, opts.timeoutMs);
		socket.on('data', (data: Buffer) => {
			chunks.push(data);
			received += data.length;
			if (!paused && opts.pauseAfterBytes && received >= opts.pauseAfterBytes) {
				paused = true;
				socket.pause();
				setTimeout(() => socket.resume(), opts.stallMs);
			}
		});
		socket.on('error', () => {});
		socket.on('close', () => {
			clearTimeout(timer);
			resolvePromise({ ...decodeChunked(Buffer.concat(chunks)), clientTimedOut });
		});
	});
}

function rowCount(body: string): number {
	return body.split('"id":').length - 1;
}

suite('streamed JSON read past the open-transaction limit (harper#2392)', (ctx: ContextWithHarper) => {
	let httpURL = '';
	let auth = '';

	before(async () => {
		await setupHarperWithFixture(ctx, FIXTURE_PATH, {
			config: {
				storage: { maxTransactionOpenTime: MAX_TXN_OPEN_MS },
				threads: { count: 1 },
				logging: { level: 'warn' },
			},
			env: {},
		});
		httpURL = ctx.harper.httpURL;
		auth = 'Basic ' + Buffer.from(`${ctx.harper.admin.username}:${ctx.harper.admin.password}`).toString('base64');
		const deadline = Date.now() + 30_000;
		while (Date.now() < deadline) {
			const probe = await fetch(`${httpURL}/StallRow/?id=none`, { headers: { Authorization: auth } }).catch(() => null);
			if (probe?.status === 200) break;
			await sleep(250);
		}
		for (let start = 0; start < ROWS; start += SEED_BATCH) {
			const records = [];
			for (let i = start; i < start + SEED_BATCH; i++)
				records.push({ id: String(i).padStart(6, '0'), group: 'g', pad: PAD });
			const response = await fetch(ctx.harper.operationsAPIURL, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json', 'Authorization': auth },
				body: JSON.stringify({ operation: 'insert', database: 'data', table: 'StallRow', records }),
			});
			strictEqual(response.status, 200, `seeding failed: ${await response.text()}`);
		}
	});

	after(async () => {
		await teardownHarper(ctx);
	});

	function harperLog(): string {
		// logDir is set only under HARPER_INTEGRATION_TEST_LOG_DIR; otherwise Harper logs under its root path
		const path = join(ctx.harper.logDir ?? join(ctx.harper.dataRootDir, 'log'), 'hdb.log');
		return existsSync(path) ? readFileSync(path, 'utf8') : '';
	}

	test('control: an unstalled read returns every row as complete JSON', { timeout: 60_000 }, async () => {
		const cap = await stalledGet(httpURL, auth, { timeoutMs: 50_000 });
		strictEqual(cap.status, 200);
		strictEqual(cap.sawTerminalChunk, true);
		const rows = JSON.parse(cap.body);
		strictEqual(rows.length, ROWS);
		strictEqual(new Set(rows.map((row) => row.id)).size, ROWS);
	});

	test(
		'a client stalled past the limit gets a cut-off response, not a shorter array',
		{ timeout: 90_000 },
		async () => {
			const cap = await stalledGet(httpURL, auth, {
				pauseAfterBytes: 256 * 1024,
				stallMs: MAX_TXN_OPEN_MS * 6,
				timeoutMs: 60_000,
			});
			strictEqual(cap.clientTimedOut, false, 'the server must end the response itself');
			strictEqual(cap.status, 200);
			const received = rowCount(cap.body);
			ok(received > 0 && received < ROWS, `expected a partial result, got ${received} of ${ROWS} rows`);
			// the body's diagnostic element is best-effort, so the server log is the fallback evidence
			ok(
				cap.body.includes('ReadSnapshotExpiredError') || harperLog().includes('ReadSnapshotExpiredError'),
				`the scan must have failed on the expired snapshot; body ends ${JSON.stringify(cap.body.slice(-300))}`
			);
			strictEqual(cap.sawTerminalChunk, false, 'a failed stream must not send the chunked terminator');
			throws(() => JSON.parse(cap.body), SyntaxError, 'a partial result must not parse as a complete array');
		}
	);

	test('the worker still serves reads afterwards', { timeout: 60_000 }, async () => {
		const response = await fetch(`${httpURL}/StallRow/000001`, { headers: { Authorization: auth } });
		strictEqual(response.status, 200);
		strictEqual((await response.json()).id, '000001');
	});
});
