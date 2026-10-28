# Harper vs. a conventional Node stack (YCSB over REST)

A rough head-to-head: the same YCSB-style REST workload driven against

| Target         | What answers the request                                                                              |
| -------------- | ----------------------------------------------------------------------------------------------------- |
| `harper`       | Harper core (this checkout's `dist/`), `usertable` over REST — database, cache and app in one process |
| `harper-sized` | Same, with `HARPER_RECORD_CACHE_SIZE` raised to the next power of two ≥ the record count              |
| `harper-base`  | Another Harper build (`--base-harper=<dist/bin/harper.js>`), driven by this harness                   |
| `pg-redis`     | Fastify → Redis look-aside cache → Postgres                                                           |
| `pg-only`      | Fastify → Postgres (no cache), to isolate what the cache is buying                                    |

It reuses `benchmarks/ycsb` **unchanged** — same load generator, same key
distributions, same workload mixes, same 10 × 100 B record shape. The only
variable is the server. See `benchmarks/ycsb/README.md` for the workload
definitions (A–F) and the REST operation mapping.

## Running

```sh
npm run build                     # dist/bin/harper.js, which the harper target spawns
npm ci --prefix benchmarks/ycsb-vs-pg/pg-app   # Fastify, pg, ioredis for the conventional stack
docker --version                  # postgres + redis run via docker compose
node benchmarks/ycsb-vs-pg/run-compare.mts --scale=standard
node benchmarks/ycsb-vs-pg/run-compare.mts --scale=quick --workloads=C,A --targets=harper,pg-redis
```

All `benchmarks/ycsb` flags apply, plus:

| Flag                           | Default           | Meaning                                              |
| ------------------------------ | ----------------- | ---------------------------------------------------- |
| `--targets`                    | `harper,pg-redis` | Targets to compare (table above)                     |
| `--target-cpus=K`              | `4`               | Size of the CPU set every target runs on             |
| `--serverCpus`, `--driverCpus` | derived           | Explicit CPU lists instead of `--target-cpus`        |
| `--cache`                      | `warm`            | `warm` or `cold` (below)                             |
| `--base-harper`                | —                 | `dist/bin/harper.js` of the build `harper-base` runs |
| `--shards`                     | `4`               | Load-generator processes                             |
| `--reps`                       | `1`               | Independent samples per target × workload            |

`--threads` (Harper's worker threads and the Fastify cluster size) defaults to K.
Results land in `benchmarks/ycsb-vs-pg/results/`, written after every sample, with
a printed table at the end. Runtime scales with reps × workloads × targets: every
sample starts a fresh server and reloads the dataset.

## Method

- **Equal CPU budget.** Each target, as a whole, runs on the same K CPUs:
  the Harper process, or the Fastify cluster plus the Postgres and Redis
  containers together (compose `cpuset`, no per-service quota — the stack
  picks its own split). The K CPUs are one logical CPU on each of K physical
  cores from the fastest core class (so the machine needs more than K physical
  cores); their SMT siblings stay idle. The load
  generator and the harness run on every CPU of the remaining physical cores.
  Affinity is set when each process is created (a `taskset` wrapper for Harper,
  `taskset -c` for Fastify, compose `cpuset` for containers) and every thread is
  checked before measuring; a sample with a thread outside its set fails.
- **Memory budget.** 8 GiB per target, recorded with the results. The pg stack
  splits it as postgres `mem_limit` 6g (`shared_buffers=4GB`), redis 1g
  (`maxmemory 768mb`) and the Fastify cluster the remainder. Host processes
  (Harper, Fastify) are measured, not limited: one cgroup spanning host
  processes and docker containers needs root. Peak memory is sampled every 2 s.
- **Headline is throughput at equal cores.** CPU µs/op (server CPU only), peak
  memory, Redis hit rate and p50/p99 of the primary operation sit beside it.
- **Cache state is set, not inherited.** After the load, a pass reads every key
  once. `--cache=warm` then requires the Redis hit rate over the measured run to
  be ≥ 99% (the sample fails otherwise) and records it; run `harper` and
  `harper-sized` to see Harper with the stock and a dataset-sized record cache.
  `--cache=cold` refuses `pg-redis` (cold Postgres is `pg-only`) and runs
  `harper` with `HARPER_RECORD_CACHE_SIZE=4`. That is reduced retention, not a
  true cold: the record cache cannot be disabled, and entries beyond the strong
  set stay reachable on WeakRefs until GC. Both "cold" engines still read from
  memory (RocksDB block cache, `shared_buffers`) when the dataset fits.
- **Postgres is vacuumed after the load.** `VACUUM (ANALYZE)` sets hint bits and
  planner statistics before measuring, as an operator would after a bulk load,
  and keeps an autovacuum triggered by the load out of the measured run.
- **Interleaved reps.** Reps are the outer loop: every (rep, workload, target)
  is a fresh server, dataset and read-all pass, then one measured run. Target
  order is forward on even reps and reversed on odd ones; each sample records
  its position. The table reports the median rep by throughput.

## How the conventional stack is built

`pg-app/server.mjs` is what a competent team would write, not a strawman:

- Fastify 5, one process per `--threads` with `SO_REUSEPORT` (kernel-balanced,
  no primary-process hop) — structurally the closest match to Harper's threads.
- `pg` with a connection pool and **named prepared statements**, so Postgres
  skips parse/plan on every request.
- `ioredis` with auto-pipelining. Reads are cache-aside; writes are
  write-through (upsert the row, then replace the cache line), which maximizes
  hit rate on the read-heavy workloads.
- Scans (`workload E`) bypass Redis, as they must — a range query can't be
  served from a key-value cache.

## Fairness notes

- **Same storage medium, and it is a real disk.** Both engines write under
  `YCSB_VS_PG_DATA_DIR` (default `benchmarks/ycsb-vs-pg/data`), and the runner
  refuses to start if that path is tmpfs or if the two data directories land on
  different devices. This is load-bearing: on tmpfs an `fsync` is a no-op, so
  Postgres would get `synchronous_commit=on` for free while Harper still paid
  real RocksDB compaction, quietly tilting every write-bearing workload.
- **Same durability setting.** Postgres keeps `fsync=on` /
  `synchronous_commit=on`, matching Harper's default `storage.writeAsync=false`.
- **Postgres is tuned, Harper is not.** `shared_buffers=4GB`,
  `effective_cache_size=6GB` — the stock 128 MB would make it a page-fault
  benchmark. Harper runs stock apart from `threads.count` and log level.
- **Identical response bodies.** The Fastify handler selects `id` alongside the
  fields so both targets return the same JSON keys and roughly the same bytes.
- **Every sample gets its own freshly started server, dataset and read-all pass.**
  This is the expensive option and it is load-bearing. Sharing one instance across workloads let each one inherit
  the last one's state — the record cache left resident by a preceding read
  sweep, the compaction backlog left by a preceding write burst — and the
  distortion was big enough to invert rankings: a 95%-read workload measured
  _slower_ than a 50%-write one, and a 100%-read workload measured 2.5x slower
  than the 95%-read workload that followed it.
- **The read-all pass touches every key through the target's own read path** —
  Redis for `pg-redis`, Postgres for `pg-only`, the record cache and RocksDB for
  Harper — so first-touch costs land before the measured run.
- **Everything is on one host**, including the load generator. Run
  `client-ceiling.mts` to confirm the reported numbers are server-bound rather
  than client-bound:

  ```sh
  node benchmarks/ycsb-vs-pg/client-ceiling.mts --target-cpus=4 --concurrency=64
  ```

  It serves a fixed in-memory record from a `node:http` cluster on the target
  CPUs and drives it with the same sharded driver on the same generator CPUs,
  for workload C (all shards) and E (one shard, since it inserts). Its result
  is the upper bound for any target on that machine.
