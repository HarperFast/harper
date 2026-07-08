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
 */
import { suite, test, before, after } from 'node:test';
import { ok } from 'node:assert/strict';
import { resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
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
					const r = await fetch(`${httpURL}/Expiry/`, {
						method: 'GET',
						headers: { Authorization: auth },
						signal: AbortSignal.timeout(3_000),
					});
					if (r.status !== 503) break;
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

		const jsonHeaders = () => ({
			'Content-Type': 'application/json',
			'Authorization': auth,
		});

		async function restPut(id: string, body: Record<string, unknown>): Promise<number | 'error'> {
			try {
				const r = await fetch(`${httpURL}/Expiry/${id}`, {
					method: 'PUT',
					headers: jsonHeaders(),
					body: JSON.stringify({ id, ...body }),
					signal: AbortSignal.timeout(5_000),
				});
				return r.status;
			} catch {
				return 'error';
			}
		}

		async function restPatch(id: string, body: Record<string, unknown>): Promise<number | 'error'> {
			try {
				const r = await fetch(`${httpURL}/Expiry/${id}`, {
					method: 'PATCH',
					headers: jsonHeaders(),
					body: JSON.stringify(body),
					signal: AbortSignal.timeout(5_000),
				});
				return r.status;
			} catch {
				return 'error';
			}
		}

		async function opsUpdate(id: string, fields: Record<string, unknown>): Promise<number | 'error'> {
			try {
				const r = await fetch(opsURL, {
					method: 'POST',
					headers: jsonHeaders(),
					body: JSON.stringify({
						operation: 'update',
						schema: 'data',
						table: 'Expiry',
						records: [{ id, ...fields }],
					}),
					signal: AbortSignal.timeout(5_000),
				});
				return r.status;
			} catch {
				return 'error';
			}
		}

		// AlaSQL limitation: string literals in SET clauses and reserved column names cause
		// parse errors, so we use `SET n = <number>` which parses cleanly.
		async function sqlUpdate(id: string, newN: number): Promise<number | 'error'> {
			try {
				const r = await fetch(opsURL, {
					method: 'POST',
					headers: jsonHeaders(),
					body: JSON.stringify({
						operation: 'sql',
						sql: `UPDATE data.Expiry SET n = ${newN} WHERE id = '${id}'`,
					}),
					signal: AbortSignal.timeout(5_000),
				});
				return r.status;
			} catch {
				return 'error';
			}
		}

		async function addTo(id: string, delta = 1): Promise<number | 'error'> {
			try {
				const r = await fetch(`${httpURL}/AddToCounter/`, {
					method: 'POST',
					headers: jsonHeaders(),
					body: JSON.stringify({ id, delta }),
					signal: AbortSignal.timeout(5_000),
				});
				return r.status;
			} catch {
				return 'error';
			}
		}

		async function getRecord(id: string): Promise<{ status: number | 'error'; body: any }> {
			try {
				const r = await fetch(`${httpURL}/Expiry/${id}`, {
					method: 'GET',
					headers: { Authorization: auth },
					signal: AbortSignal.timeout(5_000),
				});
				let body: any = null;
				if (r.status === 200) {
					try {
						body = await r.json();
					} catch {
						/* ignore */
					}
				}
				return { status: r.status, body };
			} catch {
				return { status: 'error', body: null };
			}
		}

		async function deleteRecord(id: string): Promise<void> {
			try {
				await fetch(`${httpURL}/Expiry/${id}`, {
					method: 'DELETE',
					headers: { Authorization: auth },
					signal: AbortSignal.timeout(5_000),
				});
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
				const updateStatus = await doUpdate(id);
				const updateAt = Date.now();
				ok(
					updateStatus === 200 || updateStatus === 204,
					`[${label}] update returned ${updateStatus} (expected 200/204)`
				);

				// Wait until the ORIGINAL expiry has passed, then check.
				const checkResetAt = seedAt + CHECK_RESET_MS;
				const waitForCheck = checkResetAt - Date.now();
				if (waitForCheck > 0) await sleep(waitForCheck);

				const { status: resetStatus } = await getRecord(id);
				result.resetObserved = resetStatus === 200;

				// Now wait until well past the RESET expiry window (update_time + TTL_MS + slack).
				const checkGoneAt = updateAt + TTL_MS + 1500;
				const waitForGone = checkGoneAt - Date.now();
				if (waitForGone > 0) await sleep(waitForGone);

				// Poll for gone (allow one extra sweep cycle).
				result.goneObserved = await pollUntilGone(id, EXPIRY_POLL_MS);

				if (result.resetObserved && result.goneObserved) {
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
