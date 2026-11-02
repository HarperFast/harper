/**
 * QA-431 companion — same fixture as ttl-rate-limiter-concurrent.test.ts, with the two
 * ingredients that make version-reuse cache staleness reproducible: GET pressure DURING each
 * burst (cold reads re-seed the VerificationTable), and per-window convergence classification —
 * CONVERGED_LATE (a read raced still-landing merges) vs STUCK_SHORT (unconverged acknowledged increments).
 *
 * Set HARPER_TTL_SNAPSHOT_DIAGNOSTICS=1 to capture a request-transaction snapshot and cached
 * view alongside the audit chain for initial short reads. This opt-in run is diagnostic and is
 * not equivalent to the default workload: the extra cached read can refresh the snapshot worker's
 * cache. That worker may differ from the worker serving the short GET. The transaction snapshot
 * is pinned, not a latest-commit view; different versions can be legitimate. Served ETags and the
 * encoded raw version are evidence only: even equal versions do not alone prove a cache violation.
 * Neither view proves durability.
 *
 * The chain is requested inside the key's own burst worker, behind a GET that already reads short.
 * Nothing in that sequence is awaited before round measurements: records expire 500 ms after their
 * last write, so a wait ahead of a measurement can expire keys still to be read. The round's
 * timestamp read and diagnostic logging run after every window has been measured.
 *
 * EXPIRED_RECREATED: the record was evicted at its TTL and recreated by a late increment, proven from
 * the live chain alone — seed PUT succeeded, no `upsert`, first entry a `patch` stamped after the
 * round began, and as many patches as the record's final count (every post-recreate increment
 * added 1 to 0). An empty or failed chain proves nothing and leaves the window STUCK_SHORT.
 */

import { suite, test, before, after } from 'node:test';
import { ok, strictEqual } from 'node:assert';
import { resolve } from 'node:path';
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { setTimeout as sleep } from 'node:timers/promises';
import { setupHarperWithFixture, teardownHarper, type ContextWithHarper } from '@harperfast/integration-testing';
// @ts-expect-error utils/client.mjs has no type declarations
import { createApiClient } from '../apiTests/utils/client.mjs';

const FIXTURE_PATH = resolve(import.meta.dirname, 'ttl-rate-limiter-concurrent');
const WORKERS = 4;
const ROUNDS = 10;
const WINDOWS = 10;
const HITS = 50;
const SNAPSHOT_DIAGNOSTICS = process.env.HARPER_TTL_SNAPSHOT_DIAGNOSTICS === '1';
// Stored metadata flag; keep diagnostics independent of runtime module initialization.
const VERSION_REUSED = 0x10000;
const etagBytes = new Uint8Array(8);
const etagFloat = new Float64Array(etagBytes.buffer);

// Checked against the real GET ETag by the snapshot fixture control below.
function versionToEtag(version: number): string {
	etagFloat[0] = version;
	return String.fromCharCode(
		34,
		(etagBytes[0] & 0x3f) + 62,
		(etagBytes[0] >> 6) + ((etagBytes[1] << 2) & 0x3f) + 62,
		(etagBytes[1] >> 4) + ((etagBytes[2] << 4) & 0x3f) + 62,
		(etagBytes[2] >> 2) + 62,
		(etagBytes[3] & 0x3f) + 62,
		(etagBytes[3] >> 6) + ((etagBytes[4] << 2) & 0x3f) + 62,
		(etagBytes[4] >> 4) + ((etagBytes[5] << 4) & 0x3f) + 62,
		(etagBytes[5] >> 2) + 62,
		(etagBytes[6] & 0x3f) + 62,
		(etagBytes[6] >> 6) + ((etagBytes[7] << 2) & 0x3f) + 62,
		34
	);
}

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

		type SnapshotEntry = {
			hits: number | null;
			version: number | null;
			localTime: number | null;
			expiresAt: number | null;
			metadataFlags: number | null;
			nodeId: number | null;
			additionalAuditRefs: Array<{ version: number; nodeId?: number }>;
			receivedIdentityRefs: Array<{ version: number; nodeId?: number }>;
		};
		type Snapshot = {
			id: string;
			engine: string;
			uncachedReadBypassesCache: boolean;
			threadId: number;
			nowBefore: number;
			nowAfter: number;
			transactionSnapshot: SnapshotEntry | null;
			cached: SnapshotEntry | null;
		};
		type SnapshotCapture = { status?: number; value?: Snapshot; error?: string };
		type Chain = {
			chain: AuditEntry[];
			error?: string;
			snapshot?: SnapshotCapture;
			earlyHits?: number | null;
			earlyEtag?: string | null;
		};

		async function readSnapshot(id: string): Promise<SnapshotCapture> {
			try {
				const response = await fetch(`${httpURL}/RateSnapshot/${encodeURIComponent(id)}`, {
					headers: { Authorization: auth },
					signal: AbortSignal.timeout(5_000),
				});
				if (response.status !== 200) return { status: response.status, error: await response.text() };
				return { status: response.status, value: (await response.json()) as Snapshot };
			} catch (error) {
				return { error: (error as Error).message };
			}
		}

		function snapshotDetail(capture?: SnapshotCapture) {
			const value = capture?.value;
			if (!value) return capture ?? { error: 'initial short-read snapshot not captured' };
			const validity = (entry: SnapshotEntry | null) =>
				!entry
					? 'missing'
					: entry.expiresAt === null
						? 'unknown-expiry'
						: entry.expiresAt <= value.nowBefore
							? 'expired-before-capture'
							: entry.expiresAt <= value.nowAfter
								? 'expired-during-capture'
								: 'live-at-capture';
			return {
				...capture,
				workerRelation: 'separate snapshot request; triggering GET worker unknown',
				ttlValidity: {
					transactionSnapshot: validity(value.transactionSnapshot),
					cached: validity(value.cached),
				},
			};
		}
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
			const truncated = Boolean(terminal && !terminal.ids && terminal.error !== undefined);
			if (truncated) {
				rangeError = `range truncated: ${String(terminal!.error)}`;
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
				const errors = [error].filter(Boolean);
				if (chain.length > 0 && patchesIn(chain) !== window.finalHits) {
					const again = await readChain(window.id);
					if (again.chain.length > 0) chain = again.chain;
					else errors.push(again.error ?? 're-read found no live record');
				}
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
					`round-range=[${operations(rangeForKey)}] patches=${rangePatches}/${window.acked}${truncated ? ' (range truncated, see harper#3164)' : rangeError ? ' (range unavailable)' : ''} ` +
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

		async function getHits(
			id: string
		): Promise<{ status: number | 'error'; hits: number | null; etag?: string | null }> {
			try {
				const r = await fetch(`${httpURL}/RateCounter/${id}`, {
					headers: { Authorization: auth },
					signal: AbortSignal.timeout(5_000),
				});
				if (r.status !== 200) return { status: r.status, hits: null };
				const body = await r.json();
				return {
					status: 200,
					hits: Number(body?.hits ?? -1),
					...(SNAPSHOT_DIAGNOSTICS ? { etag: r.headers.get('etag') } : {}),
				};
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
			let initialShortSnapshotAttempts = 0;
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
								early.status === 200 && early.hits! < acked
									? SNAPSHOT_DIAGNOSTICS
										? Promise.all([readChain(id), readSnapshot(id)]).then(([chain, snapshot]) => ({
												...chain,
												snapshot,
												earlyHits: early.hits,
												earlyEtag: early.etag,
											}))
										: readChain(id)
									: { chain: [] }
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
				// let the round's records expire so rounds stay independent, with no chain read still in flight
				const initialChains = await Promise.all(perWindow.map((window) => window.pendingChain));
				for (const [index, chain] of initialChains.entries()) {
					if ('snapshot' in chain) {
						initialShortSnapshotAttempts++;
						const raw = chain.snapshot?.value?.transactionSnapshot;
						const capture = chain.snapshot?.value;
						const window = perWindow[index];
						const evidence = {
							servedEtag: chain.earlyEtag,
							rawEtag: raw?.version == null ? null : versionToEtag(raw.version),
							sameVersion: raw?.version != null && chain.earlyEtag === versionToEtag(raw.version),
							rawAtLeastAcked: raw?.hits != null && raw.hits >= window.acked,
							rawWithinAcknowledgedAndErrors:
								raw?.hits != null && raw.hits >= window.acked && raw.hits <= window.acked + window.errs,
							rawLiveThroughoutCapture: raw?.expiresAt != null && capture != null && raw.expiresAt > capture.nowAfter,
							rawVersionReused: raw?.metadataFlags != null && Boolean(raw.metadataFlags & VERSION_REUSED),
						};
						anomalyLogs.push(
							`${perWindow[index].id}: INITIAL_SHORT_SNAPSHOT acked=${perWindow[index].acked} early=${chain.earlyHits} errs=${window.errs} worker-relation=unknown evidence=${JSON.stringify(evidence)} snapshot=${JSON.stringify(snapshotDetail(chain.snapshot))}`
						);
					}
				}
				await sleep(700);
			}

			console.log(
				`\n[QA-431-CONVERGENCE] ${ROUNDS}×${WINDOWS}×${HITS} (${WORKERS} workers)\n` +
					`  clean=${clean} converged-late=${convergedLate} stuck-short=${stuckShort} expired-recreated=${expiredRecreated} over=${over} inconclusive=${inconclusive} snapshot-diagnostics=${SNAPSHOT_DIAGNOSTICS} initial-short-snapshot-attempts=${initialShortSnapshotAttempts}\n` +
					(anomalyLogs.length
						? `  ${anomalyLogs.join('\n  ')}\n  server log: ${ctx.harper.logDir ?? '(not kept: HARPER_INTEGRATION_TEST_LOG_DIR unset)'}`
						: '  (no anomalies)')
			);

			ok(stuckShort === 0, `QA-431-CONVERGENCE: ${stuckShort} window(s) with unconverged acknowledged increments`);
			ok(over === 0, `QA-431-CONVERGENCE: ${over} window(s) over-counted (double-apply)`);
			const measurable = clean + convergedLate + stuckShort + expiredRecreated + over;
			ok(
				measurable >= (ROUNDS * WINDOWS) / 2,
				`QA-431-CONVERGENCE: only ${measurable}/${ROUNDS * WINDOWS} windows measurable`
			);
		});
	}
);

suite('QA-431 authenticated snapshot control', { skip: skipSuite }, (ctx: ContextWithHarper) => {
	let httpURL: string;
	let auth: string;
	let controlFixture: string;
	before(async () => {
		controlFixture = await mkdtemp(resolve(tmpdir(), 'harper-ttl-snapshot-control-'));
		await cp(FIXTURE_PATH, controlFixture, { recursive: true });
		const schemaPath = resolve(controlFixture, 'schema.graphql');
		const schema = await readFile(schemaPath, 'utf8');
		ok(schema.includes('@table(expiration: 0.5)'));
		await writeFile(schemaPath, schema.replace('@table(expiration: 0.5)', '@table(expiration: 3600)'));
		await setupHarperWithFixture(ctx, controlFixture, {
			config: { threads: { count: 1 } },
			env: { AUTHENTICATION_AUTHORIZELOCAL: 'false' },
		});
		httpURL = ctx.harper.httpURL;
		auth = createApiClient(ctx.harper).headers.Authorization;
	});
	after(async () => {
		try {
			await teardownHarper(ctx);
		} finally {
			if (controlFixture) await rm(controlFixture, { recursive: true, force: true });
		}
	});
	test('requires authentication and copies stored/cache metadata within one worker', async () => {
		const id = 'snapshot-control';
		const anonymous = await fetch(`${httpURL}/RateSnapshot/${id}`, { signal: AbortSignal.timeout(5_000) });
		await anonymous.text();
		ok([401, 403].includes(anonymous.status));
		const seeded = await fetch(`${httpURL}/RateCounter/${id}`, {
			method: 'PUT',
			headers: { 'Authorization': auth, 'Content-Type': 'application/json' },
			body: JSON.stringify({ id, hits: 17 }),
			signal: AbortSignal.timeout(5_000),
		});
		await seeded.text();
		strictEqual(seeded.status, 204);
		let worker: number | undefined;
		let previousVersion: number | undefined;
		let previousExpiry: number | undefined;
		for (let attempt = 0; attempt < 2; attempt++) {
			const response = await fetch(`${httpURL}/RateSnapshot/${id}`, {
				headers: { Authorization: auth },
				signal: AbortSignal.timeout(5_000),
			});
			strictEqual(response.status, 200);
			const snapshot = await response.json();
			strictEqual(snapshot.id, id);
			strictEqual(snapshot.engine, process.env.HARPER_STORAGE_ENGINE === 'lmdb' ? 'other' : 'rocksdb');
			ok(Number.isInteger(snapshot.threadId) && snapshot.threadId > 0);
			if (worker !== undefined) strictEqual(snapshot.threadId, worker);
			worker = snapshot.threadId;
			ok(snapshot.nowBefore <= snapshot.nowAfter);
			for (const entry of [snapshot.transactionSnapshot, snapshot.cached]) {
				strictEqual(entry.hits, 17);
				ok(typeof entry.version === 'number' && entry.version > 0);
				ok(typeof entry.localTime === 'number');
				ok(typeof entry.metadataFlags === 'number');
				ok(entry.expiresAt > snapshot.nowAfter);
				ok(Array.isArray(entry.additionalAuditRefs));
				ok(Array.isArray(entry.receivedIdentityRefs));
			}
			if (previousVersion !== undefined) {
				strictEqual(snapshot.transactionSnapshot.version, previousVersion);
				strictEqual(snapshot.transactionSnapshot.expiresAt, previousExpiry);
			}
			previousVersion = snapshot.transactionSnapshot.version;
			previousExpiry = snapshot.transactionSnapshot.expiresAt;
			strictEqual(snapshot.cached.version, snapshot.transactionSnapshot.version);
			strictEqual(snapshot.cached.expiresAt, snapshot.transactionSnapshot.expiresAt);
		}
		const unchanged = await fetch(`${httpURL}/RateCounter/${id}`, {
			headers: { Authorization: auth },
			signal: AbortSignal.timeout(5_000),
		});
		strictEqual(unchanged.status, 200);
		strictEqual(unchanged.headers.get('etag'), versionToEtag(previousVersion!));
		strictEqual((await unchanged.json()).hits, 17);
		const updated = await fetch(`${httpURL}/RateCounter/${id}`, {
			method: 'PUT',
			headers: { 'Authorization': auth, 'Content-Type': 'application/json' },
			body: JSON.stringify({ id, hits: 18 }),
			signal: AbortSignal.timeout(5_000),
		});
		await updated.text();
		strictEqual(updated.status, 204);
		const advanced = await fetch(`${httpURL}/RateSnapshot/${id}`, {
			headers: { Authorization: auth },
			signal: AbortSignal.timeout(5_000),
		});
		strictEqual(advanced.status, 200);
		const snapshot = await advanced.json();
		for (const entry of [snapshot.transactionSnapshot, snapshot.cached]) {
			strictEqual(entry.hits, 18);
			ok(entry.version > previousVersion!);
		}
	});
});
