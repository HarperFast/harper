/**
 * QA-537 — regression verify for #1628 "SSE hang on a finite generator streamed to completion",
 * fixed by PR #1632. `transformIterable` (server/serverHelpers/contentTypes.ts) applied the SSE
 * `serialize` transform to a generator's terminal `{ value: undefined, done: true }` step, which
 * threw inside Readable.from's pull loop and left the response hanging, never closed; the fix
 * passes that step through untransformed.
 *
 * The arms vary where the terminal step falls relative to the yielded values — N=0 (it is the
 * first step produced, the sharpest trigger), N=1, N=5, N=3000 — plus ThrowGen, whose rejection
 * never reaches the terminal step and so exercises #1789's teardown instead.
 *
 * sse-throw-midstream.test.ts (#1789) anchors the throw path; stream-error-contract.test.ts pins
 * the stream-error contract across SSE, NDJSON and iterable-REST on raw socket bytes. Neither
 * covers the completion shapes above.
 *
 * Reproduction:
 *   npm run test:integration -- "integrationTests/server/sse-finite-generator.test.ts"
 */
import { suite, test, before, after } from 'node:test';
import { deepStrictEqual, ok, strictEqual } from 'node:assert';
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

		/** The `n` carried by each delivered event, in arrival order. */
		function eventNumbers(result: { events: string[] }): number[] {
			return result.events.map((event) => JSON.parse(event).n);
		}

		async function assertCompletes(path: string, expectedEvents: number) {
			const uncaughtBefore = countUncaught(readLogSafe(logPath));
			const r = await consumeSse(`${restBase}${path}`, authHeaders, 15_000);
			ok(r.status >= 200 && r.status < 300, `expected 2xx, got ${r.status} (errored=${r.errored?.message ?? null})`);
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
			deepStrictEqual(eventNumbers(r), [0]);
		});

		// ── 3: canonical finite generator (N=5) ──────────────────────────────────────────────

		test(
			'3: FiniteGen (N=5) over SSE — all 5 events arrive and the response closes cleanly',
			{ timeout: 20_000 },
			async () => {
				const r = await assertCompletes('/FiniteGen/', 5);
				deepStrictEqual(eventNumbers(r), [0, 1, 2, 3, 4]);
			}
		);

		// ── 4: large finite generator (N=3000) ───────────────────────────────────────────────

		test(
			'4: LargeGen (N=3000) over SSE — all 3000 events arrive and the response closes cleanly',
			{ timeout: 20_000 },
			async () => {
				const r = await assertCompletes('/LargeGen/', 3000);
				// Every index, not just the endpoints: a reordering or duplication in the middle of a long
				// stream preserves both the count and the ends.
				deepStrictEqual(
					eventNumbers(r),
					Array.from({ length: 3000 }, (_, i) => i)
				);
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

				// A rejecting generator exits via #1789's pipeline() teardown, which destroys the response
				// instead of ending it cleanly. Only boundedness is asserted here; the throw contract
				// itself is sse-throw-midstream.test.ts's.
				ok(!r.aborted, `must not hit the AbortController timeout — the response never terminated. raw:\n${r.raw}`);
				ok(r.terminatedBy !== null, 'response must terminate via end/error/close, not hang indefinitely');
				// The generator yields 2 before it throws. The upper bound is the contract; the lower bound
				// is 1 rather than 2 because the abrupt destroy can drop the last chunk before it drains,
				// and a prefix of zero events would mean the pre-error events were never delivered at all.
				const delivered = eventNumbers(r);
				ok(
					delivered.length >= 1 && delivered.length <= 2,
					`expected a 1-2 event prefix before the throw, got ${delivered.length}. raw:\n${r.raw}`
				);
				deepStrictEqual(delivered, [0, 1].slice(0, delivered.length));
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
				ok(
					probe!.finite && probe!.empty && probe!.single && probe!.throwGen && probe!.large,
					`Probe/ returned no lifecycle counters: ${JSON.stringify(probe)}`
				);
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
				const offenders = uncaughtLines(readLogOrThrow(logPath));
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
