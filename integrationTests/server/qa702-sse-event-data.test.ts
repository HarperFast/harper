/**
 * Promoted from qa-explorer (QA-702 / P-478): pins the Resource SSE contract — an 8-case
 * event-data payload matrix (undefined/null/''/0/false/object/nested/~300KB string) never
 * crashes a worker and the connection stays healthy, plus the F-133 mid-stream-throw
 * regression leg + a liveness canary.
 *
 * QA-702 — companion coverage for #1863 "fix: guard SSE writes against undefined event data
 * (#1724)" (commit 6bcd5cd29, merged 2026-07-21 into HarperFast/harper), PLUS a
 * re-characterization of the open sibling F-133 finding (SSE mid-stream throw hang) on current
 * main.
 *
 * (a) NOT the #1863 regression anchor — that's unitTests/server/serverHelpers/progressEmitter.test.js,
 *     which imports server/serverHelpers/progressEmitter.ts's `writeSSE()` directly and already
 *     exercises undefined/null payloads against the actual fixed guard. This suite CANNOT reach
 *     that function at all: it's wired up ONLY inside serverHandlers.js for the operations-API
 *     SSE_PROGRESS_OPERATIONS set (deploy_component / get_deployment / read_log), none of which let
 *     a test inject an arbitrary `data` value, and jsResource fixtures run from an isolated copied
 *     component root that CANNOT `import` the live repo's internal server/ modules (confirmed: a
 *     relative `../../../server/serverHelpers/progressEmitter.ts` import throws
 *     `ResourceLoadError: Cannot find module ...` — a sandboxing boundary, not a bug). Reaching the
 *     real Operations API progress stream, or unifying it with the encoder below into one shared
 *     serialization contract, are both real code changes out of scope for this test-only PR.
 *
 *     So instead, this suite covers the SIBLING encoder any Harper Resource client actually sees:
 *     contentTypes.ts's `text/event-stream` media-type `serialize()`, invoked via
 *     `resource.connect()`. Its falsy-data/id guards are asserted here against absence
 *     (undefined/null), not truthiness — see integrationTests/qa-scratch/qa702-sse-event-data/
 *     resources.js for the full writeup.
 *
 * (b) F-133 re-characterization: does a resource.connect() async generator that throws mid-stream
 *     still hang the response? Git archaeology first: commits 06f5fcff8/8930b1ef2 ("Fix SSE hang +
 *     uncaughtException when a generator throws mid-stream", #1763/#1789) landed in
 *     server/http.ts's `pipeBodyToResponse` (wires an 'error' listener on the streamed body so a
 *     Readable.from(generator) rejection propagates to the response instead of an unhandled
 *     'error' event / uncaughtException + hung connection). 8930b1ef2 IS an ancestor of this SHA
 *     (2615b092b) -- so the expectation is FIXED. ThrowGen below empirically confirms that,
 *     bounded by an AbortController + timeout so a regression surfaces as a caught timeout, never
 *     an infinite hang eating the whole test run.
 *
 * After the stream cases, a liveness probe: HealthGen (a second clean SSE stream) plus Probe
 * (plain GET on a normal route, and open/close lifecycle counters) confirm the worker survived
 * everything above.
 *
 * Harper SHA under test: 2615b092b (includes #1863's fix commit 6bcd5cd29 and #1763/#1789's fix
 * commit 8930b1ef2, both confirmed ancestors via `git merge-base --is-ancestor`).
 *
 * Reproduction:
 *   npm run test:integration -- "integrationTests/server/qa702-sse-event-data.test.ts"
 */
import { suite, test, before, after } from 'node:test';
import { ok, strictEqual, deepStrictEqual } from 'node:assert';
import { resolve, join } from 'node:path';
import { readFileSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';
import http from 'node:http';
import https from 'node:https';
import { URL } from 'node:url';
import { setupHarperWithFixture, teardownHarper, type ContextWithHarper } from '@harperfast/integration-testing';
// @ts-expect-error utils/client.mjs has no type declarations; runtime resolves fine
import { createApiClient } from '../apiTests/utils/client.mjs';

const FIXTURE_PATH = resolve(import.meta.dirname, 'qa702-sse-event-data');
const skipSuite = process.platform === 'win32';

type Client = ReturnType<typeof createApiClient>;

interface ProbeSnap {
	ok: boolean;
	throwGen: { opened: number; closed: number };
	healthGen: { opened: number; closed: number };
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
				// A hung server would otherwise block this readiness poll's while loop indefinitely;
				// bound it so a stuck request fails fast and the loop can retry or time out cleanly.
				signal: AbortSignal.timeout(5000),
			} as any,
			(res) => {
				const chunks: Buffer[] = [];
				res.on('data', (d: Buffer) => chunks.push(d));
				res.on('end', () => {
					try {
						resolvePromise({ status: res.statusCode, ...JSON.parse(Buffer.concat(chunks).toString('utf8')) } as any);
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

// ── AbortController-bounded SSE stream consumer ──────────────────────────────────────────
// Every request is wrapped in an AbortController with a bounded timeout, so a genuine hang
// regression shows up as a caught, deterministic `aborted` result, never an infinite hang.
// Also tracks a plain `closed` (the socket/response closed, 'end' or not) distinctly from
// `ended` (a clean SSE completion) -- an abrupt-but-PROMPT close is "not hung", just not a
// graceful finish; that distinction is exactly what the F-133 re-check needs to report.

interface SseResult {
	status: number;
	raw: string;
	ended: boolean; // response 'end' fired (graceful completion)
	closed: boolean; // response 'close' fired (with or without a prior 'end')
	aborted: boolean; // OUR OWN timeout fired -- the hang signal
	errored: Error | null;
}

function consumeSse(urlStr: string, authHeaders: Record<string, string>, timeoutMs = 12_000): Promise<SseResult> {
	const url = new URL(urlStr);
	const lib = url.protocol === 'https:' ? https : http;
	const controller = new AbortController();
	let timedOut = false;
	const timer = setTimeout(() => {
		timedOut = true;
		controller.abort();
	}, timeoutMs);

	return new Promise((resolvePromise) => {
		const result: SseResult = { status: 0, raw: '', ended: false, closed: false, aborted: false, errored: null };
		let settled = false;
		const finish = () => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
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
				res.on('data', (d: Buffer) => {
					result.raw += d.toString('utf8');
				});
				res.on('end', () => {
					result.ended = true;
				});
				res.on('close', () => {
					result.closed = true;
					finish();
				});
				res.on('error', (e: Error) => {
					result.errored = e;
				});
			}
		);
		req.on('error', (e: any) => {
			if (timedOut || e?.name === 'AbortError') result.aborted = true;
			else result.errored = e;
			finish();
		});
		req.end();
	});
}

// Groups raw SSE bytes into blank-line-delimited { event, data } records (mirrors the
// unitTests/server/serverHelpers/progressEmitter.test.js parseSSEBlocks helper). Assumes no
// record's `data` value contains an embedded newline (true for every case in this suite).
function parseSseBlocks(raw: string): Array<Record<string, string>> {
	return raw
		.split('\n\n')
		.filter((block) => block.trim().length > 0)
		.map((block) => {
			const out: Record<string, string> = {};
			for (const line of block.split('\n')) {
				const colon = line.indexOf(':');
				if (colon === -1) continue;
				const field = line.slice(0, colon);
				let value = line.slice(colon + 1);
				if (value.startsWith(' ')) value = value.slice(1);
				out[field] = value;
			}
			return out;
		})
		.filter((rec) => 'event' in rec || 'data' in rec || 'id' in rec || 'retry' in rec);
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

const LARGE_STRING = 'QA702-large-payload-'.repeat(15_000); // must match resources.js

// ── Suite ──────────────────────────────────────────────────────────────────────────────────

suite(
	'QA-702 SSE event-data payload matrix (contentTypes.ts encoder, sibling to the #1863 fix) + F-133 throw-path recheck',
	{ skip: skipSuite },
	(ctx: ContextWithHarper) => {
		let client: Client;
		let restBase = '';
		let authHeaders: Record<string, string> = {};
		let logPath = '';

		before(async () => {
			await setupHarperWithFixture(ctx, FIXTURE_PATH, {
				// 'error' would make the uncaughtException-delta oracle below silently vacuous: a
				// healthy boot logs nothing at that level, hdb.log may never even be created (it's
				// created lazily on first entry), and "file absent" would then be indistinguishable
				// from "logPath drifted to the wrong place" -- every uncaughtAfter/uncaughtBefore
				// assertion would still pass either way. 'info' guarantees real boot-time log
				// content, which the positive-control assertion just below then verifies.
				config: { threads: { count: 1 }, logging: { level: 'info' } },
				env: {},
			});
			client = createApiClient(ctx.harper);
			restBase = client.restURL;
			authHeaders = { Authorization: client.headers.Authorization as string };
			logPath = (ctx.harper as any).logDir
				? join((ctx.harper as any).logDir, 'hdb.log')
				: join((ctx.harper as any).dataRootDir, 'log', 'hdb.log');
			ok(
				readLogSafe(logPath).length > 0,
				`positive control: expected hdb.log to have real boot content at ${logPath} -- if this is empty, ` +
					`the uncaughtException-delta assertions below can't detect anything, regardless of what they show`
			);

			// Poll the probe route directly until it stops 404-ing (component is pre-installed; no
			// restart against a running fixture -- restartHttpWorkers() races and flakes on CI).
			const deadline = Date.now() + 30_000;
			let ready = false;
			while (Date.now() < deadline) {
				try {
					const p = await getProbe(restBase, authHeaders);
					if ((p as any).status !== 404) {
						ready = true;
						break;
					}
				} catch {
					/* not ready */
				}
				await sleep(250);
			}
			ok(ready, `Probe route never became ready within 30s (component load failure?) at ${restBase}/Probe/`);
		});

		after(async () => {
			await teardownHarper(ctx);
		});

		// ── (a) payload matrix against contentTypes.ts's text/event-stream serialize() -- the sibling
		//        encoder any Harper Resource client actually sees, NOT the #1863-guarded writeSSE()
		//        itself (unreachable from here -- see file header for why, and for the actual #1863
		//        anchor at unitTests/server/serverHelpers/progressEmitter.test.js) ────────────────────
		//
		// Only undefined/null omit the `data:` field entirely; `''`/`0`/`false` now emit their
		// (string-coerced) line. Note `''` still won't dispatch on a real EventSource client --
		// the HTML spec discards an empty data buffer regardless of whether the field was present
		// or omitted -- but the wire byte-for-byte representation is what's asserted here.

		const cases: Array<{ name: string; path: string; hasData: boolean; expectedData?: string }> = [
			{ name: 'undefined', path: 'UndefinedPayload', hasData: false },
			{ name: 'null', path: 'NullPayload', hasData: false },
			{ name: 'empty string', path: 'EmptyStringPayload', hasData: true, expectedData: '' },
			{ name: '0', path: 'ZeroPayload', hasData: true, expectedData: '0' },
			{ name: 'false', path: 'FalsePayload', hasData: true, expectedData: 'false' },
			{
				name: 'plain object (no "data" key)',
				path: 'PlainObjectPayload',
				hasData: true,
				expectedData: JSON.stringify({ foo: 'bar', n: 42 }),
			},
			{
				name: 'nested object',
				path: 'NestedObjectPayload',
				hasData: true,
				expectedData: JSON.stringify({
					phase: 'extract',
					detail: {
						steps: [
							{ name: 'a', status: 'ok' },
							{ name: 'b', status: 'ok' },
						],
						meta: { retries: 0, tags: ['x', 'y'] },
					},
				}),
			},
			{ name: 'very large string (~300KB)', path: 'LargeStringPayload', hasData: true, expectedData: LARGE_STRING },
		];

		for (const c of cases) {
			test(
				`a: event.data = ${c.name} -- valid SSE frame, no crash, connection stays healthy`,
				// Two sequential consumeSse() calls below, each bounded at 15s, plus a 200ms log-settle
				// sleep -- 20s was tighter than that combined budget and could kill an otherwise-correct
				// slow-runner case as a false red before its own diagnostics could fire.
				{ timeout: 35_000 },
				async () => {
					const logBefore = readLogSafe(logPath);
					const uncaughtBefore = countUncaught(logBefore);

					const r = await consumeSse(`${restBase}/${c.path}/`, authHeaders, 15_000);
					ok(
						!r.aborted,
						`must not hit the AbortController timeout -- a timeout here indicates a hang regression. errored=${r.errored?.message ?? null}`
					);
					ok(r.status >= 200 && r.status < 300, `expected 2xx, got ${r.status}. raw:\n${r.raw}`);
					ok(
						r.ended,
						`response must close cleanly ('end'); ended=${r.ended} closed=${r.closed} errored=${r.errored?.message ?? null}`
					);

					const blocks = parseSseBlocks(r.raw);
					const payloadBlock = blocks.find((b) => b.event === 'payload');
					ok(payloadBlock, `expected a 'payload' event block. raw:\n${r.raw}`);
					if (c.hasData) {
						strictEqual('data' in payloadBlock!, true, `expected a data: field for ${c.name}`);
						strictEqual(payloadBlock!.data, c.expectedData, `data field for ${c.name} did not match the wire contract`);
					} else {
						strictEqual(
							'data' in payloadBlock!,
							false,
							`expected NO data: field for ${c.name} -- absence (undefined/null), not falsiness, is what omits the data: line; got: ${JSON.stringify(payloadBlock)}`
						);
					}

					// Connection must stay healthy: a second immediate request against the SAME resource
					// must also succeed (rules out a worker wedged by exactly this payload).
					const r2 = await consumeSse(`${restBase}/${c.path}/`, authHeaders, 15_000);
					ok(
						!r2.aborted && r2.ended && r2.status >= 200 && r2.status < 300,
						`follow-up request after ${c.name} must also succeed cleanly`
					);

					await sleep(200); // let any async uncaughtException surface in the log
					const uncaughtAfter = countUncaught(readLogSafe(logPath));
					strictEqual(
						uncaughtAfter - uncaughtBefore,
						0,
						`no NEW uncaughtException should be logged for data=${c.name}`
					);
				}
			);
		}

		test('a: event.id = 0 (with real data) -- id: 0 is emitted', async () => {
			const r = await consumeSse(`${restBase}/IdZeroPayload/`, authHeaders, 15_000);
			ok(!r.aborted && r.ended && r.status >= 200 && r.status < 300, `expected a clean SSE response. raw:\n${r.raw}`);
			const payloadBlock = parseSseBlocks(r.raw).find((b) => b.event === 'payload');
			ok(payloadBlock, `expected a 'payload' event block. raw:\n${r.raw}`);
			strictEqual(payloadBlock!.data, 'id-zero-probe', 'data field should be unaffected by the id value');
			strictEqual(payloadBlock!.id, '0', `expected id: 0 to be emitted; got: ${JSON.stringify(payloadBlock)}`);
		});

		test('a: event.retry = 0 (with real data) -- retry: 0 is emitted', async () => {
			const r = await consumeSse(`${restBase}/RetryZeroPayload/`, authHeaders, 15_000);
			ok(!r.aborted && r.ended && r.status >= 200 && r.status < 300, `expected a clean SSE response. raw:\n${r.raw}`);
			const payloadBlock = parseSseBlocks(r.raw).find((b) => b.event === 'payload');
			ok(payloadBlock, `expected a 'payload' event block. raw:\n${r.raw}`);
			strictEqual(payloadBlock!.retry, '0', `expected retry: 0 to be emitted; got: ${JSON.stringify(payloadBlock)}`);
		});

		test('a: event-less message with data = 0 -- envelope gate must not treat this as absent', async () => {
			const r = await consumeSse(`${restBase}/ZeroPayloadNoEvent/`, authHeaders, 15_000);
			ok(!r.aborted && r.ended && r.status >= 200 && r.status < 300, `expected a clean SSE response. raw:\n${r.raw}`);
			const blocks = parseSseBlocks(r.raw);
			ok(blocks.length >= 1, `expected at least one SSE block. raw:\n${r.raw}`);
			strictEqual(
				blocks[0].data,
				'0',
				`expected a bare "data: 0" line, not the whole message JSON-wrapped; got: ${JSON.stringify(blocks[0])}`
			);
		});

		test('a: top-level data key with siblings -- data envelope takes precedence', async () => {
			const r = await consumeSse(`${restBase}/DataKeyEnvelopePayload/`, authHeaders, 15_000);
			ok(!r.aborted && r.ended && r.status >= 200 && r.status < 300, `expected a clean SSE response. raw:\n${r.raw}`);
			const blocks = parseSseBlocks(r.raw);
			ok(blocks.length >= 1, `expected at least one SSE block. raw:\n${r.raw}`);
			strictEqual(blocks[0].data, '0', `expected the top-level data value, got: ${JSON.stringify(blocks[0])}`);
			strictEqual('name' in blocks[0], false, `expected no literal sibling fields, got: ${JSON.stringify(blocks[0])}`);
		});

		test('a: plain object with an "id" key (no data/event) -- must be JSON-wrapped, not misread as an SSE id', async () => {
			const r = await consumeSse(`${restBase}/IdKeyPlainObjectPayload/`, authHeaders, 15_000);
			ok(!r.aborted && r.ended && r.status >= 200 && r.status < 300, `expected a clean SSE response. raw:\n${r.raw}`);
			const blocks = parseSseBlocks(r.raw);
			ok(blocks.length >= 1, `expected at least one SSE block. raw:\n${r.raw}`);
			strictEqual(
				blocks[0].data,
				JSON.stringify({ id: 42, name: 'Alice' }),
				`expected the whole object JSON-wrapped, not "name" dropped; got: ${JSON.stringify(blocks[0])}`
			);
		});

		// ── (b) F-133 re-characterization: generator throws mid-stream ─────────────────────────

		test(
			'b: ThrowGen (throws after 2 of 5) over SSE -- F-133 re-check: hang, fixed, or changed shape?',
			{ timeout: 20_000 },
			async () => {
				const logBefore = readLogSafe(logPath);
				const uncaughtBefore = countUncaught(logBefore);

				const r = await consumeSse(`${restBase}/ThrowGen/`, authHeaders, 15_000);

				let verdict: string;
				if (r.aborted) verdict = 'STILL HANGS (F-133 not fixed / regressed)';
				else if (r.ended) verdict = 'FIXED -- clean SSE close despite the mid-stream throw';
				else if (r.closed)
					verdict =
						'FIXED (changed shape) -- connection closed promptly but abruptly (no clean SSE terminator), not hung';
				else verdict = 'UNKNOWN -- neither aborted, ended, nor closed observed';
				console.log(
					`[QA-702][b] F-133 verdict: ${verdict}\n  status=${r.status} ended=${r.ended} closed=${r.closed} aborted=${r.aborted} errored=${r.errored?.message ?? null}\n  raw:\n${r.raw}`
				);

				await sleep(300);
				const uncaughtAfter = countUncaught(readLogSafe(logPath));
				const newUncaught = uncaughtAfter - uncaughtBefore;
				console.log(`[QA-702][b] new uncaughtException count for the mid-stream throw: ${newUncaught}`);
				// Same contract as case (a): the mid-stream throw must be handled by the SSE serializer,
				// not escape as an uncaught exception on the worker.
				strictEqual(
					newUncaught,
					0,
					`no NEW uncaughtException should be logged for the mid-stream throw. verdict=${verdict}`
				);

				// The hang signal: our own bounded AbortController must NOT be what ended this request.
				ok(
					!r.aborted,
					`F-133 regression check: ThrowGen must not hang until the client's own timeout fires. verdict=${verdict}`
				);
				// Guard against a false "fixed" reading from an unrelated failure (e.g. the component
				// failing to load, which would also 500 instantly without ever streaming): status must be
				// 200 (headers/first bytes already flushed by the time of the throw -- a genuine stream
				// start, not an immediate framework-level error response).
				strictEqual(
					r.status,
					200,
					`expected streaming to have started (status 200) before the mid-stream throw, got ${r.status}. raw:\n${r.raw}`
				);
				// The events actually yielded before the throw (0, 1) must be exactly what arrived, nothing
				// from after the throw point. Assert the actual values, not just a count in range -- a
				// count alone would also accept a duplicated {"n":0}, a corrupted {"n":1}, or (if the
				// throw's timing ever shifts) a frame from after the throw silently replacing one before it.
				const blocks = parseSseBlocks(r.raw);
				const dataBlocks = blocks.filter((b) => 'data' in b);
				const expectedPrefix = ['{"n":0}', '{"n":1}'];
				ok(
					dataBlocks.length >= 1 && dataBlocks.length <= 2,
					`expected 1-2 events yielded before the throw, got ${dataBlocks.length}. raw:\n${r.raw}`
				);
				deepStrictEqual(
					dataBlocks.map((b) => b.data),
					expectedPrefix.slice(0, dataBlocks.length),
					`expected the exact pre-throw sequence (a prefix of ${JSON.stringify(expectedPrefix)}), got: ${JSON.stringify(dataBlocks.map((b) => b.data))}`
				);
				// Pin the actual shipped shape, not just "didn't hang". The two HTTP servers genuinely
				// differ here, so pin BOTH shapes rather than asserting one and skipping the other --
				// the divergence is the point, and a silent skip would let it drift unnoticed.
				//
				// Node (`server/http.ts` pipeBodyToResponse): closes the socket abruptly WITHOUT the
				// terminal `0\r\n\r\n` chunk, deliberately -- its own comment notes this "correctly
				// signals a failed/truncated transfer... instead of implying it completed". That is the
				// contract, and it is what a spec-compliant client uses to detect the truncation.
				//
				// uWS (`server/serverHelpers/uwsServer.ts` streamResponse): routes the source's 'error'
				// and 'end' through the SAME finish(true) -> res.end() path, so it DOES write the
				// terminal chunk. The wire response is then byte-indistinguishable from a generator that
				// legitimately finished -- a mid-stream failure is silently presented as success. That is
				// a real uWS-path defect (QA-886/F-272), not an alternative contract; the fix is to close
				// the connection instead of ending it. Pinned here so it cannot regress further or get
				// quietly "fixed" in the wrong direction.
				if (process.env.HARPER_UWS_HTTP) {
					ok(
						r.ended,
						`uWS path: expected the (defective) graceful end for the mid-stream throw, got closed=${r.closed} ended=${r.ended}. verdict=${verdict}`
					);
				} else {
					ok(
						r.closed && !r.ended,
						`expected an abrupt close (closed=true, ended=false) for the mid-stream throw, got closed=${r.closed} ended=${r.ended}. verdict=${verdict}`
					);
				}
			}
		);

		// ── Z: liveness canary -- worker survived everything above ──────────────────────────────

		test(
			'Z: liveness canary -- plain GET 200s, a second clean SSE stream completes, no new uncaughtException',
			{ timeout: 30_000 },
			async () => {
				const logBefore = readLogSafe(logPath);

				// A fresh, clean SSE stream must still complete normally after the throw case.
				const health = await consumeSse(`${restBase}/HealthGen/`, authHeaders, 15_000);
				ok(!health.aborted, 'HealthGen must not hang -- a wedged worker from the throw case would surface here');
				ok(
					health.ended,
					`HealthGen must close cleanly; ended=${health.ended} closed=${health.closed} aborted=${health.aborted}`
				);
				const healthBlocks = parseSseBlocks(health.raw).filter((b) => 'data' in b);
				strictEqual(
					healthBlocks.length,
					3,
					`expected all 3 HealthGen events, got ${healthBlocks.length}. raw:\n${health.raw}`
				);

				// Plain GET on a normal (non-SSE) route must still 200.
				const p: any = await getProbe(restBase, authHeaders).catch(() => null);
				console.log(`[QA-702][Z] liveness probe: ${p ? 'alive' : 'DEAD'} ${p ? JSON.stringify(p) : ''}`);
				ok(p !== null, 'Harper must still respond to Probe/ after all streaming cases');
				strictEqual(p.status, 200, `Probe/ must 200, got ${p.status}`);
				ok(
					p.throwGen.opened >= 1 && p.throwGen.closed >= 1,
					'ThrowGen should show a matched open/close pair (its `finally` block ran)'
				);
				ok(p.healthGen.opened >= 1 && p.healthGen.closed >= 1, 'HealthGen should show a matched open/close pair');

				await sleep(300);
				const logAfter = readLogSafe(logPath);
				const newLines = logAfter.slice(logBefore.length);
				const newUncaught = newLines.split('\n').filter((l) => l.includes('uncaughtException')).length;
				if (newUncaught > 0) {
					console.log(
						`[QA-702][Z] NEW uncaughtException lines found:\n${newLines
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
