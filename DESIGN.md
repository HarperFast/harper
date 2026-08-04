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

The persisted `compression` value itself is LMDB-era and loosely shaped: `getDefaultCompression()` historically stored whatever falsy value the config resolved to (`''`, `false`, `null`) when `storage.compression` was disabled, and `{ startingOffset, threshold, dictionary? }` when enabled. lmdb-js interprets falsy as "no compression", but rocksdb-js >= 2.6 validates the option strictly (`''`/booleans throw `Unsupported compression algorithm`) and treats UNSET as "use the build default (lz4)" — the inverse default of lmdb. Every RocksDB open must therefore route through `toRocksCompression()` in `resources/databases.ts` (applied inside `openRocksDatabase`, the single chokepoint), which maps defined-falsy → `'none'` and `true` → unset. Don't pass persisted attribute compression to a RocksDB open directly.

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

## Audit-entry removal loops must track every `removeAuditEntry()`/`removeEntry()` promise

`scheduleAuditCleanup` (`auditStore.ts`) and `Table.deleteHistory` (`Table.ts`, the LMDB path behind
`delete_transaction_logs_before`) both iterate a range of audit records and remove each one. Both were
originally written as `completion = removeAuditEntry(auditStore, auditRecord)` inside the loop, awaiting
only the final iteration's promise afterward. Any rejection from a non-last iteration was silently
discarded — the promise reference was overwritten before it could be awaited or caught — and surfaced
later as an unhandled rejection instead, with no logging to explain it. Any loop that removes
audit/primary-store entries in a batch must attach a rejection handler to every removal immediately
and drain all tracked promises before returning — never stash a per-iteration promise in an outer
variable to await only the last one. `Table.deleteHistory` allows up to ten removals in flight so
storage writes overlap without growing an unbounded pending set; `scheduleAuditCleanup` remains
sequential because it is an automatic background loop.

`removeAuditEntry` has a second, nested version of the same hazard: for a `'delete'`-type audit record it
also invokes a per-table delete callback (`addDeleteRemovalCallback`) that removes the corresponding
primary-store tombstone. That callback's promise must be returned and joined with the audit-store
removal (currently via `Promise.all`, with the callback's own rejection caught and logged separately so
a failed tombstone cleanup doesn't get misreported as a failed audit-entry removal) — otherwise the
tombstone removal is fire-and-forget and the same detached-rejection hazard reappears one level down.
A tombstone whose cleanup fails this way is not swept automatically — `scheduleAuditCleanup`'s automatic
pass never retries it, since the audit entry that would have triggered a retry is already gone. It sits
in the primary store until an operator runs `delete_transaction_logs_before` with `cleanup_deleted_records: true`.

## `createBlob(readable)` and `table.put()` don't synchronously drain the source

When a blob attribute is created from a Node `Readable` (e.g. `createBlob(stream)` then `row.payload_blob = blob; await table.put(row)`), the put does **not** wait for the underlying stream to fully drain into the file before resolving. Internally `saveBlob` kicks off a `writeBlobWithStream` pipeline whose `storageInfo.saving` promise is tracked separately. The put resolves once encoding has captured the blob reference; the bytes finish writing concurrently.

Consequence for callers that wrap the source in a hashing `Transform`: calling `hash.digest('hex')` after `await table.put()` is unsafe — more `chunk.update()` calls can still fire as the stream drains, producing `Error [ERR_CRYPTO_HASH_FINALIZED]: Digest already called`. Options:

- Buffer first, then hash + put (what `components/deploymentRecorder.ts` does for Slice A — small payloads only).
- Hash via Transform while extraction reads the stream, and only finalize the hash on the Transform's `'end'` event before any second put with the final hash.
- Await `storageInfo.saving` directly if you have a handle to the FileBackedBlob (the cleanest path for streaming).

Future agents touching `components/deploymentRecorder.ts` for Slice B's streaming variant should pick one of the latter two patterns.

## Component preparation is serialized across worker threads

`prepareApplication()` performs one destructive transaction against a component directory: extract the incoming payload, then run its dependency installer. Deploy operations can execute on worker threads as well as main, so a module-local promise queue is insufficient—each worker has its own module registry. `withComponentPreparationLock()` (`components/componentPreparationLock.ts`) instead acquires an atomic filesystem lock keyed by the absolute component path. The deprecated `install_node_modules` operation uses the same lock, so it cannot run npm concurrently with a deploy.

The deploy lifecycle broadcast deliberately sits _outside_ the lock. Overlapping requests therefore increment the existing per-component lifecycle refcount before queueing; watchers remain suppressed continuously until the final queued preparation ends. The lock itself covers credential materialization, extraction, and installation. Its fully-written owner record is published with an atomic rename, so contenders never observe a partially initialized lock. A lock is never stolen from a known-live owner based on elapsed wall time: installs can be long-running and clocks can jump. Locks from a dead process are reclaimed, and a same-process contender asks the main thread whether the owning worker still exists so a worker crash does not wedge that component until Harper restarts. The bounded wait remains a backstop when owner liveness cannot be established.

A package-manager timeout must not release this lock while npm descendants are still mutating `node_modules`. POSIX spawns therefore run in a dedicated process group; timeout sends the group `SIGTERM`, escalates to `SIGKILL`, and waits for exit before rejecting. Windows uses `taskkill /T /F` for the equivalent process-tree termination. `manageThreads` tracks each spawned process tree by its owning Harper thread and force-terminates it if that worker exits, preventing detached installers from surviving a worker restart or Harper shutdown. `SIGKILL`/`taskkill` only queue termination, so a worker's dead-owner reclamation (above) waits for that thread's tracked process groups to be confirmed gone, not merely signaled—otherwise a replacement preparation could start while the old writer might still be alive. A process group a dead worker's own event loop spawned is never reaped from another thread, so it persists as a zombie rather than fully disappearing; since a zombie can no longer touch the filesystem, confirmation treats a zombie the same as a fully reaped exit.

Boot's `harper-application-lock.json` records an application configuration only after preparation fulfills. Recording at queue time would make a failed install look complete and suppress its retry on the next boot.

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

## RocksDB backup/restore: the restore lock + marker protocol (`dataLayer/restoreMarker.ts`, `dataLayer/rocksdbBackup.ts`)

The `restore_backup` operation restores a user database on a live server by closing it across all
worker threads, purging its directory (`backups.restore` with `purgeAllFiles`), and reloading it.
Three non-obvious mechanics keep that safe:

- **Two files in an isolated `` `restore` `` directory beside (never inside) the database directory**,
  each keyed by `sha256(basename(dbPath)).slice(0,32)`: `<key>.lock`, an OS-level exclusive flock
  (rocksdb-js `tryFileLock`, auto-released on process death), serializes restores; `<key>.restoring`,
  a marker written+fsynced (file _and_ the metadata directory) after the lock and before any
  destructive step, means "a restore started and has not finished" (its first line records the
  database directory name so the scan can map a marker back without decoding the key). The metadata
  is hashed into a sibling directory rather than suffixed onto the database name (`<db>.restoring`)
  for two reasons: a legal database literally named `orders.restoring` would otherwise be mistaken
  for the restore marker of `orders`, and a 250-character name (the legal max) plus a `.restore.lock`
  suffix exceeds `NAME_MAX` (255) on most filesystems. The directory name deliberately contains a
  backtick — `schemaRegex` (the database-name validator) forbids only `/` and a backtick among
  filesystem-legal characters — so it can never collide with a legal database name, including a
  database literally named `.restore` (which _is_ a legal name; a plain `.restore/` directory would
  be exactly that database's directory). Because the startup scan opens any `CURRENT`+`MANIFEST-`
  directory without re-applying `schemaRegex`, it also explicitly skips the reserved `` `restore` ``
  entry so an out-of-band directory at that name is never loaded as a database. Startup/rescan
  detection (`databasesBlockedByRestore` → `scanBlockedRestores` in `dataLayer/restoreMarker.ts`)
  reads the metadata directory and checks the **marker first**, only probing the lock when the marker exists —
  probes take the flock and are mutually exclusive across threads, so probing the (persistent) lock
  file of every long-ago-restored database on every rescan would make concurrent rescans misclassify
  healthy databases as in-progress. Marker-present + lock-held = restore in progress (don't load);
  marker-present + lock-free = crashed mid-restore (don't load; rerun the restore to recover).
- **A recovery restore must not clear a pre-existing marker on a pre-destruction failure.**
  `beginRestore` returns `preexisting: true` when a `.restoring` marker was already present (this run
  is a recovery over a possibly half-purged directory). If such a run fails _before_ any destruction
  (e.g. `verifyDatabaseClosed` finds a leaked handle), it must leave the marker in place — clearing
  it and broadcasting a reload would surface the earlier attempt's partial/corrupt directory as
  healthy. Only a _fresh_ marker on a _previously healthy_ database that failed before destruction is
  safe to clear.
- **The ITC close broadcast is best-effort, so closure is verified before the purge.** The SCHEMA
  broadcast (`signalSchemaChange`) resolves after remote handlers complete but times out at 30s
  "best-effort", swallows errors, and never reaches job-worker threads at all (their ports are
  excluded from broadcasts to avoid re-entrant deadlocks). A destructive purge cannot trust it:
  `restoreBackup` polls rocksdb-js `registryStatus()` (process-global across worker threads) until
  the database path has no open instance, and aborts with a 409 — _cleaning up the marker, since
  nothing was destroyed_ — if handles remain.
- **Online restore is impossible for a database a component holds open — and that failure is
  correct.** rocksdb-js's registry is process-global but records only a per-path refCount, with no
  attribution to a thread or component; Harper keeps no component→database ownership map. So when a
  loaded component (or the `system` database, which Harper itself never stops while running) holds
  its own handle on the target database, `registryStatus()` stays non-zero, Harper can neither
  identify nor force-close that handle, and an in-place purge would corrupt a live instance.
  `verifyDatabaseClosed` therefore waits only a short grace period (`DATABASE_CLOSE_WAIT_MS`, for a
  just-finished job worker's own close to drain) and then fails fast with a 409 that points at
  running the operation offline (`harper restore_backup` with the server stopped, where no
  components are loaded and nothing holds the database open). Offline restore is the supported path
  for component-held and `system` databases; online restore serves databases not actively held by a
  component. The CLI exposes each backup operation under its operation name only (`create_backup`,
  `restore_backup`, …) — no hyphenated alias — and `bin/backup.ts` routes it to a reachable server
  or, when the local server is stopped, to the equivalent offline function.
- **Job workers must release their RocksDB handles on exit, or the closure check can never pass.**
  rocksdb-js's registry is process-global across worker threads, and a thread that exits WITHOUT
  closing leaks its handles (the refCount never drops); the only alternative, `shutdown()`, tears
  down rocksdb for the _entire_ process. A job worker (`server/jobs/jobProcess.ts`) opens the whole
  database graph via `getDatabases()` and exits when the job finishes — and `create_backup` is
  itself a job, so before any `restore_backup` there is always at least one exited job worker that
  touched the database. Without cleanup those leaked handles keep `registryStatus()` non-zero and
  would fail the closure check even when no component holds the database. `jobProcess` therefore
  calls `closeLoadedDatabases()` (`resources/databases.ts`) in its `finally`, closing every loaded
  user database on that thread (the non-enumerable `system` DB is intentionally skipped), so an
  exited job worker leaves no residual handle to be mistaken for a live holder.
- **`dropDatabase` and `restore_backup` serialize on the same lock, not a check-then-act probe.**
  A drop's `destroy()` interleaving with a restore's purge-and-copy on the same directory would gut
  a "successful" restore (or vice versa). `dropDatabase` therefore _acquires_ the restore lock
  (`acquireRestoreLock`, marker-less) for each RocksDB root store and holds it across the whole drop,
  releasing in a `finally`; a restore in progress makes the acquire fail with 409, and a leftover
  incomplete-restore marker (lock free, detected via `restoreMarkerPresent`, which — unlike
  `checkRestoreState` — is safe while this thread holds the lock) is refused rather than dropped over.
  `database()`'s on-demand open still uses the read-only `throwIfBlockedByRestore` (a
  `create_table`/`create_schema` must not resurrect a half-purged directory as a fresh empty DB), but
  the destructive drop path now uses the exclusive lock so the race is closed, not merely narrowed.
- **The offline restore probes RocksDB's own `LOCK` file, and fails closed.** The offline path runs
  only when the CLI sees no server (a PID heuristic; the PID file is briefly absent mid-`harper
restart`), and `backups.restore`'s `purgeAllFiles` never takes RocksDB's lock — so before purging,
  `restoreBackupOffline` opens the database to probe. It now takes the restore lock+marker _before_
  probing (so a server that starts afterward sees the marker and refuses to load), and recognizes the
  pinned rocksdb-js 2.5.0 lock error — a plain `Error` with no `code` and message
  `IO error: While lock file: <db>/LOCK: Resource temporarily unavailable` (`isRocksDbLockError`) —
  aborting with a 409 rather than purging a database another process holds open. Any _other_ open
  failure (corrupt/half-restored) is exactly what restore recovers, so only a lock conflict aborts.

Known limitation: the flock is process-owned; if the restore job's worker _thread_ dies without
the process exiting, the lock stays held (restores 409) until Harper restarts. There is no typed
native lock signal in rocksdb-js 2.5.0, so the offline probe relies on message matching; a native
lock primitive is a rocksdb-js follow-on.

## RocksDB managed backups: blob snapshots (`dataLayer/blobBackup.ts`)

A database's file-backed blobs live in one or more roots _outside_ the RocksDB directory
(`getBlobPathsForDatabaseName` in `resources/blob.ts` — one per configured `storage.blobPaths`, else
`<hdb_root>/blobs/<database>`), so the engine's backup does not capture them. `create_backup`,
`restore_backup`, `delete_backup`, `purge_backups`, and the streaming `get_backup` therefore handle
blobs alongside the engine data (the `exclude_blobs` request option — default false — opts out for an
engine-only backup):

- **Managed backups** snapshot the blob roots to `<backupDir>/blobs/<backupId>/<rootIndex>/<relpath>`
  — a full, non-incremental copy per backup, mirroring the binding's `transaction_logs/<id>/` layout.
  Files are hard-linked when possible (cheap, no extra space on the same filesystem) and copied when
  the backup root is on a different filesystem; never symlinked. Hard-linking is safe against later
  mutation because Harper blobs are content-addressed and write-once (each write allocates a new
  monotonic file id → a new path; updates/deletes unlink the old path), so a snapshot's hard link
  keeps the exact bytes even after the live blob is deleted, and no in-place overwrite can alter it.
  The snapshot is built in a `.tmp-<id>` sibling and atomically renamed so a failed create leaves no
  partial snapshot. `restore_backup` purges each blob root and rewrites it from the snapshot (so a
  blob added after the backup is dropped and one deleted after it returns); `delete_backup` /
  `purge_backups` remove the corresponding snapshot directories.
- **`get_backup`** appends the blob files to the same tar under `blobs/<rootIndex>/<relpath>`. The
  binding's streaming backup finalizes its tar with exactly a 1024-byte (two-block) end-of-archive
  marker; `createBackupStream` streams the native _plain_ tar while withholding that trailer
  (verifying it is all-zero), appends the blob entries via `tar-stream` (whose `finalize` writes the
  one real trailer), and gzips the combined stream itself when requested — so the binding is always
  asked for a plain tar and compression happens after the append. No scratch disk. Blob capture is
  best-effort point-in-time (whatever files exist while it streams; a blob deleted mid-stream is
  skipped) — Harper does not freeze blob writes for a backup, the same tradeoff the engine makes for
  the transaction log.

**Completion manifest (`dataLayer/backupManifest.ts`).** `create_backup` is two-phase: the engine
backup (`rootStore.backup()`) resolves — and is immediately visible to `list_backups`/`verify_backup`/
`restore_backup` — before the blob snapshot is copied. Without a completion record, a blob-snapshot
failure (or a crash between the phases) would leave an engine backup that lists and verifies as
healthy while silently missing its blobs, and a concurrent restore could pick a backup id whose
snapshot is still being written and treat it as intentionally engine-only. So a manifest at
`<backupDir>/manifests/<backupId>.json` — recording the blob-inclusion policy — is written
(atomically, temp + rename) only after _both_ phases are durable, and a graceful blob-snapshot
failure rolls back the just-created engine backup + partial snapshot. Consumers treat a backup id
with no manifest as incomplete: `list_backups` hides it, `verify_backup`/`restore_backup` reject it
(409 for a specific id, "no complete backups" for `latest`), and restore uses the manifest's `blobs`
flag — not the mere presence of a snapshot dir — to decide whether to restore blobs (so an engine-only
backup leaves live blobs untouched, and a manifest that claims blobs but has no snapshot is flagged
corrupt by verify). This closes the "healthy-looking but incomplete" and concurrent-restore races;
the remaining engine/blob point-in-time skew (a blob unlinked between the engine cut and the blob
walk) is the documented best-effort limitation above.

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

## Per-worker UDS mirrors are separate server instances — port-keyed wiring does not reach them (`server/http.ts`)

With `tls.unixDomainSockets: true`, every secure port gets a per-worker cleartext mirror
(`<worker>-<port>.sock`) so a fronting proxy (symphony) can terminate TLS and route to a specific
worker. The mirror is a **separate** `http.Server` instance registered in `SERVERS[udsPath]` — it is
_not_ `httpServers[port]` — so anything wired by port key (upgrade listeners, uWS `wsHandler`,
mTLS flags, socket options) must be explicitly propagated to it. `getHTTPServer()` exposes the
mirror as `server.udsMirror` (Node) / `server.udsMirrorUwsConfig` (HARPER_UWS_UDS) for exactly this;
`onWebSocket()` uses those to attach the `'upgrade'` dispatch and uWS `wsHandler`. Two lessons paid
for in production (WS handshakes died with a zero-byte close on the mirrors while SSE worked):

- A Node HTTP server with **no** `'upgrade'` listener destroys upgrade sockets with no response and
  no log — a silent per-server default that makes a missing listener look like a network problem.
- `enableProxyProtocol()`'s data interception must hand the socket **back to the original
  listeners** once the PROXY header decision is made (it re-attaches them and removes its wrapper).
  A permanent wrapper breaks protocol handoffs: Node's upgrade path removes its parser's `'data'`
  listener _by reference_ before ws takes over, so a lingering wrapper keeps feeding the freed HTTP
  parser — which the parser pool can re-issue to another connection, injecting one connection's
  WS frames into another's request stream (`Parse Error: Data after 'Connection: close'`).

The h2c mirror (`HARPER_H2C_UDS`) is exempt: HTTP/1.1 `Upgrade` doesn't exist in h2, and the
fronting proxy routes WS to the h1 mirror by ALPN.

Known limitation on uWS-served transports (`HARPER_UWS_HTTP` ports, `HARPER_UWS_UDS` mirrors):
uWS accepts WebSocket handshakes natively in `app.ws()`, so `server.upgrade()` middleware never
runs pre-handshake there (auth is unaffected — it runs in the WS connection chain on both paths,
matching Node's upgrade-then-authorize order). No core component registers custom upgrade
middleware; `onUpgrade()`/`installUwsWsHandler()` warn when one is registered for a uWS-served
port so the gap is visible instead of silent.
