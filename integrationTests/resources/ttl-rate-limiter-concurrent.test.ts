/** Pins F-002/F-005/F-006 atomic-addTo+TTL-eviction fixes: 50 concurrent addTo on a 500ms-TTL key across 4 workers yields exact stored==acked with no stale resurrection. */
/**
 * QA-431 — sub-second-TTL (500ms) rate-limiter × 4 workers.
 *
 * Novel angle vs QA-224/QA-307 (both use 1s TTL):
 *   - 500ms TTL means the Harper eviction sweep (default ~62ms interval) fires
 *     multiple times per window. The sweep + write-reset + concurrent workers all
 *     race at a tighter cadence.
 *   - Primary probe: "from-nothing concurrent burst" — ALL 50 requests arrive on an
 *     already-expired key (404 state). Each calls update()+addTo() on a non-existent
 *     record simultaneously across 4 workers. Does the final stored value equal the
 *     number of 200-ACKed requests?
 *   - Secondary probes: within-window exactness (N=50, well clear of expiry);
 *     expiry-mid-burst (burst straddles the 500ms boundary).
 *
 * Known family:
 *   F-002 (#1283) — addTo racing TTL resurrection (RocksDB, nondeterministic).
 *   F-005 (#1287) — multi-worker evict() bugs (LMDB non-thenable, RocksDB ERR_BUSY).
 *   F-006 — addTo is the confirmed-safe atomic primitive; ifVersion is not.
 *   QA-224/307 — same surface, 1s TTL; this extends to 0.5s × tighter eviction cadence.
 *
 * Verdict per leg logged at end. EXPECTED = clean; DEFECT = assertion failure.
 *
 * Repro:
 *   npm run test:integration -- "integrationTests/resources/ttl-rate-limiter-concurrent.test.ts"
 * Harper SHA: 228eacc0fb41dd521b4d990a46533ecaccd6c3f3
 */

import { suite, test, before, after } from 'node:test';
import { ok } from 'node:assert';
import { resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { setupHarperWithFixture, teardownHarper, type ContextWithHarper } from '@harperfast/integration-testing';
// @ts-expect-error utils/client.mjs has no type declarations
import { createApiClient } from '../apiTests/utils/client.mjs';

const FIXTURE_PATH = resolve(import.meta.dirname, 'ttl-rate-limiter-concurrent');
const TTL_MS = 500; // matches expiration: 0.5 in schema.graphql
const CONVERGENCE_WINDOW_MS = TTL_MS - 100;
const POLL_INTERVAL_MS = 20;
const MIN_READ_BUDGET_MS = 100;
const WORKERS = 4;

const skipSuite = process.platform === 'win32' || process.env.HARPER_RUNTIME === 'bun';

const findings: string[] = [];
function log(line: string) {
	findings.push(line);
	console.log(line);
}

suite(
	`QA-431 sub-second-TTL rate-limiter [500ms × ${WORKERS} workers]`,
	{ skip: skipSuite },
	(ctx: ContextWithHarper) => {
		let httpURL: string;
		let auth: string;

		before(async () => {
			await setupHarperWithFixture(ctx, FIXTURE_PATH, {
				config: { threads: { count: WORKERS } },
				env: {},
			});
			const client = createApiClient(ctx.harper);
			httpURL = ctx.harper.httpURL;
			auth = client.headers.Authorization;

			// Readiness poll: wait until RateCounter table responds (not 503).
			const deadline = Date.now() + 30_000;
			while (Date.now() < deadline) {
				try {
					const r = await fetch(`${httpURL}/RateCounter/`, {
						headers: { Authorization: auth },
						signal: AbortSignal.timeout(3_000),
					});
					if (r.status !== 503) break;
				} catch {
					/* not ready */
				}
				await sleep(200);
			}
		});

		after(async () => {
			await teardownHarper(ctx);
			console.log('\n═══ QA-431 FINDINGS MATRIX ═══');
			for (const f of findings) console.log(f);
		});

		// ── helpers ──────────────────────────────────────────────────────────────

		function hdrs() {
			return { 'Content-Type': 'application/json', 'Authorization': auth };
		}

		/** Atomic increment via POST /RateIncrement/ */
		async function increment(id: string): Promise<{ status: number | 'error'; at: number; startedAt: number }> {
			const startedAt = Date.now();
			try {
				const r = await fetch(`${httpURL}/RateIncrement/`, {
					method: 'POST',
					headers: hdrs(),
					body: JSON.stringify({ id }),
					signal: AbortSignal.timeout(6_000),
				});
				return { status: r.status, at: Date.now(), startedAt };
			} catch {
				return { status: 'error', at: Date.now(), startedAt };
			}
		}

		/** PUT a seed record. Returns {status, at}. */
		async function put(id: string, hits: number): Promise<{ status: number | 'error'; at: number }> {
			try {
				const r = await fetch(`${httpURL}/RateCounter/${id}`, {
					method: 'PUT',
					headers: hdrs(),
					body: JSON.stringify({ id, hits }),
					signal: AbortSignal.timeout(5_000),
				});
				return { status: r.status, at: Date.now() };
			} catch {
				return { status: 'error', at: Date.now() };
			}
		}

		/** GET a record. */
		async function get(id: string, timeoutMs = 5_000): Promise<{ status: number | 'error'; body: any }> {
			try {
				const r = await fetch(`${httpURL}/RateCounter/${id}`, {
					headers: { Authorization: auth },
					signal: AbortSignal.timeout(Math.max(1, timeoutMs)),
				});
				const body = r.status === 200 ? await r.json() : null;
				return { status: r.status, body };
			} catch {
				return { status: 'error', body: null };
			}
		}

		function getConvergenceDeadline(results: Awaited<ReturnType<typeof increment>>[]) {
			const acknowledged = results.filter((result) => result.status === 200);
			if (acknowledged.length === 0) return null;
			// Every acknowledged write starts after its request, so this bound precedes its expiry.
			return Math.min(
				Math.max(...acknowledged.map((result) => result.at)) + CONVERGENCE_WINDOW_MS,
				Math.min(...acknowledged.map((result) => result.startedAt)) + TTL_MS - MIN_READ_BUDGET_MS
			);
		}

		async function waitForConvergedGet(id: string, minimumHits: number, maximumHits: number, deadline: number) {
			const seen: (number | string)[] = [];
			let response: Awaited<ReturnType<typeof get>> = { status: 'error', body: null };
			let lastMeaningfulResponse = response;
			let previousHits: number | undefined;
			let stableReads = 0;
			let confirmed = false;
			let regressed = false;
			let regressionSignature: string | undefined;
			let regressionReads = 0;
			let postWindowRead = false;
			while (deadline - Date.now() >= MIN_READ_BUDGET_MS) {
				response = await get(id, deadline - Date.now());
				if (Date.now() >= deadline) {
					postWindowRead = true;
					seen.push(`post:${response.status === 200 ? Number(response.body?.hits ?? -1) : String(response.status)}`);
					if (response.status !== 'error') lastMeaningfulResponse = response;
					break;
				}
				seen.push(response.status === 200 ? Number(response.body?.hits ?? -1) : String(response.status));
				if (response.status !== 'error') lastMeaningfulResponse = response;
				if (response.status === 200) {
					const hits = Number(response.body?.hits ?? -1);
					if (hits > maximumHits) {
						confirmed = true;
						break;
					}
					if (hits >= minimumHits) {
						regressionSignature = undefined;
						regressionReads = 0;
						stableReads = hits === previousHits ? stableReads + 1 : 1;
						previousHits = hits;
						if (stableReads >= 2) confirmed = true;
					} else {
						if (confirmed) {
							const signature = String(hits);
							regressionReads = signature === regressionSignature ? regressionReads + 1 : 1;
							regressionSignature = signature;
							if (regressionReads >= 2) regressed = true;
						}
						previousHits = hits;
						stableReads = 0;
					}
				} else {
					if (response.status === 404 && confirmed) {
						regressionReads = regressionSignature === '404' ? regressionReads + 1 : 1;
						regressionSignature = '404';
						if (regressionReads >= 2) regressed = true;
					} else {
						regressionSignature = undefined;
						regressionReads = 0;
					}
					previousHits = undefined;
					stableReads = 0;
				}
				const remainingMs = deadline - Date.now();
				if (remainingMs <= 0) break;
				await sleep(Math.min(POLL_INTERVAL_MS, remainingMs));
			}
			if (
				response.status === 'error' ||
				(!confirmed && seen.length <= 1) ||
				(!postWindowRead && confirmed && regressionReads === 1)
			) {
				postWindowRead = true;
				response = await get(id);
				seen.push(`post:${response.status === 200 ? Number(response.body?.hits ?? -1) : String(response.status)}`);
				if (response.status !== 'error') lastMeaningfulResponse = response;
			}
			return {
				response: response.status === 'error' ? lastMeaningfulResponse : response,
				seen,
				confirmed,
				regressed,
				regressionObserved: regressionReads > 0,
				endedWithError: response.status === 'error',
				postWindowRead,
			};
		}

		function classifyConvergence(
			convergence: Awaited<ReturnType<typeof waitForConvergedGet>>,
			acked: number,
			uncertain: number
		): { kind: 'clean' | 'measured' | 'lost' | 'over' | 'inconclusive'; stored?: number } {
			const { response, confirmed, regressed, regressionObserved, endedWithError, postWindowRead } = convergence;
			if (response.status === 404) {
				if (confirmed && !regressed && !regressionObserved && uncertain === 0) return { kind: 'clean' };
				return { kind: regressed || (!postWindowRead && !endedWithError) ? 'lost' : 'inconclusive' };
			}
			if (response.status !== 200) return { kind: 'inconclusive' };
			const stored = Number(response.body?.hits ?? -1);
			if (regressed) return { kind: 'lost', stored };
			if (stored > acked + uncertain) return { kind: 'over', stored };
			if (stored >= acked) {
				if (uncertain !== 0) return { kind: 'inconclusive', stored };
				return { kind: confirmed ? 'clean' : 'measured', stored };
			}
			return { kind: endedWithError || postWindowRead ? 'inconclusive' : 'lost', stored };
		}

		/** DELETE a record (best-effort cleanup). */
		async function del(id: string): Promise<void> {
			try {
				await fetch(`${httpURL}/RateCounter/${id}`, {
					method: 'DELETE',
					headers: { Authorization: auth },
					signal: AbortSignal.timeout(3_000),
				});
			} catch {
				/* best-effort */
			}
		}

		// ── (1) smoke ─────────────────────────────────────────────────────────────

		test('smoke: single increment on fresh key yields hits=1', async () => {
			const r = await increment('smoke-qa431');
			log(`[smoke] POST /RateIncrement/ → ${r.status}`);
			ok(r.status === 200, `Expected 200, got ${r.status}`);

			const g = await get('smoke-qa431');
			const hits = g.status === 200 ? Number(g.body?.hits ?? -1) : null;
			log(`[smoke] GET → status=${g.status} hits=${hits}`);
			ok(hits === 1, `Expected hits=1 after first increment, got ${hits}`);
			await del('smoke-qa431');
		});

		// ── (2) within-window exactness (N=50) ────────────────────────────────────
		//
		// Seed a record well clear of expiry (PUT with a fresh TTL reset), then fire
		// 50 concurrent addTo calls. Final stored value must == 50 (+ initial 0 from
		// seed; PUT sets hits=0, then 50 addTo → 50).
		//
		// Repeat 5 rounds. Any round with stored ≠ acked is a DEFECT.

		test('(2) within-window exactness: 50 concurrent addTo → hits==50 each round', async () => {
			const ROUNDS = 5;
			const N = 50;
			let cleanRounds = 0;
			let lostCountRounds = 0;
			let staleRounds = 0;
			let measuredRounds = 0;
			let inconclusiveRounds = 0;
			const roundLogs: string[] = [];

			for (let r = 0; r < ROUNDS; r++) {
				const id = `ww${r}`;
				// PUT a record to start from 0 with a fresh 500ms TTL.
				const seedRes = await put(id, 0);
				if (seedRes.status === 'error') {
					roundLogs.push(`r${r}: seed-error`);
					continue;
				}

				// Fire N concurrent increments immediately (well before expiry).
				const results = await Promise.all(Array.from({ length: N }, () => increment(id)));
				const acked = results.filter((x) => x.status === 200).length;
				const errs = results.filter((x) => x.status === 'error').length;
				const rejected = results.filter((x) => typeof x.status === 'number' && x.status !== 200).length;

				const convergenceDeadline = getConvergenceDeadline(results);
				if (convergenceDeadline === null) {
					inconclusiveRounds++;
					roundLogs.push(`r${r}: no acknowledged increments (skip) err=${errs} rej=${rejected}`);
					await del(id);
					continue;
				}
				const uncertain = errs + rejected;
				const convergence = await waitForConvergedGet(id, acked, acked + uncertain, convergenceDeadline);
				const outcome = classifyConvergence(convergence, acked, uncertain);
				if (outcome.kind === 'clean') cleanRounds++;
				else if (outcome.kind === 'measured') measuredRounds++;
				else if (outcome.kind === 'lost') lostCountRounds++;
				else if (outcome.kind === 'over') staleRounds++;
				else inconclusiveRounds++;
				const desc = `r${r}: ${outcome.kind.toUpperCase()} observed=${outcome.stored ?? convergence.response.status} acked=${acked} rej=${rejected} err=${errs} seen=[${convergence.seen.join(',')}]`;
				roundLogs.push(desc);
				await del(id);
			}

			log(
				`\n[QA-431] (2) WITHIN-WINDOW EXACTNESS (${ROUNDS} rounds × N=${N}, TTL=${TTL_MS}ms, ${WORKERS} workers)\n` +
					`  clean rounds                  = ${cleanRounds}\n` +
					`  single-read measured rounds   = ${measuredRounds}\n` +
					`  lost-count rounds             = ${lostCountRounds}  ← DEFECT if > 0\n` +
					`  over-count rounds             = ${staleRounds}  ← DEFECT if > 0\n` +
					`  inconclusive rounds           = ${inconclusiveRounds}\n` +
					`  ${roundLogs.join('\n  ')}`
			);

			ok(lostCountRounds === 0, `QA-431(2): lost-count in ${lostCountRounds} round(s) — CRDT×TTL defect`);
			ok(staleRounds === 0, `QA-431(2): over-count in ${staleRounds} round(s) — double-apply or resurrection`);
			ok(
				cleanRounds + measuredRounds + lostCountRounds + staleRounds >= ROUNDS / 2,
				`QA-431(2): only ${cleanRounds + measuredRounds + lostCountRounds + staleRounds}/${ROUNDS} rounds were measurable (${inconclusiveRounds} inconclusive) — cannot confirm this probe exercised the guarded regression`
			);
		});

		// ── (3) from-nothing concurrent burst ─────────────────────────────────────
		//
		// Novel angle: let a record fully expire (confirm 404), then fire N=50 concurrent
		// increments on that key simultaneously. All 50 hit an empty-record create path
		// across 4 workers. Oracle: final stored hits == number of ACKed 200 responses.
		//
		// Risk: multiple workers independently create the record with hits=1 via addTo
		// on a missing key; CRDT merge may miscount if create-vs-update path diverges.

		test('(3) from-nothing burst: 50 concurrent addTo on an expired key → exact count', async () => {
			const ROUNDS = 8;
			const N = 50;
			let cleanRounds = 0;
			let lostCountRounds = 0;
			let staleRounds = 0;
			let measuredRounds = 0;
			let skipRounds = 0;
			const roundLogs: string[] = [];

			for (let r = 0; r < ROUNDS; r++) {
				const id = `fn${r}`;

				// PUT a record, then wait long enough for it to fully expire.
				const seedRes = await put(id, 99);
				if (seedRes.status === 'error') {
					skipRounds++;
					continue;
				}

				// Wait TTL + buffer so the record is definitely gone.
				await sleep(TTL_MS + 300);

				// Verify 404 before proceeding (skip if still alive — timing).
				const checkRes = await get(id);
				if (checkRes.status !== 404) {
					// Not expired yet; skip this round.
					await del(id);
					skipRounds++;
					roundLogs.push(`r${r}: skip (not expired status=${checkRes.status})`);
					continue;
				}

				// Fire N concurrent increments on the confirmed-absent key.
				const t0 = Date.now();
				const results = await Promise.all(Array.from({ length: N }, () => increment(id)));
				const burstMs = Date.now() - t0;
				const acked = results.filter((x) => x.status === 200).length;
				const errs = results.filter((x) => x.status === 'error').length;
				const rejected = results.filter((x) => typeof x.status === 'number' && x.status !== 200).length;

				const convergenceDeadline = getConvergenceDeadline(results);
				if (convergenceDeadline === null) {
					skipRounds++;
					roundLogs.push(`r${r}: skip (no acknowledged increments) rej=${rejected} err=${errs} burstMs=${burstMs}`);
					await del(id);
					continue;
				}
				const uncertain = errs + rejected;
				const convergence = await waitForConvergedGet(id, acked, acked + uncertain, convergenceDeadline);
				const outcome = classifyConvergence(convergence, acked, uncertain);
				if (outcome.kind === 'clean') cleanRounds++;
				else if (outcome.kind === 'measured') measuredRounds++;
				else if (outcome.kind === 'lost') lostCountRounds++;
				else if (outcome.kind === 'over') staleRounds++;
				else skipRounds++;
				const desc = `r${r}: ${outcome.kind.toUpperCase()} observed=${outcome.stored ?? convergence.response.status} acked=${acked} rej=${rejected} err=${errs} burstMs=${burstMs} seen=[${convergence.seen.join(',')}]`;
				roundLogs.push(desc);
				await del(id);
			}

			log(
				`\n[QA-431] (3) FROM-NOTHING BURST (${ROUNDS} rounds × N=${N}, TTL=${TTL_MS}ms, ${WORKERS} workers)\n` +
					`  clean rounds                  = ${cleanRounds}\n` +
					`  single-read measured rounds   = ${measuredRounds}\n` +
					`  lost-count rounds             = ${lostCountRounds}  ← DEFECT if > 0\n` +
					`  over-count rounds (seed=99)   = ${staleRounds}  ← DEFECT: stale resurrection if > 0\n` +
					`  inconclusive rounds           = ${skipRounds}\n` +
					`  ${roundLogs.join('\n  ')}`
			);

			ok(lostCountRounds === 0, `QA-431(3): ${lostCountRounds} round(s) with lost increments on from-nothing burst`);
			ok(
				staleRounds === 0,
				`QA-431(3): ${staleRounds} round(s) with stale resurrection (stored>acked, seed was 99) — F-002 family`
			);
			// The primary probe only runs a round when the pre-burst check reads back 404. If TTL
			// eviction itself regressed so records never expire, every round takes the skip branch
			// above, lostCountRounds/staleRounds stay 0, and the two asserts above vacuously pass —
			// silently failing to catch the eviction class this anchor guards.
			ok(
				cleanRounds + measuredRounds + lostCountRounds + staleRounds >= ROUNDS / 2,
				`QA-431(3): only ${cleanRounds + measuredRounds + lostCountRounds + staleRounds}/${ROUNDS} rounds actually measured the burst (${skipRounds} inconclusive) — TTL eviction may not be firing, and this probe cannot exercise the guarded regression`
			);
		});

		// ── (4) expiry-mid-burst (0.5s boundary straddle) ────────────────────────
		//
		// Fire a burst that straddles the 500ms boundary: first half of requests before
		// expiry, second half after. Oracle: final stored == acked (CLEAN/EXPIRY) or
		// stored > acked (stale-resurrect = F-002).

		test('(4) expiry-mid-burst: burst straddles the 500ms TTL boundary', async () => {
			const ROUNDS = 10;
			const N = 40;
			let cleanExpiry = 0; // 404 after boundary (clean rollover)
			let cleanAlive = 0; // stored == acked (addTo kept alive)
			let lostCountRounds = 0;
			let staleRounds = 0;
			const roundLogs: string[] = [];

			for (let r = 0; r < ROUNDS; r++) {
				const id = `mb${r}`;
				const seedRes = await put(id, 0);
				if (seedRes.status === 'error') continue;
				const expireAt = seedRes.at + TTL_MS;

				// Wait until ~80ms before expiry, then fire burst.
				const fireAt = expireAt - 80;
				const waitMs = fireAt - Date.now();
				if (waitMs > 0) await sleep(waitMs);

				const results = await Promise.all(Array.from({ length: N }, () => increment(id)));
				const acked = results.filter((x) => x.status === 200).length;
				const errs = results.filter((x) => x.status === 'error').length;
				const rejected = results.filter((x) => typeof x.status === 'number' && x.status !== 200).length;

				// Wait until well past expiry to let eviction sweep run.
				const readAt = expireAt + 400;
				const readWait = readAt - Date.now();
				if (readWait > 0) await sleep(readWait);

				const g = await get(id);
				let desc: string;
				if (g.status === 404) {
					cleanExpiry++;
					desc = `r${r}: clean-expiry(404) acked=${acked} rej=${rejected} err=${errs}`;
				} else if (g.status === 200) {
					const stored = Number(g.body?.hits ?? -1);
					if (stored === acked) {
						cleanAlive++;
						desc = `r${r}: clean-alive stored=${stored}==acked=${acked} rej=${rejected} err=${errs}`;
					} else if (stored < acked) {
						lostCountRounds++;
						desc = `r${r}: LOST stored=${stored}<acked=${acked} rej=${rejected} err=${errs}`;
					} else {
						staleRounds++;
						desc = `r${r}: STALE stored=${stored}>acked=${acked} rej=${rejected} err=${errs}`;
					}
				} else {
					desc = `r${r}: unexpected status=${g.status} acked=${acked}`;
				}
				roundLogs.push(desc);
				await del(id);
			}

			log(
				`\n[QA-431] (4) EXPIRY-MID-BURST (${ROUNDS} rounds × N=${N}, TTL=${TTL_MS}ms, ${WORKERS} workers)\n` +
					`  clean expiry (404 post-boundary) = ${cleanExpiry}/${ROUNDS}\n` +
					`  clean alive (stored==acked)      = ${cleanAlive}/${ROUNDS}\n` +
					`  lost-count rounds                = ${lostCountRounds}  ← DEFECT if > 0\n` +
					`  stale resurrection rounds        = ${staleRounds}  ← DEFECT if > 0 (F-002 family)\n` +
					`  ${roundLogs.join('\n  ')}`
			);

			ok(
				lostCountRounds === 0,
				`QA-431(4): ${lostCountRounds} round(s) with lost increments straddling 500ms boundary`
			);
			ok(staleRounds === 0, `QA-431(4): ${staleRounds} round(s) with stale resurrection (F-002 family)`);
			// NOT a lower-bound assertion, deliberately: every successful write resets a record's
			// expiresAt to now+TTL (confirmed against Table.ts's write-commit path), so as long as
			// the burst's writes keep landing back-to-back, the key never gets an actual gap ≥TTL to
			// expire through — cleanExpiry stays 0/${ROUNDS} even on fully-correct eviction code. That
			// makes this specific leg unable to discriminate "eviction works" from "eviction disabled"
			// (both look identical: 100% clean-alive) — logged for visibility, not asserted on, since
			// asserting cleanExpiry>0 here would fail permanently regardless of product code. Legs
			// (2)/(3)/(5) above and ttlResetOnWrite.test.ts (QA-269) are what actually exercise the
			// eviction-disabled regression class; see dispatch Findings for a follow-up to redesign
			// this leg's timing (e.g. a genuine no-write gap) if a real boundary-straddle probe is
			// wanted here.
			if (cleanExpiry === 0) {
				log(
					`  [QA-431(4) note] 0/${ROUNDS} rounds observed clean-expiry(404) — expected given TTL-reset-on-write semantics, not asserted on`
				);
			}
		});

		// ── (5) multi-worker stress: 10 parallel windows × 50 bursts ─────────────
		//
		// Stress 4 workers with simultaneous counter bursts on DIFFERENT keys (simulates
		// real rate-limit traffic). Each key gets 50 concurrent hits. After all settle,
		// all counters must match their ACKed counts.
		//
		// If multi-worker adds divergence, we'll see per-key stored ≠ acked.

		test('(5) multi-worker stress: 10 parallel windows × 50 hits', async () => {
			const WINDOWS = 10;
			const HITS_PER_WINDOW = 50;
			let cleanWindows = 0;
			let lostWindowCount = 0;
			let overWindowCount = 0;
			let measuredWindows = 0;
			let inconclusiveWindows = 0;
			const windowLogs: string[] = [];

			// Seed all windows first.
			const seedResults = await Promise.all(Array.from({ length: WINDOWS }, (_, i) => put(`mw${i}`, 0)));
			const allSeeded = seedResults.every((r) => r.status !== 'error');
			ok(allSeeded, 'QA-431(5): failed to seed one or more windows');

			// Fire all bursts simultaneously across all windows.
			const settled = await Promise.all(
				Array.from({ length: WINDOWS }, async (_, w) => {
					const id = `mw${w}`;
					const hits = await Promise.all(Array.from({ length: HITS_PER_WINDOW }, () => increment(id)));
					const acked = hits.filter((h) => h.status === 200).length;
					const errs = hits.filter((h) => h.status === 'error').length;
					const rejected = hits.filter((h) => typeof h.status === 'number' && h.status !== 200).length;
					const uncertain = errs + rejected;
					const convergenceDeadline = getConvergenceDeadline(hits);
					return {
						id,
						acked,
						errs,
						rejected,
						convergence:
							convergenceDeadline === null
								? null
								: await waitForConvergedGet(id, acked, acked + uncertain, convergenceDeadline),
					};
				})
			);

			for (const { id, acked, errs, rejected, convergence } of settled) {
				if (!convergence) {
					inconclusiveWindows++;
					windowLogs.push(`${id}: no acknowledged increments [skip] acked=${acked} rej=${rejected} err=${errs}`);
					continue;
				}
				const outcome = classifyConvergence(convergence, acked, errs + rejected);
				if (outcome.kind === 'clean') cleanWindows++;
				else if (outcome.kind === 'measured') measuredWindows++;
				else if (outcome.kind === 'lost') lostWindowCount++;
				else if (outcome.kind === 'over') overWindowCount++;
				else inconclusiveWindows++;
				windowLogs.push(
					`${id}: ${outcome.kind.toUpperCase()} observed=${outcome.stored ?? convergence.response.status} acked=${acked} rej=${rejected} err=${errs} seen=[${convergence.seen.join(',')}]`
				);
			}
			await Promise.all(settled.map(({ id }) => del(id)));

			log(
				`\n[QA-431] (5) MULTI-WORKER STRESS (${WINDOWS} windows × ${HITS_PER_WINDOW} hits, ${WORKERS} workers)\n` +
					`  clean windows              = ${cleanWindows}/${WINDOWS}\n` +
					`  single-read measured       = ${measuredWindows}/${WINDOWS}\n` +
					`  lost-count windows         = ${lostWindowCount}  ← DEFECT if > 0\n` +
					`  over-count windows         = ${overWindowCount}  ← DEFECT if > 0\n` +
					`  inconclusive windows       = ${inconclusiveWindows}\n` +
					`  ${windowLogs.join('\n  ')}`
			);

			ok(lostWindowCount === 0, `QA-431(5): ${lostWindowCount} window(s) with lost counts under multi-worker stress`);
			ok(overWindowCount === 0, `QA-431(5): ${overWindowCount} window(s) over-counted under multi-worker stress`);
			ok(
				cleanWindows + measuredWindows + lostWindowCount + overWindowCount >= WINDOWS / 2,
				`QA-431(5): only ${cleanWindows + measuredWindows + lostWindowCount + overWindowCount}/${WINDOWS} windows were measurable (${inconclusiveWindows} inconclusive) — cannot confirm this probe exercised the guarded regression`
			);
		});
	}
);
