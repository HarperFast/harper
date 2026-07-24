# Harper benchmarks

This directory contains single-node storage and throughput benchmarks for Harper.

| Benchmark          | File             | What it measures                                                            |
| ------------------ | ---------------- | --------------------------------------------------------------------------- |
| YCSB               | `ycsb/`          | Standard CRUD workloads (A–F) across the REST interface                     |
| HNSW search        | `hnsw-search.js` | In-memory vector index search latency and recall                            |
| **Indexed-write**  | `indexed-write/` | Write throughput at 0 / 3 / 5 secondary indexes (**ST-2**)                  |
| **TTL-churn**      | `ttl-churn/`     | Storage size stability under continuous insert-with-TTL (**ST-1**)          |
| **Concurrent R+W** | `concurrent-rw/` | Read p99 under mixed concurrent writes on a highly-indexed table (**ST-5**) |
| **SQL engine A/B** | `sql-engine/`    | New (Resource-API) vs legacy (AlaSQL) SQL engine latency, per query shape   |

The three new benchmarks (ST-1, ST-2, ST-5) address gaps called out in §6.3 of the
Harper Release Testing Strategy and §5 of the v5 Integration Test Plan.

## Prerequisites

```sh
npm run build   # builds dist/bin/harper.js which all benchmarks spawn
```

On macOS/Windows, set up loopback addresses once (Linux has them by default):

```sh
npx harper-integration-test-setup-loopback
```

---

## ST-2 — Indexed-write throughput (`indexed-write/`)

Measures write ops/sec on three table variants:

| Table      | Secondary indexes    |
| ---------- | -------------------- |
| `baseline` | 0 (primary key only) |
| `indexed3` | 3 `@indexed` fields  |
| `indexed5` | 5 `@indexed` fields  |

Reports ops/sec per variant and the ratio vs. the unindexed baseline.

### Quick run (default, ~30 s)

```sh
node benchmarks/indexed-write/run.mts
```

### Nightly run (1 M records)

```sh
node benchmarks/indexed-write/run.mts --scale=nightly
```

### All flags

| Flag                | Default (quick) | Nightly   | Description                                                      |
| ------------------- | --------------- | --------- | ---------------------------------------------------------------- |
| `--scale`           | `quick`         | `nightly` | Preset (sets records, concurrency, and warmup defaults)          |
| `--records`         | 5 000           | 1 000 000 | Measured inserts per variant                                     |
| `--concurrency`     | 16              | 64        | In-flight requests                                               |
| `--engine`          | `rocksdb`       | `rocksdb` | Storage engine                                                   |
| `--threads`         | 4               | 4         | Harper worker threads                                            |
| `--instance-warmup` | 500             | 2 000     | Untimed requests fired before any variant to heat JIT/pool/cache |
| `--variant-warmup`  | 200             | 1 000     | Untimed requests at the start of each variant (discarded)        |

Individual flags override the scale preset. Pass `--instance-warmup=0 --variant-warmup=0` to
disable warmup (not recommended — results will be biased by cold-start ordering effects).

### Parseable output lines

```
INDEXED_WRITE_RESULT variant=baseline ops_per_sec=NNN
INDEXED_WRITE_RESULT variant=indexed3  ops_per_sec=NNN ratio_vs_baseline=N.NNN
INDEXED_WRITE_RESULT variant=indexed5  ops_per_sec=NNN ratio_vs_baseline=N.NNN
```

---

## ST-1 — TTL-churn / map-size growth (`ttl-churn/`)

Runs a sustained insert-with-TTL workload and samples the on-disk data directory
size at `--sample-every` seconds. Asserts (and reports) that storage stays bounded:
the final size must remain ≤ 150% of the halfway-point size, meaning Harper's TTL
eviction and compaction are reclaiming space.

**Do not run the nightly scale locally — it takes 30+ minutes.** Use the quick
default for local validation.

### Quick run (default, ~30 s)

```sh
node benchmarks/ttl-churn/run.mts
```

### Nightly run (1 M records × 60 s TTL × 30 min)

```sh
node benchmarks/ttl-churn/run.mts --scale=nightly
```

### All flags

| Flag             | Default (quick)   | Nightly          |
| ---------------- | ----------------- | ---------------- |
| `--scale`        | `quick`           | `nightly`        |
| `--records`      | 10 000 (per wave) | 1 000 000        |
| `--ttl`          | 60 s              | 60 s             |
| `--duration`     | 30 s              | 1 800 s (30 min) |
| `--concurrency`  | 32                | 64               |
| `--sample-every` | 5 s               | 60 s             |
| `--engine`       | `rocksdb`         | `rocksdb`        |
| `--threads`      | 4                 | 4                |

### Parseable output lines

```
TTL_CHURN_SAMPLE elapsed_s=NNN dir_bytes=NNN records_inserted=NNN
TTL_CHURN_RESULT duration_s=NNN peak_bytes=NNN final_bytes=NNN total_inserts=NNN bounded=true|false
```

---

## ST-5 — Concurrent read+write (`concurrent-rw/`)

Seeds a table with `--seed-records` records, then concurrently runs:

- **N readers** (`--readers`) issuing multi-condition queries against 5 `@indexed` fields
- **M writers** (`--writers`) inserting new records at full speed

Reports read latency (p50, p95, p99, max) and checks p99 against a configurable
ceiling (`--p99-ceiling-ms`, default 200 ms).

### Quick run (default, ~30 s total)

```sh
node benchmarks/concurrent-rw/run.mts
```

### Nightly run (200 k records, 120 s)

```sh
node benchmarks/concurrent-rw/run.mts --scale=nightly
```

### All flags

| Flag                 | Default (quick) | Nightly   |
| -------------------- | --------------- | --------- |
| `--scale`            | `quick`         | `nightly` |
| `--seed-records`     | 2 000           | 200 000   |
| `--duration`         | 15 s            | 120 s     |
| `--readers`          | 4               | 16        |
| `--writers`          | 2               | 8         |
| `--p99-ceiling-ms`   | 200             | 200       |
| `--load-concurrency` | 32              | 32        |
| `--engine`           | `rocksdb`       | `rocksdb` |
| `--threads`          | 4               | 4         |

### Parseable output line

```
CONCURRENT_RW_RESULT read_ops=NNN write_ops=NNN read_p50_ms=N.N read_p95_ms=N.N read_p99_ms=N.N p99_ceiling_ms=NNN ceiling_ok=true|false
```

---

---

## SQL engine A/B (`sql-engine/`)

Compares the new Resource-API SQL engine against the legacy AlaSQL engine on the
same query battery. Addresses PLAN.md phase-5 item 6 (perf budget `<=` legacy) and
the "regression on tiny queries" risk.

Engine selection is process-global (`HARPER_SQL_ENGINE`), so the benchmark boots
**two** instances with identical config/fixture/seed — one `legacy`, one `new` —
and interleaves the two at the **iteration** level (legacy, new, legacy, new...).
A block design would charge any machine drift entirely to whichever engine ran
during it; alternating cancels the drift in the ratio.

The new side runs `new`, not `auto`, on purpose: `auto` silently falls back to
legacy on an unplannable query, so timing `auto` would benchmark legacy twice and
report it as parity. Under `new`, an unplannable query surfaces as `UNSUPPORTED`.

Every query is result-parity checked (row count + normalized digest) across the two
engines before its timings count; a divergence is reported as `MISMATCH` and
excluded (its timing would be meaningless).

### Quick run (default, ~2 min)

```sh
node benchmarks/sql-engine/run.mts
```

### All flags

| Flag           | Default (quick) | Nightly   | Description                               |
| -------------- | --------------- | --------- | ----------------------------------------- |
| `--scale`      | `quick`         | `nightly` | Preset (records + iterations + warmup)    |
| `--records`    | 10 000          | 200 000   | Seeded rows                               |
| `--iterations` | 40              | 200       | Timed iterations per query **per engine** |
| `--warmup`     | 10              | 30        | Untimed iterations per query per engine   |
| `--filter`     | (none)          | (none)    | Only run queries whose name contains this |
| `--engine`     | `rocksdb`       | `rocksdb` | Storage engine                            |
| `--threads`    | 4               | 4         | Harper worker threads per instance        |

### Parseable output lines

```
SQL_ENGINE_RESULT query=pk-lookup rows=1 legacy_p50_ms=N.NN new_p50_ms=N.NN ratio=N.NN status=ok
SQL_ENGINE_SUMMARY queries=N faster=N slower=N even=N unsupported=N mismatch=N error=N geomean_ratio=N.NN
```

`ratio` is new/legacy p50 — **below 1.0 means the new engine is faster**.

### Interpreting

- **The ratio is a function of table size, not a fixed speedup.** Legacy full-scans
  anything it cannot serve from an index, so its time grows with `--records` while
  the new engine's index-served plans stay flat. `pk-range-small` (10 rows) measures
  6 / 34 / 130 ms on legacy at 1k / 10k / 40k rows against a flat ~1.5 ms on the new
  engine. Always report the ratio _with_ the record count.
- **Compare against the printed HTTP + ops-API floor** (~0.35 ms). A query whose
  engine time is near the floor is dominated by transport, so its ratio is
  compressed toward 1.0 — that is not evidence the engines are equivalent.
- `like-unindexed` is expected to be `UNSUPPORTED`: no index driver, so `new`
  rejects and production `auto` routes it to legacy. It documents the fallback
  boundary.

## Notes on interpreting results

- **Indexed-write ratios** near 1.0 at small scale are expected: with 5 k records the
  index overhead is small relative to HTTP latency, so ratios of 0.95–1.05 are normal
  noise. The regression signal is a large ratio _increase_ between runs on the same
  machine, not the absolute number. The benchmark uses an instance-level warmup and a
  per-variant warmup to eliminate cold-start ordering bias; without warmup, `baseline`
  (measured first) would absorb JIT/connection-pool/cache costs and appear artificially
  slow, inverting the expected ordering.
- **TTL-churn `bounded=false`** at quick scale can be a false alarm if the TTL has not
  expired yet (60 s TTL in a 30 s run). The nightly 30-min run is the definitive gate.
- **Concurrent-rw p99** at quick scale reflects the cost of multi-condition index scans
  over 2 k records on a warmed instance — expect it to be higher than on a nightly run
  with 200 k records cached.
- All three benchmarks write a machine-parseable `RESULT` line to stdout; a future
  regression gate can `grep` this line and diff against a stored baseline.
