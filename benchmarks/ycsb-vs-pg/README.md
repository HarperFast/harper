# Harper vs. a conventional Node stack (YCSB over REST)

A rough head-to-head: the same YCSB-style REST workload driven against

| Target     | What answers the request                                                            |
| ---------- | ----------------------------------------------------------------------------------- |
| `harper`   | Harper core, `usertable` exported over REST — database, cache and app in one process |
| `pg-redis` | Fastify → Redis look-aside cache → Postgres                                          |
| `pg-only`  | Fastify → Postgres (no cache), to isolate what the cache is buying                   |

It reuses `benchmarks/ycsb` **unchanged** — same load generator, same key
distributions, same workload mixes, same 10 × 100 B record shape. The only
variable is the server. See `benchmarks/ycsb/README.md` for the workload
definitions (A–F) and the REST operation mapping.

## Running

```sh
npm run build                     # dist/bin/harper.js, which the harper target spawns
docker --version                  # postgres + redis run via docker compose
node benchmarks/ycsb-vs-pg/run-compare.mts --scale=standard
node benchmarks/ycsb-vs-pg/run-compare.mts --scale=quick --workloads=C,A --targets=harper,pg-redis
```

All `benchmarks/ycsb` flags apply, plus `--targets` (default `harper,pg-redis`).
Results land in `benchmarks/ycsb-vs-pg/results/` alongside a printed comparison
table. The first listed target is the ratio baseline. Runtime scales with
targets x workloads, since each combination reloads the dataset from scratch.

`--threads` sets **both** Harper's worker-thread count and the Fastify cluster
size, so each side gets the same number of request handlers.

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

- **Same storage medium.** Postgres' `PGDATA` is tmpfs; the Harper side also
  runs its data directory under `/tmp`, which is tmpfs on the benchmark host.
  Neither side is measuring the SSD.
- **Same durability setting.** Postgres keeps `fsync=on` /
  `synchronous_commit=on`, matching Harper's default `storage.writeAsync=false`.
- **Postgres is tuned, Harper is not.** `shared_buffers=4GB`,
  `effective_cache_size=16GB` — the stock 128 MB would make it a page-fault
  benchmark. Harper runs stock apart from `threads.count` and log level.
- **The conventional stack gets more CPU.** It has `--threads` Fastify workers
  *plus* unconstrained Postgres backends and a Redis process; Harper gets
  `threads.count` worker threads and nothing else.
- **Identical response bodies.** The Fastify handler selects `id` alongside the
  fields so both targets return the same JSON keys and roughly the same bytes.
- **Every workload gets its own freshly started server, dataset and warmup**, and
  runs `--reps` times with the median reported. This is the expensive option and
  it is load-bearing. Sharing one instance across workloads let each one inherit
  the last one's state — the record cache left resident by a preceding read
  sweep, the compaction backlog left by a preceding write burst — and the
  distortion was big enough to invert rankings: a 95%-read workload measured
  *slower* than a 50%-write one, and a 100%-read workload measured 2.5x slower
  than the 95%-read workload that followed it.
- **Warmup sweeps the whole keyspace uniformly.** A zipfian warmup only touches
  the hot keys, leaving the measured workload to absorb the first-touch cost of
  every remaining row — for Postgres, the hint-bit rewrite each page needs after
  a bulk load.
- **Everything is on one host**, including the load generator. Run
  `client-ceiling.mts` to confirm the reported numbers are server-bound rather
  than client-bound:

  ```sh
  node benchmarks/ycsb-vs-pg/client-ceiling.mts --concurrency=64
  ```

  It serves a fixed in-memory record from a `node:http` cluster and drives it
  with the same client path, so its result is the hard upper bound for both
  targets on that machine.
