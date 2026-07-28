# DESIGN.md

Design notes and non-obvious internals for the harper-pro/core codebase. Complements AGENTS.md (architecture overview) and CONTRIBUTING.md. Grows incrementally as agents encounter non-obvious things.

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

## Blob orphan cleanup: pre-saved files outlive cancelled commits

Blobs flagged with `saveBeforeCommit` (or `saveInRecord`) are written to disk in the `beforeIntermediate` phase of a `TransactionWrite`, _before_ the LMDB/RocksDB write commits. The write's commit callback can still skip the actual record write — for older versions, supersedence by future updates, residency mismatches, or full transaction abort. In every such path the file is on disk but no record references it.

The mitigations live in three places:

- `startPreCommitBlobsForRecord` (`blob.ts`) returns the blob list alongside its completion callback so each `TransactionWrite` can attach a `savedBlobs: Blob[]`.
- `cleanupUnusedBlobs(blobs)` (`blob.ts`) waits for each blob's `saving` promise to settle, then `deleteBlob`s the file. It clears the input list so it's idempotent across repeated calls (e.g. an early-return that also gets caught by the abort path).
- `Table.ts` commit handlers set `write.skipped = true` (and reset to `false` at the top of each invocation) on early-return paths that don't write the record/audit: duplicate-tie, superseded-by-put, no-audit-fullUpdate-loses, and cache-resolve version-changed. The transaction commit success paths (`DatabaseTransaction.commit` and `LMDBTransaction.commit`) walk writes and call `cleanupUnusedBlobs(write.savedBlobs)` for every still-skipped write. Cleanup is deferred (rather than run inline in the commit handler) because the commit handler runs again on optimistic-lock retries, and a retry can flip a previously-skipped write into a successful one (e.g. the existing record gets deleted between attempts so the older replicated update suddenly wins). Inline cleanup would race the deletion's `setTimeout` against the retry that referenced the blob.
- `LMDBTransaction.abort` and `DatabaseTransaction.abort` walk all writes and run the same cleanup unconditionally (regardless of `skipped`), since nothing was committed. `DatabaseTransaction.commit` adds an explicit reject handler so a `Promise.all` failure on `completions` (e.g. a blob save errored) aborts the underlying transaction instead of leaking it _and_ the blob files.

When adding a new commit-handler early-return path: reset `write.skipped = false` at the top of the handler if you don't already, then set `write.skipped = true` immediately before the `return`. Decide first whether the audit log will reference the blob (via `auditRecordToStore`) — if it does, leave `skipped` unset. `cleanupOrphans` is the periodic safety net; don't rely on it for transactional correctness.

**Source-unavailable blobs must not abort the commit.** `startPreCommitBlobsForRecord().complete()` awaits each blob's `saving` promise; a rejection there propagates up and aborts the record's apply (the replication subscription loop catches and logs it as `error in subscription handler`). For a blob the replication source can no longer provide — evicted/expired at the origin, the receiver having flagged the rejection `sourceBlobUnavailable` (harper-pro#403) — that abort permanently wedged a replication copy stream on an expiration cache table whose TTL-evicted blobs are gone everywhere: every orphaned record's apply re-threw, the copy never advanced, and backpressure pinned at ~100%. `complete()` therefore tolerates a `sourceBlobUnavailable` rejection (`isSourceBlobUnavailable`): the record commits with a diverged blob reference, left for proactive backfill (harper-pro#388). Local/transient save faults stay unmarked and still reject, so the write aborts and a reconnect retries it — no silent loss. This is the apply/commit-side complement to the replication receiver's resume-cursor advance (harper-pro#403/#405), which handles the durability-watermark side of the same missing blob.

## Over-time transactions are aborted, not force-committed (`DatabaseTransaction`/`LMDBTransaction`)

`startMonitoringTxns()` (a `setInterval` per engine) watches `trackedTxns` and acts when a transaction's `timeout` reaches 0 (after ~2 ticks of `STORAGE_MAXTRANSACTIONOPENTIME`, default 30s). A transaction is tracked once it acquires a read snapshot (`getReadTxn`).

- **Write-bearing request transactions are aborted and poisoned** (issue #1407). The monitor calls `abortDueToTimeout()`, which sets `timedOut`, forces `open = CLOSED` (so `doneReadTxn` takes the discard path instead of re-entering `commit()` via the `LINGERING` branch — which would now throw), then `abort()`s. `addWrite`/`commit` both guard on `timedOut` and throw `transactionOpenTooLongError` (503), so the in-flight request rolls back cleanly rather than the monitor silently force-committing a partial write set (atomicity violation + orphaned secondary-index entries that only a full rebuild repairs). The old behavior `commit()`d and reused the still-open transaction.
- **`hasPendingWrites()` walks the `next` chain.** Writes to a second database live on `transaction.next` (see `txnForContext`), so a transaction that reads database A (head, tracked via its read snapshot, empty `writes`) and writes database B (`next`) is still write-bearing. Without the walk the head looks read-only and the monitor's force-commit path would cascade-commit B. `abortDueToTimeout()` poisons + aborts the whole chain.
- **Read-only, `sourceApply`, and `isReplay` transactions keep the prior force-commit behavior.** Read-only long transactions (large scans/exports) have no atomicity/index risk and must not have their ongoing reads poisoned. Canonical-source applies (replication peer / external caching source) and crash-recovery replay have no resubscribe/resume path: aborting a write would drop it while the resume cursor advances past it — a permanent divergence (harper-pro#348). `sourceApply` is propagated down the `next` chain in `txnForContext`, so gating on the head suffices. (Replay is additionally synchronous, so the async monitor can't fire mid-replay anyway.)

Known minor: if the monitor aborts a write transaction whose async `commit()` is already in flight (awaiting `before` hooks), the resumed continuation double-decrements `readTxnsUsed` and double-`abort()`s the underlying transaction (swallowed by the existing try/catch). Data is still correctly rolled back and the request errors; the only artifact is an inert negative counter on a dead transaction object.

## Repeat writes to the same key in one transaction carry their state forward (`DatabaseTransaction`/`Table`)

A transaction can hold more than one write to the same record key — two `patch()` calls inside one `transaction()`, or a replicated transaction carrying two updates to a record. Each write captures `operation.entry` (its idea of the current record) when it is staged, and **neither engine can refresh that from a read**: LMDB queues staged puts and applies them only in the commit batch, so a `getEntry` inside that loop still returns the pre-transaction record (the exclusive `store.transaction()` fallback is no better), and RocksDB read-your-writes only sees writes already staged into the native transaction — which the source-apply path, staging its whole batch before `commit()`, hasn't done yet.

So the writes carry the state forward themselves: `addWrite` chains each write to the preceding write to the same store and key (`linkWrite` → `operation.priorWrite`), a commit handler publishes what it stored on `operation.stagedEntry`, and the next write reads it back through `priorStagedEntry()` and uses it as `existingRecord`. Consequences worth knowing:

- Only the **record** comes from the earlier write. The rest of the entry (version, `localTime`/audit chain, blob metadata) stays the pre-transaction one — that is what this write's audit entry and optimistic version check are relative to.
- Program order breaks **ties only** (`if (priorStaged && precedesExisting >= 0) precedesExisting = 1`). Every write in a transaction carries the transaction's single timestamp, so a version comparison against what the earlier write landed (e.g. on a retry round after a partial apply) is a tie that the out-of-order machinery would otherwise drop as a re-delivered duplicate. A _strictly newer_ existing version can only be a concurrent transaction's write observed on a retry round; a chained write still goes through the out-of-order merge for it (and a chained delete still yields to it) rather than silently overwriting it.
- A superseded write's **blobs are cleaned up post-commit**: when a later write to the key replaces (or deletes) the record an earlier write stored, the earlier write's `savedBlobs` are reachable only through its audit entry — so unless it wrote one (`blobsAuditReferenced`, in which case audit pruning owns them), the commit-cleanup pass deletes them, checked against the final committed record so a blob the later write retained survives. Without this, LMDB (whose replacement path never sees the intermediate entry) leaked the intermediate blob's file permanently.
- The per-key chain map key (`writeKeyId`) is the **store's own canonical key encoding** (ordered-binary, as a latin1 string). JS value identity is wrong in both directions: `1n` and `1` are the same stored key and must chain, while `[0]` vs `[-0]` and `[null]` vs `[NaN]` are different stored keys that JSON/string coercion collapse. Symbol and null keys keep native identity (not key-encodable; never stage records).
- `clearWrites()` discards the chain along with the write set on commit/abort, so a reused transaction never bases a write on a previous batch's staged state.

Before this (harper#1968), every write diffed against the pre-transaction record: the secondary index kept the intermediate value permanently (nothing reconciles an index against the records, so only a rebuild repairs it), and on LMDB the earlier write's changes were dropped outright.

## Opening a source LMDB DBI for migration must thread through `compression`

When `migrateOnStart` opens a source LMDB primary store to read records out for the RocksDB copy, it constructs an `OpenDBIObject` and calls `sourceRootStore.openDB(key, dbiInit)`. Critically, the per-attribute `compression` setting from the corresponding `__dbis__` entry must be assigned onto `dbiInit` before that call — `dbiInit.compression = attribute.compression`. Without it, lmdb-js doesn't install its decompression layer; every read on the DBI returns raw compressed bytes. msgpackr then misreads bytes in the `0x40–0x7F` range as shared-structure refs, calls `loadStructures` → decodes the (also compressed) structures buffer → finds more bytes in that range → recurses → stack overflow.

Harper's normal `databases.ts` path already does this (search for `dbiInit.compression = primaryKeyAttribute.compression`); the migration path in `bin/copyDb.ts` has to match.

The same source-dbi open has a second non-obvious requirement: assign `sourceDbi.encoder.rootStore = sourceRootStore` for the primary store. The primary dbi decodes through a `RecordEncoder`, and decoding a record that holds a file-backed blob reference resolves that reference against `rootStore` (it locates the blob file). With `rootStore` unset, the `Blob` msgpackr extension throws `No store specified, cannot load blob from storage`; `RecordEncoder.decode` swallows the error and yields `null`, and `copyDbToRocks` then skips the `null` value — so every record with a file-backed blob is silently dropped from the migration. The runtime path gets `rootStore` from `handleLocalTimeForGets`; the migration path opens the source dbi raw and must set it explicitly (issue #857).

## Schema migration and `runIndexing` internals (`databases.ts`)

When `table()` is called with an attribute newly marked `indexed: true` (or with any change that requires re-building the secondary index), `runIndexing` is launched asynchronously and `Table.indexingOperation` is set to its promise. While running:

**In-flight state tracking (persisted to `attributesDbi`):**

- `attribute.indexingPID = process.pid` — set at migration start; cleared on clean completion. On restart with a different PID, `indexingPID !== process.pid` triggers a re-migration.
- `attribute.lastIndexedKey` — updated every 100 records as a resumable checkpoint. Cleared on clean completion; preserved on error so a retry starts from this key.
- `attribute.indexingFailed = true` — set if any record's `index.put` errors during the backfill. `table()` checks this flag: a fresh call in the same or a new process re-triggers the backfill from `lastIndexedKey`.
- `dbi.isIndexing = true` — in-memory flag on the index dbi. Prevents `searchByIndex` from serving partial results (returns 503 "not indexed yet" instead). Cleared only when backfill completes cleanly.

**`isIndexing` propagation across `resetDatabases()` calls:**
When `signalSchemaChange('schema-change')` fires at the start of `runIndexing`, `syncSchemaMetadata` calls `resetDatabases()` which re-opens all tables via `table()`. This creates a _new_ dbi object and assigns it to `Table.indices[attribute.name]`. The condition `if (attributeDescriptor?.indexingPID) dbi.isIndexing = true` (just before `indices[name] = dbi` in the migration-detection block) ensures any dbi created while a migration is in progress also has `isIndexing = true`. Without this, a concurrent `resetDatabases()` would replace the in-progress dbi with a fresh one where `isIndexing` is false, allowing queries to read partial index results.

**Error handling:**

- Per-record sync errors: caught by the inner try-catch. Set `hadIndexingErrors = true`.
- Per-record async rejections (`index.put` returning a rejected Promise): caught by the `when()` error handler. Set `hadIndexingErrors = true`.
- The final `await lastResolution` is wrapped in its own try-catch because if the very last put in the loop was rejected, an unguarded `await lastResolution` would throw past the `hadIndexingErrors` check to the outer catch, silently bypassing the error path.
- On any error: `indexingFailed = true` is persisted; `indexingPID`, `isIndexing`, and `lastIndexedKey` are kept. This leaves the index in 503 "incomplete" state rather than silently serving partial results.

**`Object.defineProperty(attribute, 'dbi', ...)` must use `configurable: true`:**
`attribute.dbi` is defined as a non-enumerable property (to prevent serialization to `attributesDbi`). It is defined with `configurable: true` so it can be re-assigned if the attribute participates in a retry cycle in the same process.

## Audit-store `'committed'` notification batching (`transactionBroadcast.ts`)

The cross-thread subscription path (default `crossThreads`) drives every `Table.subscribe()` consumer. When the database's audit store emits `'committed'`, we walk the audit log via a reusable iterator and dispatch matching records to subscribers. Three properties of this path are easy to break and worth knowing about before changing it:

- **`databaseSubscriptions.activeCount`** is the count of live `Subscription` instances on a database. It is incremented at the end of `addSubscription` (after the Subscription is created, so the `scope: 'full-database'` early-return path correctly skips counting) and decremented in `Subscription.end()`. `notifyFromTransactionData` short-circuits when this is zero — the reusable rocksdb iterator stays put and resumes from its position the next time a subscriber arrives. Without this short-circuit, an idle database with no subscribers still pays the audit-log iteration cost on every commit during replication backlog catch-up.
- **`notifyScheduled` + `setImmediate`** in the `'committed'` listener defers the iteration off the commit microtask. Multiple `'committed'` events that land in the same event-loop turn collapse into one notify pass. `notifyScheduled` stays set for the entire drain — including across yield-and-resume turns — so a re-entry from a new `'committed'` event cannot spawn a second concurrent notify on the same iterator.
- **Batched yielding** in `notifyFromTransactionData` (`NOTIFY_BATCH_SIZE`) is gated by `allowYield`. The `'committed'` path passes `allowYield = true`; the `listenToCommits` (same-thread `aftercommit`) path does not, because that path holds an inter-thread `'thread-local-writes'` lock that must not span event-loop turns. `subscribersWithTxns` is carried across yields via `subscriptions.pendingTxnSubscribers` so the `end_txn` signal fires exactly once when the iterator truly drains. When `activeCount` drops to zero mid-yield, the next continuation drops the carry-over to avoid invoking ended subscribers' listeners.

## `createBlob(readable)` and `table.put()` don't synchronously drain the source

When a blob attribute is created from a Node `Readable` (e.g. `createBlob(stream)` then `row.payload_blob = blob; await table.put(row)`), the put does **not** wait for the underlying stream to fully drain into the file before resolving. Internally `saveBlob` kicks off a `writeBlobWithStream` pipeline whose `storageInfo.saving` promise is tracked separately. The put resolves once encoding has captured the blob reference; the bytes finish writing concurrently.

Consequence for callers that wrap the source in a hashing `Transform`: calling `hash.digest('hex')` after `await table.put()` is unsafe — more `chunk.update()` calls can still fire as the stream drains, producing `Error [ERR_CRYPTO_HASH_FINALIZED]: Digest already called`. Options:

- Buffer first, then hash + put (what `components/deploymentRecorder.ts` does for Slice A — small payloads only).
- Hash via Transform while extraction reads the stream, and only finalize the hash on the Transform's `'end'` event before any second put with the final hash.
- Await `storageInfo.saving` directly if you have a handle to the FileBackedBlob (the cleanest path for streaming).

Future agents touching `components/deploymentRecorder.ts` for Slice B's streaming variant should pick one of the latter two patterns.

## Peer-side deploy_component payload read: retryable blob stalls and `Readable.from()` cancellation

`readPayloadBlobWithRetry` (`components/deploymentRecorder.ts`) wraps the peer's read of a replicated `hdb_deployment` row's `payload_blob` so a transient 503 `BlobReadError` (`BLOB_UNAVAILABLE_STATUS`, `resources/blob.ts`) — content bytes not arriving within `blobReadTimeout`, e.g. a parked blob send on the origin — retries instead of failing the whole deploy. Two non-obvious constraints shaped the design:

- **Retry is only safe before any byte has reached the consumer.** Once a chunk is handed downstream, re-opening `Blob.stream()` from byte 0 would duplicate it (there's no cheap way to resume from an arbitrary offset across a fresh stream without also plumbing `Blob.slice()`, which was out of scope for this fix). So the helper retries only while the current attempt has yielded nothing yet; a stall after partial content fails immediately, same as before this existed.
- **Backpressure and cancellation are two different problems, and both are easy to get wrong with a hand-rolled `ReadableStream`.** An early version wrapped the retry loop in `new ReadableStream({ async start(controller) { for await (...) controller.enqueue(chunk) } })` — this eagerly drains `streamFactory()` regardless of `controller.desiredSize`, defeating the whole point of not buffering a multi-GB payload in memory. Switching to an `async function*` consumed via `Readable.from()` restores real backpressure (the generator only resumes when the consumer wants more, matching how the un-wrapped `Blob.stream()` behaved pre-fix). But `Readable.from()`'s `return()`-on-destroy cancellation only takes effect at the generator's _next_ `yield` — while the loop is stuck retrying (no `yield` reached yet), destroying the `Readable` does nothing until the loop naturally exits, verified empirically (a generator that never yields kept retrying long after `.destroy()`). The fix: thread the constructed `Readable` back into the generator via a mutable cell (`readable` doesn't exist until after `Readable.from()` returns, so it can't be closed over directly) and check `.destroyed` explicitly at each loop iteration and after each backoff sleep.

## System table bootstrap: `systemSchema.json` + upgrade directive

Adding a new system table (e.g. `hdb_deployment` in #641 Slice A) requires three changes:

1. **`json/systemSchema.json`** — the table entry. Fresh installs auto-create it via `utility/mount_hdb.ts:createTables()`, which iterates `Object.keys(systemSchema)` on first boot.
2. **`utility/hdbTerms.ts`** — add the table name to `SYSTEM_TABLE_NAMES`.
3. **`upgrade/directives/<version>.ts`** — provisions the table on existing installs that already have a system schema. Registered in `upgrade/directives/directivesController.ts` (which is otherwise empty — its `versions` Map gets populated by these imports). The directive shape is `{ version, sync_functions, async_functions }`; copy `5-1-0.ts` for the canonical pattern (uses `bridge.createTable` to match what `mount_hdb` does on a fresh install).

   **Version the directive to the first release that ships the dependent code, not a later one.** Directives only run when `current_version < directive_version <= upgrade_version` (`directivesController.getVersionsForUpgrade`). The `hdb_deployment` directive was originally mis-tagged `5.2.0` while the deployment-recorder code shipped in `5.1.0`, so on every `5.0.x -> 5.1.x` upgrade the directive was filtered out (`5.2.0 > 5.1.x`) and the table never got created — breaking replicated `deploy_component` on peer nodes for the entire existing customer base. Caveat: `utility/common_utils.ts:compareVersions` strips trailing `.0` and therefore sorts a pre-release (`5.1.0-beta.1`) _above_ its GA (`5.1.0`), so an install already on a `5.1.0-beta.x` data version will not pick up a `5.1.0` directive when upgrading to GA; those pre-release installs need the table created by other means.

System tables replicate by default. To opt out, add the name to `NON_REPLICATING_SYSTEM_TABLES` in `resources/databases.ts`. The check happens after table init and sets `table.replicate = false` per-node.

If the table needs `audit: true`, set it both in the schema (for fresh installs) **and** on the `CreateTableObject` instance in the directive (for upgrades) — otherwise the two paths diverge.

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

## MCP protocol surface (`components/mcp/`)

The MCP Streamable-HTTP transport (spec `2025-06-18`) is served at `/mcp` under **two profiles**: an
_operations_ profile (mounted on the Fastify operations server) and an _application_ profile (mounted on
the Harper application HTTP server). Both share `transport.ts` (the JSON-RPC dispatcher) but differ in what
they expose — operations surfaces management operations as tools; application surfaces exported
Resources/tables. Profile gating runs throughout (`completeResourceArgument`, prompt visibility, tool
`visibleTo`), so when adding a method, decide which profile(s) it belongs to rather than assuming both.

A handful of design points are non-obvious and easy to break:

- **Per-call POST SSE streaming has a close-before-subscribe race.** A `tools/call` that opts into streaming
  (`Accept: text/event-stream`) gets an `IterableEventQueue` whose frames the adapter consumes via the event
  API (`on('data')` / `once('close')`), **not** `for await` — the async iterator does not terminate on
  `'close'`. The streaming tool handler is therefore dispatched inside a `setImmediate` (a _detached_,
  deferred task) so the adapter's consumer attaches **before** any frame is produced. Without the defer, a
  fast handler emits its final frame + `close` synchronously; the queue buffers `'data'` but not `'close'`,
  and the stream hangs. Any handler on this path must check `signal.aborted` first (cancellation can land
  before the deferred task runs).

- **Server→client requests are correlated across workers.** `serverRequests.ts` lets a streaming `tools/call`
  call _back_ into the client (`sampling/createMessage`, `elicitation/create`, `roots/list`) and await the
  reply. The request frame rides **the call's POST SSE stream**; the client's response is a _fresh POST_ that
  can land on **any worker**. The pending-promise registry is per-worker, so a response with no local match
  is fanned out over ITC (`MCP_CLIENT_RESPONSE`) and the worker holding the promise resolves it (mirrors
  `components/status/crossThread.ts`). Request ids are `srv-${randomUUID()}` — **not** a per-worker counter,
  which would collide on `(sessionId, id)` across workers and misroute responses. Methods are capability-gated
  (`METHOD_CAPABILITY`) against the client capabilities captured at `initialize`; the registry is bounded
  (timeout + high-water-mark) so a non-responding client can't leak promises.

- **Application tools must be rebuilt after JS resources register, not just on schema changes.** The
  application-profile tool scan (`registerApplicationTools`) runs at MCP component boot and on schema-change
  ITC events — both of which fire while the `@table` classes register, **before** the `jsResource` plugin
  registers the component's exported `class X extends tables.X` subclass. That subclass is the object the
  registry ends up holding (REST routes to it) and the only place author opt-ins (`static mcpTools`/
  `mcpPrompts`) live, so a scan that ran earlier sees only the base table class and misses them (#1448). The
  fix: `jsResource` fires `signalResourcesRegistered()` (a deliberately **local-only**, non-ITC signal in
  `utility/signalling.ts`, backed by `resourceHandler` in `server/itc/serverHandlers.js` — each worker
  registers its own JS resources, so the rebuild belongs in that worker) after registration; `listChanged`
  subscribes and re-runs the scan. Consequence: the verb tools (`create_*` etc.) now bind to the subclass and
  honor its `post`/`patch` overrides, matching REST — previously they bound to the base table class and
  silently bypassed those overrides. Advertised CRUD output schemas are still table-derived, so an overridden
  write verb whose return diverges from `{ id }`/`{ ok }`/`{ deleted }` advertises a subset shape (the in-use
  SDK tolerates supersets; tightening per-override envelopes is sibling-issue work — see the `derive.ts`
  envelope note).

- **Resource subscriptions are row-backed via the audit log.** `resources/subscribe` resolves the URI to a
  Resource and drives `Table.subscribe` off the audit-store `'committed'` path (same machinery as the
  "Audit-store `'committed'` notification batching" section above). The targeting is the subtle part:
  `getMatch` returns the matched Resource plus the remaining path on `relativeURL`, and `subscribeToResource`
  sets **both** `request.id` (the record key, or `undefined`) **and** `request.isCollection` from it. A record
  URI (`…/WorkItem/42`) watches that record; a collection URI (`…/WorkItem`, what `resources/list` advertises)
  watches the whole table. `new RequestTarget(path)` parses an id out of the path on its own, so _both_ fields
  must be overridden — otherwise a collection URI silently watches a phantom record named after the resource
  and receives nothing. `harper://*` pseudo-resources are **list-changed-only** (not row-backed). Subscriptions
  use `omitCurrent` (notify on change, not a retained snapshot — the notification just says "re-read this").

- **Subscribe requires a live GET stream; teardown is asymmetric.** `resources/subscribe` rejects (`-32602`)
  if no GET SSE stream has registered the session — the audit-log iterator has nowhere to deliver, and there'd
  be no `RegisteredSession` close hook to stop it. The GET `'close'` handler drops **subscriptions only**
  (`dropSessionSubscriptions`), _not_ pending server requests: those ride the per-call POST stream, so a normal
  GET reconnect must not reject an in-flight `ctx.serverRequest`. A `DELETE` (explicit session teardown) drops
  **both**, because it may arrive with no open GET stream.

- **SSE resumability (`Last-Event-ID`).** Every GET-channel frame goes through `pushSessionFrame`, which
  assigns a monotonic event id and appends to a bounded per-session `replayBuffer`. On reconnect with a
  `Last-Event-ID` header, `replaySince` re-sends only the frames after that id. The event-id sequence **and**
  the buffer carry across a supersede (a fresh GET replacing the old one for the same session id), so ids stay
  monotonic and no frame is lost across a reconnect.

- **Test seams avoid loading thread/audit machinery in unit tests.** `_setSubscribeImplForTest`
  (`resources.ts`) and `_setItcForTest` (`serverRequests.ts`) inject fakes so the unit suite needn't spin up
  the audit log or ITC. Consequence: the subscribe **targeting** logic (`id`/`isCollection` derivation) is
  _bypassed_ by the seam and is therefore covered at the **integration** level (`sse-listchanged.test.ts` N3
  record / N4 collection), not in unit tests.

Two related traps: the create path's exclusive `update-attributes` lock is a synchronous spin
lock (`while (!tryLock()) {}`), so any throw inside the create window must release it or every
subsequent create on that database pins a worker at 100% CPU. And dropping then recreating a
same-named table within one process requires @harperfast/rocksdb-js >= the column-family
eviction fix (1.4.3 / rocksdb-js#<main PR>): older bindings keep the dropped column family's
by-name registry entry alive whenever other worker threads hold handles, so the recreate
silently reuses a dangling handle and every write fails with "Invalid column family specified
in write batch", poisoning the whole database env until restart. The regression suite for all
of this is `unitTests/resources/dropTableGhost.test.js` (it fails by design on pre-fix
bindings).

## TLS hot-reload: cert vs. private key follow two different propagation paths (`security/keys.ts`)

A renewed **certificate** and a renewed **private key** reach a worker's live TLS secure context
by completely separate routes, and the two must reconverge or HTTPS breaks on that worker.
Certificates propagate through data: only the main thread watches the cert file (`isMainThread`
guard in `loadCertificates`) and writes the new PEM into the `system.hdb_certificate` table; every
worker is subscribed to that table and rebuilds its secure contexts (`updateTLS` inside
`createTLSSelector`) on the notification. Private keys never touch the table — each worker watches
its own key file (the private-key `loadAndWatch` has no `isMainThread` guard) and loads the PEM
straight into its in-thread `privateKeys` map. `getPrivateKeyByName` reads that map first, so an
already-built secure context has the key bytes baked in (`setCert`/`setKey` at build time); a later
map update does not touch contexts already built.

The hazard when a rotation changes **both**: the cert can win the race to a worker (table write +
subscription) and trigger `updateTLS` before that worker has reloaded the matching key, producing a
context that pairs the new cert with the old key — every handshake on it then fails, and nothing
rebuilds it until the _next_ cert-table change. The fix: a private-key reload (`handlePrivateKeyReload`,
the single sink for both the chokidar watcher and PR #1394's periodic poll) triggers a debounced
rebuild of every live selector via the module-level `liveTLSRebuilders` set, so the worker reconverges
on its own. Subtleties to preserve: the rotation guard (`previous !== undefined && previous !== key`)
must skip both the initial load and identical-content reloads or watchers thrash; transient one-shot
selectors (`getReplicationCert`) pass `liveReload=false` so they don't accumulate in the never-pruned
set; and the cert subscription shares the same debounced `scheduleRebuild` (same 1500ms cadence), so
its coalescing must stay a superset-safe no-op for the single-swap #586 case. Regression coverage:
`integrationTests/security/cert-key-reload.test.ts` deterministically pins the cert-before-key ordering
(it fails by design without the rebuild trigger); `cert-reload.test.ts` guards the cert-only #586 path.

## `set_configuration` replication is opt-in; `replicateOperation` is default-on (`config/configUtils.ts`)

`server.replication.replicateOperation` (installed by harper-pro's replicator) fans out whenever
`req.replicated \!== false` — absence of the flag means "replicate". That default-on contract is what
DDL ops rely on (`dropSchema`/`dropTable` call it unconditionally), so a handler that mirrors the
drop_schema pattern without a guard silently becomes replicate-by-default. `setConfiguration` must
stay **opt-in** (`if (replicated)` truthy guard) because config bodies routinely carry node-local
params (ports, paths, node identity) that would clobber peers. Two invariants to preserve:
`replicated` must remain in the handler's destructure strip-list on both origin and peers (peers
receive `replicated: false` in the forwarded body; anything not stripped is treated as a config
param), and there is deliberately **no** per-param node-local/cluster-wide guard here — per-field
replicability metadata is deferred to the cluster-level-config work (CORE-3018), which will own that
schema. Per-peer failures never reject: they come back as `{status: 'failed', reason, node}` entries
in `response.replicated[]`, and `message` still reads as success (same contract as drop_schema), so
operators must inspect the array for per-node outcomes.

## Config is composed and memoized before any component runs (`config/configUtils.ts`)

`getConfigObj()` composes the config once per thread (module-level memo) at its first call, which
happens before the root component loads and long before any user component's plugins run. Anything a
component does at load time — like `loadEnv` writing `process.env` — therefore cannot affect the
composed config (#1513). By design this stays true: configuration is strictly top-down, so the three
config-shaping env vars (`HARPER_DEFAULT_CONFIG`/`HARPER_CONFIG`/`HARPER_SET_CONFIG`) are **never
honored** from a component `.env`. What #1513 fixed is the silence: `config/componentEnvPrepass.ts`
scans `componentsRoot` + `RUN_HDB_APP` for `loadEnv` declarations during `initConfig` and emits an
actionable warning per config-shaping var found, and `resources/loadEnv.ts` warns again at
component-load time (covering post-boot deploys) and **skips the `process.env` assignment** for the
trio — enforce-at-injection, so anything downstream that (re)composes from `process.env`
(#1618/#1726) can rely on the trio arriving only via sanctioned channels. The pre-pass deliberately
mirrors loader behaviors that must stay in sync if the loader changes: config filename precedence
(`harper-config.yaml` → `harperdb-config.yaml` → `config.yaml`) and `files` pattern validation
(`..` and absolute patterns rejected). Known limitation: a `componentsRoot` override that itself
arrives via env var cannot redirect the scan.

## A dangling symlink silently truncates the deploy tarball (`components/packageComponent.ts`)

Packaging uses `tar-fs.pack(dir, { dereference: true })` by default (`skip_symlinks` off).
tar-fs's own walker calls `fs.stat` (not `lstat`) on every discovered entry when dereferencing; a
dangling symlink's target throws `ENOENT`, and tar-fs's `statAll` loop treats _any_ `ENOENT` from
a walk-discovered (not explicitly-requested) entry as end-of-stream — it calls `pack.finalize()`
immediately, silently dropping every entry still queued (BFS order) after the link. No error is
ever emitted, so `packStream.on('error', ...)` never fires and `deploy_component` reports success
on a truncated archive. `scanPackageDirectory()` now pre-walks the tree once (async) to build a
skip-set of dangling symlinks, which `streamPackagedDirectory`'s `tar.pack({ ignore })` consults via
a synchronous `Set.has()` — **`ignore` is called synchronously by tar-fs with no Promise support**,
so any fix here has to resolve the dangling set _before_ constructing `tar.pack`, not from inside
the callback (an earlier draft used `lstatSync`/`statSync` per entry there, which would have added
blocking I/O to a path that also runs inline on the Harper server's event loop via the
`package_component` operation). The scan recurses into _valid_ symlinked directories the same way
tar-fs's dereferenced walk does (readdir through the link), since a dangling symlink nested inside
one is just as capable of tripping the same early-finalize — skipping recursion into symlinked
dirs there would silently reintroduce the bug for that case. Circular directory symlinks are not
guarded against (in the scan or in tar-fs's own pack walk); that's a pre-existing tar-fs limitation
this fix doesn't attempt to solve. `deploy_component`/`package_component` still never validate that
declared entry points (`jsResource`/`graphqlSchema`) survived extraction — a truncation from some
other future cause would still report success silently; that's a deferred, separate fix.

## Two-phase deploy: stage then activate (`components/Application.ts`, `components/operations.js`)

`deploy_component` runs internally as two replicated phases so a cluster deploy is all-or-nothing at
the point of go-live. **Phase 1 (stage)** builds the incoming version — download/`npm pack` (incl. a
git clone), extract, `npm install` — into a hidden staging directory on every node. **Phase 2
(activate)** atomically renames the staged copy into the live component path and restarts. The origin
stages locally, **waits for every node to report a successful stage before any node activates**
(`ignore_replication_errors` opts out of the barrier), then activates. If a node can't fetch the
package or fails `npm install`, it fails during staging while the live component is still untouched _on
every node_ — where the old one-shot path could leave a peer half-installed after other peers had
already restarted onto the new code. The request/response contract is unchanged; only the SSE phase
names differ (`stage`/`activate` vs the old `prepare`/`replicate`). `two_phase: false` forces the
legacy one-shot path.

**There is only one public operation — `deploy_component`.** The two phases are NOT separate public
operations; the peer fan-out is `deploy_component` itself tagged with an internal `_phase: 'stage' |
'activate'` marker (the same `_`-prefixed internal-field convention peers already branch on, alongside
`_deploymentId`). `deployComponent` dispatches: a replicated execution with `_phase` runs the peer
stage/activate work (`deployPhaseStage` / `deployPhaseActivate`) and never re-fans; a public call runs
the origin orchestrator. Two public properties expose the phases when an operator wants them separated
(e.g. pre-stage the cluster now, flip later — or a CI-stages / approver-activates split): `activate:
false` stages cluster-wide and stops, returning the `deployment_id` in a `staged` state; passing that
`deployment_id` back to `deploy_component` (with no new payload) activates the already-staged build.
This was a deliberate API-surface choice (harper#1849 review): peer fan-out needs a wire format, not
two extra public ops, and folding the phases into `deploy_component` keeps the surface at one op while
the convergence properties cover the stage-now/activate-later use case. (`revert_component` stays a
distinct public op — it is a rollback, not a deploy phase.)

**Scope of the barrier's guarantee: fetch + install, not load.** The cluster-wide "nobody activates
until everybody staged" guarantee covers the download/`npm pack` and `npm install` steps — the slow,
failure-prone work. The pre-go-live component _load_ check (`loadValidateComponent`, which surfaces a
component that installs cleanly but throws at load) runs during stage on the origin and on any node
whose stage executes on a worker (e.g. the op-API worker for an `activate: false` stage), but it is a
no-op on the main thread — and replicated peer stage executions run on the main thread
(`replicateOperation` → `sendOperationToNode` execute there), where app code deliberately isn't
loaded. So a load-time-only fault on a peer is not caught by the barrier; it surfaces at
activate/restart like any other. Gating load-time faults cluster-wide would require dispatching the
throwaway load to a worker on each peer during stage — a possible follow-up, not done here.

The staging directory (`.deploy-staging/<deploymentId>/<name>`) lives **under the components root**,
not in `os.tmpdir()`, even though its contents are transient. This is deliberate and load-bearing:
the go-live step is `rename(stagingDir, liveDir)`, which is only atomic when both paths share a
filesystem. `os.tmpdir()` is frequently a different mount (tmpfs, a separate volume); a cross-device
rename throws `EXDEV` and Node has no atomic fallback — you'd be back to a slow recursive copy at the
exact moment you want the swap to be instantaneous, reintroducing the downtime window the split
exists to remove. The leading dot keeps `loadComponentDirectories` from loading it as a phantom
component, and it is **not** the watched base of any component's file watcher (those are rooted at
each live component dir, `EntryHandler`/`deriveCommonPatternBase`) — so building here fires no
restart-on-change events and needs no `deploy:start` watcher suppression. That suppression is now
scoped to `activateApplication`, the only phase that writes the live path. Staging is deterministic
from the deployment id precisely so the activate phase (a separate replicated `deploy_component`
invocation on peers, tagged `_phase: 'activate'`) can reconstruct the same path the stage built —
peers build a fresh `Application` per phase invocation, so there is no shared in-memory handle to rely
on. The deployment id sits ABOVE the component name (`…/<deploymentId>/<name>`, not
`…/<name>/<deploymentId>`) for two reasons: the leaf directory's basename is then the real component
name, which the pre-go-live validation load needs (`componentLoader` keys the `ApplicationScope` and
status registry off `basename(componentDirectory)`, so a UUID leaf would register the throwaway load
under a bogus name); and each deploy gets its own parent directory, so a parallel or queued deploy of
the same component can never share a directory or have its staged build swept by another's cleanup.
`extractApplication`/`installApplication` build into `application.buildDirPath`, which defaults
to the live dir (`dirPath`) — this is what keeps the legacy one-shot path, boot-time
`installApplications`, and the direct `extractApplication` callers unchanged — and is repointed at
the staging dir only for the duration of a stage.

Two-phase requires the `system` database to be replicated on the origin (`isSystemDatabaseReplicated`),
since the `hdb_deployment` row's `payload_blob` is how peers fetch the tarball and correlate the two
phases by deployment id. When `system` is excluded from a narrow `REPLICATION_DATABASES`, or the
caller passes `two_phase: false`, or the invocation is a peer replaying a one-shot deploy,
`deploy_component` falls back to `deployComponentOneShot` (the previous behavior, preserved verbatim).
Cross-version skew is a non-issue by policy — a cluster stays in lockstep on its Harper version, so
every node understands the `_phase`-tagged `deploy_component` fan-out — which is why there is no
capability negotiation on it.

**Replicator contract this rides on (`harper-pro/replication/replicator.ts`).**
`server.replication.replicateOperation(op, {onPeerResult})` fans `op` to every node in `server.nodes`
in parallel, setting `op.replicated = false` on the copy it sends so a peer never re-fans (the deploy
handlers additionally detect a replicated execution by the presence of `_deploymentId` — always set on
the sub-operations — and run the peer stage/activate work off the `_phase` marker without re-fanning). Per-peer failures never throw — `sendOperationToNode` rejections are caught and
surface as `{status:'failed', reason, node}` entries in the returned `replicated[]` array and via
`onPeerResult`, which is exactly the shape `DeploymentRecorder.normalizePeerResult` consumes. Peers
authenticate node-to-node by TLS certificate, and the receive side runs the op via
`server.operation(data, {user}, !isAuthorizedNode)` — for a trusted cluster node the authorize flag is
`false`, so a replicated super-user op skips the permission gate. That is why the `_phase`-tagged
`deploy_component` fan-out and `revert_component` (registered with the same `permission(true, [])`,
dispatched by `operation` name) replicate without an `hdb_user`, identically to the long-proven
one-shot `deploy_component` fan-out.

**Reversibility: retained previous + `revert_component`.** `activateApplication` no longer discards the
outgoing live version — it retains it as `.deploy-previous/<name>` (`retainAsPrevious`, evicting the
older one so exactly one previous is kept per component). `revert_component` swaps the live directory
with that retained previous via three same-filesystem renames through a hidden holding path, cluster-
wide and replicated like activate. The swap is bidirectional, so reverting a revert rolls forward
again. This backs two things: a customer can deploy, run their own health checks against the live
version, and `revert` if unhappy even when the cluster looks healthy; and `deploy_component`'s opt-in
`revert_on_failure` rolls the whole cluster back to the previous version when the activate phase leaves
some nodes live and some not, so the cluster reconverges on one version. The previous copy is retained
per-node (each node retains its own outgoing version during its own activate), so a replicated revert
has a local rollback source on every node.

**Staged-build retention.** A full deploy consumes its staged build immediately (activate renames it
live), so the only builds that accumulate are `activate: false` stage-and-stops that are never
activated — each leaves `.deploy-staging/<deploymentId>/<name>` in place so a later
`deploy_component({deployment_id})` can activate it. `stageApplication` bounds this: after a successful
stage it evicts the oldest not-yet-activated staged builds for that component beyond
`deployment_stagingRetention_maxCount` (default 5, `pruneStagedBuilds`), always keeping the just-staged
one and the newest N−1 by mtime. Eviction is best-effort (`allSettled`, trace-logged) but awaited so
the count is settled when the stage returns. Retention is deliberately count-only and automatic:
per the harper#1849 discussion, `hdb_deployment` rows stay as the audit trail (payload blobs already
self-reclaim by size, `deployment_payloadRetention_maxSize`), and no `delete_deployment` op was added —
eviction-on-stage keeps the surface at zero new operations. Consequence: activating a `deployment_id`
that has already aged out of the window fails with "no staged build found" — expected once more than
`maxCount` newer stages have landed for that component.

## Scheduler: cluster-once execution without a consensus primitive (`resources/scheduler/`)

The built-in `scheduler` plugin (#951) runs config-declared jobs "exactly once per cluster." The
non-obvious part is what Harper's substrate does and does not offer for that:

- **There is no election, consensus, or cross-node CAS anywhere in harper/harper-pro.** Replication
  converges concurrent writes by record version (LWW). A lease acquired with a plain `put` therefore
  cannot be race-free by construction — two nodes writing the lease both succeed locally and
  converge later. The engine's design accepts this: sticky leadership (a starter defers to a fresh
  heartbeat), a heartbeat takeover check (a leader seeing a fresher foreign heartbeat steps down),
  and documented handler idempotency are the mechanisms that ride out transient dual-leadership.
  Do not "fix" the race with a conditional write — the primitive does not exist.
- The lease + per-job run state live in the replicating system table `hdb_scheduler_state`
  (`audit: true` because system-table replication requires auditing; name chosen because `hdb_job`
  is taken by the legacy jobs subsystem). On constrained/directional replication topologies the
  lease may not reach every node; that limitation is inherent.
- The alphabetical node-name tie-break deliberately mirrors replication's deterministic failover
  convention (sorted node names in `subscriptionManager.ts`); the escalation ladder
  (`promotionWaitMs`) exists because a dead alphabetically-first node must not deadlock a
  leaderless cluster (each successive node waits one more `2 × watcher interval` rung).
- Thread-once vs cluster-once are separate layers: `getWorkerIndex() === 0` gates to one worker per
  node (correct in every threading mode incl. `threads: 0`); the lease gates across nodes.
  `handleApplication` holds a cross-thread load lock with a 30s timeout, so the plugin only
  registers there — election, scheduling, and catch-up run async after.
- Catch-up fires at most ONE missed occurrence per cron job, and a new job's `firstSeenAt` baseline
  prevents firing immediately on first deploy. Interval jobs are excluded from the sweep — they
  self-correct by anchoring to their persisted last run in `scheduleNextRun`.
- Timer firing is a deliberately thin `setTimeout` layer so the durable timer service (#754) can
  replace it without touching the config surface, election, or catch-up. Timing thresholds are
  env-overridable (`HARPER_SCHEDULER_*`) so multi-node tests can exercise failover in seconds.

## `universalHeaders` (`http.securityHeaders`): ownership, precedence, and per-thread scope

`server/http.ts` exports `universalHeaders: [string, string][]`, applied to responses in the
Node, Bun, and uWS (`#914`, `HARPER_UWS_HTTP`) request handlers alike. `http.securityHeaders`
config populates it via `applySecurityHeaders()`, called from `handleApplication()` on load and
on `scope.options.on('change', ...)`. Three invariants to preserve:

- **Ownership tracking.** Other components may push entries onto the same shared array, so a
  hot-reload can't clear-and-rebuild it. `applySecurityHeaders` tracks the exact `[name, value]`
  tuples it previously pushed in a module-level `ownedSecurityHeaders` array and splices only
  those out (by reference, via `indexOf`) before re-adding the new set. Any future feature that
  pushes into `universalHeaders` from a hot-reloadable source should follow the same "track what
  I added, only remove what I added" pattern.
- **Root scope owns the config.** `'http'` is a `TRUSTED_RESOURCE_PLUGINS` key, so an application
  `config.yaml` with an `http:` block re-invokes `handleApplication`. A module-level guard makes
  only the _first_ invocation (the root config, which loads before applications) own
  `applySecurityHeaders` and its change listener; later invocations still refresh `httpOptions`
  but cannot wipe root-configured headers.
- **App wins on conflicts.** Universal headers are _defaults_: `applyUniversalHeaders()` (a shared
  helper used by all three transports) only sets a header when `has(name)` is false, and the
  direct-to-`nodeResponse` paths (handlesHeaders, error) check `hasHeader` first. A route that sets
  `X-Frame-Options: DENY` is never loosened by a configured `SAMEORIGIN`. Response paths covered:
  normal writeHead, `handlesHeaders` streams (e.g. the static component's `send()`, which writes
  its own headers directly — universal headers are pre-set on `nodeResponse` / the Bun
  `responseHeaders` shim so the stream can still override its own names), the thrown-error path,
  and the `status === -1` cascade — on Node via the Fastify `'unhandled'` event bridge, on Bun/uWS
  via `injectToFastify` (or the bare-404 fallback when no Fastify instance is registered for the
  port). Each `status === -1` branch builds a **fresh** `Headers` object from the fallback
  response rather than reusing the request's original `headers`, so `applyUniversalHeaders()` must
  be called again on whichever object actually gets returned — applying it only once, before the
  `status === -1` branch, is a trap that silently drops universal headers on every unhandled/404
  response. CI first caught this on the uWS shard (the integration suite's only unauthenticated
  404 case landed there); the same bug existed unnoticed on Bun's parallel `status === -1`
  branches (`getBunHTTPServer`'s bare-404 return and `bunDelegateToNodeServer`'s two `Response`s)
  and is fixed alongside it in `harper-1568-fix2`.

**Why the operations API doesn't get these headers in normal mode**: ops requests _do_ flow
through the Harper-native `requestHandler` (`httpServer()` calls `getServer()` for every
registration, including Fastify's non-function listener) and cascade to Fastify via the
`status === -1` branch, which copies `response.headers` onto `nodeResponse`. But the ops API runs
on the **main thread**, and the main thread loads components with `resources.isWorker = false`
(`server/loadRootComponents.js`), so the componentLoader's `resources.isWorker &&
extensionModule.handleApplication` gate (`components/componentLoader.ts`) means http's
`handleApplication` never runs there — the main thread's `universalHeaders` array stays empty.
`universalHeaders` is per-thread module state, populated only where the http component loads.
Corollary: with `threads: 0` the ops API shares the worker where `handleApplication` _did_ run,
so ops responses **will** carry the headers there (benign).

## The published shrinkwrap governs registry installs but not tarball installs (`build-tools/`)

npm decides whether to honor a dependency's bundled `npm-shrinkwrap.json` from the `_hasShrinkwrap`
flag in the **registry packument**, metadata the registry sets at publish time — not by looking
inside the tarball. So `npm install harper` from the registry installs exactly the tree the
shrinkwrap describes, including honoring _omissions_ (it will not re-resolve an optional dependency
that has been pruned out). But `npm install ./harper-*.tgz` has no packument, so npm never learns the
shrinkwrap exists and re-resolves the whole tree from `package.json`. Verified on one published
5.1.23 artifact: via the registry it honored the pin (fastify 5.8.5), from the tarball it resolved
fresh (fastify 5.10.0, then-latest).

Three consequences worth knowing before touching packaging:

- `overrides` in harper's `package.json` are **root-only** and do nothing for anyone installing
  harper. The shrinkwrap is the only lever that reaches consumers, which is why the react-native
  prune lives in `build-tools/prune-shrinkwrap-react-native.mjs` rather than in `overrides` (#1937).
- The published shrinkwrap is deliberately _not_ what `npm shrinkwrap` produced — `build.sh`
  post-processes it (dev prune #1783, react-native prune #1937) to enforce that it describes only the
  production tree a consumer installs. Anything added there must keep it internally consistent; a
  pruned entry that something still requires would ship a broken tree to every consumer.
- The Dockerfile installs the local tarball, so it gets **none** of this: its dependency tree is
  resolved fresh at image-build time against whatever is newest within our semver ranges, meaning the
  image is not reproducible and does not match what npm consumers receive (#1960).
