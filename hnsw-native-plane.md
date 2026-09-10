# HNSW native traversal plane

Design for moving HNSW graph storage and traversal into a native (Rust/napi-rs) module over a
memory-mapped fixed-slot file, replacing the RocksDB index column family as the home of graph
nodes. Companion to the scaling analysis in `DESIGN.md` ("efConstruction and the search-ef
ceiling both auto-scale with the graph") and issues #693, #711, #895, #2182.

## 1. Motivation — measured, not estimated

Per-visit cost decomposition at 5M nodes / ef 512 (768-d int8, `benchmarks/hnsw-scale.js`
corpus, 22.18 ms p50 / 5,107 visits):

| Component                                   | Cost    | Share of a warm visit |
| ------------------------------------------- | ------- | --------------------- |
| Total per visited node                      | 4.34 µs | 100%                  |
| int8 asymmetric cosine, 768-d, JS           | 0.43 µs | 10%                   |
| msgpackr decode of one node (VT-cache miss) | 5.57 µs | +128% when cold       |
| Neighbour iteration + visited-set ops       | 0.21 µs | 5%                    |

~85% of a warm visit is JS object bookkeeping — candidate heap, visited `Set`, property access,
allocation, GC — not distance math and not I/O. Three consequences:

1. **A native distance kernel is worth ~nothing.** Distance is 10% of the visit; a NAPI crossing
   costs 0.1–0.5 µs. The win requires the whole search loop native, over a native data layout,
   with one boundary crossing per query.
2. **The fetch path decides the ceiling.** A warm RocksDB `Get` is ~1–2 µs even called natively
   (block-cache lookup, block parse, value memcpy) — 20–40× the SIMD distance it feeds. Direct
   slot addressing (`base + id × SLOT_SIZE`) into a resident mapping is ~100–200 ns. Traversal
   over RocksDB caps at ~3–5× improvement; traversal over a fixed-slot mapping reaches the
   full ceiling.
3. **Estimated native budget: ~0.25–0.4 µs/visit** (SIMD int8 dot ~50 ns + streaming 768
   contiguous bytes ~150 ns + bitset/heap ops ~50 ns) → **~10–15× on the search path**
   (22 ms → ~1.5–2 ms at 5M/ef 512), with the JS event loop untouched.

This is also the enabling dependency for same-node index slicing (parallel slice searches need
off-loop execution) and changes cluster QPS arithmetic by the same factor.

## 2. Goals / non-goals

Goals:

- Search traversal fully native, off the JS event loop, one NAPI crossing per query.
- Graph nodes in a memory-mapped fixed-slot file — **the file is the index**: the maintained
  primary of the derived data, updated in place on every commit, not a cache of RocksDB.
- Incremental maintenance preserved: insert/update/delete keep working exactly as today from
  the application's view.
- Relaxed transactional adherence (deliberate): HNSW results are approximate by contract, and
  the existing post-load exact rescore + MVCC record lookup already filter stale/wrong
  candidates. No cross-slot atomicity.
- Node-id reuse via an in-file freelist — structurally fixes the #2182 lifetime high-water
  ef over-provisioning.
- Slicing-ready: one file per slice; native merge of per-slice top-k (C2 hook).

Non-goals (this phase):

- Binary quantization / Matryoshka truncation (benchmark-gated per the Reflex study; the format
  reserves a quantization-mode field so a binary plane is a format v2, not a redesign).
- Native batch insertion; version 0.2.1 supplies the single-record native insert used here.
- Cross-node ANN protocol. Out of scope entirely.
- Lexical/BM25 anything.

## 3. Architecture

```
                     JS (worker threads)                    native (Rust, napi-rs)
  ┌─────────────────────────────────────────┐   ┌─────────────────────────────────────┐
  │ DerivedIndexBackend + HNSW adapter      │   │ @harperfast/hnsw 0.2.1             │
  │  • pk↔nodeId mapping       (RocksDB)    │   │  • mmap'd graph file (per index)    │
  │  • per-origin audit cursor (RocksDB)    │   │  • insert/remove (seqlocked)        │
  │  • committed-log replay + rebuild      ├──►│  • search(query, k, ef, filter) →   │
  │  • record load + exact rescore         │◄──┤    top-k ids, libuv worker pool     │
  │  • bounded keyed wake-up queues         │   │  • TSFN batch filter callback       │
  └─────────────────────────────────────────┘   └─────────────────────────────────────┘
```

What stays in RocksDB: the primary records, pk↔nodeId mappings, durable replay cursors, and all
other indexes. The mappings are post-commit derived state and are recoverable from records plus
the retained transaction log. Node vectors, per-layer adjacency, entry point, id allocator, and
freelist live only in the native file.

## 4. File format (v1)

One file per index (per slice, once C2 lands): `<index-path>.hnsw`.

**Header (4 KB page):**

| Field                             | Type       | Notes                                                        |
| --------------------------------- | ---------- | ------------------------------------------------------------ |
| magic + format version            | u32 + u32  | rebuild required on version mismatch (accepted contract)     |
| dims, quantization mode           | u16 + u8   | v1: int8 asymmetric; f32 supported for `quantization:"none"` |
| slot_size, layer0_cap, upper_cap  | u16 ×3     | derived from M/optimizeRouting at creation                   |
| entry_point_id, entry_point_level | u32 + u8   | atomically updated                                           |
| id_high_water                     | u64 atomic | replaces the shared Atomics BigInt64Array incrementer        |
| freelist_head                     | u64 atomic | CAS push/pop; ABA-guarded with a 32-bit tag                  |
| txn_watermark                     | u64        | last durably indexed transaction; advanced by msync cadence  |
| clean_shutdown flag               | u8         | torn-state detection on open                                 |

**Main region — layer-0 slots**, addressed `4096 + id × slot_size`:

| Field                           | Size (768-d int8, cap 64)           |
| ------------------------------- | ----------------------------------- |
| seq (seqlock)                   | 4 B                                 |
| flags (valid/deleted) + level   | 2 B                                 |
| scale (f32) + invMag (f32)      | 8 B                                 |
| degree                          | 2 B                                 |
| vector (int8 × 768)             | 768 B (padded to a 4-byte boundary) |
| neighbor ids (u32 × layer0_cap) | 256 B                               |
| **total, padded**               | **1,040 B → 1 KB-aligned 1,088 B**  |

The vector's trailing pad keeps the neighbor array 4-aligned for every `dims`, so the search
hot path reads each neighbor id as one aligned volatile `u32`. Upper-layer id lists are padded
the same way (`degree u16 + pad u16 + ids`).

At 100M nodes: ~109 GB (int8). A binary-code v2 slot (96 B codes + ids) is ~384 B → ~38 GB.
For comparison, today's encoding averages 1,425 B/node _plus_ RocksDB overhead — so v1 is
already ~25% smaller while being fixed-offset addressable, because per-edge cached float64
distances are dropped (recomputing a distance costs ~50 ns native; storing it costs 8 B and
~40% of today's node bytes).

**Upper-layer region** (append-allocated, compacted on rebuild): only ~6% of nodes have
level > 0, and upper layers hold neighbor id lists only (vectors live in the main slot). Each
entry: `node_id, level, [degree, ids × upper_cap] × level`. Kept fully resident; a few hundred
MB at 100M nodes.

**Degree cap decision.** Today layer-0 caps at `M<<1` then `<<2` under `optimizeRouting` = 128,
with transient overshoot to 160 before pruning; measured mean degree is ~37. Sizing slots at
cap 128 doubles the file for a tail. v1 policy: **hard prune-to-cap-64 on write** — the insert
path's in-memory candidate selection can overshoot as today, but what is written is pruned to
64 by the same routing-aware selection that currently prunes at 160→128. Transient overshoot
never touches the file. Recall impact must be measured in the validation phase (§9); the cap is
a header field, so revising it is a rebuild, not a format change.

## 5. Concurrency

- **Per-slot lock with owner identity.** The lock word is a u32: bit 31 = locked, low bits =
  the owner's pid; unlocked values are generations, validated seqlock-style by readers. A lock
  whose value stays unchanged for a 20 ms window AND whose owner pid is dead (ESRCH) is taken
  over by the waiter, which SANITIZES the slot (marks it invalid — a dead writer's payload is
  half-written; invisible-until-rewritten, never spliced-but-valid). Elapsed time alone never
  robs a lock: a live writer descheduled by CFS throttling or a page-fault storm keeps its
  lock until rescheduled. On platforms without a liveness check, readers degrade to
  treat-as-absent after the window and writers wait.
- **No cross-slot atomicity.** An insert updates the new node's slot plus ~M neighbors'
  back-edge lists, each independently. A traversal may observe the half-linked state: an edge
  to a slot whose valid flag is not yet set → skip (HNSW tolerates missing edges); a
  just-deleted neighbor → skip via flags. Wrong-candidate leakage is filtered by the existing
  exact rescore + MVCC record load, which is why relaxed adherence is safe _here_ and not a
  general storage pattern.
- **Writers.** Multiple worker threads insert concurrently today (distinct records); the same
  holds: id allocation is one atomic fetch_add on the header, freelist pop is CAS, slot writes
  are seqlocked. Two inserts updating the same neighbor's edge list serialize on that slot's
  seqlock (a Rust-side per-slot spinlock on the odd state).
- **Id reuse & ABA.** Delete pushes the id onto the freelist; a traversal holding the old id may
  read the reused slot and score the wrong vector — acceptable under the relaxed contract
  (rescore/record-load rejects it). The freelist head itself is tag-guarded against ABA.

## 6. Durability & crash recovery

The file is `msync`'d on a cadence (default: every N seconds or M mutated slots, configurable),
**not** per commit. The header watermark records the last transaction whose index mutations are
known durable; it advances only after a completed msync barrier.

On open:

- Clean-shutdown flag set → map and serve.
- Torn state → replay records from `txn_watermark` through the existing `runIndexing` re-feed
  path (which already treats a re-fed already-indexed record as an update — the exact semantics
  needed). This anchors today's heuristic crash re-feed to a precise watermark.
- Format-version mismatch or corruption (header checksum) → full rebuild from records. Explicit
  contract: **format upgrades require reindex** (accepted).

Note the asymmetry with today: RocksDB gave the graph per-commit durability; the file gives it
bounded-lag durability with deterministic catch-up. For an approximate index whose source of
truth (records + pk→nodeId) remains fully transactional, bounded lag is the right trade — it
buys the entire performance model.

**Backup/copy-db/reseed:** the file is node-local derived state. Backup either includes it
(consistent-enough after an msync barrier) or marks the index rebuild-on-restore. Replica
reseed = rebuild from records (C5 bulk construction makes this fast; until then, the existing
per-row path).

## 7. Search path & NAPI surface

```ts
// one crossing per query; executes on the module's own thread pool
search(sliceHandles, queryVector: Float32Array, k, ef, filter?): Promise<{ids, distances}>
```

- Asymmetric distance as today: float query × int8 stored, cached invMag, SIMD (AVX2/VNNI on
  x86, NEON on ARM; `std::arch` intrinsics with a scalar fallback).
- Visited set: epoch-stamped u32 array (one per pool thread, reused across queries — no
  allocation per query). Candidate heap: fixed-capacity binary heap of (dist, id) pairs.
- Auto-ef / auto-efC read the node count from the header high-water minus freelist length —
  same semantics as today, minus the #2182 inflation (freed ids return to the pool).

**Filtering** (predicate-aware / ACORN, `filteredSearch = true` today):

1. **Bitset fast path.** RBAC allow-lists and companion-condition candidate sets are computed
   before the query and passed as a roaring/plain bitset over node ids. Zero callbacks. This
   covers the dominant production filter shapes.
2. **Pipelined TSFN batch path** for arbitrary JS predicates. Traversal batches candidate ids
   (64–256) through a ThreadsafeFunction to a JS evaluator and **continues expanding in
   distance order while verdicts are in flight**; verdicts merge in to steer selection and
   gate results. The existing `filterExpansion` visit budget bounds speculative overshoot.
   Traversal never blocks on the event loop — that would re-import the p99 problem this
   design exists to remove. Worst case (loop saturated): budget exhausts, return what passed —
   the same contract as today's budget-bound filtered search.
3. TSFN lifecycle: shutdown-while-query-in-flight is a first-class test (see rocksdb-js #665's
   TSFN teardown SIGSEGV). napi-rs `ThreadsafeFunction` + explicit abort on env teardown.

## 8. Write path phasing

- **Phase 1 prototype — dual-write, search cutover (superseded before merge).** Insert/update/delete logic stayed in JS
  (`HierarchicalNavigableSmallWorld.ts` unchanged algorithmically); mutations persist to BOTH
  the index CF (as today) and the file via native slot-write calls. Search runs native from the
  file. Validation = compare native results against the JS path on the same graph; rollback =
  flip search back to JS, drop the file. The double-write cost is bounded (index writes are
  a fraction of insert cost) and temporary.

  This implementation was removed when phase 2 landed on the same draft PR. It never shipped, so
  the PR has no deployed dual-write format to preserve or migrate in place.

- **Phase 2 — shared post-commit delivery, file-primary (current implementation).** Implement #2489's
  `DerivedIndexBackend` runtime rather than an HNSW-specific commit callback. This remains opt-in
  behind `nativePlane: true`; ordinary HNSW indexes keep the RocksDB graph and do not acquire an
  audit dependency. A table with an opted-in backend must explicitly declare `audit: true`; inheriting
  either true or false from the global setting is rejected so a vector-index option cannot silently
  expand the audit-readable security surface. Auditing adds a durable full-record audit entry to
  every commit on the table, including commits that do not change the vector, for the configured
  retention window. This storage and data-retention cost is part of opting in.
  Enablement warns that the audit API can now expose full table history for that window.

  The commit path only validates: `prepareCommitted` compares the old and new projection and, when
  they differ, rejects a malformed vector as the client's 400. Nothing is staged on the transaction
  and there is no `aftercommit` listener; the shared `DerivedIndexRuntime`
  (`resources/derivedIndexRuntime.ts`) reads the committed transaction log, resolves each changed
  record once against the primary store, projects the vector, and delivers batches to
  `HnswDerivedIndexBackend` (`resources/indexes/hnswDerivedIndex.ts`). The batch's `records` view is
  last-write-wins per key, so rapid updates to one key cost one native insert per delivery window.
  Writer backpressure is the runtime's opt-in lag policy: a table whose index is further behind than
  `maxLagMilliseconds` (30 s by default for a `nativePlane` index, settable on the attribute) fails
  local user writes with a retryable 503 (`DERIVED_INDEX_LAGGING`) until the owner has proven
  catch-up; canonical-source applies, replay and replication notifications are never shed. This
  admission control is required because accepting unique-key load above native insert throughput and
  then rebuilding at that same throughput cannot converge.

  The backend queues each delivered batch and applies it in 5 ms slices off `setImmediate`; the
  runtime requests barriers by age (1 s) and by accepted work, and the backend answers a request once
  its queue is empty: `plane.flushAsync()`, then the pending mappings are published, then the batch's
  `through` vector is written as the one durable cursor (`Symbol.for('derived-index-cursor')` in the
  index CF). Application pauses while a barrier is in flight so the barrier publishes exactly the
  mappings it covers. If applying an entry fails, the backend drops its queue and reports `'failed'`;
  the runtime condemns the generation, publishes `rebuilding`, quiesces the epoch, calls
  `reset(epoch)` — which removes the cursor first, then the plane file, then the mappings — scans the
  primary records, and replays from the committed tail captured before the scan. Persistent rebuild
  failures retry with capped exponential backoff (1 second through 5 minutes) and park the index
  `unavailable` after eight attempts.

  The cursor vector covers every origin log and advances only after the durability barrier. On
  open, a cursor the log can no longer resolve exactly causes a full rebuild; replay never advances
  across a retained gap or a corrupt frame. A whole-table reload marker (used by replica snapshot copy)
  also forces a rebuild because its copied rows deliberately have no individual audit entries. The
  default retention means a node unavailable beyond that window takes the
  measured rebuild path and returns 503 for its duration. Operators can size retention for the
  expected outage, but correctness does not depend on doing so: expiry changes recovery cost, not
  outcome. During replay or rebuild,
  searches return the existing index-in-progress 503 rather than reading a partial file. Cleanup
  may delete old segments; the recovery contract is rebuild rather than pinning audit indefinitely.

  HNSW uses the package's standalone `insert`/`remove` API. The RocksDB index CF retains only
  `primaryKey ↔ nativeNodeId` identity and the cursor vector; graph nodes and adjacency
  exist only in the mmap file. A changed mapping is marked pending, hidden from search, and published
  only after the mmap flush succeeds; the cursor advances after the mapping publication. A crash can
  therefore leave replay extra work, but cannot leave a published mapping to an undurable node.
  Hot delivery and replay both re-read the current authoritative record
  after commit. This gives multi-origin/source-resolution writes the same reconciliation rule and
  makes an old entry idempotent as "delete current native id, then add the current value". The
  audit object's in-memory record is an allowed optimization only when its version is still the
  primary store's current version. Rebuild captures the committed tail of each log, scans current
  records into a fresh file, and replays from those tails before the index becomes queryable (§13.6
  is why the tail is safe). Existing phase-1 graph CFs are migrated by this rebuild.

  The current package fixes standalone construction at M=16, efConstruction=200, mL=1/ln(16),
  and optimizeRouting=0.5, so file-primary mode accepts only that geometry. Its sparse reservation
  is fixed at create time; `nativePlaneMaxNodes` is therefore a structural option (16M default),
  and exhaustion makes the index unavailable until it is enlarged and rebuilt. The native file
  is an approximate derived index: concurrent CRDT/source-resolution arrivals are not promised to
  reproduce a single total order. Exact record load and rescore still reject stale candidates.
  A crash between native allocation and identity persistence can leave an unreachable native node;
  replay restores the live record and exact filtering hides the orphan, while rebuild reclaims it.
  A schema requesting `nativePlane: true` with non-native construction geometry is rejected rather
  than silently changing M/efConstruction/mL/optimizeRouting during upgrade.

  Phase 1 has not shipped: this PR is draft, so no deployed index is silently migrated from its
  configurable JS geometry. Version 0.2.1 already implements the insertion search and graph mutation
  inside the native `insert()` call; phase 2 uses that path for rebuild as well as incremental writes,
  rather than the ~263 inserts/s JS anchor. The native CI job runs a gated 100k-record rebuild-insertion
  benchmark, publishes progress (records, rate, ETA), and requires at least 1,000 inserts/s. The local
  verification for this revision sustained 4,625 inserts/s at 100k including mapping writes and flush
  barriers. That gate is a regression floor at 100k, not a rebuild-duration guarantee: insert rate falls
  as the graph grows (8,482/s at 30k → 4,625/s at 100k here; §12's crate anchor is 1,242/s at 1M), and
  nothing above 1M is measured. A 16M rebuild is therefore at least ~3.6 hours at the 1M rate and in
  practice longer, so a deployment sizing above the default reservation is accepting a 503 recovery
  window of that order until a batch API exists.
  Worker shutdown is graceful and waits for a synchronous N-API insert to return; a worker is never
  force-terminated in the middle of a plane mutation while the process survives.

- **Phase 3 — native batch insert.** Add a bulk API so rebuild can cross N-API once per chunk and
  report progress while native code owns the insertion loop. Single-record insertion search and
  graph mutation already run natively in 0.2.1.

### What `nativePlane: true` requires, and what it does not promise

Removing the RocksDB graph moves several phase-1 conveniences into hard requirements. All of them
are enforced or surfaced in code, not left as advice.

| Requirement                                                                                                                                                                                                                                     | Enforcement                                                                                                                                                                                           |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| The table declares `audit: true` explicitly. Inheriting either value from the global setting is rejected, so a vector-index option cannot silently widen the audit-readable surface.                                                            | `resources/databases.ts` `table()` and `attachDerivedIndexBackends()` both throw a `ClientError`; enabling one logs once that the audit API now retains full record history for the retention window. |
| The RocksDB storage engine.                                                                                                                                                                                                                     | `ClientError` at index construction.                                                                                                                                                                  |
| `M=16`, `efConstruction=200`, `mL=1/ln(16)`, `optimizeRouting=0.5`, int8-quantized cosine. Standalone `insert` in 0.2.1 fixes this geometry, so a schema asking for another one is rejected rather than silently rebuilt under native defaults. | `ClientError` at index construction.                                                                                                                                                                  |
| `nativePlaneMaxNodes` (16M default) is structural — the sparse reservation is fixed at file create. Exhausting it makes the index unavailable until the value is raised and the index rebuilt.                                                  | Reservation is a create-time header field; growth is a possible later enhancement (§10).                                                                                                              |
| `@harperfast/hnsw` must load on the platform. There is no JS graph to fall back to, so an absent or failing native module means the index is unavailable, not degraded.                                                                         | Search returns 503; delivery throws a 503 `ServerError`. Ordinary HNSW indexes are unaffected.                                                                                                        |
| The audit log must retain entries back to each origin cursor. A cursor before retention, a corrupt frame, or a whole-table reload marker forces a full rebuild from current records.                                                            | Detected in `reconcile`/`replay`; the index reports 503 for the rebuild's duration.                                                                                                                   |
| Vector-changing writes are admissible only while the shared backlog is under its bound.                                                                                                                                                         | The pre-commit hook returns a retryable 503 once the aggregate pending-key or log-position depth reaches its threshold; unrelated writes continue.                                                    |

Not promised:

- **A single total order across concurrent CRDT or source-resolution arrivals.** Hot delivery and
  replay both re-read the current authoritative record, so the index converges on whatever the
  primary store resolved, but two origins landing concurrently are not promised to produce the
  index state a single serial order would. This is an approximate nearest-neighbour index and the
  exact record load plus rescore on the read path already rejects stale candidates, so the
  divergence is bounded by candidate selection, not by returned data.
- **Byte-identical graphs across nodes or across rebuilds.** Insertion order and the concurrent
  prune both affect edge selection; only recall is held to a baseline (§9).
- **In-place format upgrades.** A plane whose format version does not match is rejected at open
  and reindexed (§4).

### Approaches considered for phase 2

**Chosen: transaction log plus rebuild on retention gap.** Correctness: record and audit entry
commit atomically; post-commit work cannot leak an aborted write; per-origin cursors advance after
the plane flush; retained gaps force rebuild; replay reconciles against current records. Performance:
the record transaction adds no marker or mmap work, but opting in does add the required audit-log
write to every table commit; projection comparison prevents unrelated commits from reaching HNSW,
rapid same-key changes coalesce, and changed-vector writes are admitted only while the bounded queue
has capacity. The commit hook only schedules work and the backend batches its durability barrier.
Operational complexity: it reuses Harper's existing audit log,
aftercommit stream, retention setting, and rebuild path. Scope: the runtime and interface are shared
with future Tantivy work, while this PR supplies only the HNSW backend.

**Rejected: transactional dirty-key outbox.** Correctness is attractive because a marker cannot be
lost to audit retention and current-state reconciliation is naturally idempotent. It adds a second
durable delivery fact beside the transaction log, however, plus marker fencing, reclamation, and a
write to every indexed record transaction. That contradicts #2489's single protocol and raises hot
write amplification for every backend.

**Rejected: keep the phase-1 CF graph as authority.** This preserves rollback and package fallback
and makes native state disposable. It retains the duplicate graph writes and graph decode/storage
cost this phase exists to remove, so write throughput and storage continue to scale with two graphs.

**Rejected: ship post-commit delivery first and retain the CF graph until a later cutover.** This is
the safer rollout when phase 1 is already deployed, but phase 1 exists only on this draft PR and has
no production population to protect. The 0.2.1 dependency already moved insertion native, and the
opt-in flag plus 503-during-build behavior remains the rollout gate. Shipping another temporary disk
format would add a migration and prolong the duplicate graph cost without gathering compatibility
evidence from any existing deployment. File-primary therefore lands before this PR's first merge.

**Rejected: synchronous native mutation inside the record transaction.** This removes the CF graph
with little new runtime code. An aborted transaction can still publish an mmap mutation, and native
construction remains on request latency. Recovery then needs the same log protocol anyway.

**Rejected: build on `transactionBroadcast`'s subscription registry.** That module supplies the
scheduling and transaction-grouping precedent, but its cursors are live-subscription state
(`lastTxnTime` and one shared thread-local position), not durable per derived index and origin. Its
same-thread Rocks path also drains synchronously while holding `thread-local-writes`, so it cannot
contain an async native durability barrier. Adapting it would couple client-subscription lifetime to
index availability and still require the cursor, queue bound, gap detection, and rebuild machinery.
The derived runtime therefore subscribes directly to the same lower-level `aftercommit` event.

**Chosen for overload: coalesce by key, then admission-control unique work.** Applying every
intermediate vector wastes construction work because delivery always reconciles against current
primary state. A bounded keyed queue replaces pending work for the same key while retaining ordered
position tickets for cursor-prefix accounting. Per-key rate limiting is unnecessary after coalescing;
serving the removed CF graph would reintroduce dual storage and cannot include new keys. If distinct
keys or tickets still fill the queue, accepting an unbounded deficit violates eventual convergence
and dropping work forces rebuild at the same inadequate rate, so the pre-commit hook returns a
retryable 503 before that vector-changing record commits. This couples that record to its declared
index, as ordinary transactional indexes already do, while unrelated writes remain independent.

## 9. Validation plan

Baselines exist in `benchmarks/hnsw-scale.js` output (1M/2M/5M anchors, e.g. 1M efC-200:
p50 7.2 ms / recall@10-set 0.997 @ ef 512). Acceptance for phase 1:

1. **Parity:** native search over a dual-written graph returns identical candidate sets to the
   JS path at equal ef (modulo seqlock-retry races under concurrent write load — measured as a
   bounded divergence rate, not exact equality under churn).
2. **Recall:** cap-64 prune vs cap-128 measured at 1M and 5M; accept if recall@10 delta ≤ 0.5 pt
   at equal ef, else revisit the cap (header field — rebuild, not redesign).
3. **Latency:** ≥8× p50 improvement at 5M/ef 512 (22.2 ms → ≤2.8 ms), p99 within 2× p50 under
   concurrent insert load (the metric that motivates off-loop execution).
4. **Crash:** kill -9 during sustained ingest → reopen → watermark replay → graph passes
   connectivity + recall checks (extend the #1712 repair test harness).
5. **Churn:** delete/reinsert cycles hold node count stable (freelist reuse; #2182 regression
   test).

Phase-2 acceptance:

1. An aborted record transaction produces no native mutation; committed insert/update/delete reaches
   native search only after `aftercommit`.
2. An opted-in table without an explicit `audit: true` is rejected, while an ordinary HNSW index
   keeps inheriting the global audit setting. The schema error explains that the audit API retains
   full table history for the configured window.
3. Restart replays retained entries from each origin cursor; a cursor before retention rebuilds and
   search stays unavailable until publication.
4. Concurrent multi-origin delivery re-reads the winning primary record, independent of delivery
   order.
5. An unrelated-attribute commit schedules zero plane operations. Repeated writes to one key
   coalesce while retaining a correct contiguous cursor; saturating with distinct keys rejects a
   changed-vector write with a retryable 503 before commit and still permits an unrelated write.
6. A forced apply/flush failure retains the earlier cursor, produces no unhandled rejection, logs
   once for that episode, marks the index unavailable, and converges by rebuild.
7. A full rebuild and retained-log replay both meet the same recall@k baseline as a from-scratch JS
   graph on the same deterministic corpus; duplicate and deleted ids are absent from returned keys.
8. A non-default M/efConstruction/mL/optimizeRouting with `nativePlane: true` is rejected during
   schema setup, not silently rebuilt under native defaults.
9. CI's existing `HNSW native plane` job installs 0.2.1 and runs a separate load probe before mocha;
   absence already fails the job instead of producing a skipped green suite (verified on 87e0fd71).
10. Two rapid updates to one key across workers cannot apply in reverse version order, and graceful
    worker recycle waits until an in-flight native mutation has returned.
11. The gated 100k-record native rebuild benchmark reports progress and enforces at least 1,000
    inserts/s in the Linux native-plane CI job.
12. A soak combines concurrent search, queue admission, retry, and restart during delivery; after
    recovery its result quality meets the same deterministic recall baseline.

## 10. Decisions & open questions

Decided (Kris, 2026-08-31):

- **Degree cap: 128 for the int8 plane** (revised 2026-08-31 after measurement). The original
  cap-64 preference assumed 128 doubles the file; it does not for int8 slots — the 768 B vector
  dominates, so 128 costs +23.5% (1,344 vs 1,088 B slots). Measured at 1M: cap-64 loses 2.2 pts
  of recall (0.975 vs 0.996, where JS = 0.997) at equal ef and equal latency. +24% bytes for
  full recall parity is the right trade. The cap stays a header field; the **binary-code v2
  plane reopens the question** (cap-64 ≈ 352 B vs cap-128 ≈ 608 B slots, +73% — there a
  diversity-preserving prune at lower cap is worth engineering).
- **Platform policy.** Performance is a Linux target only. macOS must work (mmap/msync semantics
  differ — msync alone is a weaker barrier there; an `F_FULLFSYNC` pass is a known follow-up,
  and sparse-file behavior varies by filesystem — functional, not optimized). Windows is supported
  through the package prebuild. If the optional native package is unavailable on any platform,
  `nativePlane` indexes stay unavailable; ordinary HNSW indexes continue to use the JS implementation.
- **Packaging: independent open-source package.** The core has zero Harper coupling — the crate
  compiles standalone and its NAPI surface is generic (create/open plane, insert(vector),
  remove(id), search(query, k, ef, filter), watermark get/set). Harper-specific glue — the
  pk→nodeId mapping, #2489's `DerivedIndexBackend` delivery, txnlog-anchored replay, auto-ef
  policy constants — stays in Harper regardless of packaging. Published as the exact-pinned
  optional dependency `@harperfast/hnsw` 0.2.1 (Apache-2.0, HarperFast/hnsw), with platform
  prebuilds and a source-build fallback; the Harper adapter owns availability and integration
  policy. The pitch as a community package: a persistent,
  incrementally-maintained, concurrently-searchable HNSW for Node — hnswlib-node has no durable
  incremental persistence, no off-loop batched filtering, no seqlock concurrency.

Open:

- **Atomic slot payloads.** Fields a concurrent reader acts on (flags, level, degree, scale,
  invMag, neighbor and upper ids) are read through aligned `read_volatile`, which forbids the
  reload/split/sink across the seqlock's validating fence that `lto = true, codegen-units = 1`
  otherwise licenses. That is not the same as being race-free under Rust's memory model: only
  making those fields `AtomicU8`/`AtomicU16`/`AtomicU32` in the slot layout would be, and that
  is a format change deferred past phase 1. The stored vector stays an ordinary load on
  purpose — `cosine_int8_raw` must keep autovectorizing, and a torn vector only perturbs a
  distance the generation check discards.
- **msync cadence default** — bounded-lag durability window vs write amplification; needs a
  workload measurement, not a guess.
- ~~Workers have no shared readiness signal during reconstruction~~ — closed by the shared
  runtime: the owner publishes `ready` / `rebuilding` / `needs-rebuild` / `unavailable` in one
  shared buffer per index, `planeSearchReady()` reads it on every worker, and only the owner's
  `reset(epoch)` destroys native state. A search failure on a non-owning worker detaches and
  requests a rebuild; it no longer unlinks the file.
- ~~A new origin's first local write forces a full rebuild~~ — closed: a log without a cursor is
  read from its beginning as long as it still retains it.
- **An interior corrupt audit frame stops replay.** The runtime fails the attempt closed when a
  log cannot be read to its committed tail. A log that is corrupt inside its committed prefix
  cannot be replayed from any anchor, so this is the honest outcome rather than a loop that
  hides it; recovery is retention removing the frame.
- ~~Replay does not coalesce native mutations for one key~~ — closed by the runtime's `records`
  view, which resolves each key once after its last occurrence in the batch (the ingest bench's
  repeated-key shape now measures 265 native applies for 1,000 commits over 50 keys).
- ~~An undecodable audit header is skipped, not escalated~~ — closed: the runtime fails closed on
  an undecodable entry and condemns the generation.
- ~~Rebuild replays the whole retained log~~ — closed: the runtime anchors at the committed tail
  captured before the scan (§13.6).
- **f32 (quantization:"none") slot variant** — 3,072 B vectors → 3.4 KB slots; supported by the
  format (dims × mode in header) but int8 is the default and the optimization target.
- ~~Upper-layer region persistence~~ — done (format v2): fixed-entry region in the same file,
  per-entry seqlocks, reserved for max_nodes/8. Upper entries leak on delete (bounded by the
  2x-headroom reserve); an upper freelist is the remaining nicety.
- ~~Reservation growth~~ — decided (Kris, 2026-08-31): a generous sparse reservation at create
  is the model; mremap-based growth is a possible later enhancement, not a requirement.

## 11. Phase-1 findings resolved by phase 2

The phase-1 review found two integration constraints. Phase 2 resolves the first and retains the
second as part of the custom-index search contract:

- **Pre-commit mmap writes:** resolved. The commit path only validates; native mutation is driven
  by the shared runtime from the committed transaction log, and abort coverage verifies that no
  node is allocated for a rolled-back record write.
- **The async custom-index search contract** (`resources/search.ts`): a plane-backed search
  returns a promise-backed, async-only iterable; synchronous consumers of custom-index
  results would throw. Harper's search paths tolerate MaybePromise, and one full-stack test
  covers the async path; widening coverage of other consumers is follow-up.

## 12. Prototype measurements (kzyp Linux box, 768-d int8, ef 512, cap 64)

Gaussian-mixture corpus matching `benchmarks/hnsw-scale.js` calibration (intra-cos 0.75,
clusters = N/500). JS baseline for scale: 4.34 µs/visit; 1M efC-200 anchor: p50 7.2 ms,
recall@10-set 0.997, ~3,110 visits.

| N                   | cap | p50     | p95     | visits/query | µs/visit | recall@10 (set) | build rate      |
| ------------------- | --- | ------- | ------- | ------------ | -------- | --------------- | --------------- |
| 100K                | 64  | 0.28 ms | 0.46 ms | 1,395        | 0.201    | 1.000           | 5,583 inserts/s |
| 1M                  | 64  | 0.81 ms | 1.60 ms | 2,279        | 0.353    | 0.975           | 1,670 inserts/s |
| 1M                  | 128 | 0.75 ms | 1.48 ms | 2,309        | 0.324    | **0.996**       | 1,242 inserts/s |
| 1M (fmt v2)         | 128 | 0.83 ms | 1.61 ms | 2,309        | 0.359    | 0.996           | 1,346 inserts/s |
| 1M (coverage prune) | 128 | 0.75 ms | 1.52 ms | 2,279        | 0.327    | **0.999**       | 1,359 inserts/s |

Concurrency (same 1M graph): **6,345 QPS aggregate** across 8 searcher threads (p50 1.03 ms,
worst-thread p99 3.84 ms) while a background writer sustained **1,102 inserts/s** — the QPS
input §9 of the Reflex study lacked. Reverse-edge overflow eviction is coverage-aware
(evict the far member provably reachable via a kept nearer one; bounded 16×16 checks): the
concurrent torture test caught closest-keep eviction orphaning nodes in near-duplicate
clusters (~1-in-4 runs), and the fix also raised 1M recall from 0.996 to 0.999 at equal
build cost.
| 1M JS anchor | 128 | 7.2 ms | 12.0 ms | ~3,110 | 4.34 | 0.997 | ~263 inserts/s |

At the 1M anchor with cap 128: **9.6× p50, 12.9× per-visit, 4.7× build rate, at JS-equal
recall.** The µs/visit rise from 100K (0.20) to 1M (0.32–0.35) is the working set leaving L3 —
the memory-hierarchy term; it is the number that holds at 60–100M. An ef-1024 sweep on a
reopened cap-64 plane without its hierarchy (pre-sidecar) still reached 0.985 at p50 2.47 ms —
layer-0 beam is robust to a missing hierarchy, at ~3.4× the visits.

Milestones: zero-copy seqlock reads + AVX2 kernels took per-visit cost from 0.440 µs (first
scalar prototype) to ~0.1–0.35 µs, beating the 0.25–0.4 µs design budget. The
optimizeRouting-parity insert (including the recomputed neighbor↔neighbor distances) restored
recall from 0.49 (placeholder insert) to JS parity. Uniform-random 768-d corpora produce
meaningless recall numbers (the JS benchmark's own calibration note: a corpus "no ANN can
index") — all comparisons use the mixture corpus.

## 13. Convergence onto the shared derived-index runtime (#2533 / #2535)

[#2533](https://github.com/HarperFast/harper/pull/2533) implements #2489's shared transaction-log
runtime (`resources/derivedIndexRuntime.ts`); [#2535](https://github.com/HarperFast/harper/pull/2535)
is stacked on it and adds a RocksDB storage adapter for native derived indexes.
`resources/DerivedIndexBackend.ts` on this branch is a second, HNSW-shaped implementation of the
same protocol. One runtime is kept — #2533's — and HNSW becomes a backend on it.

### 13.1 What the measurements decide

`unitTests/resources/hnswDerivedIngest.bench.js` runs a real audited table with a file-primary
HNSW index through three shapes. Measured at 384 dimensions, `@harperfast/hnsw` 0.2.1, one worker:

| shape                                        | graph ≈3,000                    | graph ≈25,000                   |
| -------------------------------------------- | ------------------------------- | ------------------------------- |
| foreground `put`                             | 0.320 ms (3,125/s), p99 10.1 ms | 0.509 ms (1,964/s), p99 17.0 ms |
| `applyDerivedValue`                          | 0.214 ms/call                   | 0.389 ms/call                   |
| `flushDerived`                               | 3.59 ms × 50 calls              | 4.18 ms × 129 calls             |
| backend share of the write-and-index wall    | 66.9–94.9% of 641 ms            | 76.2–97.2% of 2,554 ms          |
| end-to-end indexed rate                      | 3,121/s                         | 1,957/s                         |
| event loop, max/p99 **while writing**        | 19.9 / 18.0 ms                  | 31.9 / 25.7 ms                  |
| event loop, max/p99 **while draining alone** | 0.0 / 0.0 ms                    | 2.6 / 2.6 ms                    |
| serialized single writes                     | 4.97 ms/record, ≤88.8% barrier  | 4.05 ms/record, ≤79.1% barrier  |
| 50 keys × 20 rounds: repeated `apply` calls  | 95%                             | 95%                             |

Package cost in isolation (N = 10,000): insert 208 µs (128-d) / 315 µs (384-d) / 835 µs (1536-d);
update (remove + insert) 287 / 468 / 1,399 µs. `flushAsync` scales with the **dirty set**, not with
index size, and has a floor: after a single insert it costs 2.3 / 3.4 / 4.3 ms, and after 10,000
inserts at 384-d it costs 181.7 ms — 3.4 ms per record against 18 µs per record, a ~190× spread
that is the whole case for a cadence.

What the instrumentation does and does not separate: the meter wraps whole backend methods, so
`applyDerivedValue` carries the vector hash and the RocksDB mapping writes as well as the native
insert, and `flushDerived` carries publishing those mappings as well as the msync. Those rows
therefore bound the _backend's_ share, not the native share; the isolated package numbers above are
what establish the native term inside it. The backend-share row is a range for a second reason:
`applyDerivedValue` is synchronous, so its time is exact and is the floor, while `flushDerived` is
timed across an `await` and so charges the backend for anything the loop ran during the barrier —
the ceiling. The serialized row's barrier share is bounded the same way, for the same reason. Two
rows also measure less than they look like:

- The serialized row awaits full drain between writes, so nothing is available to combine. It
  bounds the cost of one isolated write — one barrier per record, ~80–90% of it — and does **not**
  measure what a flush cadence could amortize. Arrivals paced independently of the drain are the
  missing experiment.
- The 95% is repeated keys across the whole run, not within one delivery window. Batch coalescing
  removes only the repeats that land in the same batch, so 95% is the ceiling, not the saving.

Three conclusions do hold.

1. **Per-transaction bookkeeping is not what decides HNSW throughput.** The backend's synchronous
   apply alone is 67–76% of the wall clock of a write-and-index cycle, and adding the barrier's
   wall-clock time — an over-count, since it spans an await — reaches 95–97%. Even at the floor,
   everything else, foreground write work and runtime bookkeeping together, has at most a third of
   the wall to share. The concern that #2533's collect/resolve
   path is less optimized than this branch's is real in the small but cannot pay for a second
   runtime: both implementations decode the same log entries and read the same authoritative
   record.
2. **This branch forces a barrier per drain; #2533 permits amortization but does not schedule it.**
   `replay()` awaits `flushDerived()` at every origin's final cursor advance. #2533 separates
   _offered_ from _durable_ progress and lets a backend accept up to `maxAcceptedBatchesAhead`
   batches before its barrier — but that is a ceiling, not a scheduler. A backend that flushes each
   accepted batch keeps this branch's cost, and one that waits only for the ceiling can leave a lone
   write undurable indefinitely. The cadence has to be specified, not inherited.
3. **The drain's blocking lands on the foreground write path, and neither runtime bounds it.**
   Draining alone barely touches the event loop (0.0–2.6 ms), but while writes are in flight the
   drain runs inside their awaits and the loop blocks for 20–32 ms, showing up as a `put` p99 of
   10–17 ms against a 0.06 ms median. `drain()` applies up to 128 keys between awaits, so a turn is
   up to 128 × 0.39 ms of synchronous native work. #2533 is not better placed: `#collectBatch`
   completes a whole transaction before checking any budget, `#resolveTransactions` then resolves
   every distinct key and projection outside that check, and `deliver()` runs after it — so
   `maxTransactionsPerTurn: 256` and `maxMillisecondsPerTurn: 5` bound neither one large transaction
   nor the applied cost of a batch. A queue-and-accept backend converts the applied cost into queue
   depth, which is why §13.2 bounds collection and resolved payload rather than application alone.

### 13.2 Changes the shared runtime needs (stacked on #2535)

- **Coalesced delivery view.** Add a batch-level, last-write-wins view over distinct
  `(tableId, recordId)` alongside the existing `transactions` array, keeping `writeKeyId` identity
  and the whole `through` cursor vector intact. `#resolveTransactions` already resolves each key
  once and hands every occurrence the same resolved object; what repeats is the mutation wrapper,
  which for a backend costing 0.2–1.4 ms per mutation is the expensive part. The coalesced entry
  keeps the last `logVersion` in batch order, the only field that differs between occurrences.
- **Bounded collection, resolution and delivery.** Make the budget cover the work that is actually
  unbounded: incremental collection with no cursor publication until a complete transaction is
  covered, or an explicit oversized-transaction policy; payload accounting that includes pending,
  deferred and accepted bytes, with a stated way to estimate projection size without serializing it
  twice; and time-sliced yielding rather than one `setImmediate` per mutation. Alongside it, make
  `maxTransactionsPerTurn`, `maxBytesPerTurn`, `maxMillisecondsPerTurn` and
  `maxAcceptedBatchesAhead` settable per registration — a vector backend and a full-text backend
  want different values — and correct the Stage 1 sentence claiming `deliver()` is "included in the
  runner's wall-time budget", which the code does not enforce.
- **An explicit durability cadence.** Specify what obliges a backend to flush: a maximum flush age
  so an isolated write becomes durable promptly, work and byte thresholds so a burst amortizes, idle
  completion, and shutdown behaviour. Without it, "adopt #2533" buys the _permission_ to amortize
  and none of the amortization. The thresholds are not free choices: the barrier grows with the
  dirty set (§13.1), so a cadence that waits for a large one trades per-record cost for a longer
  single stall, and both ends need a stated bound.
- **Rebuild as a runtime phase, on the conservative boundary.** #2533 stops at `needs-rebuild`:
  `#needsRebuild()` logs, drops the iterator, releases the lock, and the index stays unavailable.
  Reset storage → scan the primary store → project → deliver in bounded batches → replay → resume is
  identical for HNSW and full-text and belongs in the runtime. Anchor catch-up on the tail of a
  committed read taken at scan start — §13.6 shows why that is safe and why this branch's
  oldest-retained anchor is a cost with no correctness return — and keep the exact-boundary
  validation and fail-closed behaviour when retention or corruption prevents proof.
- **Generation fencing and cancellation.** Asynchronous acceptance makes ownership handoff unsafe
  without it: worker A can accept a batch, release the runner lock, and later run a scheduled
  mutation or a flush completion after worker B has reset the index, publishing A's mappings or
  readiness into B's generation. The backend interface needs a queue-drain/cancellation handshake;
  the runtime needs epoch checks before mutation and after every await, queue shutdown ordered
  before lock release, `rebuilding` published before any destructive reset, and `ready` published
  only after scan, catch-up and the final barrier.
- **Shared cross-worker readiness.** `indexStore.isIndexing` is per-worker and `getStatus()` is only
  meaningful on the owner, so a non-owning worker can answer from a partially built index. Publish
  readiness and its reason in a shared buffer beside the owner-epoch counter, and fence peer readers
  with it — this is the same mechanism the fencing above needs, and it closes the two cross-worker
  rebuild-window residuals in §10.
- **A lag policy, or an explicit decision not to have one.** Indexing capacity is one insert per
  changed vector plus the barrier — about 2,000 records/s per index at 384 dimensions, falling with
  dimension and graph size — while the foreground work of a `put` is 0.06 ms. A write stream that
  does not share the owning worker's event loop, which is any peer worker or any client pipelined
  across workers, therefore exceeds indexing capacity by a wide margin. The single-worker benchmark
  cannot show that gap directly, because there the writer and the drain contend for one loop and
  both land near 2,000/s. Deleting this branch's runtime deletes its retryable 503, and #2533 has no
  replacement, so sustained overload runs the cursor past audit retention, rebuilds, and falls
  behind again. Preserve the admission behaviour or approve the changed availability contract
  explicitly, with observable lag; queue memory pressure and retention lag are separate signals.

### 13.3 What #2430 became

`resources/DerivedIndexBackend.ts` is deleted. `resources/indexes/hnswDerivedIndex.ts` holds
`HnswDerivedIndexBackend`, the #2548 `DerivedIndexBackend` over the native index, and
`attachDerivedIndexes(Table)`, which registers every `postCommit` custom index of a table with one
`DerivedIndexRuntime` per database (keyed by the audit store) on every worker. `deliver()` queues and
returns accepted, an applier drains in 5 ms slices, `plane.flushAsync()` is the barrier, and the one
cursor vector lives in the index CF. HNSW does **not** use #2535's `RocksDerivedIndexStorage`: its
barrier is an `msync` of its own file, not a database-wide `flushSync`.

The three constraints the async shape imposed, and how each is met:

- **The flush cut is immutable.** The applier does not run while a barrier is in flight
  (`#applySlice` returns when `#flushing` is set, and the flush reschedules it), so the pending set
  a barrier publishes is exactly the set it covers.
- **`msync` is not the whole durability unit.** The order is fixed: plane barrier, then pending
  mappings published, then the cursor vector written — and `reset(epoch)` removes the cursor before
  it touches the file or the mappings, so a crash anywhere in either sequence reopens on a cursor
  that replays (idempotently) or on no cursor (rebuilds), never on a cursor over uncovered state.
- **Cursor migration is versioned.** Per-origin `Symbol.for('derived-index-cursor:…')` keys are
  gone; the vector under `Symbol.for('derived-index-cursor')` carries `format: 1`, and anything else
  fails the runtime's cursor validation and rebuilds.

Search readiness comes from the runtime's shared record, not `indexStore.isIndexing`: a search on a
non-`ready` index is a 503 (`unavailable` when the rebuild budget is exhausted), an empty `ready`
index answers no results, and a `ready` index whose file is gone while its mappings survive requests
a rebuild from its owner. Validation of the write stays a 400 at commit; a vector the plane cannot
hold at apply time is skipped and counted, never a rebuild.

### 13.4 Approaches considered

**Invariant:** one delivery/recovery implementation, in which a published cursor certifies a
complete durable prefix for that index generation and every committed change outside that prefix
stays replayable.

**Different layer.** Keep both runtimes and share only the transaction-log reader changes. Rejected:
ownership election, cursor validation and recovery stay duplicated, which is the failure #2489
exists to prevent.

**Deeper cause.** Move HNSW insertion into the package's own thread pool so delivery cost stops
being event-loop cost. Genuinely the deeper fix for the event-loop term, but 0.2.1 exposes only a
synchronous `insert`, it removes neither the duplicated runtime nor the repeated-key work, and it is
phase-3.

**Do less.** Adopt #2533 unchanged and put coalescing, chunking and rebuild inside the HNSW backend.
Rejected for rebuild, which is not backend-specific and whose duplication is how two runtimes came
to exist. The coalescing half of this argument is narrower than it first looked: #2533 already
resolves each key once, so backend-private coalescing would discard repeated mutation wrappers, not
repeated primary reads — still worth doing in the runtime, but as an allocation and dispatch saving.

**Chosen (revised after planning review).** One stacked PR on #2535 adds the coalesced view, bounded
collection/resolution/delivery, an explicit durability cadence, the rebuild phase, generation
fencing with cancellation, and shared readiness. #2430 then rebases onto it and becomes an HNSW
backend only.

The first draft of this plan also put a tighter rebuild boundary in the same PR — the earliest
position uncommitted at scan start, derived from `readUncommitted` or from per-worker staged
timestamps. The planning review disqualified it on a fact rather than a preference: the shared
runner resumes _after_ a complete transaction at its exact cursor, so installing the oldest staged
transaction A as the cursor skips A's own transaction entirely, and if A aborts, that exact
committed boundary may never exist and cursor validation fails. A correct version needs a distinct
_inclusive_ rebuild anchor with its own transition into a durable cursor, plus synchronization
between capture, staging publication, commit visibility, abort, worker replacement and retention —
a correctness-sensitive change to every audited writer, in exchange for an unmeasured rebuild-cost
optimization. Reading the pinned rocksdb-js afterwards showed the whole construction to be
unnecessary rather than merely misplaced — a committed read is a contiguous byte prefix, so the tail
is already a safe anchor (§13.6). The rejected alternative was right that the proposal did not
belong in this PR; it was solving a problem that is not there.

### 13.5 Sequencing

1. [#2548](https://github.com/HarperFast/harper/pull/2548) carries §13.2 on top of #2533 and #2535,
   simplified after review: one backend contract, plain-word shared readiness with reason codes,
   the committed-tail rebuild anchor, and the lag latch cleared on every park the runtime cannot
   leave. Its gate is the derived-index suites plus a fake backend carrying a synthetic
   per-mutation cost.
2. This branch is rebuilt on #2548: `DerivedIndexBackend.ts` deleted, `vectorIndexPlane.test.js`
   ported, and the `hnsw-plane` CI job still requires the native package to load rather than
   accepting a skip. Restacking exposed one runtime defect — a log that has never written a file
   reports `oldestSequenceNumber: 0`, which the runtime read as a retention gap on every fresh
   database — fixed in #2548.
3. #2548 merges into `main` as one change (closing #2533 and #2535 with it); this PR follows.

### 13.6 The rebuild anchor, resolved

The conservative anchor makes rebuild replay the whole retention window (§10). The first draft of
this plan proposed tightening it with a boundary derived from staged/uncommitted positions, the
planning review disqualified that construction, and it was deferred to the storage layer. Reading
the pinned rocksdb-js retires the whole line of work: no storage change is needed, and the tail is
already safe.

`TransactionLog.query()` resolves its end through `loadLastPosition()`, which decodes
`_lastCommittedPosition` into a single `{ logId, size }` physical offset; the iterator then walks
`while (position < size)`. A committed-only read is therefore a **contiguous byte prefix** of the
log, not a per-transaction filter over a sparse range. Nothing can sit physically behind the last
entry it yields, so anchoring rebuild catch-up on that entry cannot skip anything — the hazard the
conservative anchor exists to avoid does not exist.

The native side answers the one question this left open, and it is the stronger reading:
`TransactionLogStore` keeps the physically-written-but-uncommitted start offsets in a sorted vector
(`uncommittedTransactionPositions`) and `commitFinished()` advances `lastCommittedPosition` to
`front()` — the earliest still-uncommitted write — not to the committing transaction's own end. A
transaction that wrote at offset 200 and committed before one still pending at offset 100 stays
invisible until 100 commits, so a committed read never returns an entry of a transaction that has
not committed, and nothing committed later can sit behind the tail it yields.

The shared runtime's rebuild phase anchors on that tail (`#captureBoundary` in
`resources/derivedIndexRuntime.ts`), which removed the whole-retention-window replay, the
capture-time reload-marker suppression and its wall-clock comparison together.
