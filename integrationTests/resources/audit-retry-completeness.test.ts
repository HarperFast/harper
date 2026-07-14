/** Pins harper#1773 isRetry-leak fix: every committed write has exactly ONE audit-log entry under multi-worker conflict-retry contention. */
/**
 * QA-552 — audit-log completeness under conflict-retry contention (the #1773 / `isRetry`-leak
 * family).
 *
 * Background (read from source + the fix commits, not re-derived here):
 *
 *   - `resources/DatabaseTransaction.ts` writes audit-log entries EAGERLY at write-staging time
 *     (`save()`), not as part of the atomic RocksDB commit — so an aborted/retried conflict
 *     doesn't roll its already-staged audit entry back. To avoid double-appending on a retried
 *     restage, the native `RocksTransaction` gets an `isRetry` flag stamped at every retry site
 *     (coordinated RETRY_NOW, ERR_BUSY, ERR_TRY_AGAIN); `save()` skips `appendedAuditEntry` when
 *     `transaction.isRetry` is set.
 *   - harper#1773 (fixed by 643d10c68 + 1fd59484a, regression-anchored at the unit level by
 *     7d10daf7d `unitTests/resources/retryCounterAuditLeak.test.js`): `isRetry` used to be
 *     DERIVED from the lifetime `this.retries > 0` counter on the JS `DatabaseTransaction`
 *     object. Because that counter wasn't reset after a successful commit, a `DatabaseTransaction`
 *     instance that is REUSED for a later, completely fresh batch of writes (see
 *     `resources/Table.ts` `txnForContext` — an `ImmediateTransaction` already assigned to
 *     `context.transaction` is reused for any later write against the same store/db within that
 *     context) would incorrectly stamp `isRetry=true` on the fresh batch's brand-new native
 *     transaction, silently dropping ITS audit entry even though the record write itself
 *     succeeded. The fix (a) derives `isRetry` only from the SPECIFIC native transaction being
 *     retried (not the JS-object-lifetime counter), and (b) resets `this.retries = 0` after a
 *     successful commit so a reused instance starts clean for its next batch.
 *
 * This is the END-TO-END probe the unit test (mocked) can't reach: drive genuine HTTP writes
 * through the real Table/audit-store path, force REAL RocksDB write-write conflicts (many
 * concurrent PUTs hammering a tiny 8-key hot keyspace under `threads.count: 4`), and interleave
 * brand-new fresh-key writes immediately after each contended write **on the same pinned
 * connection** (so if any per-connection/context transaction-object reuse is in play, the fresh
 * write lands right behind the contended one — the exact shape #1773 required). Then reconcile:
 * every write the CLIENT observed as committed (2xx) must have EXACTLY ONE `read_audit_log`
 * entry — no drops (the #1773 shape), no duplicates (double-append).
 *
 * Retry evidence: Harper's integration-test harness always runs with `--LOGGING_LEVEL=debug`
 * (`@harperfast/integration-testing` `startHarper()`), and `npm run test:integration` (dist/run.js)
 * auto-sets `HARPER_INTEGRATION_TEST_LOG_DIR` so `ctx.harper.logDir` holds `hdb.log`. After the
 * storm we grep that log for the exact debug lines `DatabaseTransaction.ts` emits at its retry
 * sites (`'retrying'`, `'coordinated retry'`) plus the underlying RocksDB conflict codes
 * (`ERR_BUSY`, `ERR_TRY_AGAIN`) to CONFIRM real conflict-retries fired — otherwise this test
 * would prove nothing.
 *
 * Harper SHA: 8bf5921e0 (main; the isRetry fixes 643d10c68 + 1fd59484a are present; dist is
 * current, not rebuilt for this experiment).
 *
 * Reproduction:
 *   npm run test:integration -- "integrationTests/resources/audit-retry-completeness.test.ts"
 */
import { suite, test, before, after } from 'node:test';
import { ok, equal } from 'node:assert';
import { resolve, join } from 'node:path';
import { existsSync, readFileSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';
import http from 'node:http';

import request from 'supertest';
import { setupHarperWithFixture, teardownHarper, type ContextWithHarper } from '@harperfast/integration-testing';
// @ts-expect-error utils/client.mjs has no type declarations; runtime resolves fine
import { createApiClient } from '../apiTests/utils/client.mjs';

const FIXTURE_PATH = resolve(import.meta.dirname, 'audit-retry-completeness');
const SCHEMA = 'data';
const TABLE = 'Hot';
const skipSuite = process.platform === 'win32';

const NUM_HOT_KEYS = 8;
const HOT_KEYS = Array.from({ length: NUM_HOT_KEYS }, (_, i) => `hot-${i}`);
const ROUNDS = 25;
const CONCURRENCY = 32; // pinned contended->fresh pairs per round: 32*25 = 800 pairs, 1600 requests total

type WriteResult = { status: number | 'error'; id: string; kind: 'hot' | 'fresh' };
type HistoryEntry = { operation: string; timestamp: number; user_name?: string; ids: string[]; records: any[] };

suite(
	'QA-552 audit-log completeness under conflict-retry contention (#1773 family)',
	{ skip: skipSuite },
	(ctx: ContextWithHarper) => {
		let client: ReturnType<typeof createApiClient>;
		let baseURL: URL;
		let authHeader: string;

		const hotCommittedCount = new Map<string, number>(HOT_KEYS.map((k) => [k, 0]));
		const freshCommittedIds = new Set<string>();
		let totalHotIssued = 0;
		let totalFreshIssued = 0;
		let totalHotErrors = 0;
		let totalFreshErrors = 0;
		let seq = 0;

		before(async () => {
			await setupHarperWithFixture(ctx, FIXTURE_PATH, {
				config: { threads: { count: 4 }, logging: { auditLog: true } },
				env: {},
			});
			client = createApiClient(ctx.harper);
			baseURL = new URL(client.restURL);
			authHeader = client.headers.Authorization as string;

			const deadline = Date.now() + 30_000;
			while (Date.now() < deadline) {
				try {
					const probe = await request(ctx.harper.httpURL).get(`/${TABLE}/`).set(client.headers).timeout(3_000);
					if (probe.status !== 404) break;
				} catch {
					/* not ready */
				}
				await sleep(250);
			}
		});

		after(async () => {
			console.log('\n===== QA-552 workload summary =====');
			console.log(
				`hot issued=${totalHotIssued} committed=${[...hotCommittedCount.values()].reduce((a, b) => a + b, 0)} errors=${totalHotErrors}`
			);
			console.log(`fresh issued=${totalFreshIssued} committed=${freshCommittedIds.size} errors=${totalFreshErrors}`);
			console.log('====================================\n');
			await teardownHarper(ctx);
		});

		/** PUT a JSON body on a given http.Agent (so two calls on the same agent share one socket). */
		function putOn(agent: http.Agent, id: string, body: unknown): Promise<number | 'error'> {
			return new Promise((resolvePromise) => {
				const payload = Buffer.from(JSON.stringify(body));
				const req = http.request(
					{
						hostname: baseURL.hostname,
						port: baseURL.port,
						path: `/${TABLE}/${id}`,
						method: 'PUT',
						agent,
						headers: {
							'Authorization': authHeader,
							'Content-Type': 'application/json',
							'Content-Length': payload.length,
						},
					},
					(res) => {
						res.resume();
						res.on('end', () => resolvePromise(res.statusCode as number));
						res.on('error', () => resolvePromise('error'));
					}
				);
				req.on('error', () => resolvePromise('error'));
				req.end(payload);
			});
		}

		/**
		 * One pinned pair on a single kept-alive connection (so if any per-connection/context
		 * transaction-object reuse is in play, the fresh write is issued right behind the contended
		 * one on the SAME socket/worker): PUT the contended hot key, THEN — on the same connection —
		 * PUT a brand-new fresh key. Both awaited sequentially; many pairs run concurrently across a
		 * round to drive genuine cross-thread contention on the small hot keyspace.
		 */
		async function contendedThenFreshPair(
			hotId: string,
			freshId: string,
			v: number
		): Promise<[WriteResult, WriteResult]> {
			const agent = new http.Agent({ keepAlive: true, maxSockets: 1, maxFreeSockets: 1 });
			try {
				const hotStatus = await putOn(agent, hotId, { id: hotId, v, writer: 'contended' });
				const freshStatus = await putOn(agent, freshId, { id: freshId, v, writer: 'fresh' });
				return [
					{ status: hotStatus, id: hotId, kind: 'hot' },
					{ status: freshStatus, id: freshId, kind: 'fresh' },
				];
			} finally {
				agent.destroy();
			}
		}

		async function readAuditFor(...ids: string[]): Promise<Record<string, HistoryEntry[]>> {
			const r = await request(ctx.harper.operationsAPIURL)
				.post('')
				.set(client.headers)
				.send({
					operation: 'read_audit_log',
					schema: SCHEMA,
					table: TABLE,
					search_type: 'hash_value',
					search_values: ids,
				})
				.timeout(30_000);
			ok(r.status === 200, `read_audit_log (hash_value) expected 200, got ${r.status}: ${JSON.stringify(r.body)}`);
			return r.body;
		}

		async function readFullAuditStream(): Promise<HistoryEntry[]> {
			const r = await request(ctx.harper.operationsAPIURL)
				.post('')
				.set(client.headers)
				.send({ operation: 'read_audit_log', schema: SCHEMA, table: TABLE })
				.timeout(30_000);
			ok(r.status === 200, `read_audit_log (full scan) expected 200, got ${r.status}: ${JSON.stringify(r.body)}`);
			return Array.isArray(r.body) ? r.body : [];
		}

		function readLogText(): string {
			let text = '';
			const logDir = (ctx.harper as any).logDir as string | undefined;
			if (logDir) {
				for (const name of ['hdb.log', 'stdout.log', 'stderr.log']) {
					const p = join(logDir, name);
					if (existsSync(p)) {
						try {
							text += readFileSync(p, 'utf8');
						} catch {
							/* ignore */
						}
					}
				}
			}
			return text;
		}

		test('drive concurrent contended-hot-key PUT storm interleaved with pinned fresh-key writes', async () => {
			for (let round = 0; round < ROUNDS; round++) {
				const promises = Array.from({ length: CONCURRENCY }, () => {
					const hotId = HOT_KEYS[Math.floor(Math.random() * HOT_KEYS.length)];
					const freshId = `fresh-${seq++}`;
					const v = seq;
					totalHotIssued++;
					totalFreshIssued++;
					return contendedThenFreshPair(hotId, freshId, v);
				});

				const results = await Promise.all(promises);
				for (const [hotResult, freshResult] of results) {
					if (hotResult.status === 'error') {
						totalHotErrors++;
					} else if (hotResult.status >= 200 && hotResult.status < 300) {
						hotCommittedCount.set(hotResult.id, (hotCommittedCount.get(hotResult.id) ?? 0) + 1);
					} else {
						// e.g. 422/503 from exhausting MAX_RETRIES under extreme contention: not committed,
						// correctly expected to have NO audit entry. Counted separately from transport errors.
						totalHotErrors++;
					}
					if (freshResult.status === 'error') {
						totalFreshErrors++;
					} else if (freshResult.status >= 200 && freshResult.status < 300) {
						freshCommittedIds.add(freshResult.id);
					} else {
						totalFreshErrors++;
					}
				}
			}

			const totalHotCommitted = [...hotCommittedCount.values()].reduce((a, b) => a + b, 0);
			console.log(
				`[QA-552] hot: issued=${totalHotIssued} committed=${totalHotCommitted} non2xx=${totalHotErrors}; fresh: issued=${totalFreshIssued} committed=${freshCommittedIds.size} non2xx=${totalFreshErrors}`
			);
			ok(totalHotCommitted > 0, 'expected at least some hot-key writes to commit');
			ok(freshCommittedIds.size > 0, 'expected at least some fresh-key writes to commit');

			// Let any async housekeeping settle before reading back.
			await sleep(750);
		});

		test('genuine RocksDB conflict-retries fired (otherwise this test proves nothing)', async () => {
			const logText = readLogText();
			const retryHits = (logText.match(/retrying|coordinated retry/gi) ?? []).length;
			const conflictCodeHits = (logText.match(/ERR_BUSY|ERR_TRY_AGAIN|RETRY_NOW/gi) ?? []).length;
			console.log(
				`[QA-552] retry-evidence: debug-retry-lines=${retryHits} conflict-code-hits=${conflictCodeHits} logTextLen=${logText.length}`
			);
			ok(
				logText.length > 0,
				'expected to find a non-empty Harper log (hdb.log/stdout.log/stderr.log) under ctx.harper.logDir'
			);
			ok(
				retryHits > 0 || conflictCodeHits > 0,
				`expected evidence of real RocksDB write conflicts/retries in the Harper log (8 hot keys x ${ROUNDS * CONCURRENCY} concurrent writers should force some); found none — test result would be inconclusive`
			);
		});

		test('every committed write has EXACTLY ONE audit-log entry: no drops, no duplicates', async () => {
			const freshIds = [...freshCommittedIds];
			const allKnownIds = [...HOT_KEYS, ...freshIds];
			const histories = await readAuditFor(...allKnownIds);

			let totalExpected = 0;
			let totalFound = 0;
			const missing: string[] = [];
			const extra: string[] = [];

			for (const hotId of HOT_KEYS) {
				const expected = hotCommittedCount.get(hotId) ?? 0;
				const entries = histories[hotId] ?? [];
				totalExpected += expected;
				totalFound += entries.length;
				if (entries.length < expected)
					missing.push(
						`${hotId}: expected ${expected}, found ${entries.length} (missing ${expected - entries.length})`
					);
				if (entries.length > expected)
					extra.push(`${hotId}: expected ${expected}, found ${entries.length} (extra ${entries.length - expected})`);
			}
			for (const freshId of freshIds) {
				const entries = histories[freshId] ?? [];
				totalExpected += 1;
				totalFound += entries.length;
				if (entries.length < 1) missing.push(`${freshId}: expected 1, found ${entries.length}`);
				if (entries.length > 1) extra.push(`${freshId}: expected 1, found ${entries.length} (duplicate)`);
			}

			console.log(`[QA-552] reconciliation: expected(committed)=${totalExpected} found(audit)=${totalFound}`);
			if (missing.length)
				console.log(`[QA-552] MISSING audit entries (up to 25 shown):\n${missing.slice(0, 25).join('\n')}`);
			if (extra.length)
				console.log(`[QA-552] EXTRA/duplicate audit entries (up to 25 shown):\n${extra.slice(0, 25).join('\n')}`);

			ok(
				missing.length === 0,
				`found ${missing.length} id(s) with a MISSING audit entry (real #1773-shape drop) — see log above`
			);
			ok(extra.length === 0, `found ${extra.length} id(s) with EXTRA/duplicate audit entries — see log above`);
			equal(
				totalFound,
				totalExpected,
				`total audit entries (${totalFound}) must equal total committed writes (${totalExpected})`
			);

			// Cross-check: every entry declares operation 'upsert' (Table PUT path) and carries a
			// non-null record image (rules out a phantom no-value entry masquerading as our write).
			let badEntries = 0;
			for (const id of allKnownIds) {
				for (const entry of histories[id] ?? []) {
					if (entry.operation !== 'upsert') {
						badEntries++;
						console.log(`[QA-552] unexpected operation '${entry.operation}' for id=${id}`);
					}
					if (entry.records?.[0] == null) {
						badEntries++;
						console.log(`[QA-552] null record image for id=${id}`);
					}
				}
			}
			equal(badEntries, 0, 'expected every audit entry to be operation=upsert with a non-null record image');
		});

		test('full-table audit scan corroborates: no phantom ids, count matches committed writes', async () => {
			const fullHistory = await readFullAuditStream();
			const knownIds = new Set([...HOT_KEYS, ...freshCommittedIds]);
			let totalEntries = 0;
			const phantomIds = new Set<string>();
			for (const entry of fullHistory) {
				for (const id of entry.ids ?? []) {
					totalEntries++;
					if (!knownIds.has(id)) phantomIds.add(id);
				}
			}
			const totalCommitted = [...hotCommittedCount.values()].reduce((a, b) => a + b, 0) + freshCommittedIds.size;
			console.log(
				`[QA-552] full-table scan: totalEntries=${totalEntries} totalCommitted=${totalCommitted} phantomIds=${phantomIds.size}`
			);
			equal(
				phantomIds.size,
				0,
				`found ${phantomIds.size} audit entries for ids we never wrote: ${[...phantomIds].slice(0, 10).join(', ')}`
			);
			equal(
				totalEntries,
				totalCommitted,
				`full-table audit scan entry count (${totalEntries}) must equal total committed writes (${totalCommitted})`
			);
		});
	}
);
