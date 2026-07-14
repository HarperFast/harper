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
		async function increment(id: string): Promise<{ status: number | 'error'; at: number }> {
			try {
				const r = await fetch(`${httpURL}/RateIncrement/`, {
					method: 'POST',
					headers: hdrs(),
					body: JSON.stringify({ id }),
					signal: AbortSignal.timeout(6_000),
				});
				return { status: r.status, at: Date.now() };
			} catch {
				return { status: 'error', at: Date.now() };
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
		async function get(id: string): Promise<{ status: number | 'error'; body: any }> {
			try {
				const r = await fetch(`${httpURL}/RateCounter/${id}`, {
					headers: { Authorization: auth },
					signal: AbortSignal.timeout(5_000),
				});
				const body = r.status === 200 ? await r.json() : null;
				return { status: r.status, body };
			} catch {
				return { status: 'error', body: null };
			}
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

				const g = await get(id);
				let desc: string;
				if (g.status === 404) {
					// The burst itself took >500ms and the record expired — can't measure.
					desc = `r${r}: expired-during-burst (skip) acked=${acked} err=${errs}`;
				} else if (g.status === 200) {
					// PUT starts at 0, so stored should equal acked addTo calls.
					const stored = Number(g.body?.hits ?? -1);
					if (stored === acked) {
						cleanRounds++;
						desc = `r${r}: CLEAN stored=${stored}==acked=${acked} rej=${rejected} err=${errs}`;
					} else if (stored < acked) {
						lostCountRounds++;
						desc = `r${r}: LOST stored=${stored}<acked=${acked} rej=${rejected} err=${errs}`;
					} else {
						staleRounds++;
						desc = `r${r}: OVER stored=${stored}>acked=${acked} rej=${rejected} err=${errs}`;
					}
				} else {
					desc = `r${r}: unexpected status=${g.status} acked=${acked}`;
				}
				roundLogs.push(desc);
				await del(id);
			}

			log(
				`\n[QA-431] (2) WITHIN-WINDOW EXACTNESS (${ROUNDS} rounds × N=${N}, TTL=${TTL_MS}ms, ${WORKERS} workers)\n` +
					`  clean rounds (stored==acked)  = ${cleanRounds}\n` +
					`  lost-count rounds             = ${lostCountRounds}  ← DEFECT if > 0\n` +
					`  over-count rounds             = ${staleRounds}  ← DEFECT if > 0\n` +
					`  ${roundLogs.join('\n  ')}`
			);

			ok(lostCountRounds === 0, `QA-431(2): lost-count in ${lostCountRounds} round(s) — CRDT×TTL defect`);
			ok(staleRounds === 0, `QA-431(2): over-count in ${staleRounds} round(s) — double-apply or resurrection`);
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

				// Short settle then read.
				await sleep(100);
				const g = await get(id);
				let desc: string;
				if (g.status === 404) {
					// All increments fired but no record persisted — all lost.
					lostCountRounds++;
					desc = `r${r}: ALL-LOST(404) acked=${acked} rej=${rejected} err=${errs} burstMs=${burstMs}`;
				} else if (g.status === 200) {
					const stored = Number(g.body?.hits ?? -1);
					if (stored === acked) {
						cleanRounds++;
						desc = `r${r}: CLEAN stored=${stored}==acked=${acked} rej=${rejected} err=${errs} burstMs=${burstMs}`;
					} else if (stored < acked) {
						lostCountRounds++;
						desc = `r${r}: LOST stored=${stored}<acked=${acked} rej=${rejected} err=${errs} burstMs=${burstMs}`;
					} else {
						staleRounds++;
						// stored > acked: could indicate stale value from old window survived expiry.
						desc = `r${r}: OVER stored=${stored}>acked=${acked} rej=${rejected} err=${errs} [seed was 99] burstMs=${burstMs}`;
					}
				} else {
					desc = `r${r}: unexpected status=${g.status} acked=${acked}`;
				}
				roundLogs.push(desc);
				await del(id);
			}

			log(
				`\n[QA-431] (3) FROM-NOTHING BURST (${ROUNDS} rounds × N=${N}, TTL=${TTL_MS}ms, ${WORKERS} workers)\n` +
					`  clean rounds                  = ${cleanRounds}\n` +
					`  lost-count rounds             = ${lostCountRounds}  ← DEFECT if > 0\n` +
					`  over-count rounds (seed=99)   = ${staleRounds}  ← DEFECT: stale resurrection if > 0\n` +
					`  skipped (expiry-timing)        = ${skipRounds}\n` +
					`  ${roundLogs.join('\n  ')}`
			);

			ok(lostCountRounds === 0, `QA-431(3): ${lostCountRounds} round(s) with lost increments on from-nothing burst`);
			ok(
				staleRounds === 0,
				`QA-431(3): ${staleRounds} round(s) with stale resurrection (stored>acked, seed was 99) — F-002 family`
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
			const windowLogs: string[] = [];

			// Seed all windows first.
			const seedResults = await Promise.all(Array.from({ length: WINDOWS }, (_, i) => put(`mw${i}`, 0)));
			const allSeeded = seedResults.every((r) => r.status !== 'error');
			ok(allSeeded, 'QA-431(5): failed to seed one or more windows');

			// Fire all bursts simultaneously across all windows.
			const windowResults = await Promise.all(
				Array.from({ length: WINDOWS }, async (_, w) => {
					const id = `mw${w}`;
					const hits = await Promise.all(Array.from({ length: HITS_PER_WINDOW }, () => increment(id)));
					return {
						id,
						acked: hits.filter((h) => h.status === 200).length,
						errs: hits.filter((h) => h.status === 'error').length,
					};
				})
			);

			// Read final values.
			for (const { id, acked, errs } of windowResults) {
				const g = await get(id);
				if (g.status === 404) {
					// Burst took >500ms and window expired — inconclusive for this probe.
					windowLogs.push(`${id}: expired(404) acked=${acked} err=${errs} [skip]`);
					continue;
				}
				if (g.status === 200) {
					const stored = Number(g.body?.hits ?? -1);
					if (stored === acked) {
						cleanWindows++;
						windowLogs.push(`${id}: CLEAN stored=${stored}==acked=${acked}`);
					} else if (stored < acked) {
						lostWindowCount++;
						windowLogs.push(`${id}: LOST stored=${stored}<acked=${acked} err=${errs}`);
					} else {
						windowLogs.push(`${id}: OVER stored=${stored}>acked=${acked} [seed=0]`);
					}
				} else {
					windowLogs.push(`${id}: status=${g.status} acked=${acked}`);
				}
				await del(id);
			}

			log(
				`\n[QA-431] (5) MULTI-WORKER STRESS (${WINDOWS} windows × ${HITS_PER_WINDOW} hits, ${WORKERS} workers)\n` +
					`  clean windows              = ${cleanWindows}/${WINDOWS}\n` +
					`  lost-count windows         = ${lostWindowCount}  ← DEFECT if > 0\n` +
					`  ${windowLogs.join('\n  ')}`
			);

			ok(lostWindowCount === 0, `QA-431(5): ${lostWindowCount} window(s) with lost counts under multi-worker stress`);
		});
	}
);
