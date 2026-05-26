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
| `analytics/`            | Telemetry recording (separate from monitoring)                                                                                       |

---

## `Resource.ts` — base class

Static methods are protocol entry points (each wrapped in `transactional()`); instance methods are the per-resource behavior hooks subclasses override.

| Member                             | Notes                                                                                              |
| ---------------------------------- | -------------------------------------------------------------------------------------------------- |
| `class Resource`                   | Generic over `Record extends object`                                                               |
| `constructor(identifier, source)`  |                                                                                                    |
| Static CRUD entry points           | `get`, `put`, `patch`, `delete`, `post`, `update`, `create`, `invalidate`                          |
| Static pub/sub entry points        | `connect`, `subscribe`, `publish`                                                                  |
| Static query entry points          | `search`, `query`                                                                                  |
| Static path helpers                | `parsePath` (URL → `RequestTarget`), `getResource` (path → class)                                  |
| Other statics                      | `getNewId`, `copy`, `move`                                                                         |
| Authorization hooks                | `allowRead` / `allowUpdate` / `allowCreate` / `allowDelete` — default impls; override per resource |
| Instance helpers                   | `getId`, `getContext`, `getCurrentUser`                                                            |
| `transactional()` wrapper          | **Do not remove from static methods** — owns transaction context lifetime                          |
| `missingMethod` / `allowedMethods` | 405 response helpers                                                                               |
| `transformForSelect`               | Select-clause expansion                                                                            |

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
| `#section: computed-history`     | `setComputedAttribute`, `deleteHistory`, `getHistory` (generator), `getHistoryOfRecord`, `clear`, `cleanup`, `_readTxnForContext`.                                                                                                                                                                                                                                |
| _(after the class)_              | `getFromSource()` — cache miss → source load (see `../DESIGN.md` for the resolve-before-commit timing trap); local helpers (`coerceType`, `isDescendantId`, etc.).                                                                                                                                                                                                |

---

## "Where is X" cheat sheet

| Question                                            | Where                                                                                                                              |
| --------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| How is a CRUD request authorized?                   | `Table.ts → #section: authz-hooks`; defaults in `Resource.ts` (`allowRead` etc.)                                                   |
| Where does versioning / conflict resolution happen? | `Table.ts → _writeUpdate` (`#section: write-path-internals`)                                                                       |
| How does `search()` choose an index?                | `Table.ts → search` (`#section: search-query`)                                                                                     |
| How are subscriptions replayed?                     | `Table.ts → subscribe` (`#section: pub-sub`)                                                                                       |
| How is the response body shaped (select clause)?    | `Table.ts → transformEntryForSelect` (`#section: search-query`)                                                                    |
| Where is record-level TTL evaluated?                | `Table.ts → setTTLExpiration` (`#section: lifecycle-admin`); `Updatable.getExpiresAt` (`#section: setup-and-factory`)              |
| How are residencies enforced (replication)?         | `Table.ts → #section: lifecycle-admin` (residency block: `getResidencyRecord`, `setResidency`, `setResidencyById`, `getResidency`) |
| How is the RecordObject prototype applied?          | `RecordEncoder.ts` (see `../DESIGN.md`)                                                                                            |
| Where is the per-request transaction stored?        | `transaction.ts` + `contextStorage` (AsyncLocalStorage)                                                                            |

---

## Conventions

- **Never** remove `transactional()` from a static method on `Resource` — it owns transaction context lifetime.
- New `Resource` subclasses should override **instance** methods (`get`, `put`, ...) for behavior; static methods are the protocol entry points and stay generic.
- When adding a new early-return path inside a commit handler in `_writeUpdate`, follow the blob-cleanup protocol documented in `../DESIGN.md` ("Blob orphan cleanup").
- If you add a new top-level section to `Table.ts`, drop a `// #section: <name>` marker at its start and add a row to the section map above.
- Tests for this layer live in `../unitTests/resources/`.
