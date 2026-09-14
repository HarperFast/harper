/**
 * QA-431 companion — same fixture as ttl-rate-limiter-concurrent.test.ts, with the two
 * ingredients that make version-reuse cache staleness reproducible: GET pressure DURING each
 * burst (cold reads re-seed the VerificationTable), and per-window convergence classification —
 * CONVERGED_LATE (a read raced still-landing merges) vs STUCK_SHORT (a durably lost increment).
 */

import { suite, test, before, after } from 'node:test';
import { ok } from 'node:assert';
import { resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { setupHarperWithFixture, teardownHarper, type ContextWithHarper } from '@harperfast/integration-testing';
// @ts-expect-error utils/client.mjs has no type declarations
import { createApiClient } from '../apiTests/utils/client.mjs';

const FIXTURE_PATH = resolve(import.meta.dirname, 'ttl-rate-limiter-concurrent');
const WORKERS = 4;
const ROUNDS = 10;
const WINDOWS = 10;
const HITS = 50;

const skipSuite = process.platform === 'win32' || process.env.HARPER_RUNTIME === 'bun';

suite(
	`QA-431 convergence [${ROUNDS} rounds × ${WINDOWS} windows × ${HITS} hits, ${WORKERS} workers]`,
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
			const deadline = Date.now() + 30_000;
			let ready = false;
			while (Date.now() < deadline) {
				try {
					const r = await fetch(`${httpURL}/RateCounter/`, {
						headers: { Authorization: auth },
						signal: AbortSignal.timeout(3_000),
					});
					if (r.status !== 503) {
						ready = true;
						break;
					}
				} catch {
					/* not ready */
				}
				await sleep(200);
			}
			if (!ready) throw new Error('RateCounter never left 503 within the 30s readiness deadline');
		});

		after(async () => {
			await teardownHarper(ctx);
		});

		function hdrs() {
			return { 'Content-Type': 'application/json', 'Authorization': auth };
		}

		async function increment(id: string): Promise<number | 'error'> {
			try {
				const r = await fetch(`${httpURL}/RateIncrement/`, {
					method: 'POST',
					headers: hdrs(),
					body: JSON.stringify({ id }),
					signal: AbortSignal.timeout(6_000),
				});
				return r.status;
			} catch {
				return 'error';
			}
		}

		async function put(id: string, hits: number): Promise<number | 'error'> {
			try {
				const r = await fetch(`${httpURL}/RateCounter/${id}`, {
					method: 'PUT',
					headers: hdrs(),
					body: JSON.stringify({ id, hits }),
					signal: AbortSignal.timeout(5_000),
				});
				return r.status;
			} catch {
				return 'error';
			}
		}

		async function getHits(id: string): Promise<{ status: number | 'error'; hits: number | null }> {
			try {
				const r = await fetch(`${httpURL}/RateCounter/${id}`, {
					headers: { Authorization: auth },
					signal: AbortSignal.timeout(5_000),
				});
				if (r.status !== 200) return { status: r.status, hits: null };
				const body = await r.json();
				return { status: 200, hits: Number(body?.hits ?? -1) };
			} catch {
				return { status: 'error', hits: null };
			}
		}

		test('concurrent bursts with in-burst GET pressure converge to exact counts', async () => {
			let clean = 0;
			let convergedLate = 0;
			let stuckShort = 0;
			let over = 0;
			let inconclusive = 0;
			const anomalyLogs: string[] = [];

			for (let round = 0; round < ROUNDS; round++) {
				const ids = Array.from({ length: WINDOWS }, (_, w) => `r${round}w${w}`);
				await Promise.all(ids.map((id) => put(id, 0)));

				const perWindow = await Promise.all(
					ids.map(async (id) => {
						let bursting = true;
						const reader = (async () => {
							while (bursting) await getHits(id);
						})();
						const results = await Promise.all(Array.from({ length: HITS }, () => increment(id)));
						bursting = false;
						await reader;
						return {
							id,
							acked: results.filter((s) => s === 200).length,
							errs: results.filter((s) => s === 'error').length,
						};
					})
				);

				for (const { id, acked, errs } of perWindow) {
					// a window whose burst was wholly rejected measures nothing
					if (acked === 0) {
						inconclusive++;
						continue;
					}
					const first = await getHits(id);
					if (first.status !== 200) {
						inconclusive++;
						continue;
					}
					// a timed-out request may still have been applied, so anything up to acked+errs is
					// exact-or-explained; only beyond that is a double-apply
					if (first.hits! >= acked && first.hits! <= acked + errs) {
						clean++;
						continue;
					}
					if (first.hits! > acked + errs) {
						over++;
						anomalyLogs.push(`${id}: OVER first=${first.hits} acked=${acked} errs=${errs}`);
						continue;
					}
					const seen: (number | string)[] = [first.hits!];
					let finalHits: number | null = first.hits;
					let expired = false;
					const deadline = Date.now() + 400;
					while (Date.now() < deadline) {
						await sleep(20);
						const g = await getHits(id);
						if (g.status === 404) {
							expired = true;
							seen.push('404');
							break;
						}
						if (g.status !== 200) {
							seen.push(String(g.status));
							continue;
						}
						seen.push(g.hits!);
						finalHits = g.hits;
						if (g.hits! >= acked) break;
					}
					if (finalHits! >= acked && finalHits! <= acked + errs) {
						convergedLate++;
						anomalyLogs.push(`${id}: CONVERGED_LATE acked=${acked} seen=[${seen.join(',')}]`);
					} else if (finalHits! > acked + errs) {
						over++;
						anomalyLogs.push(
							`${id}: OVER-LATE final=${finalHits} acked=${acked} errs=${errs} seen=[${seen.join(',')}]`
						);
					} else if (expired) {
						inconclusive++;
						anomalyLogs.push(`${id}: EXPIRED-WHILE-SHORT acked=${acked} seen=[${seen.join(',')}]`);
					} else {
						stuckShort++;
						anomalyLogs.push(`${id}: STUCK_SHORT final=${finalHits} acked=${acked} seen=[${seen.join(',')}]`);
					}
				}
				// let the round's records expire so rounds stay independent
				await sleep(700);
			}

			console.log(
				`\n[QA-431-CONVERGENCE] ${ROUNDS}×${WINDOWS}×${HITS} (${WORKERS} workers)\n` +
					`  clean=${clean} converged-late=${convergedLate} stuck-short=${stuckShort} over=${over} inconclusive=${inconclusive}\n` +
					(anomalyLogs.length ? `  ${anomalyLogs.join('\n  ')}` : '  (no anomalies)')
			);

			ok(stuckShort === 0, `QA-431-CONVERGENCE: ${stuckShort} window(s) with durably lost increments`);
			ok(over === 0, `QA-431-CONVERGENCE: ${over} window(s) over-counted (double-apply)`);
			ok(
				clean + convergedLate + stuckShort + over >= (ROUNDS * WINDOWS) / 2,
				`QA-431-CONVERGENCE: only ${clean + convergedLate + stuckShort + over}/${ROUNDS * WINDOWS} windows measurable`
			);
		});
	}
);
