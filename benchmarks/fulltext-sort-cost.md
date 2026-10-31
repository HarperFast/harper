# Full-text stored scalar sort cost

Run from the repository root on Node 24:

```bash
FULLTEXT_SORT_COST_REPORT=benchmarks/fulltext-sort-cost.json NODE_OPTIONS=--conditions=typestrip node node_modules/mocha/bin/mocha.js benchmarks/fulltext-sort-cost.cjs --reporter dot
```

The Mocha initializer isolates the database paths. The probe extracts the production `getAttributeValue` and decorated-key sort closures from `Table.ts`, strips their TypeScript types, and uses real Table scalar property resolvers over resident record entries. Extraction fails if those source boundaries move. The report hashes the extracted closures and retains all 30 measured samples after three warmups.

Each case sorts 10,000 entries. The final clause contains a deterministic numeric permutation; every earlier clause ties, exercising linked-key comparisons. Cases contain 1, 3 and 32 clauses. Assertions check both ends of the sorted output.

The committed JSON records one Apple M4 Pro / Node 24.16.0 observation. It measures key extraction and synchronous sorting only. It excludes native retrieval, source-version checks, projection, highlighting, GC isolation and end-to-end latency. These results are a sizing observation, not catalog-scale qualification; wide linked sorts can still occupy the event loop for tens of milliseconds. Review the raw samples and scope before comparing another machine or revision.
