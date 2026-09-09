# RocksDB query-planner estimator repro

Diagnostic repro rig for the query-planner table-size estimator issue fixed by #2163
(`7acf00888`): `resources/search.ts`'s `estimatedEntryCount(store)` called
`RocksDatabase.getKeysCount()` (a full key scan) instead of `getEstimatedKeyCount()` (O(1)). This
only affects multi-condition AND queries (`Table.ts`'s `orderConditions` only estimates when
`conditions.length > 1 && operator !== 'or'`), and only versions before #2163.

Not a CI-tracked benchmark (unlike `benchmarks/ycsb`, `benchmarks/indexed-write`, etc.) — a one-off
diagnostic for this specific historical defect, run by hand against two builds (pre/post #2163).

## What it does

All scripts boot a bare in-process Harper environment (no HTTP server, no other threads) against a
persistent RocksDB path, using the same `#src/resources/databases` `table()`/`transaction()` APIs
`unitTests/resources/query.test.js` uses. Each invocation is a fresh process, so RocksDB's 10s
`estimatedEntryCountExpires` cache is always cold — matching a first-query-after-idle scenario, not
a warmed-up steady state.

- `schema.js` — defines a `Redirect`-shaped table (`id` PK, `url` indexed, `status` indexed) and a
  deterministic per-row generator.
- `load.js` — bulk loads N rows, batched into one `transaction()` commit per batch. `--raw-fraction
  F` writes the trailing `F*N` rows via `primaryStore.put()` directly, bypassing `Table.put`'s
  index maintenance (see completeness.js).
- `query.js` — runs one multi-condition AND query (`--query equals|startswith`), capturing the
  planner's `explain: true` output (condition order + `estimated_count`), `primaryStore.readCount`
  delta, and wall-clock time. `--enforce-execution-order` sets that search flag.
- `direct-estimate-bench.js` — isolates the exact change: `store.getKeysCount()` vs
  `store.getEstimatedKeyCount()` timing, without any query-layer noise.
- `completeness.js` — Deliverable B: compares exact primary-store vs index key counts, and
  full-scan vs indexed-search result counts, to demonstrate and detect an index left incomplete by
  a raw-bypass write path.
- `isindexing-guard-check.js` — counter-check: confirms Harper's own `index.isIndexing` flag (set
  by its real async backfill/reindex mechanism) makes a query on that index throw
  `IndexRebuildingError` rather than silently under-returning. The completeness.js gap is a
  different failure mode: rows written via a path that bypasses index maintenance entirely never
  sets that flag, so this guard never engages.

## Usage

Build the tree you want to test first (`npm run build`), then run from the repo root (dist-only —
these scripts do not run under `--conditions=typestrip` due to an unrelated JSON-import-attribute
incompatibility with newer Node on raw TS source):

```sh
# Part A: latency
node benchmarks/rocksdb-planner-query-repro/load.js --db /path/to/data --rows 19000000 --batch 20000
node benchmarks/rocksdb-planner-query-repro/direct-estimate-bench.js --db /path/to/data
node benchmarks/rocksdb-planner-query-repro/query.js --db /path/to/data --query startswith
node benchmarks/rocksdb-planner-query-repro/query.js --db /path/to/data --query startswith --enforce-execution-order

# Part B: index completeness
node benchmarks/rocksdb-planner-query-repro/load.js --db /path/to/data2 --rows 2000000 --raw-fraction 0.05
node benchmarks/rocksdb-planner-query-repro/completeness.js --db /path/to/data2
node benchmarks/rocksdb-planner-query-repro/isindexing-guard-check.js --db /path/to/data2
```

To compare pre-#2163 vs post-#2163, run the same commands against two worktrees (e.g. `git
worktree add <path> v5.2.7` for pre-fix, `origin/main` for post-fix), each with its own `npm ci`
and `npm run build` (the `@harperfast/rocksdb-js` native dependency version differs between them,
so `node_modules` cannot be shared).
