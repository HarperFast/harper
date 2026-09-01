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
 * This suite starts from the QA-537 harness/fixture pattern (sse-finite-generator.test.ts, which
 * anchors #1628) and its `ThrowGen` case, which *documented* (did not assert) the pre-fix hang.
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
import { resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { setupHarperWithFixture, teardownHarper, type ContextWithHarper } from '@harperfast/integration-testing';
import {
	awaitFixtureReady,
	consumeSse,
	countUncaught,
	readLogOrThrow,
	readLogSafe,
	uncaughtAfterSettle,
	uncaughtLines,
	waitForProbe,
} from '../utils/sseStream.ts';
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

// ── Suite ──────────────────────────────────────────────────────────────────────────────────

suite(
	'QA-559 SSE throw-mid-stream regression verify (#1789 / commit 8930b1ef2)',
	{ skip: skipSuite },
	(ctx: ContextWithHarper) => {
		let client: Client;
		let restBase = '';
		let authHeaders: Record<string, string> = {};
		let logPath = '';
		let uncaughtBaseline = 0;

		before(async () => {
			await setupHarperWithFixture(ctx, FIXTURE_PATH, {
				config: { threads: { count: 1 }, logging: { console: true, level: 'error' } },
				env: {},
			});
			client = createApiClient(ctx.harper);
			restBase = client.restURL;
			authHeaders = { Authorization: client.headers.Authorization as string };
			({ logPath, uncaughtBaseline } = await awaitFixtureReady(ctx.harper as any, restBase, authHeaders));
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

				const probe = await waitForProbe<ProbeSnap>(
					restBase,
					authHeaders,
					(snapshot) => snapshot.throwFirst.closed >= 1
				);
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

				const probe = await waitForProbe<ProbeSnap>(restBase, authHeaders, (snapshot) => snapshot.throwMid.closed >= 1);
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
				const p = await waitForProbe<ProbeSnap>(
					restBase,
					authHeaders,
					(snapshot) => snapshot.throwFirst.closed >= 1 && snapshot.throwMid.closed >= 1 && snapshot.clean.closed >= 1
				);
				console.log(`[QA-559][Z] liveness probe: ${p ? 'alive' : 'DEAD'} ${p ? JSON.stringify(p) : ''}`);
				ok(
					p !== null,
					'Harper must still respond to Probe/ after all throw-mid-stream cases (worker not crashed/wedged)'
				);
				ok(p!.throwFirst && p!.throwMid && p!.clean, `Probe/ returned no lifecycle counters: ${JSON.stringify(p)}`);
				ok(
					p!.throwFirst.opened >= 1 && p!.throwFirst.closed >= 1,
					'ThrowFirst should show a matched open/close pair (generator finally ran)'
				);
				ok(
					p!.throwMid.opened >= 1 && p!.throwMid.closed >= 1,
					'ThrowMid should show a matched open/close pair (generator finally ran)'
				);
				ok(p!.clean.opened >= 1 && p!.clean.closed >= 1, 'CleanGen should show a matched open/close pair');

				// Measured against the baseline taken in before(), so a case whose own delta check was
				// outrun by the log flush is still caught here.
				await sleep(1_000);
				const offenders = uncaughtLines(readLogOrThrow(logPath));
				if (offenders.length > uncaughtBaseline) {
					console.log(`[QA-559][Z] NEW uncaughtException lines:\n${offenders.slice(uncaughtBaseline).join('\n')}`);
				}
				strictEqual(
					offenders.length - uncaughtBaseline,
					0,
					'no uncaughtException should have appeared anywhere across the whole suite'
				);
			}
		);
	}
);
