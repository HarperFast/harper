/**
 * QA-269 — TTL expiration clock reset consistency across write surfaces.
 *
 * Promoted from exploratory QA (qa-explorer campaign) after passing GREEN on both
 * RocksDB and LMDB engines.
 *
 * Question: does every write surface reset the TTL clock?
 * Surfaces under test:
 *   1. REST PUT  (full replace)
 *   2. REST PATCH (partial update)
 *   3. ops update (HarperDB operations API)
 *   4. SQL UPDATE
 *   5. addTo     (atomic numeric increment via custom resource)
 *
 * Protocol for each surface:
 *   t=0   PUT the seed record (TTL=2s → would expire at t≈2s)
 *   t=1   issue the surface's update (N/2 = 1s — within TTL, before first expiry)
 *   t=3   check: record PRESENT  → clock RESET (update-time+2s ≈ t=3)
 *   t=4.5 check: record ABSENT   → confirms expiry happened after reset, not before
 *
 * Also includes a race probe: fire an update in the narrow window just before expiry
 * and check for F-002 family stale resurrection.
 *
 * Reproduction:
 *   npm run test:integration -- "integrationTests/database/ttlResetOnWrite.test.ts"
 *   HARPER_STORAGE_ENGINE=lmdb npm run test:integration -- "integrationTests/database/ttlResetOnWrite.test.ts"
 *
 * Uses node:http directly rather than fetch()/undici: this suite's whole premise is measuring
 * request-to-request timing against a TTL clock, and a global-fetch client stall (of unbounded,
 * multi-second duration under some Node/undici builds — see harper#2025) reads as a false
 * NO-RESET no matter how the check windows are computed. node:http isn't subject to that stall.
 * Root cause: nodejs/undici#5600 (unref'd idle-socket-validation setImmediate stalls fetch() on an
 * otherwise-idle event loop), bundled into Node via undici 8.9.0 (used by 26.5.1); fixed upstream by
 * nodejs/undici#5609 but not yet in a released undici/Node build as of this writing.
 */
import { suite, test, before, after } from 'node:test';
import { ok } from 'node:assert';
import { resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import http from 'node:http';
import { setupHarperWithFixture, teardownHarper, type ContextWithHarper } from '@harperfast/integration-testing';
// @ts-expect-error utils/client.mjs has no type declarations; runtime resolves fine
import { createApiClient } from '../apiTests/utils/client.mjs';

const FIXTURE_PATH = resolve(import.meta.dirname, 'ttl-reset-on-write');
const ENGINE = process.env.HARPER_STORAGE_ENGINE === 'lmdb' ? 'lmdb' : 'rocksdb';

// TTL in seconds (must match schema.graphql expiration: 2).
const TTL_S = 2;
const TTL_MS = TTL_S * 1000;

// Time to wait between seed write and update (N/2).
const HALF_TTL_MS = TTL_MS / 2; // 1000ms

// After the update, we wait until original expiry has passed, then check record is PRESENT.
// original-expiry = ~TTL_MS after seed. update issued at ~HALF_TTL_MS.
// If clock reset: expires at update_time + TTL_MS ≈ HALF_TTL_MS + TTL_MS = 3000ms.
// We check at CHECK_RESET_MS (must be > TTL_MS but < HALF_TTL_MS + TTL_MS).
const CHECK_RESET_MS = TTL_MS + 200; // 2200ms — past original expiry, before reset expiry

// Note: the "record is GONE" check anchors on the measured update time (updateAt + TTL_MS + slack),
// not a seed-relative constant, so it accounts for real scheduling/HTTP drift in when the update lands.

// Max extra slack for expiry (one background-sweep leeway).
const EXPIRY_POLL_MS = 5_000;
const EXPIRY_POLL_INTERVAL_MS = 200;

// The "record is RESET" check polls across the whole valid window (past the original expiry, up
// to just before the reset-expiry) rather than sampling a single instant. Polling only helps if
// each sample is abandoned quickly: the window itself is a few hundred ms, so a sample bound to
// httpRequest's full default timeout would consume the whole window on one slow response, same
// as the single-check version it replaces. RESET_POLL_TIMEOUT_MS keeps each sample well under
// the poll interval so a slow/stalled one is abandoned in time for a retry within the window.
const RESET_POLL_INTERVAL_MS = 150;
const RESET_POLL_TIMEOUT_MS = 300;
// Safety margin before the reset-expiry deadline, so the last poll isn't racing the sweep itself.
const RESET_CHECK_SAFETY_MS = 200;
// Below this much time left in the window, a sample is doomed before it starts (its timeout would
// be clamped to a few ms) — skip it rather than counting a guaranteed failure toward "no clean read".
const RESET_POLL_MIN_REMAINING_MS = 50;

const skipSuite = process.platform === 'win32' || process.env.HARPER_RUNTIME === 'bun';

/** Matrix accumulator */
interface SurfaceResult {
	surface: string;
	resetObserved: boolean | 'not-checked';
	goneObserved: boolean | 'not-checked';
	finding: string;
}
const matrix: SurfaceResult[] = [];

suite(
	`QA-269 TTL reset consistency across write surfaces [${ENGINE}]`,
	{ skip: skipSuite },
	(ctx: ContextWithHarper) => {
		let httpURL: string;
		let auth: string;
		let opsURL: string;

		before(async () => {
			await setupHarperWithFixture(ctx, FIXTURE_PATH, {
				config: {
					threads: { count: 4 },
					...(ENGINE === 'lmdb' ? { storage: { engine: 'lmdb' } } : {}),
				},
				env: {},
			});

			const client = createApiClient(ctx.harper);
			httpURL = ctx.harper.httpURL;
			opsURL = ctx.harper.operationsAPIURL;
			auth = client.headers.Authorization;

			// Readiness poll: wait until Expiry is live.
			const deadline = Date.now() + 30_000;
			while (Date.now() < deadline) {
				try {
					const { status } = await httpRequest('GET', `${httpURL}/Expiry/`);
					if (status !== 503) break;
				} catch {
					/* not ready */
				}
				await sleep(250);
			}
		});

		after(async () => {
			await teardownHarper(ctx);
			// Print the matrix
			console.log(`\n[QA-269:${ENGINE}] WRITE-SURFACE TTL RESET MATRIX`);
			console.log('  surface            reset-at-t+2.2s  gone-at-t+3.5s  finding');
			for (const r of matrix) {
				console.log(
					`  ${r.surface.padEnd(18)} ${String(r.resetObserved).padEnd(16)} ${String(r.goneObserved).padEnd(15)} ${r.finding}`
				);
			}
		});

		// ── low-level helpers ─────────────────────────────────────────────────────
		// All requests go through node:http directly (see the file-header note on why fetch()
		// isn't used here).

		function httpRequest(
			method: string,
			url: string,
			body?: string,
			timeoutMs = 5_000
		): Promise<{ status: number; body: string }> {
			return new Promise((resolvePromise, reject) => {
				const u = new URL(url);
				const headers: Record<string, string> = { Authorization: auth };
				if (body !== undefined) {
					headers['Content-Type'] = 'application/json';
					headers['Content-Length'] = String(Buffer.byteLength(body));
				}
				const req = http.request(
					{ hostname: u.hostname, port: u.port, path: u.pathname + u.search, method, headers, timeout: timeoutMs },
					(res) => {
						const chunks: Buffer[] = [];
						res.on('data', (chunk) => chunks.push(chunk));
						res.on('error', reject);
						res.on('end', () =>
							resolvePromise({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf-8') })
						);
					}
				);
				req.on('timeout', () => req.destroy(new Error(`request to ${url} timed out after ${timeoutMs}ms`)));
				req.on('error', reject);
				req.end(body);
			});
		}

		async function restPut(id: string, body: Record<string, unknown>): Promise<number | 'error'> {
			try {
				const { status } = await httpRequest('PUT', `${httpURL}/Expiry/${id}`, JSON.stringify({ id, ...body }));
				return status;
			} catch {
				return 'error';
			}
		}

		async function restPatch(id: string, body: Record<string, unknown>): Promise<number | 'error'> {
			try {
				const { status } = await httpRequest('PATCH', `${httpURL}/Expiry/${id}`, JSON.stringify(body));
				return status;
			} catch {
				return 'error';
			}
		}

		async function opsUpdate(id: string, fields: Record<string, unknown>): Promise<number | 'error'> {
			try {
				const { status } = await httpRequest(
					'POST',
					opsURL,
					JSON.stringify({ operation: 'update', schema: 'data', table: 'Expiry', records: [{ id, ...fields }] })
				);
				return status;
			} catch {
				return 'error';
			}
		}

		// AlaSQL limitation: string literals in SET clauses and reserved column names cause
		// parse errors, so we use `SET n = <number>` which parses cleanly.
		async function sqlUpdate(id: string, newN: number): Promise<number | 'error'> {
			try {
				const { status } = await httpRequest(
					'POST',
					opsURL,
					JSON.stringify({ operation: 'sql', sql: `UPDATE data.Expiry SET n = ${newN} WHERE id = '${id}'` })
				);
				return status;
			} catch {
				return 'error';
			}
		}

		async function addTo(id: string, delta = 1): Promise<number | 'error'> {
			try {
				const { status } = await httpRequest('POST', `${httpURL}/AddToCounter/`, JSON.stringify({ id, delta }));
				return status;
			} catch {
				return 'error';
			}
		}

		async function getRecord(id: string, timeoutMs?: number): Promise<{ status: number | 'error'; body: any }> {
			try {
				const { status, body: rawBody } = await httpRequest('GET', `${httpURL}/Expiry/${id}`, undefined, timeoutMs);
				let body: any = null;
				if (status === 200) {
					try {
						body = JSON.parse(rawBody);
					} catch {
						/* ignore */
					}
				}
				return { status, body };
			} catch {
				return { status: 'error', body: null };
			}
		}

		async function deleteRecord(id: string): Promise<void> {
			try {
				await httpRequest('DELETE', `${httpURL}/Expiry/${id}`);
			} catch {
				/* best-effort */
			}
		}

		/**
		 * Poll until the record is absent (404) or timeout.
		 * Returns true if it went absent within the deadline.
		 */
		async function pollUntilGone(id: string, maxMs: number): Promise<boolean> {
			const deadline = Date.now() + maxMs;
			while (Date.now() < deadline) {
				const { status } = await getRecord(id);
				if (status === 404) return true;
				await sleep(EXPIRY_POLL_INTERVAL_MS);
			}
			return false;
		}

		interface PresenceResult {
			observed: boolean;
			// true only if every sample that completed inside the real reset-expiry (expiresAt)
			// failed to return a clean read (200 or 404) — i.e. we never got a trustworthy read at
			// all. A 404 that lands after expiresAt doesn't count as a clean sample: the record may
			// have genuinely expired only *because* the check ran late, so that 404 could reflect a
			// correct reset rather than a real NO-RESET. Note expiresAt, not the (earlier, more
			// conservative) polling deadlineAt: a 404 landing between the two is still trustworthy —
			// the real reset-expiry hasn't passed — and treating it as unclean would bias this check
			// toward masking the very NO-RESET regressions it exists to catch. Distinguishes
			// "couldn't measure" from an actual NO-RESET signal, so a transport hiccup never gets
			// reported as a TTL data-integrity defect.
			inconclusive: boolean;
		}

		/**
		 * Poll for the record being present (200), bounding every attempt and sleep to what's left
		 * before deadlineAt so no sample can start once the window has closed. Returns as soon as
		 * any sample observes it present. Each attempt is capped at RESET_POLL_TIMEOUT_MS (see its
		 * definition above) — and further capped to the remaining time near the deadline — so one
		 * slow/stalled response can't consume the whole window or run past it. Samples with less
		 * than RESET_POLL_MIN_REMAINING_MS left are skipped rather than attempted: a timeout clamped
		 * to a few ms is a guaranteed failure, not a real absence of a clean read.
		 */
		async function pollForPresent(id: string, deadlineAt: number, expiresAt: number): Promise<PresenceResult> {
			let sawCleanSample = false;
			while (deadlineAt - Date.now() >= RESET_POLL_MIN_REMAINING_MS) {
				const remainingMs = deadlineAt - Date.now();
				const { status } = await getRecord(id, Math.min(RESET_POLL_TIMEOUT_MS, remainingMs));
				if (status === 200) return { observed: true, inconclusive: false };
				if (status === 404 && Date.now() <= expiresAt) sawCleanSample = true;
				const sleepBudgetMs = deadlineAt - Date.now();
				if (sleepBudgetMs <= 0) break;
				await sleep(Math.min(RESET_POLL_INTERVAL_MS, sleepBudgetMs));
			}
			return { observed: false, inconclusive: !sawCleanSample };
		}

		// ── generic harness ───────────────────────────────────────────────────────

		async function probeSurface(
			label: string,
			idSuffix: string,
			doUpdate: (id: string) => Promise<number | 'error'>
		): Promise<void> {
			const id = `qa269-${idSuffix}`;
			const result: SurfaceResult = {
				surface: label,
				resetObserved: 'not-checked',
				goneObserved: 'not-checked',
				finding: '',
			};

			try {
				// t=0: seed
				const seedStatus = await restPut(id, { tag: 'seed', n: 0 });
				const seedAt = Date.now();
				ok(seedStatus === 200 || seedStatus === 204, `[${label}] seed PUT returned ${seedStatus}`);

				// t=N/2: update
				const waitToUpdate = seedAt + HALF_TTL_MS - Date.now();
				if (waitToUpdate > 0) await sleep(waitToUpdate);
				// Anchor the reset-expiry deadline on when the update was ISSUED, not when its
				// response returned: the server applies the reset at-or-before the response lands,
				// so anchoring post-response erodes RESET_CHECK_SAFETY_MS by the update's own
				// round-trip time.
				const updateIssuedAt = Date.now();
				const updateStatus = await doUpdate(id);
				const updateAt = Date.now();
				ok(
					updateStatus === 200 || updateStatus === 204,
					`[${label}] update returned ${updateStatus} (expected 200/204)`
				);

				// Wait until the ORIGINAL expiry has passed, then poll for presence up until just
				// before the reset-expiry would fire (see pollForPresent/RESET_POLL_INTERVAL_MS).
				const checkResetAt = seedAt + CHECK_RESET_MS;
				const waitForCheck = checkResetAt - Date.now();
				if (waitForCheck > 0) await sleep(waitForCheck);

				const resetDeadline = updateIssuedAt + TTL_MS - RESET_CHECK_SAFETY_MS;
				const resetExpiresAt = updateIssuedAt + TTL_MS;
				const resetResult = await pollForPresent(id, resetDeadline, resetExpiresAt);
				result.resetObserved = resetResult.inconclusive ? 'not-checked' : resetResult.observed;

				// Now wait until well past the RESET expiry window (update_time + TTL_MS + slack).
				const checkGoneAt = updateAt + TTL_MS + 1500;
				const waitForGone = checkGoneAt - Date.now();
				if (waitForGone > 0) await sleep(waitForGone);

				// Poll for gone (allow one extra sweep cycle).
				result.goneObserved = await pollUntilGone(id, EXPIRY_POLL_MS);

				if (resetResult.inconclusive) {
					// Never a clean read (200 or 404) within the window — a transport hiccup, not a
					// TTL data signal either way. Reported distinctly so it isn't mistaken for a
					// TTL-reset defect.
					result.finding =
						'INCONCLUSIVE — no clean read within the reset-check window (transport issue, not a TTL defect)';
				} else if (result.resetObserved && result.goneObserved) {
					result.finding = 'RESET+EXPIRED — correct TTL reset';
				} else if (!result.resetObserved && result.goneObserved) {
					result.finding = 'NO-RESET — expired at original write time (defect if other surfaces reset)';
				} else if (result.resetObserved && !result.goneObserved) {
					result.finding = 'RESET but DID-NOT-EXPIRE — record outlived reset window (defect)';
				} else {
					result.finding = 'NEITHER — unexpected state';
				}
			} catch (err: any) {
				result.finding = `ERROR: ${err?.message ?? String(err)}`;
			} finally {
				await deleteRecord(id);
			}

			matrix.push(result);
			console.log(
				`[QA-269:${ENGINE}] ${label}: reset=${result.resetObserved} gone=${result.goneObserved} → ${result.finding}`
			);
		}

		// ── surface tests ─────────────────────────────────────────────────────────

		test('1. REST PUT full-replace resets TTL', async () => {
			await probeSurface('REST-PUT', 'put', (id) => restPut(id, { tag: 'updated-put', n: 1 }));
			const r = matrix.find((m) => m.surface === 'REST-PUT')!;
			ok(r.resetObserved === true, `REST-PUT: expected TTL reset, got reset=${r.resetObserved}. Finding: ${r.finding}`);
			ok(r.goneObserved === true, `REST-PUT: record should have expired after reset TTL. Finding: ${r.finding}`);
		});

		test('2. REST PATCH partial-update resets TTL', async () => {
			await probeSurface('REST-PATCH', 'patch', (id) => restPatch(id, { tag: 'updated-patch' }));
			const r = matrix.find((m) => m.surface === 'REST-PATCH')!;
			ok(
				r.resetObserved === true,
				`REST-PATCH: expected TTL reset, got reset=${r.resetObserved}. Finding: ${r.finding}`
			);
			ok(r.goneObserved === true, `REST-PATCH: record should have expired after reset TTL. Finding: ${r.finding}`);
		});

		test('3. ops update resets TTL', async () => {
			await probeSurface('ops-update', 'ops', (id) => opsUpdate(id, { tag: 'updated-ops' }));
			const r = matrix.find((m) => m.surface === 'ops-update')!;
			ok(
				r.resetObserved === true,
				`ops-update: expected TTL reset, got reset=${r.resetObserved}. Finding: ${r.finding}`
			);
			ok(r.goneObserved === true, `ops-update: record should have expired after reset TTL. Finding: ${r.finding}`);
		});

		test('4. SQL UPDATE resets TTL', async () => {
			await probeSurface('SQL-UPDATE', 'sql', (id) => sqlUpdate(id, 99));
			const r = matrix.find((m) => m.surface === 'SQL-UPDATE')!;
			ok(
				r.resetObserved === true,
				`SQL-UPDATE: expected TTL reset, got reset=${r.resetObserved}. Finding: ${r.finding}`
			);
			ok(r.goneObserved === true, `SQL-UPDATE: record should have expired after reset TTL. Finding: ${r.finding}`);
		});

		test('5. addTo atomic increment resets TTL', async () => {
			await probeSurface('addTo', 'addto', (id) => addTo(id, 5));
			const r = matrix.find((m) => m.surface === 'addTo')!;
			ok(r.resetObserved === true, `addTo: expected TTL reset, got reset=${r.resetObserved}. Finding: ${r.finding}`);
			ok(r.goneObserved === true, `addTo: record should have expired after reset TTL. Finding: ${r.finding}`);
		});

		// ── race probe ────────────────────────────────────────────────────────────
		//
		// Fire an update in the narrow window just before expiry. Check for:
		//   - resurrection (stale value survives past expected expiry → F-002 family)
		//   - clean overwrite (update wins, new TTL applies)
		//   - silent loss (404 immediately after update)

		test('6. race: update during expiry window', async () => {
			const ROUNDS = 8;
			const WINDOW_BEFORE_EXPIRY_MS = 100;

			const outcomes = {
				cleanReset: 0, // update ACKed, record present immediately after, then expires
				silentLoss: 0, // update ACKed (2xx), but record 404 immediately after
				resurrection: 0, // record survives past the reset TTL (stale resurrection F-002)
				updateError: 0, // update returned non-2xx
				transportErr: 0,
			};

			for (let round = 0; round < ROUNDS; round++) {
				const id = `qa269-race-${round}`;

				// Seed
				const seedStatus = await restPut(id, { tag: 'seed-race', n: 0 });
				const seedAt = Date.now();
				if (seedStatus === 'error' || (seedStatus !== 200 && seedStatus !== 204)) {
					outcomes.transportErr++;
					continue;
				}

				// Wait until just before the natural expiry fires.
				const fireAt = seedAt + TTL_MS - WINDOW_BEFORE_EXPIRY_MS;
				const waitMs = fireAt - Date.now();
				if (waitMs > 0) await sleep(waitMs);

				// Fire the update in the expiry race window.
				const updateStatus = await restPut(id, { tag: `raced${round}`, n: round + 1 });
				const updateAt = Date.now();

				if (updateStatus === 'error') {
					outcomes.transportErr++;
					await deleteRecord(id);
					continue;
				}
				if (updateStatus !== 200 && updateStatus !== 204) {
					outcomes.updateError++;
					await deleteRecord(id);
					continue;
				}

				// Short pause to let the expiry sweep possibly run.
				await sleep(200);

				// Check immediately after the update.
				const { status: immediateStatus } = await getRecord(id);

				if (immediateStatus === 404) {
					// The expiry scanner won — update was lost or ran before expiry committed.
					outcomes.silentLoss++;
				} else if (immediateStatus === 200) {
					// Record present. Now wait to see if it expires at the RESET time or outlives it.
					const expectedGoneBy = updateAt + TTL_MS + 2000; // reset TTL + 2s slack
					const gone = await pollUntilGone(id, expectedGoneBy - Date.now() + 1000);
					if (gone) {
						outcomes.cleanReset++;
					} else {
						// Still present past reset TTL — stale resurrection?
						outcomes.resurrection++;
					}
				} else {
					outcomes.transportErr++;
				}

				await deleteRecord(id);
			}

			console.log(
				`\n[QA-269:${ENGINE}] RACE PROBE (${ROUNDS} rounds, fire ${WINDOW_BEFORE_EXPIRY_MS}ms before expiry):\n` +
					`  cleanReset   = ${outcomes.cleanReset}\n` +
					`  silentLoss   = ${outcomes.silentLoss}  ← update ACKed but immediately 404\n` +
					`  resurrection = ${outcomes.resurrection}  ← F-002 family: stale value outlives reset TTL\n` +
					`  updateError  = ${outcomes.updateError}\n` +
					`  transportErr = ${outcomes.transportErr}\n`
			);

			// silentLoss is tolerable (expiry beat the update — a timing race, not a data defect)
			// resurrection is a defect: the record should either be gone or have a new TTL.
			ok(
				outcomes.resurrection === 0,
				`F-002 stale resurrection detected in ${outcomes.resurrection}/${ROUNDS} rounds [${ENGINE}]`
			);
			// At least one round should complete cleanly (basic smoke guard).
			ok(outcomes.cleanReset + outcomes.silentLoss > 0, `No round completed cleanly — environment likely broken`);
		});
	}
);
