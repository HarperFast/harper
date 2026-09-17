# Two LMDB-step unit flakes on main: post-ordering re-reads after GC, and the commit cascade exposed after the pre-commit phase

Dispatch: harper main Unit Test red at `a6c24a542` (run 35279766894). Both failures are in the
`Unit tests: lmdb` step; each is a distinct product mechanism, reproduced locally, and neither is
caused by the merge at that head (harper#2661 changes one error-message string in
`components/Application.ts`). The same query failure had already hit main at `75e6f766e`
(run 35257249890) and a PR head (run 35278036424); the same monitor failure had hit a PR head
at 07:03Z (run 35192697461). Both are pre-existing intermittents. No revert is warranted.

## A. In-memory post-ordering re-reads records once per comparison after a GC

### Current behavior

`unitTests/resources/query.test.js` "Query data in a table with narrow constraint sorting on
different property" asserts `primaryStore.readCount` grows by fewer than 25 for a 20-row query
(`relatedId = 3`, sort by `name`). The planner is deterministic (verified with `explain`: the
`relatedId` index drives, `name` is post-ordered in memory), and the 20 loads are the only reads
on every local run. On the failing CI leg the test takes ~14 ms instead of <1 ms.

A forced `global.gc()` immediately before the query reproduces the failure locally
(`readCount` delta 40 and 76 on two runs). Per-call-site counts on the delta-40 run:

| site                                                                                                | reads |
| --------------------------------------------------------------------------------------------------- | ----- |
| `loadLocalRecord` from `transformToEntries` (the expected loads)                                    | 20    |
| `getAttributeValue` (`resources/Table.ts:7357`) called from the sort comparator inside `Array.sort` | 13    |
| `transformEntryForSelect`'s "value being GC'ed, load it now" branch (`resources/Table.ts:5052`)     | 7     |

Mechanism: with LMDB caching (`OpenDBIObject.ts:53`, `cache: { validated: true }`) every cached
entry is a `WeakRef` whose strong `value` is dropped when the shared LRFU expirer displaces it
(`weak-lru-cache` `insertEntry` → `EXPIRED_ENTRY`). `transformToOrderedSelect` collects such
entries into `ordered`, then sorts them; the comparator resolves each side with
`entry.deref() ?? primaryStore.getEntry(entry.key)?.value` and never stores the result, so once a
record has been collected every comparison that touches its entry is a store read — O(n log n)
reads per dead entry — and the post-sort transform reads it once more. Whether an entry is dead at
sort time depends on process-wide cache traffic and GC timing, which is why it is intermittent and
why it started showing on the Node 26 leg when CI's floating `node-version: 26` moved to 26.9.0
(newer V8 GC scheduling) on 2026-09-17. Locally on 26.2.0 and 26.9.0 the isolated file and the
full LMDB resources suite pass without the forced GC.

The collection loop already carries the intent (`resources/Table.ts:4917`): "we store the value we
will sort on, for fast sorting, and the entry so the records can be GC'ed if necessary before the
sorting is completed". The code stores only the entry; the sort value was never stored, so the
comparator resolves it on every comparison and the GC allowance turns into the re-read storm.

### Owning invariant

Ordering an in-memory result set reads each record from the store at most twice: once to load it,
and at most once more to materialize it after the sort if the cache let it go in between. The
comparator never reads the store. The ordering (Table.ts `transformToOrderedSelect`) owns its
working set; the cache cannot know about it.

### Approaches considered

| Axis                   | Candidate                                                                                                       | Disqualifier / fact                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| ---------------------- | --------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Different layer        | Have the cache (`lmdb-js`/`weak-lru-cache`) keep entries strong while a query holds them                        | The cache is process-shared with a fixed LRU budget and no notion of a query's lifetime; re-strengthening an expired entry (`entry.value = record`) would pin it outside the LRU forever (no slot to displace it from). The lifetime belongs to the ordering.                                                                                                                                                                                                                                                                                                                                                                                  |
| Deeper cause           | Pin each loaded record in a `Map<entry, record>` for the lifetime of the ordering so `deref()` cannot fail      | Contradicts the recorded intent at `Table.ts:4917` that records may be collected before the sort completes: an ordering over N rows would hold N records regardless of the cache's memory bound, which is the bound the weak cache exists to keep. Also still resolves the sort attribute 2·n·log n times.                                                                                                                                                                                                                                                                                                                                     |
| Do less                | Test-only: loosen the `< 25` bound or assert the plan via `explain`                                             | The extra reads are a real product cost (a sort over N rows under memory pressure costs up to N·log N extra store reads plus N reloads); accept-and-detect leaves it in place.                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| Higher layer (planner) | Drive the query from the sort-aligned `name` index and filter `relatedId` per row, or require a compound index  | Scans every row of the sort index instead of the narrow condition's rows (100 reads here instead of 20; the test at `query.test.js:966-978` exists to pin the opposite), and depends on schema. Recorded on the planning reviewer's request; not a fix for the ordering path.                                                                                                                                                                                                                                                                                                                                                                  |
| **Chosen**             | Decorate-sort-undecorate: resolve each entry's comparable sort keys once, at collection time, and compare those | As each entry is collected, `convertToComparableKeys(getAttributeValue(entry, clause.attribute, …))` is pushed onto one sidecar key array per sort clause; a position array is sorted by comparing those keys and yields entries to `transformToRecord`, whose existing "value being GC'ed" branch reloads at most once. Sidecar arrays rather than a `{ entry, keys }` object per row (planning review: two allocations per row on a hot path). `enqueuedEntryForNextGroup` and the `dbOrderedAttribute` grouping keep working on entries. n resolver calls instead of 2·n·log n, records stay collectable, one function changed, no new API. |

### Verification

Regression test in `query.test.js` against the real table and store, no method replaced: the 20
matching records are copied and handed to `transformToOrderedSelect` as real `WeakRef` entries
through an async source that drops its pins, crosses a macrotask boundary and calls `global.gc()`
after the last entry is collected (mocha runs with `--expose-gc`), so every record is dead by the
time the sort runs. Asserts count, the exact two-clause order (`relatedId` tie, `name` descending)
against the ordinary `search`, and that store reads stay within materialization (at most two per
row through the prefetch path). Fails on base with 96-97 reads for 20 rows on both engines; passes
with the decorated sort. Existing `< 25` assertion kept.

## B. A multi-store commit cascade is exposed to the idle limit after its pre-commit phase

### Current behavior

`unitTests/resources/txn-tracking.test.js` "keeps every multi-store link alive while the head
waits on its blob save" (LMDB, Node 22 leg) fails with
`Transaction was aborted after exceeding the maximum open-transaction time` thrown at
`LMDBTransaction.commit (LMDBTransaction.ts:132)` from the head's commit resolution
(`LMDBTransaction.ts:294`, `this.next.commit(options)`).

Sequence (`resources/LMDBTransaction.ts:167-195`): the head's pre-commit hooks (the blob file
write) run under `setCommitPhase(true)`, which spares the whole chain from the monitor while a
bounded grace is consumed. When the hooks finish, `setCommitPhase(false)` clears `committing`
on every link and the head re-enters `commit()`, whose store write is asynchronous; only in the
resolution does it call `this.next.commit()`. Each link's `timeout` is whatever remained of the
idle window at the moment the phase ended: the spare ticks re-arm it only when it reaches 0, so
the remainder is anywhere in `(0, max(txnExpiration, timeoutBudget)]`. If a monitor tick lands
while the head's store commit is in flight and the link's remainder has run out, the abort branch
(`DatabaseTransaction.ts:2290-2310`) poisons the link; the head's write has already committed and
the link's commit throws — a partial multi-store commit.

Reproduced locally: in the same test, deferring the head store's `ifVersion` by 250 ms after the
phase ends (async, so the monitor runs) yields the exact CI trace, with `timeouts=200,0`,
`timedOut=,true`, and afterwards `CommitPhaseBlobTable` holds record 2067 while
`CommitPhaseSecondaryBlobTable` does not. A 150 ms deferral passes (`timeouts=200,60`). In the
test the window is 200 ms (`timeoutBudget = 200`, 20 ms ticks) and the CI runner's blob finalize
plus LMDB commit occasionally exceeds it on the slowest leg; in production the window is the
30 s default, so the same break needs a ≥30 s head-store commit (an fsync stall), rare but not
impossible, and the outcome is the atomicity loss #1407 exists to prevent.

### Owning invariant

Once a chain enters `commit()` its write set is sealed and the caller is awaiting the commit; the
idle limit polices an application holding a transaction open. Every link therefore starts each hop
of the cascade with a full idle window of its own engine, never with the remainder the pre-commit
phase or an earlier hop happened to leave. The bound is per hop: a native commit that stalls for a
whole window still lets the monitor reap the waiting links, and this change does not add crash or
cross-store atomicity beyond what the cascade already had.

### Approaches considered

| Axis                          | Candidate                                                                                                                                                     | Disqualifier / fact                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Different layer               | Keep `committing` (the spare) set until the cascade has called every link's `commit()`                                                                        | The spare is bounded by `COMMIT_PHASE_GRACE` ticks shared by the chain, so a long cascade would exhaust it and be reaped mid-cascade anyway; and the phase's exit is inside an async `then` chain per engine (`LMDBTransaction.ts:294`, `DatabaseTransaction.ts:1302`) rather than one place.                                                                                                                                                                                                                                                                                                                                                                                                                            |
| Deeper cause                  | New chain state ("sealed") that the monitor's abort branch skips once `commit()` has been entered                                                             | Removes the bound: a stalled store commit would hold write intents forever, which the bounded grace and the idle window deliberately prevent. A per-hop re-arm keeps the bound (one full window per hop).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| Do less                       | Test-only: force the grace ticks explicitly and give the test a budget the cascade cannot outrun                                                              | Leaves the product exposure (partial commit) in place; the test would then pass by hiding the window it was written to exercise.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| One-shot re-arm at phase exit | `setCommitPhase(false)` re-arms every link once                                                                                                               | The first plan. Rejected on the planning review's fact: the links' clocks all start at phase exit while `this.next.commit()` is only reached after each predecessor's native commit settles, so three links each taking 80 ms under a 200 ms window still lose the third; and the shared base method would arm an LMDB link from the RocksDB expiration (`LMDBTransaction.ts` keeps its own, with its own test setter).                                                                                                                                                                                                                                                                                                  |
| **Chosen**                    | Engine-owned `renewIdleTimeout()` on each transaction class, and `renewChainForNativeCommit()` called by each link as it hands its sealed writes to the store | `DatabaseTransaction.commit` (before it closes the head for the native commit) and `LMDBTransaction.commit` (before the optimistic write path) renew every remaining open, unpoisoned link from that link's own engine limit. Each hop starts with a full window; a stalled native commit is still bounded by one; nothing clears `timedOut` or reopens a closed link; read-only chains, source applies and replays never reach the abort branch and are unaffected. The renewal runs only on a link's first entry into the native path with writes of its own (`!retries` / no retry-round `options.transaction`): an optimistic-conflict retry ladder keeps the window it had, and a write-free commit renews nothing. |

### Verification

Three tests next to the existing one, engine-aware like their neighbors: the LMDB class re-arms
from the LMDB expiration (base: no method); the CI shape, where the pre-commit phase is left to
decay the window to ≤150 ms and the head's native commit is then deferred 250 ms (LMDB
`ifVersion`, RocksDB `transaction.commit`), asserting every link was armed to the full 400 ms
budget at the handoff and both records committed; and a three-link cascade whose every native
commit is deferred 150 ms under a 200 ms window, which only a per-hop re-arm survives. On base
the last two fail with the CI trace on both engines.

## Code review, round 1

Kept: renewal gated to the first native entry with own writes (review: a retry ladder or the
monitor's read-only close-out would otherwise reset the window); packed position array; comments
trimmed. Overruled: resolving later sort clauses lazily on ties. Fact: the old comparator ran a
later clause's resolver twice per tie comparison with no bound in n; collection runs it exactly n
times, and a resolver that cannot evaluate a returned row is a query error in either design, only
earlier here. The `stallNativeCommit` test helper replaces a live store method; the repository rule
names `sinon`/`rewire`, and no product seam exists to defer a native commit deterministically, so
the helper stays and restores itself on first call and in `finally`.

## Planning review

`prepush-review.mjs --mode plan` (graded leg: Codex; Gemini not selected for planning) returned
`Framing-Verdict: better-alternative-exists`. Adopted: sidecar key arrays instead of one object per
row; per-hop, engine-owned re-arm instead of a one-shot re-arm at phase exit (its three-link
counter-example is the third test above); the real-`WeakRef` regression instead of a replaced store
method; the atomicity claim narrowed to one window per hop; the planner-level option recorded. The
"keep the spare through the cascade" rejection was restated on the grace bound rather than on
terminology.

## Out of scope, recorded as findings

- `Unit tests: lmdb` step budget: the Node 22 leg's `test:unit:resources` under LMDB took 4 m at
  `a6c24a542` against the step's 4 m cap (sized "lmdb ~1m55-2m05"); at `75e6f766e` the step was
  killed by that cap before reaching the query suite.
