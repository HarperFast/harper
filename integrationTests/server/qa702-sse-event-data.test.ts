/**
 * Promoted from qa-explorer (QA-702 / P-478): pins the Resource SSE contract — an 8-case
 * event-data payload matrix (undefined/null/''/0/false/object/nested/~300KB string) never
 * crashes a worker and the connection stays healthy, plus the F-133 mid-stream-throw
 * regression leg + a liveness canary.
 *
 * QA-702 — regression anchor for #1863 "fix: guard SSE writes against undefined event data
 * (#1724)" (commit 6bcd5cd29, merged 2026-07-21 into HarperFast/harper), PLUS a
 * re-characterization of the open sibling F-133 finding (SSE mid-stream throw hang) on current
 * main.
 *
 * (a) Green anchor for #1863, WITH AN IMPORTANT SCOPE CAVEAT (found empirically, not assumed):
 *     the literal guarded function, server/serverHelpers/progressEmitter.ts's `writeSSE()`, is
 *     wired up ONLY inside serverHandlers.js for the operations-API SSE_PROGRESS_OPERATIONS set
 *     (deploy_component / get_deployment / read_log), none of which let a test inject an
 *     arbitrary `data` value, and jsResource fixtures run from an isolated copied component root
 *     that CANNOT `import` the live repo's internal server/ modules (confirmed: a relative
 *     `../../../server/serverHelpers/progressEmitter.ts` import throws
 *     `ResourceLoadError: Cannot find module ...` — a sandboxing boundary, not a bug). So this
 *     suite instead targets the reachable SIBLING encoder: contentTypes.ts's `text/event-stream`
 *     media-type `serialize()`, invoked via `resource.connect()` — the actual SSE contract any
 *     Harper Resource's client sees. It has a DIFFERENT, pre-existing falsy-data guard
 *     (`if (message.data) { ...emit data: line... }`) that silently OMITS the `data:` field
 *     entirely for any falsy value (undefined/null/''/0/false) rather than crashing OR emitting
 *     an explicit empty/`null` line the way the fixed writeSSE() does — a distinct, worth-flagging
 *     shape of "falsy SSE data" handling, not a crash. See
 *     integrationTests/qa-scratch/qa702-sse-event-data/resources.js for the full writeup.
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
import { ok, strictEqual } from 'node:assert';
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
			{ method: 'GET', headers: { ...authHeaders, Accept: 'application/json' }, rejectUnauthorized: false } as any,
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
		.filter((rec) => 'event' in rec || 'data' in rec);
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
	'QA-702 SSE event-data payload matrix (#1863 anchor) + F-133 throw-path recheck',
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

			// Poll the probe route directly until it stops 404-ing (component is pre-installed; no
			// restart against a running fixture -- restartHttpWorkers() races and flakes on CI).
			const deadline = Date.now() + 30_000;
			while (Date.now() < deadline) {
				try {
					const p = await getProbe(restBase, authHeaders);
					if ((p as any).status !== 404) break;
				} catch {
					/* not ready */
				}
				await sleep(250);
			}
		});

		after(async () => {
			await teardownHarper(ctx);
		});

		// ── (a) payload matrix against the reachable SSE encoder (contentTypes.ts's text/event-stream
		//        serialize(), the #1863-guarded writeSSE()'s client-facing sibling -- see file header
		//        and resources.js for why this substitution was necessary) ───────────────────────────
		//
		// `hasData: false` cases exercise this encoder's OWN (pre-existing, different) falsy guard
		// -- `if (message.data) {...}` -- which OMITS the `data:` field entirely for a falsy value,
		// rather than crashing (the #1863 bug) or emitting an explicit empty/`null` line (writeSSE()'s
		// fixed behavior). That's the actual, current wire contract; asserted here, not assumed.

		const cases: Array<{ name: string; path: string; hasData: boolean; expectedData?: string }> = [
			{ name: 'undefined', path: 'UndefinedPayload', hasData: false },
			{ name: 'null', path: 'NullPayload', hasData: false },
			{ name: 'empty string', path: 'EmptyStringPayload', hasData: false },
			{ name: '0', path: 'ZeroPayload', hasData: false },
			{ name: 'false', path: 'FalsePayload', hasData: false },
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
				{ timeout: 20_000 },
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
							`expected NO data: field for falsy value ${c.name} (current contract silently omits it); got: ${JSON.stringify(payloadBlock)}`
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
				// from after the throw point.
				const blocks = parseSseBlocks(r.raw);
				const dataBlocks = blocks.filter((b) => 'data' in b);
				ok(
					dataBlocks.length >= 1 && dataBlocks.length <= 2,
					`expected 1-2 events yielded before the throw, got ${dataBlocks.length}. raw:\n${r.raw}`
				);
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
