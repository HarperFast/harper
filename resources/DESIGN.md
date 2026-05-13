# resources/ — Navigation Guide

The Resource layer is Harper's universal abstraction: all queryable/mutable things (tables, caches, message topics, custom endpoints) extend `Resource`. Inbound protocols (REST, GraphQL, MQTT, NATS, WebSockets) all converge on this interface.

**Read this when:** you're touching the read/write path, authorization, subscriptions, or table CRUD semantics.

See also: `../DESIGN.md` for cross-cutting non-obvious internals (RecordObject prototype, `getFromSource` timing, blob orphan cleanup).

---

## File overview

| File                      | Purpose                                                                                                                            |
| ------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `Resource.ts` (800 lines) | Base class; `transactional()` wrapper; method routing                                                                              |
| `Table.ts` (4744 lines)   | Table-as-Resource implementation. Factory `makeTable()` returns a `TableResource` subclass per table. **See section index below.** |
| `Resources.ts`            | Registry mapping URL paths → Resource classes                                                                                      |
| `RequestTarget.ts`        | Parses path/query into a structured target                                                                                         |
| `ResourceInterface.ts`    | Type definitions (`Context`, `Record`, etc.)                                                                                       |
| `RecordEncoder.ts`        | msgpack encoding + `entryMap` (record → storage entry)                                                                             |
| `IterableEventQueue.ts`   | Async iterable used for subscriptions and streaming responses                                                                      |
| `transaction.ts`          | Per-request transaction object stored in `contextStorage`                                                                          |
| `auditStore.ts`           | Append-only audit log records                                                                                                      |
| `nodeIdMapping.ts`        | Maps node IDs ↔ timestamps for replication ordering                                                                                |
| `openApi.ts`              | Generates OpenAPI/JSON Schema from `@export` schemas                                                                               |
| `analytics/`              | Telemetry recording (separate from monitoring)                                                                                     |

---

## `Resource.ts` — base class

The class itself spans **lines 41–461**.

| Member                                                      | Line                  | Notes                                                                |
| ----------------------------------------------------------- | --------------------- | -------------------------------------------------------------------- |
| `Resource` class declaration                                | 41                    | Generic over `Record extends object`                                 |
| `constructor(identifier, source)`                           | 48                    |                                                                      |
| `static get` (transactional)                                | 57                    | Entry point — wraps instance `get()`                                 |
| `static put`                                                | 91                    |                                                                      |
| `static patch`                                              | 117                   |                                                                      |
| `static delete`                                             | 129                   |                                                                      |
| `static getNewId`                                           | 139                   |                                                                      |
| `static create` (overloads)                                 | 150–192               |                                                                      |
| `static invalidate`                                         | 192                   |                                                                      |
| `static post`                                               | 199                   |                                                                      |
| `static update`                                             | 207                   |                                                                      |
| `static connect`                                            | 214                   | WebSocket-like persistent connection                                 |
| `static subscribe`                                          | 225                   |                                                                      |
| `static publish`                                            | 232                   |                                                                      |
| `static search`                                             | 244                   |                                                                      |
| `static query`                                              | 257                   |                                                                      |
| `static copy` / `static move`                               | 268 / 279             |                                                                      |
| `static parsePath`                                          | 320                   | URL → `RequestTarget`                                                |
| `static getResource`                                        | 351                   | Path → Resource class lookup                                         |
| `allowRead` / `allowUpdate` / `allowCreate` / `allowDelete` | 393 / 397 / 401 / 405 | Default permission hooks — override per resource                     |
| `getId` / `getContext` / `getCurrentUser`                   | 412 / 419 / 427       | Instance helpers                                                     |
| `transactional()` wrapper                                   | 475                   | **Do not remove from static methods** — breaks transaction isolation |
| `missingMethod` / `allowedMethods`                          | 688 / 698             | 405 response helpers                                                 |
| `transformForSelect`                                        | 735                   | Select-clause expansion                                              |

---

## `Table.ts` — section index

4744 lines, one giant `makeTable()` factory (line 136 → 4607) that returns a `TableResource extends Resource` class. Jump by responsibility:

### Setup & factory (lines 136–218)

- `makeTable(options)` opens at **136**
- Attribute parsing & primary key detection: **155–175**
- Replication wiring: **185–195**
- `class Updatable` (RecordObject prototype): **200–218** — provides `getUpdatedTime`/`getExpiresAt`, `addTo`/`subtractFrom`

### `TableResource` class begins: line **220**

### Static configuration (228–274)

Properties: `name`, `primaryStore`, `auditStore`, `primaryKey`, `indices`, `audit`, `databasePath`, `attributes`, `replicate`, `sealed`, `splitSegments`, `getResidencyById`, `dbisDB`, `schemaDefined`.

### Resource registry / sub-class resolution (263–639)

- `static sourcedFrom(source, options)` — **263–527** (the largest static; sets up cache/source hierarchy)
- `static get isCaching` / `shouldRevalidateEvents` — **528 / 534**
- `static getResource(...)` — **546–614** (path-to-class lookup)
- `static _updateResource` — **615**
- `ensureLoaded()` — **625**

### Lifecycle / admin (640–941)

- `static getNewId()` — **640–813** (id generation strategies: UUID, autoincrement, prefix, time-based)
- `static setTTLExpiration` — **814**
- Residency: `static getResidencyRecord` (**832**), `setResidency` (**836**), `setResidencyById` (**848**), `getResidency` (**860**)
- `static enableAuditing` — **897**
- `static coerceId` — **908**
- `static async dropTable` — **913**

### Read path (942–1055)

- `get()` overloads & impl — **942–1055**

### Authorization hooks (1056–1165)

- `allowRead` — **1056**
- `allowUpdate` — **1104**
- `allowCreate` — **1131**
- `allowDelete` — **1158**

### Write path — public API (1167–1588)

- `update()` overloads & impl — **1167–1239**
- `save()` — **1240**
- `addTo()` / `subtractFrom()` — **1253 / 1264**
- `getMetadata` / `getRecord` / `getChanges` / `_setChanges` / `setRecord` — **1271–1286**
- `invalidate()` — **1287**
- `static operation()` — **1484**
- `put()` — **1494**
- `create()` — **1533**
- `patch()` — **1571**

### Write path — internals (1589–2021)

- **`_writeUpdate()` — 1589–1942** (the central write routine, ~353 lines). Handles versioning, conflict resolution, audit, residency, replication metadata, and blob orphan tracking. The `write.skipped` flag mentioned in `../DESIGN.md` is set in this method's early-return paths.
- `_writeInvalidate()` — **1301**
- `_writeRelocate()` — **1348**
- `static _recordRelocate()` — **1408**
- `static evict()` — **1439**
- `lock()` — **1481**
- `async delete()` — **1943**
- `_writeDelete()` — **1970**

### Search & query (2022–2639)

- `search()` — **2022–2271** (the query engine; index selection, filter evaluation)
- `static transformToOrderedSelect` — **2272–2439** (select-clause ordering)
- `static transformEntryForSelect` — **2440–2639** (record → response shape)

### Pub/Sub (2640–3028)

- `async subscribe()` — **2640–2937** (~297 lines — subscription request handling, replay, cursor management)
- `static subscribeOnThisThread` — **2938**
- `doesExist()` — **2941**
- `publish()` — **2952**
- `_writePublish()` — **2972**

### Validation (3029–3197)

- `validate(record, patch?)` — **3029–3197** (~168 lines — schema enforcement, computed attributes, attribute coercion)

### Stats & admin (3198–3501)

- `getUpdatedTime` — **3198**
- `static async addAttributes` — **3201**
- `static async removeAttributes` — **3218**
- `static getSize` / `getAuditSize` / `getStorageStats` — **3232 / 3239 / 3247**
- `static async getRecordCount` — **3255**
- `static updatedAttributes` — **3318–3501** (~183 lines — schema diff machinery)

### Computed / history / cleanup (3502–3598)

- `static setComputedAttribute` — **3502**
- `static async deleteHistory` — **3514**
- `static async *getHistory` — **3537** (generator)
- `static async getHistoryOfRecord` — **3555**
- `static clear` / `cleanup` / `_readTxnForContext` — **3589 / 3592 / 3595**

### After the class

- `async function getFromSource()` — **4062–~4400** (cache miss → source load; see `../DESIGN.md` for the resolve-before-commit timing trap)
- Helpers (`coerceType`, `isDescendantId`, etc.) — **4607+**

---

## "Where is X" cheat sheet

| Question                                            | File:line                                                                               |
| --------------------------------------------------- | --------------------------------------------------------------------------------------- |
| How is a CRUD request authorized?                   | `Table.ts:1056–1165` (allowRead/Update/Create/Delete), `Resource.ts:393–410` (defaults) |
| Where does versioning / conflict resolution happen? | `Table.ts:1589` (`_writeUpdate`)                                                        |
| How does `search()` choose an index?                | `Table.ts:2022`                                                                         |
| How are subscriptions replayed?                     | `Table.ts:2640`                                                                         |
| How is the response body shaped (select clause)?    | `Table.ts:2440` (`transformEntryForSelect`)                                             |
| Where is record-level TTL evaluated?                | `Table.ts:814` (`setTTLExpiration`), `Updatable.getExpiresAt` (`Table.ts:206`)          |
| How are residencies enforced (replication)?         | `Table.ts:832–895`                                                                      |
| How is the RecordObject prototype applied?          | `RecordEncoder.ts` (see `../DESIGN.md`)                                                 |
| Where is the per-request transaction stored?        | `transaction.ts` + `contextStorage` (AsyncLocalStorage)                                 |

---

## Conventions

- **Never** remove `transactional()` from a static method on `Resource` — it owns transaction context lifetime.
- New `Resource` subclasses should override **instance** methods (`get`, `put`, ...) for behavior; static methods are the protocol entry points and stay generic.
- When adding a new early-return path inside a commit handler in `_writeUpdate`, follow the blob-cleanup protocol documented in `../DESIGN.md` ("Blob orphan cleanup").
- Tests for this layer live in `../unitTests/resources/`.
