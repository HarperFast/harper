# Full-text stored scalar sort cost

Run from the repository root on Node 24:

```bash
FULLTEXT_SORT_COST_REPORT=benchmarks/fulltext-sort-cost.json NODE_OPTIONS=--conditions=typestrip node node_modules/mocha/bin/mocha.js benchmarks/fulltext-sort-cost.cjs --reporter dot
```

The Mocha initializer isolates the database paths. The probe extracts the production `getAttributeValue` and decorated-key sort closures from `Table.ts`, strips their TypeScript types, and uses real Table scalar property resolvers over resident record entries. Extraction fails if those source boundaries move. The report hashes the extracted closures and retains all 30 measured samples after three warmups.

Each case sorts 10,000 entries. The final clause contains a deterministic numeric permutation; every earlier clause ties, exercising linked-key comparisons. Cases contain 1, 3 and 32 clauses. Assertions check both ends of the sorted output.

The closure cases in the historical committed JSON record one Apple M4 Pro / Node 24.16.0 observation. They measure key extraction and synchronous sorting only. It excludes native retrieval, source-version checks, projection, highlighting, GC isolation and end-to-end latency. These results are a sizing observation, not catalog-scale qualification; wide linked sorts can still occupy the event loop for tens of milliseconds. Review the raw samples and scope before comparing another machine or revision.

## Optional real-native query observation

```bash
FULLTEXT_NATIVE_COST=1 FULLTEXT_SORT_COST_REPORT=benchmarks/fulltext-sort-cost.json NODE_OPTIONS=--conditions=typestrip node node_modules/mocha/bin/mocha.js benchmarks/fulltext-sort-cost.cjs --reporter dot
```

This also writes 9,000 real records to an audited Table, waits for full-text readiness and uses the published native binding without mocking its searches. The 31 leading String keys tie; the final numeric key is a deterministic permutation. One-clause sorting uses `key31`, three-clause sorting uses `key29`, `key30`, `key31`, and the widest case uses all 32 keys. Each request selects `id` and `key31` (plus `$highlights` in the highlighted case), requests 20 rows and includes native retrieval, current source validation, stored-field sorting when requested, Table projection and consumption of the returned page. Sorted assertions require values 0 through 19. Exact-count observations record both total and exactness, asserting 9,000 whenever exact and explicitly recording an unknown total otherwise.

The historical committed native observation has seven query cases. The current harness has twelve; its highlighted deep-offset/projection observations are recorded separately in [the final-page snapshot](fulltext-final-page-cost.json), with competing-load caveats in [the qualification method](fulltext-qualification.md). After three warmups per case, ten measured samples are retained under `nativeQueryCases`; p95 uses nearest rank and is therefore the maximum of ten samples. The same-run default relevance and unsorted exact-count cases provide workload context, not a comparison against another Harper version. The committed observation measured p50/p95 in milliseconds: relevance 0.64/0.71, exact count 22.20/29.73, one-key sort 22.90/26.47, three-key sort 29.65/32.74, 32-key sort 65.46/66.99, one-key sort with highlights 24.85/29.56, and filtered one-key sort with exact count 17.99/22.26. All ten measured unfiltered exact counts completed at 9,000. The selective sorted exact-count case adds the ordinary companion predicate `key31 < 90` against the same 9,000 raw matches; all ten measured totals completed exactly at 90 and each returned sorted page contained values 0 through 19. Runtime capabilities and the explicitly applied default policy accompany the samples; the prior configuration is restored on cleanup. The `sort-1-highlights` case additionally requests and verifies real title match spans for all 20 returned rows.

The corpus is warm and resident. This is Table execution, not HTTP latency, with no concurrent clients, writes, cold-storage qualification or control for process-wide GC. RSS before/after each case is only a process snapshot: it is not peak allocation, a leak test or a capacity bound. The 9,000-match corpus leaves room for initial-prefix replay under the default 10,000 raw-hit budget; it does not qualify larger catalogs or production latency targets.
