/**
 * QA-596 — is a `sourcedFrom` cache resolver's snapshot read-scoping CONTRACTUAL or
 * incidental?
 *
 * QA-595 (sourcedfrom-eav-cache-coherence.test.ts) found zero torn views across an EAV
 * resolver that read 5 rows back-to-back with no real async gap between reads. That
 * proved reads LOOK snapshot-scoped, but not why, and therefore not whether it's
 * guaranteed.
 *
 * MECHANISM (traced in harper at 3dbcf7b9e):
 *   1. resources/Table.ts `getFromSource` invokes the resolver inside
 *      `transaction(sourceContext, async (_txn) => { ... throttledCallToSource(...) ... })`.
 *   2. resources/transaction.ts `transaction()` creates a fresh `DatabaseTransaction` and,
 *      because `sourceContext` carries no ambient AsyncLocalStorage store of its own, runs
 *      the callback via `contextStorage.run(context, () => callback(transaction))`. Node's
 *      AsyncLocalStorage keeps that store live across every `await` inside the callback's
 *      async continuation, not just its first synchronous tick — real timers included.
 *   3. Inside the resolver, a nested read like `Attribute.get(key)` (no explicit context
 *      arg) falls through to resources/Resource.ts `context = contextStorage.getStore() ?? {}`
 *      — picking up the SAME `sourceContext`, whose `.transaction` is OPEN, so
 *      resources/transaction.ts reuses the identical `DatabaseTransaction` for every
 *      subsequent read in the fill.
 *   4. DatabaseTransaction.getReadTxn() (resources/DatabaseTransaction.ts) memoizes ONE
 *      underlying RocksTransaction per store, lazily opened on first touch and reused for
 *      every later `getEntry()` call — that's the actual MVCC snapshot pin. It is never
 *      re-opened until the outer `transaction()` wrapper commits, which happens only AFTER
 *      the resolver's `get()` returns.
 *   5. BUT: for a resolver spanning two DATABASES, `txnForContext` (resources/Table.ts)
 *      chains a SEPARATE `DatabaseTransaction` per store, and each chained store's
 *      RocksTransaction is ALSO opened lazily, independently, on ITS first touch — not
 *      eagerly for the whole logical transaction. So a second database's snapshot is
 *      pinned whenever the resolver first reads it, which can be AFTER a real async gap
 *      during which a writer committed to that database. Single-database reads (even
 *      across multiple tables, since all tables in one database share one rootStore path)
 *      share one snapshot by construction (deliberate transaction reuse); cross-DATABASE
 *      reads only share a snapshot if both databases happen to have been touched before
 *      any intervening commit — an incidental, timing-dependent property, not a guarantee.
 *
 * Three probes force a real async gap (a real timer, not a same-tick microtask hop)
 * straddling a concurrent commit:
 *   P1 single-store: SingleTableSnap resolver reads Cell row slotA, awaits a real 500ms
 *      timer, then reads Cell row slotB (same table/store as slotA). A concurrent writer
 *      mutates slotB mid-gap. The fill's OWN view of slotB stays pinned to the
 *      pre-mutation value.
 *   P2 cross-DATABASE: CrossTableSnap resolver reads RowA (default db), awaits the same
 *      real gap, then reads RowB (a table in a SEPARATE database, "qa596b"). A concurrent
 *      writer mutates RowB mid-gap. RowB's snapshot is not pinned until touched, so the
 *      fill's own view of genB picks up the concurrent write — a genuinely torn
 *      cross-database snapshot. This is EXPECTED (by-design), not a defect — the test
 *      only asserts no hang/error and eventual convergence, not a particular torn count.
 *   P3 cross-TABLE, same database: isolates whether the P2 seam is "two tables" or
 *      specifically "two databases" — RowA and RowC are two distinct tables sharing one
 *      database/rootStore, so this predicts the SAME guarantee as P1 (consistent despite
 *      the real gap), confirming the seam found in P2 is the database boundary, not the
 *      table boundary.
 *
 * Originating QA-id: QA-596. Promoted from the qa-explorer promote-candidates snapshot
 * (P-383) after a cold gate rerun on main. Pairs with sourcedfrom-eav-cache-coherence.test.ts
 * (QA-595).
 */
import { suite, test, before, after } from 'node:test';
import { ok, strictEqual } from 'node:assert';
import { resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { setupHarperWithFixture, teardownHarper, type ContextWithHarper } from '@harperfast/integration-testing';
// @ts-expect-error utils/client.mjs has no type declarations; runtime resolves fine
import { createApiClient } from '../apiTests/utils/client.mjs';
// @ts-expect-error utils/lifecycle.mjs has no type declarations; runtime resolves fine
import { restartHttpWorkers } from '../apiTests/utils/lifecycle.mjs';

const FIXTURE_PATH = resolve(import.meta.dirname, 'sourcedfrom-snapshot-scoping');
const skipSuite = process.platform === 'win32';

const TTL_MS = 3000; // matches schema.graphql's @table(expiration: 3) on both cache tables
const SETTLE_MS = 2500;
const GAP_MS = 500; // the real async gap forced inside both resolvers via Control { gapMs }
const MUTATE_AT_MS = 150; // fire the concurrent mutation partway through the gap, well clear of both edges
const N_TRIALS = 20; // distinct entities per probe, so each trial forces a fresh fill

interface SingleBody {
	id: string;
	gens: { slotA: number | null; slotB: number | null };
	fillSeq: number;
	assembledAt: number;
}
interface CrossBody {
	id: string;
	genA: number | null;
	genB: number | null;
	fillSeq: number;
	assembledAt: number;
}
interface TwoTableSameDbBody {
	id: string;
	genA: number | null;
	genC: number | null;
	fillSeq: number;
	assembledAt: number;
}

suite(
	'QA-596 sourcedFrom resolver snapshot scoping under a real async gap',
	{ skip: skipSuite },
	(ctx: ContextWithHarper) => {
		let client: ReturnType<typeof createApiClient>;
		let restURL: string;
		let headers: Record<string, string>;

		async function putCell(entityId: string, slot: string, gen: number): Promise<number> {
			const key = `${entityId}:${slot}`;
			const res = await fetch(`${restURL}/Cell/${encodeURIComponent(key)}`, {
				method: 'PUT',
				headers,
				body: JSON.stringify({ id: key, entityId, slot, gen }),
			});
			await res.text().catch(() => undefined);
			if (![200, 201, 204].includes(res.status)) throw new Error(`PUT Cell/${key} -> ${res.status}`);
			return res.status;
		}

		async function putRow(table: 'RowA' | 'RowB' | 'RowC', id: string, gen: number): Promise<number> {
			const res = await fetch(`${restURL}/${table}/${encodeURIComponent(id)}`, {
				method: 'PUT',
				headers,
				body: JSON.stringify({ id, gen }),
			});
			await res.text().catch(() => undefined);
			if (![200, 201, 204].includes(res.status)) throw new Error(`PUT ${table}/${id} -> ${res.status}`);
			return res.status;
		}

		async function getJSON<T>(path: string): Promise<{ status: number; body: T | null }> {
			const res = await fetch(`${restURL}${path}`, { headers });
			const text = await res.text();
			let body: T | null = null;
			try {
				body = JSON.parse(text);
			} catch {
				/* leave null */
			}
			return { status: res.status, body };
		}

		/**
		 * Run one trial: `fill` is already in flight (its resolver is mid-gap), `duringFill`
		 * lands the concurrent commit inside that gap. Both are always awaited, so a trial can
		 * never leave a request in flight past the end of the test — an orphaned fetch that
		 * rejects after teardown surfaces as an unhandledRejection blamed on whichever test is
		 * running by then, masking the real failure (#1833). `duringFill`'s error wins: the
		 * fill's is usually just downstream of it.
		 */
		async function trial<T>(fill: Promise<T>, duringFill: () => Promise<void>): Promise<T> {
			const [filled, mutated] = await Promise.allSettled([fill, duringFill()]);
			if (mutated.status === 'rejected') throw mutated.reason;
			if (filled.status === 'rejected') throw filled.reason;
			return filled.value;
		}

		/** POST the gap and return the threadId of the worker now holding it. */
		async function setGap(ms: number): Promise<number> {
			const res = await fetch(`${restURL}/Control/`, { method: 'POST', headers, body: JSON.stringify({ gapMs: ms }) });
			if (res.status !== 200) throw new Error(`Control gapMs=${ms} -> ${res.status}`);
			const body = (await res.json().catch(() => null)) as { gapMs?: number; threadId?: number } | null;
			ok(body && body.gapMs === ms, `Control did not accept gapMs=${ms}: ${JSON.stringify(body)}`);
			ok(typeof body!.threadId === 'number', `Control returned no threadId: ${JSON.stringify(body)}`);
			return body!.threadId!;
		}

		/**
		 * `gapMs` is resources.js module state on ONE worker. If that worker is replaced mid-test the
		 * replacement silently reverts to the default (100ms) gap — shorter than MUTATE_AT_MS — so the
		 * mutation lands *after* the resolver already read its second row and every probe below becomes
		 * a vacuous pass: tornCount=0 proves nothing. That is exactly what a premature
		 * `restartHttpWorkers()` used to cause (#1833). Pin it: the worker we handed the gap to must
		 * still be the one serving.
		 */
		async function assertGapWorkerStillServing(expectedThreadId: number): Promise<void> {
			const { status, body } = await getJSON<{ threadId: number }>('/WhoAmI/');
			ok(status === 200 && body, `GET /WhoAmI/ failed: ${status}`);
			strictEqual(
				body!.threadId,
				expectedThreadId,
				`the worker holding gapMs=${GAP_MS} was replaced mid-test (was thread ${expectedThreadId}, now ` +
					`${body!.threadId}): the probe ran with the default gap and proves nothing`
			);
		}

		before(async () => {
			// Single worker (default thread count) deliberately: resources.js's `gapMs`/`fillLog` module
			// state is per-worker-thread (each worker loads its own copy of resources.js), and POST
			// /Control/ only lands on whichever worker handles that one request. With multiple workers,
			// GETs load-balanced onto a worker that never received the gapMs update would silently run
			// with the default gap, turning "mutate mid-gap" into an uncontrolled race against whatever
			// gap that worker happens to be using. The mechanism under test (AsyncLocalStorage-propagated
			// context + DatabaseTransaction reuse) is single-request/single-worker by construction, so a
			// single worker isolates the real question. `threadId` is still reported per fill for
			// attribution/debugging.
			await setupHarperWithFixture(ctx, FIXTURE_PATH, { config: {}, env: {} });
			client = createApiClient(ctx.harper);
			restURL = ctx.harper.httpURL;
			headers = { 'Content-Type': 'application/json', 'Authorization': client.headers.Authorization };

			await restartHttpWorkers(client, '/WhoAmI/');
		});

		after(async () => {
			await teardownHarper(ctx);
		});

		test(
			"P1: single-store real-gap fill — does the resolver's OWN pinned snapshot survive a mid-await commit on the row it hasn't read yet?",
			{ timeout: 60_000 },
			async () => {
				const gapThreadId = await setGap(GAP_MS);
				const ids = Array.from({ length: N_TRIALS }, (_, i) => `S${i}`);

				// seed slotA/slotB at gen0 for every trial entity
				for (const id of ids) {
					await putCell(id, 'slotA', 0);
					await putCell(id, 'slotB', 0);
				}

				const results: Array<{ id: string; body: SingleBody | null; status: number }> = [];
				for (const id of ids) {
					const r = await trial(
						getJSON<SingleBody>(`/SingleTableSnap/${id}`), // reads slotA(gen0), awaits GAP_MS, reads slotB
						async () => {
							await sleep(MUTATE_AT_MS); // land the mutation inside the gap, before slotB is read
							await putCell(id, 'slotB', 1); // concurrent writer: slotB gen0 -> gen1, mid-await
						}
					);
					results.push({ id, body: r.body, status: r.status });
				}

				await assertGapWorkerStillServing(gapThreadId);

				let tornCount = 0; // fill's OWN view mixes slotA gen0 with slotB gen1 (post-mutation)
				const tornSamples: Array<{ id: string; gens: unknown }> = [];
				for (const { id, body, status } of results) {
					ok(status === 200 && body, `GET /SingleTableSnap/${id} failed: ${status}`);
					if (body!.gens.slotA !== 0) throw new Error(`unexpected slotA for ${id}: ${JSON.stringify(body!.gens)}`);
					if (body!.gens.slotB !== 0) {
						tornCount++;
						if (tornSamples.length < 8) tornSamples.push({ id, gens: body!.gens });
					}
				}
				console.log(
					`[QA-596 P1] trials=${N_TRIALS} torn(fill's own slotB reflects the mid-gap commit)=${tornCount}\n` +
						`  samples: ${JSON.stringify(tornSamples)}`
				);

				// eventual convergence sanity: after TTL+settle, a fresh fill must see gen1 for both slots
				await sleep(TTL_MS + SETTLE_MS);
				const staleAfterSettle: Array<{ id: string; gens: unknown }> = [];
				for (const id of ids) {
					const r = await getJSON<SingleBody>(`/SingleTableSnap/${id}`);
					ok(r.status === 200 && r.body, `post-settle GET /SingleTableSnap/${id} failed: ${r.status}`);
					if (r.body!.gens.slotA !== 0 || r.body!.gens.slotB !== 1) staleAfterSettle.push({ id, gens: r.body!.gens });
				}
				console.log(`[QA-596 P1] unconverged after TTL+settle: ${staleAfterSettle.length}/${N_TRIALS}`);
				strictEqual(
					staleAfterSettle.length,
					0,
					`convergence sanity failed: ${JSON.stringify(staleAfterSettle.slice(0, 5))}`
				);

				// the core claim under test: single-store fills stayed on ONE pinned snapshot across the
				// real async gap, in every trial, despite the mutation landing mid-await.
				strictEqual(
					tornCount,
					0,
					`snapshot scoping did NOT survive a real async gap within one store: ${tornCount}/${N_TRIALS} fills observed ` +
						`their own slotB read reflect a commit that landed mid-await: ${JSON.stringify(tornSamples)}`
				);
			}
		);

		test(
			'P2: cross-database real-gap fill — does a resolver spanning two databases see a torn (mixed-vintage) view across a mid-await commit?',
			{ timeout: 60_000 },
			async () => {
				const gapThreadId = await setGap(GAP_MS);
				const ids = Array.from({ length: N_TRIALS }, (_, i) => `C${i}`);

				for (const id of ids) {
					await putRow('RowA', id, 0);
					await putRow('RowB', id, 0);
				}

				const results: Array<{ id: string; body: CrossBody | null; status: number }> = [];
				let debugLogged = 0;
				for (const id of ids) {
					let mutateStartedAt = 0;
					let mutateAckAt = 0;
					const r = await trial(
						getJSON<CrossBody>(`/CrossTableSnap/${id}`), // reads RowA(gen0), awaits GAP_MS, reads RowB
						async () => {
							await sleep(MUTATE_AT_MS);
							mutateStartedAt = Date.now();
							await putRow('RowB', id, 1); // concurrent writer: RowB gen0 -> gen1, mid-await, BEFORE the resolver touches RowB
							mutateAckAt = Date.now();
						}
					);
					results.push({ id, body: r.body, status: r.status });
					if (debugLogged < 5 && r.body) {
						const b = r.body as any;
						console.log(
							`[QA-596 P2 timing] id=${id} startedAt=+0 preGapAt=+${b.preGapAt - b.startedAt}ms ` +
								`mutateStartedAt=+${mutateStartedAt - b.startedAt}ms mutateAckAt=+${mutateAckAt - b.startedAt}ms ` +
								`postGapAt=+${b.postGapAt - b.startedAt}ms finishedAt=+${b.finishedAt - b.startedAt}ms genB=${b.genB}`
						);
						debugLogged++;
					}
				}

				await assertGapWorkerStillServing(gapThreadId);

				let tornCount = 0; // fill's own view: genA=0 (pre-gap snapshot) but genB=1 (post-mutation) -- mixed vintage
				const tornSamples: Array<{ id: string; genA: unknown; genB: unknown }> = [];
				let allOldCount = 0; // genA=0, genB=0 -- cross-database snapshot held despite the real gap
				for (const { id, body, status } of results) {
					ok(status === 200 && body, `GET /CrossTableSnap/${id} failed: ${status}`);
					if (body!.genA !== 0) throw new Error(`unexpected genA for ${id}: ${JSON.stringify(body)}`);
					if (body!.genB === 1) {
						tornCount++;
						if (tornSamples.length < 8) tornSamples.push({ id, genA: body!.genA, genB: body!.genB });
					} else if (body!.genB === 0) {
						allOldCount++;
					}
				}
				console.log(
					`[QA-596 P2] trials=${N_TRIALS} torn(genA=old,genB=new mid-gap commit visible)=${tornCount} ` +
						`all-old(cross-database snapshot held)=${allOldCount}\n  samples: ${JSON.stringify(tornSamples)}`
				);

				// eventual convergence sanity: not a correctness requirement under test here, just confirm
				// no hang/error and the cache eventually reflects reality.
				await sleep(TTL_MS + SETTLE_MS);
				const staleAfterSettle: Array<{ id: string; genA: unknown; genB: unknown }> = [];
				for (const id of ids) {
					const r = await getJSON<CrossBody>(`/CrossTableSnap/${id}`);
					ok(r.status === 200 && r.body, `post-settle GET /CrossTableSnap/${id} failed: ${r.status}`);
					if (r.body!.genA !== 0 || r.body!.genB !== 1)
						staleAfterSettle.push({ id, genA: r.body!.genA, genB: r.body!.genB });
				}
				console.log(`[QA-596 P2] unconverged after TTL+settle: ${staleAfterSettle.length}/${N_TRIALS}`);
				strictEqual(
					staleAfterSettle.length,
					0,
					`convergence sanity failed: ${JSON.stringify(staleAfterSettle.slice(0, 5))}`
				);

				// NOTE: no hard assertion on tornCount here. This probe exists to OBSERVE whether the
				// cross-database case breaks the single-store guarantee proven above; the observed
				// distribution (logged) is itself the finding QA-596 was asked to establish, not a
				// pass/fail gate — a torn cross-database view here is EXPECTED (by design), not a defect.
			}
		);

		test(
			'P3: two DIFFERENT tables in the SAME database — isolates whether the P2 seam is "two tables" or specifically "two databases"',
			{ timeout: 60_000 },
			async () => {
				const gapThreadId = await setGap(GAP_MS);
				const ids = Array.from({ length: N_TRIALS }, (_, i) => `T${i}`);

				for (const id of ids) {
					await putRow('RowA', id, 0);
					await putRow('RowC', id, 0);
				}

				const results: Array<{ id: string; body: TwoTableSameDbBody | null; status: number }> = [];
				for (const id of ids) {
					const r = await trial(
						getJSON<TwoTableSameDbBody>(`/TwoTableSameDbSnap/${id}`), // reads RowA(gen0), awaits GAP_MS, reads RowC
						async () => {
							await sleep(MUTATE_AT_MS);
							await putRow('RowC', id, 1); // concurrent writer: RowC gen0 -> gen1, mid-await, BEFORE the resolver touches RowC
						}
					);
					results.push({ id, body: r.body, status: r.status });
				}

				await assertGapWorkerStillServing(gapThreadId);

				let tornCount = 0;
				const tornSamples: Array<{ id: string; genA: unknown; genC: unknown }> = [];
				for (const { id, body, status } of results) {
					ok(status === 200 && body, `GET /TwoTableSameDbSnap/${id} failed: ${status}`);
					if (body!.genA !== 0) throw new Error(`unexpected genA for ${id}: ${JSON.stringify(body)}`);
					if (body!.genC !== 0) {
						tornCount++;
						if (tornSamples.length < 8) tornSamples.push({ id, genA: body!.genA, genC: body!.genC });
					}
				}
				console.log(
					`[QA-596 P3] trials=${N_TRIALS} torn(genA=old,genC=new mid-gap commit visible, same-db cross-table)=${tornCount}\n` +
						`  samples: ${JSON.stringify(tornSamples)}`
				);

				await sleep(TTL_MS + SETTLE_MS);
				const staleAfterSettle: Array<{ id: string; genA: unknown; genC: unknown }> = [];
				for (const id of ids) {
					const r = await getJSON<TwoTableSameDbBody>(`/TwoTableSameDbSnap/${id}`);
					ok(r.status === 200 && r.body, `post-settle GET /TwoTableSameDbSnap/${id} failed: ${r.status}`);
					if (r.body!.genA !== 0 || r.body!.genC !== 1)
						staleAfterSettle.push({ id, genA: r.body!.genA, genC: r.body!.genC });
				}
				console.log(`[QA-596 P3] unconverged after TTL+settle: ${staleAfterSettle.length}/${N_TRIALS}`);
				strictEqual(
					staleAfterSettle.length,
					0,
					`convergence sanity failed: ${JSON.stringify(staleAfterSettle.slice(0, 5))}`
				);

				// core claim: two tables in the SAME database share the reused-transaction snapshot just
				// like two rows in one table (P1) -- the seam found in P2 is the DATABASE boundary, not
				// the table boundary.
				strictEqual(
					tornCount,
					0,
					`snapshot scoping did NOT survive a real async gap across two same-database tables: ${tornCount}/${N_TRIALS} ` +
						`fills observed their own second-table read reflect a commit that landed mid-await: ${JSON.stringify(tornSamples)}`
				);
			}
		);
	}
);
