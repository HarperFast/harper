/**
 * QA-616 — aborted UPDATE that migrates an @indexed value (A -> B): index atomicity probe.
 *
 * Background. F-147 (confirmed via QA-604/QA-607/QA-609/QA-611) and F-149 are both DELETE-shaped:
 * Table.ts _writeDelete()'s audit:false commit branch calls removeEntry(primaryStore, existingEntry)
 * WITHOUT the {transaction} option its sibling updateIndices(id, existingRecord, null,
 * transaction && {transaction}) threads one line above (~Table.ts 2660/2680) — so the primary
 * removal commits standalone regardless of how the enclosing transaction dies. The RocksDB eviction
 * sweep (Table.ts ~5540-5610, createEvictionBatcher) uses its OWN dedicated `new RocksTransaction
 * (primaryStore.store)` per batch, entirely outside the request/monitor's tracked-transaction
 * machinery, orphaning secondary-index entries on 100% of TTL evictions (F-149).
 *
 * THE UNCOVERED CORNER this file targets: an UPDATE that changes an @indexed attribute's value from
 * A to B must REMOVE the old index(A -> id) entry and ADD a new index(B -> id) entry (Table.ts
 * updateIndices(), ~line 4734). The ordinary write path (Table.ts ~2522) calls this AS
 * `updateIndices(id, existingRecord, recordToStore, transaction && {transaction})` — correctly
 * transaction-scoped, unlike the buggy delete branch. The question is whether that correct wiring
 * actually holds under abort, for both abort mechanisms:
 *   - in-request throw (mirrors QA-604's DeleteThenAbort, resources/transaction.ts onError -> abort)
 *   - over-time abort (storage.maxTransactionOpenTime -> DatabaseTransaction.ts
 *     startMonitoringTxns/abortDueToTimeout, issue #1407's abort+poison path, confirmed present at
 *     this SHA by reading DatabaseTransaction.ts:695-712)
 *
 * Enumerated possibilities per abort, measured directly against the raw index dbi (not
 * search_by_value — D-230 "oracle-masking fallacy": Table.ts transformToEntries() joins every index
 * hit through the primary record and SKIPs on absence, so a dangling entry is invisible to any
 * query-surface oracle):
 *   (a) fully atomic  — entry at A restored/unchanged, no entry at B, primary rolls back  (CORRECT)
 *   (b) old orphaned  — entry at A removed/missing while primary rolls back (F-147-family lost-index)
 *   (c) new leaked    — entry at B present pointing at a value the primary never committed (phantom,
 *                        the QA-607 wrong-result signature: later query on B returns a record whose
 *                        actual field != B)
 *
 * POSITIVE CONTROL (mandatory, D-225 "no vacuous greens"): injects a SYNTHETIC dangling entry on
 * this same fixture shape (RemoveFromPrimaryOnly — a real put, then a primary-store removal that
 * bypasses updateIndices()) to prove the direct-store oracle DOES detect one, before any "clean"
 * result on the update path is trusted. Deliberately synthetic rather than reusing a real defect's
 * mechanism (QA-604's delete-then-abort, F-147): a control keyed to an open defect would turn this
 * file red the day that defect is fixed.
 *
 * Reproduction:
 *   cd /home/kzyp/dev/harper
 *   timeout 900 npm run test:integration -- "integrationTests/database/aborted-update-index-migration.test.ts"
 * Verified green on harper 1e1edc666 (promoted from QA-616).
 */
import { suite, test, before, after } from 'node:test';
import assert from 'node:assert';
const { ok, strictEqual, deepStrictEqual } = assert;
import { resolve, join } from 'node:path';
import { readFileSync, existsSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';
import request from 'supertest';
import { setupHarperWithFixture, teardownHarper, type ContextWithHarper } from '@harperfast/integration-testing';
// @ts-expect-error utils/client.mjs has no type declarations; runtime resolves fine
import { createApiClient } from '../apiTests/utils/client.mjs';
// @ts-expect-error utils/lifecycle.mjs has no type declarations; runtime resolves fine
import { restartHttpWorkers } from '../apiTests/utils/lifecycle.mjs';

const FIXTURE_PATH = resolve(import.meta.dirname, 'aborted-update-index-migration');
const SCHEMA = 'data';
// Low enough that a 4s deliberate stall reliably crosses ~2x threshold (the monitor's own tick
// math: timeout starts at maxTransactionOpenTime and is decremented by that same amount each tick
// -> fires on the 2nd tick, ~2x threshold wall time), high enough that the plain single-put-then-
// throw/return requests (sub-few-ms) never spuriously trip it.
const MAX_TXN_OPEN_MS = 800;
const STALL_MS = 4000;
const skipSuite = process.platform === 'win32';

suite(
	'QA-616 aborted index-migrating UPDATE (A -> B) vs secondary-index atomicity [rocksdb]',
	{ skip: skipSuite },
	(ctx: ContextWithHarper) => {
		let client: ReturnType<typeof createApiClient>;
		let procOutput = '';
		const findings: string[] = [];

		before(async () => {
			await setupHarperWithFixture(ctx, FIXTURE_PATH, {
				config: {
					threads: { count: 1 },
					storage: { maxTransactionOpenTime: MAX_TXN_OPEN_MS, debugLongTransactions: true },
					logging: { console: true, level: 'error' },
				},
				env: { THREADS_COUNT: '1' },
			});
			client = createApiClient(ctx.harper);
			await restartHttpWorkers(client, '/Widget/', 120_000);

			procOutput += ctx.harper.startupOutput?.stdout ?? '';
			procOutput += ctx.harper.startupOutput?.stderr ?? '';
			const proc = ctx.harper.process;
			proc?.stdout?.on('data', (d: Buffer) => (procOutput += d.toString()));
			proc?.stderr?.on('data', (d: Buffer) => (procOutput += d.toString()));

			findings.push('Engine: rocksdb (default, not overridden)');
			findings.push(`maxTransactionOpenTime=${MAX_TXN_OPEN_MS}ms, stall=${STALL_MS}ms`);
		});

		after(async () => {
			await teardownHarper(ctx);
			console.log('\n[QA-616] FINDINGS');
			for (const f of findings) console.log('  ' + f);
		});

		function getJSON(path: string) {
			return fetch(`${ctx.harper.httpURL}${path}`, { headers: { Authorization: client.headers.Authorization } });
		}
		function postJSON(path: string, body: unknown) {
			return fetch(`${ctx.harper.httpURL}${path}`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json', 'Authorization': client.headers.Authorization },
				body: JSON.stringify(body),
			});
		}

		async function seed(id: string, category: string, value: string) {
			await request(client.restURL).put(`/Widget/${id}`).set(client.headers).send({ id, category, value }).expect(204);
		}
		async function pointRead(id: string): Promise<{ status: number; body?: any }> {
			const r = await request(client.restURL).get(`/Widget/${id}`).set(client.headers);
			return { status: r.status, body: r.body };
		}
		async function indexDump(category: string): Promise<string[]> {
			const r = await getJSON(`/IndexDump/?category=${encodeURIComponent(category)}`);
			strictEqual(r.status, 200, 'IndexDump should return 200');
			const body = (await r.json()) as { ids?: string[] };
			return (body.ids ?? []).map(String);
		}
		/** search_by_value(category) -> full rows, via the operations API (query-visibility surface). */
		async function searchByValue(category: string): Promise<any[]> {
			const r = await client
				.req()
				.send({
					operation: 'search_by_value',
					schema: SCHEMA,
					table: 'Widget',
					search_attribute: 'category',
					search_value: category,
					get_attributes: ['id', 'category', 'value'],
				})
				.timeout(30_000)
				.expect(200);
			return Array.isArray(r.body) ? r.body : [];
		}
		function overTimeFireCount(): number {
			let logText = procOutput;
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
			return (logText.match(/Transaction was open too long/gi) || []).length;
		}

		// ==========================================================================================
		// POSITIVE CONTROL — proves the direct-store oracle detects a genuinely dangling entry
		// (D-225: a "clean" result on the update-migration path below is vacuous without this).
		// ==========================================================================================
		test('POSITIVE CONTROL: a synthetic dangling entry is one the oracle DOES see', async () => {
			await seed('pc-1', 'pc-catA', 'v');
			const before1 = await indexDump('pc-catA');
			ok(before1.includes('pc-1'), `PRECONDITION: index must see pc-1 before removal (got ${JSON.stringify(before1)})`);

			const res = await postJSON('/RemoveFromPrimaryOnly/', { id: 'pc-1' });
			strictEqual(res.status, 200, `PRECONDITION: synthetic primary-only removal must succeed, got ${res.status}`);
			await sleep(400);

			const pr = await pointRead('pc-1');
			strictEqual(pr.status, 404, 'PRECONDITION: primary row must be gone after the primary-only removal');

			const after1 = await indexDump('pc-catA');
			findings.push(
				`POSITIVE CONTROL: direct-store IndexDump(pc-catA) after synthetic primary-only removal = ${JSON.stringify(after1)}`
			);
			ok(
				after1.includes('pc-1'),
				`ORACLE SANITY FAILED: expected the oracle to see a dangling entry but got ${JSON.stringify(after1)} — the oracle cannot be trusted below`
			);
			findings.push('POSITIVE CONTROL: oracle CONFIRMED capable of detecting a genuinely dangling raw index entry.');
		});

		// ==========================================================================================
		// CONTROL — successful (non-aborted) index-migrating update: A -> B should end with exactly
		// one entry at B, none at A.
		// ==========================================================================================
		test('CONTROL: successful update migrates category A -> B with exactly one entry at B, none at A', async () => {
			await seed('ctrl-1', 'ctrl-catA', 'orig');
			const res = await postJSON('/UpdateOK/', { id: 'ctrl-1', newCategory: 'ctrl-catB' });
			strictEqual(res.status, 200, `Successful update should return 200 (got ${res.status})`);

			const pr = await pointRead('ctrl-1');
			strictEqual(pr.status, 200, 'record must be point-readable after a successful update');
			strictEqual(pr.body?.category, 'ctrl-catB', 'record must carry the NEW category after a successful update');

			const dumpA = await indexDump('ctrl-catA');
			const dumpB = await indexDump('ctrl-catB');
			findings.push(
				`CONTROL: after clean A->B update, IndexDump(A)=${JSON.stringify(dumpA)} IndexDump(B)=${JSON.stringify(dumpB)}`
			);

			const svA = await searchByValue('ctrl-catA');
			const svB = await searchByValue('ctrl-catB');
			findings.push(
				`CONTROL: search_by_value(A)=${JSON.stringify(svA.map((r) => r.id))} search_by_value(B)=${JSON.stringify(svB.map((r) => r.id))}`
			);

			deepStrictEqual(
				dumpA,
				[],
				'CONTROL: old-value entry at A must be fully removed after a successful migrating update'
			);
			deepStrictEqual(
				dumpB,
				['ctrl-1'],
				'CONTROL: exactly one entry at B must exist after a successful migrating update'
			);
			strictEqual(
				svA.some((r) => r.id === 'ctrl-1'),
				false,
				'CONTROL: query on A must not return ctrl-1'
			);
			ok(
				svB.some((r) => r.id === 'ctrl-1' && r.category === 'ctrl-catB'),
				'CONTROL: query on B must return ctrl-1 with category=B'
			);
		});

		// ==========================================================================================
		// EXPERIMENT 1 — in-request abort (plain throw after the migrating update).
		// ==========================================================================================
		test('EXPERIMENT 1: in-request-abort index-migrating update (A -> B) — raw index + primary state', async () => {
			await seed('exp1-1', 'exp1-catA', 'orig');
			const before1 = await indexDump('exp1-catA');
			ok(
				before1.includes('exp1-1'),
				`PRECONDITION: index must see exp1-1 under A before the migrating update (got ${JSON.stringify(before1)})`
			);

			const res = await postJSON('/UpdateThenAbort/', { id: 'exp1-1', newCategory: 'exp1-catB' });
			ok(res.status >= 500, `PRECONDITION: UpdateThenAbort must enter the abort path (5xx), got ${res.status}`);
			await sleep(400);

			const pr = await pointRead('exp1-1');
			const dumpA = await indexDump('exp1-catA');
			const dumpB = await indexDump('exp1-catB');
			const svA = await searchByValue('exp1-catA');
			const svB = await searchByValue('exp1-catB');

			findings.push(
				`EXPERIMENT 1 (in-request abort): pointRead=${JSON.stringify(pr)} ` +
					`IndexDump(A)=${JSON.stringify(dumpA)} IndexDump(B)=${JSON.stringify(dumpB)} ` +
					`search_by_value(A)=${JSON.stringify(svA)} search_by_value(B)=${JSON.stringify(svB)}`
			);

			let verdict: string;
			if (
				dumpA.includes('exp1-1') &&
				!dumpB.includes('exp1-1') &&
				pr.status === 200 &&
				pr.body?.category === 'exp1-catA'
			) {
				verdict = '(a) ATOMIC — old entry at A intact, no entry at B, primary rolled back to A. CORRECT.';
			} else if (!dumpA.includes('exp1-1') && !dumpB.includes('exp1-1')) {
				verdict =
					'(b) OLD-ORPHANED — entry at A missing/removed while primary rolled back (F-147-family lost-index). DEFECT.';
			} else if (dumpB.includes('exp1-1')) {
				verdict =
					'(c) NEW-LEAKED — phantom entry at B survives despite the update never durably committing. DEFECT (QA-607-signature risk).';
			} else {
				verdict = `UNEXPECTED STATE — dumpA=${JSON.stringify(dumpA)} dumpB=${JSON.stringify(dumpB)} pr=${JSON.stringify(pr)}`;
			}
			findings.push(`EXPERIMENT 1 VERDICT: ${verdict}`);

			const wrongResultB = svB.find((r: any) => r.id === 'exp1-1' && r.category !== 'exp1-catB');
			findings.push(
				`EXPERIMENT 1 correctness angle: search_by_value(exp1-catB) wrong-result row = ${wrongResultB ? JSON.stringify(wrongResultB) : 'none'}`
			);

			// Hard assertions for possibility (a) — CORRECT/EXPECTED. A failure here is itself the
			// empirical proof of whichever defect (b)/(c) actually occurred (see verdict above/findings).
			strictEqual(
				dumpA.includes('exp1-1'),
				true,
				`old-value entry at A must survive an aborted migrating update: ${verdict}`
			);
			strictEqual(
				dumpB.includes('exp1-1'),
				false,
				`no phantom entry at B may survive an aborted migrating update: ${verdict}`
			);
			strictEqual(
				wrongResultB,
				undefined,
				`search_by_value(B) must not return a record whose actual category != B: ${verdict}`
			);
			if (pr.status === 200) {
				strictEqual(
					pr.body?.category,
					'exp1-catA',
					`primary record must roll back to its original category: ${verdict}`
				);
			}
		});

		// ==========================================================================================
		// EXPERIMENT 2 — over-time abort (drive the same migration over maxTransactionOpenTime).
		// ==========================================================================================
		test(
			'EXPERIMENT 2: over-time-abort index-migrating update (A -> B) — raw index + primary state',
			{ timeout: 60_000 },
			async () => {
				await seed('exp2-1', 'exp2-catA', 'orig');
				const before1 = await indexDump('exp2-catA');
				ok(
					before1.includes('exp2-1'),
					`PRECONDITION: index must see exp2-1 under A before the migrating update (got ${JSON.stringify(before1)})`
				);

				const fireBefore = overTimeFireCount();
				const res = await postJSON('/UpdateThenStall/', { id: 'exp2-1', newCategory: 'exp2-catB', stallMs: STALL_MS });
				const fireAfter = overTimeFireCount();
				await sleep(600);

				// PROVE the over-time abort path actually fired (D-225: do not infer, grep the log).
				ok(
					fireAfter > fireBefore,
					`PRECONDITION FAILED: over-time monitor never logged "Transaction was open too long" (fireBefore=${fireBefore} fireAfter=${fireAfter}) — increase STALL_MS or lower MAX_TXN_OPEN_MS`
				);
				findings.push(
					`EXPERIMENT 2: over-time monitor fired (count ${fireBefore} -> ${fireAfter}); request status=${res.status}`
				);

				const pr = await pointRead('exp2-1');
				const dumpA = await indexDump('exp2-catA');
				const dumpB = await indexDump('exp2-catB');
				const svA = await searchByValue('exp2-catA');
				const svB = await searchByValue('exp2-catB');

				findings.push(
					`EXPERIMENT 2 (over-time abort): pointRead=${JSON.stringify(pr)} ` +
						`IndexDump(A)=${JSON.stringify(dumpA)} IndexDump(B)=${JSON.stringify(dumpB)} ` +
						`search_by_value(A)=${JSON.stringify(svA)} search_by_value(B)=${JSON.stringify(svB)}`
				);

				let verdict: string;
				if (
					dumpA.includes('exp2-1') &&
					!dumpB.includes('exp2-1') &&
					pr.status === 200 &&
					pr.body?.category === 'exp2-catA'
				) {
					verdict = '(a) ATOMIC — old entry at A intact, no entry at B, primary rolled back to A. CORRECT.';
				} else if (!dumpA.includes('exp2-1') && !dumpB.includes('exp2-1')) {
					verdict =
						'(b) OLD-ORPHANED — entry at A missing/removed while primary rolled back (F-147-family lost-index). DEFECT.';
				} else if (dumpB.includes('exp2-1')) {
					verdict =
						'(c) NEW-LEAKED — phantom entry at B survives despite the update never durably committing. DEFECT (QA-607-signature risk).';
				} else {
					verdict = `UNEXPECTED STATE — dumpA=${JSON.stringify(dumpA)} dumpB=${JSON.stringify(dumpB)} pr=${JSON.stringify(pr)}`;
				}
				findings.push(`EXPERIMENT 2 VERDICT: ${verdict}`);

				const wrongResultB = svB.find((r: any) => r.id === 'exp2-1' && r.category !== 'exp2-catB');
				findings.push(
					`EXPERIMENT 2 correctness angle: search_by_value(exp2-catB) wrong-result row = ${wrongResultB ? JSON.stringify(wrongResultB) : 'none'}`
				);

				strictEqual(
					dumpA.includes('exp2-1'),
					true,
					`old-value entry at A must survive an over-time-aborted migrating update: ${verdict}`
				);
				strictEqual(
					dumpB.includes('exp2-1'),
					false,
					`no phantom entry at B may survive an over-time-aborted migrating update: ${verdict}`
				);
				strictEqual(
					wrongResultB,
					undefined,
					`search_by_value(B) must not return a record whose actual category != B: ${verdict}`
				);
				if (pr.status === 200) {
					strictEqual(
						pr.body?.category,
						'exp2-catA',
						`primary record must roll back to its original category: ${verdict}`
					);
				}
			}
		);

		test('SUMMARY', async () => {
			console.log('\n[QA-616 SUMMARY] see FINDINGS above for exact per-experiment verdicts.');
			ok(true);
		});
	}
);
