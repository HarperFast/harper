# resources/ — design notes

Rules the `resources/` code cannot state, why each holds, and the symbol and test enforcing it. Navigation: [MAP.md](MAP.md). Also: [record-locks.md](record-locks.md), [audit-retention.md](audit-retention.md), [FULL_TEXT.md](FULL_TEXT.md). Tests are in `unitTests/resources/` unless a path is given.

## Full-text declarations and reader snapshots

A declaration compiles to `fullTextIndexes`/`fullTextFields` (`fullTextSchema.ts`), never to `attributes`: it has no stored or selectable value. Write guards ignore reader readiness (`assertFullTextWrite`). One reader lease spans a search; only an idle reader reloads (`#acquireSearchReader`, `fullTextQueryIndex.test.js`). Native budgets are fixed before `startHTTPThreads()`.

## A bare nullish id is never a collection target for `get` or `delete`

`transactional()` throws a 400 for a bare `null` or `undefined` id; a bare-null delete once removed every record. Gaps: `{ id: undefined }` and function-form `defineResource` (`deleteNullResourceApi.test.js`).

## A static get by a primitive id skips instance dispatch only when nothing could observe it

The `registerPrimitiveIdGet` getter shares `loadRecord()` with `_loadRecord`. Its gate compares every hook the instance dispatch would call against the original, and declines any context that changes dispatch. **Add every new instance-get hook to that gate** (`tableGetPrimitiveId.test.js`).

## An audit record carries two clocks; identity is (nodeId, log key), never a version

`AuditRecord.version` (record version) drives last-writer-wins, `@updatedTime` and ETags; `txnLogKey` (log key) drives identity, `auditStore.get(logKey, tableId, id, nodeId)` and resume cursors. They diverge for source fills, applied writes and caller timestamps; such a RocksDB record reaches its head via `additionalAuditRefs`.

- `isAuditEntryWrite` is the only identity test; `removeAuditEntry` keeps a tombstone of unknown identity, as a version compare would let one write destroy another's.
- An applied RocksDB write stores its received version (`TransactionWrite.recordVersion`) under the origin's log key.
- A ref states its kind: `additionalAuditRefs` holds log keys, `receivedIdentityRefs` received identities (bit 31, `RECEIVED_IDENTITY_REF`), an unaudited record's only re-delivery proof. **Never "fix" a log key to the version** (`auditRefKinds.test.js`).
- An LMDB merge keeps the older version, because it is `LMDBTransaction.commit`'s `ifVersion` token (`noAuditOutOfOrderPatch.test.js`).
- Duplicates are judged from committed identity; only a minted key distinguishes a retry's own staging (`readsOwnStaging`, `replicatedRetryDuplicate.test.js`).
- `FULL_WRITE_HEAD`: the head replaced the whole record, unchanged since; any other write clears it, and an older write skips the walk only above a known floor (`fullWriteHead.test.js`).
- A numeric log selector only looks a log up, because `useLog` would create it (`auditLog.test.js`).
- Equal versions tie only within one origin; the walk's `precedesAudited` never rewrites the head comparison (`equalVersionOriginOrder.test.js`).
- Replay applies stored versions; a replay transaction ends at `endTxn`, a log change or a key change, never by key alone (`replayCommitBoundaries.test.js`).

## Request admission authorizes exactly what the dispatch runs

- `transactional()` resolves a QUERY body first, drops client `checkPermission`, and hands the body's `select` to `allowRead` (`permissions.test.js`).
- In false mode, `search`, `query` and `get` await the `SEARCH_AUTHORIZATION` verdict `Table.search` carries, so a denial cannot become a truncated success. A default-mode `get` takes no extra promise step: `allowRead` was already awaited (`asyncAllowReadSearchResults.test.js`).
- In false mode, array PUT, query DELETE and publish take one verdict each; DELETE scans a private cloned target (`staticResourceDispatch.ts`).
- `rowFilter` is rechecked on the materialized record, and `limit` applies after it.

## Array PUT is a collection dispatch that settles every element before it fails

The synthesized target keeps the collection flag, or the batch becomes one null-keyed record. Each element gets its own target (`elementTargetFactory`, no `checkPermission`); a context in the target position would be staged as data. Non-objects are refused before dispatch. `settleElements`, not `Promise.all`, lets every element finish, so the transaction cannot unwind under a slow element into a partial PUT; it reports the earliest-index error, adding no `cause` (`arrayPutCallerImpact.test.js`).

## Sharding resolves fixed slots through an authoritative database map

- Public `@sharded` hashes primary keys; `by`/`slotFrom` need the test switch `replication_experimentalAttributeSlots` (`unsupportedResidencyPolicy`, harper-pro#1178). RocksDB-only; needs auditing and replication.
- The slot map (`residencyMaps.ts`) is authoritative, never rebuilt from config; policy and count are fixed after activation (`declareTable`).
- Map writes and activation serialize on a native lock (`acquireResidencyMapFence`, 503 on contention). `installResidencyMap` imports lazily: an eager import reorders boot.
- `captureResidencyOwners` pins owners for a commit and its retries; replicas never own. A LOCAL_ONLY transition excluding the writer is refused before submission, and a catch cannot let it through.
- Main quarantines only classified failures, released only by restart. Live holds are retryable (`DatabaseShardingHeldError`); replay bypasses them, never a quarantine. Only `REPLICATION_APPLY` fills an incomplete owner (`databaseBaselineHoldReason`).
- `blobReferenceGeneration` fences replica blob reclaim: encoders bump it before checking a claim, and a claimed file returns 503 `BLOB_RECLAMATION_BUSY` (`declarativeResidency.test.js`, `shardingSupport.test.js`).

## Full PUT resequencing

`_writeUpdate` replays every retained newer patch onto an out-of-order PUT, or skips the PUT when nothing can be verified. A newer `invalidate` entry is a boundary like a put or delete; test the entry, not the `INVALIDATED` flag a patch keeps. An incomplete walk falls back to the per-node merge, which converges only by full copy (harper#1148; `outOfOrderFullPut.test.js`, `outOfOrderInvalidatedHead.test.js`).

## Database generation and resumable positions

**No readable copy keeps its source's generation. A position resumes only with the current generation and a finite cursor at or above the resume floor** (`isResumablePosition`, RocksDB only).

- A copy stamps and flushes a new generation before it is readable (`stampDatabaseGeneration`); an open never repairs one.
- Cursors are progress-based: a snapshot's newest key can fall below a later floor.
- An open ends earlier handles' subscriptions (`endSubscriptionsFromEarlierHandles`).
- A resume is checked at registration and at every replay yield against the previous check's position, since a prune raises the floor before deleting. Read failures, undecodable entries and `reload` markers refuse it. Checkpoint only after `resumeVerified` (`databaseGeneration.test.js`, `subscribeResume.test.js`).

## Origin-closed timestamp floor

**Nothing appends to `local` below the certified floor `F`** (`originClosedFloor.ts`, harper-pro#922).

- A key is reserved on its thread before the first staged write (`DatabaseTransaction.save`, `reserveLocalKey`). Otherwise `RocksTransactionLogStore.put` throws: a logged violation is unrepairable.
- A thread marks its bound pending before minting; samplers raise `proposed` before reading bounds, so one side sees the other. Compare-and-swap maxima keep concurrent certifiers safe.
- **Every `local` key is minted** (`reserve`, `freshKey`). A caller's value is only the record version (`uniqueLocalLogKeys.test.js`).
- The floor syncs **before** publication; a restart seeds keys above it and the issuance ceiling (`coverLocalIssuance`).
- Worker bounds retire only on main's `worker.on('exit')`, after its commits drain.
- `progress()` reports `certifiedThrough`. A notify pass captures `localStartBound` **before** it drains (`originClosedFloor.test.js`, `subscribeProgress.test.js`).

## Historical record reconstruction (`getRecordAtTime`)

`getRecordAtTime` (`crdt.ts`) undoes only patches. Past a newer put, delete or invalidate it rebuilds forward (`reconstructForward`): carrying an image back returns a future state. A reversed field survives only when the reversal is exact. An unlinked put ends the chain without implying an empty past (`crdt.test.js`).

## Path routing & parameterised routes

Parameterised routes sit outside the base map (`paramRoutes`), so exact and prefix matching stays fast and static routes win (`Resources.getMatch`). Literal > `:param` > `*`; a wildcard is last. `openApi.ts` and `components/mcp/resources.ts` each convert templates, so a syntax change touches both (`paramRoutes.test.js`).

## Persisted relationship catalog

The operations thread loads no schema, so `table()` stores `@relationship` targets on the primary descriptor, which older versions ignore. Only GraphQL (`schemaRelationshipsDefined`) may replace the list. The update holds the `update-attributes` lock and never replaces a drop tombstone (`schemaMigrationFragility.test.js`).

## A relationship read is authorized against the related table

Each relationship step needs `read` on the related table and attribute (`Table._readDenial`). **The search layer checks nothing**, so REST `allowRead` (`_authorizeRelatedSelection`), `verifyPerms` (after `normalizeSearchRequest`) and `ResourceBridge.getSelect` check the query that will run. A `*` select of `@enumerable` relationships is rewritten unless `_readableInFull`. SQL is not covered (harper#3509; `permissions.test.js`).

## Typed, discoverable resources (code-first schema + request contract)

**Runtime metadata is values; types derive from it**, since type stripping erases types (harper#1503). `attributeToFragment` is the one IR for validation, OpenAPI and MCP. Contract types narrow `RequestTarget` only because each declared verb validates its input before dispatch (`ValidationError`). `compileVerb` alone decides `bodyRequired` (`defineResource.test.js`).

## Conventions

- **Never remove `transactional()` from a static `Resource` method**: it owns the context's lifetime. Override instance methods.
- **A static override owns the whole contract.** It resolves or consumes `data` and decides access itself; no `allow*` runs (`login.ts`).
- `transactional()` resolves the body before `allow*` and passes both one object (`requestBody.test.js`).
- Nested relationship constraints share `_prepareRelationshipSelection`. Predicates never mutate projection maps (`nestedRelationshipConstraints.test.js`).
- Only records and relationship targets use a table's resolvers; plain JSON uses resolver-free `nestedSelectTransform` (`searchSelectProjection.test.js`).
- Storage keeps only stored fields (`storedFieldsOnly`); `toJSON` is a projection.
- **`relationship.from` accessors are synchronous** (v4 parity): `getSync`/`getEntry`, never `get()` (`query.test.js`).
- **Queries read related records asynchronously** (`loadEntries`), choose one or many by `toMany`, and check `getReadTransactionGuard` after each await (`relationshipAsyncReads.test.js`).
- **`@relationship(from, to)` joins `related[to] == local[from]`.** The resolver, `joinTo`/`joinFrom`, `transformEntryForSelect` and `filterByType` must agree.
- `updatedAttributes` precompiles expressions before mutating, and retires removed accessors.
- A new `_writeUpdate` early return follows the blob protocol. A new `Table.ts` section starts with `// #section:`.
- A new public table-class member must be mirrored in `TableResourceClass`/`TableResourceInstance`, or `tsc` fails (`_TableResourceMatchesItsDeclaredTypes`).

## RecordObject prototype and entryMap

Each encoder has its own `StoreRecordObject` prototype, so getters stay per table; `entryMap` maps record to entry (`RecordEncoder.ts`). LMDB promotes before lmdb-js caches, since a cached WeakRef target is fixed (`lmdbPrefetchComputed.test.js`). Test with `instanceof RecordObject`, never `entryMap.has`. Never copy a record that other code mutates.

## Struct mode is gated to primary DBIs (downgrade compatibility)

v4 (msgpackr v1) reads struct headers `0x20–0x3f` as integers, so a struct-encoded `__dbis__` breaks a v5→v4 downgrade. `OpenDBIObject` allows structs only on primary stores (opt-in) and custom-index object stores. `RecordEncoder` **bails** the write hook (`_writeStruct = () => 0`), never clears it: clearing moves the fixint boundary, so the read hook would misread `0x20–0x3f` (`recordEncoder.test.js`).

## Non-`initStore` structure saves read inside their own transaction

`PrimaryRocksDatabase.open()` binds `encoder.rocksStore` for `__dbis__`, so `saveStructures` reads inside its compare-and-put. It writes `asBinary`, so `putSync` cannot re-enter `encode`. **Never set `encoder.isRocksDB` on `__dbis__`**: it would move the key and strip byte `0x42` (`recordEncoder.test.js`).

## A patch that creates a record derives its primary key and created time at commit

A patch that lands on no record carries neither field, and RocksDB logs only the first attempt. So the commit fills whichever is missing, on every path (`completeCreatedRecord`, `createdTimeBase.test.js`).

## getFromSource() timing: promise resolves before commit runs

A fill resolves before its commit, which encodes the shared record as it is then. **Copy a resolved record before mutating it**, as `finalizeResponse` does. The commit builds its own `recordToStore` and decides residency before `updateIndices` (`sourceFillIndexes.test.js`).

## getFromSource() waiters share a fill that stored nothing

A same-thread waiter reuses the leader's fill only if it committed and kept its write, is plain data (`isSharableRecord`) and was not `noCacheStore`; failures and other threads never share (`sourceFillCoalescing.test.js`).

## getFromSource() keeps source versions separate from fill ordering

- A source's `lastModified` is capped at local time: the version is also the last-writer-wins token, so a future-dated source would make local writes look stale.
- A first fill replaces a raced record only with a **strictly greater** version. `precedesExistingVersion()` breaks ties by executing node, letting replicas diverge at one version.
- A non-advancing RocksDB version carries `VERSION_REUSED` (persisted bit `0x10000`), which rocksdb-js will not vouch for; renumbering needs a migration (`caching-rocks-database.test.js`).
- Fill puts carry no condition of their own; on LMDB one `ifVersion` block guards primary, index and audit puts (`sourceFillConditionalWrite.test.js`).

## getFromSource() record locks outlive neither their handle nor a close

Closing the owning handle releases a fill's lock, so `releaseRecordLock` ignores an unlock on a closed store. Waiters also wake on `LOCK_TIMEOUT`: a close never notifies another thread (`cacheFillClose.test.js`).

## Blob orphan cleanup: pre-saved files outlive cancelled commits

Pre-commit blob files land before a commit that can still skip the write.

- A commit handler resets `write.skipped` each round and sets it only when the round staged neither record nor audit entry; an unmarked skip looks like a write that replicates nothing.
- Skips are cleaned after commit, never inline: a retry can make the skipped write win. Abort cleans all but files a durable log or audit entry owns (`hasDurableLog`, `blobsAuditReferenced`).
- `cleanupUnusedBlobs(blobs, retainedFileIds)` spares the committed record's files. A deleted file tombstones its `Blob`, so `saveBlob` throws on it (#2062).
- `cleanupOrphans` scans every retained audit value: history owns its files.
- `evict()` and source-miss removals unlink only from their own commit, for the version and expiry they read (`evictionBlobs.test.js`).
- An unavailable source blob (`isSourceBlobUnavailable`) never aborts a replicated apply (`blob.test.js`).

## Blob compression: policy at `saveBlob`, completeness from the writer lock

- Policy resolves in `saveBlob`, which every local write passes; unknown-size streams never compress.
- **Completeness comes from the writer lock, never the length**: the header records the uncompressed size. After waiting, `readCompressedBlob` compares `fstat` with `stat`, since repair renames over the path.
- The header byte is per-file truth; `storedCodec` only prefilters. Inflate verifiers settle on `error`/`close`: a mid-stream `Z_DATA_ERROR` never calls the `write` callback.
- Repair classifies asynchronously and confirms under the lock by length and header, never inflating on the event loop (`blobCompression.test.js`).

## Over-time transactions are aborted, not force-committed

`startMonitoringTxns` acts past `STORAGE_MAXTRANSACTIONOPENTIME`. Code committing a native handle itself opens it raw, never via a wrapper's `getReadTxn`: the wrapper would stay tracked, and its retry would resolve a conflict as `RETRY_NOW` instead of rejecting with `ERR_BUSY`.

- **A write-bearing transaction is aborted and poisoned** (422 `transactionOpenTooLongError`): force-committing a partial write set breaks atomicity. `hasPendingWrites()` walks `next`.
- Read-only, `sourceApply` and `isReplay` transactions are force-committed. Sources and replay cannot resume, so an abort drops a write the cursor passed (harper-pro#348).
- The owner's commit chains on `monitorCommit`. The pre-commit phase is spared `COMMIT_PHASE_GRACE` ticks: its writes are sealed, and poisoning there once reported success after unlinking blobs.
- After the pre-commit await, the commit rechecks liveness or resolves as a phantom. **The monitor never aborts a submitted native commit.**
- `timeoutBudget` is a sticky floor that chained links inherit.
- Conflict retries get one deadline per logical commit (503 `TransactionCommitConflictTimeoutError`), not per attempt: that clock drives `checkOverloaded()`.
- **A handle with a durable log entry is never aborted on retry** (harper#3236): that orphans an entry replay applies (`noAbortAfterTxnLog.test.js`, `txn-tracking.test.js`).

## A client disconnect cancels the request's writes

`context.signal` is the request's lifetime: after it aborts, `transaction.ts` stages no more writes on that context (harper#2001), since an orphan's intents wedge other commits. Work outliving the client uses a signal-free context; background work arms via `contextStorage.exit()`, which is `run(undefined)` because native `exit()` only disables storage (`contextStorageExit.test.js`).

- `admitRequestWrite()` reads the signal at the first write; a read-only request creates none.
- **The point of no return is native submission.** A poison mid-submission aborts nothing; the chain's remaining stores follow (#1407).
- `closeOwnedReadIterators()` closes unreachable iterators, and an abandoned scope keeps its handle (`abandonScope()`). MQTT carries no signal (`transactionCommitBoundary.test.js`).

## Replication directives are super-user only, gated where they enter

Consumers trust `context.replicateTo`/`replicatedConfirmation`, which applications set for any user, so client input may set them only for a super user, checked where it enters: the header in `server/REST.ts` (403 on any method, since a custom `get` can write) and the body fields in `verifyPerms`. **`Table.allow*` cannot enforce this**: false-mode resources skip it and applications override it (harper#2898; `replicationDirectiveAuthorization.test.js`).

## A read-only server refuses writes at admission

A read-only process stages no writes: every producer passes `DatabaseTransaction.admitRequestWrite()` (405). `transactional()` refuses table writes early, never `post` or `publish`. Producers running before `addWrite` refuse themselves: `lock()`, numeric `getNewId()`, `addAttributes` and TTL eviction (`readOnlyModeWrites.test.js`, `readOnlyModeTtl.test.js`).

## A record past its expiry on a table with no source is gone before eviction removes it

Eviction trails expiry. Until then, a table without a source get treats an expired record as absent (`isHiddenExpiry`) in get, only-if-cached (504), search, subscribe and `withLocalEntry` (no `ETag`). Write-path loads and `includeExpired` (SQL UPDATE/DELETE) still see it. Stored expiry resolves at commit: option, context, field, table default; an out-of-order write keeps its merge base's expiry (`outOfOrderWriteExpiry.test.js`, `onlyIfCachedExpiry.test.js`).

## RocksDB range activity and snapshot expiration

`trackReadRange` records each `next()`, but a scan never renews a write holder. The read owner is a symbol property (`READ_OWNER`), **not a `WeakMap`**: a per-transaction ephemeron costs every scavenge (GC time per GET rose). Resuming past a released snapshot throws a 503 `ReadSnapshotExpiredError`; retry only the read. `snapshot: false` pins no snapshot (`rangeReadActivity.test.js`).

## Per-row read work on RocksDB index scans

RocksDB index rows store `null`, so `RocksIndexStore.getRange` reads keys only. `PrimaryRocksDatabase.getEntry` passes a fresh options literal, never the caller's object; add newly needed options there. The plain-column fast path is decided per row (`indexRangeSelect.test.js`).

## A read reference belongs to the handle acquisition it was taken on

`doneReadTxn(generation)` ignores returns from earlier acquisitions: lmdb-js reuses the `Txn` object. Gap: `disregardReadTxn()` is unstamped (harper#3308; `detachedReadRefs.test.js`).

## `getRecordCount`'s estimate is a heuristic, not a bound

`estimatedRange`'s upper end comes from the native estimator and can undercount (`getRecordCountCallerImpact.test.js`). Only `exactCount: true` is exact. An untrusted store answer degrades, never poisons, it (`usableCount`).

## Auto-increment id ranges are claimed by compare-and-replace

`replaceIdAllocation` (`getNewId`) writes only if the stored range equals the one it read. **Compare the value, never `entry.version`**: the record has no version, so a version check always passes (`idAllocation.test.js`).

## Replicated apply failure listeners

**After a terminal apply failure, nothing is pulled until every listener has been awaited** with the origin and position (log key, not version). A listener runs and persists outside the source transaction, resolves only once durable, and is idempotent for `(nodeId, position)`. A failing listener never stops the others (`notifyReplicatedApplyFailure`); a hung one backpressures the source (`replicatedApplyFailure.test.js`).

## Source transactions are delimited per connection, and a transaction log holds one origin

- `Table.sourcedFrom` keeps one transaction per `txnStream` token: connections share the subscription and yield mid-frame (harper#1162).
- `RocksTransactionLogStore.put` files each origin in its own log, so keys stay unique per log; exact resume depends on that.
- `onFailure` returning true **holds** the stream (no cursor moves) while the source replays; held failures skip the listeners.
- `originFloors` merge only from tagged streams passing `onFailure`, since resume trusts them (`sourceTxnStreams.test.js`).

## Repeat writes to the same key in one transaction carry their state forward

No engine can refresh a staged base from a read, so `addWrite` chains same-key writes (`linkWrite`) and each takes the prior write's `stagedEntry` (`priorStagedWrite()`); without it, indexes keep intermediate values (harper#1968).

- Program order breaks **ties only**; a newer existing version still takes the out-of-order merge.
- The chain key is the store's key encoding (`writeKeyId`): `1n` and `1` chain, but `[0]` and `[-0]` do not.
- **Staging order must equal execution order** (harper#2211). `chainsStagedState` writes defer behind an unrun predecessor, `save()` drains predecessors, and `stageWrite` keeps arrival order. Gap: `_writeRelocate` saves eagerly.
- `_writePublish` leaves the record unchanged and marks `stagedEntry` `unchanged`, so a re-delivery still dedups (`outOfOrderChainedWrites.test.js`, `indexOrphanStagingOrder.test.js`, `publishRecordState.test.js`).

## A tracked instance commits only what it changed, as plain data

Reads cache tracked wrappers in the changes, so `validate` substitutes `collapseChanges(...)` (`tracked.ts`), the one patch every consumer reads. **A read never becomes a write**: it would beat an older out-of-order patch and, on retry, restore stale state. CRDT operations stay operations; `addTo` composes. `hasOwnChange` is the single own-property test (`trackedUpdateCommit.test.js`).

## A delete re-delivered onto its own removal is a no-op

If this same write (origin and log key) emptied the key, `_writeDelete` writes nothing but stages the removal; otherwise each re-delivery appends an entry peers forward again. `stagedEntry` carries `localTime` and `nodeId` for `removalBefore` (harper-pro#826; `replicatedDeleteRedelivery.test.js`).

## An `ImmediateTransaction` save chains on `operation.innerCommit` and re-saves into the handle it is retrying

- A second `save()` outside `transaction()` commits through a nested `commit()` stored on `operation.innerCommit`. Both `Table.save()` branches must await it, or `save()` returns before the write is durable (`recordLock.test.js`).
- During a retry, `ImmediateTransaction.save()` forwards to the retried handle; otherwise it would nest and recurse (harper#2825). A failed re-save releases the detached handle before `abort()` (`immediateTransactionConflictRetry.test.js`).

## A transaction is joinable as a scope only if it stages its writes

`txnForContext` installs a self-committing `ImmediateTransaction` in an empty or `RELEASED_TRANSACTION` slot; it reports `OPEN`, but nothing owns its commit. **Join sites ask `isJoinableScope()`, never `OPEN`**: joining it made `transaction()` self-commit each write and skip its abort (harper#2292).

- A finished scope leaves `RELEASED_TRANSACTION` behind (`contextTransactionCallerShapes.test.js`).
- A joinable scope **takes over** deferred writes (`detachWrite`), since commit paths read only `writes`, but never from a `sourceApply`, `isReplay` or finished holder.
- `scopeOwned` is deliberately not the test (`releasedSlotScope.test.js`).

## The RocksDB codec is a deployment setting, resolved once per process

`DB::Open` opens every column family at once, and a family's codec cannot change while open, so `getRocksCompression()` resolves one codec before the first open and freezes it; opens pass `compressionForAllColumnFamilies`, and per-table `compression` selects nothing. A fresh install stages it before `mountHdb()`. Native WAL stays on for the root and `__dbis__` (`rocksCompressionOpen.test.js`).

## Schema migration and `runIndexing` internals

`runIndexing` (`databases.ts`) writes a checkpoint (`lastIndexedKey`) only after the index writes it covers have settled. A checkpoint resumes only with matching certification; a failure sets `indexingFailed` (503, never partial results). **Set `dbi.isIndexing` on any dbi created mid-build**, because `resetDatabases()` reopens tables (`indexBuildAbandonment.test.js`).

## Cluster-origin table definitions are additive-only

An `origin: 'cluster'` definition is a peer snapshot, possibly mid-create, so `table()` only adds from it: never removing or redefining attributes or flipping `schemaDefined`, and logging what it discards. Drops and redefinitions therefore do not converge through gossip. Abandoned index builds still recover (`clusterSchemaMerge.test.js`).

## `drop_attribute` never removes the primary key, and a strip keeps each row's version

`removeAttributes` refuses the primary key (400) before any change (harper#3574). `stripAttributeValues` rewrites rows audit-off, keeping version and metadata (`VERSION_REUSED`). A raw `put` would drop the metadata prefix (harper#1762; `stripAttributeValues.test.js`).

## A table is invisible to catalog scans until its create is complete

`table()` writes the primary-key row **last**, under the lock, and `initStores` skips a table that has no primary row. A scan mid-create once announced a partial table (`createTableCatalogOrder.test.js`).

## A keyless table's bare catalog row names its primary store

A bare `<table>/` row can lack both `name` and `isPrimaryKey` (harper#3225), so primary-store selection goes through `isPrimaryCatalogRow`. A key declared later cannot re-key existing records, so `table()` clears it (`keylessTable.test.js`).

## Per-origin subscription checkpoints

`checkpoint()` (`subscriptionCheckpoint.ts`) encodes a boundary per origin; lowering one only adds duplicates. **If any known origin lacks a qualifying floor, there is no checkpoint.**

- A floor publishes only after the pass that captured it drains cleanly (`passCapture`).
- `admitCheckpoint` is rechecked at each yield against `readOriginStateEpoch`.
- A live certified subscription is `ungated`: the `startTime` gate would drop a late lower-key commit.
- Only an origin's direct route sets its current generation; floors never order generations.
- An audit-less copy records bounds (`writeCopyBounds`) that void older routes (`subscribeCheckpoint.test.js`).

## Subscription version selection

`eventFromAudit` delivers a mutation only at the current primary version, unless `includeSuperseded` is set. `currentEntryForAudit` reads it once per audit record, safe only because `readAuditEntry` decodes a fresh object per entry (`subscriptionEntryRead.test.js`).

- An out-of-order fold delivers the current state (`subscriptionLatePatch.test.js`).
- **Timestamps are no delivery boundary** (commits finish in any order): the snapshot never advances `startTime` (`subscriptionLateCommit.test.js`).
- A `reload` marker closes position-keeping subscribers (410) and re-snapshots the rest (`reloadMarker.test.js`).

## Audit-store `'committed'` notification batching (`transactionBroadcast.ts`)

- **Registration is the delivery boundary**: a subscriber sees only what commits after it registers; with none, a pass does not iterate (`subscriptionRegistrationBoundary.test.js`).
- `notifyScheduled` spans yields, so passes never share an iterator; the same-thread path holds a lock and never yields.
- A pass skips a closing store, because LMDB emits `'committed'` inside `close()`.
- **The ancestor key walk must strictly shrink** (harper#2687; `transactionBroadcastKeyWalk.test.js`).
- **Ending a subscription never reshapes an array a loop is walking.** The last traversal compacts it (`transactionBroadcastEndDuringDelivery.test.js`).
- `IterableEventQueue.close(finalMessage)` always finishes, then rethrows.

## `createBlob(readable)` and `table.put()` don't synchronously drain the source

The commit waits for a fresh local blob (`startPreCommitBlobsForRecord`), but `put` can resolve before the commit runs. Finalize anything derived from the source only after `storageInfo.saving` settles, as `deploymentRecorder.ts` does.

## Table drops, the `dropping` tombstone, ghost tables, and lifecycle stamps

Nothing spans a table's column families and catalog rows, so `dropTable()` writes a `dropping` tombstone first; boot (`completeInterruptedDrop`) or a same-name create finishes an interrupted drop.

- Rows carry `createdTime`; a drop records `droppedTime` in `/dropped/<table>`; `isDeadGeneration` is strict. An untimed drop never gets a time later, which could postdate a peer's recreate.
- Checks run under the row-publishing lock: a dead peer generation is a 409 before any store opens; a peer drop spares `replicate: false` and needs `REPLICATED_FROM`.
- A name with history gets a generation suffix (harper#3102). Reclamation spares live stores (`dropTableLifecycle.test.js`, `dropTableGeneration.test.js`).

## The exclusive `update-attributes` lock is a bounded synchronous wait

`acquireUpdateAttributesLock` can time out, so `table()` takes the lock **before** mutating the live `Table`. **Locked sections stay synchronous**: the wait blocks the event loop. Release is structural (`withUpdateAttributesLock`). Recreating a table needs rocksdb-js 2.1.0 or later (`updateAttributesLock.test.js`).

## RocksDB transaction log purges are database-wide only

A database's tables share its logs and purges delete whole files, so `deleteTransactionLogsBefore` returns 400 for a table-scoped purge and 404 for a missing table (harper#2049); presence uses `!= null` (`deleteTransactionLogsBeforeRocks.test.js`).

## Boot replay reads bypass the primary-record cache

Replay reads bases with `uncachedRead`: cached WeakRefs outlived the replay and kept the backlog alive (harper#2950).

## Replay limits do not establish data loss

Replay guards cannot prove durability or peer completeness, so they advise copying the database first and verifying peers before re-cloning (harper#2951).

## Query-plan range estimation blends statistical estimates by confidence

- **Capability is feature-detected per store** and answers are validated (`estimateRangeCondition`), so an odd store degrades to the heuristic rather than NaN-poisoning the order.
- **The estimated range is the executed range**: `getRange` and `estimateCount` share `translateIndexBounds`.
- Secondary-index scans open at `null` exclusive; primary scans at `true`, past symbol-keyed metadata (`searchBooleanFalseIndex.test.js`).
- A negated condition estimates `Infinity`. Non-driving filters drop null and omitted values, as ranges do (harper#3212; `estimateRangeCondition.test.js`).

## Query conditions: chained legs scope one array element, and the FIQL parser always advances

- `a=ge=X&=le=Y` matches within **one array element**: `prepareConditions` collapses it to one range comparator so indexed and unindexed paths agree; separate conditions may match different elements; other chains are 400. Multi-value ranges dedupe records before paging (`distinctRecords`; `query-array-scoping.test.js`).
- In `parseBlock`, a pending condition makes the next token a value, and only the group terminator picks the tokenizer. **Every token must advance**: a zero-length match is an error, or the global regexes rematch forever (`query-parse.test.js`).

## Long-lived transactions are reported from the main thread by native id

rocksdb-js's handle registry is process-global, so only main runs `runLongLivedTransactionSweep`, naming handles open past `storage.longTransactionReportThreshold` (`0` disables). Workers attribute their own by the same id (`reportIfLongLived`). Stuck-commit logs list holders from every database, regardless of age: the verification table is one process-wide array (`longLivedTransactions.test.js`).

## A table declaration lands where its application's `databases` binding resolves the name

`table()` is `declareTable` on the global target; branched applications declare through `scopedTableFactory`. A branch root's `databaseName` is filled only when unset (`??=`); branch classes keep the logical name, so schema statics stay refused (`assertSchemaMutable`), and never emit `updateTable` (`branchDatabase.test.js`).

## Ordering an in-memory result set reads each record at most twice

`transformToOrderedSelect` resolves sort keys once per row before sorting, so the comparator never reads the store (harper#2675). Vector distances are cached per sort clause. A stub stays for revalidation unless a filter needs its record, so sorted and unsorted reads agree (`sortedKeyInvalidationReads.test.js`).

## Each hop of a multi-store commit cascade starts with a full idle window

Once sealed, each hop gets a full idle window, never the previous hop's remainder (`renewChainForNativeCommit`).

## A related-table read uses the related table's own database link

A read transaction belongs to one database, so a related read uses the related table's (`_readTxnForContext`); a post-commit join leases that handle (`leaseRelatedReadTxn`). Renewals never count as activity, so abandoned leases are reaped (`crossDatabaseRelationship.test.js`).

## `enc:v1:` env values wait for a registered decryptor and never fail the boot

`loadEnv.ts` defers an encrypted value until a decryptor registers (`deferEncryptedEnvValue`), then replays it; ciphertext is never exposed (`secretDeferredReplay.test.js`).

## Closing an LMDB database closes its environment, never its dbis

Closing a dbi after its environment is a use-after-free, so `closeDatabase` closes an LMDB root once, skipping dbis. Only `closed` counts: lmdb-js resolves `close()` early during a read (`lmdbCloseCompletion.test.js`).

## A RocksDB database's teardown closes every wrapper its loads and declarations opened

A redeclare reuses open wrappers (`internalDbisFor`, `indexFor`). Every wrapper is recorded in `ownedRocksStores` and closed before the root, or `restore_backup` finds the database open (harper#3120). Never close one just because the graph dropped it (`closeLoadedDatabases.test.js`).

## Every `.mdb` under a storage path must open as LMDB

A rescan (`getDatabases`) opens every `.mdb` under the storage paths, and lmdb-js double-frees on a failed open, so a non-LMDB file there segfaults the process (harper#2669).

## A local-only write marks both the record and its audit entry, and replay preserves it

`LOCAL_ONLY` sits in the entry's `extendedType` and the record's flags, so a sender skips by bitmask; `replayLogs.ts` re-derives it from the entry, since replay never re-appends. The row bit follows its latest mutation (`localOnly.test.js`).

## Legacy record-based residency is the listed nodes plus the writer, and a patch over a stub stays a stub

When a local write's residency excludes this node, `_writeUpdate` adds the node and stores the full record. A patch over a stub stays a stub, with the base's `residencyId` (harper#2257; `writerResidency.test.js`).

- **Residency stubs** are projections. Local-only collection reads skip them, and over a stub a computed index's old value is a guess (`updateIndices` `existingIsStub`, harper#2370; `residencyReads.test.js`).

## A read keeps a fetched record as a local replica and never relocates it

Replicas are RocksDB-only. `_storeReplica` keeps a resident's body as an audit-free `REPLICA` row with the stub's identity (harper-pro#436).

- **Admission keeps only the stub's own head write, and only when no later fold can change it** (`answersStub`, `FULL_WRITE_HEAD`, harper#3640). A table written only by patches never caches.
- The deadline lives in `<table>/@replicas`, not `expiresAt`; demotion re-reads it in its own transaction, and `repairReplicaDeadlines` leaves no replica permanent. Demote all replicas before a downgrade (`residencyReplicas.test.js`).

## `replicatedConfirmation` counts only the residents of each written record

A peer acknowledges a database-wide position even for a stub, so `confirmationTarget` counts only each write's owners, resolved before submission (harper-pro#1031; `residencyConfirmation.test.js`).

## Replication confirmation failure means the linked writes committed locally

`replicationUnconfirmed` attests only a local commit, not peer receipt; it is `retryable: false`, since a replay could duplicate committed writes. A nested commit's flag never vouches for an enclosing scope (`withoutReplicationUnconfirmed`; `replicationConfirmationOutcome.test.js`).

## This node's short id is 0, confirmed per audit store

`getIdMappingRecord` always maps this node to 0, so `getThisNodeId` only confirms the mapping and caches it briefly (`thisNodeId.test.js`).

## Query primary-key identity is the stored encoding

`CandidateKeySet` compares keys by store encoding (`writeKeyId`), never joined strings: `['t', 7]` and `'t\0007'` join alike. A primary-key record filter must agree with its id filter (`searchKeyIdentity.test.js`).

## Validation keeps a patch operation and coerces only its operand

`validate` keeps the `{ __op__, value }` envelope, because a bare scalar would turn an increment into an assignment (`validation.test.js`).
