# resources/ — design notes

Rules the `resources/` code cannot state, why each holds, and the symbol and test enforcing it; [MAP.md](MAP.md) is the navigation. Tests are in `unitTests/resources/` unless a path is given.

## Full-text declarations and reader snapshots

Declarations compile to `fullTextIndexes`/`fullTextFields` (`fullTextSchema.ts`), never `attributes`: they hold no stored or selectable value. Write guards ignore reader readiness (`assertFullTextWrite`). One reader lease spans a search; only an idle reader reloads (`#acquireSearchReader`, `fullTextQueryIndex.test.js`). A native snapshot is not a record snapshot, so hydration re-checks source versions. Native budgets are fixed before `startHTTPThreads()`; a worker started before capture fails.

## A bare nullish id is never a collection target for `get` or `delete`

`transactional()` throws a 400 for a bare `null` or `undefined` id; a bare-null delete once removed every record. Gaps: `{ id: undefined }`, function-form `defineResource` (`deleteNullResourceApi.test.js`).

## A primitive-id static get skips instance dispatch only behind its gate

The `registerPrimitiveIdGet` getter shares `loadRecord()` with `_loadRecord`; its gate compares each hook the instance dispatch would call with the original and declines dispatch-changing contexts. **Add every new instance-get hook to that gate.** It matches only the exact class (subclass constructors may have effects); an async load hands its instance back to the general dispatch, so authorization still runs (`tableGetPrimitiveId.test.js`).

## An audit record carries two clocks; identity is (nodeId, log key), never a version

`AuditRecord.version` drives last-writer-wins, `@updatedTime` and ETags; `txnLogKey` drives identity, `auditStore.get(logKey, tableId, id, nodeId)` and resume cursors. When they diverge, `additionalAuditRefs` finds the head.

- `isAuditEntryWrite` is the only identity test; `removeAuditEntry` keeps unknown-identity tombstones, as version compares let one write destroy another's; an unknown predecessor is not origin 0.
- Applied RocksDB writes store their version (`TransactionWrite.recordVersion`) at the origin log key.
- `additionalAuditRefs` holds log keys; `receivedIdentityRefs` (bit 31, `RECEIVED_IDENTITY_REF`) holds received identities (addressing no entry, omitted from audit entries). Unaudited, it is the only re-delivery proof: a commutative patch appends, a body-replacing write restarts it, a listed patch skips before the version comparison. Walks read all non-head branches (log keys never bound versions). `identityIsNotKey` writes record the head as a log-key ref even if key == version. **Never "fix" a log key to the version** (`auditRefKinds.test.js`). [Receipt rules](receipt-rules.md).
- LMDB merges keep the older version (`LMDBTransaction.commit` `ifVersion`, `noAuditOutOfOrderPatch.test.js`).
- Duplicates use committed identity (read outside the txn after a same-key relocate/publish restamps the base); only minted keys mark a retry's own staging (`readsOwnStaging`, `replicatedRetryDuplicate.test.js`).
- RocksDB logs once; the watermark stalls at uncommitted entries, so ref walks pass `followingCommittedRef` and retries/replays add the base head and missed refs (`withRefsMissedByLoggedEntry`). History walks follow one chain and can miss a branch ([#3977](https://github.com/HarperFast/harper/issues/3977)).
- `FULL_WRITE_HEAD`: the head replaced the record, unchanged since; any other write (base-copy frames included) clears it. Older writes skip the walk only if they and `fullWriteHeadKey` >= a known floor (`fullWriteHead.test.js`).
- Numeric log selectors only look up (`useLog` creates); `local` reads filter by `nodeId`, received-key dedup skips unnamed ids, and named-log misses never fall back to `local` (`auditLog.test.js`).
- Equal versions tie (0) only within one origin; others order by node name (named > unnamed), then local id. Only the head's own same-origin entry resolves 0 (`precedesAudited`, `equalVersionOriginOrder.test.js`).
- Replay applies stored versions; replay transactions end at `endTxn` or log/key change (never key alone), dropping truncated frames (`replayCommitBoundaries.test.js`).

## Request admission authorizes exactly what the dispatch runs

- `transactional()` resolves a QUERY body first, drops client `checkPermission`, and hands its `select` to `allowRead`; only the narrowed projection reaches the search (`permissions.test.js`).
- In false mode, `search`, `query` and `get` await `Table.search`'s `SEARCH_AUTHORIZATION` verdict, so a denial cannot become a truncated success; the verdict names its gate, so a transform derived from it is never unwrapped, and the search starts before the transaction settles, keeping its snapshot. Default-mode `get` adds no promise step: `allowRead` was already awaited (`asyncAllowReadSearchResults.test.js`).
- In false mode, array PUT, query DELETE and publish take one verdict each; DELETE scans a private cloned target (`staticResourceDispatch.ts`).
- `rowFilter` is rechecked on the materialized record, and `limit` applies after it.

## Array PUT is a collection dispatch that settles every element before it fails

The synthesized target keeps the collection flag, or the batch is one null-keyed record. Each element gets its own target (`elementTargetFactory`, no `checkPermission`); a context there would be staged as data. Non-objects are refused before dispatch. `settleElements`, not `Promise.all`, lets every element finish, so the transaction cannot unwind under a slow one into a partial PUT; the earliest-index error is reported, no `cause` added. Static-mode classes get the whole array, unguarded (a `null` element is a 500) (`arrayPutCallerImpact.test.js`).

## Sharding resolves fixed slots through an authoritative database map

- Public `@sharded` hashes primary keys; `by`/`slotFrom` need the test switch `replication.experimentalAttributeSlots` plus native abort markers (`unsupportedResidencyPolicy`, harper-pro#1178); on that path a replicable transition outside the new owners needs one new-owner acknowledgement (`requireConnectedResidencyOwner`). RocksDB-only; needs auditing and replication; branches refuse it.
- The slot map (`residencyMaps.ts`) is authoritative, never rebuilt from config; policy and count are fixed after activation (`declareTable`).
- Map writes and activation serialize on a native lock (`acquireResidencyMapFence`, 503 on contention). `installResidencyMap` imports lazily: an eager import reorders boot.
- `captureResidencyOwners` pins owners for a commit and its retries; replicas never own. A LOCAL_ONLY transition excluding the writer is refused before submission, past any catch.
- Main quarantines only classified failures, released only by restart. Live holds are retryable (`DatabaseShardingHeldError`); replay bypasses them, never a quarantine. Only `REPLICATION_APPLY` and crash replay (`isReplay`) fill an incomplete owner (`databaseBaselineHoldReason`).
- `blobReferenceGeneration` fences replica blob reclaim: captured before commit, compared before and after the claim, never cleared. The replica audit walk is capped at 32 reads, then continues after commit as tracked maintenance that yields, stops once maintenance closes and rereads the live row's files before release; files it cannot verify go to orphan cleanup; encoders bump it before checking a claim, and a claimed file returns 503 `BLOB_RECLAMATION_BUSY` (`declarativeResidency.test.js`).

## Full PUT resequencing

`_writeUpdate` replays every retained newer patch onto an out-of-order PUT, or skips the PUT when nothing can be verified; a head newer only by a message is replaced at its version, and a same-transaction restamp is undone first (`identityBase`). A newer `invalidate` entry is a boundary like a put or delete; test the entry, not the `INVALIDATED` flag a patch keeps. An incomplete walk falls back to the per-node merge, converging only by full copy (harper#1148); one with no patches still skips on an `INVALIDATED` head (harper#3469; `outOfOrderInvalidatedHead.test.js`).

## Database generation and resumable positions

**No readable copy keeps its source's generation. A collection position resumes only with the current generation and a finite cursor at or above the resume floor** (`isResumablePosition`, RocksDB only).

- A copy stamps and flushes a new generation before it is readable (`stampDatabaseGeneration`); an open never repairs one. The resume floor never reads below a finite audit floor.
- Cursors are progress-based: a snapshot's newest key can fall below a later floor.
- An open ends earlier handles' subscriptions (`endSubscriptionsFromEarlierHandles`).
- A resume is checked at registration and at each replay yield against the prior check's position (pruning raises the floor before deleting). Read errors, undecodable entries and `reload` markers refuse it; a single-record resume pre-checks only the generation, and a complete history walk overrides the floor (a missing version or the 10,000-version cap refuses; no entry or a first-version end falls back to the floor, since a pruned tombstone takes its history). Checkpoint only after `resumeVerified`. Gaps: filesystem copies, base-copy back-fill before `reload`, commits below a recorded position (harper#2928; `databaseGeneration.test.js`).

## Origin-closed timestamp floor

**Nothing appends to `local` below the certified floor `F`** (`originClosedFloor.ts`, harper-pro#922).

- A key is reserved on its thread before the first staged write (`DatabaseTransaction.save`, `reserveLocalKey`). Otherwise `RocksTransactionLogStore.put` throws: a logged violation is unrepairable.
- A thread marks its bound pending before minting; samplers raise `proposed` before reading bounds, so one side sees the other. Compare-and-swap maxima keep concurrent certifiers safe. `localStartBound` cannot yield, so it uses the carried bound or the floor published before its sample, never a clock (harper#3599).
- **Every `local` key is minted** (`reserve`, `freshKey`). A caller's value is only the record version (`uniqueLocalLogKeys.test.js`).
- The floor syncs before publication where the engine has `syncWal` (`originFloorsDurable`), and the issuance ceiling is persisted before use (`coverLocalIssuance`, `noteIssued`), so a restart seeds keys above both. Gaps: power loss without `syncWal`, version-only re-delivery of a local explicit-timestamp write past the walk cap (harper#1148), older binaries, LMDB.
- A reservation ends only at its handle's terminal settle or an abort. Worker bounds retire only on main's `worker.on('exit')`, after its commits drain.
- `progress()` reports `certifiedThrough`. A notify pass captures `localStartBound` before it drains; a same-thread registry uses its own `threadStartBound`, runs no capture tick and certifies no scalar replay (`subscribeProgress.test.js`).

## Historical record reconstruction (`getRecordAtTime`)

`getRecordAtTime` (`crdt.ts`) undoes only patches. Past a newer put, delete or invalidate it rebuilds forward (`reconstructForward`): carrying an image back returns a future state. A reversed field survives only when the reversal is exact. An unlinked put ends the chain without implying an empty past (`crdt.test.js`).

## Path routing & parameterised routes

Parameterised routes sit outside the base map (`paramRoutes`), so exact and prefix matching stays fast and static routes win (`Resources.getMatch`). Literal > `:param` > `*`; a wildcard is last. `openApi.ts` and `components/mcp/resources.ts` each convert templates, so a syntax change touches both (`paramRoutes.test.js`).

## Persisted relationship catalog

The operations thread loads no schema, so `table()` stores `@relationship` targets on the primary descriptor, which older versions ignore. Only GraphQL (`schemaRelationshipsDefined`) may replace the list. The update holds the `update-attributes` lock and never replaces a drop tombstone (`schemaMigrationFragility.test.js`).

## A relationship read is authorized against the related table

`_readDenial` gates relationship steps/scalar properties. Search has no general read gate: REST `allowRead`, `verifyPerms`, `ResourceBridge.getSelect` admit; nested rechecks require `checkPermission`. Root ops use normalized `attribute`, nested `[0] ?? attribute`. Enumerable `*` rewrites unless `_readableInFull` (per admission/principal); relationship rechecks are unshared. Uncovered: subscription delivery, [root predicates](https://github.com/HarperFast/harper/issues/3903). Tests: `permissions.test.js`, `relationshipSelectionReadPermissions.test.js`.

## Typed, discoverable resources

`attributeToSchema` emits MCP/OpenAPI; contract narrowing requires every verb to validate. Only `compileVerb` sets `bodyRequired` (`defineResource.test.js`).

Contracts keep absent types; metadata infers omitted ones. Primitives retain conditional `properties`/`items`. Projections refresh per read; MCP rebuilds on registration (`schemaProjectionInvariants.test.js`).

## Conventions

- **Never remove `transactional()` from a static `Resource` method**: it owns the context's lifetime. Override instance methods.
- **A static override owns the whole contract.** It resolves or consumes `data` (a promise, or a multipart `AsyncIterable<{ name, value }>` that `super.post` collects) and decides access itself; no `allow*` runs (`login.ts`).
- `transactional()` resolves the body before `allow*` and passes both one object (`requestBody.test.js`).
- Nested relationship constraints share `_prepareRelationshipSelection`. Predicates never mutate projection maps (`nestedRelationshipConstraints.test.js`).
- Only records and relationship targets use a table's resolvers; plain JSON uses resolver-free `nestedSelectTransform` (`searchSelectProjection.test.js`).
- Storage keeps only stored fields (`storedFieldsOnly`); `toJSON` is a projection.
- **`relationship.from` accessors are synchronous** (v4 parity): `getSync`/`getEntry`, never `get()` (`query.test.js`). Resolving one marks the request uncacheable (`markRelatedReadUncacheable`), or a stale ETag yields a 304 (gap: unselected `@enumerable` links resolve in `toJSON` after the ETag).
- **Async query iteration reads related records via `loadEntries`**, picks one or many by `toMany`, and checks `getReadTransactionGuard` after each await; sync iteration reads synchronously (`relationshipAsyncReads.test.js`; gaps: `.to` `asArray` on a caching table can yield Promises, harper#3588, and the adaptive index switch uses `getSync`).
- **Each AND condition on a to-many relationship is existential, whichever leads**; a `rel[...]` group (`isRelationshipGroup`) binds its conditions to one related record, and walkers read them as the related table's (`someConditionPath`, `checkConditionPaths`). `select()` keeps the related records an AND condition matched, never an OR's (`relationshipSameRecordGroup.test.js`; gap: harper#3762).
- **`@relationship(from, to)` joins `related[to] == local[from]`.** The resolver, `joinTo`/`joinFrom`, `transformEntryForSelect` and `filterByType` must agree.
- `updatedAttributes` precompiles expressions before mutating, and retires removed accessors.
- A new `_writeUpdate` early return follows the blob protocol. A new `Table.ts` section starts with `// #section:`.
- A new public table-class member must be mirrored in `TableResourceClass`/`TableResourceInstance`, or `tsc` fails (`_TableResourceMatchesItsDeclaredTypes`).

## RecordObject prototype and entryMap

Each encoder has its own `StoreRecordObject` prototype, so getters stay per table; `entryMap` maps record to entry (`RecordEncoder.ts`). LMDB promotes before lmdb-js caches, since a cached WeakRef target is fixed (`lmdbPrefetchComputed.test.js`). Test with `instanceof RecordObject`, never `entryMap.has`. Never copy a record that other code mutates.

## Struct mode is gated to primary DBIs (downgrade compatibility)

v4 (msgpackr v1) reads struct headers `0x20-0x3f` as integers, so a struct-encoded `__dbis__` breaks a v5→v4 downgrade. `OpenDBIObject` allows structs only on primary stores (opt-in); `databases.ts` forces them on for custom-index object stores. `RecordEncoder` bails the write hook (`_writeStruct = () => 0`), never clears it: clearing moves the fixint boundary, so the read hook would misread `0x20-0x3f`. The read hook stays, and structon's `prepareStructures` saves records-mode structures as the plain array v4 reads (`recordEncoder.test.js`).

## Non-`initStore` structure saves read inside their own transaction

`PrimaryRocksDatabase.open()` binds `encoder.rocksStore` for `__dbis__`, so `saveStructures` reads inside its compare-and-put. It writes `asBinary`, so `putSync` cannot re-enter `encode`. **Never set `encoder.isRocksDB` on `__dbis__`**: it would move the key and strip byte `0x42` (`recordEncoder.test.js`).

## A patch that creates a record derives its primary key and created time at commit

A patch that lands on no record carries neither field, and RocksDB logs only the first attempt. So the commit fills whichever is missing, on every path (`completeCreatedRecord`, `createdTimeBase.test.js`).

## getFromSource() timing: promise resolves before commit runs

A fill resolves before its commit, which encodes the shared record as it is then. **Copy a resolved record before mutating it**, as `finalizeResponse` does. The commit builds its own `recordToStore` and decides residency before `updateIndices` (`sourceFillIndexes.test.js`).

## getFromSource() waiters share a fill that stored nothing

A same-thread waiter reuses the leader's fill only if it committed and kept its write, is plain data (`isSharableRecord`) and the source did not set `noCacheStore`; a request-level `noCacheStore` fill (`unstoredRecord`) shares only with `noCacheStore` waiters; failures and other threads never share (`sourceFillCoalescing.test.js`).

## getFromSource() keeps source versions separate from fill ordering

- A source's `lastModified` is capped at local time: the version is also the last-writer-wins token, so a future-dated source would make local writes look stale.
- A first fill replaces a raced record only with a strictly greater version. `precedesExistingVersion()` breaks ties by executing node, letting replicas diverge at one version.
- A non-advancing RocksDB version carries `VERSION_REUSED` (persisted bit `0x10000`), which rocksdb-js will not vouch for; renumbering needs a migration (`caching-rocks-database.test.js`).
- Fill puts carry no condition of their own; on LMDB one `ifVersion` block guards primary, index and audit puts (`sourceFillConditionalWrite.test.js`).

## getFromSource() record locks outlive neither their handle nor a close

Closing the owning handle releases a fill's lock, so `releaseRecordLock` ignores an unlock on a closed store. Waiters also wake on `LOCK_TIMEOUT`: a close never notifies another thread (`cacheFillClose.test.js`).

## Blob orphan cleanup: pre-saved files outlive cancelled commits

Pre-commit blob files land before a commit that can still skip the write.

- A commit handler resets `write.skipped` each round and sets it only when the round staged neither record nor audit entry (an audit-only `auditRecordToStore` entry is not a skip). Skips: duplicate tie; newer put; losing no-audit full update; no-audit patch tying the head, meeting a recordless head, already received or keeping nothing; losing invalidate, relocate or delete; source version change. A skipped write's `replicatedConfirmation` falls back to the stored version (harper#3182).
- Skips are cleaned after commit, never inline: a retry can make the skipped write win. Abort cleans all but files a durable log or audit entry owns (`abortedWithoutLog`, `blobsAuditReferenced`) and writes of another in-flight handle.
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

`startMonitoringTxns` acts past `STORAGE_MAXTRANSACTIONOPENTIME`. Code committing a native handle itself opens it raw, never via a wrapper's `getReadTxn`: the wrapper would stay tracked, and its retry would resolve `RETRY_NOW`, not reject with `ERR_BUSY`.

- **A write-bearing transaction is aborted and poisoned** (422 `transactionOpenTooLongError`): force-committing a partial write set breaks atomicity. `hasPendingWrites()` walks `next`.
- Read-only, `sourceApply` and `isReplay` transactions are force-committed: sources and replay cannot resume, so an abort drops a write the cursor passed (harper-pro#348).
- The owner's commit chains on `monitorCommit`. The pre-commit phase is spared `COMMIT_PHASE_GRACE` ticks (`sourceApply`/`isReplay` without limit): its writes are sealed, and poisoning there once reported success after unlinking blobs.
- After the pre-commit await, the commit rechecks liveness or resolves as a phantom. **The monitor never aborts a submitted native commit.**
- `timeoutBudget` is a sticky floor chained links inherit.
- Conflict retries get one deadline per logical commit (503 `TransactionCommitConflictTimeoutError`); the per-attempt clock (`trackOutstandingCommit`) drives `checkOverloaded()` shedding.
- **Abort markers let a retry abort a logged handle and dedup trust its log** (harper#3236; `mustRetryLoggedCommit`, `mayReadOwnOrphan`); until old log files purge (~3d after a restart) a twin may double-count. Re-logging restamps record times (`stampRecordTimes`).
- Each hop of a sealed commit cascade gets a full idle window, not the last hop's remainder (`renewChainForNativeCommit`).
- Long-lived handles are reported from main only: rocksdb-js's registry is process-global (`runLongLivedTransactionSweep`, past `storage.longTransactionReportThreshold`); workers attribute their own by the same id (`reportIfLongLived`). Stuck-commit logs list holders from every database regardless of age: the verification table is one process-wide array (`longLivedTransactions.test.js`).

## A client disconnect cancels the request's writes

`context.signal` is the request's lifetime: after it aborts, `transaction.ts` stages no more writes on that context (harper#2001), since an orphan's intents wedge other commits. Work outliving the client uses a signal-free context; background work arms via `contextStorage.exit()`, which is `run(undefined)` because native `exit()` only disables storage (`contextStorageExit.test.js`).

- `admitRequestWrite()` reads the signal at the first write; a read-only request creates none.
- **The point of no return is native submission.** A poison mid-submission aborts nothing; the chain's remaining stores follow (#1407).
- `closeOwnedReadIterators()` closes unreachable iterators, and an abandoned scope keeps its handle (`abandonScope()`). MQTT carries no signal (`transactionCommitBoundary.test.js`).

## Replication directives are super-user only, gated where they enter

Consumers trust `context.replicateTo`/`replicatedConfirmation`, set by applications for any user, so only a super user's input may set them, checked at entry: the header in `server/REST.ts` (403 on any method; a custom `get` can write) and body fields in `verifyPerms`. **`Table.allow*` cannot enforce this**: false-mode resources skip it and applications override it (harper#2898; `replicationDirectiveAuthorization.test.js`). `X-Replicate-From: none` stays open to everyone by design.

## A read-only server refuses writes at admission

A read-only process stages no writes: every producer passes `DatabaseTransaction.admitRequestWrite()` (405). `transactional()` refuses table writes early, never `post`, `publish`, `copy` or `move`. Producers running before `addWrite` refuse themselves: `lock()`, numeric `getNewId()`, `addAttributes` and TTL eviction (`readOnlyModeWrites.test.js`).

## A past-expiry record stays queryable until eviction

Eviction (`scheduleCleanup`) trails expiry (`ttlCleanupInterval.test.js`). Search returns expired rows as stored (covered selects too); a caching table's loaded select refreshes unless only-if-cached or `includeExpired` (SQL). With no source get, get, only-if-cached (504), subscribe and `withLocalEntry` (no `ETag`) hide it (`isHiddenExpiry`). Expiry resolves at commit (option, context, field, default); out-of-order writes keep their base's expiry (`onlyIfCachedExpiry.test.js`).

## RocksDB range activity and snapshot expiration

`trackReadRange` records each `next()`, but a scan never renews a write holder. The read owner is a symbol property (`READ_OWNER`), **not a `WeakMap`**: a per-transaction ephemeron costs every scavenge (GC time per GET rose). Resuming past a released snapshot throws a 503 `ReadSnapshotExpiredError`; retry only the read. `snapshot: false` pins no snapshot (`rangeReadActivity.test.js`).

## Per-row read work on RocksDB index scans

RocksDB index rows store `null`, so `RocksIndexStore.getRange` reads keys only. A cached `PrimaryRocksDatabase.getEntry` passes a fresh literal, not caller options (`uncachedRead` forwards it); add options there. `coverIndexEntries` reads no record (overflow and `-0` keys aside), covering `SCALAR_TYPES` and untyped/`ID` PKs; unvalidated values (`Date`/`BigInt` ints still decode) and untyped/`ID` `[x]` or bigint ids keep index form (`indexRangeSelect.test.js`).

## A read reference belongs to the handle acquisition it was taken on

`doneReadTxn(generation)` ignores returns from earlier acquisitions: lmdb-js reuses the `Txn` object. Gap: `disregardReadTxn()` is unstamped (harper#3308; `detachedReadRefs.test.js`).

## `getRecordCount`'s estimate is a heuristic, not a bound

`estimatedRange`'s upper end comes from the native estimator and can undercount (`getRecordCountCallerImpact.test.js`). Only `exactCount: true` is exact. An untrusted store answer degrades, never poisons, it (`usableCount`).

## Auto-increment id ranges are claimed by compare-and-replace

`replaceIdAllocation` (`getNewId`) writes only if the stored range equals the one it read. **Compare the value, never `entry.version`**: the record has no version, so a version check always passes (`idAllocation.test.js`).

## Replicated apply failure listeners

**After a terminal apply failure, nothing is pulled until every listener has been awaited** with the origin and position (log key, not version). A transport registers on every applying worker before delivering. A listener runs and persists outside the source transaction, resolves only once durable, and is idempotent for `(nodeId, position)`. Registration replays nothing, a listener never waits for the source commit, and the transport owns recovery when one cannot persist. A failing listener never stops the others (`notifyReplicatedApplyFailure`); a hung one backpressures the source (`replicatedApplyFailure.test.js`).

## Source transactions are delimited per connection, and a transaction log holds one origin

- `Table.sourcedFrom` keeps one transaction per `txnStream` token: connections share the subscription and yield mid-frame (harper#1162).
- `RocksTransactionLogStore.put` files each origin in its own log, so keys stay unique per log; exact resume depends on that.
- `onFailure` returning true holds the stream (no cursor moves) while the source replays; held failures skip the listeners.
- `originFloors` merge only from tagged streams passing `onFailure`, since resume trusts them (`sourceTxnStreams.test.js`).

## Repeat writes to the same key in one transaction carry their state forward

`linkWrite` chains staged state through `priorStagedWrite()`; reads cannot refresh it (harper#1968). Newer versions merge out of order; order breaks ties. `writeKeyId` uses store encoding: `1n`/`1` chain; `[0]`/`[-0]` do not.

- **Operations execute in staging order** (harper#2211): `chainsStagedState` defers behind predecessors; `save()` drains them. Gap: `_writeRelocate` saves eagerly.
- `#mergeableWrite` edits one unvalidated node at its first position, like `set()`; `mergeUpdateChanges` coerces adds and rejects invalid replacement patches. Replacement mode stays; `addWrite` admits once (`deferredWriteLifecycle.test.js`).
- Refusal keeps its generation; `#saveOperation` reattaches live writes; failed staging requires `update()`.
- `_writePublish` stages the unchanged record, preserving re-delivery dedup (`publishRecordState.test.js`).

## A tracked instance commits only what it changed, as plain data

Reads cache tracked wrappers in the changes, so `validate` substitutes `collapseChanges(...)` (`tracked.ts`), the one patch every consumer reads. **A read never becomes a write**: it would beat an older out-of-order patch and, on retry, restore stale state. CRDT operations stay operations; `addTo` composes. `hasOwnChange` is the single own-property test (`trackedUpdateCommit.test.js`).

## A delete re-delivered onto its own removal is a no-op

If this same write (origin and log key) emptied the key, `_writeDelete` writes nothing but stages the removal; otherwise each re-delivery appends an entry peers forward again. `stagedEntry` carries `localTime` and `nodeId` for `removalBefore` (harper-pro#826; `replicatedDeleteRedelivery.test.js`).

## `ImmediateTransaction` saves chain on `operation.innerCommit` and forward retries

- A second write outside `transaction()` commits through a nested `commit()` stored on `operation.innerCommit`. `ImmediateTransaction.save()` must await it, or the write returns before it is durable (`recordLock.test.js`).
- During a retry, `save()` forwards to the retried handle; otherwise it would nest and recurse (harper#2825). A failed re-save releases the detached handle before `abort()` (`immediateTransactionConflictRetry.test.js`).

## A transaction is joinable as a scope only if it stages its writes

`txnForContext` installs a self-committing `ImmediateTransaction` in an empty or `RELEASED_TRANSACTION` slot; it reports `OPEN`, but nothing owns its commit. **Join sites ask `isJoinableScope()`, never `OPEN`**: joining it made `transaction()` self-commit each write and skip its abort (harper#2292).

- A finished scope leaves `RELEASED_TRANSACTION` behind (`contextTransactionCallerShapes.test.js`).
- A joinable scope takes over deferred writes (`detachWrite`), since commit paths read only `writes`, but never from a `sourceApply`, `isReplay` or finished holder, nor on LMDB (`stagesWriteOnSave`). A spent self-committing link is rebuilt, never reused (harper#2323).
- `scopeOwned` is deliberately not the test (`releasedSlotScope.test.js`).

## The RocksDB codec is a deployment setting, resolved once per process

`DB::Open` opens families together, so `getRocksCompression()` freezes one codec; `compressionForAllColumnFamilies` applies it, ignoring per-table `compression`. Install stages the full config with `stageInstallConfig()` before `mountHdb()`, validates before `createTables()`, and persists it without worker overrides. Existing files retain codecs until rewritten (`compact({ bottommost: true })`). Native WAL stays on for root and `__dbis__` (`rocksCompressionOpen.test.js`).

## Schema migration and `runIndexing` internals

`runIndexing` (`databases.ts`) checkpoints (`lastIndexedKey`) only after the writes it covers settle and resumes only a matching certification; a failure sets `indexingFailed` (503, never partial). **Set `dbi.isIndexing` on any dbi created mid-build**: `resetDatabases()` reopens tables (`indexBuildAbandonment.test.js`). A `@computed` index rebuilds on `computationChanged` (a function `from` by `computedFromHash`); a resolver the catalog lacks certifies rows only as `RESOLVED_CHECKPOINT_ALGORITHM` (`requestComputedIndexRepair`; `computedRedeclare.test.js`).

## Cluster-origin table definitions are additive-only

An `origin: 'cluster'` definition is a peer snapshot, so `table()` only adds from it and logs what it discards. Drops and redefinitions never converge via gossip (recover via local `create_attribute` or redeploy). Abandoned index builds still recover (`clusterSchemaMerge.test.js`). A reload keeps a thread's own TTL. `@table` omitting a TTL clears it (`null`); `table()` omitting one keeps it.

## `drop_attribute` never removes the primary key, and a strip keeps each row's version

`removeAttributes` refuses the primary key (400) before any change (harper#3574). `stripAttributeValues` rewrites rows audit-off, keeping version and metadata (`VERSION_REUSED`). A raw `put` would drop the metadata prefix (harper#1762; `stripAttributeValues.test.js`).

## A table is invisible to catalog scans until its create is complete

`table()` writes the primary-key row last, under the lock, and `initStores` skips a table without one; a scan mid-create once announced a partial table (`createTableCatalogOrder.test.js`).

## A keyless table's bare catalog row names its primary store

A bare `<table>/` row can lack both `name` and `isPrimaryKey` (harper#3225), so primary-store selection uses `isPrimaryCatalogRow`. A key declared later cannot re-key records, so `table()` clears it (`keylessTable.test.js`).

## Per-origin subscription checkpoints

`checkpoint()` (`subscriptionCheckpoint.ts`) encodes a boundary per origin; lowering one only adds duplicates. **If any known origin lacks a qualifying floor, there is no checkpoint.**

- A floor publishes only after the pass that captured it drains cleanly (`passCapture`).
- `admitCheckpoint` is rechecked at each yield against `readOriginStateEpoch`.
- A live certified subscription is `ungated`: the `startTime` gate would drop a late lower-key commit.
- Only an origin's direct route sets its current generation; floors never order generations.
- `updateRecordedSequenceId` is the only writer of a `[seq, P]` row. An audit-less copy writes its bounds (`writeCopyBounds`) before the copied rows; they void older routes (`subscribeCheckpoint.test.js`).

## Subscription version selection

`eventFromAudit` delivers a mutation only at the current primary version, unless `includeSuperseded` is set. `currentEntryForAudit` reads it once per audit record, safe only because `readAuditEntry` decodes a fresh object per entry (`subscriptionEntryRead.test.js`).

- An out-of-order fold delivers the current state (`subscriptionLatePatch.test.js`).
- **Timestamps are no delivery boundary** (commits finish in any order): the snapshot never advances `startTime`, save an `includeSuperseded` subscriber without progress, which gates on the scan's highest log key (`subscriptionLateCommit.test.js`).
- A `reload` marker closes position-keeping subscribers (410) and re-snapshots the rest (`reloadMarker.test.js`).

## Audit-store `'committed'` notification batching (`transactionBroadcast.ts`)

- **Registration is the delivery boundary**: a subscriber sees only what commits after it registers, except a backlog over one batch, a subscribe inside a dispatch, or an entry behind a still-uncommitted transaction (harper#2928). With none (`activeCount`), a pass does not iterate (`subscriptionRegistrationBoundary.test.js`).
- `notifyScheduled` spans yields, so passes never share an iterator; the same-thread path holds a lock and never yields.
- A pass skips a closing store, because LMDB emits `'committed'` inside `close()`.
- **The ancestor key walk must strictly shrink** (harper#2687; `transactionBroadcastKeyWalk.test.js`).
- **Ending a subscription never reshapes an array a loop is walking.** The last traversal compacts it (`transactionBroadcastEndDuringDelivery.test.js`).
- `IterableEventQueue.close(finalMessage)` always finishes, then rethrows.

## `createBlob(readable)` and `table.put()` don't synchronously drain the source

The commit waits for a fresh local blob (`startPreCommitBlobsForRecord`), but `put` can resolve before it runs. Finalize anything derived from the source after `storageInfo.saving` settles, as `deploymentRecorder.ts` does.

## Table drops, the `dropping` tombstone, ghost tables, and lifecycle stamps

Nothing spans a table's column families and catalog rows, so `dropTable()` writes a `dropping` tombstone first; boot (`completeInterruptedDrop`) or a same-name create finishes it.

- Rows carry `createdTime`; a drop records `droppedTime` in `/dropped/<table>`; `isDeadGeneration` is strict. An untimed drop never gets a time later, which could postdate a peer's recreate.
- Checks run under the row-publishing lock: a dead peer generation is a 409 before any store opens; a peer drop spares `replicate: false` and needs `REPLICATED_FROM`.
- A name with history gets a generation suffix (harper#3102). Reclamation spares live stores (`dropTableLifecycle.test.js`).

## The exclusive `update-attributes` lock is a bounded synchronous wait

`acquireUpdateAttributesLock` can time out, so `table()` locks before mutating the live `Table`. **Locked sections stay synchronous**: the wait blocks the event loop. Release is structural (`withUpdateAttributesLock`; `updateAttributesLock.test.js`).

## RocksDB transaction log purges are database-wide only

Tables share their database's logs and purges delete whole files, so `deleteTransactionLogsBefore` returns 400 for a table-scoped purge, 404 for a missing table (harper#2049); presence uses `!= null` (`deleteTransactionLogsBeforeRocks.test.js`).

## Boot replay reads bypass the primary-record cache, and replay limits never establish data loss

Replay reads bases with `uncachedRead`: cached WeakRefs outlived the replay, keeping the backlog alive (harper#2950). Its guards cannot prove durability or peer completeness, so they advise copying the database and verifying peers before re-cloning (harper#2951).

## Query-plan range estimation blends statistical estimates by confidence

- Store estimates are feature-detected and validated (`estimateRangeCondition`).
- **The estimated range is the executed range**: `getRange` and `estimateCount` share `translateIndexBounds`.
- Secondary-index scans open at `null` exclusive; primary scans at `true`, past symbol-keyed metadata (`searchBooleanFalseIndex.test.js`).
- A negated condition estimates `Infinity`; an AND's estimate ignores non-finite legs (`estimateConditionForTable`, `estimateFilterOnlySibling.test.js`; gap: `intersectionEstimate` multiplies `Infinity` into the incoming-row hint).
- **Null and omitted values match alike on every path** (`nullOmittedScanFilterParity.test.js`): no range matches them; a `null` lower bound opens it; a non-null `ne` matches them (and an array with any differing element), so it reads the primary store (`bypassesSecondaryIndex`); SQL leaves a range against NULL residual.
- **An AND leads with its narrowest condition that can drive an index scan** (`orderConditions`, `conditionDrivesIndex`), because `in`, an empty `starts_with` and unindexed ranges estimate finite counts (for `count: 'estimated'` and the lazy index switch) yet full-scan. A relationship drives only if each hop's join index and leaf scan can run (`relationshipScanRuns`). Only a lead reading the sort attribute's index (`scansInAttributeOrder`) streams the sort and keeps the lead.

## Chained query conditions scope one array element; FIQL tokens always advance

- `a=ge=X&=le=Y` collapses in `prepareConditions` so both paths agree; separate legs match any element; other chains 400. Array ranges dedupe (`distinctRecords`; `query-array-scoping.test.js`).
- Values (not `target` or pattern text) convert to leaf/element type (`''`→`null` bar `String`/`Any`; `Any` & untyped coercing ops `autoCast`, so numeric/bool/date text in `[Any]`/`Any` misses `=`), chains too (`coerceConditionValue`; `restConditionCoercion.test.js`; harper#3950).
- In `parseBlock`, a pending condition makes next token a value; only group end picks tokenizer. **Every token must advance**: 0-length match errors or regexes loop (`query-parse.test.js`).

## A table declaration lands where the application's `databases` binding points

`table()` is `declareTable` on the global target; branched applications declare through `scopedTableFactory`. A branch root's `databaseName` is filled only when unset (`??=`); branch classes keep the logical name, so schema statics stay refused (`assertSchemaMutable`), and never emit `updateTable` (`branchDatabase.test.js`).

## Ordering an in-memory result set reads each record at most twice

`transformToOrderedSelect` resolves sort keys once per row before sorting; the comparator never reads the store (harper#2675). Vector distances are cached per sort clause. A stub is kept unless a filter lacks a `keyPredicate`; a content sort reloads it (`prepareForSort`), so sorted and unsorted reads match.

## A related-table read uses the related table's own database link

A read transaction belongs to one database, so a related read uses the related table's (`_readTxnForContext`); a post-commit join leases it (`leaseRelatedReadTxn`). Renewals are not activity, so abandoned leases are reaped (`crossDatabaseRelationship.test.js`).

## `enc:v1:` env values wait for a registered decryptor and never fail the boot

`loadEnv.ts` defers an encrypted value until a decryptor registers (`deferEncryptedEnvValue`), then replays it, never exposing ciphertext (`secretDeferredReplay.test.js`).

## Closing an LMDB database closes its environment, never its dbis

Closing a dbi after its environment is a use-after-free, so `closeDatabase` closes only the LMDB root, once. Only `closed` counts; lmdb-js resolves `close()` early during a read (`lmdbCloseCompletion.test.js`). A rescan (`getDatabases`) opens every `.mdb` under the storage paths, and lmdb-js double-frees on a failed open, so **every `.mdb` there must be LMDB** (harper#2669).

## RocksDB teardown closes every wrapper the database opened

A redeclare reuses open wrappers (`internalDbisFor`, `indexFor`); each is recorded in `ownedRocksStores` and closed before the root, or `restore_backup` finds the database open (harper#3120). Never close one because the graph dropped it (`closeLoadedDatabases.test.js`).

## A local-only write marks its record and audit entry, and replay keeps the mark

`LOCAL_ONLY` sits in the entry's `extendedType` and the record's flags, so a sender skips by bitmask; `replayLogs.ts` re-derives it from the entry, since replay never re-appends. The row bit follows its latest mutation (`localOnly.test.js`).

## Legacy residency includes the writer, and a patch over a stub stays a stub

If a local write's residency excludes this node, `_writeUpdate` adds it and stores the full record. A patch over a stub stays a stub, with the base's `residencyId` (harper#2257; `writerResidency.test.js`).

- **Residency stubs** are projections. Local-only collection reads skip them, and over a stub a computed index's old value is a guess (`updateIndices` `existingIsStub`, harper#2370; `residencyReads.test.js`).

## A read keeps a fetched record as a local replica and never relocates it

Replicas are RocksDB-only. `_storeReplica` keeps a resident's body as an audit-free `REPLICA` row with the stub's identity (harper-pro#436).

- **Admission keeps only the stub's own head write, and only when no later fold can change it** (`answersStub`, `FULL_WRITE_HEAD`, harper#3640). A table written only by patches never caches.
- The deadline lives in `<table>/@replicas`, not `expiresAt`; demotion re-reads it in its own transaction, and `repairReplicaDeadlines` leaves no replica permanent. Demote all replicas before a downgrade (`residencyReplicas.test.js`).
- A pressure pass (`reclaimReplicaSpace`) frees no disk until compaction, so its window and budget bound it, not the priority (`replicaStorageReclamation.test.js`).

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
