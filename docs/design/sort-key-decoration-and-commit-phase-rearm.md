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

| site | reads |
|---|---|
| `loadLocalRecord` from `transformToEntries` (the expected loads) | 20 |
| `getAttributeValue` (`resources/Table.ts:7357`) called from the sort comparator inside `Array.sort` | 13 |
| `transformEntryForSelect`'s "value being GC'ed, load it now" branch (`resources/Table.ts:5052`) | 7 |

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

| Axis | Candidate | Disqualifier / fact |
|---|---|---|
| Different layer | Have the cache (`lmdb-js`/`weak-lru-cache`) keep entries strong while a query holds them | The cache is process-shared with a fixed LRU budget and no notion of a query's lifetime; re-strengthening an expired entry (`entry.value = record`) would pin it outside the LRU forever (no slot to displace it from). The lifetime belongs to the ordering. |
| Deeper cause | Pin each loaded record in a `Map<entry, record>` for the lifetime of the ordering so `deref()` cannot fail | Contradicts the recorded intent at `Table.ts:4917` that records may be collected before the sort completes: an ordering over N rows would hold N records regardless of the cache's memory bound, which is the bound the weak cache exists to keep. Also still resolves the sort attribute 2·n·log n times. |
| Do less | Test-only: loosen the `< 25` bound or assert the plan via `explain` | The extra reads are a real product cost (a sort over N rows under memory pressure costs up to N·log N extra store reads plus N reloads); accept-and-detect leaves it in place. |
| **Chosen** | Decorate-sort-undecorate: resolve each entry's comparable sort keys once, at collection time, and compare those | `ordered` holds `{ entry, keys }` where `keys[i]` is `convertToComparableKeys(getAttributeValue(entry, order_i.attribute, …))` for each link of the sort chain; the comparator compares keys and never touches a record; `sortedArrayIterator` yields the entry to `transformToRecord`, whose existing "value being GC'ed" branch reloads at most once. `enqueuedEntryForNextGroup` and the `dbOrderedAttribute` grouping keep working on entries. n resolver calls instead of 2·n·log n, records stay collectable, one function changed, no new API. |

### Verification

Regression test in `query.test.js`: wrap `QueryTable.primaryStore.getEntry` so each returned
entry is a `WeakRef`-shaped object whose `deref()` answers only on its first call (a record
collected after load), run the same query, and assert the read delta is at most two per returned
record (20 loads plus at most 20 post-sort reloads). Fails on base (the comparator re-reads per
comparison, delta ≥ 53 for 20 rows), passes with the decorated sort; engine-agnostic. Existing
`< 25` assertion kept.

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
idle limit polices an application holding a transaction open, so the cascade after pre-commit work
must start with a full idle window, not the remainder the pre-commit phase happened to leave.

### Approaches considered

| Axis | Candidate | Disqualifier / fact |
|---|---|---|
| Different layer | Keep `committing` (the spare) set until the cascade has called every link's `commit()` | Overloads the pre-commit-phase concept: the spare keeps consuming `COMMIT_PHASE_GRACE` ticks and logs "waiting on pre-commit work" for an ordinary store write, and the phase's exit is inside an async `then` chain per engine (`LMDBTransaction.ts:294`, `DatabaseTransaction.ts:1302`) rather than one place. |
| Deeper cause | New chain state ("sealed") that the monitor's abort branch skips once `commit()` has been entered | Removes the bound: a stalled store commit would hold write intents forever, which the bounded grace and the idle window deliberately prevent. The re-arm keeps the bound (one full window). |
| Do less | Test-only: force the grace ticks explicitly and give the test a budget the cascade cannot outrun | Leaves the product exposure (partial commit) in place; the test would then pass by hiding the window it was written to exercise. |
| **Chosen** | `setCommitPhase(false)` re-arms every link's `timeout` to `Math.max(txnExpiration, timeoutBudget)` | One place, both engines (`DatabaseTransaction.ts:642`), bounded by one idle window, no new state. Existing behavior for a read-only chain, a source apply, or a replay is untouched (they never enter the phase or are spared indefinitely). |

### Verification

Regression test next to the existing one: same multi-store blob commit, but the head store's
commit is deferred asynchronously past the remaining window after the phase ends; asserts the
commit resolves and both stores hold the record. Fails on base with the CI trace and the partial
commit; passes with the re-arm. Engine-aware like the surrounding tests.

## Out of scope, recorded as findings

- `Unit tests: lmdb` step budget: the Node 22 leg's `test:unit:resources` under LMDB took 4 m at
  `a6c24a542` against the step's 4 m cap (sized "lmdb ~1m55-2m05"); at `75e6f766e` the step was
  killed by that cap before reaching the query suite.
