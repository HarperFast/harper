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
- Native insert loop (phase 3; insert logic stays in JS initially, persisting through the
  native slot-write API).
- Cross-node ANN protocol. Out of scope entirely.
- Lexical/BM25 anything.

## 3. Architecture

```
                     JS (worker threads)                    native (Rust, napi-rs)
  ┌─────────────────────────────────────────┐   ┌─────────────────────────────────────┐
  │ HierarchicalNavigableSmallWorld.ts      │   │ hnsw-plane                          │
  │  • pk→nodeId mapping   (stays RocksDB)  │   │  • mmap'd slot file (per index/slice)│
  │  • insert/update/delete logic (phase 1) ├──►│  • slot read/write API (seqlocked)   │
  │  • commit callback → slot writes        │   │  • search(query, k, ef, filter) →    │
  │  • record load + exact rescore (as-is)  │◄──┤    top-k ids, own thread pool        │
  │  • runIndexing replay from watermark    │   │  • TSFN batch filter callback        │
  └─────────────────────────────────────────┘   └─────────────────────────────────────┘
```

What stays in RocksDB: the pk→nodeId mapping (transactional with record writes — it is the
authority on which node id a record owns), records themselves, and all other indexes. What
moves to the file: node vectors, per-layer adjacency, entry point, id allocator, freelist.

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

| Field                           | Size (768-d int8, cap 64)          |
| ------------------------------- | ---------------------------------- |
| seq (seqlock)                   | 4 B                                |
| flags (valid/deleted) + level   | 2 B                                |
| scale (f32) + invMag (f32)      | 8 B                                |
| degree                          | 2 B                                |
| vector (int8 × 768)             | 768 B                              |
| neighbor ids (u32 × layer0_cap) | 256 B                              |
| **total, padded**               | **1,040 B → 1 KB-aligned 1,088 B** |

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

- **Per-slot seqlock.** Writer: fetch_add seq to odd → write slot → fetch_add to even. Reader
  (traversal): read seq, copy the ≤1 KB slot (or read fields in place), re-check seq; retry on
  change. Retries are rare (writes touch ~40 slots per insert out of millions) and cheap.
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

- **Phase 1 — dual-write, search cutover.** Insert/update/delete logic stays in JS
  (`HierarchicalNavigableSmallWorld.ts` unchanged algorithmically); mutations persist to BOTH
  the index CF (as today) and the file via native slot-write calls. Search runs native from the
  file. Validation = compare native results against the JS path on the same graph; rollback =
  flip search back to JS, drop the file. The double-write cost is bounded (index writes are
  a fraction of insert cost) and temporary.

  _Integrated_ behind the opt-in `nativePlane: true` index option (search-only: toggling never
  reindexes; int8 + cosine indexes only — the flag no-ops elsewhere). Mutations mirror at the
  exact `indexStore.put/remove` sites via `writeNodeRaw`/`clearNode`/`setEntryPoint` with
  host-allocated ids; the plane file (`<store path>/<table>.<attr>.hnsw`, layer0 cap 128,
  16M-node sparse reservation) is created lazily with a full mirror of the existing CF graph on
  first enable, reopened on restart, deleted on drop/clear/reindex. The compiled module is
  optional (`npm run build:hnsw-plane`); absence falls back to the JS path with one warning.
  Parity, predicate, restart, and lifecycle coverage in `unitTests/resources/vectorIndexPlane.test.js`.
  Watermark/replay wiring, slicing, and msync-cadence flushes are not wired yet (open items).

- **Phase 2 — file-primary.** Drop the CF writes; the file is the only graph store. JS insert
  reads nodes through a native `getNode(id)` (one NAPI crossing per read, ~1 µs — comparable to
  today's decode path). Migration for existing indexes: reindex (accepted contract), or a
  one-shot CF→file bulk conversion since it is a pure format transform.
- **Phase 3 — native insert.** Move the insert search + neighbor selection native (same
  traversal core), leaving JS a thin `index(pk, vector)` call. Unlocks bulk build (C5) at
  native speed and removes the ~tens-of-ms event-loop pin per insert (#895).

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
  and sparse-file behavior varies by filesystem — functional, not optimized). Windows may fall back to the JS implementation
  entirely; the native plane is allowed to be absent there.
- **Packaging: independent open-source package.** The core has zero Harper coupling — the crate
  compiles standalone and its NAPI surface is generic (create/open plane, insert(id, vector),
  remove(id), search(query, k, ef, filter), watermark get/set). Harper-specific glue — the
  pk→nodeId mapping, commit-callback integration, txnlog-anchored replay, auto-ef policy
  constants — stays in Harper regardless of packaging. Plan: develop in-repo under
  `native/hnsw-plane/` until the NAPI surface stabilizes (end of phase 1), then split to its own
  repo in the symphony/lmdb-js mold and consume via npm. The pitch as a community package: a
  persistent, incrementally-maintained, concurrently-searchable HNSW for Node — hnswlib-node has
  no durable incremental persistence, no off-loop batched filtering, no seqlock concurrency.

Open:

- **msync cadence default** — bounded-lag durability window vs write amplification; needs a
  workload measurement, not a guess.
- **f32 (quantization:"none") slot variant** — 3,072 B vectors → 3.4 KB slots; supported by the
  format (dims × mode in header) but int8 is the default and the optimization target.
- ~~Upper-layer region persistence~~ — done (format v2): fixed-entry region in the same file,
  per-entry seqlocks, reserved for max_nodes/8. Upper entries leak on delete (bounded by the
  2x-headroom reserve); an upper freelist is the remaining nicety.
- ~~Reservation growth~~ — decided (Kris, 2026-08-31): a generous sparse reservation at create
  is the model; mremap-based growth is a possible later enhancement, not a requirement.

## 11. Known phase-1 limitations (reviewed, accepted, tracked)

From the round-1 cross-model review (codex + gemini + cursor-grok + harper-domain), two
architectural findings are deliberately deferred rather than fixed in phase 1 — both are
bounded by the phase-1 contract (opt-in flag, CF authoritative, plane derived):

- **Mirroring runs at the indexStore.put sites, inside the transaction.** A rolled-back
  transaction can leave phantom nodes in the plane (the CF never had them). Phantom ids are
  filtered at record load (missing record → SKIP), so results can be transiently short by
  the phantom count; the garbage accumulates only at the rollback rate. The structural fix —
  driving the mirror from committed state (commit callback / txnlog consumer) — is the
  phase-2 "watermark/replay wiring" work item and also subsumes the residual lost-write
  window during attach retry (mirror calls during the 250 ms backoff are dropped and heal
  only on the node's next touch).
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
