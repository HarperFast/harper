# resources/ — Navigation Guide

The Resource layer is Harper's universal abstraction: all queryable/mutable things (tables, caches, message topics, custom endpoints) extend `Resource`. Inbound protocols (REST, GraphQL, MQTT, NATS, WebSockets) all converge on this interface.

**Read this when:** you're touching the read/write path, authorization, subscriptions, or table CRUD semantics.

See also: `../DESIGN.md` for cross-cutting non-obvious internals (RecordObject prototype, `getFromSource` timing, blob orphan cleanup).

> **Navigation convention.** This guide references code by **symbol name** (e.g. `_writeUpdate`) and by **section marker** (e.g. `// #section: write-path-internals`). Jump in your editor via go-to-symbol, or `grep` for the section marker. Line numbers drift; symbols and section markers don't.

---

## File overview

| File                    | Purpose                                                                                                                              |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `Resource.ts`           | Base class; `transactional()` wrapper; method routing                                                                                |
| `Table.ts`              | Table-as-Resource implementation. Factory `makeTable()` returns a `TableResource` subclass per table. **See section markers below.** |
| `Resources.ts`          | Registry mapping URL paths → Resource classes                                                                                        |
| `RequestTarget.ts`      | Parses path/query into a structured target                                                                                           |
| `ResourceInterface.ts`  | Type definitions (`Context`, `Record`, etc.)                                                                                         |
| `RecordEncoder.ts`      | msgpack encoding + `entryMap` (record → storage entry)                                                                               |
| `IterableEventQueue.ts` | Async iterable used for subscriptions and streaming responses                                                                        |
| `transaction.ts`        | Per-request transaction object stored in `contextStorage`                                                                            |
| `auditStore.ts`         | Append-only audit log records                                                                                                        |
| `nodeIdMapping.ts`      | Maps node IDs ↔ timestamps for replication ordering                                                                                  |
| `openApi.ts`            | Generates OpenAPI/JSON Schema from `@export` schemas                                                                                 |
| `defineTable.ts`        | Code-first table authoring (`defineTable` + `types`) — a TS front-end to the canonical `table()` model                               |
| `defineResource.ts`     | Per-method request contract (`defineResource` / `Resource.withSchema`, `t`, `schemaOf`) — typed handlers + edge validation           |
| `jsonSchemaTypes.ts`    | Shared `JsonSchemaFragment` IR + `attributeToFragment` projector (one vocabulary for validation/OpenAPI/MCP)                         |
| `analytics/`            | Telemetry recording (separate from monitoring)                                                                                       |

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

| Section marker                   | Contents                                                                                                                                                                                                                                                                                                                                                          |
| -------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `#section: setup-and-factory`    | `makeTable(options)` entry, attribute parsing & primary-key detection, replication wiring, `class Updatable` (RecordObject prototype: `getUpdatedTime`, `getExpiresAt`, `addTo`, `subtractFrom`). Ends where `class TableResource` opens.                                                                                                                         |
| `#section: static-config`        | Static configuration properties: `name`, `primaryStore`, `auditStore`, `primaryKey`, `indices`, `audit`, `databasePath`, `attributes`, `replicate`, `sealed`, `splitSegments`, `getResidencyById`, `dbisDB`, `schemaDefined`, `expirationMS`.                                                                                                                     |
| `#section: resource-registry`    | `sourcedFrom()` (cache/source hierarchy — the largest static), `isCaching`, `shouldRevalidateEvents`, `getResource()`, `_updateResource`, `ensureLoaded()`.                                                                                                                                                                                                       |
| `#section: lifecycle-admin`      | `getNewId()` (UUID / autoincrement / prefix / time-based strategies), `setTTLExpiration`, residency (`getResidencyRecord`, `setResidency`, `setResidencyById`, `getResidency`), `enableAuditing`, `coerceId`, `dropTable`.                                                                                                                                        |
| `#section: read-path`            | `get()` overloads & impl.                                                                                                                                                                                                                                                                                                                                         |
| `#section: authz-hooks`          | `allowRead`, `allowUpdate`, `allowCreate`, `allowDelete`.                                                                                                                                                                                                                                                                                                         |
| `#section: write-path-public`    | `update()`, `save()`, `addTo()`, `subtractFrom()`, `getMetadata`, `getRecord`, `getChanges`, `_setChanges`, `setRecord`, `invalidate()`, `operation()`, `put()`, `create()`, `patch()`.                                                                                                                                                                           |
| `#section: write-path-internals` | **`_writeUpdate()` — the central write routine** (versioning, conflict resolution, audit, residency, replication metadata, blob orphan tracking). The `write.skipped` flag mentioned in `../DESIGN.md` is set in this method's early-return paths. Also `_writeInvalidate`, `_writeRelocate`, `_recordRelocate`, `evict()`, `lock()`, `delete()`, `_writeDelete`. |
| `#section: search-query`         | `search()` (the query engine — index selection, filter evaluation), `transformToOrderedSelect` (select-clause ordering), `transformEntryForSelect` (record → response shape).                                                                                                                                                                                     |
| `#section: pub-sub`              | `subscribe()` (subscription request handling, replay, cursor management), `subscribeOnThisThread`, `doesExist()`, `publish()`, `_writePublish()`.                                                                                                                                                                                                                 |
| `#section: validation`           | `validate(record, patch?)` — schema enforcement, computed attributes, attribute coercion.                                                                                                                                                                                                                                                                         |
| `#section: stats-admin`          | `getUpdatedTime`, `addAttributes`, `removeAttributes`, `getSize`, `getAuditSize`, `getStorageStats`, `getRecordCount`, `updatedAttributes` (schema diff machinery).                                                                                                                                                                                               |
| `#section: computed-history`     | `setComputedAttribute`, `deleteHistory`, `oldestRetainedAuditTime`, `getHistory` (generator), `getHistoryOfRecord`, `clear`, `cleanup`, `_readTxnForContext`.                                                                                                                                                                                                     |
| _(after the class)_              | `getFromSource()` — cache miss → source load (see `../DESIGN.md` for the resolve-before-commit timing trap); local helpers (`coerceType`, `isDescendantId`, etc.).                                                                                                                                                                                                |

---

## "Where is X" cheat sheet

| Question                                                                 | Where                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| ------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| How is a CRUD request authorized?                                        | `Table.ts → #section: authz-hooks`; defaults in `Resource.ts` (`allowRead` etc.)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| Where does versioning / conflict resolution happen?                      | `Table.ts → _writeUpdate` (`#section: write-path-internals`)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| How does `search()` choose an index?                                     | `Table.ts → search` (`#section: search-query`)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| How are subscriptions replayed?                                          | `Table.ts → subscribe` (`#section: pub-sub`)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| Can a saved audit cursor still catch up, or has its history been pruned? | `Table.oldestRetainedAuditTime()` (`#section: computed-history`) → `auditStore.ts → getAuditFloor`. Returns the database-scoped floor: a cursor below it must resync, and `Infinity` means the floor is unknown (fails closed). `cursor >= floor` means only that no _prune_ removed history _after_ the cursor (nothing is promised below the FLOOR — that history is what a prune takes; `[floor, cursor)` is below the cursor but still covered) — it is not a generation check, so it cannot see a `restore_backup`/checkpoint rollback (harper#2451). See "Audit retention floor" below.                                                                                                                                                                                                                                                |
| How is the response body shaped (select clause)?                         | `Table.ts → transformEntryForSelect` (`#section: search-query`)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| Where is record-level TTL evaluated?                                     | `Table.ts → setTTLExpiration` (`#section: lifecycle-admin`); `Updatable.getExpiresAt` (`#section: setup-and-factory`). Stored expiry metadata is resolved in the `_writeUpdate` commit closure: `options.expiresAt ?? context.expiresAt ?? (record @expiresAt field, if finite &amp; ≥ 0) ?? table default`. This metadata drives read-hiding + the cleanup sweep. The `@expiresAt` attribute is authoritative for **direct** put/patch only; cache/source fills persist via `recordUpdater` and derive expiry from `sourceContext.expiresAt` (source freshness / table default), not the field.                                                                                                                                                                                                                                             |
| Why does `search()` hide a row that's past its TTL but not yet swept?    | `Table.ts → transformEntryForSelect` unconditionally treats `entry.expiresAt < Date.now()` as gone (lazy eviction on read) — correct for a SELECT, but a mutation locating rows to overwrite needs the opposite: pass `target.includeExpired = true` (read by the SQL engine's `runUpdate`/`runDelete` via `SqlEngineContext.includeExpiredRows`) to treat such a row as a live match, matching the leniency a direct by-id `put`/`patch` already has (they skip this check entirely, since `Resource.patch`'s static options don't request `ensureLoaded`).                                                                                                                                                                                                                                                                                 |
| How are residencies enforced (replication)?                              | `Table.ts → #section: lifecycle-admin` (residency block: `getResidencyRecord`, `setResidency`, `setResidencyById`, `getResidency`)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| How is the RecordObject prototype applied?                               | `RecordEncoder.ts` (see `../DESIGN.md`)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| Where is the per-request transaction stored?                             | `transaction.ts` + `contextStorage` (AsyncLocalStorage)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| What is in `context.transaction` when no scope owns one?                 | Whatever the last table call left there. A completed scope leaves `RELEASED_TRANSACTION` (`DatabaseTransaction.ts`), which reads latest and no-ops on commit. The next table call finds no transaction and `Table.ts → txnForContext` installs an `ImmediateTransaction` in the slot. It reports `open === OPEN`, but `transaction()` and `Resource`'s dispatcher gate on `isJoinableScope` — OPEN _and_ staging its writes for a later commit — so they never join it and start their own scope instead (#2292); `txnForContext` keeps returning it for reads and for writes that reach no wrapper, and those commit per write. It is also the only transaction that opens its native handle inside its own `commit()` (its `getReadTxn` never opens one), which is why `commit()` re-reads `this.transaction` after its save loop (#2288). |
| How does a query opt out of a read snapshot?                             | Pass `snapshot: false` on the search request (e.g. `get_analytics`). `Table.ts → search` calls `txn.useReadTxn(snapshot === false)`; on RocksDB `DatabaseTransaction.getReadTxn` then builds the read txn with `{ disableSnapshot: true }` so a long scan reads latest without pinning a snapshot. No-op on LMDB (`LMDBTransaction.useReadTxn`).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| How does a URL path map to a Resource?                                   | `Resources.ts → getMatch` (exact/prefix fast path) then `matchParamRoute` (parameterised routes); see "Path routing" below                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| What do chained conditions (`a=ge=X&=le=Y`) mean over array values?      | SAME-ELEMENT scoping: `prepareConditions` (`Table.ts → search`) collapses the chain into one range comparator (`gele`/`gtlt`/…) before execution, so the indexed path (per-element index entries, one range scan) and the unindexed path (`search.ts → attributeComparator`, per-element `some` over the collapsed predicate) agree. Repeating the attribute as two independent conditions is independently existential (different elements may satisfy different legs). Only a single `and`-chained leg is supported — `\|=` and a second `&=` are rejected. Pinned by `unitTests/resources/query-array-scoping.test.js`; known gaps: chained-leg values are never type-coerced (#2433), index scans duplicate records with several matching elements (#2434), error paths (#2435).                                                         |
| How does HNSW keep the graph connected on delete?                        | `indexes/HierarchicalNavigableSmallWorld.ts → index()` delete path: zero-degree orphans reindexed via `needsReindexing`; severed multi-node islands detected and reconnected by `repairSeveredNeighbors` (#1712)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| How is a filter applied _during_ a vector search?                        | Predicate-aware traversal (#1241): `search.ts → executeConditions` composes companion AND conditions with request `vectorFilter` / `rowFilter` predicates into one `(primaryKey) => boolean` (`composeRecordFilter`) and passes it to `HierarchicalNavigableSmallWorld.search(cond, ctx, filter)`. The filter gates result admission at layer 0 only (routing ignores it, ACORN-style); a visit budget (`filterExpansion`) bounds the under-filled/selective case. Very selective _condition_ filters are instead diverted to the exact brute-force path by the query planner's `estimateCountAsSort` ordering.                                                                                                                                                                                                                              |
| How does post-ordering resolve vector distances safely?                  | Each comparator owns its `Sort`, passes it directly to the custom-index resolver, and caches distances by that immutable per-query sort object.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| How is application row filtering applied?                                | Authorization admission happens in the resource operation before query work. The legacy `allow*` hook, when armed by the protocol, is evaluated once with its historical receiver semantics; overriding it never changes its scope. An operation override may add indexed conditions and/or attach the JavaScript-only synchronous `target.rowFilter(record, context)`. `Table.search` composes it with query filters and rechecks the final materialized cache/source record. `SubscriptionRequest.rowFilter` covers full-row events; `eventFilter(event, context)` explicitly handles tombstones/messages/raw events. Prefer indexed conditions because an opaque predicate may inspect every admitted candidate and `limit` applies after filtering.                                                                                      |

**QUERY admission uses the body projection.** `Resource.transactional` resolves an asynchronous HTTP QUERY body before resource resolution, recursively clones away client-supplied `checkPermission`, and copies the body's `select` onto the operation admission target before `allowRead`. After authorization, `Resource.query` transfers only the narrowed projection to the body target. This ensures a body-only relationship select is checked before `Table.search`; permission-control fields from QUERY data must never reach a search target.

**Async false-mode read gates preserve the streaming contract.** `Table.search` returns an `ExtendedIterable` carrying the internal `SEARCH_AUTHORIZATION` promise. Static `Resource.search` and `query` await that verdict before returning a response; on success the wrapper initializes the real search before the transaction settles so its normal read snapshot stays reserved until iteration completes. The marker follows supported iterable transforms and retains `selectApplied`/`getColumns`, so async or mapped delegation cannot turn a denial into a truncated successful response.

**False-mode collection write gates stay per dispatch.** Built-in array PUT, query DELETE, and publish perform one request-scoped `allowUpdate`, `allowDelete`, or `allowCreate` verdict respectively. After query DELETE authorizes, it scans with a private cloned target whose permission check is disabled; the caller target stays untouched, and concurrent reads using it still run `allowRead`. Static publish overload routing marks the fresh per-dispatch resource receiver in `staticResourceDispatch.ts`, so copied targets and delayed delegation retain the `(target, message)` signature without putting reusable state on caller objects.

---

## Audit retention floor

`Table.subscribe`'s `startTime` replay just begins wherever the audit log now begins, so a consumer
resuming below the retention horizon is silently handed a short replay. The floor is the primitive
that makes that detectable (harper#2447); `Table.subscribe` does not yet consume it (harper#2448).

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
