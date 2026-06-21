# New Harper SQL Engine on the Resource API

## Context

Harper's current SQL engine (`core/sqlTranslator/`, `core/dataLayer/SQLSearch.js`) is a two-pass hybrid: AlaSQL parses and also re-executes the entire SQL in-memory over data fetched by `harperBridge`. The fetch step degrades to a full attribute scan whenever the WHERE clause has `OR`, comparators, or any predicate that isn't an indexable equality. Aggregates, GROUP BY, ORDER BY, and LIMIT are all delegated to AlaSQL on materialized arrays (`SQLSearch.js:1175` `alasql.promise(sql, tableData)`), so memory grows with the number of fetched rows, not the number of returned rows.

We want a SQL engine built directly on the Resource API (`Table.search`, `Table.get`, `Table.put`, `transaction()`) that:

- Uses indexes natively via `Table.search({ conditions, sort, limit, offset, select })`.
- Streams end-to-end via `AsyncIterable` operators (no `tableData` arrays).
- Maps SQL clauses to Resource primitives where possible; rejects what can't be efficient.
- Stays back-compatible with the AlaSQL surface that Harper users already use, including the 20+ custom functions registered today.
- Keeps AlaSQL only as a parser; nothing else.

Implementation will be carried out by a different LLM, so this plan is detailed and self-contained.

## Goals / Non-goals

**Goals**

- Index- and relationship-aware execution with proper predicate pushdown.
- Streaming pipeline; bounded memory for arbitrarily large result sets (modulo unavoidable buffers — sort, hash join, hash aggregate).
- Coexistence with the legacy engine via a feature flag while we prove parity.
- Clear rejection model for queries that cannot map efficiently.
- Drop-in replacement for the public `evaluateSQL` entry point so callers don't change.

**Non-goals (initial)**

- Cost-based optimizer with histograms (use simple selectivity heuristics first).
- Spill-to-disk for sort / hash join / hash aggregate (cap with a configurable row limit and reject above it).
- Window functions, recursive CTEs, FULL/RIGHT OUTER joins, correlated subqueries — reject in v1; revisit later.
- Replacing `core/dataLayer/insert.js`, `update.js`, `delete.js` themselves — call them from the new operators or use Resource API directly, but don't refactor those files yet.

## Key strategic decisions (review before implementation)

These are the defaults I'm recommending. Override before the implementer starts.

1. **Language: TypeScript.** New code under `core/sqlEngine/` is `.ts`. The Resource API is already TS; the parser layer is the only place that touches AlaSQL JS, and that boundary is a single file.
2. **AlaSQL stays as parser only.** AlaSQL types (`alasql.yy.*`) MUST NOT escape `parser/normalizer.ts`. Everything downstream consumes the internal IR.
3. **Volcano model with `AsyncIterable`.** Each operator exposes `execute(ctx): AsyncIterable<Row>`. No explicit `open/next/close`. Composes natively with `Table.search`'s return type.
4. **Strictness on full scans.** New engine inherits `Table.search`'s default `allowFullScan: false`. Per-table or per-query opt-in via a config flag mirrors the Resource API contract.
5. **Migration via single config flag** `sql.engine = 'legacy' | 'new' | 'auto'`, defaulting to `'legacy'` until parity is proven; `'auto'` falls back to legacy on `EngineUnsupportedError`. Hard cutover by deleting legacy in the final phase.
6. **AlaSQL quirks**: where AlaSQL behavior diverges from SQL standard (e.g., loose `=` coercion, `undefined → null` translation in outer joins per `SQLSearch.js:1189`), the new engine matches AlaSQL for back-compat. Documented per-quirk in `parser/normalizer.ts` or `expressions/coerce.ts`.
7. **Subqueries / window funcs / set ops / RIGHT/FULL OUTER**: rejected in v1 with `EngineUnsupportedError`. Add in a later phase.
8. **Permissions** stay on `opAuth.verifyPermsAst` (called at `sqlTranslator/index.js:80`) — keep it on the router boundary so the new engine inherits permission behavior verbatim.

## Architecture

```
HTTP/MQTT/etc.
      │
evaluateSQL(jsonMessage, callback)         ← unchanged signature in core/sqlTranslator/index.js
      │
processAST → router (reads sql.engine)
      │
      ├── 'legacy' → existing path (search.js / SQLSearch.js, deleteTranslator.js, etc.)
      └── 'new' or 'auto' →
              parser/normalizer.ts        AlaSQL AST  → internal IR (typed plain objects)
                          │
              binder/                     resolves Table refs, columns, functions, types
                          │
              logical/build.ts            internal IR → LogicalPlan tree
                          │
              optimizer/ruleEngine.ts     fixed-point rule application (R1–R8 below)
                          │
              physical/plan.ts            LogicalPlan → PhysicalPlan
                          │
              executor/                   drive AsyncIterable, shape result
                          │
              Resource API                Table.search / put / patch / delete / transaction
```

## Logical operators

```ts
type LogicalPlan =
	| { kind: 'Scan'; table; alias?; pushedFilter?; pushedSort?; pushedLimit?; projection? }
	| { kind: 'Filter'; input; predicate }
	| { kind: 'Project'; input; projections: { expr; alias }[] }
	| {
			kind: 'Join';
			left;
			right;
			on;
			type: 'inner' | 'left' | 'cross';
			strategy: 'relationship' | 'indexNL' | 'hash' | 'nestedLoop';
	  }
	| { kind: 'Aggregate'; input; groupKeys: Expr[]; aggs: AggCall[]; having? }
	| { kind: 'Sort'; input; keys: SortKey[] }
	| { kind: 'Limit'; input; limit?; offset? }
	| { kind: 'Distinct'; input; keys?: Expr[] }
	| { kind: 'Insert'; table; rows: Row[] | LogicalPlan }
	| { kind: 'Update'; table; assignments; selector: LogicalPlan }
	| { kind: 'Delete'; table; selector: LogicalPlan };
```

## Optimizer rules (rule-based, fixed point)

| #   | Rule                                               | Effect                                                                                                                                                                                         |
| --- | -------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| R1  | Predicate pushdown                                 | Push WHERE conditions through Project/Join into `Scan.pushedFilter` (Resource API condition shape).                                                                                            |
| R2  | Projection pushdown                                | Compute minimal attributes per Scan; map to `Table.search({ select })`.                                                                                                                        |
| R3  | Predicate normalization                            | `BETWEEN` → `gele`/`gelt`/etc.; `LIKE 'x%'` → `starts_with`; `LIKE '%x'` → `ends_with`; `LIKE '%x%'` → `contains`; `NOT(>)` → `<=` (NULL-aware). Anything else stays as a residual `Filter`.   |
| R4  | Constant folding & redundant predicate elimination | `1=1`, `x=x`, contradictions.                                                                                                                                                                  |
| R5  | Limit pushdown                                     | Push `LIMIT/OFFSET` into the Scan when no Sort/Aggregate/Join intervenes (or when the Sort can be index-served — see R7).                                                                      |
| R6  | Distinct → Aggregate                               | `SELECT DISTINCT a, b` becomes `Aggregate(groupKeys=[a,b], aggs=[])`.                                                                                                                          |
| R7  | Sort-from-index                                    | If the requested sort key matches an indexed attribute on the leaf scan, drop the explicit `Sort` and push to `Scan.pushedSort` (`Table.search({ sort })`).                                    |
| R8  | Reject non-scannable plans                         | If after pushdowns a `Scan` has no usable index condition and the table doesn't allow full scans, throw `EngineUnsupportedError` with the offending column name. Mirrors `Table.ts:2124-2131`. |

(Add R9 join reordering, R10 subquery decorrelation, R11 cost-based ordering in later phases.)

## Physical operators → Resource API mapping

| Physical op                      | Resource API call                                                                                                                                                                                                                     |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `PhysicalIndexScan`              | `Table.search({ conditions, select, sort, limit, offset, allowFullScan: false })` returning `AsyncIterable<Record>`.                                                                                                                  |
| `PhysicalFullScan` (opt-in only) | `Table.search({ conditions: [], allowFullScan: true })`.                                                                                                                                                                              |
| `PhysicalFilter`                 | wraps child iterable; residual predicate compiled by `expressions/compile.ts`.                                                                                                                                                        |
| `PhysicalProject`                | per-row evaluation of projection list.                                                                                                                                                                                                |
| `PhysicalRelationshipJoin`       | single `Table.search` using the array-attribute relationship syntax (`core/resources/search.ts:138-196`) — fastest join path when the join is on a declared `relationship` attribute.                                                 |
| `PhysicalIndexNestedLoopJoin`    | outer side streams via index scan; per outer row, probe inner side with `Table.search({ conditions: [{ attribute: innerKey, value: outerRow[outerKey], comparator: 'equals' }] })`. LEFT OUTER fills nulls when probe returns 0 rows. |
| `PhysicalHashJoin`               | build smaller side into `Map<key, row[]>`; probe the other; cap build size by `sql.engine.maxHashRows`.                                                                                                                               |
| `PhysicalNestedLoopJoin`         | only for cross / non-equi join. Last resort.                                                                                                                                                                                          |
| `PhysicalSort`                   | in-memory sort with `sql.engine.maxSortRows` cap.                                                                                                                                                                                     |
| `PhysicalLimit`                  | counts rows; calls `child.return()` when limit is reached.                                                                                                                                                                            |
| `PhysicalStreamingAggregate`     | requires input sorted on group keys (set by `outputOrder` properties on physical operators); O(1) memory per group.                                                                                                                   |
| `PhysicalHashAggregate`          | `Map<groupKey, accumulators>`; capped by `maxHashRows`.                                                                                                                                                                               |
| `PhysicalDistinct`               | becomes `PhysicalHashAggregate` after R6.                                                                                                                                                                                             |
| `PhysicalInsert`                 | inside `transaction(ctx, async () => { ... })`, calls `Table.put(record, ctx)` (or `Table.create`) per row.                                                                                                                           |
| `PhysicalUpdate`                 | inside `transaction()`, drives `selector` plan, calls `Table.patch(id, newValues, ctx)` per row.                                                                                                                                      |
| `PhysicalDelete`                 | inside `transaction()`, drives `selector` plan, calls `Table.delete(id, ctx)` per row.                                                                                                                                                |

## File tree (new directory `core/sqlEngine/`)

```
core/sqlEngine/
  index.ts                       public entry; same shape as sqlTranslator entries
  router.ts                      reads sql.engine flag; tries new, falls back to legacy on EngineUnsupportedError
  config.ts                      engine flag, allowFullScan, maxSortRows, maxHashRows
  types.ts                       SqlType, Row, ColumnSchema, RuntimeError types

  parser/
    parse.ts                     calls alasql.parse
    normalizer.ts                AlaSQL AST → internal IR (the only place that imports alasql.yy.*)
    ast.ts                       internal IR type definitions
    backtick.ts                  reserved-word backtick helper

  binder/
    bind.ts                      driver
    resolveTable.ts              schema/table resolution via core/resources/databases.ts
    resolveColumn.ts             column → Attribute resolution + alias scope
    resolveFunction.ts           lookup in functions/registry.ts
    typeInference.ts             expression type inference and AlaSQL-compatible coercion

  logical/
    op.ts                        LogicalPlan union helpers
    build.ts                     bound IR → LogicalPlan

  optimizer/
    ruleEngine.ts                fixed-point driver
    rules/
      predicatePushdown.ts       R1
      projectionPushdown.ts      R2
      predicateNormalize.ts      R3 (LIKE, BETWEEN, NOT)
      constantFolding.ts         R4
      limitPushdown.ts           R5
      distinctToAggregate.ts     R6
      sortFromIndex.ts           R7
      validateScannable.ts       R8
    cardinality.ts               selectivity heuristics (cribbed from core/resources/search.ts ratios)

  physical/
    plan.ts                      LogicalPlan → PhysicalPlan
    properties.ts                outputOrder helpers
    op.ts                        PhysicalOp interface (execute(ctx): AsyncIterable<Row>)
    PhysicalIndexScan.ts
    PhysicalFullScan.ts
    PhysicalFilter.ts
    PhysicalProject.ts
    PhysicalRelationshipJoin.ts
    PhysicalIndexNestedLoopJoin.ts
    PhysicalHashJoin.ts
    PhysicalNestedLoopJoin.ts
    PhysicalSort.ts
    PhysicalLimit.ts
    PhysicalStreamingAggregate.ts
    PhysicalHashAggregate.ts
    PhysicalDistinct.ts
    PhysicalInsert.ts
    PhysicalUpdate.ts
    PhysicalDelete.ts

  expressions/
    compile.ts                   ExprNode → CompiledExpr closure (run once at plan time)
    nullLogic.ts                 three-valued AND/OR/NOT
    coerce.ts                    AlaSQL-compatible runtime coercion

  functions/
    registry.ts                  FunctionRegistry singleton (scalar | aggregate | window)
    standard.ts                  +,-,*,/,||,UPPER,LOWER,LENGTH,COALESCE,NULLIF,...
    date.ts                      reuse implementations from core/utility/functions/date/dateFunctions.js
    geo.ts                       reuse implementations from core/utility/functions/geo.js
    extensions.ts                MAD, MEAN, MODE, PROD, MEDIAN, DISTINCT_ARRAY, SEARCH_JSON
                                 (reuse implementations from core/utility/functions/sql/alaSQLExtension.js)

  executor/
    runSelect.ts                 drives root iterator
    runInsert.ts                 wraps PhysicalInsert in transaction
    runUpdate.ts                 wraps PhysicalUpdate in transaction
    runDelete.ts                 wraps PhysicalDelete in transaction

  errors.ts                      EngineUnsupportedError, EngineRuntimeError
  diff/
    differential.ts              run query against legacy + new; deep-equal results (for tests)
```

**Modified files (small edits):**

- `core/sqlTranslator/index.js`: in `processAST` (line 130), after the switch resolves `sqlFunction`, route through `core/sqlEngine/router.ts` instead of calling `search`/`convertInsert`/`cbUpdateUpdate`/`deleteTranslator` directly.
- `config/...`: add the `sql.engine`, `sql.engine.allowFullScan`, `sql.engine.maxSortRows`, `sql.engine.maxHashRows` settings.
- No changes to `core/dataLayer/SQLSearch.js`, `SelectValidator.js`, `sql_statement_bucket.js` until the final cutover phase.

## Custom function porting

Reuse implementations directly — they're pure JS. The new `functions/registry.ts` re-registers them in the new engine's format. Existing files stay in place until legacy is deleted.

| Source file                                     | Functions                                                                                                                                                                                |
| ----------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `core/utility/functions/sql/alaSQLExtension.js` | aggregates: `MAD`, `MEAN`, `MODE`, `PROD`, `MEDIAN`; scalars: `DISTINCT_ARRAY`, `SEARCH_JSON`                                                                                            |
| `core/utility/functions/date/dateFunctions.js`  | `CURRENT_DATE`, `CURRENT_TIME`, `EXTRACT`, `DATE`, `DATE_FORMAT`, `DATE_ADD`, `DATE_SUB`, `DATE_DIFF`/`DATEDIFF`, `NOW`, `OFFSET_UTC`, `GET_SERVER_TIME`, `GETDATE`, `CURRENT_TIMESTAMP` |
| `core/utility/functions/geo.js`                 | `GEOAREA`, `GEOCIRCLE`, `GEOCONTAINS`, `GEOCONVERT`, `GEOCROSSES`, `GEODIFFERENCE`, `GEODISTANCE`, `GEOEQUAL`, `GEOLENGTH`, `GEONEAR`                                                    |

Aggregates register `{ factory: () => ({ step(v), finalize() }) }`. AlaSQL's accumulator convention (`(value, accum, row) → newAccum`) wraps trivially. Buffering aggregates (`MAD`, `MEDIAN`, `MODE`) keep all values in the accumulator.

## Phasing

Each phase leaves the system shippable and behind the flag.

**Phase 0 — Scaffolding.** Create `core/sqlEngine/` skeleton, types, registry, config flag, router. Router always delegates to legacy. No behavior change. Adds `differential.ts` test harness.

**Phase 1 — Single-table SELECT.** Parser, binder, logical build, R1–R5/R7/R8, `PhysicalIndexScan`/`Filter`/`Project`/`Sort`/`Limit`. Custom date/geo/SEARCH_JSON/DISTINCT_ARRAY scalars. Reject joins, aggregates, subqueries. Differential harness runs the SELECT subset of `core/unitTests/dataLayer/SQLSearch.test.js` and must match.

**Phase 2 — Aggregates & sort variants.** `PhysicalStreamingAggregate`, `PhysicalHashAggregate`, `PhysicalDistinct`; R6; HAVING; aggregate functions (MAD/MEAN/MODE/PROD/MEDIAN/COUNT/SUM/AVG/MIN/MAX). Differential coverage of the aggregate cases in the legacy test suite.

**Phase 3 — Joins.** `PhysicalRelationshipJoin` (cheap, big win), `PhysicalIndexNestedLoopJoin`, `PhysicalHashJoin`, `PhysicalNestedLoopJoin`. LEFT OUTER. NULL-fill semantics matched exactly to `SQLSearch.js:1189`.

> **Status (in progress).** Implemented: multi-table binder with alias-scoped
> column resolution; left-deep join build with WHERE-conjunct distribution;
> qualified (`<alias>.<attr>`) row model threaded through compile/operators;
> `PhysicalIndexNestedLoopJoin` (default when the inner join key is indexed —
> the only strategy that passes the no-full-scan policy without `allowFullScan`),
> `PhysicalHashJoin` (equi, full inner side), `PhysicalNestedLoopJoin`
> (CROSS / non-equi); LEFT OUTER null-fill; INNER/LEFT/CROSS + comma-FROM;
> GROUP BY / ORDER BY / 3+ table chains. RIGHT/FULL rejected.
> **Output naming:** join columns get clean unqualified names (SELECT `AS`
> honored), with `_2`/`_3` suffixes on collision — legacy AlaSQL instead emitted
> `[id]`/`[id1]`; the differential harness will normalize between the two.
> **Deferred to a phase-3 follow-up:** `PhysicalRelationshipJoin` (declared-
> relationship fast path via the array-attribute search syntax) — correctness is
> covered by indexNL/hash/NL; relationship join is a pushdown optimization.
> Projection pushdown does not yet descend through joins (inner/outer scans fetch
> all attributes). Hash-key matching uses JSON equality (no loose `=` coercion
> across join keys of differing types — non-equi falls to nested-loop).
>
> **Phase-3 cross-model review follow-ups (Gemini leg).** Applied: self-join
> base-name qualifier now rejects as ambiguous; undeclared unqualified column in a
> join now rejects (→ legacy fallback) instead of silently defaulting to the FROM
> table; `rightBaseScan` unwraps stacked Filters; hash-join keys exclude `NaN`.
> Still deferred: (a) single-table predicates living in an INNER-JOIN `ON` clause
> are evaluated as a post-join residual rather than pushed into the inner scan —
> results are correct (indexNL serves the probe), but a non-indexed join key whose
> only indexable predicate is in `ON` will be rejected under `allowFullScan:false`;
> (b) the binder mutates AST `ExprNode.table` in place — fine today, but revisit
> before adding plan caching.

**Phase 4 — Mutations.** `PhysicalInsert`/`Update`/`Delete` inside `transaction()`. INSERT supports literals and `INSERT … SELECT`. Response shapes verified against `core/unitTests/dataLayer/insert.test.js`, `update.test.js`, `delete.test.js`, `sql-update.test.js`.

> **Status — IMPLEMENTED (VALUES-form INSERT, UPDATE, DELETE).** What landed:
>
> - normalizer: `normalizeInsert`/`normalizeUpdate`/`normalizeDelete` over the AlaSQL ASTs (Insert `{into:{databaseid,tableid}, columns:[{columnid}], values:[[{value}]]}`; Update `{table, columns:[{column:{columnid}, expression}], where}`; Delete `{table, where}`). `INSERT … SELECT` is rejected for now (falls back to legacy).
> - binder: `bindInsert`/`bindUpdate`/`bindDelete` resolve the single target table via `bindTableRef` (bare column refs, like single-table SELECT).
> - executor `executor/runMutation.ts`: `runInsert`/`runUpdate`/`runDelete`. The `databases`-resolved entry is the Table class; its static `get`/`put`/`patch`/`delete`/`getNewId` are called inside one `transaction(context, …)` (injectable via `_setTransactionRunner` for unit tests) so the per-row writes join one atomic txn. UPDATE/DELETE find targets by running the ordinary SELECT pipeline (`SELECT * / SELECT pk FROM target WHERE …`) inside that transaction. INSERT skips existing-PK rows (get-then-put) to match legacy createRecords skip semantics; auto-generates a PK via `getNewId()` when absent.
> - index.ts: dispatches by `bound.kind`; returns the **legacy response shapes** — INSERT `{message:"inserted N of M records", inserted_hashes, skipped_hashes}`, UPDATE `{message:"updated N of M records", update_hashes, skipped_hashes}`, DELETE `{message:"N of M records successfully deleted", deleted_hashes, skipped_hashes}`. Permissions stay on the AST at the router boundary (unchanged).
> - 8 mutation unit tests (`unitTests/sqlEngine/mutation.test.js`) cover insert/skip/auto-PK, update (incl. relative `qty=qty+1`), delete, and single-transaction batching.
>
> **Deferred within phase 4:** `INSERT … SELECT`; an unconditional `UPDATE`/`DELETE` (no WHERE) is a full scan, so it is rejected under the default `allowFullScan:false` (→ legacy fallback in 'auto') — intentional, consistent with SELECT. Read-then-write uses one transaction (read sees a consistent snapshot); not a row-level locking read-modify-write (legacy has the same window). **Real-instance behavioral/differential test** (boots a local Harper instance, runs INSERT/UPDATE/DELETE through the new engine vs legacy) is the remaining verification beyond the unit mocks.
>
> **RESOLVED — the transactional-write invocation (source-confirmed).** The
> `databases`-resolved entry (`databases[db][table]`, the same value the binder
> already holds as `boundTable.resource`) is the Table **class**, which exposes
> static `create`/`put`/`patch`/`delete` (`resources/Resource.ts:113-214`). Each
> static method internally calls `transaction(context, …)`
> (`resources/transaction.ts:8`), which **joins** an already-open transaction on
> the context and otherwise opens+commits one. So the engine wraps a whole
> multi-row mutation in a single `transaction(context, async () => { … })` and the
> per-row static calls join it → one atomic commit (abort-on-throw).
> Semantics (`resources/Table.ts:1691` instance `create`):
>
> - `create(record, context)` → returns the record; auto-generates a UUID PK via
>   `getNewId()` when absent (and writes it onto the record). **Throws
>   `ClientError(409)` when the PK already exists.**
> - Legacy SQL INSERT instead **skips** duplicates and reports them in
>   `skipped_hashes` (`dataLayer/insert.ts:236-258`, message "inserted N of M").
>   So the executor must pre-check existence (resource `get`) and skip, NOT let
>   `create`'s 409 abort the surrounding transaction.
> - `put` upserts (requires an explicit PK); `delete(id)` is idempotent → boolean.
>   Remaining empirical check folded into a real-instance behavioral/differential
>   integration test (boots a local Harper instance, runs INSERT/UPDATE/DELETE
>   through the new engine, compares to legacy) rather than a unit mock.

**Phase 5 — Cutover.** Flip default to `'auto'`. Burn in for one release, watching logs for fallback warnings. Then flip to `'new'`. Then delete `core/dataLayer/SQLSearch.js`, `core/sqlTranslator/SelectValidator.js`, `sql_statement_bucket.js`, `alasqlFunctionImporter.js`, the SQLSearch-specific helpers in `core/dataLayer/search.js`. Keep `alasql.parse` only.

> **Status (in progress) — parity gate built; default flip BLOCKED.**
>
> - **Cutover-readiness differential** (`integrationTests/apiTests/sql-engine-differential.test.mjs`): boots a `new`-side (`HARPER_SQL_ENGINE=auto`, the production cutover setting) and a `legacy`-side instance with identical data and compares responses + persisted state across a 30-case battery (single-table SELECT, OR/NOT/BETWEEN/LIKE/IN, NULL semantics, ORDER BY/LIMIT/OFFSET/DISTINCT, COUNT/SUM/MIN/MAX/AVG/GROUP BY/HAVING, INNER/LEFT join, INSERT/UPDATE/DELETE). Result: **30/30 identical**. Because the new side runs in `auto`, an unsupported query falls back and matches by construction, so the only way to fail is a _silent_ divergence — which is the real cutover risk.
> - **Trial flip to `auto` (reverted).** Setting the default to `'auto'` and running the _existing_ SQL suite (`delete.test.mjs`) exposed **two blockers the differential battery didn't cover**, so the default was reverted to `'legacy'`:
>   1. **Literal type-coercion on `IN` — FIXED.** `… WHERE id IN ('5','6')` (string literals) against a numeric column matched in legacy but not the new engine (silent wrong result; `auto` doesn't fall back). Diagnosis (real-instance probe): legacy coerces _only_ for `IN` (both PK and indexed non-PK), not for single `=` (legacy `id = '5'` also returns nothing, so `=` is left strict for parity). Fix: `whereToConditions` now expands each `IN` literal into its loosely-equal variants (numeric-string ↔ number, exact-round-trip guarded) so the numeric branch is still an indexed equality lookup. Covered by the differential's `in-str-pk`/`in-str-nonpk`/`in-mixed` cases + a unit test; `delete.test.mjs` under `auto` dropped from 5 failures to 3 (only blocker 2 remains).
>   2. **`LIKE`-predicate DELETE → 403 (investigate).** `DELETE FROM northnwd.employees WHERE address LIKE '%Lane'` returned 403 Forbidden through the new selector path (a non-PK, suffix-LIKE predicate). Root cause TBD — likely the DELETE selector's internal `resource.search` authorization interaction, or an unsupported path erroring instead of cleanly throwing `EngineUnsupportedError` to fall back. Plain SELECTs and indexed-PK DELETEs authorize fine, so it's specific to this shape.
> - **Cutover checklist** (do in order): (a) fix blocker 1 (coercion) + 2 (LIKE-403) and add regression cases to the differential; (b) run the FULL existing SQL suite under `auto` in CI (local full-suite is contended — see [[reference_harper_local_unit_suite_contention]]) and drive it green; (c) flip default `legacy → 'auto'`; (d) burn in one release watching `sql-engine v2 fallback:` log lines; (e) flip to `'new'`; (f) delete the legacy SQL path.

**Phase 6 (optional, post-cutover).** Subquery decorrelation, UNION/UNION ALL, EXPLAIN/EXPLAIN ANALYZE, cost-based join reordering with histograms, spillable hash join/agg.

## Verification (testing strategy)

1. **Differential test harness** (`diff/differential.ts`): runs each query through both engines, normalizes results (sort by JSON serialization when no ORDER BY, normalize `undefined → null`), deep-equals.
2. **Replay legacy test corpus.** Extract SQL strings from `core/unitTests/dataLayer/SQLSearch.test.js` (1745 lines), `core/unitTests/sqlTranslator/sql_statement_bucket.test.js`, `core/unitTests/sqlTranslator/alasqlFunctionImporter.test.js`, `core/unitTests/dataLayer/sql-update.test.js`, `core/unitTests/dataLayer/insert.test.js`, `core/unitTests/dataLayer/delete.test.js`. Each existing case becomes a differential case. Anything that throws `EngineUnsupportedError` lands in an `unsupported.txt` audit file (expected to shrink phase by phase).
3. **Per-operator unit tests** in `core/unitTests/sqlEngine/` mirroring the file tree.
4. **Property tests** with `fast-check` on:
   - random AND/OR/NOT predicate trees (truth-equivalence vs a reference evaluator),
   - aggregator parity vs AlaSQL on random number arrays,
   - LIKE pattern → comparator mapping.
5. **Integration tests** under `core/integrationTests/sqlEngine/` using real LMDB.
6. **Performance regression**: a subset of the legacy corpus run with timings; budget ≤ legacy time. Particular attention to:
   - WHERE with OR / comparators (legacy degrades to full scans here),
   - GROUP BY with index-aligned keys (new engine should stream; legacy materializes),
   - JOINs where a relationship attribute exists.
7. **Manual smoke**: hit the running server with curl/HTTP through the SQL endpoint with `sql.engine='new'` for a representative set of queries before flipping the default.

## Risks and unknowns

- **AlaSQL AST quirks.** Legacy code has accumulated workarounds (`SQLSearch.js:1212`, `_buildSQL` rewrites at line 1217, NOT(NULL), alias duplication). Pre-Phase-1 task: enumerate every workaround and either replicate in `parser/normalizer.ts` or document as a fixed bug.
- **NULL / three-valued logic.** SQL standard vs AlaSQL behavior diverges. We default to AlaSQL behavior for back-compat (`expressions/nullLogic.ts`) and document each divergence.
- **Property ordering.** Some legacy tests assert specific column order. Decision upfront: new engine produces SELECT-clause column order. Tests relying on legacy ordering get a normalizer in the differential harness.
- **Resource subclass overrides.** Some Harper tables are externalized via Resource subclasses. `Table.put`/`patch`/`delete` may have subclass overrides; phase-4 prereq is to enumerate which Resource methods are commonly overridden and ensure operators call them via the resource, not LMDB directly.
- **Schema change races.** Snapshot the schema (`databases.ts` state) at plan time and pass through the operator tree; don't re-resolve mid-execution.
- **Performance regression on tiny queries.** A streaming pipeline has more per-row overhead than AlaSQL on inputs that already fit in memory. Mitigation: short-circuit in `PhysicalLimit`/`PhysicalProject`; include tiny-input cases in the perf budget.
- **Memory caps in HashJoin/HashAggregate.** Phase-2/3 must enforce `maxHashRows`. Phase 6 is the right time for spilling if observed need arises.
- **Transaction semantics for bulk mutations.** Legacy `dataLayer/insert.js` etc. may or may not be fully transactional today; the new path is _always_ transactional via `transaction(ctx, ...)`. Match legacy summary shapes (e.g., `inserted_hashes`, `message`) exactly even when nothing partially fails.
- **Permissions parity.** Keep `opAuth.verifyPermsAst` on the AlaSQL AST at the router boundary in phase 0–4. Reimplementation against the internal IR is a phase-6 task.
- **Connector tables / replicated tables.** Verify `Table.search` behavior on every `Table` subclass type before flipping the default.

## Critical files to modify

- `/home/kzyp/dev/harper-pro/core/sqlTranslator/index.js` — wire router into `processAST` (line 130).
- `/home/kzyp/dev/harper-pro/core/sqlEngine/**` — entire new directory.
- `/home/kzyp/dev/harper-pro/config/...` — add `sql.engine` flag.
- `/home/kzyp/dev/harper-pro/core/unitTests/sqlEngine/**` — new tests.
- `/home/kzyp/dev/harper-pro/core/integrationTests/sqlEngine/**` — new integration tests.
- (Phase 5 deletions) `core/dataLayer/SQLSearch.js`, `core/sqlTranslator/SelectValidator.js`, `core/sqlTranslator/sql_statement_bucket.js`, `core/sqlTranslator/alasqlFunctionImporter.js`.

## Critical files to read & reuse

- `core/resources/Table.ts` — `search` (line 1983), `put` (1461), `create` (1500), `patch` (1538), `delete` (1905); `attributes`, `primaryKey`, `indices`.
- `core/resources/search.ts` — condition shape, comparators, relationship-attribute join syntax (138–196), selectivity estimates, `prepareConditions`.
- `core/resources/transaction.ts` — `transaction(context, async () => {...})` for atomic mutations.
- `core/resources/databases.ts` — table resolution.
- `core/utility/functions/sql/alaSQLExtension.js`, `core/utility/functions/date/dateFunctions.js`, `core/utility/functions/geo.js` — pure-JS function bodies to reuse.
- `core/utility/operation_authorization.js` — `verifyPermsAst` to keep on the AlaSQL AST boundary.
- `core/dataLayer/SQLSearch.js` — read for AlaSQL-quirk workaround inventory before Phase 1.
