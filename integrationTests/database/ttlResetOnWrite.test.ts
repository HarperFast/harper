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
 *
 * The reset/gone checks additionally classify an unmeasurable window as INCONCLUSIVE (see
 * PresenceResult/AbsenceResult below) so a transport hiccup is never reported as a TTL
 * data-integrity defect. This is a diagnosis improvement, not a deflaking one, for surfaces 1-5:
 * an INCONCLUSIVE window still fails its assertion (resetObserved/goneObserved isn't `true`) — it
 * just fails with an accurate "couldn't measure" message instead of a false RESET/NO-RESET or
 * F-002 verdict. Only the race probe (surface 6) has a bucket that absorbs INCONCLUSIVE outright.
 */
import { suite, test, before, after } from 'node:test';
import { ok } from 'node:assert';
import { resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import http from 'node:http';
import https from 'node:https';
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

// The reset-presence check's window is inherently tight (order RESET_CHECK_SAFETY_MS +
// RESET_POLL_TIMEOUT_MS wide) because it has to fit between the original expiry and the
// reset-expiry. On a loaded runner, server latency alone can exceed that window even when TTL
// reset worked correctly — no per-sample budget tuning fixes that, since the window's width is
// bounded by TTL_S, not by how the samples inside it are scheduled. Retrying the whole
// seed→update→check scenario on INCONCLUSIVE (fresh id, fresh timing) is what actually
// distinguishes "this window was unlucky" from "TTL reset doesn't work."
const MAX_PROBE_ATTEMPTS = 3;

// Max extra slack for expiry (one background-sweep leeway).
const EXPIRY_POLL_MS = 5_000;
const EXPIRY_POLL_INTERVAL_MS = 200;
// Cap each gone-check sample well under the overall window, same reasoning as
// RESET_POLL_TIMEOUT_MS: a sample bound to httpRequest's full default timeout could consume the
// whole window on one slow response and get misread as the record surviving past its TTL (F-002
// stale resurrection).
const EXPIRY_POLL_SAMPLE_TIMEOUT_MS = 400;

// The "record is RESET" check polls across the whole valid window (past the original expiry, up
// to just before the reset-expiry) rather than sampling a single instant. Polling only helps if
// each sample is abandoned quickly: the window itself is a few hundred ms, so a sample bound to
// httpRequest's full default timeout would consume the whole window on one slow response, same
// as the single-check version it replaces. RESET_POLL_TIMEOUT_MS keeps each sample well under
// the overall window so a slow/stalled one is abandoned in time for a retry within it.
const RESET_POLL_INTERVAL_MS = 150;
const RESET_POLL_TIMEOUT_MS = 300;
// Gap between the conservative intermediate-sample deadline and the true reset-expiry. Bounds
// only the INTERMEDIATE samples in pollForPresent — the final sample deliberately runs all the
// way to the true expiry (see pollForPresent's docblock), so this no longer describes "the last
// poll," just how early the intermediate phase backs off to leave room for that final attempt.
const RESET_CHECK_SAFETY_MS = 200;

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
				const transport = u.protocol === 'https:' ? https : http;
				const headers: Record<string, string> = { Authorization: auth };
				if (body !== undefined) {
					headers['Content-Type'] = 'application/json';
					headers['Content-Length'] = String(Buffer.byteLength(body));
				}
				let wallClockTimer: ReturnType<typeof setTimeout>;
				const settle = (fn: () => void) => {
					clearTimeout(wallClockTimer);
					fn();
				};
				const req = transport.request(
					{ hostname: u.hostname, port: u.port, path: u.pathname + u.search, method, headers, timeout: timeoutMs },
					(res) => {
						const chunks: Buffer[] = [];
						res.on('data', (chunk) => chunks.push(chunk));
						res.on('error', (err) => settle(() => reject(err)));
						res.on('end', () =>
							settle(() =>
								resolvePromise({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf-8') })
							)
						);
					}
				);
				req.on('timeout', () => req.destroy(new Error(`request to ${url} timed out after ${timeoutMs}ms`)));
				req.on('error', (err) => settle(() => reject(err)));
				// `timeout` above is socket-*inactivity*, not wall-clock: a response that keeps
				// emitting bytes inside each interval never trips it, so every poller's "one sample
				// can't run past its budget" invariant isn't actually enforced by that option alone.
				// This timer is the real absolute per-sample deadline.
				wallClockTimer = setTimeout(
					() => req.destroy(new Error(`request to ${url} timed out after ${timeoutMs}ms (wall-clock)`)),
					timeoutMs
				);
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

		interface AbsenceResult {
			observed: boolean;
			// true only if the LAST full-budget sample admitted within the window returned neither
			// 200 nor 404 (timeout or transport error) — not "every sample ever," since a 200 goes
			// stale: it proves the record hadn't expired *yet*, not that it's still present now.
			// Without this, a stalled response on the deciding sample reads as "still present" and
			// gets reported as F-002 stale resurrection, when it's really "couldn't measure."
			inconclusive: boolean;
		}

		/**
		 * Poll until the record is absent (404), bounding every attempt to what's left before the
		 * deadline so no sample can start once the window has closed. Returns as soon as any sample
		 * observes it absent. A sample is only admitted — and only gets to decide conclusiveness —
		 * once it can run with the FULL EXPIRY_POLL_SAMPLE_TIMEOUT_MS budget: since conclusiveness
		 * comes from the last completed sample (see below), a window with a fixed size always has a
		 * final admitted sample, and admitting one with a shortened, clamped budget would make that
		 * structurally-doomed sample the one deciding "still present" vs "couldn't measure" — gating
		 * the suite's loudest data-integrity alarm on its least reliable measurement.
		 */
		async function pollUntilGone(id: string, maxMs: number): Promise<AbsenceResult> {
			const deadline = Date.now() + maxMs;
			// Conclusiveness must come from the LAST completed sample, not "any sample, anywhere in
			// the window": a 200 near the start only proves the record hadn't expired *yet*, and
			// stays true no matter how stale it gets. If it were sticky, one early 200 (the common
			// case — pollUntilGone is typically entered right after an immediate present-check) would
			// make every later stall in the rest of the window read as conclusive "still present",
			// which is exactly the stall-reads-as-defect failure this poll exists to prevent.
			let lastSampleClean = false;
			while (deadline - Date.now() >= EXPIRY_POLL_SAMPLE_TIMEOUT_MS) {
				const { status } = await getRecord(id, EXPIRY_POLL_SAMPLE_TIMEOUT_MS);
				if (status === 404) return { observed: true, inconclusive: false };
				lastSampleClean = status === 200;
				const sleepBudgetMs = deadline - Date.now();
				if (sleepBudgetMs <= 0) break;
				await sleep(Math.min(EXPIRY_POLL_INTERVAL_MS, sleepBudgetMs));
			}
			return { observed: false, inconclusive: !lastSampleClean };
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
		 * Poll for the record being present (200) up to expiresAt (the true reset-expiry), in two
		 * phases. Intermediate samples are bounded to RESET_POLL_TIMEOUT_MS and only admitted with
		 * that full budget, and run up to deadlineAt (the conservative cutoff) — mirrors
		 * pollUntilGone's "don't admit a sample you can't give a fair budget" rule, so one stall
		 * can't eat the whole window and block a retry. The FINAL sample instead gets whatever time
		 * remains up to expiresAt: a 200 landing at any point up to the real reset-expiry proves the
		 * clock reset (the request can't have started before the original expiry), so clamping the
		 * deciding sample to the intermediate budget would silently discard a valid late response
		 * under load — the same masking failure this poll exists to avoid, just on the positive
		 * (200) side of the check instead of the negative (404) side handled by expiresAt below.
		 */
		async function pollForPresent(id: string, deadlineAt: number, expiresAt: number): Promise<PresenceResult> {
			let sawCleanSample = false;
			while (deadlineAt - Date.now() >= RESET_POLL_TIMEOUT_MS) {
				const { status } = await getRecord(id, RESET_POLL_TIMEOUT_MS);
				if (status === 200) return { observed: true, inconclusive: false };
				if (status === 404 && Date.now() <= expiresAt) sawCleanSample = true;
				const sleepBudgetMs = deadlineAt - Date.now();
				if (sleepBudgetMs <= 0) break;
				await sleep(Math.min(RESET_POLL_INTERVAL_MS, sleepBudgetMs));
			}
			const finalBudgetMs = expiresAt - Date.now();
			if (finalBudgetMs > 0) {
				const { status } = await getRecord(id, finalBudgetMs);
				if (status === 200) return { observed: true, inconclusive: false };
				if (status === 404 && Date.now() <= expiresAt) sawCleanSample = true;
			}
			return { observed: false, inconclusive: !sawCleanSample };
		}

		// ── generic harness ───────────────────────────────────────────────────────

		/** One attempt at the seed→update→check scenario. Does not retry. */
		async function probeSurfaceOnce(
			label: string,
			id: string,
			doUpdate: (id: string) => Promise<number | 'error'>
		): Promise<{ result: SurfaceResult; inconclusive: boolean }> {
			const result: SurfaceResult = {
				surface: label,
				resetObserved: 'not-checked',
				goneObserved: 'not-checked',
				finding: '',
			};
			let inconclusive = false;

			try {
				// t=0: seed
				const seedStatus = await restPut(id, { tag: 'seed', n: 0 });
				const seedAt = Date.now();
				if (seedStatus === 'error') {
					// A transport failure here carries strictly less information than a half-measured
					// window — MAX_PROBE_ATTEMPTS exists precisely for this class of bad luck, so this
					// should retry too, not fail hard. Only a genuine non-2xx status is a real defect.
					inconclusive = true;
					result.finding = 'INCONCLUSIVE — seed PUT failed to complete (transport issue, not a TTL defect)';
					return { result, inconclusive };
				}
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
				if (updateStatus === 'error') {
					inconclusive = true;
					result.finding = 'INCONCLUSIVE — update failed to complete (transport issue, not a TTL defect)';
					return { result, inconclusive };
				}
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
				const goneResult = await pollUntilGone(id, EXPIRY_POLL_MS);
				result.goneObserved = goneResult.inconclusive ? 'not-checked' : goneResult.observed;

				// A conclusive negative reading on EITHER axis is already actionable defect evidence
				// on its own (NO-RESET from the reset axis, DID-NOT-EXPIRE/F-002 from the gone axis) —
				// it must never be discarded by retrying just because the OTHER axis came back
				// inconclusive. The retry wrapper only retries when `inconclusive` is true, so gating
				// that flag on "is there NO conclusive defect to report" (not "is either axis merely
				// unmeasured") is what keeps a measured defect from being thrown away and silently
				// replaced by a lucky attempt on a fresh id.
				const resetIsNoReset = !resetResult.inconclusive && resetResult.observed === false;
				const goneIsDidNotExpire = !goneResult.inconclusive && goneResult.observed === false;

				if (resetResult.inconclusive && goneResult.inconclusive) {
					// Never a clean read (200 or 404) on EITHER axis — a transport hiccup, not a TTL
					// data signal either way.
					inconclusive = true;
					result.finding =
						'INCONCLUSIVE — no clean read within either check window (transport issue, not a TTL defect)';
				} else if (resetResult.inconclusive) {
					if (goneIsDidNotExpire) {
						// Reset axis unmeasured, but the gone axis conclusively caught the record
						// outliving its TTL — that's the suite's loudest defect signal and stands on
						// its own; don't let the unmeasured reset axis bury it under "INCONCLUSIVE".
						result.finding =
							'RESET-UNMEASURED + DID-NOT-EXPIRE (defect) — reset-check window inconclusive, but record conclusively outlived its TTL';
					} else {
						// Gone axis is clean (or also unreachable) and shows no defect — nothing to
						// report, this window genuinely couldn't measure the reset.
						inconclusive = true;
						result.finding =
							'INCONCLUSIVE — no clean read within the reset-check window (transport issue, not a TTL defect)';
					}
				} else if (goneResult.inconclusive) {
					if (resetIsNoReset) {
						// Symmetric case: reset axis conclusively measured NO-RESET; the deciding
						// (last full-budget) sample in the gone-check window didn't complete cleanly —
						// could follow several clean 200s earlier in the window (see pollUntilGone's
						// docblock) — but the reset defect is already conclusive regardless.
						result.finding =
							'NO-RESET (defect) + GONE-UNMEASURED — reset conclusively did not happen; gone-check window inconclusive';
					} else {
						inconclusive = true;
						result.finding =
							'INCONCLUSIVE — no clean read within the gone-check window (transport issue, not a TTL defect)';
					}
				} else if (result.resetObserved === true && result.goneObserved === true) {
					result.finding = 'RESET+EXPIRED — correct TTL reset';
				} else if (result.resetObserved === false && result.goneObserved === true) {
					result.finding = 'NO-RESET — expired at original write time (defect if other surfaces reset)';
				} else if (result.resetObserved === true && result.goneObserved === false) {
					result.finding = 'RESET but DID-NOT-EXPIRE — record outlived reset window (defect)';
				} else {
					result.finding = 'NEITHER — unexpected state';
				}
			} catch (err: any) {
				result.finding = `ERROR: ${err?.message ?? String(err)}`;
			} finally {
				await deleteRecord(id);
			}

			return { result, inconclusive };
		}

		/**
		 * Runs probeSurfaceOnce, retrying (fresh id, fresh timing) up to MAX_PROBE_ATTEMPTS times
		 * while the result is INCONCLUSIVE. The reset-check window is inherently tight (see
		 * MAX_PROBE_ATTEMPTS above), so a single unlucky window shouldn't fail the suite this change
		 * exists to stabilize — but an attempt that's genuinely RESET/NO-RESET/DID-NOT-EXPIRE is
		 * conclusive and is never retried or discarded. This holds even when only ONE axis measured
		 * cleanly: probeSurfaceOnce only sets `inconclusive` when there's no conclusive defect signal
		 * on either axis (see its RESET-UNMEASURED/GONE-UNMEASURED branches) — a mixed
		 * unmeasured-axis-plus-conclusive-defect result is never retried either, so a real defect
		 * measured on one axis can't be thrown away just because the other axis stalled.
		 */
		async function probeSurface(
			label: string,
			idSuffix: string,
			doUpdate: (id: string) => Promise<number | 'error'>
		): Promise<void> {
			let outcome: { result: SurfaceResult; inconclusive: boolean } | undefined;
			for (let attempt = 1; attempt <= MAX_PROBE_ATTEMPTS; attempt++) {
				const id = attempt === 1 ? `qa269-${idSuffix}` : `qa269-${idSuffix}-r${attempt}`;
				outcome = await probeSurfaceOnce(label, id, doUpdate);
				if (!outcome.inconclusive) break;
				if (attempt < MAX_PROBE_ATTEMPTS) {
					console.log(`[QA-269:${ENGINE}] ${label}: attempt ${attempt} inconclusive, retrying`);
				}
			}

			matrix.push(outcome!.result);
			console.log(
				`[QA-269:${ENGINE}] ${label}: reset=${outcome!.result.resetObserved} gone=${outcome!.result.goneObserved} → ${outcome!.result.finding}`
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
				// The update itself landed at/after the record's natural expiry — this round never
				// entered the intended "narrow window right before expiry" race at all, regardless of
				// what the immediate check below would have shown. Excluded from the F-002 coverage
				// floor's denominator (see the assertion below) rather than counted as any other
				// outcome, so a loaded runner that keeps missing the window can't manufacture either a
				// false pass (nothing raced, so nothing could resurrect) or a false coverage failure.
				windowMissed: 0,
			};

			for (let round = 0; round < ROUNDS; round++) {
				const id = `qa269-race-${round}`;

				// Seed. The server applies the write at some point at-or-before the response lands, so
				// the record's true expiry is anywhere in [seedIssuedAt + TTL_MS, seedAt + TTL_MS].
				const seedIssuedAt = Date.now();
				const seedStatus = await restPut(id, { tag: 'seed-race', n: 0 });
				const seedAt = Date.now();
				if (seedStatus === 'error' || (seedStatus !== 200 && seedStatus !== 204)) {
					outcomes.transportErr++;
					continue;
				}

				// Wait until just before the EARLIEST possible natural expiry (anchored on the seed's
				// ISSUE time, not its response time): anchoring on the response time — as an earlier
				// version of this probe did — could put fireAt after the record had already expired
				// if the seed's own round-trip exceeded WINDOW_BEFORE_EXPIRY_MS, silently turning the
				// "race" into a plain post-expiry write against a dead key.
				const fireAt = seedIssuedAt + TTL_MS - WINDOW_BEFORE_EXPIRY_MS;
				const waitMs = fireAt - Date.now();
				if (waitMs > 0) await sleep(waitMs);

				// Fire the update in the expiry race window.
				const updateIssuedAt = Date.now();
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
				// Gate on when the update was ISSUED, not when its response landed (updateAt): the
				// server could have applied it well before the response returned, so gating on
				// response time could discard a round that genuinely raced. seedAt (response time,
				// the LATEST possible natural expiry) stays the comparison bound — the conservative
				// choice, so this only marks a round windowMissed when it's certain to have missed.
				if (updateIssuedAt >= seedAt + TTL_MS) {
					// The update was issued after natural expiry could already have fired — this round
					// missed the race window it was meant to probe, independent of whatever the
					// record's state turns out to be.
					outcomes.windowMissed++;
					await deleteRecord(id);
					continue;
				}

				// Short pause to let the expiry sweep possibly run.
				await sleep(200);

				// Check immediately after the update, tightly bounded: an unbounded read here could
				// itself take long enough to cross the natural-expiry boundary, in which case a 404 no
				// longer distinguishes "the expiry scanner won" from "this GET was just slow" — see the
				// re-check below.
				const { status: immediateStatus } = await getRecord(id, EXPIRY_POLL_SAMPLE_TIMEOUT_MS);

				if (immediateStatus === 404 && Date.now() <= updateAt + TTL_MS) {
					// The expiry scanner won — update was lost or ran before expiry committed.
					outcomes.silentLoss++;
				} else if (immediateStatus === 404) {
					// A 404 that only completed after the record's natural (reset) expiry could
					// legitimately reflect it — the GET itself was the slow part, not the write path.
					// Undecidable from this sample alone.
					outcomes.transportErr++;
				} else if (immediateStatus === 200) {
					// Record present. Now wait to see if it expires at the RESET time or outlives it.
					const expectedGoneBy = updateAt + TTL_MS + 2000; // reset TTL + 2s slack
					const goneResult = await pollUntilGone(id, expectedGoneBy - Date.now() + 1000);
					if (goneResult.inconclusive) {
						// Never a clean read — a transport hiccup, not evidence either way. Counting
						// this as resurrection would raise the suite's loudest data-integrity alarm
						// for a stalled GET, which is exactly what this poll exists to avoid.
						outcomes.transportErr++;
					} else if (goneResult.observed) {
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
					`  transportErr = ${outcomes.transportErr}\n` +
					`  windowMissed = ${outcomes.windowMissed}  ← update landed at/after natural expiry, never raced\n`
			);

			// silentLoss is tolerable (expiry beat the update — a timing race, not a data defect)
			// resurrection is a defect: the record should either be gone or have a new TTL.
			ok(
				outcomes.resurrection === 0,
				`F-002 stale resurrection detected in ${outcomes.resurrection}/${ROUNDS} rounds [${ENGINE}]`
			);
			// Rounds that never entered the race window (windowMissed) can't tell us anything about
			// F-002 either way — excluded from the denominator so a loaded runner that keeps missing
			// the window can't manufacture a coverage failure out of a race that never happened.
			// Checked before the generic smoke guard below so an all-windowMissed run reports its
			// actual, more specific cause instead of a generic "environment likely broken".
			const racedRounds = ROUNDS - outcomes.windowMissed;
			ok(
				racedRounds > 0,
				`all ${ROUNDS} rounds missed the intended race window (update landed at/after natural expiry) — ` +
					`environment too slow to run this probe meaningfully [${ENGINE}]`
			);
			// At least one round should complete cleanly (basic smoke guard).
			ok(outcomes.cleanReset + outcomes.silentLoss > 0, `No round completed cleanly — environment likely broken`);
			// Only cleanReset and resurrection rounds actually exercise the F-002 property —
			// silentLoss and updateError both `continue` before the resurrection check ever runs.
			// A first version of this guard capped transportErr alone, which missed that: a probe
			// where every round lands in silentLoss (a legitimate outcome of the exact race this
			// probe induces) would pass resurrection===0 having measured the property in zero
			// rounds. Assert on the measured set directly, over the raced rounds only.
			ok(
				outcomes.cleanReset + outcomes.resurrection >= racedRounds / 2,
				`only ${outcomes.cleanReset + outcomes.resurrection}/${racedRounds} raced rounds actually measured ` +
					`the F-002 property (cleanReset=${outcomes.cleanReset}, resurrection=${outcomes.resurrection}, ` +
					`silentLoss=${outcomes.silentLoss}, updateError=${outcomes.updateError}, ` +
					`transportErr=${outcomes.transportErr}, windowMissed=${outcomes.windowMissed}) — the ` +
					`resurrection===0 check above isn't meaningful with this little coverage [${ENGINE}]`
			);
		});
	}
);
