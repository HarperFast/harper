# Index-backfill-convergence repro (harper#2536 / PR #2539)

Empirical validation rig for the Walmart USGM incident: a secondary-index backfill frozen
partway, with a persisted `lastIndexedKey` that never let it converge. Not a CI-tracked benchmark
-- a one-off diagnostic, run by hand against a pre-#2539 and post-#2539 build. Follows the
bootstrap/loader conventions of `benchmarks/rocksdb-planner-query-repro/` (rocksdb-planner-repro-rig
branch).

Build the tree you want to test first (`npm ci && npm run build`), then run from the repo root.

## Root cause (proven, not inferred)

Pre-#2539, `runIndexing`'s resume-checkpoint reduction was:

```js
let start;
for (const attribute of attributes) {
	if (compareKeys(attribute.lastIndexedKey, start) < 0) start = attribute.lastIndexedKey;
	...
}
```

`compareKeys(x, undefined)` returns **+1** (lmdb's key-space treats `undefined` as sorting
*before* any concrete key, i.e. `-Infinity`, not `+Infinity`). So `compareKeys(concreteKey,
undefined) < 0` is **never true**, for any key, on the very first (and only, since `start` never
becomes anything else) iteration. `start` is unconditionally `undefined` regardless of what's
persisted -- **every resume, on every restart, silently rescans from the very first primary-store
record.** See `poisoned-checkpoint-scenario.js`'s companion investigation notes and the PR
description for `resumeStartKey`, the fix.

## Scripts

- `env.js` -- boots a bare Harper environment against a persistent db path (in-process, no HTTP).
- `schema.js` -- a table with `id` + N low-cardinality secondary attributes (attr0..attrN-1).
- `worker.js` -- child-process worker: `seed` (writes N unindexed rows), `index` (declares the
  attributes indexed, triggering `runIndexing`; records the `start` key and first-visited key of
  its primary-store scan to `<result>.started.json` *synchronously*, so the observation survives
  an external SIGKILL even if the process never gets an event-loop turn to write it otherwise),
  `inspect` (reads counts + the raw attribute descriptor without contributing further indexing
  progress as a side effect).
- `driver.js` -- orchestrates: seeds once, then repeatedly spawns `worker.js --mode index` and
  SIGKILLs it from the parent (independent of the child's own event loop) after a fixed wall-clock
  budget -- modeling a supervisor that kills an unresponsive worker after the same amount of time,
  every time. `--final-run` does one more attempt with no external kill, to check convergence.
- `poisoned-checkpoint-scenario.js` -- small-scale (few hundred rows), single-process, real code
  path: injects one index-put failure, confirms pre-#2539 code advances the checkpoint *past* the
  failed record anyway (checkpoint writes aren't error-gated on the interval path), then confirms
  whether #2539 resuming from that inherited, already-poisoned checkpoint (a) trusts it and
  declares the index complete while silently missing the failed record, and (b) whether clearing
  `lastIndexedKey` first (forcing a full rescan) recovers it.
- `incident-replica.mjs` (ESM, needs `@harperfast/integration-testing`) -- end-to-end replica
  against a REAL running Harper server: boots with an unindexed schema fixture, bulk-loads via the
  operations API, stops (data dir survives), swaps in an `@indexed` schema and reboots (this is
  the real backfill trigger), then interrupts the running backfill with real
  `operation: 'restart_service', service: 'http_workers'` calls -- an in-process worker-thread
  restart that leaves `process.pid` unchanged, exactly like the field's `restart_service
  http_workers` recovery attempt. Polls the restart's `job_id` via `get_job` so the next cycle
  doesn't proceed until the worker swap has actually completed (up to
  `threadTerminationTimeout*2`, 20s by default -- a worker mid a non-yielding backfill can't
  notice a graceful shutdown request until it hits a yield point). Samples `search_by_value` vs
  `search_by_hash` on a sentinel tail record to observe the silent-stuck signature: `search_by_hash`
  (primary-store read) always finds it; `search_by_value` (indexed) returns 200 with an empty
  result for as long as the backfill hasn't reached it.
- `fixtures/redirect/` -- the component schema `incident-replica.mjs` stages: `schema-unindexed.graphql.tmpl`
  (first boot) and `schema-indexed.graphql.tmpl` (second boot, the one that fires the backfill).

## Usage

```sh
# Part A: controlled SIGKILL crash-loop (the precise, decisive comparison)
node driver.js --db /tmp/backfill-a --database test --table T --rows 1000000 --num-attrs 2 \
  --kill-after-ms 800 --cycles 5
node driver.js --db /tmp/backfill-a --database test --table T --rows 1000000 --num-attrs 2 \
  --final-run --final-timeout-ms 60000

# Part B: poisoned pre-existing checkpoint (run `poison` on a pre-#2539 build, copy the db dir,
# then run `resume` and/or `remediate`+`resume` on a #2539 build)
node poisoned-checkpoint-scenario.js --db /tmp/poison-db --mode poison --result /tmp/poison.json
cp -R /tmp/poison-db /tmp/poison-db-resume
node poisoned-checkpoint-scenario.js --db /tmp/poison-db-resume --mode resume --result /tmp/resume.json

# Part C: real running-server replica (needs the repo's own dist/ built)
node incident-replica.mjs --rows 5000000 --attrs 5 --workers 2 --restart-cycles 4 --restart-after-ms 1000
```

To compare pre-#2539 vs post-#2539: run the same commands against two worktrees/checkouts, each
with its own `npm ci && npm run build`.
