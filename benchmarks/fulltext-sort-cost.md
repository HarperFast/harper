# Full-text stored scalar sort cost

Run from the repository root on Node 24, writing the report outside the checkout:

```bash
FULLTEXT_SORT_COST_REPORT=/absolute/output/fulltext-sort-cost.json NODE_OPTIONS=--conditions=typestrip node node_modules/mocha/bin/mocha.js benchmarks/fulltext-sort-cost.cjs --reporter dot
```

The Mocha initializer isolates database paths. The probe extracts the production `getAttributeValue` and decorated-key sort closures from `Table.ts`, strips their TypeScript types, and uses real Table scalar property resolvers over resident record entries. Extraction fails if those source boundaries move. Reports hash the extracted closures and retain 30 samples after three warmups.

Each scalar case sorts 10,000 entries using 1, 3 or 32 clauses. The final clause is a deterministic numeric permutation; earlier clauses tie, exercising linked-key comparisons. Assertions check both ends of the sorted output. These cases measure key extraction and synchronous sorting, excluding native retrieval, source-version checks, projection and highlighting.

## Optional real-native queries

```bash
FULLTEXT_NATIVE_COST=1 FULLTEXT_SORT_COST_REPORT=/absolute/output/fulltext-native-cost.json NODE_OPTIONS=--conditions=typestrip node node_modules/mocha/bin/mocha.js benchmarks/fulltext-sort-cost.cjs --reporter dot
```

This mode seeds 9,000 matching records in an audited Table and waits for full-text readiness. Requests cover relevance, stored-field sorting, highlights, exact counts, selective predicates, deep offsets and computed projection. Sorted pages and highlights are checked against deterministic expectations. Exact-count cases assert the known total whenever exact and retain unknown totals otherwise. Reports include native capabilities, applied policy and samples; cleanup restores prior configuration.

## Interpretation

The corpus is warm and resident. This is Table execution, not HTTP latency, with no concurrent clients, writes, OS-cache eviction or process-wide GC isolation. RSS snapshots are not peak allocation, a leak test or a capacity bound. The 9,000-match corpus leaves room for initial-prefix replay under the default 10,000 raw-hit budget. Same-run controls are not a comparison against another Harper revision.

Keep generated reports outside the source tree. See the [concurrency method](fulltext-qualification.md) and [HTTP harness](fulltext-http/README.md) for other workload scopes.
