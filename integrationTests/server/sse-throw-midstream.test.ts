/**
 * QA-559 — regression verify for #1789 "Fix SSE hang + uncaughtException when a generator
 * throws mid-stream" (commit 8930b1ef2), the error-path sibling of #1628/#1632 (QA-537) and
 * our earlier filed finding F-133.
 *
 * Bug recap (see server/http.ts, `pipeBodyToResponse` / the old inline `body.pipe(nodeResponse)`
 * wiring in the Node HTTP requestHandler): the plain Node HTTP path piped a streaming response
 * body with a bare `body.pipe(nodeResponse)` and never attached an 'error' listener on the
 * source. `pipe()` does not forward the source's 'error' event to the destination, and an
 * unhandled 'error' on an EventEmitter is a Node `uncaughtException` — contentTypes.ts's
 * serializeStream()/Readable.from already surfaced a mid-iteration generator rejection
 * correctly as an 'error' event, it just had no listener downstream. The net effect (F-133):
 * an async generator streamed over SSE that threw partway through left the HTTP response open
 * forever (client hangs) AND crashed the process with an uncaughtException.
 *
 * The fix extracts an exported `pipeBodyToResponse(body, nodeResponse, ...)` helper that wires
 * the pipe via `stream.pipeline()` instead of a bare `.pipe()`. `pipeline()` tears down both
 * sides symmetrically: a source 'error' destroys the response too, closing the connection
 * (abruptly, not via a clean `.end()` — deliberate, per PR review, so the client doesn't get
 * misled into thinking a truncated transfer completed normally). So post-fix, a client
 * consuming an SSE stream whose generator throws mid-iteration should observe the HTTP
 * response terminate (via 'end', 'error', or 'close' — any of the three, per the updated unit
 * test in contentTypes.test.js) in bounded time, receiving only the events flushed before the
 * throw, with NO uncaughtException logged and the worker still alive afterward.
 *
 * This suite starts from the QA-537 harness/fixture pattern (qa-scratch/qa537-sse-finite-
 * generator/) and its `ThrowGen` case, which *documented* (did not assert) the pre-fix hang.
 * Here the throw cases are promoted to hard assertions of clean termination:
 *   ThrowFirst - throws on the very first step, before any bytes are yielded.
 *   ThrowMid   - yields 3 of an intended 6 events, then throws (genuine mid-stream failure).
 *   CleanGen   - control: 5 events then natural completion, no throw at all.
 *
 * Every request is wrapped in an AbortController with a bounded (12-15s) timeout, so if the
 * regression were present, the test would fail/timeout deterministically instead of hanging the
 * whole run forever. After the throw cases, a plain Probe/ request confirms the server process
 * is still healthy (no uncaughtException crashed/wedged a worker), and the hdb.log is scanned
 * for any newly-appeared `uncaughtException` lines.
 *
 * Harper SHA under test: 182971ad1 (includes fix commit 8930b1ef2, confirmed via
 * `git merge-base --is-ancestor 8930b1ef2 182971ad1`).
 *
 * Reproduction:
 *   npm run test:integration -- "integrationTests/server/sse-throw-midstream.test.ts"
 */
import { suite, test, before, after } from 'node:test';
import { ok, strictEqual } from 'node:assert';
import { resolve, join } from 'node:path';
import { readFileSync } from 'node:fs';
import { StringDecoder } from 'node:string_decoder';
import { setTimeout as sleep } from 'node:timers/promises';
import http from 'node:http';
import https from 'node:https';
import { URL } from 'node:url';
import { setupHarperWithFixture, teardownHarper, type ContextWithHarper } from '@harperfast/integration-testing';
// @ts-expect-error utils/client.mjs has no type declarations; runtime resolves fine
import { createApiClient } from '../apiTests/utils/client.mjs';

const FIXTURE_PATH = resolve(import.meta.dirname, 'sse-throw-midstream');
const skipSuite = process.platform === 'win32';

type Client = ReturnType<typeof createApiClient>;

interface ProbeSnap {
	ok: boolean;
	throwFirst: { opened: number; closed: number };
	throwMid: { opened: number; closed: number };
	clean: { opened: number; closed: number };
}

async function getProbe(restBase: string, authHeaders: Record<string, string>): Promise<ProbeSnap> {
	const url = new URL(`${restBase}/Probe/`);
	const lib = url.protocol === 'https:' ? https : http;
	return new Promise((resolvePromise, reject) => {
		const req = lib.request(
			url,
			{
				method: 'GET',
				headers: { ...authHeaders, Accept: 'application/json' },
				rejectUnauthorized: false,
				signal: AbortSignal.timeout(3_000),
			} as any,
			(res) => {
				const chunks: Buffer[] = [];
				res.on('data', (d: Buffer) => chunks.push(d));
				res.on('end', () => {
					try {
						resolvePromise(JSON.parse(Buffer.concat(chunks).toString('utf8')));
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

async function waitForProbe(
	restBase: string,
	authHeaders: Record<string, string>,
	predicate: (probe: ProbeSnap) => boolean,
	timeoutMs = 5_000
): Promise<ProbeSnap | null> {
	const deadline = Date.now() + timeoutMs;
	let probe: ProbeSnap | null = null;
	while (Date.now() < deadline) {
		probe = await getProbe(restBase, authHeaders).catch(() => null);
		if (probe && predicate(probe)) return probe;
		await sleep(50);
	}
	return probe;
}

// ── AbortController-bounded SSE stream consumer ──────────────────────────────────────────
// Wraps the request in an AbortController with a generous but bounded timeout, so a genuine
// regression (hung response) shows up as a caught timeout/abort in the test, never a hung
// process. Resolves on whichever of 'end' / 'error' / 'close' fires first, since the fixed
// pipeline()-based teardown closes the response abruptly (not via a clean 'end') on a source
// error -- see PR #1789.

interface SseResult {
	status: number;
	raw: string;
	events: string[]; // parsed `data: ...` payloads, in order
	terminatedBy: 'end' | 'error' | 'close' | null; // which event resolved the request
	aborted: boolean; // did our own timeout abort fire (i.e. it hung)?
	errored: Error | null;
	elapsedMs: number;
}

function consumeSse(urlStr: string, authHeaders: Record<string, string>, timeoutMs = 12_000): Promise<SseResult> {
	const url = new URL(urlStr);
	const lib = url.protocol === 'https:' ? https : http;
	const controller = new AbortController();
	let timedOut = false;
	const start = Date.now();
	const timer = setTimeout(() => {
		timedOut = true;
		controller.abort();
	}, timeoutMs);

	return new Promise((resolvePromise) => {
		const result: SseResult = {
			status: 0,
			raw: '',
			events: [],
			terminatedBy: null,
			aborted: false,
			errored: null,
			elapsedMs: 0,
		};
		let settled = false;
		const finish = (terminatedBy: SseResult['terminatedBy'], err?: Error) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			result.terminatedBy = terminatedBy;
			result.errored = err ?? null;
			result.elapsedMs = Date.now() - start;
			result.events = result.raw
				.split('\n')
				.filter((l) => l.startsWith('data: '))
				.map((l) => l.slice('data: '.length));
			resolvePromise(result);
		};
		const req = lib.request(
			url,
			{
				method: 'GET',
				headers: { ...authHeaders, Accept: 'text/event-stream' },
				rejectUnauthorized: false,
				signal: controller.signal,
			} as any,
			(res) => {
				result.status = res.statusCode ?? 0;
				// Decode incrementally: a bare d.toString('utf8') per chunk corrupts any multi-byte
				// character that straddles a TCP chunk boundary into U+FFFD.
				const decoder = new StringDecoder('utf8');
				res.on('data', (d: Buffer) => {
					result.raw += decoder.write(d);
				});
				res.on('end', () => {
					result.raw += decoder.end();
					finish('end');
				});
				res.on('error', (e: Error) => finish('error', e));
				res.on('close', () => finish('close'));
			}
		);
		req.on('error', (e: any) => {
			if (timedOut || e?.name === 'AbortError') {
				if (settled) return;
				settled = true;
				clearTimeout(timer);
				result.aborted = true;
				result.elapsedMs = Date.now() - start;
				result.events = result.raw
					.split('\n')
					.filter((l) => l.startsWith('data: '))
					.map((l) => l.slice('data: '.length));
				resolvePromise(result);
			} else {
				finish('error', e);
			}
		});
		req.end();
	});
}

function readLogSafe(logPath: string): string {
	try {
		return readFileSync(logPath, 'utf8');
	} catch {
		return '';
	}
}

function countUncaught(log: string): number {
	return log.split('\n').filter((l) => l.includes('uncaughtException')).length;
}

/**
 * Asserting a NON-event: the worker logs an uncaughtException asynchronously, so reading hdb.log
 * the instant the response closes can pass vacuously by simply outrunning the flush. Give the
 * writer a bounded settle first — one of the cases AGENTS.md reserves a fixed sleep for.
 */
async function uncaughtAfterSettle(logPath: string): Promise<number> {
	await sleep(1_000);
	return countUncaught(readLogSafe(logPath));
}

// ── Suite ──────────────────────────────────────────────────────────────────────────────────

suite(
	'QA-559 SSE throw-mid-stream regression verify (#1789 / commit 8930b1ef2)',
	{ skip: skipSuite },
	(ctx: ContextWithHarper) => {
		let client: Client;
		let restBase = '';
		let authHeaders: Record<string, string> = {};
		let logPath = '';

		before(async () => {
			await setupHarperWithFixture(ctx, FIXTURE_PATH, {
				config: { threads: { count: 1 }, logging: { console: true, level: 'error' } },
				env: {},
			});
			client = createApiClient(ctx.harper);
			restBase = client.restURL;
			authHeaders = { Authorization: client.headers.Authorization as string };
			logPath = (ctx.harper as any).logDir
				? join((ctx.harper as any).logDir, 'hdb.log')
				: join((ctx.harper as any).dataRootDir, 'log', 'hdb.log');

			const deadline = Date.now() + 30_000;
			let ready = false;
			while (Date.now() < deadline) {
				try {
					const p = await getProbe(restBase, authHeaders);
					if (p?.ok !== undefined) {
						ready = true;
						break;
					}
				} catch {
					/* not ready */
				}
				await sleep(250);
			}
			ok(ready, 'Probe route did not become ready within 30 seconds');
			readFileSync(logPath, 'utf8');
		});

		after(async () => {
			await teardownHarper(ctx);
		});

		// ── 1: throw on the very first step, before any bytes ────────────────────────────────

		test(
			'1: ThrowFirst -- throws before any yield; response terminates in bounded time, no uncaughtException',
			{ timeout: 25_000 },
			async () => {
				const logBefore = readLogSafe(logPath);
				const uncaughtBefore = countUncaught(logBefore);

				const r = await consumeSse(`${restBase}/ThrowFirst/`, authHeaders, 15_000);
				console.log(
					`[QA-559][1] ThrowFirst: status=${r.status} events=${r.events.length} terminatedBy=${r.terminatedBy} aborted=${r.aborted} errored=${r.errored?.message ?? null} elapsedMs=${r.elapsedMs}`
				);

				ok(
					!r.aborted,
					`must not hit the AbortController timeout -- a timeout here indicates the #1789 hang regressed. raw:\n${r.raw}`
				);
				ok(r.terminatedBy !== null, 'response must terminate via end/error/close, not hang indefinitely');
				strictEqual(
					r.events.length,
					0,
					`expected 0 events (throw before any yield), got ${r.events.length}. raw:\n${r.raw}`
				);

				const probe = await waitForProbe(restBase, authHeaders, (snapshot) => snapshot.throwFirst.closed >= 1);
				ok(probe && probe.throwFirst.closed >= 1, 'ThrowFirst generator should have completed cleanup');
				const uncaughtAfter = await uncaughtAfterSettle(logPath);
				strictEqual(
					uncaughtAfter - uncaughtBefore,
					0,
					'no NEW uncaughtException should be logged for a throw-before-first-yield generator'
				);
			}
		);

		// ── 2: throw mid-stream, after some events already flushed ──────────────────────────

		test(
			'2: ThrowMid -- yields 3 of 6 then throws; pre-error events delivered, response terminates cleanly, no uncaughtException',
			{ timeout: 25_000 },
			async () => {
				const logBefore = readLogSafe(logPath);
				const uncaughtBefore = countUncaught(logBefore);

				const r = await consumeSse(`${restBase}/ThrowMid/`, authHeaders, 15_000);
				console.log(
					`[QA-559][2] ThrowMid: status=${r.status} events=${r.events.length} terminatedBy=${r.terminatedBy} aborted=${r.aborted} errored=${r.errored?.message ?? null} elapsedMs=${r.elapsedMs}`
				);

				ok(
					!r.aborted,
					`must not hit the AbortController timeout -- a timeout here indicates the #1789 hang regressed. raw:\n${r.raw}`
				);
				ok(r.terminatedBy !== null, 'response must terminate via end/error/close, not hang indefinitely');
				ok(
					r.events.length >= 1 && r.events.length <= 3,
					`expected a 1-3 event prefix before the abrupt close, got ${r.events.length}. raw:\n${r.raw}`
				);
				for (let i = 0; i < r.events.length; i++) {
					ok(r.events[i].includes(`"n":${i}`), `expected event ${i} to contain n=${i}, got: ${r.events[i]}`);
				}

				const probe = await waitForProbe(restBase, authHeaders, (snapshot) => snapshot.throwMid.closed >= 1);
				ok(probe && probe.throwMid.closed >= 1, 'ThrowMid generator should have completed cleanup');
				const uncaughtAfter = await uncaughtAfterSettle(logPath);
				strictEqual(
					uncaughtAfter - uncaughtBefore,
					0,
					'no NEW uncaughtException should be logged for a mid-stream throw'
				);
			}
		);

		// ── 3: control -- finite generator completes cleanly, no throw ──────────────────────

		test(
			'3: CleanGen (control, N=5) -- all 5 events arrive and the response closes cleanly via end',
			{ timeout: 20_000 },
			async () => {
				const r = await consumeSse(`${restBase}/CleanGen/`, authHeaders, 15_000);
				ok(r.status >= 200 && r.status < 300, `expected 2xx, got ${r.status}`);
				strictEqual(r.events.length, 5, `expected 5 SSE data events, got ${r.events.length}. raw:\n${r.raw}`);
				for (let i = 0; i < 5; i++) {
					ok(r.events[i].includes(`"n":${i}`), `expected event ${i} to contain n=${i}, got: ${r.events[i]}`);
				}
				ok(!r.aborted, 'must not hit the AbortController timeout on a completing control generator');
				strictEqual(
					r.terminatedBy,
					'end',
					`a non-throwing generator should close via a clean 'end', got terminatedBy=${r.terminatedBy}`
				);
			}
		);

		// ── Z: liveness canary + final uncaughtException sweep ──────────────────────────────

		test(
			'Z: liveness canary -- server survived all throw-mid-stream probes, no new uncaughtException',
			{ timeout: 30_000 },
			async () => {
				const logBefore = readLogSafe(logPath);
				const p = await waitForProbe(
					restBase,
					authHeaders,
					(snapshot) => snapshot.throwFirst.closed >= 1 && snapshot.throwMid.closed >= 1 && snapshot.clean.closed >= 1
				);
				console.log(`[QA-559][Z] liveness probe: ${p ? 'alive' : 'DEAD'} ${p ? JSON.stringify(p) : ''}`);
				ok(
					p !== null,
					'Harper must still respond to Probe/ after all throw-mid-stream cases (worker not crashed/wedged)'
				);
				ok(
					p!.throwFirst.opened >= 1 && p!.throwFirst.closed >= 1,
					'ThrowFirst should show a matched open/close pair (generator finally ran)'
				);
				ok(
					p!.throwMid.opened >= 1 && p!.throwMid.closed >= 1,
					'ThrowMid should show a matched open/close pair (generator finally ran)'
				);
				ok(p!.clean.opened >= 1 && p!.clean.closed >= 1, 'CleanGen should show a matched open/close pair');

				await sleep(1_000); // same non-event settle as the per-case sweeps above
				const logAfter = readLogSafe(logPath);
				const newLines = logAfter.slice(logBefore.length);
				const newUncaught = newLines.split('\n').filter((l) => l.includes('uncaughtException')).length;
				if (newUncaught > 0) {
					console.log(
						`[QA-559][Z] NEW uncaughtException lines found:\n${newLines
							.split('\n')
							.filter((l) => l.includes('uncaughtException'))
							.join('\n')}`
					);
				}
				strictEqual(newUncaught, 0, 'no uncaughtException should have appeared anywhere across the whole suite');
			}
		);
	}
);
