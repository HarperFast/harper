# Full-text concurrency and memory observation

Status: observed — ten local cells completed. Owner: Kyle. Last observed: 2026-11-01.

Observed: one-field sorting reached 42 queries/s with one query loop and no writes; 32-field sorting reached 14 queries/s. With strict freshness and 10 indexed writes/s, both sorting and relevance-only queries took approximately one second. These measurements do not establish catalog-scale readiness or a 50ms service-level guarantee.

## Run

Use RocksDB and the installed native fulltext package. The runner isolates each cell in a new process and test database; it does not start an HTTP server.

```sh
FULLTEXT_QUALIFICATION_OUTPUT=/absolute/new/results-directory \
  node benchmarks/run-fulltext-qualification.cjs

FULLTEXT_QUALIFICATION_OUTPUT=/absolute/new/control-directory \
  FULLTEXT_QUALIFICATION_RELEVANCE_CONTROL=1 \
  node benchmarks/run-fulltext-qualification.cjs
```

The output directory must not exist. The default matrix is eight 60-second cells: 1/32 sort clauses × 1/4 concurrent closed query loops × 0/10 paced writes per second. The optional relevance control selects two unsorted cells with one query loop and writes off/on. `FULLTEXT_QUALIFICATION_SMOKE=1` selects the first cell; `FULLTEXT_QUALIFICATION_DURATION_MS=5000` shortens its measurement window. A failed cell leaves its log and prevents a complete aggregate report; inspect the failure before rerunning into a new directory.

Each cell seeds 9,000 matching records, with 31 tied string fields and one permuted numeric key; the permutation seed is 7,919. A separate nonmatching indexed record receives writes, preserving a stable ordering oracle while exercising publication. Queries request 20 records and fully consume the result. The first query is recorded separately, followed by three warmups. This is a fresh process/reader observation after seeding; setup warms storage and the operating-system cache is uncontrolled.

## Recorded results

Observed on Apple M4 Pro, Node v24.16.0, Darwin arm64, fulltext 0.8.0. Exact runtime capabilities, CPU (central processing unit) time, event-loop utilization/delay and memory measurements are retained in [the ten-cell summary](fulltext-qualification-results.json).

| Sort clauses   | Query loops | Target writes/s | Queries/s | Query p50 ms | Query p99 ms |
| -------------- | ----------- | --------------- | --------- | ------------ | ------------ |
| 1              | 1           | 0               | 41.99     | 23.07        | 33.53        |
| 1              | 1           | 10              | 1.00      | 1,002.78     | 1,096.72     |
| 1              | 4           | 0               | 50.15     | 76.12        | 123.05       |
| 1              | 4           | 10              | 4.00      | 996.30       | 1,111.89     |
| 32             | 1           | 0               | 13.71     | 72.49        | 85.24        |
| 32             | 1           | 10              | 1.00      | 1,002.41     | 1,049.16     |
| 32             | 4           | 0               | 15.48     | 255.62       | 288.59       |
| 32             | 4           | 10              | 3.99      | 1,001.22     | 1,061.98     |
| Relevance only | 1           | 0               | 5,237.38  | 0.184        | 0.262        |
| Relevance only | 1           | 10              | 1.07      | 1,003.94     | 1,037.65     |

All ten cells completed with zero recorded query/write errors. Rates use elapsed time including draining admitted work after the 60-second admission window; achieved write rates and raw sample counts are in the summary. Write cells with approximately 60 samples provide limited p99 resolution.

Verified configuration: queries set `maxIndexLagMilliseconds: 0` and `waitForIndexMilliseconds: 30000`. The [waiting query path](../resources/indexes/fullTextQueryIndex.ts) requests current coverage before searching. The [derived-index runner](../resources/derivedIndexRuntime.ts) defaults to a 1,000ms flush age. Observed write-cell median latency near one second, including the relevance-only control, supports publication waiting as the dominant cost. This control does not isolate every latency contributor or establish a before/after regression comparison. Increasing tolerated lag while retaining a positive wait does not bypass that waiting path.

## Freshness control and sustained follow-up

`FULLTEXT_QUALIFICATION_FRESHNESS` defaults to `strict` (lag 0, wait 30 seconds). `bounded-lag` performs an untimed strict readiness query, then measures lag 5 seconds with no wait option. Positive waits request current coverage regardless of the lag option. This control uses the same deterministic result oracle; it does not prove that concurrent writes are immediately visible. The native writer can catch up after stalls, unlike the paced HTTP writer.

See the [sustained and HTTP observations](fulltext-http/results/README.md) for longer local measurements, retained raw reports and invalidated controls. These extend the evidence without replacing the release qualification gaps below.

## Final-page preparation check

A separate [final-page observation](fulltext-final-page-cost.json) runs the current highlighted shallow/deep cases over 9,000 matches. It completed all 15 correctness cases while the broad unit/integration gates were also running. These timings measure bounded observed cost under uncontrolled competing load; they do not establish an isolated performance baseline or a before/after regression comparison.

| Request                                          | Offset | Observed p50 ms | Observed maximum ms |
| ------------------------------------------------ | -----: | --------------: | ------------------: |
| Sorted highlights                                |      0 |           30.34 |               44.65 |
| Sorted highlights                                |  8,800 |           37.91 |               40.53 |
| Exact count with computed projection             |      0 |           27.88 |               52.33 |
| Exact count with computed projection             |  8,800 |           26.37 |               37.58 |
| Highlighted exact count with computed projection |      0 |           28.85 |               30.16 |
| Highlighted exact count with computed projection |  8,800 |           28.88 |               30.09 |

Each highlighted request traces exactly the 20 visible records through the actual native reader. Exact-count projection controls expose the existing count-tail work: unhighlighted requests project all 9,000 records at either offset; highlighted requests project 9,000 at offset zero and 200 at offset 8,800. Highlighted preparation avoids offset projection, but ordinary count-tail projection remains. This can exhaust Table's separate count timer and return an unknown total; it is not represented as a completed optimization.

## Memory and provenance

The eight sort cells ran at [d5e49215c9628ee9f3b5cc83f0f7a43b5b8eea3b](https://github.com/HarperFast/harper/commit/d5e49215c9628ee9f3b5cc83f0f7a43b5b8eea3b); the two relevance controls ran at [f4551b4be26974f3944132d77c72e9d25c98addc](https://github.com/HarperFast/harper/commit/f4551b4be26974f3944132d77c72e9d25c98addc). The latter adds the optional control and reporting fields; these are separate source snapshots. The summary labels freshness/window/drain fields inferred afterward for the original matrix as `posthocVerifiedConfiguration`.

Recorded resident set size (RSS) high-water values include seeding, native caches and measurement arrays. Sampled peaks are observations, not guaranteed instantaneous maxima. `lifetimeMaxRssBytesIncludingSetup` is the process high-water value before cleanup. The historical collector retained a memory sample after every query; the high-throughput relevance control therefore retained many more samples. Its memory is measurement-storage-confounded and cannot be compared as product RAM (random-access memory).

The current harness bounds that instrumentation to a 20ms time series plus rolling query-boundary peaks. This change was made after all ten cells and was not used to produce these results. Latency arrays remain retained in memory. A long-duration memory/leak study needs instrumentation overhead controls.

[Compressed raw latencies](fulltext-qualification-latencies.json.gz) preserve every query/write latency as gzip JSON, with zero gzip modification time. Each entry identifies its source artifact and cell index. The summary records compressed/uncompressed SHA-256 digests, source commits and original artifact names/digests. Full historical memory time series are not bundled; only their derived peaks and source digests are shared. Decompress with `gzip -dc benchmarks/fulltext-qualification-latencies.json.gz`.

## Open qualification

Untested: operating-system-cold storage, multiple HTTP workers, competing unrelated traffic, sustained leaks, large indexes, catalog-scale deep offsets and expensive query classes. [Qualify native full-text filtering and catalog-scale operation for v5.4](https://github.com/HarperFast/harper/issues/2512) retains matched standalone-wrapper/Harper baselines, representative catalogs of at least 100 million records and agreed query-class p99 targets. This local matrix does not close those release gates.

These observations are not a release sign-off.

## Sources

- [Cell implementation](fulltext-qualification.cjs) and [isolated runner](run-fulltext-qualification.cjs).
- [Ten-cell summary and source artifact digests](fulltext-qualification-results.json).
- [Complete compressed query/write latency samples](fulltext-qualification-latencies.json.gz).
- [Earlier warm scalar/native cost observation](fulltext-sort-cost.md).
