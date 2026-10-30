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

## Ranked optimization candidates

Estimates are CPU µs/op at the point named, from the bucket and frame costs below; none is measured as a change. All are proposals for separate work: this PR changes no product code.

| #   | candidate                                                                                                                                                                                                                                                                                                                                                                                                 | where                                                                                                                                                   | estimated gain                                                                                                                                                                                                                                                                                                                  | risk                                                                                                                                                                                            |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | **Bloom filters on SST files.** rocksdb-js builds `BlockBasedTableOptions` with no `filter_policy`, so a point read probes every overlapping file: index-block search, block-cache lookup and often a data-block read per L0 file and per level. B flushes a ~15.5 MiB memtable every few seconds (150 flushes in one 2x B sample), so L0 holds several files.                                            | rocksdb-js `src/binding/database/db_descriptor.cpp:205`                                                                                                 | 2x C: SST probing costs 21.5 µs/op (block reads 8.8, block cache 4.3, index search 3.8, SST/version 4.6); filters should save a third to a half, **7–11 µs/op (6–9%)**. 2x B: probing costs 49.6 µs/op, so **15–25 µs/op (8–12%)**. ~0 at warm C.                                                                               | Low–medium. About 1.25 B/key of filter memory charged to the block cache (21 MiB at 2x, 86 MiB at 8x); existing SSTs get filters only as they are rewritten; build CPU at flush and compaction. |
| 2   | **A RocksDB transaction for every read.** Each request gets a `DatabaseTransaction` (`transaction.ts:52`), whose first read opens a native `RocksTransaction` (`DatabaseTransaction.ts:1176`); the request then commits it (`transaction.ts:79` → `DatabaseTransaction.ts:2651`) and the native side aborts it. Native `Transaction::Constructor` alone is 4.0 µs/op and `Abort` 1.9.                     | `resources/transaction.ts:52,79`, `resources/DatabaseTransaction.ts:1162-1196`, `:2651`                                                                 | Whole lifecycle **9.0 µs/op at warm C (11.8%)**, ~11 at 2x C, plus the GC its allocations cause. (a) Read a single key without a native transaction, opening one only on a second read or a write: most of the 9.0. (b) Reuse native transaction objects in rocksdb-js (RocksDB's `BeginTransaction(..., old_txn)`): 3–4 µs/op. | (a) Medium–high: snapshot consistency across reads, record locks, cancellation and replication all hang off this object. (b) Low–medium.                                                        |
| 3   | **Response header assembly.** Every local-trust response resolves a principal, so it takes the identity-dependent branch of `applyResponseHeaders`: Headers normalization, a `Vary: Authorization` merge that splits and lowercases the existing value, and `Cache-Control: private, no-cache`. Then `writeHeaders` copies the Headers map into uWS. The closure and its array are allocated per request. | `security/auth.ts:523` (inside `authentication`, `:134`), `server/serverHelpers/Headers.ts:72,91`, `server/serverHelpers/uwsServer.ts:293`              | **~3.7 µs/op at warm C (5%)**: `applyResponseHeaders` 1.6, `writeHeaders` 1.1, `addVaryHeader` 0.6, `appendHeader` 0.4. Precomputing the constant header pair and writing straight to uWS should recover 2–3.                                                                                                                   | Low. The #1565/#1518 cache-partitioning semantics must stay.                                                                                                                                    |
| 4   | **JSON per record version.** On a record-cache hit Harper re-serializes the same object for every request; on a miss it also decodes it. The stack returns the stored bytes. Caching the JSON with the cached record (keyed by version, dropped with the record) serves a whole-record GET without `select` from bytes.                                                                                   | `server/serverHelpers/contentTypes.ts:511` (`serialize`), `resources/PrimaryRocksDatabase.ts:133` (`getEntry`), `resources/RecordEncoder.ts` (`decode`) | Serialize 2.7 + decode 2.7 + entry wrapping 0.9 = **6.3 µs/op at warm C (8%)**; the hit-path share of that, plus GC.                                                                                                                                                                                                            | Medium: memory for a second copy of hot records, content negotiation, keeping the representation exact.                                                                                         |
| 5   | **rocksdb-js `get` binding overhead.** Around the engine's 5.8 µs/op `DBImpl::GetImpl`, `Database::GetSync` spends ~2.4 µs/op: option-object property reads (`getProperty<bool>` 0.7), a separate `isOpen()` napi call before every get (0.5), version-table checks (1.0).                                                                                                                                | rocksdb-js `dist/index.cjs:880` (`getBinaryFast` → `isOpen()`), native `Database::GetSync`                                                              | **1–1.5 µs/op (2%)** from positional flags and folding the open check into the get.                                                                                                                                                                                                                                             | Low.                                                                                                                                                                                            |
| 6   | **Prefetch through the libuv pool under memory pressure.** At 2x the record loader's prefetch mode sends a share of reads to the thread pool: pool threads 15.6 µs/op, completions 16.2 µs/op inclusive, 0.93 context switches/op (0.10 at warm). The pool shares the same 4 cores, so the hop buys concurrency only while a read waits on disk.                                                          | `resources/Table.ts:11161-11330` (`loadRecord` prefetch feedback, `loadPrefetchedRecord`)                                                               | Uncertain, **−5 to +10 µs/op at 2x**: measure 2x and 8x with prefetch off, and try `MultiGet` for bundled ids.                                                                                                                                                                                                                  | Medium.                                                                                                                                                                                         |
| 7   | **GC at 2x.** GC doubles from warm to 2x (11.2 → 20.3 µs/op; scavenge 3.9 → 8.2, major marking 4.8 → 8.3), consistent with decoded records surviving one scavenge in the weak record cache and dying later. HTTP threads get a 16 MiB young generation under an 8 GiB cap (`maxOldMemory >> 6`, floor 16).                                                                                                | `server/threads/manageThreads.ts:1363`                                                                                                                  | Candidates 2–4 cut allocation directly. A larger young generation is a cheap experiment, maybe 2–4 µs/op at 2x.                                                                                                                                                                                                                 | Low (memory).                                                                                                                                                                                   |

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
```
