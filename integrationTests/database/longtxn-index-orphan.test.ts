/**
 * QA-601 — over-time transaction x secondary-index (I x K), MULTI-STORE `next`-chain corner.
 *
 * Anchored on #1407/#1411 (Abort over-time write transactions instead of force-committing,
 * merged as commit 21ed179c2 / PR #1411). That fix is confirmed present on the checkout under
 * test: `git merge-base --is-ancestor 3249fb58e 3dbcf7b9e` succeeds. It replaced the old
 * force-commit-with-partial-writes path with abort+poison: a write-bearing transaction that
 * exceeds `storage.maxTransactionOpenTime` is aborted, and `timedOut` is set so any further
 * write/commit throws `transactionOpenTooLongError` instead of silently landing a partial
 * write set (see resources/DatabaseTransaction.ts `transactionOpenTooLongError` doc comment).
 *
 * Existing qa-scratch coverage (qa176/qa309/qa314/qa317/qa318/qa455/qa-overtime-txn) already
 * exercises SINGLE-store held transactions extensively, mostly against pre-#1411 commits. The
 * first-party regression anchor `integrationTests/resources/txn-overtime-atomicity.test.ts`
 * covers the same-table pre-await/post-await case. None of them combine the over-time axis with
 * a MULTI-STORE (cross-table) transaction — confirmed via `grep -rl maxTransactionOpenTime`
 * (single-store only) vs `grep -rln txnForContext` (only qa552/qa596, neither touching
 * maxTransactionOpenTime). That gap is this test's target: `abortDueToTimeout()`
 * (resources/DatabaseTransaction.ts) walks and poisons the whole `next` chain — but its own doc
 * comment only claims to poison links that EXIST at the moment the monitor fires:
 *
 *   abortDueToTimeout(): for (let txn = this; txn; txn = txn.next) { txn.timedOut = true; ... }
 *
 * HYPOTHESIS (disproven — see below): a request writes table A (creating+tracking the head
 * DatabaseTransaction), sleeps past the threshold (monitor fires, poisons the head — chain is
 * just [A], B never touched), then writes table B for the first time. If `txnForContext`
 * (resources/Table.ts ~line 5026) created B's `next` link fresh at that point, it would inherit
 * `open = CLOSED` from the head but NOT `timedOut`, and take the `immediateCommit` branch in
 * `save()` — durably committing standalone, bypassing the poison.
 *
 * ACTUAL (traced + confirmed via server-side debug logging, see resources.js console.error
 * trace captured below): this does NOT happen. `resources/Resource.ts`'s `applyContext` (the
 * `transactional()` wrapper behind every static Table/Resource call, e.g. `tables.TableB.put()`)
 * has its own explicit guard — `context?.transaction?.open === OPEN || context?.transaction?.timedOut`
 * — that is checked BEFORE `txnForContext` is ever reached for the second store. Once the head is
 * poisoned, this guard routes table B's write through the SAME poisoned ambient transaction
 * instead of starting fresh, so it throws `transactionOpenTooLongError` immediately (confirmed in
 * the debug trace: `next.open=undefined next.timedOut=undefined` — the `.next` link for table B
 * was never even created). This guard is deliberate and documented in Resource.ts (citing exactly
 * this class of hazard) and is exactly what closes the gap `abortDueToTimeout()`'s own comment
 * worried about, for the standard Resource-API write path. Net: table B's write is rejected, NOT
 * silently committed. Neither table survives — true cross-store atomicity holds.
 *
 * This is a legitimate negative result: a plausible, code-comment-motivated defect that does NOT
 * reproduce via the standard Resource/Table API, adding coverage for an architectural corner
 * (multi-store `next` chain) that no existing test — including the first-party anchor — exercises
 * by name.
 *
 * Harper SHA: 3dbcf7b9e
 * Reproduction:
 *   npm run test:integration -- "integrationTests/database/longtxn-index-orphan.test.ts"
 */
import { suite, test, before, after } from 'node:test';
import { ok, strictEqual } from 'node:assert';
import { resolve, join } from 'node:path';
import { readFileSync, existsSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';
import { setupHarperWithFixture, teardownHarper, type ContextWithHarper } from '@harperfast/integration-testing';
// @ts-expect-error utils/client.mjs has no type declarations; runtime resolves fine
import { createApiClient } from '../apiTests/utils/client.mjs';

const FIXTURE_PATH = resolve(import.meta.dirname, 'longtxn-index-orphan');
const SCHEMA = 'data';
// Threshold low enough that a single real sleep() reliably crosses it on ONE transaction
// (not wall-clock across many short txns — see task methodology note).
const MAX_TXN_OPEN_MS = 500;
const HOLD_MS = 3000; // 6x threshold; monitor's setInterval(MAX_TXN_OPEN_MS) ticks multiple times mid-hold.
const skipSuite = process.platform === 'win32';

suite(
	'QA-601 over-time write-txn x multi-store next-chain vs secondary index [rocksdb]',
	{ skip: skipSuite },
	(ctx: ContextWithHarper) => {
		let client: ReturnType<typeof createApiClient>;
		let httpURL: string;
		let procOutput = '';

		before(async () => {
			await setupHarperWithFixture(ctx, FIXTURE_PATH, {
				config: {
					storage: { maxTransactionOpenTime: MAX_TXN_OPEN_MS, debugLongTransactions: true },
					logging: { console: true, level: 'error' },
				},
				env: {},
			});
			client = createApiClient(ctx.harper);
			httpURL = ctx.harper.httpURL;

			procOutput += ctx.harper.startupOutput?.stdout ?? '';
			procOutput += ctx.harper.startupOutput?.stderr ?? '';
			const proc = ctx.harper.process;
			proc?.stdout?.on('data', (d: Buffer) => (procOutput += d.toString()));
			proc?.stderr?.on('data', (d: Buffer) => (procOutput += d.toString()));

			// Readiness poll — workers register routes async (see integrationTests/database/ttl.test.ts pattern).
			const deadline = Date.now() + 30_000;
			let ready = false;
			while (Date.now() < deadline) {
				try {
					const probe = await fetch(`${httpURL}/ReadyProbe/`, {
						headers: { Authorization: client.headers.Authorization },
						signal: AbortSignal.timeout(3_000),
					});
					await probe.body?.cancel();
					if (probe.status === 200) {
						ready = true;
						break;
					}
				} catch {
					/* not ready */
				}
				await sleep(250);
			}
			ok(ready, 'ReadyProbe route did not become ready within 30 seconds');
		});

		after(async () => {
			await teardownHarper(ctx);
		});

		function postJSON(path: string, body: unknown): Promise<Response> {
			return fetch(`${httpURL}${path}`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json', 'Authorization': client.headers.Authorization },
				body: JSON.stringify(body),
			});
		}

		/** Count monitor firings so each trial must produce a new over-time event. */
		function countOverTimeOccurrences(): number {
			let logText = '';
			const logDir = (ctx.harper as any).logDir as string | undefined;
			if (logDir) {
				for (const name of ['hdb.log', 'stdout.log', 'stderr.log']) {
					const p = join(logDir, name);
					if (existsSync(p)) {
						try {
							logText += readFileSync(p, 'utf8');
						} catch {
							/* ignore */
						}
					}
				}
			}
			return (
				(logText.match(/Transaction was open too long/gi)?.length ?? 0) +
				(procOutput.match(/Transaction was open too long/gi)?.length ?? 0)
			);
		}

		async function dumpA(): Promise<Array<{ id: string; tag: string }>> {
			const r = await fetch(`${httpURL}/DumpA/`, { headers: { Authorization: client.headers.Authorization } });
			strictEqual(r.status, 200, 'DumpA should return 200');
			return (await r.json()) as Array<{ id: string; tag: string }>;
		}
		async function dumpB(): Promise<Array<{ id: string; tag: string }>> {
			const r = await fetch(`${httpURL}/DumpB/`, { headers: { Authorization: client.headers.Authorization } });
			strictEqual(r.status, 200, 'DumpB should return 200');
			return (await r.json()) as Array<{ id: string; tag: string }>;
		}
		async function searchByTag(table: string, tag: string): Promise<Set<string>> {
			const r = await client
				.req()
				.send({
					operation: 'search_by_value',
					schema: SCHEMA,
					table,
					search_attribute: 'tag',
					search_value: tag,
					get_attributes: ['id', 'tag'],
				})
				.timeout(30_000)
				.expect(200);
			const rows: any[] = Array.isArray(r.body) ? r.body : [];
			return new Set(rows.map((row) => String(row.id)));
		}

		/** Both-direction index<->primary consistency check for one table + tag. */
		async function checkConsistency(table: string, tag: string, baseRows: Array<{ id: string; tag: string }>) {
			const indexHits = await searchByTag(table, tag);
			const baseIds = new Set(baseRows.filter((r) => r.tag === tag).map((r) => r.id));
			const phantom = [...indexHits].filter((id) => !baseIds.has(id)); // index -> no live base row
			const missing = [...baseIds].filter((id) => !indexHits.has(id)); // base row -> not findable via index
			return { indexCount: indexHits.size, baseCount: baseIds.size, phantom, missing };
		}

		// ---- CONTROL: quick write to both tables under threshold commits atomically ----
		test('CONTROL: under-threshold cross-table write commits both A and B, index-consistent', async () => {
			const tag = 'ctrl';
			const res = await postJSON('/CrossBaseline/', { tag });
			strictEqual(res.status, 200, `Baseline should return 200 (got ${res.status})`);

			const [a, b] = await Promise.all([dumpA(), dumpB()]);
			const rA = await checkConsistency('TableA', tag, a);
			const rB = await checkConsistency('TableB', tag, b);
			console.log(
				`[QA-601 CONTROL] status=${res.status} A(base=${rA.baseCount},idx=${rA.indexCount}) B(base=${rB.baseCount},idx=${rB.indexCount})`
			);
			strictEqual(rA.baseCount, 1, 'Table A should have the control row');
			strictEqual(rB.baseCount, 1, 'Table B should have the control row');
			strictEqual(
				rA.phantom.length + rA.missing.length + rB.phantom.length + rB.missing.length,
				0,
				'no orphaned index entries in control'
			);
		});

		async function runCrossOvertimeTrial(tag: string) {
			const overTimeBaseline = countOverTimeOccurrences();
			const t0 = Date.now();
			const res = await postJSON('/CrossOvertime/', { tag, holdMs: HOLD_MS });
			const elapsed = Date.now() - t0;
			const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
			let overTimeCount = countOverTimeOccurrences();
			const deadline = Date.now() + 5_000;
			while (overTimeCount <= overTimeBaseline && Date.now() < deadline) {
				await sleep(100);
				overTimeCount = countOverTimeOccurrences();
			}
			const fired = overTimeCount > overTimeBaseline;
			const [a, b] = await Promise.all([dumpA(), dumpB()]);
			const rA = await checkConsistency('TableA', tag, a);
			const rB = await checkConsistency('TableB', tag, b);
			const aSurvived = rA.baseCount > 0;
			const bSurvived = rB.baseCount > 0;

			const debugLines = procOutput
				.split('\n')
				.filter((line) => line.includes(`QA601-DEBUG ${tag}`))
				.join('\n');
			console.log(
				`\n[QA-601 ${tag}] status=${res.status} elapsedMs=${elapsed} bError=${JSON.stringify((body as any).bError)}\n` +
					`  overTimeFired=${fired}\n` +
					`  TableA: base=${rA.baseCount} idx=${rA.indexCount} phantom=${rA.phantom.length} missing=${rA.missing.length}\n` +
					`  TableB: base=${rB.baseCount} idx=${rB.indexCount} phantom=${rB.phantom.length} missing=${rB.missing.length}\n` +
					`  *** aSurvived=${aSurvived} bSurvived=${bSurvived} clientStatus=${res.status} ***\n` +
					`  --- server debug trace ---\n${debugLines}\n  --- end trace ---`
			);

			return { res, fired, rA, rB, aSurvived, bSurvived };
		}

		// ---- PROBE run 1 ----
		test(
			'PROBE run 1: write A, hold past threshold (single txn), first-touch write B',
			{ timeout: 30_000 },
			async () => {
				const { res, fired, rA, rB, aSurvived, bSurvived } = await runCrossOvertimeTrial('probe1');

				// Hard precondition: the force-commit/abort path must have actually been entered on a
				// single transaction (not inferred from wall-clock).
				ok(
					fired,
					'Long-transaction monitor must have logged "Transaction was open too long" — else this run does not cover the axis'
				);

				// Index/primary consistency must hold in BOTH directions on EACH table, regardless of
				// which rows ultimately survived.
				strictEqual(rA.phantom.length, 0, `Table A phantom index entries: ${JSON.stringify(rA.phantom)}`);
				strictEqual(rA.missing.length, 0, `Table A missing index entries: ${JSON.stringify(rA.missing)}`);
				strictEqual(rB.phantom.length, 0, `Table B phantom index entries: ${JSON.stringify(rB.phantom)}`);
				strictEqual(rB.missing.length, 0, `Table B missing index entries: ${JSON.stringify(rB.missing)}`);

				// Cross-table atomicity: table A (the poisoned head) must NOT have survived.
				strictEqual(
					aSurvived,
					false,
					'Table A (head, poisoned by the monitor) unexpectedly survived — should have been aborted/rolled back'
				);

				// Client must be told the request failed (never a silent-success 2xx over a torn write).
				ok(res.status < 200 || res.status >= 300, `expected a non-2xx response, got ${res.status}`);

				// The core hypothesis check: table B's write must NOT escape the head's poison and land as
				// a silently-committed partial write while the client is told the overall request failed.
				// Per transactionOpenTooLongError's own contract ("the request rolls back cleanly instead
				// of silently committing a partial write set"), table B surviving here would violate it.
				strictEqual(
					bSurvived,
					false,
					`DEFECT: client got status=${res.status} (reported failure) but table B's row durably committed anyway — ` +
						`silent partial-write survival under a reported abort (multi-store next-chain poison gap)`
				);
			}
		);

		// ---- PROBE run 2 (reproducibility) ----
		test('PROBE run 2: repeat to confirm reproducibility', { timeout: 30_000 }, async () => {
			const { res, fired, rA, rB, aSurvived, bSurvived } = await runCrossOvertimeTrial('probe2');
			ok(fired, 'Long-transaction monitor must have fired on run 2 as well');
			strictEqual(rA.phantom.length, 0, `Run 2 Table A phantom: ${JSON.stringify(rA.phantom)}`);
			strictEqual(rA.missing.length, 0, `Run 2 Table A missing: ${JSON.stringify(rA.missing)}`);
			strictEqual(rB.phantom.length, 0, `Run 2 Table B phantom: ${JSON.stringify(rB.phantom)}`);
			strictEqual(rB.missing.length, 0, `Run 2 Table B missing: ${JSON.stringify(rB.missing)}`);
			strictEqual(aSurvived, false, 'Run 2: Table A (head) unexpectedly survived');
			ok(res.status < 200 || res.status >= 300, `Run 2: expected a non-2xx response, got ${res.status}`);
			strictEqual(bSurvived, false, 'Run 2: DEFECT — table B row survived despite reported failure');
		});
	}
);
