# DESIGN.md

Design notes and non-obvious internals for the harper-pro/core codebase. Complements AGENTS.md (architecture overview) and CONTRIBUTING.md. Grows incrementally as agents encounter non-obvious things.

---

## RecordObject prototype and entryMap

Records stored in tables are plain objects given a `RecordObject` prototype, which provides `getExpiresAt()` and `getUpdatedTime()`. These methods read from `entryMap` (a `WeakMap` in `RecordEncoder.ts`), which maps each record object to its storage entry.

- The prototype is set automatically by the msgpack decoder via `structPrototype` (per-table, defined inside `RecordEncoder`).
- `entryMap.set(record, entry)` is called whenever a record is read from the store.
- To give a plain JS object the RecordObject prototype without copying it (preserving mutability), use `Object.setPrototypeOf(obj, primaryStore.encoder.structPrototype)` then `entryMap.set(obj, entry)`.
- Do **not** copy the object (e.g. via `Object.assign` into a new instance) if any code still holds a reference to the original and expects to mutate it — see below.

## getFromSource() timing: promise resolves before commit runs

In `getFromSource()` (`Table.ts`), the promise that callers await resolves with the entry **before** the `dbTxn.addWrite` commit callback runs. The commit callback mutates `updatedRecord` in-place to set fields like `createdAt` and `updatedAt`. Since the resolved entry's `.value` is the same reference as `updatedRecord`, those mutations are visible to the caller after resolution.

Consequence: never replace `entry.value` with a copy of `updatedRecord` in this path — the copy won't receive the commit callback's mutations.

## Blob orphan cleanup: pre-saved files outlive cancelled commits

Blobs flagged with `saveBeforeCommit` (or `saveInRecord`) are written to disk in the `beforeIntermediate` phase of a `TransactionWrite`, _before_ the LMDB/RocksDB write commits. The write's commit callback can still skip the actual record write — for older versions, supersedence by future updates, residency mismatches, or full transaction abort. In every such path the file is on disk but no record references it.

The mitigations live in three places:

- `startPreCommitBlobsForRecord` (`blob.ts`) returns the blob list alongside its completion callback so each `TransactionWrite` can attach a `savedBlobs: Blob[]`.
- `cleanupUnusedBlobs(blobs)` (`blob.ts`) waits for each blob's `saving` promise to settle, then `deleteBlob`s the file. It clears the input list so it's idempotent across repeated calls (e.g. an early-return that also gets caught by the abort path).
- `Table.ts` commit handlers set `write.skipped = true` (and reset to `false` at the top of each invocation) on early-return paths that don't write the record/audit: duplicate-tie, superseded-by-put, no-audit-fullUpdate-loses, and cache-resolve version-changed. The transaction commit success paths (`DatabaseTransaction.commit` and `LMDBTransaction.commit`) walk writes and call `cleanupUnusedBlobs(write.savedBlobs)` for every still-skipped write. Cleanup is deferred (rather than run inline in the commit handler) because the commit handler runs again on optimistic-lock retries, and a retry can flip a previously-skipped write into a successful one (e.g. the existing record gets deleted between attempts so the older replicated update suddenly wins). Inline cleanup would race the deletion's `setTimeout` against the retry that referenced the blob.
- `LMDBTransaction.abort` and `DatabaseTransaction.abort` walk all writes and run the same cleanup unconditionally (regardless of `skipped`), since nothing was committed. `DatabaseTransaction.commit` adds an explicit reject handler so a `Promise.all` failure on `completions` (e.g. a blob save errored) aborts the underlying transaction instead of leaking it _and_ the blob files.

When adding a new commit-handler early-return path: reset `write.skipped = false` at the top of the handler if you don't already, then set `write.skipped = true` immediately before the `return`. Decide first whether the audit log will reference the blob (via `auditRecordToStore`) — if it does, leave `skipped` unset. `cleanupOrphans` is the periodic safety net; don't rely on it for transactional correctness.

## Opening a source LMDB DBI for migration must thread through `compression`

When `migrateOnStart` opens a source LMDB primary store to read records out for the RocksDB copy, it constructs an `OpenDBIObject` and calls `sourceRootStore.openDB(key, dbiInit)`. Critically, the per-attribute `compression` setting from the corresponding `__dbis__` entry must be assigned onto `dbiInit` before that call — `dbiInit.compression = attribute.compression`. Without it, lmdb-js doesn't install its decompression layer; every read on the DBI returns raw compressed bytes. msgpackr then misreads bytes in the `0x40–0x7F` range as shared-structure refs, calls `loadStructures` → decodes the (also compressed) structures buffer → finds more bytes in that range → recurses → stack overflow.

Harper's normal `databases.ts` path already does this (search for `dbiInit.compression = primaryKeyAttribute.compression`); the migration path in `bin/copyDb.ts` has to match.

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

## System table bootstrap: `systemSchema.json` + upgrade directive

Adding a new system table (e.g. `hdb_deployment` in #641 Slice A) requires three changes:

1. **`json/systemSchema.json`** — the table entry. Fresh installs auto-create it via `utility/mount_hdb.ts:createTables()`, which iterates `Object.keys(systemSchema)` on first boot.
2. **`utility/hdbTerms.ts`** — add the table name to `SYSTEM_TABLE_NAMES`.
3. **`upgrade/directives/<version>.ts`** — provisions the table on existing installs that already have a system schema. Registered in `upgrade/directives/directivesController.ts` (which is otherwise empty — its `versions` Map gets populated by these imports). The directive shape is `{ version, sync_functions, async_functions }`; copy `5-2-0.ts` for the canonical pattern (uses `bridge.createTable` to match what `mount_hdb` does on a fresh install).

System tables replicate by default. To opt out, add the name to `NON_REPLICATING_SYSTEM_TABLES` in `resources/databases.ts`. The check happens after table init and sets `table.replicate = false` per-node.

If the table needs `audit: true`, set it both in the schema (for fresh installs) **and** on the `CreateTableObject` instance in the directive (for upgrades) — otherwise the two paths diverge.
