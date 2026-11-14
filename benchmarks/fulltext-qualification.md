# Full-text concurrency and memory benchmark

## Run

Run `npm run build` first. Use RocksDB and the installed native fulltext package. The default module resolution measures the built `dist` implementation, matching the HTTP and cost runners. The runner isolates each cell in a new process and test database; it does not start an HTTP server.

```sh
node benchmarks/run-fulltext-qualification.mts
node benchmarks/run-fulltext-qualification.mts --scale=nightly --output=/absolute/new/results-directory
node benchmarks/run-fulltext-qualification.mts --relevance-control --writes=0,10 --duration=5
```

Quick, the default, runs one read-only cell with one sort clause and one query loop for one second. Nightly selects eight 60-second cells: 1/32 sort clauses × 1/4 concurrent closed query loops × 0/10 paced writes per second. Flags override presets. Quick verifies the harness; it is not performance qualification.

| Flag                  | Values                                          | Quick / nightly           |
| --------------------- | ----------------------------------------------- | ------------------------- |
| `--clauses`           | comma-separated 1,32                            | 1 / 1,32                  |
| `--clients`           | comma-separated 1,4                             | 1 / 1,4                   |
| `--writes`            | comma-separated 0,10 per second                 | 0 / 0,10                  |
| `--duration`          | integer seconds, 1–300                          | 1 / 60                    |
| `--freshness`         | strict, bounded-lag                             | strict                    |
| `--relevance-control` | select unsorted queries instead of sort clauses | off                       |
| `--output`            | new output directory                            | fresh temporary directory |
| `--help`              | show options without starting Harper            |                           |

The output directory must not exist and its parent must exist. Keep it outside the checkout. Environment-only `FULLTEXT_QUALIFICATION_*` settings are replaced by CLI flags; the runner supplies every internal cell setting explicitly. A failed cell retains its log and prevents a complete aggregate report. Inspect it before rerunning into a new directory.

Each cell seeds 9,000 matching records, with 31 tied string fields and one permuted numeric key. A separate nonmatching indexed record receives writes, preserving a stable ordering oracle while exercising publication. Queries request 20 records and fully consume the result. The first query is recorded separately, followed by three warmups. Setup warms storage; the operating-system cache is uncontrolled.

## Freshness controls

`--freshness=strict` uses lag 0 and a 30-second wait. `--freshness=bounded-lag` performs an untimed strict readiness query, then measures lag 5 seconds with no wait option. Positive waits request current coverage regardless of the lag option. This control does not prove concurrent writes are immediately visible. The native writer can catch up after stalls, unlike the paced HTTP writer.

## Output and interpretation

The parent prints parseable `FULLTEXT_CONCURRENCY_RESULT` lines with scale, clauses, clients, configured write rate, duration, freshness, sample count, achieved query/write rates and p95 latency. Each child log and report is retained separately. The aggregate `report.json` records resolved options, checkout identity and harness hashes; each cell fingerprints its resolved Table/query modules so a stale build can be distinguished.

Reports retain latency samples, achieved query/write rates, errors, runtime capabilities, CPU time, event-loop utilization/delay and memory observations. Rates include draining admitted work after the admission window. Small sample counts provide limited tail-latency resolution.

RSS high-water values include seeding, native caches and measurement arrays. Sampled peaks are observations, not guaranteed instantaneous maxima. Instrumentation uses a bounded 20ms time series plus rolling query-boundary peaks; latency arrays remain retained in memory. Long-duration memory/leak studies need instrumentation-overhead controls.

These benchmarks do not establish OS-cold behavior, balanced HTTP worker traffic, active working sets above RAM, sustained leak freedom or release qualification. Those requirements remain tracked in [Qualify native full-text filtering and catalog-scale operation for v5.4](https://github.com/HarperFast/harper/issues/2512).

## Related harnesses

- [Cell implementation](fulltext-qualification.cjs) and [isolated runner](run-fulltext-qualification.mts).
- [Warm native cost method](fulltext-sort-cost.md).
- [HTTP qualification harness](fulltext-http/README.md).
