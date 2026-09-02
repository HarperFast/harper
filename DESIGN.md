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

## Version gate at startup: downgrades prompt, and only the minor direction is confirmable

`getVersionUpdateInfo()` (`dataLayer/hdbInfoController.ts`) compares the store's `data_version_num` (latest `system.hdb_info` record) against the binary's `packageJson.version` on every start. Data newer than binary by a **major** version → hard refusal. Newer by a **minor** version → `forceDowngradePrompt()` asks for confirmation; answering yes records the data version back down to the binary's version and boots (upgrade directives are deliberately additive/downgrade-compatible — see the struct-mode section above and `patchHdbSecretIsHashAttribute` in `upgrade/directives/5-2-0.ts`).

- The prompt's answer can be supplied non-interactively via `CONFIRM_DOWNGRADE` — env var or `--CONFIRM_DOWNGRADE` CLI arg; argv wins (`assignCMDENVVariables`). With no override and no TTY on stdin, the prompt throws instead of blocking on stdin forever (#2046 — services/CI hung with nothing in the log; the mismatch is also logged to hdb.log now).
- Upgrades never prompt (see the rationale comment in `bin/upgrade.js`); only the downgrade direction confirms. `upgradeCertsPrompt()` on the 4.x upgrade path still has the block-on-stdin hazard.
- Test-suite gotcha: a suite that supplies the override via `process.argv` affects every later test file in the same mocha process — save and restore `process.argv` in `before`/`after` (see `unitTests/dataLayer/hdbInfoController.test.js`).

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
and carries `VERSION_NOT_UNIQUE_FLAG`; rocksdb-js 2.8.0 ([#766](https://github.com/HarperFast/rocksdb-js/pull/766))
then refuses to publish or confirm that version through the VerificationTable. This avoids inventing
an epsilon timestamp solely to force replacement while keeping stale record-cache values from being
vouched as fresh.

The flag is also applied to ordinary resequenced RocksDB writes. Those records remain ineligible for
VerificationTable fast-path confirmation until a later write advances their version.

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

## Over-time transactions are aborted, not force-committed (`DatabaseTransaction`/`LMDBTransaction`)

`startMonitoringTxns()` (a `setInterval` per engine) watches `trackedTxns` and acts when a transaction's `timeout` reaches 0 (after ~2 ticks of `STORAGE_MAXTRANSACTIONOPENTIME`, default 30s). A transaction is tracked once it acquires a read snapshot (`getReadTxn`).

- **Write-bearing request transactions are aborted and poisoned** (issue #1407). The monitor calls `abortDueToTimeout()`, which sets `timedOut`, forces `open = CLOSED` (so `doneReadTxn` takes the discard path instead of re-entering `commit()` via the `LINGERING` branch — which would now throw), then `abort()`s. `addWrite`/`commit` both guard on `timedOut` and throw `transactionOpenTooLongError` (503), so the in-flight request rolls back cleanly rather than the monitor silently force-committing a partial write set (atomicity violation + orphaned secondary-index entries that only a full rebuild repairs). The old behavior `commit()`d and reused the still-open transaction.
- **`hasPendingWrites()` walks the `next` chain.** Writes to a second database live on `transaction.next` (see `txnForContext`), so a transaction that reads database A (head, tracked via its read snapshot, empty `writes`) and writes database B (`next`) is still write-bearing. Without the walk the head looks read-only and the monitor's force-commit path would cascade-commit B. `abortDueToTimeout()` poisons + aborts the whole chain.
- **Read-only, `sourceApply`, and `isReplay` transactions keep the prior force-commit behavior.** Read-only long transactions (large scans/exports) have no atomicity/index risk and must not have their ongoing reads poisoned. Canonical-source applies (replication peer / external caching source) and crash-recovery replay have no resubscribe/resume path: aborting a write would drop it while the resume cursor advances past it — a permanent divergence (harper-pro#348). `sourceApply` is propagated down the `next` chain in `txnForContext`, so gating on the head suffices. (Replay is additionally synchronous, so the async monitor can't fire mid-replay anyway.)

- **A transaction parked in its commit phase is spared, not poisoned** (issue #2062). `commit()` sets `committing` around its pre-commit await (the `before`/`beforeIntermediate` completions — in practice a blob's durable file write) and the monitor logs instead of aborting while it is set. The limit polices an _application_ holding a transaction open with an unfinished write set; once `commit()` is entered the write set is sealed and the caller is awaiting the commit, so the time is core's own I/O, and a multi-tens-of-MB deploy payload legitimately outruns the limit. Poisoning there was actively destructive: `abort()` cleared the write set and unlinked the write's pre-saved blobs, and the resumed commit then found nothing to write and resolved as **success** — the caller was told its write landed, and was left holding a blob whose file was gone but whose `fileId` was still set, so its next `put` silently minted a reference to a destroyed file (the deploy-payload case: `Blob file not found` on the peer, unrecoverably). The grace is bounded — `COMMIT_PHASE_GRACE` over-limit ticks, ~10 min at the 30s default, since sparing re-arms `timeout` — because the transaction still pins a read snapshot; a source that stalls rather than finishing falls through to the normal abort. `sourceApply`/`isReplay` are spared without a bound: they may be neither aborted (harper-pro#348) nor force-committed mid-write (that would durably commit a replica record whose blob file is still being written), and their blob sources are bounded by the receive-side idle watchdog instead.
- **Resuming from that await re-checks that the transaction is still alive.** `timedOut` (monitor poison, including via the `next` chain) throws `transactionOpenTooLongError`; a write set cleared with the handle released — a plain `abort()` in the same window — throws `Transaction was aborted while its commit was waiting on pre-commit work`. Without both, either path resolves as a phantom commit. `LMDBTransaction.commit` carries the same pair around its own `before` phase.

**Extending the budget for one known-long write:** `DatabaseTransaction.timeoutBudget` is a per-transaction RocksDB floor applied whenever the transaction is re-armed (initial reads, writes, and active multi-store-chain propagation); the effective timeout is `Math.max(txnExpiration, timeoutBudget)`. This makes the budget sticky across a write's pre-commit existing-entry read and later writes, while never shortening a larger global `STORAGE_MAXTRANSACTIONOPENTIME`; RocksDB links added for another store inherit the same floor. Reads after a pending write do not re-arm the transaction: that preserves the idle-limit invariant for orphaned write-holding requests. Also, `resources/transaction.ts`'s `transaction(callback)` (no explicit context) joins whatever transaction is already open on the ambient AsyncLocalStorage context rather than guaranteeing a fresh one. `components/deploymentRecorder.ts`'s `withIsolatedTransaction` builds a new context from only the ambient audit/session/cancellation fields, so every recorder write commits independently without inheriting transaction controls. It uses the sticky budget to give `ingestPayload`'s blob-gated writes a size-appropriate limit instead of the generic default, while coalesced progress flushes are drained and suppressed until ingest settles to avoid same-row transaction conflicts. The ingest helper deliberately floors the shared `deployment_timeout` at ten minutes because `0` means “poll once” for peer waits; consequently an ingest can pin its system-database snapshot for that minimum. Known gap (harper#2057): the extension only reaches RocksDB transactions — on `HARPER_STORAGE_ENGINE=lmdb`, `Table.txnForContext()` chains a separate `LMDBTransaction` (`txn.next`) with its own independently-reset timeout that the LMDB engine's monitor tracks instead.

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

Both orders are now pinned. `addWrite` defers a write whose earlier same-key write has not run yet, but **only for writes that both consume `priorStagedWrite()` and publish `stagedEntry`** — marked `chainsStagedState`, today just the delete write. `_writeInvalidate`/`_writeRelocate`/`_writePublish` do neither, so reordering them past a staged put would hand them a pre-transaction basis they have no way to correct; they keep their eager save. And the apply loop's `stageWrite` chains the writes to any one key through a per-transaction map so staging order is arrival order, dropping settled entries (a bulk transaction retains one entry per in-flight write, not per record) and short-circuiting successors when a predecessor rejects. LMDB was never exposed: `LMDBTransaction.addWrite` defers every write and has always executed them in `this.writes` order.

Two consequences of that scoping are worth knowing, both pre-existing and neither closed by the ordering fix. `_writeRelocate` still saves eagerly, so a replicated `put K; relocate K` where the residency list excludes this host strips K to its indexed-attribute stub first and then re-stores the **full record** — content retained on a node the residency policy excludes; `_writeInvalidate` has the milder form (a lost invalidation, so stale reads until TTL). Closing those means teaching both handlers `priorStagedWrite()`/`stagedEntry` and then flagging them, not simply deferring them. Separately, the apply loop's per-key chain narrows but does not close the cross-key escape: in `{put A, delete B}` where A's resource load rejects and B's is slow, the abort lands at `end_txn` and B's continuation then reaches `addWrite` on a CLOSED transaction, where `save()` commits it alone.

## Record locks: the native key lock is the sole authority (`Table`/`DatabaseTransaction`/`recordLock`)

`table.lock(id, options?)` (harper#483, Phase 0: one node, every worker thread) gives a caller exclusive
write access to one record. The sole authority is the rocksdb-js process-wide key lock — a shared in-memory
map keyed by `[Symbol.for('record-lock'), tableId, id]`. No write goes to the store or audit log for
`lock()` or `unlock()`. The record's version and stored bytes are unchanged when a lock is acquired or
released; only the native key is locked in memory. This design resolves the Phase 0 blockers: durable
LOCK/UNLOCK control writes set a `LOCAL_ONLY` flag that the replication send path must strip, and they
produced a version bump that could cause a peer who received the replication write to see the next
non-lock write as an out-of-order duplicate and discard it. Staying in memory removes that version
skew entirely and eliminates all durable lock state from the on-disk format.

Consequences that shape the code:

- **`store.tryLock(lockKey, onUnlocked)` is the acquisition primitive.** It returns `true` immediately if
  the key is free, or queues `onUnlocked` and returns `false`. `store.unlock(lockKey)` is ownerless —
  any caller can release — and fires all queued callbacks. `store.hasLock(lockKey)` tests without modifying.
  Because `unlock` is ownerless, the handle's `released` flag (set atomically with `store.unlock` in the
  same thread as the lease timer) is what prevents a stale holder from clearing a new holder's lock: once
  `released` is set, `release()` is a no-op. The key is `lockAttemptKey(tableId, id)` =
  `[LOCK_KEY_PREFIX, tableId, ...id]`, distinct from `getFromSource`'s bare-id single-flight lock.
- **`RecordLockHandle`** (`recordLock.ts`) carries `store`, `key`, `keyId`, `expiresAt`, `hold`, `released`,
  and `expired`. `release()` is synchronous: it sets `released`, clears the lease timer, and calls
  `store.unlock(key)`. A lease timer in the holder thread sets `expired = true` then calls `store.unlock()`
  on fire; the stale holder's next `gateLockedWrite` check then throws 409 if another party holds the key.
  `acquireRecordKey` (shared by `lock()` and the async write-gate path) loops `tryLock` → await wake →
  retry until acquired or `waitMs` elapsed (then 423). Converting a gate handle (no lease) to `{ hold:
true }` neutralizes the gate handle and creates a fresh handle with the requested lease timer.
- **Re-entrancy is per-transaction.** `DatabaseTransaction.recordLocks` is a lazily allocated `Map<store, Map<keyId, handle>>` (O(1) lookup; a 5 000-write transaction stays linear).
  `registerRecordLock`, `recordLockFor`, and `unregisterRecordLock` manage it. Both `lock()` and the write
  gate consult it before calling `tryLock`; a re-entrant call returns the existing live handle. A handle
  expired by its lease timer stays registered until a re-lock replaces it, so a stale holder's write gets
  409; an explicitly released handle is removed at once. `waitForPendingKeys` acquires **all** gate-eligible
  writes (not just the failed subset) in canonical `(lockTableId, encoded keyId)` order before re-staging.
  Acquiring only the failed subset causes livelock: W1 acquires A while W2 acquires B, both re-stage,
  each grabs the other's first key synchronously and gates on the complement again indefinitely (until
  the lock deadline → 423). Acquiring the full set ensures the re-stage's synchronous gate finds every key
  re-entrant and no new gating occurs.
- **The gate acts at staging, not at park.** `gateLockedWrite` in `DatabaseTransaction.save()` runs for
  every write marked `gateOnLock` (local mutations: update, delete, invalidate, relocate, publish; never a
  replicated, source-notified, or copy-applied write, nor replay). It calls `tryLock` synchronously. On
  success, a gate handle is registered on the transaction and the write proceeds. On failure, the write is
  marked `gated` with a `pendingWake` promise (resolved by the `onUnlocked` callback). `commit()` collects
  all `gated` writes, discards the current staged round (to drop stale version references and release any
  verification-table intents held during the wait), acquires all keys via `acquireRecordKey`, and restages
  the whole write set via `restageAfter` with a timestamp past the holder's released version. Bounded by
  `LOCKED_WRITE_WAIT_MS`, then 423.
- **Holder writes are re-entrant.** When the transaction's `recordLocks` map already has a handle for the
  write's `keyId`, `gateLockedWrite` re-uses it. It re-reads the entry: if an ungated rewrite (source fill,
  replicated apply) moved the record past the transaction's timestamp, `operation.restage = true` is set
  and `commit()` re-stages the transaction with `restageHolderWrites` (bounded by `LOCKED_WRITE_WAIT_MS`).
- **Release.** A transaction-scoped handle (the default) is in the `recordLocks` array; every commit or abort
  of the link calls `releaseRecordLocks()` which iterates and calls `handle.release()` on each. `{ hold:
true }` attaches the handle to the returned instance as `#lockHandle` instead; `unlock()` calls
  `handle.release()` directly (synchronous, returns false if already released). When no iterators are open
  (`readTxnsUsed <= 1`) the read snapshot is released and `snapshotFree` is set so subsequent reads see
  current state; when iterators are open `setTimestamp` re-pins the same handle, and plain reads in that
  scope keep the pre-lock snapshot — only the holder's own writes bypass it through the gate re-entrancy
  path. A `{ hold: true }` lock does not need the snapshot drop a scoped lock applies: `#reloadLocked`
  reads the record directly from `primaryStore.getEntry(id)` (no transaction, no snapshot), so the
  reloaded value always reflects the latest committed state at lock-acquisition time regardless of any
  prior snapshot the transaction was holding.
- **Replay-handle lifetime.** `restageAfter` creates a native `RocksTransaction` (marked `coordinatedRetry`)
  and passes it as `options.transaction` into the recursive `commit()`. Every error exit of that `commit()`
  call aborts `options.transaction` before propagating — including the save-loop sync throw, the
  `when()`-callback sync throw, and the async rejection path — so iterators-open restage rounds can never
  leak a native handle with staged write intents.
- **Crash / thread death.** A process crash releases all key locks (process-wide in-memory). A worker
  thread termination releases its locks too: rocksdb-js's `~DBHandle()` destructor calls
  `lockReleaseByOwner(this)` on env teardown, releasing every key the terminated thread's handle held.
  The lease timer is additionally a soft bound in case a holder's event loop is blocked (the timer fires
  in the holder's thread, so a blocked-but-alive thread delays it). Phase 1 follow-up: add a native
  lease/deadline to rocksdb-js `LockHandle` so waiters can evict a timed-out holder without waiting.
- **Not supported on LMDB.** `lock()` throws 501; `gateLockedWrite` guards on `typeof store.tryLock !==
'function'` and returns false to avoid crashing if a gated write somehow reaches that path on LMDB.
- **`lock()` is an in-process verb only.** `Resource.lock` is a static verb registered through
  `transactional()` (`type: 'update'`, so it is authorized as an update, with the options treated as call
  options rather than record attributes), but no protocol reaches it: REST dispatches a fixed verb switch
  and answers 501 for anything else (`server/REST.ts`), `KNOWN_METHODS` does not include it, and neither
  OpenAPI nor MCP enumerate it. A held lock therefore always has an in-process owner that can call
  `unlock()`; exposing lock/unlock over a protocol is a Phase 1 decision.
- **`lock()` and `allowUpdate`:** writes through a held lock bypass per-table `allowUpdate`/`allowWrite`
  hooks by the same trust model as any in-process `Table.update(id)` + set/save sequence; lock is not
  reachable over a protocol, so application-layer authorization is the owner's responsibility.

Not in Phase 0, by design: replication of lock transitions, gating of replicated writes, lease renewal,
subscription events for lock/unlock, and lock() on LMDB. Phase 1 direction: replicate lock request/grant/
release as control transaction-log entries with Ricart–Agrawala-style (timestamp, nodeId) tiebreaking; once
every node gates its local writers on a distributed grant, no record version bump is needed.

**Restage timestamp.** `restageAfter` uses the native rocksdb-js process-wide monotonic generator
(`db.getMonotonicTimestamp()`), not the JS per-thread generator (`getNextMonotonicTime`). The two
sequences are independent; mixing them can interleave timestamps unpredictably. If the native generator
has not yet advanced past the peer version being restaged past, the timestamp is nudged by 0.001 ms —
the same exposure any local write already has against a future-dated replicated version arriving after
wall clock. Phase 1 follow-up: add an explicit advance API to the rocksdb-js generator so the nudge
goes through the authoritative path.

**Hold handles and re-entrancy scope.** A hold handle registered in `link.recordLocks` enables
re-entrant writes through `gateLockedWrite` only while that link's transaction is open. Once the
acquiring transaction commits, `releaseRecordLocks` removes non-hold gate handles; the hold handle
stays registered on the resource instance (`#lockHandle`) and on the link for as long as `unlock()`
has not been called. Writing through the returned record after the acquiring transaction committed is
fine (each write auto-commits as an ImmediateTransaction). Taking the lock again in a second
`transaction()` scope issues a fresh lock() call rather than relying on the first hold still being
re-entrant in that new scope.

**Untested scenarios (single-threaded unit tests).** Two scenarios cannot be exercised with a single
JS thread:

- _Abort during the `acquireRecordKey` await window._ The async gap between `tryLock` failing and the
  `onUnlocked` callback is short in practice, and injecting an abort during that window requires two
  concurrent threads.
- _The 503 restage deadline._ `restageHolderWrites` fires when a holder's write cannot commit because
  an ungated writer keeps moving the record past the transaction's timestamp. Triggering this requires
  a concurrent ungated writer that interleaves between the restage-check and the commit attempt, which
  has no scheduling slot in single-threaded tests.

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

## Opening a source LMDB DBI for migration must thread through `compression`

When `migrateOnStart` opens a source LMDB primary store to read records out for the RocksDB copy, it constructs an `OpenDBIObject` and calls `sourceRootStore.openDB(key, dbiInit)`. Critically, the per-attribute `compression` setting from the corresponding `__dbis__` entry must be assigned onto `dbiInit` before that call — `dbiInit.compression = attribute.compression`. Without it, lmdb-js doesn't install its decompression layer; every read on the DBI returns raw compressed bytes. msgpackr then misreads bytes in the `0x40–0x7F` range as shared-structure refs, calls `loadStructures` → decodes the (also compressed) structures buffer → finds more bytes in that range → recurses → stack overflow.

Harper's normal `databases.ts` path already does this (search for `dbiInit.compression = primaryKeyAttribute.compression`); the migration path in `bin/copyDb.ts` has to match.

The persisted `compression` value itself is LMDB-era and loosely shaped: `getDefaultCompression()` historically stored whatever falsy value the config resolved to (`''`, `false`, `null`) when `storage.compression` was disabled, and `{ startingOffset, threshold, dictionary? }` when enabled. lmdb-js interprets falsy as "no compression", but rocksdb-js >= 2.6 validates the option strictly (`''`/booleans throw `Unsupported compression algorithm`) and treats UNSET as "use the build default (lz4)" — the inverse default of lmdb. Every RocksDB open must therefore route through `toRocksCompression()` in `resources/databases.ts` (applied inside `openRocksDatabase`, the single chokepoint), which maps defined-falsy → `'none'` and enabled-without-an-algorithm → an explicit lz4 request when available. Don't pass persisted attribute compression to a RocksDB open directly.

`bin/copyDb.ts`'s `openRocksDb` is part of that chokepoint, not an exception to it. This is about the bytes migration writes, not about a later failure: `copyDbToRocks()` closes every target handle before the staging directory is renamed, and rocksdb-js permits an explicit codec change across a close/reopen, so the runtime would open the migrated database fine either way. But a migration that ignores the configured codec writes the entire dataset uncompressed, and those SST/blob files then keep their original codec until write traffic rewrites them — a full LMDB→RocksDB migration is the one moment the whole dataset is written at once, so it is exactly when the deployment's codec should apply.

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

## `createBlob(readable)` and `table.put()` don't synchronously drain the source

When a blob attribute is created from a Node `Readable` (e.g. `createBlob(stream)` then `row.payload_blob = blob; await table.put(row)`), the put does **not** wait for the underlying stream to fully drain into the file before resolving. Internally `saveBlob` kicks off a `writeBlobWithStream` pipeline whose `storageInfo.saving` promise is tracked separately. The put resolves once encoding has captured the blob reference; the bytes finish writing concurrently.

Consequence for callers that wrap the source in a hashing `Transform`: calling `hash.digest('hex')` after `await table.put()` is unsafe — more `chunk.update()` calls can still fire as the stream drains, producing `Error [ERR_CRYPTO_HASH_FINALIZED]: Digest already called`. Options:

- Buffer first, then hash + put (what `components/deploymentRecorder.ts` does for Slice A — small payloads only).
- Hash via Transform while extraction reads the stream, and only finalize the hash on the Transform's `'end'` event before any second put with the final hash.
- Await `storageInfo.saving` directly if you have a handle to the FileBackedBlob (the cleanest path for streaming).

Future agents touching `components/deploymentRecorder.ts` for Slice B's streaming variant should pick one of the latter two patterns.

## Component preparation is serialized across worker threads

`prepareApplication()` performs one destructive transaction against a component directory: extract the incoming payload, then run its dependency installer. Deploy operations can execute on worker threads as well as main, so a module-local promise queue is insufficient—each worker has its own module registry. `withComponentPreparationLock()` (`components/componentPreparationLock.ts`) instead acquires an atomic filesystem lock keyed by the absolute component path. The deprecated `install_node_modules` operation uses the same lock, so it cannot run npm concurrently with a deploy.

The deploy lifecycle broadcast deliberately sits _outside_ the lock. Overlapping requests therefore increment the existing per-component lifecycle refcount before queueing; watchers remain suppressed continuously until the final queued preparation ends. The lock itself covers credential materialization, extraction, and installation. Its fully-written owner record is published with an atomic rename, so contenders never observe a partially initialized lock. A preparation caller never steals a lock from a known-live owner based on elapsed wall time: installs can be long-running and clocks can jump. Locks from a dead process are reclaimed, and a same-process contender asks the main thread whether the owning worker still exists so a worker crash does not wedge that component until Harper restarts. The boot-time bulk-recovery probe is deliberately different: it never renews its 250 ms deadline, even behind another live recovery, so it can defer that component and let the worker bind its listener.

A plugin load that begins while its component is being deployed waits for that lifecycle to end before
starting `handleApplication`; if a deploy begins during the load, the plugin timeout counts only active,
unpaused load time. This prevents a long install from looking like a hung plugin while its entry handlers
are deliberately paused against the intermediate tree.

### The component load lock is keyed by plugin type, so a plugin's promise is everyone's clock

`sequentiallyHandleApplication` (`components/componentLoader.ts`) holds a cross-thread lock keyed by the
plugin TYPE name — `graphqlSchema`, `rest`, … — not by the component. That is deliberate. Plugin modules
are per-thread singletons carrying module-level state (`server/http.ts`'s `universalHeaders` ownership
array, `resources/graphql.ts`'s `knownGraphQLDirectives`, the scheduler's register-inside-the-lock
contract), and applications load _concurrently_: `serializeComponentLoad` serializes per application
name and all applications go into one `Promise.all`. Without this key two applications' `handleApplication`
for the same plugin would interleave on a single thread, not merely across threads.

The price of that key is that whatever a plugin does inside the lock is paid by every other application.
So a plugin must return a promise that settles with its real outcome: the `withDeployAwareTimeout`
watchdog exists for a _hang_, never as the reporting path for a failure the plugin already diagnosed. A
success-only wait is what turned one unparseable schema into 30s of instance-wide gating per broken
component (#1917). `Scope.waitForInitialLoads()` is that promise — it resolves once the entry handler's
initial scan and every operation that scan started have completed, and rejects with the first failure,
after draining the rest so no sibling operation outlives the lock. The watchdog can still cut that drain
short, so the serialization the lock buys is bounded by the timeout rather than absolute.

Extraction renames an existing component aside before writing the replacement and keeps it until
dependency installation and metadata verification complete. Any preparation failure atomically
renames the partial tree into hidden staging before restoring the prior tree, so a live writer cannot
wedge rollback with `ENOTEMPTY`; cleanup completes while the same-component lock is still held.
On non-root POSIX systems, rollback uses a mode-`000` placeholder to keep that writer out between
retries. Before moving or removing it, rollback verifies the placeholder's device/inode identity and
restores owner permissions because a cross-parent directory move updates `..` and requires write
permission on the moved directory.
The aside name is itself the recovery record: an `.in-progress-*` directory or symlink preserves a
previous tree, while an `.in-progress-*-prior-absent` file records that a first deploy must remove a
partial live tree after a crash. A sibling `.retired-*` marker records that the replacement committed.
Cleanup removes the recovery record before its marker, so an interrupted cleanup cannot make obsolete
state recoverable.
Component loading recovers unretired interrupted deploys before scanning the component root, and
preparation repeats recovery under the same-component lock before reading runtime metadata. A full
`drop_component` writes retirement markers before deleting the live tree and keeps its filesystem,
and configuration mutations under that lock, so cleanup residue cannot resurrect a dropped
component and a concurrent deploy cannot interleave with the drop. Peer replication begins after
the local lock is released, and each peer serializes its own drop independently. Full-component drops
rename the live tree into staging before best-effort cleanup, avoiding an in-place recursive-delete
race with the running worker. Recovery is durable across a process crash. It relies on rename/create
ordering rather than `fsync`, so a host power loss can lose the marker.

A package-manager timeout must not release this lock while npm descendants are still mutating `node_modules`. POSIX spawns therefore run in a dedicated process group; timeout sends the group `SIGTERM`, escalates to `SIGKILL`, and waits for exit before rejecting. Windows uses `taskkill /T /F` for the equivalent process-tree termination. `manageThreads` tracks each spawned process tree by its owning Harper thread and force-terminates it if that worker exits, preventing detached installers from surviving a worker restart or Harper shutdown. `SIGKILL`/`taskkill` only queue termination, so a worker's dead-owner reclamation (above) waits for that thread's tracked process groups to be confirmed gone, not merely signaled—otherwise a replacement preparation could start while the old writer might still be alive. A process group a dead worker's own event loop spawned is never reaped from another thread, so it persists as a zombie rather than fully disappearing; since a zombie can no longer touch the filesystem, confirmation treats a zombie the same as a fully reaped exit.

Boot's `harper-application-lock.json` records an application configuration only after preparation fulfills. Recording at queue time would make a failed install look complete and suppress its retry on the next boot.

Automatic npm component installation is production-only and uses `--omit=dev --no-audit --no-fund`.
`installApplication()` skips the package-manager child entirely when the root manifest declares no
production dependencies, non-empty workspaces, or enabled install lifecycle. An explicitly selected
non-npm manager still runs so it can discover workspace configuration outside `package.json`, and it
retains its own install defaults. A configured `install_command` remains the explicit escape hatch for
build-time tooling. `readInstalledPackageMetadata()` must use the same automatic-work predicate so a
dev-only npm manifest does not force a restart on every redeploy for lacking a lockfile while an
explicit non-npm workspace install still does. Absolute local archives are classified before
package-protocol detection: a Windows drive letter's colon is path syntax, not an npm protocol. File
type detection remains asynchronous in extraction. Bare absolute Windows directory inputs retain
npm's copy/pack behavior rather than becoming live links; explicit `file:` and relative directory
inputs retain their existing symlink behavior.

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

## OIDC trusted publishing (`security/authn/oidc/`)

`exchange_oidc_token` lets a workload authenticate with no stored Harper credential (#2171): it presents an identity token minted by its runtime, and gets back a one-hour operation token for the user a stored trust policy names. It is in `NO_AUTH_OPERATIONS` because it _is_ the authentication, the same way `create_authentication_tokens` is against a password — the same three wiring points apply (`serverHandlers.js` `NO_AUTH_OPERATIONS`, the `verifyPerms` bypass in `serverUtilities.ts`, and a `permission(false, [])` registration).

**The core is issuer-agnostic; everything issuer-specific lives in `providers/`.** That split is the point of the layout, not an accident of it — a new workload-identity issuer should be a profile, not a change to verification, matching, or storage.

- `claims.ts` — matching and constraint _shape_ validation. Knows nothing about any issuer.
- `jwks.ts` — issuer keys. The rate-limit clock for unknown-`kid` refetches lives _outside_ the cache entry: a successful fetch replaces the entry, and a rate limit that resets whenever it fires is not a rate limit. Keeping it separate also means a genuine key rotation is picked up on first use rather than after the window.
- `identityToken.ts` — signature, issuer, audience, `exp`, and a bounded lifetime. Owns `rejectToken`, shared with the exchange so both halves refuse identically.
- `tokenExchange.ts` — policy selection, replay, minting, audit. Verification is memoized per audience, so N policies sharing one cost one signature check.
- `providers/` — `assertPolicyIsSpecific` / `assertAudienceIsSpecific` / `normalizeClaims` / `describePrincipal` / optional `vetoClaims`, resolved by normalized issuer.

**An unregistered issuer gets `providers/generic.ts`, which is strict rather than permissive:** the policy must pin `sub`. That is what makes Kubernetes service accounts, GCP service accounts, and SPIFFE SVIDs work with zero provider code — each has a stable canonical subject. GitHub needs its own profile precisely because its `sub` is the one claim you should _not_ pin: it varies by trigger, and its format changed for repositories created after 2026-07-15.

Four constraints that look like choices but are not:

1. **Every rejection returns the same message.** The endpoint is unauthenticated; a caller told which check failed can enumerate a policy one claim at a time. Reasons go to the `oidc-trust` logger.
2. **A GitHub policy must gate the ref.** `githubActionsProfile.assertPolicyIsSpecific` rejects a policy pinning only repository + workflow, because anyone who can push a branch could then add that workflow to it and mint a token. Stricter than npm's trusted-publishing model, which mitigates the same hole with environment protection instead — and profile-scoped, so it never constrains another issuer.
3. **`createOperationToken`, not `createTokens`.** `createTokens` overwrites `hdb_user.refresh_token` as a side effect, so minting for CI would silently revoke whatever credential that user already held (#2018) — the exact problem this feature removes.
4. **The role is the boundary; the per-policy `operations` allowlist only narrows it.** Least privilege is primarily the role of the user the policy names. A policy may _optionally_ carry an `operations` scope, which can only subtract from that role — never add to it. It is deliberately not merged into `permission.operations`: gate 2 in `operation_authorization.ts` treats an explicit listing of an SU-only operation as a deliberate grant, so reusing that field would _widen_ where this must only narrow. The scope is carried as a separate `tokenOperations` claim and intersected ahead of every early return, including the super_user bypass.

   Its enforcement surface is the operations API and SQL (`verifyPerms` / `verifyPermsAST`) — **not** the application REST/GraphQL resource path, which authorizes through table-level `checkPermission` and does not consult the scope. A scoped token therefore still carries its role's full CRUD there, which is why the role has to be least-privilege on its own; the scope is defense in depth, not a substitute. Closing that gap is a follow-up on the same surface as CORE-3061. Because a second authorization mechanism beside roles is one more place for the two to disagree, whether to keep this at all is an open design question on #2173 rather than a settled constraint.

   Naming `sql` in a scope grants the SQL interface, not unrestricted DML through it: a write statement additionally requires its matching data operation (`insert`/`update`/`delete`) in scope. That is what keeps `read_only` — which expands to include `sql` — from admitting a DELETE, given that `verifyPermsAST` returns early for a super_user before any table check runs.

`hdb_oidc_token_use` (created lazily via `table()`, not the system schema) records spent tokens keyed on a SHA-256 of the token itself, with `expiresAt` past the token's own expiry. Hashed rather than stored, so the table never holds a credential; keyed on the token's **signed input** (`header.payload`) rather than `jti` because not every issuer emits one (Azure uses `uti`). Not on the whole token string: the signature segment is covered by nothing, and base64url decoding ignores the surplus low bits of its final character, so 16 distinct spellings of an RS256 signature decode to the same bytes, all verify, and all hash differently — one leaked token would buy 16 exchanges. ES\* malleability (`s → n−s`) is a second such vector. The signed input is exactly what the issuer asserted, so every variant collapses to one fingerprint. The get-then-put is not atomic and does not claim to be: a concurrent replay is not a privilege escalation, since whoever holds the token could obtain one operation token anyway.

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

Two related traps: the create/schema-update path's exclusive `update-attributes` lock is a
synchronous bounded wait (`acquireUpdateAttributesLock` in `Table.ts`: brief hot spin, then
`Atomics.wait` backoff, retryable `ServerError` after the 10s `UPDATE_ATTRIBUTES_LOCK_TIMEOUT` — harper#2251; it used to be
an unbounded `while (!tryLock()) {}` spin that pinned a worker core forever if the holder never
released). Release is structural — `table()` releases in a single `finally` and `dropTable` uses
`withUpdateAttributesLock` — so a throw inside the locked window cannot leak the lock (regression
suite: `unitTests/resources/updateAttributesLock.test.js`). Because the acquire can now throw,
`table()` takes the RocksDB lock _before_ it mutates the live `Table` (attributes, class metadata,
index handles): losing the race then leaves this worker's in-memory schema exactly as it found it,
and moving any mutation above that acquire reintroduces schema drift the catalog never saw. LMDB
keeps the lazy acquire — its `exclusiveLock()` is an environment-wide write transaction that cannot
time out, so taking it eagerly would stall every write to the database on an unchanged reload. A
successful acquire that waited past `UPDATE_ATTRIBUTES_LOCK_SLOW_WAIT` (1s) warns once, since
contention is otherwise invisible until it becomes a timeout. The locked
sections MUST stay synchronous: the wait blocks the event loop, so an awaited operation inside
one would stall a concurrent acquirer to its deadline. And dropping then recreating a
same-named table within one process requires @harperfast/rocksdb-js >= the column-family
eviction fix (1.4.3 / rocksdb-js#<main PR>): older bindings keep the dropped column family's
by-name registry entry alive whenever other worker threads hold handles, so the recreate
silently reuses a dangling handle and every write fails with "Invalid column family specified
in write batch", poisoning the whole database env until restart. The regression suite for all
of this is `unitTests/resources/dropTableGhost.test.js` (it fails by design on pre-fix
bindings).

## Scoped tokens and synthetic-role identity (`security/tokenAuthentication.ts`, `security/impersonation.ts`)

`create_authentication_tokens` with an inline `role` **object** mints a `sub: 'scoped-operation'`
JWT that embeds its whole (downgraded, deep-validated) permission set; the bearer needs no
`hdb_user`/`hdb_role` row and the `username` is attribution only. Minting is super_user-gated
(or trusted internal dispatch via `isOperationAuthorizationBypassed()`); a string `role` keeps its
legacy meaning (component-defined token, rejected by `validateOperationToken`). Scoped tokens get
no refresh token, touch no user record, and are therefore **irrevocable until expiry** — expiry is
the only control, which is why `auth.ts` evicts cached Bearer identities at exact `authExpiresAt`
rather than waiting for the auth-cache TTL.

The attribution `username` must NOT name an existing `hdb_user` (rejected at mint; the default is
`scoped:<minter>`): code paths that rehydrate a user by name would otherwise substitute the real
principal's permissions for the token's — or fail-closed on the non-existent name. The three known
by-name sites are handled, all by the same `_scopedToken` short-circuit: the MQTT last-will replay
(`DurableSubscriptionsSession.ts` persists the scoped role/marker/expiry on the will and skips
rehydration — and both the restart-replay and the live abnormal-disconnect paths refuse to publish
a scoped will past `authExpiresAt`), the live-subscription stale-auth recheck (`Resource.ts`
`registerLiveSubscriptionForContext` keeps the embedded role as the identity), and the MCP
`list_changed` session refresh (`components/mcp/listChanged.ts` `refreshSessionUser`). The scoped
principal also cannot self-mint standing tokens: the passwordless path of `createTokens` rejects an
`hdb_user._scopedToken` requester. **Any future by-name rehydration must check `_scopedToken`.** A
user _created after minting_ with a colliding name is therefore inert at every current site; the
residual is only some _new_ unguarded by-name site — another reason to prefer short expiries.

Scope of the `operations` allowlist: it gates the **operations API** (including the `sql` path,
which never reaches `verifyPerms` and calls `verifyOperationsAllowlist` directly from
`chooseOperation`) — it does NOT gate the application/REST/GraphQL/MQTT surfaces, which authorize
on translated table CRUD permissions only. A scoped token intended to be read-only on app
endpoints must carry restrictive table permissions; `operations: ['read_only']` alone does not
constrain REST writes if table perms allow them.

The invariant to preserve when touching any synthetic (inline/impersonated/scoped) role:
`permissionsTranslator.getRolePermissions` memoizes translated permissions **by role name** (keyed
further by `__updatedtime__` + schema). A synthetic role must therefore never carry a constant
name or a per-request timestamp — two different permission sets would alias one cache slot (a
same-millisecond `Date.now()` was enough), leaking one principal's translated permissions to
another. `syntheticRoleName()` derives the name from a hash of the post-downgrade permission
content with `__updatedtime__: 0`, so identical sets share a slot and distinct sets can't collide;
`applyImpersonation` re-keys all three impersonation modes the same way (Mode B/C previously wrote
downgraded copies under the _persisted_ role's name). Synthetic translations live in a separate
256-entry LRU (`syntheticRolePermsMap`), not the permanent `rolePermsMap` — so >256 concurrently
live distinct permission sets degrade to per-request translation (a deliberate cliff; raise the
constant if a legitimate workload hits it). The `_` name prefix is the discriminator; a persisted
role named with a leading underscore lands in the LRU too (correct, just evictable). Relatedly,
the role `operations` allowlist gate in `verifyPerms` must stay **ahead of** the ambient privilege
early-returns (super_user, structure_user, system-table allowances): persisted roles can't combine
`super_user` with other permission keys, but inline roles can combine `structure_user` with an
allowlist, and the gate ordering is what keeps unlisted schema ops unreachable.

## The dispatched API operation is carried on async context, never on the request (`server/serverHelpers/operationAuthorizationState.ts`)

`verifyPermsAST`'s token-scope check has to be told which top-level API operation the caller
invoked, because the scope is written in that namespace (`sql`, `export_local`, ...). Two things
make that awkward:

1. On the **direct-SQL** path, the object handed to `checkASTPermissions` _is_ the client's request
   body, and this check is the only gate there (`chooseOperation`'s `sql` branch is mutually
   exclusive with its `verifyPerms` call). Any field read off that object is therefore a way to
   name whichever operation the caller's scope happens to allow and run arbitrary SQL under it.
   `jsonMessage.operation` is safe only because dispatch already routed on that same field, so it
   cannot disagree with the operation running. Never add another.
2. A **job** re-parses its SQL from the nested `search_operation` in a _different_ async context —
   `executeJob` persists the request and hands off to the job runner, and `jobProcess.ts` re-enters
   from the `hdb_job` record. So a store established around the originating request cannot reach
   it, and the re-parse would be judged as `sql` rather than as the job's own operation.

The carrier is therefore established **in the job worker**, by `runWithDispatchedOperation`, from
the same `request.operation` that `getOperationFunction` just resolved the handler from. That
identity is the whole basis for trusting it: the value naming the operation and the value selecting
the code cannot diverge. A new carrier must preserve that property — an added request property, a
`search_operation` field, or a persisted `parsed_sql_object` would not.

This lives in the same `AsyncLocalStorage` as the auth bypass rather than a second store, so
`processAST` reads the state once. `runWithOperationAuthorizationBypass` **preserves** an existing
carrier on both branches. That is deliberate and was initially got wrong: its enforced branch is not
a bypass, so a job handler dispatching a nested _authorized_ operation lands there, and dropping the
carrier would judge that job's re-parsed SQL as the inner `sql` and refuse it partway through its own
work. The consequence to know is the other direction — a nested dispatch inside a job is judged
against the **outer** job's operation for any `evaluateSQL` that does not pass through
`chooseOperation`. It allocates only when a carrier is present; with none, two shared frozen objects
serve the common path. All four stores are frozen, so `getOperationAuthorizationState()` cannot hand
a mutable one to a caller.

It has four call sites, and they are not all dispatch wrappers: `server.operation()`
(`serverUtilities.ts`), the ITC path (`registeredOperations.ts`), the legacy SQL engine
(`sqlEngine/diff/differential.ts`), and Harper's own `hdb_job` query (`server/jobs/jobs.ts`) — that
last one **is** reached from the ops-API dispatch, via `search_jobs_by_start_date` →
`handleGetJobsByStartDate` → `getJobsInDateRange`.

Harper's own internal SQL takes the bypass, not the carrier. `getJobsInDateRange` runs a fixed
`system.hdb_job` query through `evaluateSQL` beneath a handler the caller was already authorized for,
and `SqlSearchObject` hardcodes `operation: 'sql'` — so the same mismatch applies, but the answer
differs, and the reason is easy to get backwards. `verifyPermsAST`'s super_user early return is
`isSuperUser && !isSuSystemOperation`, so a `system` schema is **exempt** from it and the table check
genuinely runs. A carrier would therefore put Harper's own query through `hasPermissions` on
`system.hdb_job`, which passes only because `appendSystemTablesToRole` grants `system.*.read` to a
hydrated super_user — a super_user principal without an appended `permission.system` (an
impersonation payload, or any path that skips user-cache hydration) would start getting 403s on an
operation it is entitled to. The bypass also states the actual intent: the statement is Harper's, not
the caller's. Wrap the individual statement, not the function — a later caller-dependent statement
must not inherit it.

A second body field has to be neutralized for any of this to hold: `evaluateSQL` trusts a supplied
`parsed_sql_object` verbatim and skips parsing, `chooseOperation` overwrites only the **top-level**
one, and `dataLayer/export.ts` hands the nested `search_operation` straight to `evaluateSQL`. So a
body-supplied `search_operation.parsed_sql_object` carrying `permissions_checked: true` would run an
arbitrary AST with the check skipped. `chooseOperation` deletes it, forcing the worker to re-parse
from the `sql` string that dispatch authorized — the nested object is never overwritten the way the
top-level one is, because nothing downstream should read one at all.

What is untestable is not the carrier's contract — unit tests cover that by calling
`runWithDispatchedOperation` directly — but that `jobProcess` is what establishes it. Delete that call
and those tests stay green. The carrier only changes an outcome through `tokenScopeDenial`, which is
inert unless the principal carries `tokenOperations`, and that property has exactly one origin: an
OIDC trust-policy exchange, for which there is no integration harness.

Three different mechanisms are easy to conflate here. `tokenOperations` above is the **OIDC token
operation scope** (#2174). An **inline-role scoped token** (`create_authentication_tokens` with a
`role` object) is not the same thing and cannot substitute, because `createScopedToken` mints it
`super_user: false`, so it cannot invoke a `requires_su` operation such as `export_local` at all.
**Table permissions** are a third, and also cannot substitute — see the system-schema exemption
above. See #2298.

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

**Publication is transactional (#2382).** `updateTLS` builds the entire replacement state —
hostname→context map, CA map, and default candidate — into pass-local candidates and reconciles the
live maps in place only after the pass completes (their identity is load-bearing:
`server.secureContexts` and each context's `availableCAs` alias them). A record that is still in the
table but fails to build (`ERR_OSSL_X509_KEY_VALUES_MISMATCH` when the table's cert outruns the
on-disk key, a missing key on this thread) keeps every live entry it owns _and_ its default
candidacy — a record can be serving as the default with no hostname entries at all — so a transient
mismatch never downgrades serving below last-good (the pre-fix behavior served the self-signed
default for days). Retention is trust-aware: a context froze its `ca:` list at build time, so when
the CA set has changed since, the retained pair is rebuilt against the current trust material —
new handshakes never see revoked client-CA trust; established sessions and outstanding session
tickets are unaffected, exactly as on a fresh build (ticket keys are process-wide and never rotate
on trust changes) — and if that rebuild fails the record's entries
drop for that pass, except when nothing else is servable: the zero-certificate guard then retains
the old state (availability outranks the drop in that corner) while the failure keeps retrying. Deleting the record remains the way to drop its contexts; a corrupt authority
row is a pass failure like any other (reported through the signature throttle, armed for retry) and
its trust drops until it heals. A failed pass arms a
self-retry on the shared debounce with a per-signature backoff (1.5s doubling to 5min) and
signature-throttled logging; external triggers (table subscription, key reload) stay at the plain
debounce. `loadAndWatch` latches its mtime before the callback for chokidar/poll dedupe, but rolls
the latch back on a synchronous throw or a rejected callback promise (equality-guarded so a stale
rejection cannot unlatch a newer reload) — the latch means "last successfully applied", so the
periodic poll can heal a lost `hdb_certificate` write instead of deduplicating it forever.

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

## Boot-path config persistence is best-effort, and its two artifacts commit as a unit (`config/configUtils.ts`, `config/harperConfigEnvVars.ts`)

Every boot with a `HARPER_*_CONFIG` env var set re-derives the merged config and, historically, wrote
it back unconditionally. On a full or quota-exhausted volume that write is refused and, being fatal,
turned a full disk into a container restart loop nothing inside the container could break — the
cleanup that frees space needs a started process (#847). Two rules follow.

**Derived boot writes are best-effort; user-requested ones are not.** `persistConfigDuringBoot()`
swallows exactly ENOSPC/EDQUOT (matching on `errno` as well as `code`, because Linux has no libuv
mapping for EDQUOT and reports `Unknown system error -122`) and lets the boot proceed on the
in-memory config. `updateConfig`/`set_configuration`, `addConfig`, `deleteConfigFromFile` and the
install path keep persist-or-throw: a caller who asked to persist must not get a silent success, and
an install has no last-known-good config to fall back on.

**The env-config state and the config file must never disagree.** The state file records the
_pre-env_ values, so it is the only copy of what the operator's config said before an env layer
overwrote it — the config file itself holds the env-derived value. Both single-file orderings lose
something: writing the state last means the file it would read originals from is already
overwritten; writing it first leaves a state ahead of the file, which the next boot's
`detectConfigDrift` reads as a manual user edit and _permanently_ reassigns those paths to `user`,
silently disabling the env layer even after space is freed. So the commit is three steps —
`saveState()` stages the new state in `.harper-config-state.pending.<pid>.json`, the config file is
written, and `confirmConfigWritten()` **renames** the sidecar over the confirmed record. A rename
needs no free space, which is the point: no write an exhausted volume can refuse ever stands between
the confirmed originals and disk. A refused staging write leaves the config file alone; a refused
config write unlinks the sidecar; a sidecar found at load means a commit was interrupted, so it is
cleared and drift detection is skipped for that boot rather than mistaking the in-flight write for
an edit. A boot that re-derives the same state writes nothing at all.

Two details the name and the caller carry. The sidecar is **per-process**: every CLI invocation runs
`initConfig`, and one shared name would let a starting server clear a running process's in-flight
commit — the loser would then rewrite the config file with the confirmed state still describing the
old values, which is the failure the protocol exists to prevent. Recovery therefore only clears a
sidecar whose owning pid is gone. And only the **main thread** persists or runs recovery: workers
derive the same merged config and would otherwise race over one pair of files for a result they
already agree on — and since a worker shares its process's pid, a recovery scan from one would
delete the main thread's in-flight sidecar as if it were the last boot's wreckage.

A sidecar owned by a _live_ foreign process is not cleared — that process is mid-commit — but its
presence still turns drift detection off for this boot: a pair someone else is halfway through is no
more comparable than one an interruption left behind. That suspension is why a sidecar also ages
out regardless of what its pid says: without it, a sidecar whose owner was killed and whose pid was
later recycled would look mid-commit forever and suspend drift detection on every boot. The age-out
is deliberately far longer than a commit could take — recovery from a recycled pid only has to be
eventual, while deleting a slow-but-live writer's sidecar is the worse error, stranding its config
file against an unpromoted state.

Drift detection is main-thread-only for the same reason recovery is. A worker never owns the state:
in the normal sequence the main thread has already classified and persisted before any worker runs,
and inside the main thread's commit window a file that differs from the snapshot is as likely to be
the write in flight as an operator edit. A worker that concluded "user edit" would drop the
env-supplied value for itself alone and serve different config than its siblings.

Known limit: the pair commits as a unit _within a process_. Two live processes (a server boot and a
CLI invocation) can still interleave their config-file writes and promotions, and nothing in the repo
serializes config writes across processes. Pre-existing — both artifacts were unordered before this
protocol — and out of scope here, but the "commits as a unit" guarantee stops at the process
boundary.

Related: a log write must not be fatal either. `fs.appendFileSync` in `logQueuedData` throws from
both inline and timer call sites, so on a full volume every log statement was a crash point. The
fallback goes through `nativeStdWrite`, never `console` — `installStdioGuard` routes console output
back into this same file logger when `logging.file` and `logging.console` are both on, so a console
fallback recurses until the stack blows.

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
  Each enumerated entry is classified before capture: complete blobs and existing abort markers are
  hard-linked when possible (copied across filesystems), `.repair` temporaries are omitted, and an
  incomplete blob is replaced by a retryable PENDING (`0xfe`) marker. If a classified blob vanishes
  before capture, a terminal ERROR (`0xff`) marker preserves its file id. A file reclaimed before its
  parent directory is read is outside the snapshot. This keeps a snapshot inode from changing as a
  live write finishes, while complete blobs remain safe to hard-link because published blob paths are
  write-once. The snapshot is built in a `.tmp-<id>` sibling and atomically renamed so a failed create
  leaves no partial snapshot. `restore_backup` purges each blob root and rewrites it from the snapshot;
  `delete_backup` / `purge_backups` remove the corresponding snapshot directories.
- **`get_backup`** appends the blob files to the same tar under `blobs/<rootIndex>/<relpath>`. The
  binding's streaming backup finalizes its tar with exactly a 1024-byte (two-block) end-of-archive
  marker; `createBackupStream` streams the native _plain_ tar while withholding that trailer
  (verifying it is all-zero), appends the blob entries via `tar-stream` (whose `finalize` writes the
  one real trailer), and gzips the combined stream itself when requested — so the binding is always
  asked for a plain tar and compression happens after the append. No scratch disk. The same blob
  classification rule applies: complete blobs are streamed, incomplete or post-enumeration missing
  blobs become PENDING/ERROR marker entries, and repair temporaries are omitted.

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

## Under Bun, the main HTTP port is served by `node:http`, not `Bun.serve`

Worth knowing before debugging anything Bun-specific on the HTTP path: `getBunHTTPServer()` builds
the `Bun.serve()` fetch config, but `onWebSocket()` calls `getHTTPServer()` unconditionally — it has
a uWS branch and no Bun branch, because Bun native WebSockets are unimplemented (nothing ever sets
`config.websocket`, so WS relies on the Node `ws` server attached to an `http.Server`). MQTT's
`handleApplication` registers WS on the default port before REST's `httpServer()` call for that same
port, so `httpServers[port]` is already a Node server by then and `getBunHTTPServer` early-returns
without registering a serve config. The port is bound by `registerServer()`'s Node server via
`listenOnPortsBun`'s trailing "non-HTTP servers" loop, and the fetch handler is never invoked for it
(only the exclusive operations port reaches `Bun.serve`). Consequence: on Bun the `Request`/`Response`
fetch path is dead code for the main port, and its divergences show up as `node:http`-emulation
divergences instead.

One such divergence, `#2210`: Bun's `node:http` never derives keep-alive from the request. For a
`Connection: close` request `shouldKeepAlive` stays `true`, and neither a `Connection: close` response
header nor `response.socket.end()` closes the connection — a **stream-ended** response (an async
source ended through `pipeline()`; a direct `response.end()` is fine) delivers its full body and
terminal chunk, then holds the connection until Bun's own idle timeout — a chunked-aware client
completes the message and can walk away, but the un-honored close still violates RFC 9112 §9.6 and
strands the socket; a raw client waiting on the FIN (and the HTTP/1.0 case below, which has no
terminal chunk to stop at) hangs outright. An HTTP/1.0 client hangs the same way
without asking to close at all, since 1.0 persistence needs both an explicit `keep-alive` and a length
to read to — so a 1.0 response that got no `Content-Length` is close-delimited, the same line Node
draws (Node closes it at ~7ms; Bun never does). An explicit `close` token wins over `keep-alive` on
both versions. A 1.0 `keep-alive` request whose response _did_ get a
`Content-Length` (`body.size` on a blob, `server/http.ts:698-709`) is left open, which is again what
Node does and what Bun then handles correctly.

`pipeBodyToResponse()` therefore ends `request.socket` itself for those shapes
(`endConnectionIfClientExpectsClose`, `isBun`-gated, HTTP/1 only, clean path only — the error path
already closes because `pipeline()` destroys the response with the stream error). Ending the
_request's_ socket is the only remedy that works after a clean stream end on Bun: a `Connection:
close` response header, `response.socket.end()` and `response.destroy()` were all measured as no-ops
there. `socket.end()` is graceful, so it does not truncate — 8 MB over plain TCP and 6 MB over TLS to
a deliberately slow reader each arrive whole. The
`Content-Length` check reads `response.hasHeader()`, which Bun populates from the `writeHead(status,
headers)` fast path this file uses (Node does not, but the branch is Bun-only). A
keep-alive arm pins the other direction (such a client keeps its connection and reuses it); the two
HTTP/1.0 arms are Node/Bun-only, because uWS does not route an HTTP/1.0 request to the resource at
all.

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
- The Dockerfile extracts the local tarball into a project directory and runs `npm install` there
  (rather than `npm install --global <tarball>`), so it reads `npm-shrinkwrap.json` off disk like any
  checked-out project and gets version pinning (#1960). It does **not** get the omission half: `npm
install` (unlike a registry install of harper as _someone else's_ dependency) reconciles the local
  project's own `package.json` against the lockfile, and the packed `package.json` prunes nothing —
  only the shrinkwrap does. `alasql`'s packed manifest still declares the react-native-fs optional
  edge, so plain `npm install` silently re-adds that whole pruned subtree to satisfy it. Closing that
  gap needs `npm ci` against a package.json where `alasql`'s own packed manifest has also had the edge
  removed — a bigger change to the published tarball than this dance, and not yet done. The Dockerfile
  does strip `devDependencies` from its _own extracted copy_ of `package.json` before installing (not
  the published tarball — registry consumers never see this) — not for `npm ci`'s sake, but because
  without it `npm install` still resolves dev edges to compute the ideal tree even under `--omit=dev`,
  which could silently lift a _production_ package that a devDependency also happens to want above its
  shrinkwrap pin. Confirmed empirically before landing: a hoisted production package's installed
  version tracked a devDependency's looser range instead of the shrinkwrap pin without this strip.
- Pinning inverts the old incident-remediation path, worth knowing before reaching for it: before
  #1960, rebuilding the image picked up any newer in-range dependency automatically, which is how a
  bad pin got fixed in production by "refresh/rebuild the image" alone. After #1960, the _pinned_ part
  of the tree is frozen to the shrinkwrap, so a remediation of that shape now needs a lock bump and a
  re-release — a rebuild alone reproduces the same tree, bug included. This does **not** apply to the
  react-native residual two bullets up: that subtree is still re-resolved fresh on every build, so a
  bug specific to it (not that anyone should want one there) actually would clear on a rebuild.

## The published image runs `tini -g` as PID 1, not Harper (`Dockerfile`)

Harper used to be PID 1 in the published image. It is now started under `tini -g`, and that is
user-visible in four ways worth knowing before changing the entrypoint:

- **The restart watchdog depends on it.** `bin/restartExitWatchdog.ts` refuses to arm when
  `process.pid <= 1`, and the SIGKILL it delivers would be ignored by PID 1 anyway (the kernel
  drops unhandled signals to the init process). Harper being a _child_ is what makes a wedged
  restart teardown forcibly exit rather than hang until the orchestrator's own timeout.
- **`-g` forwards `docker stop`'s SIGTERM to Harper's process group**, not just Harper. This reaches
  descendants a component spawns in-group — they now receive SIGTERM directly instead of only seeing
  their parent go away — and is the boundary most likely to change behaviour for such a component. It
  does **not** reach Harper-managed subprocesses: `utility/processManagement/processManagement.js`
  forks them `detached: true`, which `setsid()`s them into their own group and session, so tini's
  group signal never arrives.
- **`docker exec … ps` and anything keying off PID 1** now sees `tini`, not `node`.
- **`docker run --init` nests a second init** above `tini`. Harmless, but redundant.

Volumes written by older PID-1 images stay compatible: `utility/processManagement` treats a pid
file naming PID 1 as stale when PID 1 is an init process, so a container restarted onto such a
volume does not refuse to start on a "still running" pid that is now `tini`.

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

## Deploy watcher generations preserve logical entry events

Component deploys pause each scope's `EntryHandler` while the component directory is replaced. A
new chokidar instance then performs a cold-style initial scan, which reports every surviving path
as `add`/`addDir` and cannot report paths that disappeared. Exposing those raw scan events changed
the public `scope.handleEntry()` contract in #1806: consumers could no longer distinguish an
unchanged file from a changed one, and deletions vanished entirely.

`EntryHandler` therefore owns the deploy boundary. It retains a compact snapshot of matching paths
(entry kind, URL path, and a SHA-256 content digest for files), assigns each watcher a monotonically
increasing generation, and compares the resumed generation's scan with the pre-pause snapshot. The
comparison emits only logical `add`, `change`, `unlink`, `addDir`, and `unlinkDir` events; unchanged
entries remain silent. File contents are still read once for the event payload and are not retained
in the snapshot. Reads and readiness are generation-scoped, and a per-path sequence prevents a slow
read from an obsolete event from overwriting a newer state. Missing paths are synthesized as unlink
events only after the resumed scan and all of its reads complete.

Every watcher recreation uses the same comparison. The first generation compares against an empty
snapshot and therefore retains its cold-load `add` behavior; deploy resume, configuration updates,
and polling recovery compare against the last completed generation. This keeps file identity intact
when watcher recovery could otherwise replay stale modules as new and ensures an update racing a
deploy scan cannot discard its removals. New component deploys still use `Application#isNewComponent`
to mark a restart as required for #674; other existing-component redeploys request a restart only when
their logical entry, loaded runtime, or configuration changes require one.

## Restart-free deploys require proof of runtime equivalence

`EntryHandler` intentionally observes only the files a component declares in its `files` option. It
cannot prove that the JavaScript runtime is unchanged: a watched `resources.js` can import an
unwatched `lib/db.js`, and installed dependencies live under the watcher's ignored `node_modules`
tree. Conversely, hashing the entire extracted tree treats unused source and generated caches as
runtime changes and collapses restart-free deploys back into unconditional restarts.

Runtime equivalence is therefore layered. A deploy can remain restart-free only when all three
layers it uses are proven equivalent:

- `EntryHandler` compares consumer-visible watched entries.
- `ApplicationScope` records the file URL and load-time digest of every application-local module
  that Harper's VM or compartment loader reads, including application-local package imports and
  package self-references, together with every application-local resolution edge. After a deploy,
  those exact logical paths are re-read and each edge is resolved again against the replacement tree
  after evicting Node's matching resolution-cache entry. Adding a higher-priority `foo.js` ahead of a
  previously resolved `foo.json` is therefore a runtime change even when `foo.json` itself is
  byte-identical. For import-only package exports that Node's CommonJS resolver cannot resolve, the
  package manifest itself is recorded as a runtime input so an exports-map retarget is also observable.
- The deploy pipeline compares dependency metadata at the same preparation stage: the previous
  installed tree before extraction versus the replacement tree after installation.

Loader or installer paths that Harper cannot observe are conservative. Full native module loading,
custom install commands, enabled install scripts, payloads that already contain `node_modules`, and
installs without deterministic lock evidence mark the runtime opaque; an existing component using an
opaque path requires a restart on redeploy. `harper deploy` omits `node_modules` by default; callers of
`package_component` that want restart-free comparison must likewise set `skip_node_modules: true`.
Npm dependencies delegated from the default VM loader to Node's native loader are instead covered
by the installed package/lock comparison—otherwise the default `dependencyLoader: auto` mode would
make nearly every application opaque. Explicit `dependencyLoader: native` remains authoritative;
an application-local import delegated by that setting marks the runtime opaque. `package.json` is compared as parsed JSON so formatting and
key order are irrelevant, while lockfiles remain exact installed-tree evidence. A module first
loaded while a deploy is in flight also invalidates the old runtime rather than letting a mixed
generation appear equivalent. This is deliberately proof-oriented: an unused new local file need
not restart a fully observed runtime, but a changed or missing imported helper, changed resolution
input, changed dependency evidence, or any genuinely opaque runtime does. Entry changes themselves
remain consumer-directed: the static plugin applies asset changes incrementally, while executable
consumers such as `jsResource` request a restart on their logical `change` or `unlink` events.

## Graph size on the HNSW query path must come from node ids (`resources/indexes/HierarchicalNavigableSmallWorld.ts`)

The ef auto-scale needs to know how big the graph is, on every query. Two sources that look right
are not.

`getKeysCount()` on a RocksDB store is an exact key scan, so it is O(N): measured at 13 ms per call
at 10K keys, 128 ms at 100K, ~1 s at 500K. Calling it per query puts a linear-in-corpus-size term in
front of every vector search — 34% of query latency at 20K vectors on the real table stack.

RocksDB's `rocksdb.estimate-num-keys` property is O(1) and looks like the obvious replacement, but it
counts entries across memtable and SST files without reconciling overwrites. Building an HNSW graph
rewrites each node many times as its neighbours change, so on a real index it reads far high: 37,775
for a 2,000-record table whose exact key count is 4,001, and worse after deletes. It reads exact on a
fresh store with simple puts, so it validates clean in isolation and only misleads on a real index.

Node ids are the sound source. They are allocated monotonically from a `getUserSharedBuffer` counter,
so the counter (or one reverse seek to the largest id) gives the node count in O(1), unaffected by
how many times a node has been rewritten. Deletes leave it reading high until a rebuild, which only
makes ef slightly generous.

Note the unit: the index store holds two keys per record — the graph node and the primary-key
mapping — so a key count is twice the node count. `AUTO_EF_REF` is expressed in nodes for that
reason, and any change between the two units has to move it to keep the resolved ef the same.

## HNSW layers above 0 are for routing only, and must be searched greedily

Each layer above 0 exists to hand the next layer down an entry point: `search()` and `index()` both
take `results[0]` and discard the rest. Searching them at the full `ef` therefore buys nothing and
costs work proportional to the layer's population rather than to ef — layer 1 holds ~N/M nodes, and
at ef 512 a query visited ~95% of it. That is a second linear-in-N term: upper-layer visits per query
grew 342 → 2,421 across 5K → 41K vectors on real embeddings, and reached 75% of query time at 100K. Greedy descent
(`ROUTING_EF`) is what standard HNSW does. Measured against the same graphs searched at the full `ef`
on every layer, across 16 (size, `ef`) points on a held-out real-embedding corpus, the worst
recall@10 change was -0.002 — one displaced neighbour at a single point — and 0.000 everywhere else.

The connection-building pass in `index()` is not routing — it selects the edges that get stored — so
it keeps `efConstruction`.

The insert-side change is the one that alters stored graphs, recoverable only by a reindex, so it was
measured separately (`benchmarks/hnsw-scale.js --build-upper-ef=100` restores the previous
index-time descent). At 20,000 real 768-dim embeddings with identical corpus and level assignments,
the two builds were indistinguishable on every metric measured — same recall at each `ef`, same visit
counts, same mean layer-0 degree — and the greedy build was 1.28x faster. That is consistent with the
graphs being identical, though equal metrics do not prove it. It is the expected result either way:
the upper layers are sparse enough that a greedy walk reaches the same entry point, which is why
standard HNSW descends this way.

Greedy-equals-full is statistical, not per-graph: rare level layouts route to a different layer-0
entry point and displace the tail of the top-k (~2-3% of random 600-node graphs in the unit test's
corpus). Tests that assert exact result-set equality across search strategies must therefore pin the
graph: level assignment draws from the instance's `random` property (a test seam defaulting to
`Math.random`), which the routing test replaces with a seeded PRNG. One pinned graph samples the
property once, so that test sweeps a fixed list of seeds, each verified non-divergent when the list
was written — a seed that starts diverging after an intentional index change is a re-pin, not
necessarily a routing regression.

## `efConstruction` and the search-`ef` ceiling both auto-scale with the graph

The connection-building pass selects each node's stored edges from a candidate list of
`efConstruction` entries. Held at a constant (100) while the corpus grows, edge quality erodes in a
way no search-side setting can compensate: at 1M nodes (768-dim, int8, calibrated hard corpus)
recall@10 fell to 0.935 and sweeping the search `ef` from 512 to 1536 only reached 0.957 raw / 0.967
set at 4.7x the latency — the missing neighbours were not deep in the candidate list, they were
unreachable. Rebuilding the identical corpus (same seed, same level assignments) with
`efConstruction` 200 restored 0.985/0.997 and made queries _faster_ at the same `ef` (3,110 nodes
visited vs 3,948 — better-selected edges route more directly). Quantization contributed ~1.5 points
(float32 rebuild: 0.952); construction quality was the dominant term. Full sweep in #2180.

So when the schema does not configure `efConstruction`, it scales as `AUTO_EF_BASE * sqrt(nodes /
AUTO_EFC_REF)`, capped at `AUTO_EFC_MAX`. The healthy write path reads the count directly from the
shared id counter: one atomic load with no memo lag during bulk ingest. If an update-only worker
cannot attach that counter, it warns once, falls back to the memoized reverse seek, and retries the
attach after the memo TTL; a new insert still requires the shared counter rather than risking ids
from a private counter. Scaling starts at 250K nodes: efC 100 held recall through 500K (0.978), so
smaller graphs — the common case — build exactly as before. The sqrt shape mirrors the search-side
scale; the cost is build time (1.77x at 1M for efC 200), paid only by tables that actually grow
large, and partly returned as cheaper queries.

An explicit `efConstruction` stays authoritative and is structural, so changing it triggers a full
index rebuild. It also seeds the search `ef`: setting `efConstruction: 100` alone cuts query effort
to 100. Retaining the former large-graph search default while opting out of build scaling requires
an explicit `efConstructionSearch` as well (512 after the former auto-scale reached its plateau).
There is currently no "pinned build, auto search" combination.

The search side scales past its old plateau for the same reason. `AUTO_EF_MAX` (512, pinned from
~13K nodes) was calibrated when layers above 0 were searched at the full `ef`, which made large efs
cost seconds; after the greedy-descent fix the same headroom costs tens of milliseconds (ef 1024 at
5M nodes: ~45ms p50), and holding the pin leaves measured recall on the table — set-recall at a
pinned 512 on well-built graphs decays 0.997 → 0.955 → 0.935 across 1M/2M/5M. So past
`AUTO_EF_LARGE_REF` (1M nodes, where 512 was last measured sufficient) the scale resumes from the
plateau — `512 * sqrt(nodes / 1M)` — up to `AUTO_EF_CEILING` (2048, binding at ~16M). The 5M point
resolves 1,145, bracketed by the measured ef-1024 sweep there (0.985 set). The default's query
latency therefore grows as sqrt(N) on large tables; that is the recall-first trade chosen here, and
apps preferring latency pin `efConstructionSearch` or a per-query `ef`. The filtered-traversal
budget (`maxVisits`, #1241) deliberately does not follow the second regime: each budgeted visit is
a synchronous record load plus predicate evaluation, so an auto-scaled ef's budget contribution
stays capped at `AUTO_EF_MAX` — the recall decision and the filtered-scan bound are separate
decisions, and an explicit ef (per-query or schema) still raises the budget for callers who own
the cost. Both ceilings are finite on
purpose: total build work grows as N^1.5 under sqrt scaling, and past roughly tens of millions of
nodes per graph, sharded medium graphs beat one huge graph on build and query cost alike — scaling
the constants further is the wrong tool there.

Two caveats are accepted deliberately, both inherited from the count being a lifetime high-water
mark of allocated node ids rather than a live count. First, churn: a table that deletes heavily
(TTL eviction, delete-and-reinsert ingest) reads high forever, so its build-side efC can sit at the
cap while the live graph is small. The 6–7x build-time extrapolation applies to a comparably large
graph; it is not a bound for a small rolling window. When efC exceeds the live graph size, the
candidate list cannot fill and an insert can traverse a large fraction of the graph before storing
only `M << 1` edges. This wastes throughput without improving recall. The search side accepted the
same over-count as "slightly generous ef" on an opt-in read path; the write path inherits it as a
known cost until a live count exists (tracked follow-up). Second, ramp history: nodes indexed before
the graph crossed a scale threshold keep their original edges — the scale applies to inserts from
that point on. A reindex in a live process rebuilds roughly uniformly (the id counter keeps its
high-water mark), but a reindex after a restart re-seeds the counter from the largest id in the
rebuilding store and therefore repeats the ramp — its first 250K nodes rebuild at the base efC.
Later inserts add reverse edges to older nodes, but a default-ramp 1M build has not been compared
directly with the uniform-200 A/B. The larger default-ramp runs reached 0.988 set-recall at 2M and
0.985 at 5M when searched at ef 1024, which shows that the measured neighbours remained reachable
at those sizes without proving uniform convergence.

Deletes have a separate tail-latency cost: connectivity repair can synchronously reinsert an orphan
and up to 256 nodes from a severed island. Those reinserts use the current auto-scaled efC, so the
per-insert build multiplier can land hundreds of times within one delete.

## An approximate index returns at most `ef` rows, so `limit` has to reach it

Layer 0 keeps at most `ef` candidates, and ef resolves from the auto-scale, not from the query. A
`limit` above it came back short with no error: with the 512 cap no vector query could return more
than 512 rows however large the limit, and `{offset: 250, limit: 200}` returned zero rows, so
paginating a vector search past the first page returned nothing. `searchByIndex` threads the query's
`offset + limit` to the custom index as `minResults`, which widens the candidate list to cover the
request. Any future approximate index needs the same plumbing.

Two bounds keep that from becoming a new problem. `ef` drives a synchronous traversal that holds
every admitted candidate in a sorted array with an O(len) insert, so a limit-derived `ef` is capped
at `LIMIT_EF_MAX`; without it, ordinary deep pagination (`offset` in the millions) would walk the
whole graph on the event loop, which is worse than the truncation being fixed. And schema-level or
per-query `ef` values stay authoritative: each is an explicit cost ceiling, so it bounds the result
set rather than being raised by the limit. Only automatically scaled indexes widen toward
`LIMIT_EF_MAX` to satisfy a larger bounded request.

`LIMIT_EF_MAX` is the _only_ bound on the widening — deliberately not also the graph size. Clamping
there is tempting and costs more than it saves: the memoized size reads low while a table grows, so
it truncates the limit it was supposed to honour, and resolving a size exact enough to clamp against
puts a store lookup back on every query whose `limit` exceeds the table — the linear-in-N term this
whole change removed, reintroduced in miniature. An `ef` above the node count is free anyway: the
traversal is bounded by the nodes it can reach, so it ends at the graph, not at `ef`.

The filter budget deliberately does not follow a limit-derived `ef`. It is computed from the `ef`
the index resolved for itself, with an automatically scaled `ef` capped at `AUTO_EF_MAX` before it is
multiplied by `filterExpansion`; explicit schema or per-query `ef` values remain authoritative.
Multiplying the budget by a caller's `limit` would turn a filtered vector query into a record-loading
scan wearing an index's clothes.

Paging a vector search is best-effort, not a stable partition. Each page re-runs the approximate
search at a different `ef` (`offset 0, limit 250` resolves 250; `offset 250, limit 200` resolves 450),
and an HNSW candidate set at a larger `ef` is not guaranteed to be an ordered superset of the smaller
one, so a record can repeat across pages or be skipped. Honoring `limit` fixes the "second page is
empty" defect; it does not make offsets a cursor. Callers who need stability should fetch one page
large enough for the whole result set, or pin an explicit `ef`.

One consumer is still calibrated in index-store keys rather than nodes: `estimateCountAsSort`, the
planner's cost estimate for a vector sort. It is scaled by `INDEX_KEYS_PER_NODE` so the count-source
unit switch does not shift the estimate on its own. The ef term remains the configured search value,
not the runtime auto-scaled value, so the planner increasingly underestimates vector traversal cost
as an automatically scaled graph grows.

## Env-config empty objects mean three different things (`config/harperConfigEnvVars.ts`)

An `{}` in the config system is context-dependent, and conflating the contexts is the root of #2067. In an **env layer** (`HARPER_SET_CONFIG` et al.), an empty object contributes no leaves — `http: {}` means "no overrides under http" (load-bearing removal semantics in `flattenObject`). In the **base config file**, a bare `componentName: {}` is user content — a real empty scope declaration that composition must preserve (`restoreBaseEmptyObjects`, #1618/#1726). An `{}` that is _neither_ — the residue of removing an env-sourced entry leaf-by-leaf — is invalid config that validation may reject forever, because the file is written before validation runs and the residue then reads as user content on every later boot.

Removal therefore prunes: `deleteNestedValue` removes ancestors the deletion emptied, only when it actually deleted an existing leaf, and reports what it pruned. The overlap case — a file-declared empty scope an env layer temporarily populated — is tracked in the state file's `emptyScopeOriginals` (separate from `originalValues` so a marker can never mask or be consumed as a real leaf original at the same path; older state files lacking the field are defaulted). Restore consumes a marker only for a path the prune actually removed, so a scalar overwrite or an absent-leaf no-op can never resurrect a scope over live env-layer content. Note there are two coexisting mechanisms for "file `{}` is user content": `restoreBaseEmptyObjects` on the stateless compose path and the marker pair on the stateful removal path — if you touch one, check the other.

Two durable limitations of the marker mechanism, both with user config-file content as the blast radius: markers can only be recorded at populate time, so a scope an env layer populated _before_ `emptyScopeOriginals` existed (any pre-upgrade boot) has no marker and prunes away on its first post-upgrade vacate; and a corrupt config-state file resets to fresh state — dropping `originalValues` and `emptyScopeOriginals` for every tracked path — after which the next removal prunes those scopes for good; `saveConfigState` writes via temp+rename precisely so a torn write cannot be the trigger, leaving genuine corruption (disk faults, hand edits) as the remaining path.

## Every path handed to a native file watch must be canonicalized (`utility/watchPath.ts`)

libuv's Windows fs-event callback rebuilds each event's absolute path, expands it with
`GetLongPathNameW`, and asserts the expansion still starts with the directory it stored when the
watch was armed. An 8.3 short directory (`C:\Users\RUNNER~1\...`) never survives that comparison,
and libuv **aborts the process** rather than failing the watch — there is no JS-observable seam, so
`isWatcherExhaustionError`/polling recovery never runs (harper#2234).

The trap is that libuv only stores that directory for **file** targets, which reads as a narrow
surface until you follow chokidar: v4 opens a per-file `fs.watch` for every file it discovers inside
a watched tree, so one directory watch arms hundreds of file watches.

So `canonicalizeWatchPath` runs on every path before it reaches `fs.watch` (directly or through
chokidar), and returns `undefined` when it cannot establish the long form; `resolveWatchTarget` turns
that into `mustPoll`, and polling stats the file instead of arming a native watch. It resolves every
Windows path rather than only the ones that look short: `GetLongPathNameW`'s documentation is
explicit that a short name need not contain a tilde, so any spelling test leaves the abort reachable.
Plain `realpathSync` is not a substitute for the `.native` variant: it resolves symlinks but leaves
8.3 names intact — which also means Windows watch paths are symlink-resolved, matching what
`fs.watch` already does elsewhere by following a symlinked file to its target inode. A leaf that does
not exist yet resolves through its directory, because libuv stores and compares only the parent
directory of a file target.

New watch sites must go through it. As of this writing the sites are `components/EntryHandler.ts`,
`components/OptionsWatcher.ts`, `config/RootConfigWatcher.ts`, `security/keys.ts`,
`server/threads/manageThreads.js`, and `resources/blob.ts`. `fs.watchFile` (`utility/logging/readLog.ts`)
is stat polling with no fs-event handle and is outside this invariant.

Two consequences worth knowing before adding a caller. `EntryHandler` is the one place where the
canonical path is load-bearing past the `fs.watch` call: chokidar's `ignored` predicate receives
absolute paths built from `cwd`, so its bases must be derived from the same spelling, while event
paths are relative to `cwd` and reads stay on the configured `component.directory`. And a watcher
that degrades to polling stays there for its lifetime, so a caller with no polling story of its own
(`resources/blob.ts`) needs one — there it polls `readMore` on the existing no-progress deadline.

## No descriptor on the root config may outlive a turn (`config/configUtils.ts`, `config/RootConfigWatcher.ts`, `components/OptionsWatcher.ts`)

`atomicWriteFile` replaces `harper-config.yaml` by rename-over and retries `EPERM`/`EACCES` with a
synchronous `Atomics.wait`. On Windows a rename over an open destination fails, and a descriptor
belongs to the process, not the thread — measured on `windows-latest`/Node 24: a single Node read
descriptor on the destination blocks it, while `fs.watch` and chokidar handles do not.

That makes the retry unable to outlast a holder on the _calling_ thread, because the sleep blocks
the event loop whose turn would close it: the holder's lifetime becomes exactly the retry budget
and every attempt fails. This is why widening the budget (#1714, #2036) never fixed the
`set_configuration` 500s it was aimed at, and why both root-config watchers read with
`readFileSync`. Any future `fsPromises.readFile` of this file reintroduces harper#2313 — the rule
is unenforced by anything but this note and the comment on `atomicWriteFile`.

The synchronous read then sees writers mid-write, which promise-based reads mostly skipped. A read
that is unusable — empty, or parsing to anything but an object — is retried by `PartialReadRetry`
(`utility/watcherFallback.ts`) rather than adopted, because chokidar may emit nothing further for
that write. Completeness is judged on the file's own parse, _before_ `overlayRootEnvConfig`, which
returns a non-null object whenever a config env var is set and would otherwise launder a
half-written file into a valid-looking env-only config. Its three outcomes are distinct and each
one matters: a usable read withdraws the file's give-up report and restores the budget; giving up
restores the budget (the write that repairs the file can itself be read mid-write) but leaves the
report standing, since it is shared with every other watcher of that file; closing is terminal.

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
