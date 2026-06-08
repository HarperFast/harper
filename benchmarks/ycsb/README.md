# YCSB-style CRUD load test

A [YCSB](https://github.com/brianfrankcooper/YCSB)-style load test that drives
CRUD operations against Harper over the **HTTP REST interface**. It boots a real
Harper instance using [`@harperfast/integration-testing`](https://github.com/HarperFast/integration-testing-framework),
loads a dataset, then runs the standard YCSB workloads and reports throughput and
latency percentiles. Results are written as JSON for tracking over time (e.g. the
nightly workflow in `.github/workflows/ycsb-nightly.yml`).

## What it measures

A record is a string primary key plus N string fields (YCSB default: 10 × 100 B).
Operations map onto REST as:

| Operation | REST                                         |
| --------- | -------------------------------------------- |
| read      | `GET /usertable/<key>`                       |
| insert    | `PUT /usertable/<key>` (full record)         |
| update    | `PUT /usertable/<key>` (full record replace) |
| rmw       | `GET` then `PUT`                             |
| scan      | `GET /usertable/?id>=<key>&limit(<n>)`       |

The runner is **closed-loop**: a fixed number of in-flight requests
(`--concurrency`) each issue their next request as soon as the previous completes,
so throughput reflects the server rather than a fixed injection rate.

### Workloads

| Workload | Mix                                | Distribution |
| -------- | ---------------------------------- | ------------ |
| A        | 50% read / 50% update              | zipfian      |
| B        | 95% read / 5% update               | zipfian      |
| C        | 100% read                          | zipfian      |
| D        | 95% read / 5% insert (read latest) | latest       |
| E        | 95% scan / 5% insert               | zipfian      |
| F        | 50% read / 50% read-modify-write   | zipfian      |

Key distributions: `uniform`, `zipfian` (scrambled hotspot, YCSB default), and
`latest` (biased toward recently inserted keys). Override per-run with
`--distribution`.

## Prerequisites

```sh
npm run build   # the test spawns dist/bin/harper.js
```

On macOS/Windows, configure loopback addresses once (Linux has them by default):

```sh
npx harper-integration-test-setup-loopback
```

## Running (single node)

```sh
node benchmarks/ycsb/run-single-node.mts --scale=standard
node benchmarks/ycsb/run-single-node.mts --scale=quick --workloads=C,A
node benchmarks/ycsb/run-single-node.mts --engine=lmdb --threads=4
```

### Scales

| Scale      | records | ops/workload | concurrency |
| ---------- | ------- | ------------ | ----------- |
| `quick`    | 50k     | 100k         | 32          |
| `standard` | 200k    | 500k         | 64          |
| `heavy`    | 1M      | 4M           | 128         |

### Flags

`--scale` `--records` `--ops` `--concurrency` `--load-concurrency` `--fields`
`--field-length` `--scan-max` `--warmup` `--workloads` `--distribution`
`--engine` (`rocksdb`|`lmdb`) `--threads` `--out` `--startup-timeout`.
Individual flags override the scale preset.

## Output

- Console: a per-workload table of throughput and p50/p95/p99/max latency.
- JSON: `benchmarks/ycsb/results/ycsb-single-node-<timestamp>.json` plus a stable
  `ycsb-single-node-latest.json`. The `results/` directory is git-ignored.

The JSON includes `meta` (git commit/branch, node version, platform),
`config` (scale, threads, engine), `load`, and per-workload throughput +
latency stats — enough to diff runs across nights.

### Trend tracking & regression alerts

The nightly workflow feeds results to
[`github-action-benchmark`](https://github.com/benchmark-action/github-action-benchmark)
via `to-benchmark-json.mts` (throughput as bigger-is-better, p99 latency as
smaller-is-better). History is pushed to the `gh-pages` branch and a regression
beyond the configured threshold comments on the commit and `@`-mentions the
maintainer. **Enable GitHub Pages on `gh-pages` to view the trend dashboard.**
Thresholds are deliberately generous to absorb shared-runner variance — tighten
them once the benchmark runs on a fixed/self-hosted runner.

## Notes

- `threads.count` is set via `HARPER_SET_CONFIG` (defaults to 4), which takes
  precedence over the framework's default of 1.
- Instances run with `AUTHENTICATION_AUTHORIZELOCAL=true`, so loopback requests
  are authorized without per-request auth — the benchmark measures CRUD, not auth.
- Only the primary key is indexed, matching the YCSB access model.
- The schema declares `field0..field9`; keep `--fields` ≤ 10 (or edit
  `app/schema.graphql`). Higher counts are stored as dynamic attributes, which
  changes the load-phase write path and isn't directly comparable.

### Reading the numbers (vs. reference YCSB)

These are trend signals on a fixed host, not a 1:1 reproduction of the Java YCSB:

- **Throughput** is _successful_ ops/sec over wall-clock time; errors are
  reported separately. Clean runs (the expectation) report 0 errors, so the two
  definitions coincide.
- **Latency percentiles** use the nearest-rank method (slightly conservative vs.
  interpolated / HdrHistogram), consistent across runs — don't compare them 1:1
  to HdrHistogram p99s.
- The **`latest`** distribution (workload D) is approximate: a scrambled-zipfian
  value mod the keyspace, biased toward newest keys but with a uniform tail.
  Faithful enough for trends, not identical to YCSB's `LatestGenerator`.

## Profiling

`--profile` runs the HTTP server on the main thread (`threads.count=0`) and
sets `--cpu-prof`, so a single V8 CPU profile captures request handling.
(Harper's worker threads use a fixed `execArgv` that `--cpu-prof` can't reach,
hence the single-thread mode for profiling.)

```sh
node benchmarks/ycsb/run-single-node.mts --profile --records=100000 --ops=300000 --workloads=A
node benchmarks/ycsb/analyze-profile.mts benchmarks/ycsb/results/profile
```

The analyzer prints self-time by module/category and the hottest functions. The
profile spans startup + load + the run phase, so one-time costs (module loading,
cert/key generation) appear alongside steady-state request handling — discount
those when reading the results.

## Cluster

The 3-node cluster variant (harper-pro) reuses `workload.mts`, `restClient.mts`,
and `harness.mts` from here, starting three connected nodes and round-robining
load across them.
