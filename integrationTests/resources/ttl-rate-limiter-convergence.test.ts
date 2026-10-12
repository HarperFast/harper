/**
 * QA-431 companion — same fixture as ttl-rate-limiter-concurrent.test.ts, with the two
 * ingredients that make version-reuse cache staleness reproducible: GET pressure DURING each
 * burst (cold reads re-seed the VerificationTable), and per-window convergence classification —
 * CONVERGED_LATE (a read raced still-landing merges) vs STUCK_SHORT (a durably lost increment).
 *
 * A short window also prints the audit evidence harper#3163 needs. Its live chain is requested from
 * inside the key's own burst worker, behind a GET that already reads short, and nothing in that
 * sequence is awaited before the round is measured: the record expires 500 ms after its last write
 * and the windows are measured one after another, so by a later window's turn its record is often
 * gone, while any wait ahead of a measurement can expire the keys still to be read. The round's
 * timestamp read runs after every window has been measured.
 *
 * EXPIRED_RECREATED: the record was evicted at its TTL and recreated by a late increment, proven from
 * the live chain alone — seed PUT succeeded, no `upsert`, first entry a `patch` stamped after the
 * round began, and as many patches as the record's final count (every post-recreate increment
 * added 1 to 0). An empty or failed chain proves nothing and leaves the window STUCK_SHORT.
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
		let operationsURL: string;
		let auth: string;

		before(async () => {
			await setupHarperWithFixture(ctx, FIXTURE_PATH, {
				config: { threads: { count: WORKERS } },
				env: {},
			});
			const client = createApiClient(ctx.harper);
			httpURL = ctx.harper.httpURL;
			operationsURL = ctx.harper.operationsAPIURL;
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

		type Settled = { ms: number; status: number | 'error' };
		const settledIncrements = new Map<string, Settled[]>();
		async function increment(id: string): Promise<number | 'error'> {
			const started = performance.now();
			let status: number | 'error';
			try {
				const r = await fetch(`${httpURL}/RateIncrement/`, {
					method: 'POST',
					headers: hdrs(),
					body: JSON.stringify({ id }),
					signal: AbortSignal.timeout(6_000),
				});
				status = r.status;
			} catch {
				status = 'error';
			}
			let settled = settledIncrements.get(id);
			if (!settled) settledIncrements.set(id, (settled = []));
			settled.push({ ms: Math.round(performance.now() - started), status });
			return status;
		}

		type AuditEntry = { operation: string; timestamp: number; ids?: string[] };
		async function readAuditLog(search: { search_type: string; search_values: unknown[] }): Promise<unknown> {
			const r = await fetch(operationsURL, {
				method: 'POST',
				headers: hdrs(),
				body: JSON.stringify({ operation: 'read_audit_log', database: 'data', table: 'RateCounter', ...search }),
				signal: AbortSignal.timeout(10_000),
			});
			const text = await r.text();
			if (!r.ok) throw new Error(`read_audit_log ${search.search_type} → ${r.status} ${text.slice(0, 300)}`);
			return JSON.parse(text);
		}
		const operations = (entries: AuditEntry[]) => entries.map((entry) => entry.operation).join(',');

		type Chain = { chain: AuditEntry[]; error?: string };
		async function readChain(id: string): Promise<Chain> {
			try {
				const result = (await readAuditLog({ search_type: 'hash_value', search_values: [id] })) as Record<
					string,
					AuditEntry[]
				>;
				return { chain: Array.isArray(result?.[id]) ? result[id] : [] };
			} catch (error) {
				return { chain: [], error: (error as Error).message };
			}
		}

		type ShortWindow = {
			id: string;
			acked: number;
			finalHits: number | null;
			label: string;
			detail: string;
			pendingChain: Promise<Chain>;
		};
		// The timestamp range is the only source for `default` writes (a keyed read of an expired key is
		// empty). harper#3164 ends it at the first entry whose record has expired; the stream then
		// carries a terminal `{ error }` element, so a truncated range is detected, not inferred.
		async function diagnoseShortWindows(
			shortWindows: ShortWindow[],
			roundStart: number,
			seeded: Set<string>
		): Promise<{ strayWrites: string; windows: Array<ShortWindow & { recreated: boolean }> }> {
			const chains = await Promise.all(shortWindows.map((window) => window.pendingChain));
			let range: Array<AuditEntry & { error?: unknown }> = [];
			let rangeError: string | undefined;
			try {
				const result = await readAuditLog({ search_type: 'timestamp', search_values: [roundStart, Date.now()] });
				if (Array.isArray(result)) range = result;
				else rangeError = `timestamp read returned ${typeof result}`;
			} catch (error) {
				rangeError = (error as Error).message;
			}
			const terminal = range.at(-1);
			if (terminal && !terminal.ids && terminal.error !== undefined) {
				rangeError = `range truncated: ${String(terminal.error)}`;
				range = range.slice(0, -1);
			}
			const forId = (id: string) => range.filter((entry) => entry.ids?.includes(id));
			const strayWrites = rangeError ? `>=${forId('default').length} (${rangeError})` : String(forId('default').length);
			const patchesIn = (chain: AuditEntry[]) => chain.filter((entry) => entry.operation === 'patch').length;
			const windows: Array<ShortWindow & { recreated: boolean }> = [];
			for (const [index, window] of shortWindows.entries()) {
				let { chain, error } = chains[index];
				// an increment applied after the capture (a client-side abort the server still applied)
				// is missing from it; the key may still be live for one more read, and an expired key's
				// empty answer must not replace the captured evidence
				if (chain.length > 0 && patchesIn(chain) !== window.finalHits) {
					const again = await readChain(window.id);
					if (again.chain.length > 0) ({ chain, error } = again);
				}
				const errors = [error].filter(Boolean);
				const rangeForKey = forId(window.id);
				const rangePatches = rangeForKey.filter((entry) => entry.operation === 'patch').length;
				const recreated =
					seeded.has(window.id) &&
					chain.length > 0 &&
					chain[0].operation === 'patch' &&
					chain[0].timestamp >= roundStart &&
					!chain.some((entry) => entry.operation === 'upsert') &&
					patchesIn(chain) === window.finalHits;
				const slowest = (settledIncrements.get(window.id) ?? [])
					.slice()
					.sort((a, b) => b.ms - a.ms)
					.slice(0, 5)
					.map((settled) => `${settled.ms}ms:${settled.status}`);
				const detail =
					`${window.detail} chain=[${operations(chain)}] ` +
					`round-range=[${operations(rangeForKey)}] patches=${rangePatches}/${window.acked}${rangeError ? ' (range truncated, see harper#3164)' : ''} ` +
					`slowest=[${slowest.join(' ')}]` +
					(errors.length ? ` chain-error=${JSON.stringify(errors)}` : '');
				windows.push({ ...window, recreated, detail });
			}
			return { strayWrites, windows };
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
			let expiredRecreated = 0;
			let over = 0;
			let inconclusive = 0;
			const anomalyLogs: string[] = [];

			for (let round = 0; round < ROUNDS; round++) {
				const ids = Array.from({ length: WINDOWS }, (_, w) => `r${round}w${w}`);
				const roundStart = Date.now();
				settledIncrements.clear();
				const seedStatuses = await Promise.all(ids.map((id) => put(id, 0)));
				const seeded = new Set(ids.filter((_, index) => seedStatuses[index] === 204));
				const shortWindows: ShortWindow[] = [];

				const perWindow = await Promise.all(
					ids.map(async (id) => {
						let bursting = true;
						const reader = (async () => {
							while (bursting) await getHits(id);
						})();
						const results = await Promise.all(Array.from({ length: HITS }, () => increment(id)));
						bursting = false;
						await reader;
						const acked = results.filter((s) => s === 200).length;
						return {
							id,
							acked,
							errs: results.filter((s) => s === 'error').length,
							pendingChain: getHits(id).then((early) =>
								early.status === 200 && early.hits! < acked ? readChain(id) : { chain: [] }
							),
						};
					})
				);

				for (const { id, acked, errs, pendingChain } of perWindow) {
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
						shortWindows.push({
							id,
							acked,
							finalHits,
							label: 'EXPIRED-WHILE-SHORT',
							detail: `acked=${acked} seen=[${seen.join(',')}]`,
							pendingChain,
						});
					} else {
						shortWindows.push({
							id,
							acked,
							finalHits,
							label: 'STUCK_SHORT',
							detail: `final=${finalHits} acked=${acked} seen=[${seen.join(',')}]`,
							pendingChain,
						});
					}
				}
				if (shortWindows.length) {
					const { strayWrites, windows } = await diagnoseShortWindows(shortWindows, roundStart, seeded);
					anomalyLogs.push(`round ${round}: default-writes=${strayWrites}`);
					for (const window of windows) {
						let label = window.label;
						if (window.recreated) {
							expiredRecreated++;
							label = 'EXPIRED_RECREATED';
						} else if (label === 'STUCK_SHORT') stuckShort++;
						else inconclusive++;
						anomalyLogs.push(`${window.id}: ${label} ${window.detail}`);
					}
				}
				// let the round's records expire so rounds stay independent
				await sleep(700);
			}

			console.log(
				`\n[QA-431-CONVERGENCE] ${ROUNDS}×${WINDOWS}×${HITS} (${WORKERS} workers)\n` +
					`  clean=${clean} converged-late=${convergedLate} stuck-short=${stuckShort} expired-recreated=${expiredRecreated} over=${over} inconclusive=${inconclusive}\n` +
					(anomalyLogs.length
						? `  ${anomalyLogs.join('\n  ')}\n  server log: ${ctx.harper.logDir ?? '(not kept: HARPER_INTEGRATION_TEST_LOG_DIR unset)'}`
						: '  (no anomalies)')
			);

			ok(stuckShort === 0, `QA-431-CONVERGENCE: ${stuckShort} window(s) with durably lost increments`);
			ok(over === 0, `QA-431-CONVERGENCE: ${over} window(s) over-counted (double-apply)`);
			const measurable = clean + convergedLate + stuckShort + expiredRecreated + over;
			ok(
				measurable >= (ROUNDS * WINDOWS) / 2,
				`QA-431-CONVERGENCE: only ${measurable}/${ROUNDS * WINDOWS} windows measurable`
			);
		});
	}
);
