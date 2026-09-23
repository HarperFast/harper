# resources/ — Navigation Guide

The Resource layer is Harper's universal abstraction: all queryable/mutable things (tables, caches, message topics, custom endpoints) extend `Resource`. Inbound protocols (REST, GraphQL, MQTT, NATS, WebSockets) all converge on this interface.

**Read this when:** you're touching the read/write path, authorization, subscriptions, or table CRUD semantics.

See also: `../DESIGN.md` for cross-cutting non-obvious internals (RecordObject prototype, `getFromSource` timing, blob orphan cleanup).

> **Navigation convention.** This guide references code by **symbol name** (e.g. `_writeUpdate`) and by **section marker** (e.g. `// #section: write-path-internals`). Jump in your editor via go-to-symbol, or `grep` for the section marker. Line numbers drift; symbols and section markers don't.

---

## File overview

| File                      | Purpose                                                                                                                                                                                                                                           |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Resource.ts`             | Base class; `transactional()` wrapper; method routing                                                                                                                                                                                             |
| `Table.ts`                | Table-as-Resource implementation. Factory `makeTable()` returns a `TableResource` subclass per table. **See section markers below.**                                                                                                              |
| `Resources.ts`            | Registry mapping URL paths → Resource classes                                                                                                                                                                                                     |
| `RequestTarget.ts`        | Parses path/query into a structured target                                                                                                                                                                                                        |
| `ResourceInterface.ts`    | Type definitions (`Context`, `Record`, etc.)                                                                                                                                                                                                      |
| `RecordEncoder.ts`        | msgpack encoding + `entryMap` (record → storage entry)                                                                                                                                                                                            |
| `IterableEventQueue.ts`   | Async iterable used for subscriptions and streaming responses                                                                                                                                                                                     |
| `transaction.ts`          | Per-request transaction object stored in `contextStorage`                                                                                                                                                                                         |
| `auditStore.ts`           | Append-only audit log records                                                                                                                                                                                                                     |
| `derivedIndexRuntime.ts`  | Lock-elected, exact-cursor delivery of committed RocksDB log mutations to derived-index backends; chunked collection, flush cadence, rebuild phase, epoch fencing, shared readiness, lag policy. Design: root `DESIGN.md` § Derived-index runtime |
| `derivedIndexRegistry.ts` | Worker-local registration counts (which tables emit cache-eviction markers) and per-table write-admission checks for the lag policy                                                                                                               |
| `indexes/fullText*`       | Bounded native Fulltext adapter, lazy capability-checked binding, and wrapper-owned inspection/open/reset/reclamation lifecycle                                                                                                                   |
| `recordLock.ts`           | Exclusive record locks (harper#483): option contract, native key lock primitives (`lockAttemptKey`, `makeKeyLockHandle`, `acquireRecordKey`)                                                                                                      |
| `nodeIdMapping.ts`        | Maps node IDs ↔ timestamps for replication ordering                                                                                                                                                                                               |
| `openApi.ts`              | Generates OpenAPI/JSON Schema from `@export` schemas                                                                                                                                                                                              |
| `defineTable.ts`          | Code-first table authoring (`defineTable` + `types`) — a TS front-end to the canonical `table()` model                                                                                                                                            |
| `defineResource.ts`       | Per-method request contract (`defineResource` / `Resource.withSchema`, `t`, `schemaOf`) — typed handlers + edge validation                                                                                                                        |
| `jsonSchemaTypes.ts`      | Shared `JsonSchemaFragment` IR + `attributeToFragment` projector (one vocabulary for validation/OpenAPI/MCP)                                                                                                                                      |
| `analytics/`              | Telemetry recording (separate from monitoring)                                                                                                                                                                                                    |

---

## `Resource.ts` — base class

Static methods are protocol entry points (each wrapped in `transactional()`); instance methods are the per-resource behavior hooks subclasses override.

| Member                             | Notes                                                                                                                                                   |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `class Resource`                   | Generic over `Record extends object`                                                                                                                    |
| `constructor(identifier, source)`  |                                                                                                                                                         |
| Static CRUD entry points           | `get`, `put`, `patch`, `delete`, `post`, `update`, `create`, `invalidate`                                                                               |
| Static pub/sub entry points        | `connect`, `subscribe`, `publish`                                                                                                                       |
| Static query entry points          | `search`, `query`                                                                                                                                       |
| Static path helpers                | `parsePath` (URL → `RequestTarget`), `getResource` (path → class)                                                                                       |
| Other statics                      | `getNewId`, `copy`, `move`                                                                                                                              |
| Authorization hooks                | Legacy operation gates: `allowRead` / `allowUpdate` / `allowCreate` / `allowDelete`. Application-specific authorization belongs in operation overrides. |
| Instance helpers                   | `getId`, `getContext`, `getCurrentUser`                                                                                                                 |
| `transactional()` wrapper          | **Do not remove from static methods** — owns transaction context lifetime                                                                               |
| `missingMethod` / `allowedMethods` | 405 response helpers                                                                                                                                    |
| `transformForSelect`               | Select-clause expansion                                                                                                                                 |

---

## `Table.ts` — section map

One giant `makeTable()` factory that returns a `TableResource extends Resource` class. The file is divided into the sections below; each is anchored by a `// #section: <name>` marker — grep for the marker (or use VS Code's go-to-symbol within the section) to land directly.

| Section marker                   | Contents                                                                                                                                                                                                                                                                                                                                                                                                         |
| -------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `#section: setup-and-factory`    | `makeTable(options)` entry, attribute parsing & primary-key detection, replication wiring, `class Updatable` (RecordObject prototype: `getUpdatedTime`, `getExpiresAt`, `addTo`, `subtractFrom`). Ends where `class TableResource` opens.                                                                                                                                                                        |
| `#section: static-config`        | Static configuration properties: `name`, `primaryStore`, `auditStore`, `primaryKey`, `indices`, `audit`, `databasePath`, `attributes`, `replicate`, `sealed`, `splitSegments`, `getResidencyById`, `dbisDB`, `schemaDefined`, `expirationMS`.                                                                                                                                                                    |
| `#section: resource-registry`    | `sourcedFrom()` (cache/source hierarchy — the largest static), `isCaching`, `shouldRevalidateEvents`, `getResource()`, `_updateResource`, `ensureLoaded()`.                                                                                                                                                                                                                                                      |
| `#section: lifecycle-admin`      | `getNewId()` (UUID / autoincrement / prefix / time-based strategies), `setTTLExpiration`, residency (`getResidencyRecord`, `setResidency`, `setResidencyById`, `getResidency`), `enableAuditing`, `coerceId`, `dropTable`.                                                                                                                                                                                       |
| `#section: read-path`            | `get()` overloads & impl.                                                                                                                                                                                                                                                                                                                                                                                        |
| `#section: authz-hooks`          | `allowRead`, `allowUpdate`, `allowCreate`, `allowDelete`.                                                                                                                                                                                                                                                                                                                                                        |
| `#section: write-path-public`    | `update()`, `save()`, `addTo()`, `subtractFrom()`, `getMetadata`, `getRecord`, `getChanges`, `_setChanges`, `setRecord`, `invalidate()`, `operation()`, `put()`, `create()`, `patch()`.                                                                                                                                                                                                                          |
| `#section: write-path-internals` | **`_writeUpdate()` — the central write routine** (versioning, conflict resolution, audit, residency, replication metadata, blob orphan tracking). The `write.skipped` flag mentioned in `../DESIGN.md` is set in this method's early-return paths. Also `_writeInvalidate`, `_writeRelocate`, `_recordRelocate`, `evict()`, `lock()`/`unlock()` (record locks — see `../DESIGN.md`), `delete()`, `_writeDelete`. |
| `isPlainOptions`                 | _(after the class)_ argument-position helper for `lock()` (distinguishes `lock(options)` from `lock(target, options)`)                                                                                                                                                                                                                                                                                           |
| `#section: search-query`         | `search()` (the query engine — index selection, filter evaluation), `transformToOrderedSelect` (select-clause ordering), `transformEntryForSelect` (record → response shape).                                                                                                                                                                                                                                    |
| `#section: pub-sub`              | `subscribe()` (subscription request handling, replay, cursor management), `subscribeOnThisThread`, `doesExist()`, `publish()`, `_writePublish()`.                                                                                                                                                                                                                                                                |
| `#section: validation`           | `validate(record, patch?)` — schema enforcement, computed attributes, attribute coercion.                                                                                                                                                                                                                                                                                                                        |
| `#section: stats-admin`          | `getUpdatedTime`, `addAttributes`, `removeAttributes`, `getSize`, `getAuditSize`, `getStorageStats`, `getRecordCount`, `updatedAttributes` (schema diff machinery).                                                                                                                                                                                                                                              |
| `#section: computed-history`     | `setComputedAttribute`, `deleteHistory`, `getHistory` (generator), `getHistoryOfRecord`, `clear`, `cleanup`, `_readTxnForContext`.                                                                                                                                                                                                                                                                               |
| _(after the class)_              | `getFromSource()` — cache miss → source load (see `../DESIGN.md` for the resolve-before-commit timing trap); local helpers (`coerceType`, `isDescendantId`, etc.).                                                                                                                                                                                                                                               |

---

## "Where is X" cheat sheet

| Question                                                                       | Where                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| ------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| How is a CRUD request authorized?                                              | `Table.ts → #section: authz-hooks`; defaults in `Resource.ts` (`allowRead` etc.)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| Where does versioning / conflict resolution happen?                            | `Table.ts → _writeUpdate` (`#section: write-path-internals`)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| How does `search()` choose an index?                                           | `Table.ts → search` (`#section: search-query`)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| How are subscriptions replayed?                                                | `Table.ts → subscribe` (`#section: pub-sub`)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| Can a saved audit cursor still catch up, or has its history been pruned?       | `auditStore.ts → getAuditFloor` — internal; there is deliberately no public accessor (harper#2458). **No resume path consumes it yet** — harper#2448 is to have `Table.subscribe` read it inside the resume, so the check and the replay cannot drift apart; until then a `startTime` below the floor is still silently truncated. One non-resume consumer does: `Table.commit`'s out-of-order reconciliation skips the audit walk for a write below the floor (harper#2642) — see "Audit retention floor" below. Returns the database-scoped floor: a cursor below it must resync, and `Infinity` means the floor is unknown (fails closed). `cursor >= floor` means only that no prune that ran _with a floor recorded_ removed history _after_ the cursor (nothing is promised below the FLOOR — that history is what a prune takes; `[floor, cursor)` is below the cursor but still covered). Two things it cannot see: history a legacy prune removed _before_ the floor existed, which a clock rollback can leave the stamped starting floor below; and a `restore_backup`/checkpoint rollback, since it is not a generation check (harper#2451). See "Audit retention floor" below.                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| How is the response body shaped (select clause)?                               | `Table.ts → transformEntryForSelect` (`#section: search-query`)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| Where is record-level TTL evaluated?                                           | `Table.ts → setTTLExpiration` (`#section: lifecycle-admin`); `Updatable.getExpiresAt` (`#section: setup-and-factory`). Stored expiry metadata is resolved in the `_writeUpdate` commit closure: `options.expiresAt ?? context.expiresAt ?? (record @expiresAt field, if finite &amp; ≥ 0) ?? table default`. This metadata drives read-hiding + the cleanup sweep. The `@expiresAt` attribute is authoritative for **direct** put/patch only; cache/source fills persist via `recordUpdater` and derive expiry from `sourceContext.expiresAt` (source freshness / table default), not the field.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| Why does `search()` hide a row that's past its TTL but not yet swept?          | `Table.ts → transformEntryForSelect` unconditionally treats `entry.expiresAt < Date.now()` as gone (lazy eviction on read) — correct for a SELECT, but a mutation locating rows to overwrite needs the opposite: pass `target.includeExpired = true` (read by the SQL engine's `runUpdate`/`runDelete` via `SqlEngineContext.includeExpiredRows`) to treat such a row as a live match, matching the leniency a direct by-id `put`/`patch` already has (they skip this check entirely, since `Resource.patch`'s static options don't request `ensureLoaded`).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| How are residencies enforced (replication)?                                    | `Table.ts → #section: lifecycle-admin` (residency block: `getResidencyRecord`, `setResidency`, `setResidencyById`, `getResidency`)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| How is the RecordObject prototype applied?                                     | `RecordEncoder.ts` (see `../DESIGN.md`)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| Where is the per-request transaction stored?                                   | `transaction.ts` + `contextStorage` (AsyncLocalStorage)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| What is in `context.transaction` when no scope owns one?                       | Whatever the last table call left there. A completed scope leaves `RELEASED_TRANSACTION` (`DatabaseTransaction.ts`), which reads latest and no-ops on commit. The next table call finds no transaction and `Table.ts → txnForContext` installs an `ImmediateTransaction` in the slot. It reports `open === OPEN`, but `transaction()` and `Resource`'s dispatcher gate on `isJoinableScope` — OPEN _and_ staging its writes for a later commit — so they never join it and start their own scope instead (#2292); `txnForContext` keeps returning it for reads and for writes that reach no wrapper, and those commit per write. It is also the only transaction that opens its native handle inside its own `commit()` (its `getReadTxn` never opens one), which is why `commit()` re-reads `this.transaction` after its save loop (#2288).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| How do I find a transaction that is holding write intents and is never reaped? | Three log surfaces, joined by the native transaction id (`longLivedTransactions.ts`, #2471). `runLongLivedTransactionSweep()` runs on the **main thread only** — rocksdb-js's registry is process-global, so one sweep sees every worker's handles — and names any handle open past `storage.longTransactionReportThreshold` (default `5m`, `0` disables all three), including handles no `DatabaseTransaction` owns. Changing the threshold clears the accrued backoff, so a handle already under observation is re-measured against the new value. `reportIfLongLived()` in each worker's monitor reports every link holding its own handle under that link's own id, adding `startedFrom`, the table, and the state keeping it alive (`source-apply`, `replay`, `commit-phase`, `active` when written in the current or preceding monitor tick), which is what the reap branches below it deliberately do not do. Attribution lines are capped at 10 per monitor tick; a summary names deferred holders, whose due backoff remains intact for a later tick. Attribution suppression is keyed on database path, native id, and handle-open time, so a reattached descriptor id cannot inherit its predecessor's backoff. The two stuck-commit logs (`checkOverloaded()` and `abandonCommitAfterDeadline()`) append holder candidates from **every** database, the commit's own first and then by age — the verification table is one process-global slot array, so a holder in another database parks this commit at the same rate — never filtered by age, because a coordinated retry can park on a transaction younger than itself. |
| How does a query opt out of a read snapshot?                                   | Pass `snapshot: false` on the search request (e.g. `get_analytics`). `Table.ts → search` calls `txn.useReadTxn(snapshot === false)`; on RocksDB `DatabaseTransaction.getReadTxn` then builds the read txn with `{ disableSnapshot: true }` so a long scan reads latest without pinning a snapshot. No-op on LMDB (`LMDBTransaction.useReadTxn`).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| How does a URL path map to a Resource?                                         | `Resources.ts → getMatch` (exact/prefix fast path) then `matchParamRoute` (parameterised routes); see "Path routing" below                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| What do chained conditions (`a=ge=X&=le=Y`) mean over array values?            | SAME-ELEMENT scoping: `prepareConditions` (`Table.ts → search`) collapses the chain into one range comparator (`gele`/`gtlt`/…) before execution, so the indexed path (per-element index entries, one range scan) and the unindexed path (`search.ts → attributeComparator`, per-element `some` over the collapsed predicate) agree. Repeating the attribute as two independent conditions is independently existential (different elements may satisfy different legs). Only a single `and`-chained leg is supported — `\|=` and a second `&=` are rejected. An indexed scan whose range spans more than one indexed value collapses to one result per record before paging (`search.ts → distinctRecords`, #2434), so `limit`/`offset` count records rather than index entries; element equality stays uncollapsed because `[indexedValue, primaryKey]` is already unique. Pinned by `unitTests/resources/query-array-scoping.test.js`; known gaps: chained-leg values are never type-coerced (#2433), an undeclared (untyped) indexed attribute holding an array still repeats per entry, error paths (#2435).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| How does HNSW keep the graph connected on delete?                              | `indexes/HierarchicalNavigableSmallWorld.ts → index()` delete path: zero-degree orphans reindexed via `needsReindexing`; severed multi-node islands detected and reconnected by `repairSeveredNeighbors` (#1712)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| How is a filter applied _during_ a vector search?                              | Predicate-aware traversal (#1241): `search.ts → executeConditions` composes companion AND conditions with request `vectorFilter` / `rowFilter` predicates into one `(primaryKey) => boolean` (`composeRecordFilter`) and passes it to `HierarchicalNavigableSmallWorld.search(cond, ctx, { filter })`. The filter gates result admission at layer 0 only (routing ignores it, ACORN-style); a visit budget (`filterExpansion`) bounds the under-filled/selective case. Very selective _condition_ filters are instead diverted to the exact brute-force path by the query planner's `estimateCountAsSort` ordering.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| How does post-ordering resolve vector distances safely?                        | Each comparator owns its `Sort`, passes it directly to the custom-index resolver, and caches distances by that immutable per-query sort object.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| How is application row filtering applied?                                      | Authorization admission happens in the resource operation before query work. The legacy `allow*` hook, when armed by the protocol, is evaluated once with its historical receiver semantics; overriding it never changes its scope. An operation override may add indexed conditions and/or attach the JavaScript-only synchronous `target.rowFilter(record, context)`. `Table.search` composes it with query filters and rechecks the final materialized cache/source record. `SubscriptionRequest.rowFilter` covers full-row events; `eventFilter(event, context)` explicitly handles tombstones/messages/raw events. Prefer indexed conditions because an opaque predicate may inspect every admitted candidate and `limit` applies after filtering.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |

**An audit record carries two clocks; never substitute one for the other (harper#2412 stage 0b).**
`AuditRecord.version` is the originating write's record version — LWW ordering in
`precedesExistingVersion`, `@updatedTime`, ETag/`Last-Modified`. Historical audit-only entries may
carry the surviving version instead. `AuditRecord.txnLogKey` is that
entry's key in the per-origin transaction log: write identity, the record→log lookup
(`auditStore.get(logKey, tableId, id, nodeId)`), and every resume cursor. On LMDB these have always
been distinct fields; on RocksDB the read surface used to overwrite `version` with the log key, and
`#2409`'s `recordVersion` alias is now absorbed back into `version`.

They hold the same value for every write whose record version is its own commit timestamp, which is
every ordinary local write, so a bug that confuses them stays invisible until a **source fill**
(`getFromSource`, core #2065): the record is stored at the source-reported version while its log
entry is keyed at the fill's commit. A RocksDB record stores its version in the existing word and,
when the clocks diverge, keeps its audit head in `additionalAuditRefs`; stage 2 can replace that
compatibility pointer with a dedicated log-key word.

Consequences worth knowing:

- **Identity is `(nodeId, log key)`, never a version.** `isAuditEntryWrite` (`auditStore.ts`) is the
  single predicate; `removeAuditEntry`'s tombstone removal and `blob.ts`'s orphan sweep both gate on
  it, and both retain rather than delete when identity is unknown. A version compare there would let
  one write authorize destroying another's tombstone or blob.
- **A RocksDB applied write carries its own record version.** `TransactionWrite.recordVersion`, set from
  `options.version` by every `_write*` builder and read in `save()` only when the transaction is
  `sourceApply` or `isReplay`, is how a replication receiver stores the origin's version while the
  transaction commits under the origin's log key — so a peer's copy of an origin's log stays in the
  origin's clock. New audit entries persist that write version even when an out-of-order merge leaves
  a newer record version in the primary store. `getAppliedWriteVersion` also bounds historical
  overloaded values by `txnLogKey`. One frame can carry writes at different record versions, so this
  cannot be a per-transaction value. Deprecated LMDB keeps its legacy transaction-version apply
  behavior.
- **`additionalAuditRefs[].version` is a log key, not a version.** Every consumer follows it straight
  into `auditStore.get` (`Table.ts`'s `auditRefsToVisit`). The list carries folded out-of-order
  branches and, when a RocksDB record version differs from its log key, the record's own audit head.
  Under stage 2 the stored reference field can be renamed; until then, "fixing" it to the record
  version silently unaddresses the entry it points at.
- **Crash replay uses both.** `replayLogs` delimits transactions by `txnLogKey` (which is also what
  `CorruptFrameStop.truncatedVersions` records) and replays each write at its stored `version`.
  Stamping a replayed record at its log key would move its version forward and make a later
  legitimate write look stale.
- **Compatibility surfaces still report `localTime` as the transaction timestamp.** Subscription,
  history, and pro-to-core replication event shapes predate this internal name and remain unchanged;
  no on-disk or on-wire identifier changes in this stage.

**QUERY admission uses the body projection.** `Resource.transactional` resolves an asynchronous HTTP QUERY body before resource resolution, recursively clones away client-supplied `checkPermission`, and copies the body's `select` onto the operation admission target before `allowRead`. After authorization, `Resource.query` transfers only the narrowed projection to the body target. This ensures a body-only relationship select is checked before `Table.search`; permission-control fields from QUERY data must never reach a search target.

**Async false-mode read gates preserve the streaming contract.** `Table.search` returns an `ExtendedIterable` carrying the internal `SEARCH_AUTHORIZATION` promise. Static `Resource.search` and `query` await that verdict before returning a response; on success the wrapper initializes the real search before the transaction settles so its normal read snapshot stays reserved until iteration completes. The marker follows supported iterable transforms and retains `selectApplied`/`getColumns`, so async or mapped delegation cannot turn a denial into a truncated successful response.

**Native query waits start on consumption.** A positive native `waitForIndexMilliseconds` preserves instance `Table.search`'s synchronous iterable result and normal `.map()`/`.concat()` composition. The custom-index adapter supplies a start gate: HNSW validates options and generation readiness synchronously, then waits for the first async pull before capturing its fixed coverage target. Zero-size pages start no native work. Count pages still materialize before returning.

Index waits use the ordinary transaction timeout; they do not renew it. The adapter reuses the range-scan snapshot guard, loads through the captured read handle, and checks predicate reads so expiration cannot silently switch to latest-state reads. Iterator closure aborts pending waits and skips late result materialization. OR/concatenated prefixes may stream before a later branch fails. Waiting queries do not publish a coverage header; clients must consume the stream and check its error records. HTTP first-item status deferral is tracked separately in Harper #2670.

**False-mode collection write gates stay per dispatch.** Built-in array PUT, query DELETE, and publish perform one request-scoped `allowUpdate`, `allowDelete`, or `allowCreate` verdict respectively. After query DELETE authorizes, it scans with a private cloned target whose permission check is disabled; the caller target stays untouched, and concurrent reads using it still run `allowRead`. Static publish overload routing marks the fresh per-dispatch resource receiver in `staticResourceDispatch.ts`, so copied targets and delayed delegation retain the `(target, message)` signature without putting reusable state on caller objects.

**Array PUT is a collection dispatch in both modes.** `Class.put(batch, context)` arrives with no target, so `transactional` synthesizes one — and the collection it inferred from the null id has to carry over onto it, or the resource resolves as a single record with a null primary key and the batch never fans out. Default (instance) mode then dispatches per element through `getResource`, and each element call must carry its own normalized target in the second position — minted by `elementTargetFactory` so the element's id and `isCollection === false` sit on top of the request's query and route metadata, with `checkPermission` deliberately omitted so a per-element dispatch cannot re-arm the verdict the collection receiver already gave. Each element gets its own object, because its id must not be visible to a sibling whose dispatch resolves later; the request's contribution is resolved once for the batch rather than deep-cloned per element, and nested metadata is shared rather than copied — not the outer collection target and not the context: `Table`'s back-compat `put(target, record)` shift only recognizes a target that is a `RequestTarget`, so a context there is taken for the record and staged as record data (harper#2000). A default-mode `put()` override consequently sees one call per element with that element's id and `isCollection === false`; a component that needs the whole array in one call belongs in `loadAsInstance === false` mode.

**A malformed element fails the whole batch, and never abandons a sibling write.** The dispatch loop starts each element's write as it goes, so an element that throws _synchronously_ — `null`, or an id the store rejects — aborts the loop with earlier writes already in flight. Those are settled before the batch rejects: otherwise a sibling that rejects afterwards has no handler and surfaces as an unhandled rejection. Any element that is not an object — `null`, `undefined`, or a primitive — is rejected _before_ anything is dispatched, so a malformed body cannot race a sibling's write and nothing needs unwinding. The nullish case alone is not enough: only a `Table`'s own key validation rejects a primitive later, so a plain `Resource`, or any `put()` override that writes onto the record it is handed, would otherwise be given one. For a failure raised once dispatch is underway the batch reports the **earliest-index** one, uniformly — the same rule whether that element's `getResource` resolved synchronously or asynchronously, so the reported error does not move with cache residency — and the surrounding transaction rolls every element back — array PUT is all-or-nothing, not per-element reporting. The up-front rejection names the offending index as a `ClientError`, so a malformed body cannot land as a 500 carrying an engine-generated `TypeError`. A resource class that implements no `put` answers 405 through `missingMethod` here, matching the single-record path rather than throwing a bare `TypeError`.

**The batch cannot settle while an element is outstanding.** `settleElements` — not `Promise.all` — closes the fan-out. `Promise.all` rejects the batch on the first failing element, which lets `transactional` unwind the transaction while a slower element is still resolving its resource; that element then stages its write against no live batch and commits on its own, leaving a _partially applied_ array PUT. It is only reachable once the async branch passes the target rather than the context — before that the late write failed for its own reasons and hid the hole — so the two fixes belong together. Every element has to stage or fail its write before the transaction may unwind. When several elements fail, the batch reports the **earliest-index** failure rather than whichever rejected first in wall-clock time, so the error a client sees does not move with scheduling. Only that one failure is reported: the framework does not attach a `cause` onto it, because the thrown value belongs to application code and may be a primitive, frozen, or a shared singleton that a per-request mutation would contaminate for every later request.

---

## Audit retention floor

`Table.subscribe`'s `startTime` replay just begins wherever the audit log now begins, so a consumer
resuming below the retention horizon is silently handed a short replay. The floor is the primitive
that makes that detectable (harper#2447). It is internal, with deliberately no public accessor, and **no
resume path consumes it yet**: harper#2448 is to put the check inside `Table.subscribe` itself — the same shape as
replication's `shouldForceBaseCopyForRetention`, and the only one where the floor cannot move between
being read and being acted on. Until then the short replay above is unchanged.

**The one consumer today is not a resume**: `Table.commit`'s out-of-order reconciliation reads the
floor before entering the audit walk (harper#2642). The walk terminates at the incoming write only by
reaching an audit entry at or below its version, so below the floor it cannot — it runs the whole
retained chain, one RocksDB end-of-log scan per step, to an outcome the floor already determines.
Two things that consumer does differently from a cursor check, and both are deliberate: it compares
the write's record version rather than a log key, because that is what the walk's own loop condition
compares; and it treats the `Infinity` unknown floor as **walk anyway** rather than as "not safe",
because here the conservative direction is to do the work, not to skip it. Below the floor a write
contributes only its commutative operations — a plain field's survival depends on what newer writes
did to that key, which is exactly what the pruned history no longer answers.

**The invariant: every path that prunes audit history raises the floor BEFORE removing anything.**
There are five, and the ordering is the whole guarantee — a floor written after the removal is lost
if the process dies in between, and the surviving lower floor then certifies a cursor whose history
is gone. Over-reporting (a floor covering more than the prune actually removed) costs a consumer one
unnecessary resync; under-reporting loses its data with no signal. So `raiseAuditFloor` is called
first and a throw from it is what stops the prune.

| Prune path                                                                   | Engine                                                                      |
| ---------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| `scheduleAuditCleanup` retention loop (`auditStore.ts`)                      | LMDB                                                                        |
| `scheduleAuditCleanup` → `purgeLogs`                                         | RocksDB                                                                     |
| `purgeAgedLogs` (boot/recovery, called from `replayLogs.ts`)                 | RocksDB                                                                     |
| `Table.deleteHistory`                                                        | LMDB (`RocksTransactionLogStore.remove()` is a no-op, so it must NOT raise) |
| `delete_transaction_logs_before` whole-database branch (`ResourceBridge.ts`) | RocksDB                                                                     |

Seven things that are easy to get wrong here:

- **The floor cannot be derived from the surviving log.** For four of the five paths the oldest
  surviving entry would do, because they prune a database-wide time prefix. `Table.deleteHistory`
  does not: it removes one table's entries out of a database-scoped log, so a sibling's entry
  survives _below_ the newest entry it removed. Measured, LMDB: highest removed `…147.797`, oldest
  surviving `…143.309` — a log-derived floor would have certified a cursor at `…145`.
- **The record's presence is the trust marker.** `Symbol.for('audit-floor')` is a different key from
  `last-removed`, which is still live and still maintained by the LMDB retention loop (#2338 hardened
  its write path and added tests for the retry-carry — do not remove it). They coexist because they
  answer different questions: `last-removed` records where the LMDB loop got to, after the fact,
  while the floor is written ahead of every one of the five prune paths and its commit is verified.
  A value found under `last-removed` therefore cannot be told apart from one carrying those
  guarantees, which is why the floor needs its own key rather than reusing it.
- **A store with no floor record is a store whose retention history we cannot account for.** That
  includes the empty audit store an LMDB→RocksDB migration leaves behind, since `bin/copyDb.ts`
  deliberately does not migrate it, and the audit-DBI-less result of a table-scoped backup taken
  without `include_audit` — so `openAuditStore` stamps `max(Date.now(), newest retained key)` as a
  one-time resync epoch. There is no permissive-baseline case: creating the audit DBI proves the
  DBI was absent, not that the database is new.
- **That epoch is a guess, and it is recorded as one.** Its bound is surviving state, which cannot see
  history a selective prune already removed: a legacy `deleteHistory` takes one table's entries out of
  the shared log, so a table that held the newest entries can leave the newest _survivor_ older than
  entries that are gone, and a clock rolled back between the two stamps a floor below them (#2458).
  Refusing to stamp is worse — `AUDIT_FLOOR_UNKNOWN` is absorbing (`raiseAuditFloor` cannot lift it,
  `establishAuditFloor` skips any existing record), so it would make every upgraded deployment fail
  closed forever. So `establishAuditFloor` writes the epoch under `Symbol.for('audit-floor-bootstrap')`
  first, then stamps the floor from what that record holds.

  **The record's presence is the signal; comparing it against the floor is not.** A store carrying one
  has an unverified pre-tracking window for as long as the record exists, however far the floor has
  since moved — a prune raising the floor above the epoch certifies only what that prune removed, and
  says nothing about history removed before tracking began, which may sit _above_ the epoch, since that
  is precisely what the guess could not see. Worked example: a v4-era `deleteHistory` removes tableA up
  to t=1000 while sibling tableB's newest survivor is 900; a rolled-back clock stamps bootstrap=900 and
  floor=900; a later retention pass raises the floor to 950. A repair keyed on `floor > bootstrap` would
  read 950 > 900, call it earned, and leave a consumer at cursor 970 certified over tableA's missing
  950–1000. So the mark is retired by a database generation (#2451), never by a floor that climbed past
  it; what the recorded _value_ is for is telling that repair how far the guess reached.

  Two properties it does depend on. **Ordering:** the record is written first, so a crash between the
  two writes leaves a record with no floor, which the next open retries because the early return tests
  the _floor_. **Undecodable bytes are overwritten** rather than kept — unlike the floor, where a
  present record may be a deliberate `AUDIT_FLOOR_UNKNOWN` and rewriting it would lower a floor.
  Keeping torn bytes pinned the store to unknown _forever_: the resolver skipped the write because a
  record existed, the read back failed identically on every later open, and no retry could succeed.

- **`getHistory` is not in the floor's time domain.** The floor is an audit-log key, which is what
  `subscribe`'s events carry as `localTime`; `getHistory` reports each entry's origin `version` under
  that same name, and a backdated or replicated write makes the two differ. A cursor saved from
  `getHistory` cannot be compared against the floor.
- **On RocksDB the floor tracks the configured retention horizon, not retained reality.** Whole-log-file
  purge granularity means the branch cannot know which entries a purge will drop, and the floor is
  written first, so each pass advances it to `Date.now() - auditRetention/(1+priority²)` whether a
  file was dropped or not. Entries below that horizon are often still on disk, and a cursor among
  them is told to resync — conservative in the safe direction only. LMDB can see a single eligible
  entry, so it raises off the first one it finds instead.
- **Untrustworthy metadata resolves to `Infinity`, not to a number.** A wrong-length record, or eight
  bytes decoding to NaN/negative, must not become a floor: `cursor < NaN` is false, so a consumer
  spelling the check that way would read corrupt metadata as safe.
- **A restore is outside what the floor can see.** `restore_backup` reinstalls the backup's floor
  along with everything else, so a cursor from after the backup point reads as safe against it. The
  audit floor is one of three carriers of resumable state a restore rolls back (record versions and
  per-node `Symbol.for('seq')` records are the others), so this wants a database-level generation
  rather than a fix in this one field — harper#2451.

---

## Path routing & parameterised routes

`Resources.ts` is the registry that maps URL paths to `Resource` classes. Resources are registered (`jsResource.ts`) from a component's exports:

- **Default path (convention):** the export name, resolved relative to the component's directory — `export class Widget` → `<dir>/Widget`.
- **Declared path (`static path`):** a `static path` field overrides the convention. A leading `/` makes it root-relative (top-level); `./` or a bare name is relative to the component directory.
- **Export-name-as-path:** `export { Widget as '/widget/:id' }` — the export name is the path (also honors the leading-slash root rule).

A path is **parameterised** if any segment begins with `:` (named param) or `*` (wildcard/catch-all):

```ts
export class Widget extends Resource {
	static path = '/widget/:id/action/:action';
	get(target) {
		// GET /widget/10/action/jump → target.id === '10', target.action === 'jump'
	}
}

export class Files extends Resource {
	static path = '/files/*rest'; // GET /files/a/b/c.txt → target.rest === 'a/b/c.txt'
}
```

Mechanics:

- **Registration** (`Resources.set`): parameterised paths are compiled into `paramRoutes` (kept _out_ of the base `Map`) so the exact/prefix matching fast path is untouched. Routes are ordered most-specific-first (more leading static segments, then longer patterns; wildcards rank last).
- **Matching** (`Resources.getMatch`): exact and prefix matches are tried first and win ("static wins"); only when no static resource matches — and only if `paramRoutes` is non-empty — does `matchParamRoute` run. Matched segment values are decoded and stored on `entry.params`.
- **Binding to the target:** request handlers (`server/REST.ts`, `server/DurableSubscriptionsSession.ts`) `Object.assign(target, entry.params)` after building the `RequestTarget`, so `:id` lands on `target.id`, `*rest` on `target.rest`, etc.
- Named params match exactly one segment; a wildcard captures the remainder (zero or more segments) and must be the final segment.
- **Discovery surfaces:** because parameterised routes live outside the base Map, the enumerators read `resources.paramRoutes` explicitly — `openApi.ts` emits them as templated paths (`:id` → `{id}`) with path parameters, and `components/mcp/resources.ts` lists them via `resources/templates/list` as `{param}` URI templates. `routePatternToTemplate` (exported from `Resources.ts`) is the shared `:param`/`*wildcard` → `{param}` converter.

Tests: `../unitTests/resources/paramRoutes.test.js` (unit) and `../integrationTests/apiTests/param-routes.test.mjs` (end-to-end); enumeration coverage in `../unitTests/resources/openApi.test.js` and `../unitTests/components/mcp/resources.test.js`.

---

## Persisted relationship catalog

GraphQL `@relationship` attributes are live objects in component workers, but the operations API runs in a separate thread that does not load component schemas. `processGraphQLSchema` therefore records each relationship's target `database.table`, and `table()` persists a normalized, data-only relationship list on the table's primary catalog descriptor. The primary descriptor is deliberate: older Harper versions ignore the unknown field instead of loading a per-attribute row without the runtime table definition and silently returning `null`.

`getDatabases()` waits until the complete table catalog is loaded, then hydrates catalog-owned relationship attributes with a stable target-class snapshot and calls `updatedAttributes()` to rebuild resolvers. The list is authoritative only when the GraphQL authoring path explicitly supplies `schemaRelationshipsDefined`; admin and replication callers that omit it cannot erase component-owned metadata. An empty list removes catalog-owned relationships. Live schema relationships and same-name runtime attributes always win, and `@enumerable` is not persisted, so operations queries traverse relationships only when explicitly selected.

The primary-descriptor update shares the `update-attributes` serialization boundary with `dropTable()`, re-reads the row after locking, and refuses to replace a drop tombstone. Missing or malformed targets are skipped rather than installed without authorization metadata.

Only the GraphQL authoring path persists relationships. `defineTable()` resolves its relation targets through a lazy thunk so forward references and cycles work, and the target class is not resolvable at registration time — so code-first relationships remain worker-only, and the operations API still rejects them as unknown attributes. Tightening the operations API's object/nested `get_attributes` form to reject names it cannot resolve is NOT an option: `Table.transformEntryForSelect` projects undeclared JSON sub-objects through that same form, so `validation/searchValidator.ts` deliberately leaves it unchecked.

Tests: `../unitTests/resources/schemaMigrationFragility.test.js` (catalog round-trip and failure behavior) and `../integrationTests/apiTests/graphql.test.mjs` (operations API in both directions).

---

## Typed, discoverable resources (code-first schema + request contract)

Design record: the full RFC and its type-level design proofs live in the design PR (**HarperFast/harper#1503**); this section is the retained summary.

**The principle.** Harper strips TypeScript at runtime (`--conditions=typestrip`), which erases types and rules out metadata-emitting decorators. So **runtime metadata must be values, and TypeScript types are _derived_ from those values — never the reverse.** Everything here is erasable syntax; the values survive stripping, the types are inferred, nothing can drift. One shared IR — `JsonSchemaFragment` (`jsonSchemaTypes.ts`), produced by `attributeToFragment` — feeds validation, OpenAPI, and MCP, so those surfaces cannot silently disagree.

**Code-first tables (`defineTable.ts`).** `defineTable(name, shape, opts)` authors a table in TypeScript and eagerly registers it through the same `table()` factory GraphQL drives — the returned value _is_ the live table class (`Track.get/put/...` work, `new Track()`/`instanceof` hold). Fields come from the `types` vocabulary (getter flags: `string.indexed`, `id.primaryKey`, `date.createdTime`); per-verb shapes are inferred projections discoverable as members (`(typeof Track)['$insert' | '$upsert' | '$patch' | '$query' | '$record']`). Relationships use lazy thunks (`types.relation(() => Album, { from })`) so forward references/cycles resolve at query time; `relationOf`/`hasManyOf` are the escape hatch for a mutual pair whose eager const-inference would otherwise collapse to `any`.

**Per-method request contract (`defineResource.ts`).** Two front-ends, same runtime metadata:

- `defineResource(contract, impl)` — function form (an object of verb handlers).
- `Resource.withSchema(contract)` — class form; `extends` it and implement the declared verbs. It pins `static loadAsInstance = false` so instance verbs receive the converged `(target, data)` arg order the types assume (the default dispatch order is `(data, target)` — see `Resource.post/put/patch`).

A contract is `{ path, record?, get/post/put/patch/delete: { query?, body?, response? } }`. Handler types are **derived** from it: path params from a template-literal parse of `path`, query/body/response from the schema's inferred type. It is a **subset, not a fork** — a handler gets the SAME `RequestTarget`, structurally narrowed (`target.id: string`, `target.get('expand')` typed by the query schema), and the resource still registers/serves like a plain one. The narrowed types are justified by **runtime enforcement**: each declared verb validates/coerces `query`/`body` before dispatch and throws a structured 400 (`ValidationError`, per-field `{ path, code, message }[]`) — the same bargain `Table.validate` makes for tables.

**Vocabulary.** The built-in `t` (`t.string/number/integer/boolean/date/enum/array/object`) and `schemaOf<T>(source?)` both reduce to `JsonSchemaFragment`. A `defineTable` projection slots straight into a contract body/response — `schemaOf<(typeof Track)['$insert']>({ table: Track, projection: 'insert' })` derives the compile-time type from the projection and the runtime fragment from the table's attributes (via `projectTableFragment` → `attributeToFragment`). **Nullability:** non-nullable by default (a bare `t.string` rejects `null`); `.optional` allows absence, `.nullable` allows an explicit `null`; table-derived bodies mirror `Table.validate`'s policy (null rejected only when `nullable === false`).

**Downstream surfaces.** `openApi.ts` emits a contract's query params, request body, and response for parameterised routes; `components/mcp/tools/application.ts` drives the tool input/output schema off the contract and binds arbitrary path params + query (`applyContractInputs`), which lifts the generated-verb binding restriction for contract resources. `ValidationError` (`../utility/errors/hdbError.ts`) extends `ClientError` (400) so existing HTTP handling is unchanged; the structured issues ride on `.detail`/`.errors`.

Tests: `../unitTests/resources/defineResource.test.js`, `../unitTests/resources/defineTable-registration.test.js`, `../unitTests/resources/openApi-contract.test.js`, `../unitTests/components/mcp/tools/application-contract.test.js`.

---

## Conventions

- A record's `toJSON` is a response projection, not durable state. `recordUpdater` (and the cache-fill
  and audit paths feeding it) projects records to stored fields via `storedFieldsOnly`, so no durable
  form carries a resolver-owned (`@computed`/`@relationship`) name; materialization skips such names
  when promoting a decoded record (`assignStoredFields`), which is what keeps rows written by affected
  releases readable. See harper#2359 and `integrationTests/resources/cachedComputedAttribute.test.ts`.
- **Never** remove `transactional()` from a static method on `Resource` — it owns transaction context lifetime.
- New `Resource` subclasses should override **instance** methods (`get`, `put`, ...) for behavior; static methods are the protocol entry points and stay generic.
- **Overriding a static entry point takes over its whole contract.** Assigning `static post`/`put`/`patch` on a subclass shadows the `transactional()`-wrapped static, so none of that wrapper runs — including the `when(data, ...)` that resolves `data` and the `allowCreate`/`allowUpdate` gate. That is by design (it is how `login.ts` implements a deliberately pre-authentication endpoint), and it means an override owns two obligations the wrapper would otherwise have met:
  - **`data` is a `MaybePromise` — `await` it.** Protocol callers pass `request.data` through unresolved; over REST that is the streaming deserializer's pending promise (`server/REST.ts` → `getDeserializer(…, true)`). A promise has no own enumerable properties, so skipping the `await` fails silently rather than loudly: `JSON.stringify(body) === '{}'` and every field reads `undefined`.
  - **The override makes the access-control decision.** No `allow*` predicate runs for it. An override that is not meant to be public must check authorization itself.
- **FK-side relationship accessors (`relationship.from`) are a synchronous contract** (v4 parity). The resolvers built in `Table.updatedAttributes` must read through `getSync`/`getEntry` (which block on a RocksDB block-cache miss, like v4's LMDB page faults) — never `get()`, whose `async: true` path returns a Promise on a cache miss and would leak an intermittent value-or-Promise to `record.<relation>` in user code. Pinned by the "relationship property access is synchronous" test in `../unitTests/resources/query.test.js`, which stubs `store.get` to throw.
  - **Known gap, not covered by that test:** the `.to` side (one-to-many/many-to-many, resolved via `relatedTable.search(...).asArray`) is synchronous for a local read, but `asArray` can still hand back a Promise when the search lands on a **caching** table whose row needs source revalidation — `transformEntryForSelect` returns `loadingFromSource.then(transform)` for an expired/invalidated entry. Same bug class this PR closes on the FK side; not yet fixed here.
- When adding a new early-return path inside a commit handler in `_writeUpdate`, follow the blob-cleanup protocol documented in `../DESIGN.md` ("Blob orphan cleanup").
- If you add a new top-level section to `Table.ts`, drop a `// #section: <name>` marker at its start and add a row to the section map above.
- Tests for this layer live in `../unitTests/resources/`.

---

## RecordObject prototype and entryMap

Records stored in tables are plain objects given a `RecordObject` prototype, which provides `getExpiresAt()` and `getUpdatedTime()`. These methods read from `entryMap` (a `WeakMap` in `RecordEncoder.ts`), which maps each record object to its storage entry.

- `RecordObject` is a shared runtime base class; every encoder creates an isolated `StoreRecordObject` subclass for its `structPrototype`, so table-specific computed getters do not leak across tables. Structon records inherit that prototype during decode. Classic msgpackr records decode as plain objects and are promoted by the store read wrappers before Harper exposes them.
- Use `record instanceof RecordObject` when behavior must apply to either exposed representation. Do not use `entryMap.has(record)` as a record-type test: `entryMap` exists for storage metadata, and some range-read paths can prototype-promote a record without registering that mapping.
- Point reads and other paths that need storage metadata call `entryMap.set(record, entry)` when exposing a record.
- To give a plain JS object the RecordObject prototype without copying it (preserving mutability), use `Object.setPrototypeOf(obj, primaryStore.encoder.structPrototype)` then `entryMap.set(obj, entry)`.
- Do **not** copy the object (e.g. via `Object.assign` into a new instance) if any code still holds a reference to the original and expects to mutate it — see below.

## Struct mode is gated to primary DBIs (downgrade compatibility)

`RecordEncoder` extends a structon encoder, whose random-access "struct" encoding uses header bytes in `0x20–0x3f`. That range overlaps msgpack positive-fixints, so a reader without struct support (msgpackr v1, i.e. harperdb v4) decodes a struct header as an integer. harperdb v4 only enabled struct mode (its `randomAccessStructure` option) on **primary** DBIs, so non-primary DBIs — notably the `__dbis__` metadata store (table/attribute defs) — were plain records mode. If v5 writes `__dbis__` in struct mode, a v5→v4 downgrade can't decode the metadata, silently treats the instance as a fresh pre-3.0 install, and refuses to boot.

To match v4: `OpenDBIObject` sets `randomAccessStructure = isPrimary`, and `RecordEncoder`, when `randomAccessStructure` is false, makes the struct **write** hook bail (`this._writeStruct = () => 0`) so objects are written in records mode. Two subtleties:

- We **bail** the hook (return 0) rather than clear it (`undefined`). Clearing it shifts msgpackr's positive-fixint boundary from `0x20` to `0x40`, so top-level integers `0x20–0x3f` (e.g. a `NEXT_TABLE_ID` ≥ 32 stored in `__dbis__`) would be written as bare fixints — which the still-installed struct **read** hook misreads as struct headers. Bailing keeps the boundary at `0x20`, so those integers are written as `uint8`.
- The struct **read** hook is left intact, so records a prior v5 already wrote in struct mode still decode (read-compat); only new writes switch to records mode.
- Companion change in `structon`: `prepareStructures` saves the shared structures in the legacy plain-array form when there are no typed structs (instead of the `{named, typed}` Map), so the `Symbol.for('structures')` buffer for a records-mode `__dbis__` is also v4-decodable.

## getFromSource() timing: promise resolves before commit runs

In `getFromSource()` (`Table.ts`), the promise that callers await resolves with the entry **before** the `dbTxn.addWrite` commit callback runs. The commit callback mutates `updatedRecord` in-place to set fields like `createdAt` and `updatedAt`. Since the resolved entry's `.value` is the same reference as `updatedRecord`, those mutations are visible to the caller after resolution.

Consequence: never replace `entry.value` with a copy of `updatedRecord` in this path — the copy won't receive the commit callback's mutations.

The sharing cuts both ways: the caller's mutations are visible to the **commit**, which encodes whatever the object holds at commit time. A downstream consumer that mutates the resolved record before the deferred commit runs corrupts what gets persisted — `finalizeResponse` (`server/REST.ts`) did exactly this, overwriting `.headers` with a web `Headers` (no enumerable own keys → stored as `{}`) and stamping `.status` (#1702; LMDB-only because RocksDB commits encode synchronously). Consumers must copy before mutating; `finalizeResponse` now copies any `entryMap`-tracked record.

## getFromSource() keeps source versions separate from fill ordering

`getFromSource()` reserves a fallback timestamp before calling the source so competing first fills
whose source does not report a version have a stable ordering token. An inherited request/transaction
timestamp is used when present; otherwise the storage engine supplies a monotonic timestamp. After
the source responds, a valid positive, finite, Date-representable `sourceContext.lastModified` is the
record's candidate version, and the reserved timestamp is only its fallback. A 304 retains the
existing version.

The candidate is capped at local time (`max(reserved token, Date.now())`). A record's version is also
this node's ordering token — `precedesExistingVersion()` compares a write's transaction timestamp
against it — so a source that reports a `lastModified` ahead of local time (a skewed origin clock)
would otherwise make every later local write to that row look out-of-order and be discarded until
wall-clock caught up. Capping costs the shared-version property only for that misbehaving case, and
the cap is logged.

The ordering token is not installed on `sourceContext.timestamp`: the source-resolution transaction
keeps its own default timestamp, so a slow fetch does not backdate its transaction-log entry. LMDB
stores the source candidate directly, preserving its separate source-version/local-time semantics;
only RocksDB clamps a non-advancing candidate because it uses one version for both roles.

Revalidations retain exact-CAS semantics, and a source miss cannot delete a record that raced the
fetch. First fills may replace a raced record only when their candidate version is strictly greater
than the raced record's. The comparison is deliberately not `precedesExistingVersion()`: that breaks
a version tie with the _executing_ node's name, and a fill from a shared source carries no node
identity of its own, so two replicas resolving the same tie could keep different values at the same
version — the one state anti-entropy cannot repair. On a tie the raced record wins on every replica. A
RocksDB replacement whose candidate cannot advance the current version stores at the current version
and carries `VERSION_REUSED` (`resources/RecordEncoder.ts`, aliasing rocksdb-js's own
`VERSION_NOT_UNIQUE_FLAG`); rocksdb-js 2.8.0 ([#766](https://github.com/HarperFast/rocksdb-js/pull/766))
then refuses to publish or confirm that version through the VerificationTable. This avoids inventing
an epsilon timestamp solely to force replacement while keeping stale record-cache values from being
vouched as fresh.

The flag is applied generically to every RocksDB record write whose version does not advance past
the record it replaces (`recordUpdater` in `RecordEncoder.ts`), not just this source-fill path — an
ordinary resequenced (out-of-order CRDT-merged) write gets it too. Those records remain ineligible
for VerificationTable fast-path confirmation until a later write advances their version.

## Blob orphan cleanup: pre-saved files outlive cancelled commits

Blobs flagged with `saveBeforeCommit` (or `saveInRecord`) are written to disk in the `beforeIntermediate` phase of a `TransactionWrite`, _before_ the LMDB/RocksDB write commits. The write's commit callback can still skip the actual record write — for older versions, supersedence by future updates, residency mismatches, or full transaction abort. In every such path the file is on disk but no record references it.

The mitigations live in three places:

- `startPreCommitBlobsForRecord` (`blob.ts`) returns the blob list alongside its completion callback so each `TransactionWrite` can attach a `savedBlobs: Blob[]`.
- `cleanupUnusedBlobs(blobs)` (`blob.ts`) waits for each blob's `saving` promise to settle, then `deleteBlob`s the file. It clears the input list so it's idempotent across repeated calls (e.g. an early-return that also gets caught by the abort path).
- `Table.ts` commit handlers set `write.skipped = true` (and reset to `false` at the top of each invocation) on early-return paths that don't write the record/audit: duplicate-tie, superseded-by-put, no-audit-fullUpdate-loses, and cache-resolve version-changed. The transaction commit success paths (`DatabaseTransaction.commit` and `LMDBTransaction.commit`) walk writes and call `cleanupUnusedBlobs(write.savedBlobs)` for every still-skipped write. Cleanup is deferred (rather than run inline in the commit handler) because the commit handler runs again on optimistic-lock retries, and a retry can flip a previously-skipped write into a successful one (e.g. the existing record gets deleted between attempts so the older replicated update suddenly wins). Inline cleanup would race the deletion's `setTimeout` against the retry that referenced the blob.
- `LMDBTransaction.abort` and `DatabaseTransaction.abort` walk all writes and run the same cleanup unconditionally (regardless of `skipped`), since nothing was committed. `DatabaseTransaction.commit` adds an explicit reject handler so a `Promise.all` failure on `completions` (e.g. a blob save errored) aborts the underlying transaction instead of leaking it _and_ the blob files.

**A blob instance outlives its file, so deletion tombstones it.** The `fileId` stays set on a `Blob` whose file has been unlinked, and `saveBlob` short-circuits on a set `fileId` — so a caller still holding the instance (the deploy recorder re-puts the same record object across a deploy) would re-encode a reference to a file that is gone. `cleanupUnusedBlobs` marks the blob's shared file state when transaction cleanup decides the file is no longer usable, before an in-flight save settles; slices share that state with their source. Ordinary supersession keeps its retention and re-reference window; reclamation marks every queued instance only after it claims the unlink. `saveBlob` throws on a discarded instance rather than minting a second reference (issue #2062).

When adding a new commit-handler early-return path: reset `write.skipped = false` at the top of the handler if you don't already, then set `write.skipped = true` immediately before the `return`. Decide first whether the audit log will reference the blob (via `auditRecordToStore`) — if it does, leave `skipped` unset. `cleanupOrphans` is the periodic safety net; don't rely on it for transactional correctness.

**Source-unavailable blobs must not abort the commit.** `startPreCommitBlobsForRecord().complete()` awaits each blob's `saving` promise; a rejection there propagates up and aborts the record's apply (the replication subscription loop catches and logs it as `error in subscription handler`). For a blob the replication source can no longer provide — evicted/expired at the origin, the receiver having flagged the rejection `sourceBlobUnavailable` (harper-pro#403) — that abort permanently wedged a replication copy stream on an expiration cache table whose TTL-evicted blobs are gone everywhere: every orphaned record's apply re-threw, the copy never advanced, and backpressure pinned at ~100%. `complete()` therefore tolerates a `sourceBlobUnavailable` rejection (`isSourceBlobUnavailable`): the record commits with a diverged blob reference, left for proactive backfill (harper-pro#388). Local/transient save faults stay unmarked and still reject, so the write aborts and a reconnect retries it — no silent loss. This is the apply/commit-side complement to the replication receiver's resume-cursor advance (harper-pro#403/#405), which handles the durability-watermark side of the same missing blob.

## Blob compression: policy at `saveBlob`, completeness via the writer lock, codec is per-file truth

Opt-in deflate compression for file-backed blobs (harper#2443) has three load-bearing placements. **Policy resolves in `saveBlob`, not `createBlob`:** every local blob write funnels through `saveBlob` (the msgpackr pack extension, pre-commit saves, native-Blob saves), including the HTTP-upload path, which never sees creation options — an explicit `compress` option or a pre-compressed source (`storedCodec`) still wins. The shipped `false` entries for already-compressed types merge under the operator's `storage.blobs.compression` map with same-key-operator-wins and exact-beats-wildcard precedence; unknown-size streamed writes never compress (a threshold cannot be evaluated without a size). **A compressed body's completeness authority is the writer lock, never its length:** the 8-byte header records the _uncompressed_ size, so the streaming read path (`stream()`'s `readCompressedBlob`) waits for the lock like `bytes()` always has. After the wait it checks **file identity** — `fstat` on its descriptor vs `stat` on the path — because an in-place repair renames a fresh (uncompressed) file over the path while holding that same lock, and can do so either during the wait or in the gap between the first read and the lock probe (so "did we wait" is not a reliable signal). If the inode changed, the descriptor is orphaned: it reopens the path (nulling `fd` before closing the stale descriptor, so a racing `cancel()` cannot double-close a reassigned fd, #1457) and re-reads the header — a repaired (now uncompressed) header is reported retryable 503 so a re-read serves the new file, matching `openStoredBlobBody`. If the inode is unchanged the descriptor is kept and the same-fd re-read still catches an in-place PENDING/ERROR stamp (harper-pro#481). It then inflates with a hard output ceiling at the declared size — a header that lies small is refused before emitting past it, and a clean deflate end short of the declared size is a torn body (500), not a short read. **The header type byte is per-file local truth:** the `storedCodec` hint stamped into stored blob-ref options is only a cheap prefilter for replication senders — every node re-encodes blob refs with local fileIds on apply, and `openStoredBlobBody`/`createBlobFromStoredBody` verify the actual bytes by concurrent inflate (sender: torn body → loud permanent error before the terminal frame; receiver: reject-before-publish), so no relayed metadata can ever mislabel a file. Both concurrent-inflate verifiers settle their pipeline from the inflater's `error`/`close`, not only from the per-chunk `write` callback: a mid-stream `Z_DATA_ERROR` (a corrupt, not merely truncated, body) fires `error`/`close` but never invokes the pending `write` callback, so a verifier waiting only on it would hang the write pipeline forever (receiver) or suspend the send generator with its descriptor and file hold un-released (sender). Do not "simplify" either to await only the write callback. **In-place repair classifies a compressed body once, unlocked and async, and confirms it locked by identity:** a deflate body torn by an unclean shutdown carries a finalized header recording the uncompressed size, so a length-only gate declines exactly the repair compression makes common — `blobFileMissingOrIncompleteAsync` inflates (streamed, output bounded at the declared size) and records the damaged file's `(length, header)` on its storage info; the locked sync recheck `blobFileMissingOrIncomplete` never inflates on the event loop and answers `true` for a deflate body only while length and header still equal that observation (writers only append and repairs replace the file, so unchanged length + header means unchanged bytes), otherwise `undefined`, which declines. Callers (harper-pro's copy-delivery repair) must probe async first. `openStoredBlobBody` sniffs synchronously (lock probe + header) but its `stream()` opens its own descriptor and re-reads the header — a mismatch means the announced form is gone (a repair rename landed) and is reported as a transient 503, not a corrupt body. Read streams own their descriptors in path mode — sharing an fd with an fs stream races its worker-thread `close(2)` (EBADF); the blob hold keeps the path alive instead.

## Over-time transactions are aborted, not force-committed (`DatabaseTransaction`/`LMDBTransaction`)

`startMonitoringTxns()` (a `setInterval` per engine) watches `trackedTxns` and acts when a transaction's `timeout` reaches 0 (after ~2 ticks of `STORAGE_MAXTRANSACTIONOPENTIME`, default 30s). A transaction is tracked once it acquires a read snapshot (`getReadTxn`).

- **Write-bearing request transactions are aborted and poisoned** (issue #1407). The monitor calls `abortDueToTimeout()`, which sets `timedOut`, forces `open = CLOSED` (so `doneReadTxn` takes the discard path instead of re-entering `commit()` via the `LINGERING` branch — which would now throw), then `abort()`s. `addWrite`/`commit` both guard on `timedOut` and throw `transactionOpenTooLongError` (503), so the in-flight request rolls back cleanly rather than the monitor silently force-committing a partial write set (atomicity violation + orphaned secondary-index entries that only a full rebuild repairs). The old behavior `commit()`d and reused the still-open transaction.
- **`hasPendingWrites()` walks the `next` chain.** Writes to a second database live on `transaction.next` (see `txnForContext`), so a transaction that reads database A (head, tracked via its read snapshot, empty `writes`) and writes database B (`next`) is still write-bearing. Without the walk the head looks read-only and the monitor's force-commit path would cascade-commit B. `abortDueToTimeout()` poisons + aborts the whole chain.
- **Read-only, `sourceApply`, and `isReplay` transactions keep the prior force-commit behavior.** Read-only long transactions (large scans/exports) have no atomicity/index risk and must not have their ongoing reads poisoned. Canonical-source applies (replication peer / external caching source) and crash-recovery replay have no resubscribe/resume path: aborting a write would drop it while the resume cursor advances past it — a permanent divergence (harper-pro#348). `sourceApply` is propagated down the `next` chain in `txnForContext`, so gating on the head suffices. (Replay is additionally synchronous, so the async monitor can't fire mid-replay anyway.)

- **A transaction parked in its commit phase is spared, not poisoned** (issue #2062). `commit()` sets `committing` around its pre-commit await (the `before`/`beforeIntermediate` completions — in practice a blob's durable file write) and the monitor logs instead of aborting while it is set. The limit polices an _application_ holding a transaction open with an unfinished write set; once `commit()` is entered the write set is sealed and the caller is awaiting the commit, so the time is core's own I/O, and a multi-tens-of-MB deploy payload legitimately outruns the limit. Poisoning there was actively destructive: `abort()` cleared the write set and unlinked the write's pre-saved blobs, and the resumed commit then found nothing to write and resolved as **success** — the caller was told its write landed, and was left holding a blob whose file was gone but whose `fileId` was still set, so its next `put` silently minted a reference to a destroyed file (the deploy-payload case: `Blob file not found` on the peer, unrecoverably). The grace is bounded — `COMMIT_PHASE_GRACE` over-limit ticks, ~10 min at the 30s default, since sparing re-arms `timeout` — because the transaction still pins a read snapshot; a source that stalls rather than finishing falls through to the normal abort. `sourceApply`/`isReplay` are spared without a bound: they may be neither aborted (harper-pro#348) nor force-committed mid-write (that would durably commit a replica record whose blob file is still being written), and their blob sources are bounded by the receive-side idle watchdog instead.
- **Resuming from that await re-checks that the transaction is still alive.** `timedOut` (monitor poison, including via the `next` chain) throws `transactionOpenTooLongError`; a write set cleared with the handle released — a plain `abort()` in the same window — throws `Transaction was aborted while its commit was waiting on pre-commit work`. Without both, either path resolves as a phantom commit. `LMDBTransaction.commit` carries the same pair around its own `before` phase.

**Extending the budget for one known-long write:** `DatabaseTransaction.timeoutBudget` is a per-transaction RocksDB floor applied whenever the transaction is re-armed (initial reads, writes, and active multi-store-chain propagation); the effective timeout is `Math.max(txnExpiration, timeoutBudget)`. This makes the budget sticky across a write's pre-commit existing-entry read and later writes, while never shortening a larger global `STORAGE_MAXTRANSACTIONOPENTIME`; RocksDB links added for another store inherit the same floor. Reads after a pending write do not re-arm the transaction: that preserves the idle-limit invariant for orphaned write-holding requests. Also, `resources/transaction.ts`'s `transaction(callback)` (no explicit context) joins whatever transaction is already open on the ambient AsyncLocalStorage context rather than guaranteeing a fresh one. `components/deploymentRecorder.ts`'s `withIsolatedTransaction` builds a new context from only the ambient audit/session/cancellation fields, so every recorder write commits independently without inheriting transaction controls. It uses the sticky budget to give `ingestPayload`'s blob-gated writes a size-appropriate limit instead of the generic default, while coalesced progress flushes are drained and suppressed until ingest settles to avoid same-row transaction conflicts. The ingest helper deliberately floors the shared `deployment_timeout` at ten minutes because `0` means “poll once” for peer waits; consequently an ingest can pin its system-database snapshot for that minimum. Known gap (harper#2057): the extension only reaches RocksDB transactions — on `HARPER_STORAGE_ENGINE=lmdb`, `Table.txnForContext()` chains a separate `LMDBTransaction` (`txn.next`) with its own independently-reset timeout that the LMDB engine's monitor tracks instead.

**A commit's conflict retries have their own deadline, separate from the open-transaction limit** (issue #2450). rocksdb-js ≥2.8 wakes a commit parked on another transaction's write intent after `ROCKSDB_JS_PARK_TIMEOUT_MS` (5s) and returns `RETRY_NOW_VALUE` even when the holder never releases, so a wedged intent presents as a stream of transient conflicts rather than one hung commit — and the `MAX_RETRIES` cap alone then keeps the request pending for ~40 park timeouts, minutes past the configured queue limit. `DatabaseTransaction.commitStartedAt` is stamped on the **chain root** at its first native submission and read at both retry decisions (the coordinated `RETRY_NOW_VALUE` resolve path and the `ERR_BUSY`/`ERR_TRY_AGAIN` rejection path); past `Math.max(STORAGE_MAXTRANSACTIONQUEUETIME, timeoutBudget)` the commit takes the existing `abortChainAfterRetries()` cleanup and throws a 503 `TransactionCommitConflictTimeoutError`. One clock per _logical_ commit, deliberately not per attempt: the per-attempt clock is `trackOutstandingCommit()`'s, which measures native liveness and drives `checkOverloaded()`'s thread-wide shedding, so back-dating it would let one uncapped `sourceApply` retry shed every unrelated request on the thread. The clock is released through the promise `commit()` returns (which settles only after the chained stores' commits), so a reused transaction's next batch starts fresh. `retryable` is true only on a chain root that has not rotated through a mid-scope commit — anywhere else an earlier store already wrote durable audit entries and ran its hooks that a replayed request would repeat. `sourceApply` is exempt, as it is from the attempt cap, for the harper-pro#348 divergence reason above.

## RocksDB range activity and snapshot expiration

`PrimaryRocksDatabase.getRange` and `RocksIndexStore.getRange` pass native ranges through `trackReadRange`. The native transaction's owner is captured once when constructing the range; each `next()` records activity before native access, including entries later discarded by filters. The transaction monitor consumes that activity at its existing cadence and applies the same read-only idle policy as point reads. It never renews a pending write holder merely because a scan advances. Iterator references still own the original snapshot; the wrapper does not reopen or rotate it. When a handle with no outstanding reader references is handed to the native commit/retry loop, its read-owner association is removed: retry handlers can construct new synchronous ranges on that still-live write handle without being mistaken for expired readers. Existing wrapped ranges retain their captured owner and cannot resume after their read ownership ends.

RocksDB 2.9.0 binds ranges to their supplied transaction and invalidates them when that transaction ends. An abandoned range is still bounded by the idle monitor. Resuming after its snapshot has been released throws an `ReadSnapshotExpiredError` (503) before accessing the native iterator; retry only the read, without replaying previously committed writes. A poisoned write-bearing transaction retains its existing 422 error and rollback behavior. Early iterator return remains a cleanup operation, including after expiration.

## Replicated apply failure listeners (`resources/replicatedApplyFailure.ts`)

`registerReplicatedApplyFailureListener(database, listener)` and
`unregisterReplicatedApplyFailureListener(database, listener)` are exported from `harper`.
They register one callback per database on the current worker; registering the same callback
again is idempotent, unregistering removes only that callback, and database removal clears all
of that database's listeners. A replication transport must register on every worker that runs
its source apply loop, before delivering events. Registration does not replay earlier failures.

The listener receives `{ database, table?, nodeId, position, localTime?, error }`. `nodeId` is
the audit header's translated origin id, not the immediate relay; `position` is the failed
event's original `timestamp` (the origin transaction-log key), inherited from the transaction
envelope for sub-writes without their own coordinates, never its record `version` or
peer resume `localTime`. Events without numeric origin and log coordinates cannot be attributed
and are not reported. A transaction commit failure uses its saved begin event, including when
an `end_txn` marker lacks an origin or a new `beginTxn` belongs to a different origin.

**No event is pulled from a replicated source after a terminal apply failure until every
registered listener for the database has been awaited with that failure's origin and position.**
Consecutive `beginTxn` events require pulling the new begin marker to close the preceding
transaction; the preceding failure's notification completes before staging that new marker's
write. The listener set is captured when notification starts, and callbacks run in registration
order outside the source transaction's async context. A listener may therefore persist a hole
in its own transaction. Dropped-entry notifications can run while the source transaction is
still open: persist to dedicated state keys/tables outside the replicated writes, and never
wait for that source transaction to commit. A listener must resolve only after its state is durable and be idempotent for
`(nodeId, position)`: a crash before the later cursor update can replay the same failure.

The hook covers terminal commit/staging failures, malformed transaction envelopes, unknown
operations, valueless puts, and explicitly discarded lock-control entries. These last cases also drain their
notifications before the next source pull, even inside an open transaction. A successful commit
followed by a failing `onCommit` callback or resume-cursor write is logged as before but does not
report a missing write. Conflict retries and successful no-op conflict/dedup resolution are
unchanged. An unsupported operation, including a future operation type, is reported because
core cannot certify that it applied it; transports should consume their own non-write markers
before forwarding events to the table apply loop. The outer subscription-error handler
terminates iteration and is not a skip.

Listener throws and rejections are logged individually and do not stop later listeners or change
continue-on-failure behavior. Core has no timeout or durable fallback for listeners: a hung
listener backpressures the source, and a rejected persistence operation cannot establish durable
hole state. The transport owns recovery and fail-closed behavior for those cases.

## Repeat writes to the same key in one transaction carry their state forward (`DatabaseTransaction`/`Table`)

A transaction can hold more than one write to the same record key — two `patch()` calls inside one `transaction()`, or a replicated transaction carrying two updates to a record. Each write captures `operation.entry` (its idea of the current record) when it is staged, and **neither engine can refresh that from a read**: LMDB queues staged puts and applies them only in the commit batch, so a `getEntry` inside that loop still returns the pre-transaction record (the exclusive `store.transaction()` fallback is no better), and RocksDB read-your-writes only sees writes already staged into the native transaction — which the source-apply path, staging its whole batch before `commit()`, hasn't done yet.

So the writes carry the state forward themselves: `addWrite` chains each write to the preceding write to the same store and key (`linkWrite` → `operation.priorWrite`), a commit handler publishes what it stored on `operation.stagedEntry`, and the next write reads it back through `priorStagedEntry()` and uses it as `existingRecord`. Consequences worth knowing:

- Only the **record** comes from the earlier write. The rest of the entry (version, `localTime`/audit chain, blob metadata) stays the pre-transaction one — that is what this write's audit entry and optimistic version check are relative to.
- Program order breaks **ties only** (`if (priorStaged && precedesExisting >= 0) precedesExisting = 1`). Every write in a transaction carries the transaction's single timestamp, so a version comparison against what the earlier write landed (e.g. on a retry round after a partial apply) is a tie that the out-of-order machinery would otherwise drop as a re-delivered duplicate. A _strictly newer_ existing version can only be a concurrent transaction's write observed on a retry round; a chained write still goes through the out-of-order merge for it (and a chained delete still yields to it) rather than silently overwriting it.
- A superseded write's **blobs are cleaned up post-commit**: when a later write to the key replaces (or deletes) the record an earlier write stored, the earlier write's `savedBlobs` are reachable only through its audit entry — so unless it wrote one (`blobsAuditReferenced`, in which case audit pruning owns them), the commit-cleanup pass deletes them, checked against the final committed record so a blob the later write retained survives. Without this, LMDB (whose replacement path never sees the intermediate entry) leaked the intermediate blob's file permanently.
- The per-key chain map key (`writeKeyId`) is the **store's own canonical key encoding** (ordered-binary, as a latin1 string). JS value identity is wrong in both directions: `1n` and `1` are the same stored key and must chain, while `[0]` vs `[-0]` and `[null]` vs `[NaN]` are different stored keys that JSON/string coercion collapse. Symbol and null keys keep native identity (not key-encodable; never stage records).
- `clearWrites()` discards the chain along with the write set on commit/abort, so a reused transaction never bases a write on a previous batch's staged state.

Before this (harper#1968), every write diffed against the pre-transaction record: the secondary index kept the intermediate value permanently (nothing reconciles an index against the records, so only a rebuild repairs it), and on LMDB the earlier write's changes were dropped outright.

The chain only describes reality if **staging order is also execution order**, and on RocksDB two things used to break that. `addWrite` runs a write's commit handler immediately unless the write sets `deferSave`; `_writeUpdate` does set it and depends on `resource.save()` to run the write, and the source/replication apply path calls `_writeUpdate` directly and never calls `save()` (`replayLogs` does, explicitly). So an apply-path put executes in the commit loop while a delete executes at staging time, whichever was staged first. And the apply loop itself dispatches each record's `writeUpdate()` without awaiting; that function suspends on an async record load (RocksDB `get` is synchronous only on a block-cache hit), so within one transaction a warm key can reach `addWrite` before a cold key that arrived earlier. A leader's `delete K; put K` then staged as `put K; delete K` and executed as `delete K; put K` with neither write chained to the other — both diffed against the pre-transaction record, the delete removed **every** index entry for the record and the put, whose indexed values matched that same record, did no index work at all and re-stored the record. Live record, no index entries, permanent (harper#2211).

Both orders are now pinned. `addWrite` defers a write whose earlier same-key write has not run yet, but **only for writes that both consume `priorStagedWrite()` and publish `stagedEntry`** — marked `chainsStagedState`, today the update and delete writes. `DatabaseTransaction.save()` applies the same rule when an explicit `resource.save()` bypasses `addWrite`: it drains that operation's unsaved predecessor chain oldest-first into the same native transaction before saving the requested write. `_writeInvalidate`/`_writeRelocate`/`_writePublish` consume and publish neither staged record state, so reordering them past a staged put would hand them a pre-transaction basis they have no way to correct; they keep their eager save. And the apply loop's `stageWrite` chains the writes to any one key through a per-transaction map so staging order is arrival order, dropping settled entries (a bulk transaction retains one entry per in-flight write, not per record) and short-circuiting successors when a predecessor rejects. LMDB was never exposed to the storage-order inversion: `LMDBTransaction.addWrite` defers every write and has always executed them in `this.writes` order.

An ordinary tracked update instance represents one staged write at a time. Once its write is selected for saving — explicitly, as an explicit save's predecessor, or by transaction commit — its direct and lazily tracked nested mutation surfaces throw 409 until `update()` stages a fresh write. Reads remain valid. Record-lock instances retain their separate lifecycle because scoped and held locks deliberately reuse the same instance and lock handle across explicit update/save cycles.

Two consequences of that scoping are worth knowing, both pre-existing and neither closed by the ordering fix. `_writeRelocate` still saves eagerly, so a replicated `put K; relocate K` where the residency list excludes this host strips K to its indexed-attribute stub first and then re-stores the **full record** — content retained on a node the residency policy excludes; `_writeInvalidate` has the milder form (a lost invalidation, so stale reads until TTL). Closing those means teaching both handlers `priorStagedWrite()`/`stagedEntry` and then flagging them, not simply deferring them. Separately, the apply loop's per-key chain narrows but does not close the cross-key escape: in `{put A, delete B}` where A's resource load rejects and B's is slow, the abort lands at `end_txn` and B's continuation then reaches `addWrite` on a CLOSED transaction, where `save()` commits it alone.

## A second sequential save() on the same ImmediateTransaction context must chain on `operation.innerCommit`

Two `update()`+`save()` cycles on the _same resource instance_, outside an explicit `transaction()`,
reuse the same `ImmediateTransaction` object even after its first cycle has closed it (`this.open =
CLOSED`). The second `save()` re-enters `ImmediateTransaction.save()` with `isCommitting` false, so it
calls `this.commit()` again; that `commit()`'s own sweep loop calls `this.save(newWrite, ...)` — a
**polymorphic re-dispatch to `ImmediateTransaction.save()`**, now with `isCommitting` true, which takes
the `super.save(operation, null, true)` branch and (since `this.open` is still `CLOSED`) creates its own
brand-new `RocksTransaction` and immediately commits it, stashing the real commit promise on
`operation.innerCommit`. But the outer `commit()`'s sweep loop discards the return value of
`this.save(operation, ...)` for every write it processes — that's fine when the write commits inline,
but this reused-context write's real work happens in a _third_, more deeply nested `commit()` call
(triggered by `immediateCommit` inside the nested `save()`), whose promise never propagates back through
any of the enclosing calls. `Table.save()`'s ordinary `#savingOperation` path used to just return
`#saveOperation(operation)`'s result directly — which can resolve before that nested native commit
actually settles, so a caller's `await resource.save()` can return before the write is durable (a real,
if narrow, race: `LockTest.get()` immediately after can read the pre-write value). The lock-writable hold
branch already avoided this by explicitly returning `operation.innerCommit` after its own recursive
`save()`; the ordinary path now does the same — `when(this.#saveOperation(operation), () =>
operation.innerCommit)`. `operation.innerCommit` is `undefined` when a write commits inline (no
immediateCommit), so this is safe for the common case. Found via record-lock scoped-lock staging
(harper#483), which is what first made this reused-closed-context pattern reachable for an ordinary
resource, but the gap is general to `Table.save()`, not lock-specific.

## A transaction is joinable as a scope only if it stages its writes (`transaction`/`Resource`/`Table`)

`txnForContext` builds an `ImmediateTransaction` for a context slot that is empty or holds
`RELEASED_TRANSACTION`, and installs it there — reached by anything that resolves a transaction without
going through the static-API wrappers, an instance load (`getResource`) being the common one. That
instance reports `open === OPEN`, but its `save()` **is** the commit (`saveCommits`), and nothing owns a
final commit or abort for it.

`TRANSACTION_STATE.OPEN` therefore carries two meanings that are not interchangeable: "will accept a
write" and "stages writes for an owner that will commit or abort them as a unit". Both join sites —
`transaction()` and the `transactional` dispatcher — ask `isJoinableScope()` for the second, not the
first. Joining on OPEN alone meant `transaction(ctx, …)` ran its callback and returned without ever
reaching its own `commit({ doneWriting: true })`: every write self-committed, a throw partway left the
earlier ones durable, and `onError`'s abort never ran — silently, with the handler returning success
(harper#2292, seen live on 5.2.5).

Two things follow from the same invariant:

- A chained link (`transaction.next`, a second database) inherits the head's commit discipline: under a
  self-committing head it is another `ImmediateTransaction`, transitively down the chain. Such a link is
  CLOSED once it has committed, and a further write through it would commit on a native handle nothing
  awaits (harper#2323), so a spent one — closed, no handle, no pending writes — is dropped from the chain
  and rebuilt rather than handed back. A staging link
  there is only swept up if the head's own database is written again (its commit cascades the chain), so
  a handler that writes the second database last silently loses that write.
- A deferred write (`deferSave`, which is every `_writeUpdate`) is only _triggered_ by
  `resource.save()`; it lives in the `writes` of whichever transaction `addWrite` put it in
  (`operation.stagedIn`). So `save()` can run after the context has moved on to a different
  transaction, which a scope opening in between now makes routine. A joinable scope **takes the write
  over**: `detachWrite` from the holder, `addWrite` onto the scope, and `priorWrite` cleared. Every
  commit path decides what to stage, what to replay onto a fresh handle for outstanding iterators, what
  to roll back and whose blobs to reclaim from `writes` alone, so a write in two lists is either
  committed twice or dropped by whichever list is consulted first; and the per-key basis chain belongs
  to the holder, so keeping it would diff the merge and the secondary index against a record that may
  never land. Otherwise the write stays with its holder, the transaction whose commit will see it. Never
  taken over from a `sourceApply` or `isReplay` holder: that never-drop-on-conflict policy lives on the
  transaction and would not travel with the write (harper-pro#348). And only where `addWrite` runs the
  write — `LMDBTransaction`'s never does (its commit applies `writes`), so on LMDB the holder always keeps
  it (`stagesWriteOnSave`). A write whose holder has already **finished** is not revived — it is dropped,
  as it was before any of this — because an aborted holder has already reclaimed that write's blobs, so
  committing it now would store a record pointing at deleted files. `validate` receives the transaction that is
  committing the write (`committedBy`) rather than closing over the one that staged it, so overload
  accounting, the replay marker and a no-op write's removal all follow the takeover.

Ownership is deliberately **not** the test. A context pre-seeded with an externally driven
`DatabaseTransaction` (`replayLogs.ts`, `Table.ts`) is not `scopeOwned`, yet it still owns the writes the
static API gives it and its own `commit()`/`abort()` still governs them; gating on `scopeOwned` would
move those writes onto a transaction the caller does not hold. Writes made with no scope at all keep
committing per write.

## The RocksDB codec is a deployment setting, resolved once per process

`getRocksCompression()` in `resources/databases.ts` resolves one codec for everything this process opens: `storage.rocks.compression` if it names one, otherwise `storage.compression` (default `true`) decides enabled-or-not and the build default supplies the algorithm. It is resolved on first use and frozen.

It has to be one codec, decided before the first open, because RocksDB opens **every** column family of a database in a single `DB::Open` and a family's compression cannot change while it is open. Harper cannot consult per-table metadata first: that catalog (`__dbis__`) is itself one of the families that call opens. So per-table `compression` metadata still records the LMDB-era boolean but no longer selects — a table persisted as disabled inside a deployment that enables compression would need its own codec, and there is nowhere to apply it.

Opens pass `compressionForAllColumnFamilies` (rocksdb-js) alongside the codec. Without it the binding gives every family the caller did not name its _persisted_ algorithm and applies the request only to the target, so families this process never names individually would keep their original codec forever — which is why a database created before the prebuild carried any codecs (every 5.1 instance) stayed uncompressed no matter how new the binary was, and why reconciling a table afterwards failed with `already open with compression ...; cannot reopen it with ...`.

The ordering that still has to hold is a fresh install: `install()` calls `mountHdb()` — which creates the system families — several steps before `createConfigFile()` writes the config file, so `installer.ts` stages the value into the in-memory config (`stageRocksCompression()`, mirroring the `STORAGE_ENGINE` line beside it) before `mountHdb()` runs. Measured without it, same pid: `thread=0 resolved=undefined`, `thread=1/2 resolved=zstd`, and the boot dies with "The system database failed to load".

Changing the codec governs newly written files. Existing SST/blob files keep theirs until rewritten; ordinary compaction will not do it (RocksDB skips the bottommost level without a compaction filter), so converting an existing database in place needs `compact({ bottommost: true })`.

Harper's normal RocksDB open path disables RocksDB's native WAL for primary and index column families; durable recovery for runtime transactions comes from rocksdb-js transaction logs. The root handle that owns those logs and the `__dbis__` metadata column family deliberately keep native WAL enabled. `copyDbToRocks` writes directly and does not create rocksdb-js transaction-log entries, so it can use the same no-native-WAL bulk path only when called by `migrateOnStart` for a `<database>.migrating` staging directory. The LMDB source remains authoritative until the copy and verification finish; an interruption deletes that staging directory and restarts the copy. The root and `__dbis__` handles retain native WAL, while every primary and index handle receives `disableWAL: true` (rocksdb-js stores the option per handle). Their metadata-sized WAL traffic is negligible beside the bulk copy. When the last handle closes, rocksdb-js flushes every column family and waits for background work before the verified staging directory is atomically renamed. A direct `copyDbToRocks` call to a non-staging path keeps native WAL enabled because it has neither transaction-log recovery nor the wrapper's discard-and-retry guarantee.

## Schema migration and `runIndexing` internals (`databases.ts`)

When `table()` is called with an attribute newly marked `indexed: true` (or with any change that requires re-building the secondary index), `runIndexing` is launched asynchronously and `Table.indexingOperation` is set to its promise. While running:

**In-flight state tracking (persisted to `attributesDbi`):**

- `attribute.indexingPID = process.pid` — set at migration start; cleared on clean completion. On restart with a different PID, `indexingPID !== process.pid` triggers a re-migration.
- `attribute.lastIndexedKey` — a resumable checkpoint, written at most once per checkpoint period and never before the record floor (`setIndexingCheckpointPeriod`), and only once the index writes it covers have settled and flushed. Cleared on clean completion; preserved on error so a retry starts from this key.
- `attribute.checkpointCertified` / `attribute.checkpointAlgorithm` — the key the checkpoint was stamped with, and the version of the algorithm that stamped it. A checkpoint resumes only when both match; anything else is rebuilt from scratch, because earlier releases could advance `lastIndexedKey` past a record whose index write failed. The algorithm stamp is also kept on a completed index, so a build made under a version that could skip a record stays distinguishable from one that could not.
- `attribute.indexingFailed = true` — set if any record's `index.put` errors during the backfill. `table()` checks this flag: a fresh call in the same or a new process re-triggers the backfill from `lastIndexedKey`.
- `dbi.isIndexing = true` — in-memory flag on the index dbi. Prevents `searchByIndex` from serving partial results (returns 503 "not indexed yet" instead). Cleared only when backfill completes cleanly.

**`isIndexing` propagation across `resetDatabases()` calls:**
When `signalSchemaChange('schema-change')` fires at the start of `runIndexing`, `syncSchemaMetadata` calls `resetDatabases()` which re-opens all tables via `table()`. This creates a _new_ dbi object and assigns it to `Table.indices[attribute.name]`. The condition `if (attributeDescriptor?.indexingPID) dbi.isIndexing = true` (just before `indices[name] = dbi` in the migration-detection block) ensures any dbi created while a migration is in progress also has `isIndexing = true`. Without this, a concurrent `resetDatabases()` would replace the in-progress dbi with a fresh one where `isIndexing` is false, allowing queries to read partial index results.

**Error handling:**

- Per-record sync errors: caught by the inner try-catch. Set `hadIndexingErrors = true`.
- Per-record async rejections (`index.put` returning a rejected Promise): every index mutation the build issues — each value's put, the drops for removed indexes, and the LMDB `clearAsync` — is registered in a per-build set that absorbs its own rejection and sets `hadIndexingErrors = true`. A record fans out into one put per indexed value, so tracking only the last one left the earlier puts' failures visible only if they happened to settle in time.
- A checkpoint drains that set before flushing and refuses to certify if any mutation it covers failed; completion drains it too, so "no errors" means every write settled rather than none had failed yet. The set also bounds how many writes stay in flight (`MAX_OUTSTANDING_INDEXING`).
- On any error: `indexingFailed = true` is persisted; `indexingPID`, `isIndexing`, and `lastIndexedKey` are kept. This leaves the index in 503 "incomplete" state rather than silently serving partial results.

**`Object.defineProperty(attribute, 'dbi', ...)` must use `configurable: true`:**
`attribute.dbi` is defined as a non-enumerable property (to prevent serialization to `attributesDbi`). It is defined with `configurable: true` so it can be re-assigned if the attribute participates in a retry cycle in the same process.

## Cluster-origin table definitions are additive-only (`databases.ts` `table()`)

`table()` distinguishes two kinds of callers by the `origin` field of the definition. Local schema authoring (create_table, `@table`, `defineTable`) is authoritative: its attribute list replaces the live one, and the catalog reconcile removes descriptors (and indexes) for attributes the list no longer declares. A definition with `origin: 'cluster'` — replication's DB_SCHEMA handshake (`ensureTableIfChanged` in harper-pro) or a replicated `define_schema` event (`Table.ts`) — is only ever a _snapshot of a peer's eventually-consistent view_: it can be captured mid-create (only the primary key registered yet) or read from a worker whose thread-local map hasn't absorbed a concurrent local create. Such definitions are applied additively: attributes the local table lacks are added, locally declared attributes are never removed or redefined, catalog descriptors are never reconciled away, and the local `schemaDefined` declaration is never flipped. Before this was enforced, a partial peer snapshot racing a local create_table permanently deleted the just-declared attributes' descriptors — and because the table was `schemaDefined`, the handshake's honor-local guard then refused to ever re-add them from peers, so searches failed with "unknown attribute" forever after (harper-pro nightly `replicationLoad` flake). The deliberate cost of additive-only: attribute _drops_ and _redefinitions_ do not converge through schema gossip — a stale peer can resurrect a locally dropped attribute, and a peer's redefinition of an existing name is discarded. Cluster-wide schema changes converge by applying the schema on every node (component deploy); a versioned schema exchange is the eventual fix. Every discarded peer difference is logged (`Ignoring peer redefinition of ...`), because a silently dropped `indexed` is otherwise indistinguishable from convergence. Where a catalog descriptor already exists, it is the authoritative declaration on this path and the incoming definition is restated from it — in both directions, so a field the descriptor dropped is dropped live too. That is what keeps a caller whose list predates a concurrent `create_attribute` from shadowing it in memory (losing the index registration for the rest of the worker's life) as well as on disk. One exception to "never writes an existing descriptor": an abandoned index build — `indexingFailed`, a foreign `indexingPID`, or a `restartNumber` older than this worker's generation — is still recovered, rebuilding the durable declaration rather than the caller's snapshot. Skipping recovery would leave the index's `isIndexing` flag pinned on with nothing left to clear it, so every query on the attribute would fail with `IndexRebuildingError` for the life of the worker. Regression coverage: `unitTests/resources/clusterSchemaMerge.test.js`.

**Remediating a node damaged before this was enforced.** The fix is forward-only. A node that already lost an attribute's catalog descriptor still has `schemaDefined: true` persisted, so the handshake's honor-local guard refuses to re-add the attribute from any peer and `search_by_value` keeps failing with `unknown attribute`; the recurring `Schema for '<db>.<table>' is defined locally, but attribute '<name>: <type>' from '<node>' does not match local attribute which does not exist` warn is the only detection signal. Local schema authoring is now the only path permitted to write that descriptor back, so remediation is to re-declare the attribute locally on the damaged node — the `create_attribute` operation, or redeploying the component whose `@table` declares it.

## A table is invisible to catalog scans until its create is complete (`databases.ts` `table()` / `initStores`)

The additive-only rule above repairs the _consumer_ of a partial peer snapshot; this rule stops the snapshot from existing. Every worker thread has its own `Table` map, rebuilt by `resetDatabases()` → `initStores` scanning the `__dbis__` catalog whenever any schema-change ITC signal arrives — including one for an unrelated database. On RocksDB catalog rows are individual `putSync` writes and the cross-thread `update-attributes` lock is taken only by writers, so a scan that lands inside a `create_table` used to see the primary row with none or some of the attribute rows, build a `Table` whose `attributes` was that partial list, and emit `updateTable` for it — which harper-pro forwards to peers as a DB_SCHEMA announcement. On a peer whose replication thread had not loaded the table yet, the announcement was applied as an authoritative definition and deleted the locally declared attributes (harper-pro `replicationLoad` "unknown attribute 'name'"; the partial announcement is visible in the node log as `(Re)creating { ... attributes: [ { name: 'id', ... } ] }`).

`table()` therefore writes the primary-key descriptor (`<table>/` — the row `initStores` needs before it will load a table; a row carrying `isPrimaryKey` is accepted too, for pre-5.x catalogs, so the primary-key descriptor must stay the last row written whatever key it lands on) only after every attribute row, still under the exclusive lock, and registers the class in this worker's `databases` map immediately after it. That write is also where the rollback stops: the row is durable the moment the put returns — on LMDB the `finally` that releases the exclusive lock commits the create's write transaction whether or not an error is unwinding — so a create that throws past it (registering the class, persisting relationships) keeps every row it wrote, and undoing them would leave the primary-only catalog this rule exists to prevent. `initStores` skips — with a warn — a table that has attribute rows but no primary row. The catalog is either invisible or complete to every other thread, so no thread can build or announce a partial `Table`. A scan that finds the incomplete catalog also drops a class it still holds from a dropped same-name table, rather than serving that stale generation through the recreate. A create that throws before its primary row is registered nowhere, and `table()` releases what it had opened for the class (primary store, index stores, the audit delete-removal callback, and its storage-reclamation handler — `removeStorageReclamationHandler`, because a RocksDB column family shares its reclamation path with every other family in the database). LMDB already had this property because `exclusiveLock()` there is an environment-wide write transaction. Consequence for an interrupted create: orphan attribute rows, no primary row, and the column families opened before the crash (as before), so the table does not load at all instead of loading with whatever attributes had landed; re-running `create_table` writes the rows, reuses the families, and the new-table reconcile removes any orphan row the new definition does not declare. The guarantee holds only once every schema-creating node runs this code: an older peer still announces primary-first snapshots, so the receiver-side additive rule above stays necessary. Regression coverage: `unitTests/resources/createTableCatalogOrder.test.js` (write order, a create failing on either side of the publish point, and a second worker thread scanning the catalog while the create is paused).

## Audit-store `'committed'` notification batching (`transactionBroadcast.ts`)

The cross-thread subscription path (default `crossThreads`) drives every `Table.subscribe()` consumer. When the database's audit store emits `'committed'`, we walk the audit log via a reusable iterator and dispatch matching records to subscribers. Three properties of this path are easy to break and worth knowing about before changing it:

- **`databaseSubscriptions.activeCount`** is the count of live `Subscription` instances on a database. It is incremented at the end of `addSubscription` (after the Subscription is created, so the `scope: 'full-database'` early-return path correctly skips counting) and decremented in `Subscription.end()`. `notifyFromTransactionData` short-circuits when this is zero — the reusable rocksdb iterator stays put and resumes from its position the next time a subscriber arrives. Without this short-circuit, an idle database with no subscribers still pays the audit-log iteration cost on every commit during replication backlog catch-up.
- **`notifyScheduled` + `setImmediate`** in the `'committed'` listener defers the iteration off the commit microtask. Multiple `'committed'` events that land in the same event-loop turn collapse into one notify pass. `notifyScheduled` stays set for the entire drain — including across yield-and-resume turns — so a re-entry from a new `'committed'` event cannot spawn a second concurrent notify on the same iterator.
- **Batched yielding** in `notifyFromTransactionData` (`NOTIFY_BATCH_SIZE`) is gated by `allowYield`. The `'committed'` path passes `allowYield = true`; the `listenToCommits` (same-thread `aftercommit`) path does not, because that path holds an inter-thread `'thread-local-writes'` lock that must not span event-loop turns. `subscribersWithTxns` is carried across yields via `subscriptions.pendingTxnSubscribers` so the `end_txn` signal fires exactly once when the iterator truly drains. When `activeCount` drops to zero mid-yield, the next continuation drops the carry-over to avoid invoking ended subscribers' listeners.
- **The ancestor key walk must strictly shrink.** `notifyFromTransactionData` notifies a changed key and then each `/`-delimited ancestor (`a/b/c` → `a/b/` → `a/` → the `null` root). It stops when the computed parent equals the current key, because a key rooted at `/` otherwise yields `/` as its own parent forever, and this loop is synchronous inside the notify pass with the batch yield outside it, so a single non-terminating walk seizes every worker holding a subscription on the table (harper#2687). Any change to the parent computation must keep a `/`, `/foo`, or `//x` key terminating in `unitTests/resources/transactionBroadcastKeyWalk.test.js`.

## Audit-entry removal loops must track every `removeAuditEntry()`/`removeEntry()` promise

`scheduleAuditCleanup` (`auditStore.ts`) and `Table.deleteHistory` (`Table.ts`, the LMDB path behind
`delete_transaction_logs_before`) both iterate a range of audit records and remove each one. Both were
originally written as `completion = removeAuditEntry(auditStore, auditRecord)` inside the loop, awaiting
only the final iteration's promise afterward. Any rejection from a non-last iteration was silently
discarded — the promise reference was overwritten before it could be awaited or caught — and surfaced
later as an unhandled rejection instead, with no logging to explain it. Any loop that removes
audit/primary-store entries in a batch must attach a rejection handler to every removal immediately
and drain all tracked promises before returning — never stash a per-iteration promise in an outer
variable to await only the last one. `Table.deleteHistory` allows up to 1,000 LMDB removals in flight
(ten for RocksDB) so storage writes batch without growing an unbounded pending
set. Live removals are tracked in a `Set`, and each one removes itself and wakes at most one parked
producer when it settles, so any completion releases the loop. In these removal loops, do not repeatedly
race the live set: each race attaches another reaction to every long-pending removal. Both phases drain
their tracked removals before settling, including when iteration throws. `scheduleAuditCleanup` remains
sequential because it is an automatic background loop.

Individual removal failures are logged and excluded from the returned count, but a purge that attempted
at least one removal and completed none rejects with the first error after both phases have drained.
Without that, `delete_transaction_logs_before` reports a successful `entries_deleted: 0` whether nothing
was eligible or the store rejected every write, and an operator pruning to bound disk growth has no signal
that pruning did nothing. Drain first, then decide: a failing store should still get every removal it can
accept, and a single success means the purge made progress and reports normally.

The optional primary-store cleanup snapshots each tombstone's key and version before yielding and passes
that version to `remove()`. LMDB enforces the condition natively. Harper's RocksDB adapter re-reads and
removes inside one native transaction, retrying a conflict once, because rocksdb-js's `remove()` accepts
an options object rather than an LMDB-style version argument. Never replace this with a separate live read
followed by an unconditional remove: a record recreated between those operations would be deleted.

`removeAuditEntry` has a second, nested version of the same hazard: for a `'delete'`-type audit record it
also invokes a per-table delete callback (`addDeleteRemovalCallback`) that removes the corresponding
primary-store tombstone. That callback's promise must be returned and joined with the audit-store
removal (currently via `Promise.all`, with the callback's own rejection caught and logged separately so
a failed tombstone cleanup doesn't get misreported as a failed audit-entry removal) — otherwise the
tombstone removal is fire-and-forget and the same detached-rejection hazard reappears one level down.
A tombstone whose cleanup fails this way is not swept automatically — `scheduleAuditCleanup`'s automatic
pass never retries it, since the audit entry that would have triggered a retry is already gone. It sits
in the primary store until an operator runs `delete_transaction_logs_before` with `cleanup_deleted_records: true`.

## Audit retention cleanup is a self-rearming, engine-independent lifecycle

One call to `scheduleAuditCleanup` establishes a retention cadence that ends when the root store closes
(or immediately in process-wide read-only mode). Storage-engine selection changes the work inside each pass, not whether the timer,
serialization barrier, error containment, and re-arm exist. LMDB removes bounded batches of audit
entries; RocksDB asks rocksdb-js to purge conservatively eligible log segments before the same time
cutoff. Disk-pressure callbacks may accelerate the next pass and shorten the effective window, but
ordinary retention progress must not depend on pressure.

The two engines do not share a cadence rule, because their units of progress differ. LMDB's adaptive
backoff reads a per-entry delete count: it speeds up while entries are being removed and doubles while
idle. Rocks reclaims whole segments whose eligibility changes only on rotation/flush, so the same
signal would only make it rescan the same files — its delay is instead a pure function of the
pressure-adjusted retention window (a tenth of it, floored at `DEFAULT_AUDIT_CLEANUP_DELAY`).

Exactly one Rocks purge loop exists per store, and that is owned by the **arming** sites, not the
re-arm: `onStorageReclamation` registers its handler only on the last worker (it takes no
`skipThreadCheck`), and the store-open arm gates on the same index. The last-worker conjunct on the
re-arm is therefore unreachable through either of those paths; it is a backstop for a direct caller
of the exported `scheduleAuditCleanup`, because a store-wide segment purge looping on every worker is
duplicated work. If a future change passes `skipThreadCheck: true` at the registration site, that
backstop — not the registration — becomes the thing keeping the loop single.

Both re-arm guards are **Rocks-only**, deliberately: the LMDB arm keeps `origin/main`'s unconditional
re-arm, so it neither yields to an already-pending pass (a pressure-armed 100ms pass can be cancelled
and replaced by the idle backoff) nor restricts itself to one worker. Those are pre-existing LMDB
behaviours, not invariants this section establishes — don't read the paragraphs above as
engine-independent.

Two things a purge does **not** need to coordinate, both load-bearing for the continuous cadence.
Unlinking a segment a consumer has mapped is safe **on POSIX**: the inode outlives the unlink, and the
mapping cache (`_logBuffers`) holds `WeakRef`s, with a strong ref only on the newest segment, which is
never purge-eligible — so nothing pins a purged inode and no cross-worker cache invalidation is
required. Windows does not share that property: deleting a mapped segment raises a sharing violation,
so the purge throws, is warn-logged, re-arms, and makes no progress for as long as a consumer holds the
mapping. The continuous cadence therefore turns a Windows retention stall into a steady state rather
than a one-off, and nothing covers it — the Rocks retention integration test skips win32.
What is _not_ covered is the segment a lagging consumer has not mapped yet: `TransactionLog.query()`'s
iterator returns `done` when its next segment cannot be mapped, indistinguishable from being caught up
(rocksdb-js `src/transaction-log-reader.ts`). A consumer that far behind needs a full copy rather than
log replay, so the gap is a missing escalation signal in the reader, not a reason to hold retention —
tracked as HarperFast/rocksdb-js#805. Continuous retention is what moves it from unreachable-in-steady-state
to routine: a peer offline longer than `logging.auditRetention` now resumes into a purged prefix and is
recorded as caught up, and `txnlogReplayGapBytes` observes the gap without escalating on it.

Retirement is two things, and teardown needs both. `stopAuditCleanup()` latches the loop closed and
cancels the pending timer, and it **returns a drain barrier** — a promise that settles once the pass
already running has finished. The barrier is what makes closing stores safe: lmdb-js stamps the DBI
number into its write instruction synchronously and the native writer consumes it later
(`node_modules/lmdb/write.js`), so a pass suspended inside `await removeAuditEntry()` still has a
delete pending against the primary and audit DBIs, and LMDB forbids closing a DBI an existing
transaction has modified. `dropDatabase()` and the legacy arm of `Table.dropTable()` await it.
`closeDatabase()` and branch `close()` are synchronous and cannot; what covers them is that every
environment touch remaining in a resumed pass — cursor advance, cursor release, marker write, re-arm —
re-checks `rootStore.status`, plus the fact that their production callers reach them only for RocksDB
stores, whose pass is one synchronous `purgeLogs()` call with nothing suspended mid-removal.
`resetDatabases()` closes LMDB roots with no retirement call at all, so that re-check is a routine
path rather than a defensive one.

The last-removed marker is retained until it commits. A rejected write is logged and carried to the
next pass rather than dropped: a pass that deletes nothing never reaches the write again, so one
transient failure would otherwise leave the recorded boundary permanently behind the entries that
were already removed.

## `createBlob(readable)` and `table.put()` don't synchronously drain the source

When a blob attribute is created from a Node `Readable` (e.g. `createBlob(stream)` then `row.payload_blob = blob; await table.put(row)`), the put does **not** wait for the underlying stream to fully drain into the file before resolving. Internally `saveBlob` kicks off a `writeBlobWithStream` pipeline whose `storageInfo.saving` promise is tracked separately. The put resolves once encoding has captured the blob reference; the bytes finish writing concurrently.

Consequence for callers that wrap the source in a hashing `Transform`: calling `hash.digest('hex')` after `await table.put()` is unsafe — more `chunk.update()` calls can still fire as the stream drains, producing `Error [ERR_CRYPTO_HASH_FINALIZED]: Digest already called`. Options:

- Buffer first, then hash + put (what `components/deploymentRecorder.ts` does for Slice A — small payloads only).
- Hash via Transform while extraction reads the stream, and only finalize the hash on the Transform's `'end'` event before any second put with the final hash.
- Await `storageInfo.saving` directly if you have a handle to the FileBackedBlob (the cleanest path for streaming).

Future agents touching `components/deploymentRecorder.ts` for Slice B's streaming variant should pick one of the latter two patterns.

## Table drops, the `dropping` tombstone, and ghost tables

A table is a set of RocksDB column families (`T/` plus `T/<attr>`) and a set of catalog rows
in the `__dbis__` store, with no transaction spanning the two. `Table.dropTable()` therefore
persists a `dropping: true` flag on the table's primary catalog entry (`T/`) before any
destructive work, then drops the column families (awaited - a failed drop must surface as the
operation's error, never a swallowed rejection), then removes the catalog rows. If the process
dies or a drop fails partway, the tombstone survives; both the boot-time schema load in
`databases.ts` (`completeInterruptedDrop`) and a same-name `table()` create complete the
interrupted drop instead of resurrecting the table. Without this, surviving catalog rows are
silently re-opened with create-if-missing on the next start, which resurrects "deleted" tables
(with their data, if the column families were never actually removed).

## RocksDB transaction log purges are database-wide only (`ResourceBridge.deleteTransactionLogsBefore`)

On RocksDB, every table in a database writes to one shared set of transaction logs (partitioned per
origin node, not per table), and `purgeLogs()` deletes whole log files — rocksdb-js has no table
filter, and adding one would mean rewriting files instead of deleting them. So a table-scoped
`delete_transaction_logs_before` is unimplementable at the storage layer; the bridge rejects
`table` on RocksDB with a 400 rather than silently purging every sibling table's history
(harper#2049 — the original code did exactly that, and a _typo'd_ table name did too, because a
missing table fell through to the no-table branch; that now 404s). Two consequences to preserve:
the deprecated `delete_audit_logs_before` op _requires_ `table`, so it always errors on RocksDB
(the message steers callers to the new op without `table`); and the table/no-table checks in the
bridge use `!= null` presence, not truthiness, so a table named `"0"` addressed numerically stays
table-scoped instead of widening to a database purge.

## Query-plan range estimation blends statistical estimates by confidence (`search.ts`)

`estimateCondition` estimates range comparators (`starts_with`/`prefix`, the `between` family,
`lt`/`le`/`gt`/`ge`) via the store's `estimateCount({start, end, …}) → { count, confidence }`
(rocksdb-js ≥ 2.8.0) instead of flat table fractions, blended as
`round(confidence × count + (1 − confidence) × fraction-heuristic)` so a low-confidence estimate
degrades to the historical behavior rather than replacing it. Invariants that are easy to break:

- **Capability is feature-detected per store** (`typeof store.estimateCount === 'function'`)
  because LMDB-backed and custom index stores do not implement it. The result shape is validated
  (`Number.isFinite(count)`, `0 ≤ confidence ≤ 1`) and the native call is try/caught, so a store
  that answers differently — or one closing concurrently — degrades the plan to the fraction
  heuristic instead of NaN-poisoning condition ordering.
- **The estimated range must be the executed range.** Construction mirrors `searchByIndex`'s
  comparator switch; bounds longer than `MAX_SEARCH_KEY_LENGTH` fall back entirely because
  execution truncates + filters (wider range than the estimable one). Two ways this has already
  been got wrong: `lt`/`le` need `searchByIndex`'s `start: true` lower bound, or the estimate
  counts the `[null, primaryKey]` entries an `indexNulls` index holds and execution skips (`true`
  sorts above `null`) — measured at 21× inflation on an index that is 99% nulls, which is worse
  than the flat heuristic it replaces; and `RocksIndexStore` must widen value-space bounds to
  `[value, MAXIMUM_KEY]` composite bounds, because the base implementation's byte-successor
  semantics exclude the wrong entries on composite `[value, primaryKey]` keys. `getRange` and
  `estimateCount` therefore share one `translateIndexBounds` helper rather than two copies.
- **Negated conditions estimate `Infinity` at the root** (`estimateConditionForTable`), following
  the filter-only convention (`contains`/`ends_with`): the negated flag always forces
  `needFullScan`, so `estimated_count` here is execution-cost ordering, not result cardinality —
  a narrow negated range must never look selective enough to become the driving condition.
- `estimatedEntryCount` reads `estimate-num-keys` (O(1)) rather than iterating; it skews high on
  overwrite/delete-heavy data until compaction, which is acceptable for the relative-ordering and
  explicitly-estimated consumers it feeds (and it is a divisor — keep the ≥1 floor).

## A table declaration lands where its application's `databases` binding resolves the name (`resources/databases.ts`)

`table()` is the global instance of an internal target-bound factory, `declareTable(target, definition)`.
A `TableTarget` is the small binding the declaration body needs and nothing more: the root store, the
`tables` graph the class is published into, what to do after a lost create race (another thread created
the table first), and who owns the column-family wrappers the declaration opens. The global target is
`database()` / `databases[name]` / `resetDatabases()`; a branch target (harper#2264) is that branch's
`rootStore` / `tables` / `reloadBranch`, and it adopts every wrapper into `branch.openedStores` so
`close()` releases them.

An application that declared `branchedDatabases` declares through `scopedTableFactory(branches)`, which
routes each declaration by database name — to the branch of that name, or to `table()` itself. GraphQL
`@table` (`graphql.ts`), `scope.ensureTable` (`components/Scope.ts`, `componentLoader.ts`) and
`defineTable` (`defineTableUsing`, through `security/jsLoader.ts`) all go through it. **An unbranched,
shared application gets `table` and `defineTable` by identity** — `scopedTableFactory(undefined) ===
table`. An isolated application gets a declaration-only wrapper even without branches, so its own
schema can claim maintenance that no pool worker configured; hydrated tables remain pool-owned.

Consequences to preserve:

- A branch root store's `databaseName` is its STORE identity (`initStores` stamps `storeName`), and the
  branch's blob roots resolve from it. The create path may only fill the name in when it is unset
  (`??=`), never overwrite it with the logical name.
- A branch Table class carries the base's logical name, so the Table statics that resolve the global
  schema by name (`dropTable`, `addAttributes`, `removeAttributes`, audit-enabling `subscribe`) stay
  refused through `assertSchemaMutable`. Schema evolution of a branch table is the factory's
  existing-Table path — the re-declaration `@table`/`defineTable`/`ensureTable` perform on every reload —
  which runs entirely against the branch's own store and catalog.
- A branch is scope-private: no `updateTable` event names a branch class (declaration, reload and
  relationship hydration all pass the announcement policy through), so replication and analytics never
  observe one. Cross-thread propagation still happens: the ITC schema-change signal carries
  `branchPath`, and `syncSchemaMetadata` (`server/itc/serverHandlers.js`) hands such a message to
  `reloadBranchAt`, which re-reads the catalog into the branch's `tables` on every thread that holds
  that branch open — the same pre-backfill signal the base path relies on so a worker keeps a new index
  maintained while another worker's backfill runs — instead of running the global rescan.
- The lost create race is handled per target: the global path rescans everything (`resetDatabases`);
  a branch reloads only itself, and the relationships that reload queues are hydrated through the
  application's own branch set (`branch.relatedBranches`, stamped by `prepareBranches`), never the
  global map.

## Ordering an in-memory result set reads each record at most twice (`Table.ts` `transformToOrderedSelect`)

Ordering an in-memory result set reads each record from the store at most twice: once to load it,
and at most once more to materialize it after the sort if the cache let it go in between. The
comparator never reads the store: sort keys are resolved once per row before the sort, so a GC
between load and compare cannot turn every comparison into a store read (harper#2675). The ordering
owns its working set; the cache cannot know about it.

## Each hop of a multi-store commit cascade starts with a full idle window (`DatabaseTransaction`)

Once a chain enters `commit()` its write set is sealed and the caller is awaiting the commit; the
idle limit polices an application holding a transaction open, not the commit itself. Every link
therefore starts each hop of the cascade with a full idle window of its own engine, never with the
remainder the pre-commit phase or an earlier hop happened to leave (harper#2675). The bound is per
hop: a native commit that stalls for a whole window still lets the monitor reap the waiting links,
and the cascade gains no crash or cross-store atomicity from this.

## `enc:v1:` env values decrypt through a registered decryptor, and skip non-fatally without one (`resources/loadEnv.ts`, `resources/secretDecryptor.ts`, `utility/envFile.ts`)

Core recognises the `enc:v1:` value prefix (`isEncryptedEnvValue`), exposes a decryptor registration
hook, and decrypts through the registered decryptor when loading `.env` files; the cryptography and
the cluster-shared private key live in the Pro env-secrets component. Without a registered decryptor
an encrypted value is skipped with an error logged, never fatally: the node still boots, the value
can be replaced through `set_env_value`, and a replicated encrypted value cannot crash a non-Pro
node. The application sees a missing variable rather than ciphertext. Plaintext and encrypted values
coexist per value; `get_env_keys` and `get_component_file` still expose key names only. The
envelope format, key model and client flow are user-facing and belong in HarperFast/documentation.

## Closing an LMDB database closes its environment, never its dbis (`databases.ts` `closeDatabase`)

Database aliases that resolve to one path share one LMDB root store, but each alias opens its own
dbi handles. `mdb_env_close` releases every dbi, while lmdb-js's native `DbiWrap.close()` calls
`mdb_dbi_close` on the `MDB_env*` it captured at open, so closing a dbi after another alias closed the
environment is a use-after-free (an intermittent segfault in the lmdb unit run). `closeDatabase` closes
an LMDB root once, only while `open`, skips its dbis, and unregisters every alias sharing it. RocksDB
column families are independently refcounted handles, so they are still closed one by one. Enforced by
the shared-store close cases in `unitTests/resources/databaseAliasIdentity.test.js`.
