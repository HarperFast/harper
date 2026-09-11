# Full-text derived-index backend

## Objective

Implement the package-independent Harper state machine that adapts an asynchronous Fulltext owner
runtime to `DerivedIndexBackend`. This unit covers owner acquisition, bounded ordered delivery,
barrier publication, durable-cursor recovery, owner fencing, shutdown, and reset. It does not wire a
customer schema, query API, database lifecycle, or unpublished `@harperfast/fulltext` package.

The implementation is stacked on
[Shared derived-index runtime for native backends #2567](https://github.com/HarperFast/harper/pull/2567)
and keeps Fulltext behind structural engine, encoder, and generation-lifecycle interfaces. Unit
tests run with a deterministic engine. A real Fulltext artifact remains an opt-in integration input
until the package has a versioned prerelease with supported platform binaries.

## Invariant

A durable cursor returned to Harper is a validated cursor from an accepted batch and describes no
mutation that is absent from the same published, searchable Fulltext generation. After shutdown
begins for an owner epoch, no command from that epoch may apply or publish.

## Existing contracts verified in code

- `DerivedIndexRuntime` elects one owner per backend id and mints an epoch before reading the
  backend cursor (`resources/derivedIndexRuntime.ts`). Backends that do not need asynchronous owner
  setup retain a synchronous path.
- Idle release calls `flush('shutdown')`, awaits `shutdown(epoch)`, and unlocks only after shutdown
  resolves. A later commit can reacquire the same registration without registering it again.
- `deliver()` is synchronous. Accepted batches remain backend-owned until their cursor becomes
  durable or the backend reports `accepted-work-lost`.
- `RocksDerivedIndexStorage.write()` uses the existing root transaction and therefore raises the
  same process-wide `committed` notification as other RocksDB transactions.
- Fulltext's Harper runtime exposes asynchronous `apply`, `publish`, and `close`; `publish` commits
  the payload and reloads the owner reader before resolving. Its package is not present in the npm
  registry as of 2026-09-11.

## Required shared-runtime correction

The current backend contract cannot safely close an asynchronous native writer at handoff and then
reopen it on the next ownership acquisition: the runtime reads `getDurableCursor()` before any
awaitable hook. Keeping the writer open after `shutdown()` would not prove native and storage
quiescence, and it would prevent a different worker from opening the same physical generation.

Add an optional
`acquire(ownerEpoch): DerivedIndexCursor | undefined | Promise<DerivedIndexCursor | undefined>`
backend hook. The elected runner calls it after minting the epoch and uses its result before opening
the transaction-log iterator. A backend without the hook keeps the current synchronous
`getDurableCursor()` path with no Promise or microtask. The runner holds its lock and gates drains
while an asynchronous acquisition settles. Stop or release waits for the acquisition to settle
before requesting the shutdown flush, so an opener cannot install a handle after the lock is
released.

`acquire()` is an owner-lifecycle hook, not another election mechanism. It does not read source
records, choose a generation, or advance progress. Fulltext uses it only to open the generation and
validate its committed payload. It retries transient open failures within a bounded policy before
rejecting. A rejection is treated as transient: the runtime releases ownership and retries after
its existing rebuild backoff without condemning the generation. After the configured acquisition
attempt cap, the runtime publishes `unavailable` rather than silently retrying or destructively
rebuilding an index it could not inspect. A successfully opened generation with a missing or invalid
commit payload returns no cursor and enters rebuild. A never-settling
acquisition intentionally prevents shutdown and lock release because quiescence cannot be proved.
While a transient acquisition failure is waiting for retry, shared readiness is `unknown` with an
`acquisition-failed` reason rather than retaining a stale `ready` state. The attempt cap is local to
each runner; whichever contender reaches it first publishes the shared terminal state.
`reset(newEpoch)` already runs inside a separately minted epoch and returns with the replacement
generation open, so the runtime does not call `acquire()` again during that rebuild attempt.

## Backend boundary

The backend accepts these structural collaborators rather than importing the unpublished package:

```ts
interface FullTextDerivedIndexEngine {
	readonly committedPayload?: string;
	apply(batch: Uint8Array): Promise<number>;
	// Success proves the payload and every preceding mutation are durably ordered together.
	publish(payload: string): Promise<bigint>;
	close(options?: { mode?: 'require-clean' | 'rollback' }): Promise<void>;
}

interface FullTextDerivedIndexLifecycle {
	open(ownerEpoch: bigint): Promise<FullTextDerivedIndexEngine>;
	replace(ownerEpoch: bigint): Promise<FullTextDerivedIndexEngine>;
}
```

`open()` reopens the currently selected physical generation. `replace()` performs the externally
coordinated generation replacement and returns the new open engine. The production implementation
will own `RocksDerivedIndexStorage`, physical-generation metadata, and database lifecycle ordering;
this unit neither opens a column family nor adds a global close hook.

The encoder collaborator accepts the Harper mutation input and returns Fulltext's packed batch. The
backend owns the mapping from `DerivedIndexBatch.records`; it never serializes the batch object.
Only string and string-array projection fields are forwarded. Other values are omitted so one
schema-drifted record cannot poison a batch; the later schema integration validates configured
attributes at the projection boundary so Harper can count them as unindexable.
The shared runtime carries the canonical `writeKeyId()` string it already computes into each
mutation, avoiding a second ordered-binary encode during a catalog rebuild. Record ids base64url
encode that string's bytes and use `<decimal table id>.<key>`; `.` is outside the base64url alphabet,
so adjacent table ids cannot collide. Audit and scan entries whose canonical key is not a string are
Harper-internal entries, not records; replay and rebuild both skip them while still advancing past
their transaction boundaries.

## Ordered command state machine

`deliver()` performs only validation, a count-and-byte capacity check, and enqueue. Encoding and
native work run later from one ordered drain. The queue has independent maximum batch and byte
limits; bytes use Harper's batch estimate and every batch consumes one slot, including cursor-only
batches. A batch that cannot fit even in an empty configured queue fails closed rather than deferring
forever. When a prior deferral may have occurred, capacity release schedules `changed` on a later
macrotask.

Each accepted apply receives a local sequence. A barrier captures, at request time:

- the last accepted sequence;
- the most recent `batch.through` object at or before that sequence, including a repeated cursor;
  and
- the current owner epoch.

The drain applies commands in FIFO order. A cursor-only command advances ordering without encoding
or crossing into the native apply path; emptiness is based on source records rather than encoded
upserts and deletes because an unindexable source record becomes a delete. The backend never derives
a cursor from a sequence or merges cursor vectors. A barrier publishes only the captured cursor, or
a cursorless payload when a rebuild generation has not yet received its final `through`. Replayed
documents remain idempotent by canonical document id.

`flush(reason)` queues or coalesces a barrier and returns `void`. By default every request queues the
latest eligible horizon. An optional cursor-only policy can publish on every Nth `age` request, with
a hard elapsed-time cap checked on those existing requests. It adds no timer. A real mutation,
`threshold`, or `shutdown` request forces the barrier. The count defaults to one, is capped at 16,
and the elapsed bound is capped at 60 seconds; schema activation must validate the resulting
wall-clock replay window against the same resolved flush age and effective lag budget used by the
runtime registration. The barrier horizon is claimed only when the command is actually queued.
Async apply/publication results are reported through `onStateChange`; a transient barrier rejection
must not enter the runtime's `flush()` rejection path, which treats it as a permanent backend failure.

The commit payload is versioned JSON with either one complete `DerivedIndexCursor` or `null` for a
cursorless generation. Parsing enforces a byte limit, the payload version, cursor format, a plain
logs object, non-empty non-reserved log names, and positive finite timestamps before
caching. The validated logs map is copied to a null-prototype object. Log names are data only and
never become paths, symbols, namespaces, or store names. The cached cursor is a frozen clone
populated only by successful open or publication and never regresses to `undefined` within an
active epoch.

## Failure and fencing behavior

The backend maintains an active local epoch in addition to `host.isOwnerEpoch()`. `shutdown(epoch)`
stops new delivery and joins all accepted work before the runtime releases the owner lock. A recovery
reopen that completes during shutdown is closed by that same join before another worker can acquire.
A revived held-lock path can re-arm the same numeric epoch only through a fresh `acquire()` call.

Every apply, barrier, recovery installation, reset, and shutdown checks both fences before and after
its asynchronous boundary. A recoverable apply or publish failure discards later queued work,
rolls back or closes the poisoned engine, reopens the same physical generation, validates its
payload, caches the recovered cursor, and only then emits `accepted-work-lost`. The runtime replays
from that cursor. Failure to close sufficiently to prove quiescence makes `shutdown()` reject and
keeps the runner lock held. A closed and quiescent but corrupt generation emits `failed`; its later
shutdown may resolve so the runtime can enter rebuild.

Failures already returned by `deliver()` or rejected by `reset()`/`shutdown()` mark the backend
failed without also scheduling a state callback. Drain and recovery failures have no synchronous
channel and emit one `failed` callback. This keeps one physical fault from spending two runtime
rebuild attempts.

State notifications always run in a later macrotask. The backend never re-enters the runtime from an
engine callback or synchronous host-storage callback, and it does not wake a runner whose shutdown
is already joining the drain.

## Shutdown and reset

`shutdown(epoch)` stops accepting that epoch immediately and joins the ordered drain. The shutdown
barrier publishes the latest eligible cursor. If accepted work after that cursor cannot be
published, close uses rollback and leaves the previous committed payload for replay. Shutdown clears
the in-memory cursor only after native close proves that no task or callback can touch storage.

`reset(newEpoch)` attempts to open the old generation, publishes a cursorless tombstone, and closes
it before calling `replace(newEpoch)`. If the old generation is unopenable, replacement still
proceeds: the lifecycle collaborator must durably select the new cursorless physical generation
before it drops or mutates the old one. If an opened generation cannot publish its tombstone or
prove close, reset stops before replacement. The returned replacement must have no committed
cursor; otherwise reset fails closed. The replacement stays open for rebuild delivery under the new
epoch.

Physical generation naming, metadata, orphan cleanup, and column-family drop remain the lifecycle
collaborator's responsibility and are implemented with the real package integration. Harper's
shared runtime remains the only rebuild scanner and replay coordinator.

## RocksDB committed-notification amplification

The hosted-storage benchmark records total root `committed` events, but the current runtime cannot
identify which event advanced a source transaction log. Derived Fulltext writes can consequently
wake every registered runner. This unit adds a real `RocksDerivedIndexStorage` plus fake-engine test
that measures the behavior; it does not conceal the notification or claim production readiness.

Before schema activation, the backend-integration benchmark must measure empty drains per
publication window. If the architecture gate is exceeded, the chosen mitigation is a generic
source-log commit signal owned by `RocksTransactionLogStore`, not a Fulltext special case: one
post-commit shared notification per transaction that actually appended source log entries. That
change requires its own hot-path measurement because it touches every audited commit. A new
rocksdb-js primitive and per-publication polling are not assumed.

## Verification

- Runtime tests prove commits cannot drain during asynchronous acquisition, stop settles acquisition
  before shutdown and unlock, existing synchronous backends retain their path, and idle release can
  close and reopen without rebuilding. They also prove explicit rebuild waits for acquisition,
  asynchronous cursor-install failures are contained, transient failures recover, and persistent
  failures become observable `unavailable` state at the configured cap.
- Backend tests prove bounded asynchronous encoding, FIFO barrier horizons, repeated `through`
  values, exact barrier snapshots, monotone cursors, cursor-only native bypass and bounded
  publication coalescing, deferred wake-up, and fail-closed behavior.
- Cursor tests cover decimal RocksDB audit positions, malformed and oversized payloads, restart
  recovery, and publication/readback ordering.
- Failure tests cover one-channel reporting for synchronous failures, recoverable apply and ambiguous
  publish failures, reopen-before-notify, unreopenable generations, late opens after revocation, and
  retry after quiescence failure.
- Shutdown/reset tests prove clean close, tombstone-before-replacement, cursor clearing, reopen on a
  later owner epoch, replacement of an unopenable old generation, and an open cursorless replacement.
- A RocksDB integration test pairs real `RocksDerivedIndexStorage` with a deterministic fake engine,
  owns close ordering explicitly, and records root notification amplification. It does not represent
  native callback or Tantivy coverage.
- End-to-end route: the package-independent backend runs through a real `DerivedIndexRuntime` and
  real Harper RocksDB storage with the deterministic engine. The optional packed-artifact harness
  remains the only current Tantivy/host-callback route and must be reported separately.

## Approaches considered

| Axis                    | Candidate and disposition                                                                                                                                                                                                                                                                   |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Different layer         | Store queue and cursor state in `DerivedIndexRuntime`. Rejected because encoding, publication atomicity, native recovery, and queue capacity are engine-adapter responsibilities; making the shared runtime aware of Fulltext would duplicate its backend contract.                         |
| Deeper cause            | Keep the Fulltext runtime open after owner release. Rejected because `shutdown()` must prove no native task or storage callback can write after unlock, and an open writer prevents another worker from opening the same generation.                                                        |
| Do less                 | Keep the existing contract and reopen before initial registration only. Rejected because the same registration reacquires after every idle release without running registration again, so its synchronous cursor read would force rebuild after the first close.                            |
| Cursor outside Fulltext | Store a second cursor in the root store so acquisition can read it synchronously. Rejected because it does not reopen the engine or prove that its searchable generation matches that cursor; both values would need reconciliation, leaving the missing async acquisition boundary intact. |
| Split lifecycle         | Add a separate backend `close()` and make `shutdown()` leave the writer open. Rejected because owner handoff, not only process shutdown, must close the writer before another worker can own it.                                                                                            |
| Chosen                  | Add an optional generic `acquire(ownerEpoch)` hook before the runtime's cursor read, and keep open/close/recovery inside the Fulltext backend. It is the only option that preserves one shared election/replay protocol while proving handoff quiescence across workers.                    |
