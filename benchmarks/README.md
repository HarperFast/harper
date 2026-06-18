# Harper benchmarks

This directory contains single-node storage and throughput benchmarks for Harper.

| Benchmark          | File             | What it measures                                                            |
| ------------------ | ---------------- | --------------------------------------------------------------------------- |
| YCSB               | `ycsb/`          | Standard CRUD workloads (A–F) across the REST interface                     |
| HNSW search        | `hnsw-search.js` | In-memory vector index search latency and recall                            |
| **Indexed-write**  | `indexed-write/` | Write throughput at 0 / 3 / 5 secondary indexes (**ST-2**)                  |
| **TTL-churn**      | `ttl-churn/`     | Storage size stability under continuous insert-with-TTL (**ST-1**)          |
| **Concurrent R+W** | `concurrent-rw/` | Read p99 under mixed concurrent writes on a highly-indexed table (**ST-5**) |

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
