# resources/ — design notes

Invariants the code cannot state, why, and what enforces them; [MAP.md](MAP.md) navigates. Tests: `unitTests/resources/` unless pathed; `#N` refs are harper's.

## Full-text declarations and reader snapshots

Declarations compile to `fullTextIndexes`, never `attributes` (no stored value). One reader lease per search; only an idle reader reloads (`fullTextQueryIndex.test.js`). A native snapshot is not a record snapshot: hydration re-checks versions. Native budgets fix before `startHTTPThreads()`.

## A bare nullish id is never a collection target for `get` or `delete`

`transactional()` 400s a bare `null`/`undefined` id (a bare-null delete once emptied a table). Gaps: `{ id: undefined }`, function-form `defineResource` (`deleteNullResourceApi.test.js`).

## A primitive-id static get skips instance dispatch only behind its gate

`registerPrimitiveIdGet`'s gate checks every hook instance dispatch calls is the original (exact class only). **Add every new instance-get hook to that gate.** Async loads fall back to general dispatch (authorization runs) (`tableGetPrimitiveId.test.js`).

## An audit record carries two clocks; identity is (nodeId, log key), never a version

`AuditRecord.version` drives last-writer-wins and ETags, `txnLogKey` identity and resume cursors; `additionalAuditRefs` finds the head when they diverge.

- `isAuditEntryWrite` is the only identity test; `removeAuditEntry` keeps unknown-identity tombstones.
- `receivedIdentityRefs` holds received identities, never log keys: unaudited, the only re-delivery proof ([receipt rules](receipt-rules.md)). **Never "fix" a log key to the version** (`auditRefKinds.test.js`).
- LMDB merges keep the older version (`noAuditOutOfOrderPatch.test.js`). Duplicates use committed identity; only minted keys mark a retry's own staging (`readsOwnStaging`, `replicatedRetryDuplicate.test.js`).
- RocksDB's watermark stalls at uncommitted entries, so ref walks pass `followingCommittedRef`. Gap: history walks follow one chain (#3977).
- `FULL_WRITE_HEAD`: the head replaced the record and is unchanged since; any other write clears it (`fullWriteHead.test.js`).
- Named-log misses never fall back to `local`; `local` reads filter by `nodeId` (`auditLog.test.js`).
- Equal versions tie only within an origin, else node name orders (`precedesAudited`, `equalVersionOriginOrder.test.js`).
- Replay transactions end at `endTxn` or a log/key change, never key alone (`replayCommitBoundaries.test.js`).

## Request admission authorizes exactly what the dispatch runs

`transactional()` drops client `checkPermission` and gives a QUERY `select` to `allowRead`; only that projection is searched (`permissions.test.js`). In false mode `search`/`query`/`get` await `Table.search`'s `SEARCH_AUTHORIZATION` verdict, so a denial is never a truncated success (`asyncAllowReadSearchResults.test.js`); array PUT, query DELETE and publish take one each (`staticResourceDispatch.ts`). `rowFilter` is rechecked on the materialized record, before `limit`.

## Array PUT is a collection dispatch that settles every element before it fails

Each element gets its own target (`elementTargetFactory`) without `checkPermission` (it would stage as data). `settleElements`, never `Promise.all`, so a slow element cannot leave a partial PUT; the earliest-index error wins. Gap: static-mode classes get the array unguarded (`arrayPutCallerImpact.test.js`).

## Sharding resolves fixed slots through an authoritative database map

- `@sharded` hashes primary keys; `by`/`slotFrom` are test-only (harper-pro#1178). Needs RocksDB, auditing, replication.
- The slot map is never rebuilt from config; map writes serialize on `acquireResidencyMapFence`. `installResidencyMap` imports lazily: an eager import reorders boot.
- `captureResidencyOwners` pins owners for a commit and its retries; replicas never own.
- Quarantines clear only on restart; live holds are retryable (`DatabaseShardingHeldError`) and replay bypasses them.
- `blobReferenceGeneration` fences replica blob reclaim and is never cleared; unverifiable files go to orphan cleanup (`declarativeResidency.test.js`).

## Full PUT resequencing

`_writeUpdate` replays every retained newer patch onto an out-of-order PUT, or skips it. A newer `invalidate` entry is a boundary: test the entry, not the `INVALIDATED` flag. An incomplete walk converges only by full copy (#1148); one with no patches still skips on an `INVALIDATED` head (#3469; `outOfOrderInvalidatedHead.test.js`).

## Database generation and resumable positions

**No readable copy keeps its source's generation; a collection position resumes only in the current generation, with a finite cursor >= the resume floor** (`isResumablePosition`, RocksDB); below the floor a single-record resume needs a complete history walk. Rechecked at each replay yield (pruning raises the floor before deleting); checkpoint only after `resumeVerified`. Gaps: filesystem copies, base-copy back-fill before `reload`, commits below a recorded position (#2928; `databaseGeneration.test.js`).

## Origin-closed timestamp floor

**Nothing appends to `local` below the certified floor `F`** (`originClosedFloor.ts`, harper-pro#922).

- A key is reserved before the first staged write (`reserveLocalKey`), else `RocksTransactionLogStore.put` throws (a logged violation is unrepairable). **Every `local` key is minted**; a caller's value is only the record version (`uniqueLocalLogKeys.test.js`).
- A thread marks its bound pending before minting; samplers raise `proposed` before reading bounds. `localStartBound` never reads a clock (#3599).
- The floor syncs before publication where `syncWal` exists (`originFloorsDurable`). Gaps: power loss without `syncWal`, version-only re-delivery past the walk cap (#1148), older binaries, LMDB.
- Worker bounds retire only on main's `worker.on('exit')`, after its commits drain; notify passes capture `localStartBound` before draining (`subscribeProgress.test.js`).

## Historical record reconstruction (`getRecordAtTime`)

`getRecordAtTime` undoes only patches; past a newer put, delete or invalidate it rebuilds forward (`reconstructForward`): carrying an image back yields a future state (`crdt.test.js`).

## Path routing & parameterised routes

`paramRoutes` sit outside the base map so static routes win. `openApi.ts` and `components/mcp/resources.ts` each convert templates: change both (`paramRoutes.test.js`).

## Persisted relationship catalog

The operations thread loads no schema; `table()` stores `@relationship` targets on the primary descriptor. Only GraphQL replaces them, never over a drop tombstone (`schemaMigrationFragility.test.js`).

## A relationship read is authorized against the related table

`_readDenial` gates relationship steps; search has no general read gate, so REST `allowRead`, `verifyPerms` and `ResourceBridge.getSelect` admit, and nested rechecks need `checkPermission`. Uncovered: subscription delivery, root predicates (#3903) (`permissions.test.js`, `relationshipSelectionReadPermissions.test.js`).

## Typed, discoverable resources

`attributeToSchema` is the one JSON Schema source for MCP and OpenAPI; only `compileVerb` sets `bodyRequired` (`defineResource.test.js`); projections refresh per read (`schemaProjectionInvariants.test.js`).

## Conventions

- **Never remove `transactional()` from a static `Resource` method**: it owns the context's lifetime. It resolves the body before `allow*` (`requestBody.test.js`).
- **A static override owns the whole contract**: it resolves `data` and decides access; no `allow*` runs (`login.ts`).
- Predicates never mutate projection maps (`nestedRelationshipConstraints.test.js`); plain JSON skips resolvers (`searchSelectProjection.test.js`).
- **`relationship.from` accessors are synchronous** (v4 parity: `getSync`, never `get()`; `query.test.js`) and mark the request uncacheable, else a stale ETag 304s (gap: unselected `@enumerable` links).
- **Async query iteration reads related records via `loadEntries`**, checking `getReadTransactionGuard` after each await (`relationshipAsyncReads.test.js`; gaps: `.to` `asArray` on a caching table, #3588; the index switch uses `getSync`).
- **Each AND condition on a to-many relationship is existential**; a `rel[...]` group (`isRelationshipGroup`) binds to one related record. `select()` keeps what an AND matched, never an OR (`relationshipSameRecordGroup.test.js`; gap: #3762).
- **`@relationship(from, to)` joins `related[to] == local[from]`** on every path.
- New `_writeUpdate` early returns follow the blob protocol; new public members go in `TableResourceClass`/`TableResourceInstance` (`_TableResourceMatchesItsDeclaredTypes`).

## RecordObject prototype and entryMap

Each encoder has its own `StoreRecordObject` prototype, so getters stay per table; LMDB promotes before lmdb-js caches (`lmdbPrefetchComputed.test.js`). Test `instanceof RecordObject`, never `entryMap.has`; never copy a record others mutate.

## Struct mode is gated to primary DBIs (downgrade compatibility)

v4 reads struct headers `0x20-0x3f` as integers, so structs in `__dbis__` break a v5→v4 downgrade; `OpenDBIObject` allows them only on primary stores. `RecordEncoder` bails the write hook, **never clears it**: that moves the fixint boundary and the read hook misreads (`recordEncoder.test.js`).

## Non-`initStore` structure saves read inside their own transaction

`saveStructures` on `__dbis__` reads inside its compare-and-put and writes `asBinary`, so `encode` is never re-entered. **Never set `encoder.isRocksDB` on `__dbis__`**: it moves the key and strips byte `0x42` (`recordEncoder.test.js`).

## A patch that creates a record derives its primary key and created time at commit

RocksDB logs only the first attempt, so the commit fills both on every path (`completeCreatedRecord`, `createdTimeBase.test.js`).

## getFromSource() timing: promise resolves before commit runs

The commit encodes the shared record after the fill resolves, so **copy a resolved record before mutating it** (`sourceFillIndexes.test.js`).

## getFromSource() waiters share a fill that stored nothing

Same-thread waiters reuse only a committed, kept, plain-data fill (`isSharableRecord`); a source's `noCacheStore` never shares, a request's only with `noCacheStore` waiters; failures and other threads never share (`sourceFillCoalescing.test.js`).

## getFromSource() keeps source versions separate from fill ordering

A source's `lastModified` caps at local time: the version is the last-writer-wins token. A first fill replaces a raced record only with a strictly greater version; executing-node tie-breaks let replicas diverge at one version. A non-advancing RocksDB version carries `VERSION_REUSED`; renumbering needs a migration (`caching-rocks-database.test.js`). On LMDB one `ifVersion` guards all fill puts (`sourceFillConditionalWrite.test.js`).

## getFromSource() record locks outlive neither their handle nor a close

Closing the owning handle releases the fill's lock (`releaseRecordLock` ignores closed stores); waiters wake on `LOCK_TIMEOUT` (a close notifies no other thread) (`cacheFillClose.test.js`).

## Blob orphan cleanup: pre-saved files outlive cancelled commits

- `write.skipped` is set only when a round staged neither record nor audit entry (#3182).
- Skips clean up after commit, never inline: a retry can make the skipped write win. Abort spares files a durable log or audit entry owns (`blobsAuditReferenced`).
- A deleted file tombstones its `Blob`, so `saveBlob` throws (#2062). `cleanupOrphans` scans every retained audit value: history owns its files.
- `evict()` unlinks only from its own commit (`evictionBlobs.test.js`); an unavailable source blob never aborts a replicated apply (`blob.test.js`).

## Blob compression: policy at `saveBlob`, completeness from the writer lock

**Completeness comes from the writer lock, never the length**, and the header byte is per-file truth. Inflate verifiers settle on `error`/`close` (a `Z_DATA_ERROR` skips the `write` callback); repair never inflates on the event loop (`blobCompression.test.js`).

## Over-time transactions are aborted, not force-committed

`startMonitoringTxns` enforces the open-time limit; code committing a native handle itself opens it raw, never via `getReadTxn`.

- **A write-bearing transaction is aborted and poisoned** (422): a partial force-commit breaks atomicity. Read-only, `sourceApply` and `isReplay` ones force-commit: they cannot resume (harper-pro#348).
- The pre-commit phase gets `COMMIT_PHASE_GRACE` (its writes are sealed). **The monitor never aborts a submitted native commit.**
- **Abort markers let a retry abort a logged handle and dedup trust its log** (#3236; `mustRetryLoggedCommit`); until old logs purge a twin may double-count.
- rocksdb-js's registry is process-global, so only main reports long-lived handles (`longLivedTransactions.test.js`).

## A client disconnect cancels the request's writes

After `context.signal` aborts, `transaction.ts` stages no more of its writes: orphan intents wedge other commits (#2001). Background work uses `contextStorage.exit()` (`contextStorageExit.test.js`). **The point of no return is native submission**: a poison mid-submission aborts nothing (#1407). MQTT carries no signal (`transactionCommitBoundary.test.js`).

## Replication directives are super-user only, gated where they enter

Consumers trust `context.replicateTo`/`replicatedConfirmation`, so only super-user input sets them, checked at entry: `server/REST.ts` (header, 403) and `verifyPerms` (body). **`Table.allow*` cannot enforce this**: false-mode resources skip it (#2898; `replicationDirectiveAuthorization.test.js`). `X-Replicate-From: none` is open by design.

## A read-only server refuses writes at admission

Every write producer passes `DatabaseTransaction.admitRequestWrite()` (405); producers before `addWrite` (`lock()`, `getNewId()`, `addAttributes`, TTL eviction) refuse themselves (`readOnlyModeWrites.test.js`).

## A past-expiry record stays queryable until eviction

Eviction trails expiry (`ttlCleanupInterval.test.js`): search returns expired rows (caching tables' loaded selects refresh); with no source get, get, only-if-cached (504) and subscribe hide them (`isHiddenExpiry`, `onlyIfCachedExpiry.test.js`).

## RocksDB range activity and snapshot expiration

A scan never renews a write holder. The read owner is a symbol (`READ_OWNER`), **not a `WeakMap`**: an ephemeron per transaction costs every scavenge. A released snapshot throws 503 `ReadSnapshotExpiredError`; retry only the read (`rangeReadActivity.test.js`).

## Per-row read work on RocksDB index scans

Cached `getEntry` copies only the options rocksdb-js reads: add new ones there. `coverIndexEntries` answers covered selects without the record, overflow and `-0` keys aside (`indexRangeSelect.test.js`).

## A read reference belongs to the handle acquisition it was taken on

lmdb-js reuses `Txn` objects, so `doneReadTxn(generation)` ignores earlier acquisitions. Gap: `disregardReadTxn()` is unstamped (#3308; `detachedReadRefs.test.js`).

## `getRecordCount`'s estimate is a heuristic, not a bound

The native estimator can undercount (`getRecordCountCallerImpact.test.js`); only `exactCount: true` is exact.

## Auto-increment id ranges are claimed by compare-and-replace

`replaceIdAllocation` writes only if the stored range is unchanged. **Compare the value, never `entry.version`**: the record has none, so a version check always passes (`idAllocation.test.js`).

## Replicated apply failure listeners

**After a terminal apply failure nothing is pulled until every listener is awaited**, keyed by log key, not version. Transports register on every applying worker before delivering. A listener persists outside the source transaction, resolves once durable, is idempotent for `(nodeId, position)` and never awaits the source commit; a failing one never stops the others, a hung one backpressures the source (`replicatedApplyFailure.test.js`).

## Source transactions are delimited per connection, and a transaction log holds one origin

`Table.sourcedFrom` keeps one transaction per `txnStream` token (#1162). Each origin has its own log, keeping keys unique for exact resume. `onFailure` returning true holds the stream; `originFloors` merge only from streams passing it (`sourceTxnStreams.test.js`).

## Repeat writes to the same key in one transaction carry their state forward

No engine refreshes a staged base from a read, so `addWrite` chains same-key writes (`linkWrite`), each taking the prior `stagedEntry`, or indexes keep intermediate values (#1968). The chain key is the store encoding (`writeKeyId`). **Staging order must equal execution order** (#2211); gap: `_writeRelocate` saves eagerly. Publish leaves the record unchanged but still dedups (`publishRecordState.test.js`).

## A tracked instance commits only what it changed, as plain data

`validate` substitutes `collapseChanges(...)`. **A read never becomes a write**: it would beat an older out-of-order patch and, on retry, restore stale state. CRDT operations stay operations (`trackedUpdateCommit.test.js`).

## A delete re-delivered onto its own removal is a no-op

If the same write (origin, log key) emptied the key, `_writeDelete` writes nothing; else each re-delivery appends an entry peers re-forward (harper-pro#826; `replicatedDeleteRedelivery.test.js`).

## `ImmediateTransaction` saves chain on `operation.innerCommit` and forward retries

`ImmediateTransaction.save()` awaits `operation.innerCommit`, else a second write returns early (`recordLock.test.js`). During a retry it forwards to the retried handle, else it recurses (#2825; `immediateTransactionConflictRetry.test.js`).

## A transaction is joinable as a scope only if it stages its writes

A self-committing `ImmediateTransaction` reports `OPEN` with no commit owner. **Join sites ask `isJoinableScope()`, never `OPEN`**: joining one made `transaction()` self-commit each write and skip its abort (#2292; `contextTransactionCallerShapes.test.js`). A spent self-committing link is rebuilt, never reused (#2323); `scopeOwned` is not the test (`releasedSlotScope.test.js`).

## The RocksDB codec is a deployment setting, resolved once per process

`DB::Open` opens column families together, so `getRocksCompression()` freezes one codec; native WAL stays on for root and `__dbis__` (`rocksCompressionOpen.test.js`).

## Schema migration and `runIndexing` internals

`runIndexing` checkpoints only after the writes it covers settle; a failure sets `indexingFailed` (503, never partial). **Set `dbi.isIndexing` on any dbi created mid-build**: `resetDatabases()` reopens tables (`indexBuildAbandonment.test.js`). A `@computed` index rebuilds on `computationChanged` (`requestComputedIndexRepair`; `computedRedeclare.test.js`).

## Cluster-origin table definitions are additive-only

An `origin: 'cluster'` definition is a peer snapshot, so `table()` only adds from it; drops never converge via gossip. `@table` omitting a TTL clears it; `table()` omitting one keeps it (`clusterSchemaMerge.test.js`).

## `drop_attribute` never removes the primary key, and a strip keeps each row's version

`removeAttributes` refuses the primary key (400) before any change (#3574). `stripAttributeValues` keeps each row's version and metadata; a raw `put` drops the metadata prefix (#1762; `stripAttributeValues.test.js`).

## A table is invisible to catalog scans until its create is complete

`table()` writes the primary-key row last, and `initStores` skips tables without one (`createTableCatalogOrder.test.js`).

## A keyless table's bare catalog row names its primary store

A bare `<table>/` row may lack `name` and `isPrimaryKey` (#3225), so use `isPrimaryCatalogRow`; a later-declared key is cleared (`keylessTable.test.js`).

## Per-origin subscription checkpoints

`checkpoint()` encodes one boundary per origin. **If any known origin lacks a qualifying floor, there is no checkpoint.** A floor publishes only after its pass drains; a live certified subscription is `ungated`: the `startTime` gate drops late lower-key commits. Only `updateRecordedSequenceId` writes `[seq, P]` rows (`subscribeCheckpoint.test.js`).

## Subscription version selection

`eventFromAudit` delivers only at the current primary version unless `includeSuperseded`; `currentEntryForAudit` relies on `readAuditEntry` decoding a fresh object per entry (`subscriptionEntryRead.test.js`, `subscriptionLatePatch.test.js`). **Timestamps are no delivery boundary**: commits finish in any order, so the snapshot never advances `startTime`, save an `includeSuperseded` one without progress (`subscriptionLateCommit.test.js`). A `reload` marker closes position-keeping subscribers (410; `reloadMarker.test.js`).

## Audit-store `'committed'` notification batching (`transactionBroadcast.ts`)

**Registration is the delivery boundary**, except a backlog over one batch, a subscribe inside a dispatch, or an entry behind an uncommitted transaction (#2928; `subscriptionRegistrationBoundary.test.js`). Passes never share an iterator and skip a closing store. **The ancestor key walk must strictly shrink** (#2687; `transactionBroadcastKeyWalk.test.js`). **Ending a subscription never reshapes an array a loop walks** (`transactionBroadcastEndDuringDelivery.test.js`).

## `createBlob(readable)` and `table.put()` don't synchronously drain the source

`put` can resolve before the commit saves the blob: finalize source-derived state after `storageInfo.saving` settles.

**On RocksDB a write is encoded before its stream ends**, record and log entry both without the size, and a staged log entry cannot be replaced. So once a commit has waited for a blob `save()` noted as unsized (`blobsAwaitingSize`), it re-stages that handle's writes on a fresh one (`stagedBeforeBlobSizes`, `openReplayTransaction`) and aborts the original unsubmitted. A copy decoded from the first staging is a separate instance: `withRestagedBlobSizes` sizes it by file id, in the re-stage and in the replacement's retry rounds. Blobs a commit does not wait for (nested, or received by a `sourceApply`) stay unsized (`streamedBlobDescriptorSize.test.js`).

## Table drops, the `dropping` tombstone, ghost tables, and lifecycle stamps

Nothing spans column families and catalog rows, so `dropTable()` writes a `dropping` tombstone first; boot (`completeInterruptedDrop`) or a same-name create finishes it. A dead peer generation 409s before any store opens (`isDeadGeneration`). Names with history get a generation suffix (#3102; `dropTableLifecycle.test.js`).

## The exclusive `update-attributes` lock is a bounded synchronous wait

The lock can time out, so `table()` takes it before mutating the live `Table`. **Locked sections stay synchronous**: the wait blocks the event loop (`updateAttributesLock.test.js`).

## RocksDB transaction log purges are database-wide only

Tables share logs and purges delete whole files, so a table-scoped purge is 400 (#2049; `deleteTransactionLogsBeforeRocks.test.js`).

## Boot replay reads bypass the primary-record cache, and replay limits never establish data loss

Replay reads bases with `uncachedRead`: cached WeakRefs kept the backlog alive (#2950). Its guards prove neither durability nor peer completeness: copy and verify before re-cloning (#2951).

## Query-plan range estimation blends statistical estimates by confidence

- **The estimated range is the executed range**: `getRange` and `estimateCount` share `translateIndexBounds` (`searchBooleanFalseIndex.test.js`).
- An AND ignores non-finite legs (`estimateFilterOnlySibling.test.js`; gap: `intersectionEstimate` multiplies `Infinity` into the row hint).
- **Null and omitted values match alike on every path** (`nullOmittedScanFilterParity.test.js`).
- **An AND leads with its narrowest index-driving condition** (`conditionDrivesIndex`). Only a lead in sort order (`scansInAttributeOrder`) streams the sort.

## Chained query conditions scope one array element; FIQL tokens always advance

`a=ge=X&=le=Y` collapses in `prepareConditions` so both paths agree; separate legs match any element (`query-array-scoping.test.js`). Values (not `target` or pattern text) convert to the leaf type (`coerceConditionValue`; `restConditionCoercion.test.js`; #3950). **Every FIQL token must advance** in `parseBlock`, or the regexes loop (`query-parse.test.js`).

## A table declaration lands where the application's `databases` binding points

Branched applications declare via `scopedTableFactory`; branch classes keep the logical name, so schema statics stay refused (`assertSchemaMutable`) and never emit `updateTable` (`branchDatabase.test.js`).

## Ordering an in-memory result set reads each record at most twice

`transformToOrderedSelect` resolves sort keys once per row; the comparator never reads the store (#2675). A content sort reloads a stub (`prepareForSort`), so sorted and unsorted reads match.

## A related-table read uses the related table's own database link

A read transaction belongs to one database, so a related read uses the related table's (`_readTxnForContext`); abandoned post-commit leases are reaped (`crossDatabaseRelationship.test.js`).

## `enc:v1:` env values wait for a registered decryptor and never fail the boot

`loadEnv.ts` defers an encrypted value until a decryptor registers, never exposing ciphertext (`secretDeferredReplay.test.js`).

## Closing an LMDB database closes its environment, never its dbis

Closing a dbi after its environment is a use-after-free, so `closeDatabase` closes only the root, once; only `closed` counts (`lmdbCloseCompletion.test.js`). lmdb-js double-frees on a failed open: **every `.mdb` under the storage paths must be LMDB** (#2669).

## RocksDB teardown closes every wrapper the database opened

Each reused wrapper is recorded in `ownedRocksStores` and closed before the root, or `restore_backup` finds the database open (#3120). Never close one because the graph dropped it (`closeLoadedDatabases.test.js`).

## A local-only write marks its record and audit entry, and replay keeps the mark

`LOCAL_ONLY` sits in the entry's `extendedType` and the record's flags; replay, which never re-appends, re-derives it from the entry (`localOnly.test.js`).

## Legacy residency includes the writer, and a patch over a stub stays a stub

`_writeUpdate` adds this node to a residency that excludes it. A patch over a stub stays a stub (#2257; `writerResidency.test.js`). **Residency stubs** are projections local-only collection reads skip; over one a computed index's old value is a guess (`existingIsStub`, #2370; `residencyReads.test.js`).

## A read keeps a fetched record as a local replica and never relocates it

Replicas are RocksDB-only audit-free `REPLICA` rows with the stub's identity (`_storeReplica`, harper-pro#436). **Admission keeps only the stub's own head write, and only when no later fold can change it** (`answersStub`, #3640). Demote all replicas before a downgrade (`residencyReplicas.test.js`); window and budget bound reclamation (`replicaStorageReclamation.test.js`).

## `replicatedConfirmation` counts only the residents of each written record

Peers acknowledge a position even for a stub, so `confirmationTarget` counts only each write's owners (harper-pro#1031; `residencyConfirmation.test.js`).

## Replication confirmation failure means the linked writes committed locally

`replicationUnconfirmed` is `retryable: false`: the writes committed locally, so a replay could duplicate them. A nested commit's flag never vouches for an enclosing scope (`replicationConfirmationOutcome.test.js`).

## This node's short id is 0, confirmed per audit store

`getIdMappingRecord` maps this node to 0 (`thisNodeId.test.js`).

## Query primary-key identity is the stored encoding

`CandidateKeySet` compares keys by store encoding (`writeKeyId`), never joined strings: `['t', 7]` and `'t\0007'` join alike (`searchKeyIdentity.test.js`).

## Validation keeps a patch operation and coerces only its operand

`validate` keeps the `{ __op__, value }` envelope: a bare scalar turns an increment into an assignment (`validation.test.js`).
