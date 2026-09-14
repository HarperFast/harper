# Full-text derived-index backend

Storage direction updated September 14, 2026:
[Native Tantivy storage and Harper derived indexes](https://github.com/HarperFast/fulltext/blob/codex/native-storage-design/docs/native-storage-integration.md).
The backend below uses native Tantivy files. Harper's RocksDB transaction log remains authoritative;
the local full-text directory is a rebuildable, independently published projection.

## Objective

Implement the Harper state machine and native generation lifecycle that adapt an asynchronous
Fulltext owner runtime to `DerivedIndexBackend`. This unit covers owner acquisition, bounded ordered
delivery, barrier publication, durable-cursor recovery, crash-safe generation replacement, owner
fencing, shutdown, and reset. It does not yet wire a customer schema or query API.

The implementation is stacked on
[Shared derived-index runtime for native backends #2567](https://github.com/HarperFast/harper/pull/2567)
and keeps Fulltext behind structural engine, encoder, and generation-lifecycle interfaces. The
production loader is present, while tests inject a structural module until Fulltext has a versioned
prerelease with supported platform binaries. Harper will exact-pin that release as an optional
dependency in the schema-integration unit.

## Architecture

```text
authoritative Harper transaction
              |
              v
    DerivedIndexRuntime (RocksDB cursor/election/replay protocol)
              |
              v
 FullTextDerivedIndexBackend (bounded FIFO apply/publish state machine)
              |
              v
 @harperfast/fulltext/native (one Tantivy writer for the owned index)
              |
              v
 <store>/<index-hash>.fulltext/
   CURRENT ---------------------> generations/<uuid>/  (selected native index)
   STORE.json                    generations/<old-uuid>/ (retired, reclaimed)
```

RocksDB does not store Tantivy terms, postings, segments, or documents. Each source node and replica
builds the same logical index from the authoritative records and transactions it receives. A native
publication commits the searchable Tantivy generation and its Harper replay cursor together.

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
- Fulltext's native runtime exposes asynchronous `apply`, `publish`, and `close`; publication commits
  the payload and reloads the owner reader. Harper uses this native facade directly. The hosted
  RocksDB storage provider is retired.

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

`open()` reopens the physical generation named by `CURRENT`. `replace()` creates a cursorless
generation, durably switches `CURRENT`, returns the new open engine, and reclaims retired
generations. Harper uses Fulltext's public native factory; this adapter does not implement Tantivy
storage.

`NativeFullTextDerivedIndexLifecycle` derives a fixed-length directory name from the logical store
name, records the readable store name in `STORE.json`, and stores physical generations under random
UUIDs. `CURRENT` is versioned JSON containing the physical UUID and a hash of Harper's source-table
generation identity. Control files are created with mode `0600` inside `0700` directories. A selector
is published as a temp-file write, file `fsync`, Harper's bounded rename retry, and parent-directory
`fsync` where the platform supports directory handles. The rename retry is capped at 15 ms so index
activation cannot park a worker for the general configuration writer's multi-second retry budget.

Before selecting a new generation, the lifecycle syncs the native generation directory and its
parent. A crash before the selector rename leaves the old generation selected. A crash after the
rename selects the new cursorless generation, so recovery rebuilds it from Harper. Replacement never
deletes or modifies the selected generation first. Cleanup accepts only strict UUID child paths and
runs after selection; the next open also sweeps non-selected generations, bounding crash leftovers.

Missing `CURRENT` is a rebuild signal; `open()` stays read-only and the existing condemn/reset path
calls `replace()` once to create the first cursorless generation. Invalid selector metadata, a
mismatched source identity, a missing selected directory, and Fulltext's
`E_IDENTITY_MISMATCH`, `E_INCOMPLETE_CREATE`, or `E_SCHEMA_MISMATCH` errors condemn the generation and
enter Harper's rebuild protocol without consuming transient acquisition retries. Lock contention,
missing binaries, permission errors, and `E_STORAGE` remain non-destructive acquisition failures.
Replacement repairs a malformed `STORE.json` written by Harper, but rejects a valid metadata file
that names another store or a newer format.

The encoder collaborator accepts the Harper mutation input and returns Fulltext's packed batch. The
backend owns the mapping from `DerivedIndexBatch.records`; it never serializes the batch object.
A native `E_BATCH_TOO_LARGE` multi-record batch is split and retried without changing ordering. A
single oversized upsert becomes a removal so stale text cannot remain searchable and increments
Harper's `unindexableRecords` metric; a delete that cannot be encoded still fails closed. Other
invalid arguments remain terminal. A transient encoder failure rolls back and replays accepted work.
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

`reset(newEpoch)` calls `replace(newEpoch)` only after the runtime has shut down the old owner and
persisted its condemnation marker. The lifecycle creates and opens a new physical generation before
atomically selecting it. It does not reopen, tombstone, or mutate the old generation. The returned
replacement must have no committed cursor; otherwise reset fails closed. It stays open for rebuild
delivery under the new epoch. Harper's shared runtime remains the only rebuild scanner and replay
coordinator.

## Native publication and unrelated source traffic

Native Tantivy publication writes no segment bytes through Harper RocksDB and therefore creates no
derived-storage root-commit feedback. Unrelated authoritative writes
can still wake derived runners and advance cursor-only progress. Native commits and reader reloads
for those boundaries still need measurement under the existing bounded flush policy.

Native storage does not justify a new source-log signal or RocksDB primitive. The real-Rocks test
uses Harper's authoritative table and audit log while a deterministic native module owns derived
documents outside RocksDB; this proves the integration does not feed its own storage writes back
through the source log.

## Verification

- Runtime tests prove commits cannot drain during asynchronous acquisition, stop settles acquisition
  before shutdown and unlock, existing synchronous backends retain their path, and idle release can
  close and reopen without rebuilding. They also prove explicit rebuild waits for acquisition,
  asynchronous cursor-install failures are contained, transient failures recover, and persistent
  failures become observable `unavailable` state at the configured cap.
- Backend tests prove bounded asynchronous encoding, FIFO barrier horizons, repeated `through`
  values, exact barrier snapshots, physically ordered non-monotone timestamp values, cursor-only
  native bypass and bounded publication coalescing, deferred wake-up, and fail-closed behavior.
- Cursor tests cover decimal RocksDB audit positions, malformed and oversized payloads, restart
  recovery, and publication/readback ordering.
- Failure tests cover one-channel reporting for synchronous failures, recoverable apply and ambiguous
  publish failures, reopen-before-notify, unreopenable generations, late opens after revocation, and
  retry after quiescence failure.
- Shutdown/reset tests prove clean close, cursor clearing, reopen on a later owner epoch, atomic
  replacement without opening the retired generation, and an open cursorless replacement.
- Lifecycle tests cover restart reuse, source-identity mismatch, bounded selector replacement,
  traversal-safe cleanup, orphan reclamation, malformed-metadata repair, native module validation,
  and persistent-versus-transient native error classes. Child processes are killed before and after
  selector publication for both first activation and replacement of an existing selected index.
- The end-to-end route runs the production lifecycle and backend through a real
  `DerivedIndexRuntime`, authoritative Harper RocksDB table, and deterministic structural native
  module. The packed Fulltext artifact remains the final binary-integration gate.

## Approaches considered

| Axis                    | Candidate and disposition                                                                                                                                                                                                                                                                   |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Different layer         | Store queue and cursor state in `DerivedIndexRuntime`. Rejected because encoding, publication atomicity, native recovery, and queue capacity are engine-adapter responsibilities; making the shared runtime aware of Fulltext would duplicate its backend contract.                         |
| Deeper cause            | Keep the Fulltext runtime open after owner release. Rejected because `shutdown()` must prove no native task or storage callback can write after unlock, and an open writer prevents another worker from opening the same generation.                                                        |
| Do less                 | Keep the existing contract and reopen before initial registration only. Rejected because the same registration reacquires after every idle release without running registration again, so its synchronous cursor read would force rebuild after the first close.                            |
| Cursor outside Fulltext | Store a second cursor in the root store so acquisition can read it synchronously. Rejected because it does not reopen the engine or prove that its searchable generation matches that cursor; both values would need reconciliation, leaving the missing async acquisition boundary intact. |
| Split lifecycle         | Add a separate backend `close()` and make `shutdown()` leave the writer open. Rejected because owner handoff, not only process shutdown, must close the writer before another worker can own it.                                                                                            |
| Chosen                  | Add an optional generic `acquire(ownerEpoch)` hook before the runtime's cursor read, and keep open/close/recovery inside the Fulltext backend. It is the only option that preserves one shared election/replay protocol while proving handoff quiescence across workers.                    |
