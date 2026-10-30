# Harper vs. a conventional Node stack (YCSB over REST)

A rough head-to-head: the same YCSB-style REST workload driven against

| Target             | What answers the request                                                                              |
| ------------------ | ----------------------------------------------------------------------------------------------------- |
| `harper`           | Harper core (this checkout's `dist/`), `usertable` over REST — database, cache and app in one process |
| `harper-sized`     | Same, with `HARPER_RECORD_CACHE_SIZE` raised to the next power of two ≥ the record count              |
| `harper-uws`       | `harper` with its plaintext HTTP port on uWebSockets.js (`HARPER_UWS_HTTP=1`) instead of Node's HTTP  |
| `harper-uws-sized` | `harper-uws` with the sized record cache                                                              |
| `harper-base`      | Another Harper build (`--base-harper=<dist/bin/harper.js>`), driven by this harness                   |
| `pg-redis`         | Fastify → Redis look-aside cache → Postgres                                                           |
| `pg-only`          | Fastify → Postgres (no cache), to isolate what the cache is buying                                    |

**Which change moved Harper's read numbers in September 2026.** The read-only gain
then (workload C 30.5k → 42k ops/s; Harper CPU-seconds 58 → 42) came from the HTTP
layer, not the record cache: Fastify's HTTP layer alone was 40.3 of the stack's 60.8
CPU-seconds on C, and serving Harper over uWebSockets.js moved C from 1.03x to 1.41x
of `pg-redis`. Sizing the record cache on top of uWS added about 12% (42.1k → 46.8k).
The `harper-uws*` targets keep that comparison in every run.

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
node benchmarks/ycsb-vs-pg/memory-sweep.mts --ratios=0.5,2,8   # dataset larger than memory, below
```

User systemd (`systemd-run --user`, memory controller delegated to the user manager)
is required: every host process runs in its own capped scope.

All `benchmarks/ycsb` flags apply, plus:

| Flag                           | Default           | Meaning                                              |
| ------------------------------ | ----------------- | ---------------------------------------------------- |
| `--targets`                    | `harper,pg-redis` | Targets to compare (table above)                     |
| `--harper-memory`              | `capped`          | `capped` (8 GiB cgroup) or `measured` (no cap)       |
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
- **Equal memory budget, enforced.** 8 GiB per target, every target. Every component runs in its
  own memory cgroup with a hard cap and swap off: Harper in a user systemd scope
  capped at 8 GiB, the Fastify cluster in one capped at 1 GiB, Postgres and Redis
  under compose `mem_limit` with `memswap_limit` equal to it. run-compare's stack
  splits are `pg-redis` = Fastify 1 GiB + Postgres 6 GiB (`shared_buffers=4GB`) +
  Redis 1 GiB (`maxmemory 768mb`), and `pg-only` = Fastify 1 GiB + Postgres 7 GiB
  (its idle Redis container is not charged). Each cap, swap limit and ancestor limit is checked before a
  sample runs. Harper sizes its RocksDB block cache and worker heaps from the
  cgroup limit, as it would in an 8 GiB container. (One cgroup spanning host
  processes and containers would need root; one per process does not.)
  `--harper-memory=measured` lifts Harper's cap for comparison runs (its ancestor
  cgroups must still allow 8 GiB); such results are not equal-memory.
- **Memory is what the cgroup is charged**, the same way for every component:
  anonymous memory plus page cache (a file page is charged to the cgroup that first
  touches it) plus shared memory (`shared_buffers`). Each sample reports the 2 s
  peak and mean over the measured window, the anon/file split at its end, the
  lifetime peak, and OOM-kill events; an OOM kill invalidates the sample. Results
  before methodology v2 summed PSS for host processes, which omits page cache.
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
- **Postgres is tuned, Harper is not.** `shared_buffers` and
  `effective_cache_size` are sized to the container's share — the stock 128 MB
  would make it a page-fault benchmark. Harper runs stock apart from
  `threads.count` and log level.
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
  for workload C (all shards) and E (one shard, since it inserts). Every route
  returns one ~1 KB record, so it bounds the generator's request rate, not the
  cost of receiving E's multi-record scan bodies.

## Dataset larger than memory (`memory-sweep.mts`)

A Redis holding the whole dataset is the cache-aside stack's upper bound. The sweep
lets the hit rate come out of memory instead: same 4 cores and 8 GiB per target,
dataset sized as a multiple of the budget (`--ratios`, logical payload of the
10 × 100 B records), zipfian reads, workloads C and B.

- **Stack split, chosen once:** `pg-redis` = Fastify 1 GiB + Redis 3.5 GiB
  (`maxmemory 3gb`) + Postgres 3.5 GiB (`shared_buffers=1GB`); `pg-only` = Fastify
  1 GiB + Postgres 7 GiB (`shared_buffers=2GB`). Harper: one 8 GiB cgroup.
- **One load per engine and size, restored per sample.** A capped `harper` and a
  `pg-only` each load the dataset over REST, then quiesce (CPU under 0.1 core for
  5 s), shut down cleanly and keep the data directory as a snapshot. Every
  (target, workload) sample copies that snapshot into a fresh data directory
  from inside its own cgroup, before the server starts — in Harper's launch
  wrapper, in Postgres' container entrypoint — so the copy's page cache is
  charged to the sample, not to a copier outside the budget. All targets of a
  size read byte-identical, compacted data. Redis starts empty.
- **Warmup to a plateau, then one measured run.** 1M-op chunks of the workload's
  own zipfian mix until the last three agree (throughput within 5%, and for
  `pg-redis` the Redis hit rate within 0.5 points), up to `--warmup-max-chunks`.
  A sample that hits the ceiling is reported with `!` and is not a settled
  result. B's measured run is bounded (1M ops), not a write steady state;
  Postgres checkpoints in the window are recorded.
- **No hit-rate gate.** The Redis hit rate per sample is the output. Harper's
  record-cache hit rate is not observable without core changes.
- **A failed sample** (errors, OOM kill, crash) is recorded with its phase and the
  session continues — unless its scopes or containers are still running, in which
  case the session stops. `--sized-ratios` limits the sized targets to some sizes.
