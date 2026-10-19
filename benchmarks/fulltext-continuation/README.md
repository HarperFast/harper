# Fulltext continuation measurements

Build first, then run each command separately on an otherwise idle machine:

```sh
npm run build
npm run test:integration -- benchmarks/fulltext-continuation.bench.ts
npx mocha benchmarks/fulltext-continuation-workers.cjs
node benchmarks/fulltext-limits.cjs
FT_BENCH_PROFILE=1 npm run test:integration -- benchmarks/fulltext-continuation.bench.ts
FT_BENCH_PROFILE=1 npx mocha benchmarks/fulltext-continuation-workers.cjs
```

The HTTP fixture creates synthetic catalogs of 10,000, 50,000 and 100,000 short records.
It compares ordinary search with initial continuation pages, using exact and prefix matches,
one-in-500 filters and filters accepting no records. Indexed and unindexed filter fields are
reported separately. Each query requests 25 rows. Results are checked against an independently
sorted set of eligible IDs; explicit raw-hit budget errors are recorded rather than treated as
empty results.

Each case has a warmup, 20 sequential latency samples, and three samples alongside sequential
requests to an unrelated table. Worker execution time excludes the fixture's event-loop monitor
setup. Control-request latency includes HTTP and authentication. Event-loop delay uses a 1 ms
histogram; process RSS includes all Harper workers and native allocations. These are warm local
observations, not catalog-scale memory qualification or a production latency guarantee.

HTTP reaches one Harper worker on macOS and Windows. The separate managed-worker harness uses
two real Harper workers and production continuation messages on every supported native platform.
It compares replay of the same five-row page on its owner and on the other worker, asserting
identical rows. Its timings exclude the controller's benchmark-command transport.

The two profiling commands run separately from timing: V8 coverage can change optimization and
allocation behavior even after profiling stops. They record limits-resolver and traversal function
counts on the workers and admission authority. Coverage counts are diagnostic function counts,
not CPU time or wire-message counts. Small inlined private helpers are deliberately excluded.
The limits microbenchmark measures the real resolver with populated settings and with absent
settings. Do not interpret a per-call measurement as complete continuation-request overhead.

`FT_BENCH_SIZES=10000` and `FT_BENCH_SAMPLES=1` provide a quick harness check. Do not use those
pilot results as qualification. The defaults require the published native addon and the normal
RocksDB engine. Machine, Node/native versions, outcomes, latency distributions and counters are
printed as JSON records. Keep the full command output with any published summary.
