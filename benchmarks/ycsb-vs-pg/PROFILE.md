# Where Harper's read path spends its CPU

`harper-uws` (Harper over uWebSockets.js, stock record cache) against `pg-redis` (Fastify + Redis cache-aside over Postgres), both on the same 4 P-cores and 8 GiB, YCSB zipfian reads of 1 KB records over REST. Profiled 2026-10-30 at Harper `85bafde3` (main `ba3cc219`: includes #3740, #3549, #3755).

With the whole dataset in Redis, the stack serves workload C at 64.1 CPU µs/op against Harper's 76.2. Harper's uWS HTTP layer is ~10 µs/op cheaper than Fastify's; Harper loses it, and 12 µs/op more, on the data path and per-request setup:

| warm, workload C, CPU µs/op                                                                                         | harper-uws |                           pg-redis | Harper − stack |
| ------------------------------------------------------------------------------------------------------------------- | ---------: | ---------------------------------: | -------------: |
| HTTP parse + write, socket I/O and syscalls                                                                         |       17.5 |                               27.3 |           −9.8 |
| routing, request/context setup, handler                                                                             |        7.0 |                                2.4 |           +4.6 |
| authentication, permissions                                                                                         |        2.8 |                                  – |           +2.8 |
| data access: Harper's Table.get + transaction + record cache + RocksDB + decode; the stack's ioredis + Redis server |       28.3 |                               15.3 |          +13.0 |
| response serialization (JSON)                                                                                       |        2.7 | – (stores JSON, returns the bytes) |           +2.7 |
| event loop, promise/microtask machinery                                                                             |        4.6 |                                7.0 |           −2.4 |
| GC                                                                                                                  |       11.2 |                               11.5 |           −0.3 |
| JIT compilation, other                                                                                              |        2.2 |                                0.4 |           +1.8 |
| **total**                                                                                                           |   **76.2** |                           **64.1** |      **+12.1** |

Harper retires 16% more instructions per op (244.8k vs 210.5k) at 5% lower IPC (1.41 vs 1.48).

Added 2026-10-31:

- [why warm reads still reach RocksDB](#why-warm-reads-still-reach-rocksdb-record-cache-2026-10-31): a weak-lru-cache promotion bug, per-thread caches and a half-uniform key distribution;
- [token authentication on both sides](#token-authentication-on-both-sides---authtoken-2026-10-31);
- [Harper's pipeline by layer with per-request allocation](#harpers-request-pipeline-by-layer-with-allocation-warm-c-2026-10-31), with a ranked list of reductions.

Added 2026-11-01: [the record cache's weak tier](#the-record-caches-weak-tier-2026-11-01), counted inside `WeakLRUCache.get()`, with a V8 GC timing test and a strong-only A/B.

Added 2026-11-02: [a Redis-sized record cache](#a-redis-sized-record-cache-2026-11-02). Giving the record cache Redis's 3 GiB on 4 threads does not pay at 2x: hit rate +7–10 points, throughput flat to −7%, because the memory comes out of the page and block caches. Two threads with twice the cache use only 2.7 of 4 cores. The section has the per-record heap cost, GC by phase, a recommendation for a byte-sized cache, and two rocksdb-js read-path gaps.

## Ranked optimization candidates

Estimates are CPU µs/op at the point named, from the bucket and frame costs below; only 8 is measured as a change. All are proposals for separate work: this PR changes no product code.

| #   | candidate                                                                                                                                                                                                                                                                                                                                                                                                 | where                                                                                                                                                   | estimated gain                                                                                                                                                                                                                                                                                                                  | risk                                                                                                                                                                                            |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | **Bloom filters on SST files.** rocksdb-js builds `BlockBasedTableOptions` with no `filter_policy`, so a point read probes every overlapping file: index-block search, block-cache lookup and often a data-block read per L0 file and per level. B flushes a ~15.5 MiB memtable every few seconds (150 flushes in one 2x B sample), so L0 holds several files.                                            | rocksdb-js `src/binding/database/db_descriptor.cpp:205`                                                                                                 | 2x C: SST probing costs 21.5 µs/op (block reads 8.8, block cache 4.3, index search 3.8, SST/version 4.6); filters should save a third to a half, **7–11 µs/op (6–9%)**. 2x B: probing costs 49.6 µs/op, so **15–25 µs/op (8–12%)**. ~0 at warm C.                                                                               | Low–medium. About 1.25 B/key of filter memory charged to the block cache (21 MiB at 2x, 86 MiB at 8x); existing SSTs get filters only as they are rewritten; build CPU at flush and compaction. |
| 2   | **A RocksDB transaction for every read.** Each request gets a `DatabaseTransaction` (`transaction.ts:52`), whose first read opens a native `RocksTransaction` (`DatabaseTransaction.ts:1176`); the request then commits it (`transaction.ts:79` → `DatabaseTransaction.ts:2651`) and the native side aborts it. Native `Transaction::Constructor` alone is 4.0 µs/op and `Abort` 1.9.                     | `resources/transaction.ts:52,79`, `resources/DatabaseTransaction.ts:1162-1196`, `:2651`                                                                 | Whole lifecycle **9.0 µs/op at warm C (11.8%)**, ~11 at 2x C, plus the GC its allocations cause. (a) Read a single key without a native transaction, opening one only on a second read or a write: most of the 9.0. (b) Reuse native transaction objects in rocksdb-js (RocksDB's `BeginTransaction(..., old_txn)`): 3–4 µs/op. | (a) Medium–high: snapshot consistency across reads, record locks, cancellation and replication all hang off this object. (b) Low–medium.                                                        |
| 3   | **Response header assembly.** Every local-trust response resolves a principal, so it takes the identity-dependent branch of `applyResponseHeaders`: Headers normalization, a `Vary: Authorization` merge that splits and lowercases the existing value, and `Cache-Control: private, no-cache`. Then `writeHeaders` copies the Headers map into uWS. The closure and its array are allocated per request. | `security/auth.ts:523` (inside `authentication`, `:134`), `server/serverHelpers/Headers.ts:72,91`, `server/serverHelpers/uwsServer.ts:293`              | **~3.7 µs/op at warm C (5%)**: `applyResponseHeaders` 1.6, `writeHeaders` 1.1, `addVaryHeader` 0.6, `appendHeader` 0.4. Precomputing the constant header pair and writing straight to uWS should recover 2–3.                                                                                                                   | Low. The #1565/#1518 cache-partitioning semantics must stay.                                                                                                                                    |
| 4   | **JSON per record version.** On a record-cache hit Harper re-serializes the same object for every request; on a miss it also decodes it. The stack returns the stored bytes. Caching the JSON with the cached record (keyed by version, dropped with the record) serves a whole-record GET without `select` from bytes.                                                                                   | `server/serverHelpers/contentTypes.ts:511` (`serialize`), `resources/PrimaryRocksDatabase.ts:133` (`getEntry`), `resources/RecordEncoder.ts` (`decode`) | Serialize 2.7 + decode 2.7 + entry wrapping 0.9 = **6.3 µs/op at warm C (8%)**; the hit-path share of that, plus GC.                                                                                                                                                                                                            | Medium: memory for a second copy of hot records, content negotiation, keeping the representation exact.                                                                                         |
| 5   | **rocksdb-js `get` binding overhead.** Around the engine's 5.8 µs/op `DBImpl::GetImpl`, `Database::GetSync` spends ~2.4 µs/op: option-object property reads (`getProperty<bool>` 0.7), a separate `isOpen()` napi call before every get (0.5), version-table checks (1.0).                                                                                                                                | rocksdb-js `dist/index.cjs:880` (`getBinaryFast` → `isOpen()`), native `Database::GetSync`                                                              | **1–1.5 µs/op (2%)** from positional flags and folding the open check into the get.                                                                                                                                                                                                                                             | Low.                                                                                                                                                                                            |
| 6   | **Prefetch through the libuv pool under memory pressure.** At 2x the record loader's prefetch mode sends a share of reads to the thread pool: pool threads 15.6 µs/op, completions 16.2 µs/op inclusive, 0.93 context switches/op (0.10 at warm). The pool shares the same 4 cores, so the hop buys concurrency only while a read waits on disk.                                                          | `resources/Table.ts:11161-11330` (`loadRecord` prefetch feedback, `loadPrefetchedRecord`)                                                               | Uncertain, **−5 to +10 µs/op at 2x**: measure 2x and 8x with prefetch off, and try `MultiGet` for bundled ids.                                                                                                                                                                                                                  | Medium.                                                                                                                                                                                         |
| 7   | **GC at 2x.** GC doubles from warm to 2x (11.2 → 20.3 µs/op; scavenge 3.9 → 8.2, major marking 4.8 → 8.3), consistent with decoded records surviving one scavenge in the weak record cache and dying later. HTTP threads get a 16 MiB young generation under an 8 GiB cap (`maxOldMemory >> 6`, floor 16).                                                                                                | `server/threads/manageThreads.ts:1363`                                                                                                                  | Candidates 2–4 cut allocation directly. A larger young generation is a cheap experiment, maybe 2–4 µs/op at 2x.                                                                                                                                                                                                                 | Low (memory).                                                                                                                                                                                   |
| 8   | **The record cache's LRFU promotion (weak-lru-cache).** Entries stored with an expiration priority ≥ 1, which is every Harper record of 1 KiB or more, are never promoted out of the first generation, so the cache is a FIFO of 4,096 records per thread at the default size. See [Why warm reads still reach RocksDB](#why-warm-reads-still-reach-rocksdb-record-cache-2026-10-31).                     | weak-lru-cache `LRFUExpirer.js:60` (upstream); Harper `resources/PrimaryRocksDatabase.ts:189`                                                           | **Measured:** warm C hit rate 30% → 38% (default) and 47% → 60% (sized); instructions/op −2.0% and −3.6% over 3M-op runs.                                                                                                                                                                                                       | Landed: weak-lru-cache 1.2.3, on main since [Bump weak-lru-cache to 1.2.3](https://github.com/HarperFast/harper/pull/3849).                                                                     |

Small or ruled out at these points:

- **Eager per-request AbortSignal (#2047):** 0.18 µs/op in `get signal` on this path.
- **writev IPC loss from the earlier bisect:** writev is the Node HTTP path; `harper-uws` writes each response with one uWS `send()`. Socket syscalls are 8.7 µs/op of kernel time at warm C, mostly that `send()` through loopback TCP, against 11.8 for Fastify's `writev` and reads.
- **Promise and microtask machinery:** ~1 µs/op self time at warm C. Making async stages synchronous would save little beyond their allocations.
- **GC after #3740:** 11.2 µs/op at warm C across all threads, the same as Fastify's 11.4. #3740's ~763 ms per 100k reads (7.6 µs/op) counted the main thread only.

## Per-bucket CPU per op

From the 1M-op `perf record` window of each sample, at the quietest rep (see Method). µs/op = the bucket's share of a component's samples × that component's cgroup CPU per op in the same window; kernel-mode µs/op in brackets.

| bucket                                      | harper-uws C warm | pg-redis C warm | harper-uws B warm | pg-redis B warm | harper-uws C 2x | harper-uws B 2x ⚠ |
| ------------------------------------------- | ----------------: | --------------: | ----------------: | --------------: | --------------: | ----------------: |
| HTTP parse + write, socket I/O and syscalls |        17.5 (8.7) |     27.3 (11.8) |       21.6 (10.4) |     32.7 (13.6) |     22.9 (11.8) |       37.8 (18.5) |
| routing, request/context setup, handler     |               7.0 |             2.4 |               8.6 |             4.4 |             8.1 |              15.0 |
| authentication, permissions                 |               2.8 |               – |               3.5 |               – |             3.5 |               5.7 |
| Resource/Table.get, transactions            |              11.2 |               – |        17.9 (1.0) |               – |      17.5 (1.0) |        35.7 (2.4) |
| record cache lookup                         |               2.1 |               – |               2.6 |               – |             1.1 |               2.2 |
| RocksDB read                                |              12.3 |               – |        22.3 (1.5) |               – |      32.4 (8.0) |       80.2 (17.2) |
| record decode                               |               2.7 |               – |               3.9 |               – |             3.7 |               6.9 |
| response serialization (JSON)               |               2.7 |               – |               3.6 |             0.4 |             3.2 |               5.1 |
| Redis client (ioredis)                      |                 – |             6.5 |                 – |             7.9 |               – |                 – |
| Redis server                                |                 – |       8.8 (5.7) |                 – |       8.9 (5.2) |               – |                 – |
| Postgres client                             |                 – |               – |                 – |             1.7 |               – |                 – |
| Postgres server                             |                 – |               – |                 – |      10.8 (4.8) |               – |                 – |
| event loop, promise/microtask machinery     |         4.6 (0.8) |       7.0 (1.9) |         5.6 (0.7) |       7.4 (1.7) |       8.0 (1.9) |        12.1 (1.7) |
| GC                                          |              11.2 |            11.5 |              15.2 |            12.1 |      20.3 (0.7) |        25.3 (0.6) |
| JIT compilation                             |               1.5 |               – |               1.2 |             0.1 |             0.7 |               1.4 |
| other                                       |               0.7 |             0.4 |         1.2 (0.5) |             0.5 |       2.0 (1.2) |         3.3 (1.7) |
| **total CPU µs/op**                         |          **76.2** |        **64.1** |         **107.2** |        **86.9** |       **123.5** |         **230.7** |
| throughput in that window, ops/s            |            49,817 |          52,953 |            35,907 |          40,703 |          27,918 |            15,654 |
| host cores busy outside the run             |               0.5 |             0.8 |               0.4 |             1.9 |             1.3 |               5.2 |

⚠ The 2x B profile window ran while other agents kept 5.2 cores busy; its µs/op are inflated by contention (its counters-only window just before, 203.2 µs/op, and its measured run, 173.1 µs/op at 1.3 cores busy, are lower). Read its column for shares, not absolutes.

RocksDB read, split by innermost RocksDB frame (µs/op):

| part                                | C warm | B warm | C 2x | B 2x ⚠ |
| ----------------------------------- | -----: | -----: | ---: | -----: |
| rocksdb-js binding (`rocksdb_js::`) |    3.9 |    7.0 |  5.5 |   12.7 |
| JS glue, napi                       |    2.5 |    3.3 |  5.3 |   11.8 |
| index/data block search             |    2.0 |    3.3 |  3.8 |   14.8 |
| SST get, version, superversion      |    1.8 |    2.6 |  4.6 |    9.5 |
| block cache lookup                  |    1.1 |    2.3 |  4.3 |   11.6 |
| memtable                            |    0.9 |    2.9 |  0.1 |    5.4 |
| file read (block-cache miss)        |      – |    0.7 |  8.8 |   13.7 |
| decompression, filter               |      – |    0.2 |  0.1 |    0.7 |

Filter checks never appear: there are no Bloom filters (candidate 1).

## Hardware counters per op

`perf stat` per cgroup over a 1M-op counters-only window right before each profile window, every component of the target summed. Instructions per op repeat within 1–4% between reps; cycles per op move with load from other agents on the host.

|                              | harper-uws C warm | pg-redis C warm | harper-uws B warm | pg-redis B warm | harper-uws C 2x | harper-uws B 2x |
| ---------------------------- | ----------------: | --------------: | ----------------: | --------------: | --------------: | --------------: |
| CPU µs/op                    |              76.0 |            64.3 |             111.5 |            86.5 |           128.0 |           203.2 |
| instructions/op              |            244.8k |          210.5k |            285.9k |          219.6k |          314.1k |          407.9k |
| cycles/op                    |            173.9k |          142.6k |            255.2k |          191.8k |          291.3k |          462.9k |
| IPC                          |              1.41 |            1.48 |              1.12 |            1.15 |            1.08 |            0.88 |
| kernel share of instructions |                9% |             25% |                9% |             25% |             13% |             12% |
| context switches/op          |              0.10 |            0.62 |              0.28 |            0.76 |            0.93 |            1.36 |
| page faults/op               |             0.017 |           0.013 |             0.136 |           0.230 |           0.363 |           0.495 |

pg-redis by component, warm C: Fastify 187.8k instructions/op (IPC 1.52), Redis 22.5k (74% kernel), Postgres 0.3k. Warm B adds Postgres at 13.7k for the 5% of writes.

## Harper's request pipeline, warm C

Inclusive µs/op of Harper's own frames (each function counted once per stack), harper-uws C warm:

| stage                                                               |    µs/op inclusive |
| ------------------------------------------------------------------- | -----------------: |
| uWS request callback (`uwsServer.ts` `onRequest`)                   |               32.3 |
| `http.ts` `handle` → `authentication` → `REST.ts` `http`            | 30.6 → 30.2 → 30.1 |
| `transaction()` (per-request `DatabaseTransaction`)                 |               24.7 |
| `Resource.applyContext` → `Table.getResource` → `_loadRecord`       | 23.7 → 22.9 → 22.0 |
| `loadLocalRecord`                                                   |               16.8 |
| rocksdb-js `get` (incl. native `GetSync` 8.2, engine `GetImpl` 5.8) |               12.5 |
| `getReadTxn` (opens the native transaction)                         |                4.8 |
| `commit` / `performCommit` of the read-only transaction             |                3.5 |
| record `decode` (msgpackr/structon)                                 |                2.8 |
| JSON `serialize`                                                    |                2.7 |
| `applyResponseHeaders`                                              |                2.2 |

Workload B costs Harper 31 µs/op more than C at warm though only 5% of ops write. The writes themselves (save, commit, the commit worker) take 5–8 µs/op. The rest is reads getting dearer while writes churn the memtable: RocksDB read 12.3 → 22.3 µs/op (memtable 0.9 → 2.9, binding 3.9 → 7.0), IPC 1.41 → 1.12, page faults 8x.

## Why warm reads still reach RocksDB (record cache, 2026-10-31)

Warm C, 200k records of ~1.03 KiB (10 × 100 B fields). Counts come from a temporary probe in `PrimaryRocksDatabase.getEntry`, not committed. The probe records whether the record cache's `getValue` hit, whether the hit's value still mapped to its `Entry`, and whether the verification table (VT) already held the cached version, checked with `verifyVersion` before the read. It also records what the native read returned, every `setValue`, and every cache-Map deletion. 3M-op measured runs; rates exclude the read-all pass.

| record cache                               | weak-lru-cache | hit rate | VT fast path, share of hits | reads reaching `DBImpl::GetImpl` | strong entries/thread | instructions/op |
| ------------------------------------------ | -------------- | -------: | --------------------------: | -------------------------------: | --------------------: | --------------: |
| stock (`cacheSize` 32,768)                 | 1.2.2          |    30.3% |                         98% |                            70.3% |                 4,096 |          256.6k |
| stock                                      | 1.2.3          |    38.4% |                         95% |                            63.7% |                13,265 |  251.5k (−2.0%) |
| sized (`HARPER_RECORD_CACHE_SIZE` 262,144) | 1.2.2          |    47.2% |                         89% |                            58.0% |                32,768 |          247.4k |
| sized                                      | 1.2.3          |    59.5% |                         83% |                            50.6% |                81,639 |  238.5k (−3.6%) |

Every hit still had its `Entry` (the `entryMap` WeakMap never lost one), and every cache-Map deletion was of an entry the expirer had already evicted and GC had collected. Nothing else removes entries. The causes, largest first:

1. **A weak-lru-cache bug makes the cache a FIFO of its first generation.** `LRFUExpirer.used()` decides whether a reused entry is "recently added, don't promote" by comparing `entry.position` with the ring's `lru.position`. But `entry.position` also carries the entry's expiration-priority bits (24–29), and the ring position never does. For any entry stored with priority ≥ 1 the comparison is therefore always true, so the entry is never promoted out of generation 0. Generation 0 is a ring overwritten on every insert: the cache becomes a FIFO of `lruSize / 2^bits` entries per thread. Harper stores every record with priority `size >> 10` (`resources/PrimaryRocksDatabase.ts:189`), which is 1 for any record of 1–2 KiB. This benchmark's records are 1.03 KiB, so the strong set is exactly 4,096 entries per thread (8,192 slots, 2 per entry). Sizing the cache to 262,144 only grows that FIFO to 32,768, which is why `harper-uws-sized` was only ~3% faster. Masking the priority bits out of the comparison is a one-line fix in weak-lru-cache (`LRFUExpirer.js:60`, also on upstream master). In isolation, a key read on every iteration is evicted after 511 inserts at priority 1 without the fix and never with it. lmdb-js passes the same `size >> 10` priority, so Harper's LMDB record cache has the same defect.
2. **The cache is per worker thread.** Each of the 4 HTTP threads has its own `WeakLRUCache` and LRFU expirer, so a key served by one thread is cold in the other three. 728k of the 3.2M lookups were a key's first request in that thread, so about 18% of measured requests missed for that reason alone. The read-all pass warms only the thread that served each key.
3. **The workload's hot set is large.** YCSB's scrambled zipfian draws ranks over 10¹⁰ virtual items and folds them onto 200k keys with a hash. The top 16k ranks get 41% of draws, and the 49% that fall on ranks beyond 200k spread uniformly over every key. Computed from the generator's constants, an ideal LRU would hit 45% with 16k entries and 81% with 131k. The fixed caches' 38% (13k strong entries) and 60% (82k) sit below that by about the first-touch misses of item 2.
4. **The weak tier serves a few percent of lookups.** An evicted value stays reachable through its `WeakRef` until the GC collects it, and a lookup before that revives it. Counted inside `WeakLRUCache.get()`: 4.5% of lookups under 1.2.2 and 1.4% under 1.2.3; 94–98% of evicted values are collected before they are asked for again. See [the weak tier](#the-record-caches-weak-tier-2026-11-01). (This item first said 0 of 12.8M. That probe ran after `getValue()` had already revived or deleted the entry, so it could not see a weak hit.)
5. **VT slot collisions grow with the cache.** The VT has 131,072 slots (rocksdb-js default `verificationTableEntries`) for 200k keys, and a colliding key's populate overwrites the slot. A hit whose slot was overwritten still reads RocksDB, though it is then answered FRESH without decoding. That is 2–5% of hits at the default size, but 11–17% at 262,144 entries.

Each hit gained saves about 0.3% of instructions/op at warm C: the RocksDB read, decode, `setValue` and the decoded record's GC. A hit still pays the native `GetSync` call, its VT check and the per-read transaction snapshot. The promotion fix shipped as weak-lru-cache 1.2.3 and is on main ([Bump weak-lru-cache to 1.2.3 so records >= 1 KiB promote in the record cache](https://github.com/HarperFast/harper/pull/3849)). Harper-side levers, each a separate decision: a record-cache size derived from the memory budget instead of a fixed 32,768 entries; a VT sized to the record count; and the per-thread duplication, which a shared cache cannot remove because JS objects cannot cross isolates.

## The record cache's weak tier (2026-11-01)

When the LRFU expirer evicts an entry from the strong set, the entry stays in the cache's Map: its strong reference is replaced by `EXPIRED_ENTRY` and it keeps a `WeakRef` to the decoded record. A later `get()` dereferences it. A live value is revived (the same object goes back into the strong set) and a collected one is deleted. A `FinalizationRegistry` removes collected entries that nobody asks for. The weak tier is for object identity and for not decoding a record again while something still holds it: a request or subscription that keeps a record across awaits, or a second request for a record another one is still serializing. It also extends the cache's reach past the strong set until the next GC that can collect the value.

**Counted inside `get()`.** A temporary patch of `weak-lru-cache/dist/index.cjs` (not committed) counted each lookup's outcome before `get()` changes the entry: strong hit, EXPIRED and alive (revived), EXPIRED and collected, or absent. It also counted evictions and finalizer callbacks, and bucketed the time from eviction to the lookup. Rates use only the probe's 100 ms ticks inside the measured run. harper-uws, warm C, 2M-op runs, 4 HTTP threads:

| record cache                               | weak-lru-cache | hit rate | from the strong set | from the weak tier | weak share of hits | evicted values collected before reuse |
| ------------------------------------------ | -------------- | -------: | ------------------: | -----------------: | -----------------: | ------------------------------------: |
| stock (`cacheSize` 32,768)                 | 1.2.2          |    29.8% |               25.3% |               4.5% |                15% |                                   94% |
| sized (`HARPER_RECORD_CACHE_SIZE` 262,144) | 1.2.2          |    46.7% |               43.7% |               2.9% |                 6% |                                   95% |
| stock                                      | 1.2.3          |    36.8% |               35.4% |               1.4% |                 4% |                                   98% |
| sized                                      | 1.2.3          |    56.0% |               54.5% |               1.6% |                 3% |                                   96% |
| stock, strong-only variant                 | 1.2.3          |    35.5% |               35.5% |                  – |                  – |                                     – |
| sized, strong-only variant                 | 1.2.3          |    54.5% |               54.5% |                  – |                  – |                                     – |

- A counts-only build (no timestamps) gave 29.7% / 4.4% for the first row, so the timing instrumentation did not change the result.
- Lookups that found a collected value were 0.01% or fewer: the finalizer had already removed the entry, so those lookups count as misses.
- Revived values had been evicted 10 ms to 1 s earlier in 77–97% of revivals; 22% of the sized 1.2.3 cache's revivals came 1–10 s after eviction.
- The strong-only variant (same expirer; eviction drops the entry, no `WeakRef`, no `FinalizationRegistry`) loses almost exactly the weak tier's share.

**When V8 clears an evicted value.** A standalone Node 26.2 (V8 14.6) test put 128 records of ~1.1 KiB in a fresh cache at priority 1, as Harper does, evicted them, and re-read them after a delay. Promotion to old space was checked with `%InYoungGeneration`. Nothing dereferenced a target before the re-read: a `deref()` keeps the target alive to the end of the job, and during incremental marking it marks the target, so polling would keep it alive. Two runs gave the same result:

| evicted while                      | no allocation                     | short-lived garbage, ~100 MB/s                                           | old-space growth                   |
| ---------------------------------- | --------------------------------- | ------------------------------------------------------------------------ | ---------------------------------- |
| in new space (before any scavenge) | alive, until an idle GC           | collected at the first scavenge (~0.17 s)                                | collected at the first scavenge    |
| in old space (after two scavenges) | alive, until an idle mark-compact | alive through every scavenge; collected at the next mark-compact (0.4 s) | collected at the next mark-compact |

Under 1.2.2 an entry lived about half a second in the strong set, long enough to reach old space, so it lasted until the next mark-compact. That matches the revival ages above.

**Cost: strong-only A/B.** harper-uws and harper-uws-sized, warm C, stock 1.2.3 against the strong-only variant, 3 interleaved reps, with `--profile` (counters and GC from the steady windows):

| median of 3 reps | instructions/op, stock → strong-only |    GC µs/op |   CPU µs/op |
| ---------------- | -----------------------------------: | ----------: | ----------: |
| harper-uws       |                      261.3k → 263.6k | 13.6 → 14.6 | 82.3 → 82.1 |
| harper-uws-sized |                      249.7k → 247.9k | 14.0 → 12.9 | 78.0 → 76.8 |

The differences are smaller than the rep-to-rep spread (3–8% in instructions/op in these runs). In the flame graphs, `WeakRef` and `FinalizationRegistry` work is 0.67–0.77% of Harper's samples with the stock cache and 0.09–0.16% with the strong-only variant (`FinalizationRegistry.register`, `Runtime_JSWeakRefAddToKeptObjects`, `JSFinalizationRegistry::Cleanup`, `MarkCompactCollector::ProcessJSWeakRefs`), about 0.5 µs/op. The revivals save about as much: 1.4% of lookups × ~19 µs for a RocksDB read and decode is ~0.3 µs/op.

**On the dependent-read workloads** (harper-uws, 1.2.3, warm): hit rate 33% for inspect, 46% for chain-1, 56% for chain-2, 70% for chain-4 and 15% for F; the weak tier served 2.0%, 2.5%, 2.7%, 2.4% and 0.7% of lookups. Chains hit more because each record's link points to a zipfian-popular key.

**What this benchmark can show.** Only the reach past the strong set. Every handler here drops its records once the response is written, so nothing holds a record when it is evicted, and the identity benefit never comes up.

**Recommendation: keep the weak tier.** On these workloads it costs about 0.5 µs/op and saves about 0.3 µs/op, both under the noise. Its identity benefit applies where application code holds records, which this benchmark does not measure. The levers that move the warm hit rate are the strong set's size and the per-thread caches (items 1 and 2 above).

## A Redis-sized record cache (2026-11-02)

**Question.** In the sweep, Redis gets 3 GiB of the stack's 8 GiB (`maxmemory 3gb`). Harper's record cache holds about 13k records per thread, tens of MB in total, and almost all of Harper's 8 GiB goes to the RocksDB block cache and the page cache. Does a record cache with Redis's share pay off at the 2x point (17.2M records), and on how many threads? Harper at `f916e39`: main with header assembly (#3837), the request-pipeline reductions (#3850), uWS client addresses (#3855) and weak-lru-cache 1.2.3. Same 8 GiB cgroup and 4-core cpuset for every configuration, uWS HTTP.

| configuration    | target                      | threads | `HARPER_RECORD_CACHE_SIZE` | records held per thread | `threads.maxHeapMemory` | block cache |  verification table |
| ---------------- | --------------------------- | ------: | -------------------------: | ----------------------: | ----------------------: | ----------: | ------------------: |
| A, control       | `harper-uws`                |       4 |           32,768 (default) |                    ~13k |        744 MB (derived) | 2 GiB (25%) |          128K slots |
| B                | `harper-uws-rc3g-4t`        |       4 |                    820,000 |          410k = 768 MiB |                 1152 MB |     512 MiB | 16M slots (128 MiB) |
| C                | `harper-uws-rc3g-2t`        |       2 |                  1,640,000 |          820k = 1.5 GiB |                 2240 MB |     512 MiB |           16M slots |
| B, default table | `harper-uws-rc3g-4t-vt128k` |       4 |                    820,000 |                    410k |                 1152 MB |     512 MiB |          128K slots |
| A, large table   | `harper-uws-vt16m`          |       4 |                     32,768 |                    ~13k |                  744 MB |       2 GiB |           16M slots |
| A, 2 threads     | `harper-uws-2t`             |       2 |                     32,768 |                    ~13k |        780 MB (derived) |       2 GiB |          128K slots |

**Bytes per cached record: 1,965.** Measured in a real Harper (warm, 200k records, B's and C's `cacheSize`). A temporary probe forced two full GCs every 2 s and logged each thread's used heap against its strongly held entries, counted by scanning the LRFU ring. While the cache filled from ~20k to ~190k entries per thread, the heap rose 1,960–1,966 bytes per entry on every thread (R² 0.9997–0.9998). That covers the decoded record (10 one-byte strings of 100 chars and the object), its `WeakRef` entry with its fields, the `FinalizationRegistry` cell, the Map entry and the `Entry` held in `entryMap`. The intercept, 42 MiB per thread at B's size and 48–53 MiB at C's, is Harper's baseline heap plus the ring arrays, which are allocated up front at 8 bytes per position. A ~1 KiB record has expiration priority 1, so it takes 2 ring positions: 768 MiB is 410k records and a `cacheSize` of 820k. The stock cache's slope, 2,084–2,126 bytes, is noisier because its Map also holds weak entries.

**The memory trade inside 8 GiB.** At 2x, A fills its cap: about 2.8 GiB anon (the block cache's 2 GiB, four heaps and native memory) and 5.3 GiB of page cache. The block cache is only 2 GiB, so it cannot give up 3 GB. B and C cut it to 512 MiB (−1.5 GiB), and the rest of the cache, its heap headroom and the 128 MiB table come out of the page cache. The heap limit is the cache plus the ~50 MiB baseline plus 40% for garbage between major GCs.

**A cache hit is only cheap when the verification table vouches for it.** A record-cache hit passes the cached version to rocksdb-js. If the process-wide verification table (VT) slot for that key still holds the version, the answer is FRESH with no RocksDB read. If the slot was overwritten, rocksdb-js reads the record and still answers FRESH when the version matches: no decode, but a full RocksDB read, and through the thread pool when the block is not cached. The VT is direct-mapped, its default is 131,072 slots, and every cold read overwrites one. Harper has no setting for its size, so `vtPreload.mjs` sets it from Harper's main thread before the first database opens. A worker-thread test confirmed the setting reaches the workers: 64 slots sent all 2,000 worker lookups to RocksDB, 16M sent none.

Two findings from counting this:

- rocksdb-js's `Store.get()` passes `POPULATE_VERSION_FLAG` only to its in-memory attempt. When the block cache misses and it repeats the read on its thread pool (`context.get(keyParam, resolve, reject, txnId, expectedVersion)`, `dist/index.mjs:2008-2011`), the flag is gone, so a cold read from disk or page cache never seeds the VT. The record's first cache hit then costs a second RocksDB read, which does populate the slot. Standalone, with a 1 MiB block cache and a 16M-slot table, 6,855 of 20,000 cold reads went to the pool and the first expected-version pass found 13,134 immediate hits; the second found 19,974. With a 512 MiB block cache that misses most reads, nearly every record entering B's or C's cache pays this once.
- Inside a transaction, as Harper reads, a lookup that misses the block cache makes three RocksDB lookups. They are `Store.get()`'s in-memory attempt, the transaction's own in-memory attempt (a repeat, `transaction_handle.cpp:703-712`), then the thread-pool read. `rocksdb.number.keys.read` counts all three, so immediate VT hits = lookups − (RocksDB Gets − 2 × thread-pool reads). The probe counts a thread-pool read whenever `getEntry` gets a promise back. If the transaction's repeated probe finds a block another thread loaded in the meantime, there is no pool read and that lookup made two Gets, so the estimate is an upper bound by that margin. Standalone: 2.00 extra Gets per thread-pool read with a transaction, 1.00 without.

**Probe overhead.** Every Harper row here ran with the probe: counters inside `getEntry`, RocksDB tickers, heap and GC per thread every 100 ms, and a ring scan every 30 s (7–15 ms per thread at B's and C's sizes). Measured on harper-uws, warm C, 1M ops, 3 interleaved reps against the stock build: 207.1k instructions/op stock and 207.8k with the probe (+0.3%). The stock reps alone spread 1.0%. ops/s −0.5%. That was measured on the stock cache only. At 2x and on the tuned caches, the per-lookup work is the same few counter increments, and the ring scan takes under 0.05% of each thread's time.

**Warm row (200k records, everything fits), 3 reps, median:**

| workload | configuration |        ops/s (min–max) | p50 ms | p99 ms | CPU µs/op | instructions/op | cache hit |
| -------- | ------------- | ---------------------: | -----: | -----: | --------: | --------------: | --------: |
| C        | A             | 54,177 (52,792–55,872) |   0.79 |   4.33 |      62.9 |          206.6k |     37.5% |
| C        | B             | 60,409 (56,254–60,945) |   0.63 |   3.93 |      54.5 |          181.4k |     68.0% |
| C        | C             | 46,417 (46,252–47,475) |   0.99 |   4.15 |      44.2 |          161.6k |     84.8% |
| chain-2  | A             | 43,619 (42,487–44,779) |   1.05 |   5.90 |      88.6 |          299.0k |     60.3% |
| chain-2  | B             | 53,208 (52,420–53,288) |   0.80 |   4.54 |      69.3 |          232.7k |     86.3% |
| chain-2  | C             | 35,736 (35,573–36,523) |   1.49 |   4.50 |      59.0 |          205.6k |     94.5% |

Nothing regresses per op: B is 11–22% faster and C is the cheapest per op. C is 14–18% slower in ops/s because 2 JS threads used about 2.05 of the 4 cores (CPU µs/op × ops/s). The warm row is a fresh target after one read-all pass, so the caches were still taking their first touches: B and C's 68–95% are not their steady state.

**At 2x (17.2M records), 3 reps each, medians over settled reps.** `memory-sweep.mts --cells=…` (below). Every sample restores the snapshot inside its own 8 GiB cgroup and warms up in chunks of 2M record reads until three agree (ceiling 12). Two of the 33 rows hit the ceiling and are excluded: A on C (rep 3) and B on chain-2 (rep 3). Record-cache counts, heap and major-GC rates come from the probe over the measured run. GC phases come from the `--profile` window. pg-redis's hit rate is Redis's.

| workload | configuration  |        ops/s (min–max) | p50 / p99 ms | CPU µs/op | instructions/op | cache hit | immediate VT, share of hits | strong records/thread | peak heap/thread | anon / file GiB | disk refaults/op | block-cache hit |
| -------- | -------------- | ---------------------: | -----------: | --------: | --------------: | --------: | --------------------------: | --------------------: | ---------------: | --------------: | ---------------: | --------------: |
| C        | A `harper-uws` | 39,902 (39,853–39,950) |  1.16 / 6.79 |      92.7 |          266.2k |     37.5% |                       97.2% |                   12k |          118 MiB |     2.84 / 5.04 |             0.68 |           13.6% |
| C        | B `-rc3g-4t`   | 36,943 (30,949–40,344) |  1.18 / 7.41 |      95.2 |          263.7k |     44.9% |                       98.3% |                  140k |          658 MiB |     3.59 / 4.24 |             0.78 |            3.4% |
| C        | C `-rc3g-2t`   | 35,095 (32,536–36,457) |  1.48 / 6.12 |      76.4 |          247.2k |     48.2% |                       96.5% |                  262k |        1,417 MiB |     3.89 / 3.93 |             0.81 |            2.6% |
| C        | pg-redis       | 27,293 (26,772–27,813) |  1.84 / 9.19 |     142.2 |          345.5k |     60.6% |                           – |                     – |                – |     3.38 / 3.17 |             0.96 |               – |
| chain-2  | A              | 22,754 (21,671–25,498) | 1.71 / 11.64 |     154.8 |          405.3k |     56.6% |                       97.4% |                   13k |          122 MiB |     2.86 / 5.02 |             1.15 |           20.2% |
| chain-2  | B              | 21,348 (20,165–22,530) | 2.11 / 14.00 |     157.9 |          400.2k |     66.1% |                       99.0% |                  162k |          663 MiB |     3.67 / 4.15 |             1.74 |            3.6% |
| chain-2  | C              | 19,679 (18,476–22,562) | 2.11 / 17.43 |     125.0 |          366.1k |     69.7% |                       98.1% |                  332k |        1,460 MiB |     3.94 / 3.88 |             1.44 |            2.8% |
| chain-2  | pg-redis       | 14,236 (14,156–14,610) | 3.56 / 15.67 |     273.3 |          663.5k |     79.3% |                           – |                     – |                – |     3.38 / 3.19 |             1.43 |               – |

| workload C, 2x             |                  ops/s | CPU µs/op | cache hit | immediate VT | GC µs/op: scavenge / major marking / all GC | major GCs per s per thread |
| -------------------------- | ---------------------: | --------: | --------: | -----------: | ------------------------------------------: | -------------------------: |
| A                          |                 39,902 |      92.7 |     37.5% |        97.2% |                            5.5 / 5.2 / 13.9 |                       0.68 |
| B                          |                 36,943 |      95.2 |     44.9% |        98.3% |                            6.2 / 5.0 / 14.4 |                       0.10 |
| C                          |                 35,095 |      76.4 |     48.2% |        96.5% |                            7.6 / 1.8 / 11.7 |                       0.07 |
| B, default 128K-slot table | 38,138 (36,402–38,198) |      96.4 |     45.2% |        93.0% |                            6.3 / 5.6 / 15.4 |                       0.11 |
| A, 16M-slot table          | 36,320 (36,082–39,707) |      95.0 |     37.1% |        99.8% |                            5.4 / 4.6 / 13.2 |                       0.64 |
| A, 2 threads               | 32,194 (31,203–32,724) |      81.5 |     37.9% |        97.0% |                            7.8 / 4.5 / 15.8 |                       1.05 |
| pg-redis (Fastify's GC)    |                 27,293 |     142.2 |     60.6% |            – |                            5.2 / 6.1 / 14.3 |                          – |

What the numbers say:

- **A Redis-sized cache on 4 threads does not pay at 2x.** B is 6–7% below A on both workloads, inside the rep spread on C (B's reps run 30.9k–40.3k), and spends 2–3% more CPU per op. It gains 7–10 points of hit rate. The memory came out of the page cache (5.04 → 4.24 GiB) and the block cache (2 GiB → 512 MiB, hit rate 13.6% → 3.4%), so the misses left cost more. RocksDB's file reads after a block-cache miss rose from 6.6–7.9 to 7.4–8.5 µs/op on C (11.5–11.8 → 12.7–15.1 on chain-2). That offsets the binding and decode work that the extra hits save.
- **The hit rate cannot rise much on this workload.** YCSB's scrambled zipfian draws ranks over 10¹⁰ items and folds them onto the keys with a hash. Computed from its constants, an ideal LRU hits 40% with 13k entries, 50% with 166k, 54% with 410k and 63% with Redis's ~2.9M keys (Redis measured 60.6%). B and C sit on that curve, a few points below it from first touches per thread. Each thread caches the same hot set, so four 768 MiB caches cover about what one would.
- **The cache holds far fewer records strongly than its size says.** Under this load, weak-lru-cache's LRFU ring kept 140–162k records per thread strongly, 34–40% of B's 410k capacity, and 262–332k of C's 820k (32–40%). Every promotion leaves a hole in the generation it leaves, which is refilled only when that generation's write position comes round again. Heap still reached 658 MiB per thread for B: the weak tier and garbage between major GCs fill the rest. A configured entry count is therefore neither a byte budget nor a record count.
- **A large old generation costs little GC here, as far as these caches filled.** B held 262–304 MiB of records strongly per thread and C 0.48–0.61 GiB (strong records × 1,965 bytes). The rest of their heap was the 42–53 MiB baseline, garbage, and evicted records still behind `WeakRef`s. Marking walks the cache Map, the `WeakRef` wrappers and the `FinalizationRegistry` cells. It does not walk the evicted records, nor their `Entry` objects, which `entryMap` holds only while the record is otherwise reachable. With the heap limit raised to fit the cache, V8 runs a major GC 7–10x less often (0.07–0.10 per second per thread against A's 0.68). Major marking stays at A's level for B (5.0 vs 5.2 µs/op) and falls to 1.8 for C (4.5 for the 2-thread stock control). B's scavenges cost 0.7 µs/op more, from cached records surviving to old space; C's 7.6 matches the 2-thread control's 7.8. Total GC: A 13.9, B 14.4, C 11.7 µs/op (2-thread control 15.8). Peak heap per thread was 658 MiB for B (limit 1176) and 1,417 MiB for C (limit 2288). No sample hit an OOM kill.
- **2 threads cannot use 4 cores.** C and the 2-thread stock control use 2.6–2.7 of the 4 cores (CPU µs/op × ops/s), against 3.5–3.7 for A and 3.9 for pg-redis. At 2 threads the large cache does pay: C is 9% faster than the 2-thread stock control and 6% cheaper per op. That still leaves it 12% below A, and on chain-2 14% below.
- **The verification-table size is not the limit at 2x.** With the default 128K slots, B's immediate VT share is 93.0% against 98.3% at 16M, and throughput is within noise. A with a 16M-slot table gains nothing either (97.2% → 99.8% immediate, ops/s within noise). One reason the small table holds up is the rocksdb-js gap above: at 2x, 26–53% of lookups go to the thread pool, and those cold reads never write a slot. Once that is fixed, cold reads will overwrite slots, and the table will have to be sized with the cache.
- **Harper leads pg-redis at 2x** by 1.46x on C and 1.60x on chain-2 (A against pg-redis, at this head: #3837 and #3850 included).

**Recommendation.** A byte-sized record cache is worth a product change, but not one sized to a Redis-like share when the dataset outgrows memory.

- **Size it in bytes, not entries.** An entry count does not track memory. A ~1 KiB record holds 1,965 heap bytes. A record takes twice as many ring positions each time its size doubles (the expiration priority). Under load, the LRFU ring holds 32–40% of its nominal capacity strongly while the weak tier keeps more in the heap. The product setting should be a per-thread byte budget, enforced against measured or estimated record bytes. The heap limit should be derived from it.
- **Grow it toward the dataset when the dataset fits, and keep it small when it does not.** Warm, where everything fits, the large cache is 11–22% faster at 13–22% less CPU per op. At 2x it buys a few points of hit rate at 4x duplication and loses on page cache. A budget-derived rule that matches both rows: record cache per thread = min(dataset's decoded size, a modest share of the heap budget), with the rest of the 8 GiB left to the block cache and page cache. Those are shared by every thread and hold about 4 records per 4 KiB block. These runs did not measure a share between ~25 MB and 768 MiB per thread. The next experiment should sweep 64/128/256 MiB per thread at 0.5x and 2x.
- **Threads: one per core (4 here).** 2 threads with twice the cache are the cheapest per op but leave 1.3 cores idle and lose 12–18% throughput, warm and at 2x.
- **GC was not the obstacle at the sizes reached.** With up to 0.61 GiB per thread held strongly and the heap limit at 2.2 GiB, major GCs became rare and marking per op did not grow. A cache held fully resident at 1.5 GiB per thread was not measured. Marking scales with the live set, so that size needs its own run.
- **Do these first; they are cheaper than any size change.**
  1. Pass `POPULATE_VERSION_FLAG` through rocksdb-js's thread-pool fallback, so that a cold read from disk seeds the VT.
  2. Drop the transaction's repeated block-cache probe. A read that misses the block cache makes three RocksDB lookups, one of them redundant, and those reads are 26–53% of lookups at 2x.
  3. Expose `verificationTableEntries` in Harper's config and size it with the record cache. It costs 8 bytes per slot.

**Method.** Harper `f916e39`, i7-12700H, turbo off, target cpuset `0,2,4,6` for every configuration, generator on other cores, `bench-run --bench-cpus 0-15`. A host gate before each sample waited up to 1 min for the rest of the host to use under 3 cores; noisy measured runs were measured once more. The probe was a temporary patch of `dist/resources/PrimaryRocksDatabase.js`, not committed, installed by renaming a generated file over the clean build's and restored by a shell trap. `meta.harper.digests` in each results file shows which build it ran. Per HTTP thread, it appended to a JSON-lines file every 100 ms: cumulative counters inside `getEntry` (lookups, cache hits, FRESH answers synchronous and asynchronous, thread-pool reads, decodes, cold reads); the database's `rocksdb.number.keys.read`, block-cache hit, miss, capacity and usage; `v8.getHeapStatistics()`; `PerformanceObserver` GC counts and pauses by kind; and, every 30 s, a scan of the LRFU ring for strongly held entries. The report differences each thread's first and last ticks at least 250 ms inside the measured run and works in rates per thread. Immediate VT hits = lookups − (RocksDB Gets − 2 × thread-pool reads), checked standalone against a 64-slot and a 16M-slot table, with and without a transaction. GC phases come from `profile-report.mts` (`gcPhase`, innermost frame that names a phase). Disk refaults are `memory.stat` `workingset_refault_file` over the workload.

```sh
node benchmarks/ycsb-vs-pg/run-compare.mts --cache=warm --scale=standard --targets=harper-uws,harper-uws-rc3g-4t,harper-uws-rc3g-2t --workloads=C,chain-2 --ops=1000000 --reps=3 --perf-counters --host-quiet-cores=3 --host-quiet-max-min=1
node benchmarks/ycsb-vs-pg/memory-sweep.mts --reps=3 --profile=<dir> --profile-ops=400000 --host-quiet-cores=3 --host-quiet-max-min=1 --noisy-retries=1 --warmup-chunk=2000000 --warmup-max-chunks=12 \
  --cells=2:C:harper-uws,2:C:harper-uws-rc3g-4t,2:C:harper-uws-rc3g-2t,2:C:pg-redis,2:C:harper-uws-rc3g-4t-vt128k,2:C:harper-uws-vt16m,2:C:harper-uws-2t,2:chain-2:harper-uws,2:chain-2:harper-uws-rc3g-4t,2:chain-2:harper-uws-rc3g-2t,2:chain-2:pg-redis
node benchmarks/ycsb-vs-pg/profile-report.mts <memory-sweep results>.json
```

## Token authentication on both sides (`--auth=token`, 2026-10-31)

Warm row, 3 reps per cell, alternating `none` and `token` invocations. A host gate before each sample waited up to 1 min for the rest of the host to use under 2 cores (32 of 36 samples got there; every row records it). Harper runs with local trust off: a role that is not `super_user` and is limited to the benchmark table, and that user's RS256 operation token. Fastify verifies an HS256 JWT with `@fastify/jwt` (fast-jwt) on every request. Both receive the same `Authorization: Bearer` header. Method details are in the [README](README.md#authentication---auth). Instructions per op are the stable metric; ops/s move with load from other agents on the host.

| workload | target             | ops/s, none → token      | CPU µs/op, none → token | instructions/op, none → token |
| -------- | ------------------ | ------------------------ | ----------------------: | ----------------------------: |
| C        | harper-uws         | 47,273 → 45,245 (−4.3%)  |             79.8 → 84.1 |       260.0k → 272.8k (+4.9%) |
| C        | harper (Node HTTP) | 37,525 → 35,230 (−6.1%)  |            99.8 → 109.0 |       297.0k → 322.8k (+8.7%) |
| C        | pg-redis           | 52,200 → 47,408 (−9.2%)  |             67.3 → 79.2 |      218.5k → 265.4k (+21.5%) |
| B        | harper-uws         | 35,554 → 33,977 (−4.4%)  |           106.0 → 112.5 |       290.1k → 305.8k (+5.4%) |
| B        | harper (Node HTTP) | 29,637 → 28,095 (−5.2%)  |           129.6 → 137.5 |       321.6k → 347.3k (+8.0%) |
| B        | pg-redis           | 44,352 → 36,547 (−17.6%) |            82.8 → 101.2 |      219.0k → 277.7k (+26.8%) |

With a verified credential on both sides, pg-redis's lead at warm C narrows from 1.10x to 1.05x, and at warm B from 1.25x to 1.08x.

Where the added cost goes, from one profiled window per side at warm C:

- **Fastify: +11.9 µs/op, of which the auth bucket is 13.7 µs/op.** Every request decodes the token (base64url and `JSON.parse` of header and payload, fast-jwt `decoder.js`, ~5.4 µs/op), computes HMAC-SHA256 (`crypto.js`, ~5.2), and goes through `@fastify/jwt`'s request plumbing (~2), plus a charset regex check. Nothing is cached, which is the plugin's default. fast-jwt's verifier cache would remove most of it at some memory cost.
- **Harper: +7.1 µs/op in the profiled window, of which the auth bucket grows only 2.9 → 4.2 µs/op.** The RS256 signature is checked once per token per thread: `authorizationCache` maps the header to the user and is cleared every `authentication.cacheTTL` (30 s), so `jsonwebtoken` does not appear in the profile. Per request, Harper pays:
  - the cache lookup and expiry check;
  - `isCurrentUser` (`security/user.ts`, 0.4 µs/op), which compares the cached user's and role's record versions with the stored ones so a change takes effect at once;
  - a `cloneUserView` copy;
  - the role's table-permission check in `allowRead`.

  The rest of Harper's increase is outside authentication: the uWS layer copies the longer header into JS (+1.0 KB/request allocated there) and GC rises by 1.8 µs/op. Node's HTTP parser costs more for the same header: harper (Node HTTP) adds +25.8k instructions/op against harper-uws's +12.8k.

## Harper's request pipeline by layer, with allocation (warm C, 2026-10-31)

harper-uws, warm C, local trust (`--auth=none`), Harper `85bafde3`. CPU from a fresh 1M-op `perf record` window (76.3 CPU µs/op at 49.9k ops/s, 2.6 cores busy elsewhere on the host). `profile-report.mts --pipeline` charges each sample to the innermost layer on its stack. "With inner layers" sums down the chain rather than measuring stack containment, because work resumed after an `await` has lost its callers' frames. Allocation comes from V8's sampling heap profiler: an in-thread inspector session in each HTTP thread, 1 KiB sampling interval, including objects already collected by minor and major GC, over 40k requests per thread. That probe was temporary and is not committed. Allocation sites are the innermost non-builtin frame.

| layer (outermost first)                       | own µs/op | with inner layers | bytes/request | objects/request |
| --------------------------------------------- | --------: | ----------------: | ------------: | --------------: |
| uWS HTTP: native and `uwsServer.ts`           |      20.0 |              58.1 |         1,974 |            34.2 |
| `http.ts` handle, middleware chain            |       2.1 |              38.1 |         1,518 |            13.7 |
| authentication middleware (`auth.ts`)         |       1.3 |              36.0 |         2,392 |            21.0 |
| REST handler (`REST.ts`)                      |       2.2 |              34.7 |         1,846 |            15.6 |
| request transaction (JS and native lifecycle) |      10.2 |              32.5 |         2,734 |            36.3 |
| resource resolution, context                  |       1.7 |              22.2 |           814 |             8.7 |
| `Table.get`                                   |       2.5 |              20.5 |           558 |             9.3 |
| record cache (weak-lru-cache, VT)             |       1.5 |              18.1 |           230 |             2.6 |
| RocksDB read                                  |      11.1 |              16.6 |           524 |             6.3 |
| record decode                                 |       2.8 |               5.5 |         1,801 |            12.9 |
| response serialization (JSON)                 |       2.7 |               2.7 |         1,025 |             6.8 |
| response headers (handled by the header task) |       2.9 |                   |         1,588 |            34.1 |
| GC                                            |      11.5 |                   |               |                 |
| event loop, microtasks; JIT; other            |       3.7 |                   |           135 |             3.4 |
| **total**                                     |  **76.3** |                   |    **17,138** |       **205.0** |

By stack containment (each function once per stack), the uWS `bodyless` callback is 32.4 µs/op inclusive. Below it: `http.ts` `handle` 30.3, `authentication` 30.3, `REST.ts` `http` 30.0, `transaction()` 24.7, `REST` `dispatch` 23.9, `Resource.applyContext` 23.6, `Table.getResource` 22.8, `loadLocalRecord` 16.8, rocksdb-js `get` 12.3. Each stage adds only 0.1–2 µs/op of its own CPU. The cost is spread thin, and the larger part of it is allocation: 17.1 KB and ~205 objects per GET of a 1 KB record, against GC at 11.5 µs/op. The largest single sites are the big `async` stage functions themselves: `authentication` 2.4 KB, `onRequest` 1.8 KB, `REST.http` 1.7 KB, `transaction()` 1.6 KB, `handle` 1.2 KB. Each await suspends a large frame, and their closures, promises and strings are allocated anew per request. From `http.ts` down to `Table.get`, the layers' own CPU is 20.0 µs/op. Of that, 10.2 is the request transaction (its JS commit path and the native transaction's lifecycle); the other 9.8 is spread over ~25 functions at 0.1–1 µs/op each. Those layers allocate ~10 KB per request. Header assembly is excluded here, since the header task covers it: 2.9 µs/op own, 1.6 KB and 34 objects per request.

String internalization (`StringTable::LookupKey`, hash computation) is ~3% of Harper's samples, ~2.3 µs/op, spread across layers:

- header names from uWS used as object keys (`uwsServer.ts:126`);
- option names that native code reads by name (`getReadTxn`'s `new RocksTransaction(store, { coordinatedRetry, disableSnapshot })`);
- path slices looked up in `Resources.getMatch` (`Resources.ts:276`);
- header assembly.

### Ranked reductions

Estimates are CPU µs/op at warm C, from the self time of the named frames plus GC pro-rata to the bytes removed. GC is 11.5 µs/op for 17.1 KB/request, so ~0.67 µs per KB; that is a rough average, since scavenge cost follows survivors more than garbage. None is measured as a change.

| #   | reduction                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | where                                                                                     |                              estimate |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- | ------------------------------------: |
| 1   | **A read-only commit fast path.** Every GET commits its request transaction through `commit` → `performCommit` → `endCommitAttempt`, which build the write, completion and retry bookkeeping for a transaction with no writes. That is 3.7 µs/op inclusive, of which 1.8 is the native abort, and ~0.9 KB / 17 objects per request. A transaction with no writes and no completions could release its read handle and return. This is the JS side of held candidate 2; the native transaction and its abort stay.                                                                                                                                                                                                | `resources/transaction.ts:82` → `resources/DatabaseTransaction.ts:2651`, `:2893`, `:2799` |                               1.5–2.5 |
| 2   | **A cheaper uWS request adapter.** Per request it allocates 1.8 KB / 29 objects: a fresh upper-cased method string (`:122`), a header object keyed by fresh name strings that get internalized (`:126`, ~0.2 µs/op), the peer address through `Buffer.from(...).toString()` and `normalizeAddress` (`:139`), an `AbortController` plus an `onAborted` closure (`:141`; `get signal` 0.19 µs/op), a `dispatch` closure and two `when` callbacks (`:153`). Use constant method strings, map known header names to constants, read the address lazily while `res` is live, and create the controller on first use. Lazy creation only helps if `transaction.ts:63` stops reading `context.signal` on every request. | `server/serverHelpers/uwsServer.ts:120-175`                                               |                                 1–1.5 |
| 3   | **Authentication's per-request setup on the local-trust path.** 2.4 KB / 21 objects per request. The session cookie prefix runs two regex replaces and a concatenation even when no `Cookie` header is sent (`:181`). Every request also gets an empty `request.session` object (`:191`), an `authAuditLog` closure (`:194`), and fresh `request.session.update` and `request.login` closures (`:429`, `:494`) that almost no request calls. Skip cookie parsing without a cookie, and put the session methods on a prototype or create them on first use.                                                                                                                                                       | `security/auth.ts:134-500`                                                                |                                 0.5–1 |
| 4   | **Async wrappers that only forward.** The REST registration wrapper is `async` just to return `http(...)` (`REST.ts:840`), and `handle` awaits `normalizeUwsBody` even for a string body (`http.ts:1257`). Each adds an async function, a promise and a microtask turn per request. Make the wrapper a plain function, and check for a string or Buffer before awaiting.                                                                                                                                                                                                                                                                                                                                         | `server/REST.ts:840`, `server/http.ts:1257`                                               |                               0.4–0.6 |
| 5   | **`RequestTarget` per request.** `decodeURIComponent` runs on every id (`:130`; `Uri::Decode` 0.19 µs/op) though record ids rarely contain `%`; test `includes('%')` first. The class extends `URLSearchParams` (`:115`), so a search-params object is built for every path-only GET (213 B / 2.2 objects); not doing so is a larger API change.                                                                                                                                                                                                                                                                                                                                                                 | `resources/RequestTarget.ts:115,130`                                                      | 0.2 (decode); +0.2 for the base class |
| 6   | **Native option objects read by name.** Native code reads `{ coordinatedRetry, disableSnapshot }` (and the get options) with named-property lookups, which internalize the name on every call (`SequentialStringKey`, 0.22 µs/op in the transaction layer). Positional arguments or flags avoid it. This extends candidate 5 above to the transaction constructor.                                                                                                                                                                                                                                                                                                                                               | `resources/DatabaseTransaction.ts:1176`; rocksdb-js `Transaction` constructor             |                               0.3–0.5 |
| 7   | **Per-request strings built for analytics.** `'response_' + status` is concatenated even with analytics off (`http.ts:1245`). With analytics on (the default, but off in this harness), four `recordAction` calls per request each concatenate and hash a key (`resources/analytics/write.ts:146`); `actionRecorder` already exists to build the key once.                                                                                                                                                                                                                                                                                                                                                       | `server/http.ts:1240-1245`                                                                | ~0 here; unmeasured with analytics on |

Remaining share of header assembly, for the header task: 2.9 µs/op own and 1.6 KB / 34 objects per request. That covers `applyResponseHeaders` 0.51, `writeHeaders` 0.35, `addVaryHeader` 0.24, the `Vary` split and lowercase, the internalization of header names, and the `Server-Timing` value (`http.ts:1170`, `:1237`: two `performance.now()` calls and a `toFixed(2)` per request, 0.2 µs/op in the `http.ts` layer).

## Flame graphs

Static SVGs (root at the bottom; hover a frame for its share), colored by bucket:
[harper-uws C warm](profiles/harper-uws-C-warm-rep2.svg) ·
[pg-redis C warm](profiles/pg-redis-C-warm-rep1.svg) ·
[harper-uws B warm](profiles/harper-uws-B-warm-rep2.svg) ·
[pg-redis B warm](profiles/pg-redis-B-warm-rep1.svg) ·
[harper-uws C 2x](profiles/harper-uws-C-2x-rep1.svg) ·
[harper-uws B 2x](profiles/harper-uws-B-2x-rep1.svg) ⚠

## Method

- **Points.** Warm: `run-compare.mts --cache=warm --scale=standard` (200k records, read-all pass, 100% Redis hits), 2 reps. 2x: `memory-sweep.mts --cells=2:C:harper-uws,2:B:harper-uws` (17.2M records restored from a snapshot inside the sample's 8 GiB cgroup, zipfian warmup to a plateau). Both with `--profile`.
- **Windows.** After the measured run, `--profile` runs 1M more ops under `perf stat` only (the counters above), then 1M ops under `perf record -C <target cpus> --all-cgroups -g -F 999`. The measured run itself carries JIT warmup when the profiler flags are on (harper-uws C warm: 29.5k ops/s there, 43.5k after), so its counters are not used.
- **Symbols.** Targets run with `--perf-basic-prof --interpreted-frames-native-stack`. V8 never retracts a perf-map entry, so an address reused by newer code keeps the old name; folding rewrites each target process's map so the newest entry wins. `perf script --no-inline`: inline resolution through node's debug info takes minutes per profile.
- **Buckets** (`profile-report.mts`): GC and JIT by any frame on the stack, everything else by the innermost recognized frame, so builtins, malloc and syscalls go to the code that called them. Socket writes go to the nearest JS caller (HTTP, ioredis or pg); socket reads cannot be split, so the stack's HTTP bucket includes reading Redis replies.
- **Kernel.** `kptr_restrict=1` on this host hides kernel symbols; kernel samples are attributed through the user-space frame that entered the kernel.
- **Quiet reps.** Each column is the rep with the fewest other cores busy during its profile window (measured from /proc/stat minus this run's cgroups).
- **Host.** i7-12700H, turbo off (P-cores at 2.3 GHz), target cpuset `0,2,4,6`, generator on `8-19`, Node v26.2.0, real disk.

Reproduce:

```sh
node benchmarks/ycsb-vs-pg/run-compare.mts --cache=warm --scale=standard --workloads=C,B --targets=harper-uws,pg-redis --reps=2 --profile=<dir>
node benchmarks/ycsb-vs-pg/memory-sweep.mts --cells=2:C:harper-uws,2:B:harper-uws --profile=<dir> --warmup-chunk=2000000 --warmup-max-chunks=10
node benchmarks/ycsb-vs-pg/profile-report.mts benchmarks/ycsb-vs-pg/results/<file>.json --svg-dir=<dir>
# token auth matrix (one invocation per rep and mode), and the pipeline view of a profile
node benchmarks/ycsb-vs-pg/run-compare.mts --cache=warm --scale=standard --workloads=C,B --targets=harper-uws,harper,pg-redis --perf-counters --host-quiet-cores=2 --host-quiet-max-min=1 --auth=token
node benchmarks/ycsb-vs-pg/profile-report.mts benchmarks/ycsb-vs-pg/results/<file>.json --pipeline
```

The weak-tier counts (2026-11-01) came from a temporary patch of `node_modules/weak-lru-cache/dist/index.cjs`, installed by renaming a generated file over the stock one and checked against the 1.2.3 tarball's SHA-256 before every stock run. Per HTTP thread it appended cumulative counters to a JSON-lines file every 100 ms. The report differenced the first and last ticks at least 250 ms inside `[window.startMs, window.startMs + result.elapsedMs]`. 1.2.2 came from `npm pack weak-lru-cache@1.2.2`. The 2026-10-31 record-cache counts and the allocation profiles came from temporary instrumentation patched into `dist/resources/PrimaryRocksDatabase.js`, not committed. The cache probe counted `getValue` hits and their `Entry` lookups, checked the VT with `verifyVersion` before each read, and counted native results, `setValue` calls and cache-Map deletions. The allocation probe started an in-thread inspector session, `HeapProfiler.startSampling` with `includeObjectsCollectedByMinorGC` and `includeObjectsCollectedByMajorGC`, for 40k usertable reads per HTTP thread.
