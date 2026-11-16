# Full-text native query cost

Build Harper, then run the quick smoke from the repository root:

```sh
npm run build
node benchmarks/run-fulltext-sort-cost.mts
node benchmarks/run-fulltext-sort-cost.mts --scale=nightly --output=/absolute/new/report-directory
```

Quick uses one warmup and two measured queries per case. Nightly uses three warmups and ten samples. Override with `--warmups=0..100` and `--samples=1..1000`; `--help` lists the interface. Quick verifies the harness and correctness checks; it is not enough samples for a performance comparison. Reports go to a new temporary directory by default. `--output` selects a new directory whose parent already exists; existing directories are rejected. Keep reports outside the checkout.

The runner launches an isolated Mocha process, using normal Harper modules and `Table.search` rather than extracting private source closures. Its timeout is five minutes, including setup; larger sample requests can reach that safety bound and fail without a completed report. The corpus stays fixed at 9,000 matching records so deep offsets and the default raw-hit budget retain their meaning. Requests cover relevance, stored-field sorting with 1/3/32 clauses, highlights, exact counts, selective predicates, deep offsets and computed projection. Pages and highlights are checked against deterministic expectations. Exact-count cases assert the known total whenever exact and retain unknown totals otherwise. Cleanup restores prior configuration.

The parent prints one parseable line per completed case, separately from the child's captured Mocha log:

```text
FULLTEXT_NATIVE_COST_RESULT scale=quick case=sort-1 rows=9000 samples=2 p50_ms=... p95_ms=... max_ms=...
```

`report.json` retains samples, native capabilities, policy, hashes of the resolved Table/query modules, harness hashes, checkout commit and resolved options. `native.json` preserves the original completed child report, while `run.log` retains child output. The checkout commit and harness hashes are captured before the child starts; a checkout revision is not an attestation that its build is current. Source/compiled selection uses normal module resolution: the default measures the built `dist` implementation. The old `FULLTEXT_NATIVE_COST` switch and environment-only report interface are replaced by CLI flags; native query cases always run.

The corpus is warm and resident. This measures Table execution, not HTTP latency, with no concurrent clients, writes, OS-cache eviction or process-wide GC isolation. RSS snapshots are not peak allocation, a leak test or a capacity bound. Same-run controls are not a comparison against another Harper revision.

See the [concurrency method](fulltext-qualification.md) and [HTTP harness](fulltext-http/README.md) for other workload scopes.
