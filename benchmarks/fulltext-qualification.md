# Full-text concurrency and memory benchmark

## Run

Use RocksDB and the installed native fulltext package. The runner isolates each cell in a new process and test database; it does not start an HTTP server.

```sh
FULLTEXT_QUALIFICATION_OUTPUT=/absolute/new/results-directory node benchmarks/run-fulltext-qualification.cjs
FULLTEXT_QUALIFICATION_OUTPUT=/absolute/new/control-directory FULLTEXT_QUALIFICATION_RELEVANCE_CONTROL=1 node benchmarks/run-fulltext-qualification.cjs
```

The output directory must not exist. Keep it outside the checkout. The default matrix is eight 60-second cells: 1/32 sort clauses × 1/4 concurrent closed query loops × 0/10 paced writes per second. The optional relevance control selects two unsorted cells with one query loop and writes off/on. `FULLTEXT_QUALIFICATION_SMOKE=1` selects the first cell; `FULLTEXT_QUALIFICATION_DURATION_MS=5000` shortens its measurement window. A failed cell retains its log and prevents a complete aggregate report; inspect it before rerunning into a new directory.

Each cell seeds 9,000 matching records, with 31 tied string fields and one permuted numeric key. A separate nonmatching indexed record receives writes, preserving a stable ordering oracle while exercising publication. Queries request 20 records and fully consume the result. The first query is recorded separately, followed by three warmups. Setup warms storage; the operating-system cache is uncontrolled.

## Freshness controls

`FULLTEXT_QUALIFICATION_FRESHNESS` defaults to `strict` (lag 0, wait 30 seconds). `bounded-lag` performs an untimed strict readiness query, then measures lag 5 seconds with no wait option. Positive waits request current coverage regardless of the lag option. This control does not prove concurrent writes are immediately visible. The native writer can catch up after stalls, unlike the paced HTTP writer.

## Output and interpretation

Reports retain latency samples, achieved query/write rates, errors, runtime capabilities, source identity, CPU time, event-loop utilization/delay and memory observations. Rates include draining admitted work after the admission window. Small sample counts provide limited tail-latency resolution.

RSS high-water values include seeding, native caches and measurement arrays. Sampled peaks are observations, not guaranteed instantaneous maxima. Instrumentation uses a bounded 20ms time series plus rolling query-boundary peaks; latency arrays remain retained in memory. Long-duration memory/leak studies need instrumentation-overhead controls.

These benchmarks do not establish OS-cold behavior, balanced HTTP worker traffic, active working sets above RAM, sustained leak freedom or release qualification. Those requirements remain tracked in [Qualify native full-text filtering and catalog-scale operation for v5.4](https://github.com/HarperFast/harper/issues/2512).

## Related harnesses

- [Cell implementation](fulltext-qualification.cjs) and [isolated runner](run-fulltext-qualification.cjs).
- [Warm scalar/native cost method](fulltext-sort-cost.md).
- [HTTP qualification harness](fulltext-http/README.md).
