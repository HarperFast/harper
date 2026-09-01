/**
 * QA-537 — regression verify for #1628 "SSE hang on a finite generator streamed to completion",
 * fixed by PR #1632.
 *
 * `transformIterable` (server/serverHelpers/contentTypes.ts) applied the SSE `serialize` transform
 * to the generator's terminal `{ value: undefined, done: true }` step as well as to its yielded
 * values. `serialize()` dereferences `message.acknowledge`, so the terminal step threw a TypeError
 * inside Readable.from's pull loop — an uncaughtException that left the response hanging, never
 * closed, whenever a finite async generator was streamed to completion over
 * `Accept: text/event-stream`. The fix passes the terminal step through untransformed.
 *
 * The shapes below vary where that terminal step falls relative to the yielded values, which is
 * the axis the bug lived on: N=0 (terminal step is the first step produced, the sharpest trigger),
 * N=1, N=5 (the issue's own case) and N=3000 (same path after a long stream). ThrowGen is the
 * contrast arm — a generator that rejects never reaches the terminal step at all, so it exercises
 * the #1789 teardown path instead.
 *
 * Neighbouring suites, neither of which covers those completion shapes: sse-throw-midstream.test.ts
 * (#1789) is the dedicated anchor for a generator that *throws*; stream-error-contract.test.ts pins
 * the stream-*error* contract across SSE, NDJSON and iterable-REST on raw socket bytes.
 *
 * Reproduction:
 *   npm run test:integration -- "integrationTests/server/sse-finite-generator.test.ts"
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
	readLogSafe,
	uncaughtAfterSettle,
	uncaughtLines,
	waitForProbe,
} from '../utils/sseStream.ts';
// @ts-expect-error utils/client.mjs has no type declarations; runtime resolves fine
import { createApiClient } from '../apiTests/utils/client.mjs';

const FIXTURE_PATH = resolve(import.meta.dirname, 'sse-finite-generator');
const skipSuite = process.platform === 'win32';

type Client = ReturnType<typeof createApiClient>;

interface Lifecycle {
	opened: number;
	closed: number;
}

interface ProbeSnap {
	ok: boolean;
	finite: Lifecycle;
	empty: Lifecycle;
	single: Lifecycle;
	throwGen: Lifecycle;
	large: Lifecycle;
}

suite(
	'QA-537 SSE finite-generator completion regression verify (#1628 / PR #1632)',
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

		async function assertCompletes(path: string, expectedEvents: number) {
			const uncaughtBefore = countUncaught(readLogSafe(logPath));
			const r = await consumeSse(`${restBase}${path}`, authHeaders, 15_000);
			ok(r.status >= 200 && r.status < 300, `expected 2xx, got ${r.status}`);
			ok(
				!r.aborted,
				`${path} must not hit the AbortController timeout — a timeout here means the #1628 hang regressed. raw:\n${r.raw}`
			);
			strictEqual(
				r.events.length,
				expectedEvents,
				`expected ${expectedEvents} SSE data events, got ${r.events.length}`
			);
			strictEqual(
				r.terminatedBy,
				'end',
				`a generator streamed to completion must close via a clean 'end', got terminatedBy=${r.terminatedBy} errored=${r.errored?.message ?? null}`
			);
			strictEqual(
				(await uncaughtAfterSettle(logPath)) - uncaughtBefore,
				0,
				`no NEW uncaughtException should be logged for ${path}`
			);
			return r;
		}

		// ── 1: empty generator (N=0) — the terminal step is the very first step ──────────────

		test('1: EmptyGen (N=0) over SSE — zero events, response still closes cleanly', { timeout: 20_000 }, async () => {
			await assertCompletes('/EmptyGen/', 0);
		});

		// ── 2: single-event generator (N=1) ──────────────────────────────────────────────────

		test('2: SingleGen (N=1) over SSE — exactly 1 event, response closes cleanly', { timeout: 20_000 }, async () => {
			const r = await assertCompletes('/SingleGen/', 1);
			ok(r.events[0].includes('"n":0'), `expected the single event to contain n=0, got: ${r.events[0]}`);
		});

		// ── 3: canonical finite generator (N=5) ──────────────────────────────────────────────

		test(
			'3: FiniteGen (N=5) over SSE — all 5 events arrive and the response closes cleanly',
			{ timeout: 20_000 },
			async () => {
				const r = await assertCompletes('/FiniteGen/', 5);
				for (let i = 0; i < 5; i++) {
					ok(r.events[i].includes(`"n":${i}`), `expected event ${i} to contain n=${i}, got: ${r.events[i]}`);
				}
			}
		);

		// ── 4: large finite generator (N=3000) ───────────────────────────────────────────────

		test(
			'4: LargeGen (N=3000) over SSE — all 3000 events arrive and the response closes cleanly',
			{ timeout: 20_000 },
			async () => {
				const r = await assertCompletes('/LargeGen/', 3000);
				ok(r.events[0].includes('"n":0'), `expected first event n=0, got: ${r.events[0]}`);
				ok(r.events[2999].includes('"n":2999'), `expected last event n=2999, got: ${r.events[2999]}`);
			}
		);

		// ── 5: generator that throws partway (2 of 5) ────────────────────────────────────────

		test(
			'5: ThrowGen (throws after 2 of 5) over SSE — terminates in bounded time, no uncaughtException',
			{ timeout: 20_000 },
			async () => {
				const uncaughtBefore = countUncaught(readLogSafe(logPath));

				const r = await consumeSse(`${restBase}/ThrowGen/`, authHeaders, 15_000);
				console.log(
					`[QA-537][5] ThrowGen: status=${r.status} events=${r.events.length} terminatedBy=${r.terminatedBy} aborted=${r.aborted} errored=${r.errored?.message ?? null} elapsedMs=${r.elapsedMs}`
				);

				// A rejecting generator never reaches the terminal `done` step #1632 fixed; it exits via
				// the #1789 pipeline() teardown, which destroys the response instead of ending it
				// cleanly. Both are bounded — that is what is asserted here. The full throw contract
				// lives in sse-throw-midstream.test.ts.
				ok(!r.aborted, `must not hit the AbortController timeout — the response never terminated. raw:\n${r.raw}`);
				ok(r.terminatedBy !== null, 'response must terminate via end/error/close, not hang indefinitely');
				ok(
					r.events.length <= 2,
					`expected at most the 2 events yielded before the throw, got ${r.events.length}. raw:\n${r.raw}`
				);
				for (let i = 0; i < r.events.length; i++) {
					ok(r.events[i].includes(`"n":${i}`), `expected event ${i} to contain n=${i}, got: ${r.events[i]}`);
				}
				strictEqual(
					(await uncaughtAfterSettle(logPath)) - uncaughtBefore,
					0,
					'no NEW uncaughtException should be logged for a mid-stream throw'
				);
			}
		);

		// ── Z: liveness canary + whole-suite uncaughtException sweep ────────────────────────

		test(
			'Z: liveness canary — worker survived every streaming shape above, no new uncaughtException',
			{ timeout: 30_000 },
			async () => {
				const probe = await waitForProbe<ProbeSnap>(restBase, authHeaders, (snapshot) =>
					[snapshot.finite, snapshot.empty, snapshot.single, snapshot.throwGen, snapshot.large].every(
						(counter) => counter.opened >= 1 && counter.opened === counter.closed
					)
				);
				console.log(`[QA-537][Z] liveness probe: ${probe ? JSON.stringify(probe) : 'DEAD'}`);
				ok(probe !== null, 'Harper must still respond to Probe/ after all streaming cases');
				for (const [name, counter] of Object.entries({
					FiniteGen: probe!.finite,
					EmptyGen: probe!.empty,
					SingleGen: probe!.single,
					ThrowGen: probe!.throwGen,
					LargeGen: probe!.large,
				})) {
					ok(counter.opened >= 1, `${name} should have been opened`);
					strictEqual(counter.closed, counter.opened, `${name} generator was not closed`);
				}

				// Measured against the baseline taken in before(), so a case whose own delta check was
				// outrun by the log flush is still caught here.
				await sleep(1_000);
				const offenders = uncaughtLines(readLogSafe(logPath));
				if (offenders.length > uncaughtBaseline) {
					console.log(`[QA-537][Z] NEW uncaughtException lines:\n${offenders.slice(uncaughtBaseline).join('\n')}`);
				}
				strictEqual(
					offenders.length - uncaughtBaseline,
					0,
					'no uncaughtException should have appeared anywhere across the suite'
				);
			}
		);
	}
);
