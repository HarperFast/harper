# Full-text derived-index integration on current main

Status: backend slice implemented and verified against current Harper `main` and the merged Fulltext
wrapper tree; dependency pinning, activation, query integration, and packaged native CI are follow-up
gates · Owner: Kyle · Last verified: 2026-09-19

The canonical runtime architecture is the **Native full-text backend** section in `DESIGN.md`. This
note records implementation sequencing, rejected alternatives, verification, and remaining gates; if
the two documents conflict, `DESIGN.md` is authoritative.

## TL;DR

- Harper owns replay, ownership, readiness, rebuild, and schema/table lifecycle.
- Fulltext owns Tantivy files, mutation encoding, its exclusive writer, publication, reset, and reclamation.
- This slice adds an inert backend adapter without changing the shared runtime, HNSW, tables, or databases.
- Native files are reused after restart; missing or incompatible files rebuild from Harper records before
  full-text queries become available.
- Activation waits for an exact Fulltext package pin, cross-platform native-load CI, operator-visible
  wrapper rejection metrics, and a non-condemning result for transient inspection failure without a
  cached checkpoint.

## Intent

Replace the conflicted full-text backend stack with a current-`main` implementation that uses
Tantivy's native files as node-local derived state. Harper remains authoritative for records,
transaction-log replay, ownership, readiness, rebuild policy, and schema lifecycle. The Fulltext
package remains Harper-agnostic and owns native mutation encoding, its single writer, publication,
inspection, reset, and retired-directory reclamation.

This first unit replaces the conflicted implementation in
[Add a full-text derived-index backend #2569](https://github.com/HarperFast/harper/pull/2569).
Schema declaration and runtime activation remain stacked follow-ups. Its required wrapper API landed in
[Add exact native mutation batch partitioning #37](https://github.com/HarperFast/fulltext/pull/37).

## Current-main facts

- `resources/derivedIndexRuntime.ts` is the only Harper delivery protocol. It elects one runner per
  backend, replays committed transaction logs from exact cursors, bounds accepted work, schedules
  durability barriers, rebuilds from authoritative records, and publishes shared readiness and
  coverage.
- `resources/indexes/hnswDerivedIndex.ts` is the reference consumer. Its current registration path
  includes generation settlement, immutable-table-id drop fencing, failed-drop restoration,
  unavailable-generation retry, durability-barrier throttling, and query coverage. Those behaviors
  landed on `main` after the full-text stack branched.
- The HNSW package owns its mmap file and durability primitives but contains no Harper transaction-log,
  schema, replication, or table-lifecycle code. Harper's HNSW adapter supplies those policies.
- Fulltext `main` provides native inspection, reset, lazy writer open, apply, publish, and rollback
  close. [Add exact native mutation batch partitioning #37](https://github.com/HarperFast/fulltext/pull/37)
  added exact logical mutation-batch partitioning, replacement deletes for
  rejected upserts, retired-directory reclamation, and the API version Harper's adapter expects.
- The conflicted backend branch changes the shared runtime, table/database lifecycle, and HNSW
  adapter. Applying those files over current `main` would remove newer HNSW behavior.

## Invariant

Adding a full-text backend must not change the derived-index protocol or weaken an existing backend:
Harper offers committed work once per elected epoch, and a backend advances its cursor only with the
native state made durable by the same publication barrier.

## Chosen design

### Backend PR

The branch reconstructs
[Add a full-text derived-index backend #2569](https://github.com/HarperFast/harper/pull/2569)
from current `main` rather than resolving its conflicts commit by commit.

The backend slice:

1. Adds a `DerivedIndexBackend` adapter under `resources/indexes/` and a lazy optional Fulltext binding
   modeled on the HNSW binding. The adapter reads `batch.records` by named property; it never spreads,
   enumerates, or serializes `DerivedIndexBatch`, whose `records` and `bytes` properties are deliberately
   non-enumerable.
2. Queues each accepted runtime batch and applies it in bounded adapter-owned slices. Fulltext owns exact
   encoding, native frame partitioning, rejected-upsert replacement deletes, and writer state, but one
   native call never receives the entire 4,096-record runtime chunk. The cursor is publishable only
   after every slice from that runtime batch has completed.
3. Inspects the selected Tantivy generation synchronously at the ownership-acquisition read and caches
   that value only for the acquisition. Opens the exclusive writer lazily on first delivery or publication.
4. Publishes the Harper cursor as Tantivy's commit payload after accepted mutations. On apply or
   publication failure, rollback-close, discard queued work, and report accepted work lost so the
   runtime resumes from the durable payload.
5. Preserves every field in the current `DerivedIndexCursor`, including optional coverage, when
   encoding and decoding the native commit payload. A normal publication merges any coverage already
   stored in the durable payload because the runtime's `batch.through` clone intentionally omits it.
   The backend does not implement `publishCoverage`; query coverage arrives with the query
   integration. Ordinary replay still publishes cursor-only progress for transactions that do not
   change indexed records, because advancing the replay cursor prevents needless reprocessing and
   protects transaction-log retention.
6. Uses the runtime's existing rebuild and condemnation protocol. Fulltext owns reset, invalid native
   generation classification, and retired-directory cleanup.
7. Leaves `derivedIndexRuntime.ts`, table/database lifecycle, and HNSW unchanged. The adapter derives
   its stable document key from `tableId` and the record id's ordered-binary storage-key bytes, rejects
   symbol identities, and pays that encoding only on the full-text path. No activation or query policy
   belongs here.
8. Treats native writer-open errors as retryable unless their stable code proves the generation is
   structurally incompatible or corrupt. Retries use exponential backoff to a five-second ceiling and
   emit one content-free warning when writer unavailability persists. Per-record
   encoding failures, including oversized fields and invalid array contents, are returned by Fulltext's
   logical-batch API as rejected upserts, replaced by deletes, counted, and warned once without record
   values. Native paths and native error messages are not logged; adapter-authored messages and stable
   native error codes are.
9. Makes `shutdown(epoch)` queue a final barrier, drain accepted work, epoch-fence publication, and then
   settles the writer. The whole shutdown wait and native close are bounded at the adapter boundary. Shutdown may reject
   only when quiescence cannot be proven; the runtime then deliberately holds the runner lock rather
   than allowing two native writers. A timeout does not cancel or forget native work; it makes the
   unproven state observable instead of hanging worker shutdown indefinitely.

### Review-response investigation

The final review exposed three lifecycle cases that the earlier tests did not model. The owning
invariant is: each elected owner must discover the current native checkpoint before replay, temporary
writer unavailability must not destroy a valid derived index, and an ownership handoff must settle
within a bound without unlocking an unproven writer.

- **Current behavior:** at Harper branch commit `28f970d25`, the two focused tests named “retains its
  cached durable cursor across ownership changes” and “fails after exhausting the bounded writer-open
  retry budget” pass. Those tests encode the defects: an idle backend keeps its construction-time
  cursor after another owner publishes, and three ordinary open failures inside roughly 20 ms
  permanently fail the backend.
  The adapter does not exist on `origin/main`, so the fails-on-base comparison for the corrections uses
  this pre-fix feature-branch commit rather than Harper `main`.
- **Mechanism:** `DerivedIndexRuntime.#acquired()` asks `getDurableCursor()` before replay. HNSW reads
  its durable cursor from storage on every call; the full-text adapter currently returns its cached
  constructor value. `shutdown()` starts only after `#drain()` settles, so a native open, apply, or
  publish promise that never settles also prevents the existing close timeout from running.
- **Dependency evidence:** merged Fulltext commit
  [`ecbb7a5`](https://github.com/HarperFast/fulltext/commit/ecbb7a51e5b0fa929079b1de54cb1018f94b83b6)
  reports mutation-batch API v3. Its
  [`AppliedFullTextMutationBatch.processed`](https://github.com/HarperFast/fulltext/blob/ecbb7a51e5b0fa929079b1de54cb1018f94b83b6/ts/native.ts#L115-L121)
  contract and
  [`applyMutationBatch`](https://github.com/HarperFast/fulltext/blob/ecbb7a51e5b0fa929079b1de54cb1018f94b83b6/ts/native.ts#L203-L294)
  implementation count every consumed logical mutation, including a rejected upsert replaced by a
  delete. Harper's strict equality check is therefore the v3 contract guard, not a second accepted
  interpretation. The activation gate must still execute that contract against the packaged native
  module in CI.

### Review-response design

The backend defers its first inspection until `getDurableCursor()` is called at acquisition, caches that
result for the acquisition, and invalidates the cache on every shutdown path, including an owner that
received no batch. This yields one synchronous native metadata read per acquisition rather than one per
idle cursor poll. A refresh failure never uses the cached checkpoint: the shared runtime can publish
`ready` before lazy writer-open reconciliation, so the adapter cannot prove that cached state still
matches the files. Inspection failure propagates because the shared protocol has no non-condemning
unknown-cursor state. A reset keeps its deliberately cursorless result cached even when reset fails,
because an unknown reset outcome must not rediscover and trust the pre-reset checkpoint. The current
host contract exposes only `isOwnerEpoch(candidate)`, not the current epoch, so a backend cannot key this
cache directly from `getDurableCursor()`; invalidation through the mandatory `shutdown(epoch)` boundary
is the narrow equivalent.

Writer open keeps the existing small immediate retry burst. After that burst, every error uses the
existing exponential retry timer unless its code proves the native generation is structurally
incompatible or corrupt: schema, identity, incomplete creation, index corruption, or format
incompatibility. Configuration, binding, process-state, and unknown codes retry by default. They may
require operator action or process restart, but they do not prove the files should be reset. The
activation gate will assert the expected terminal and retryable codes against the packaged wrapper, and
must not enable a write-lag rejection budget without exposing prolonged open retry in status.

Every `shutdown(epoch)` caller gets a bounded wait around the shared internal shutdown operation. A
timeout rejects the handoff, which makes `DerivedIndexRuntime` retain its lock and report unavailable
node-wide; recovery requires the native work to settle followed by operator retry, or process restart
if it never settles. The underlying drain and close continue so the adapter never treats a timed-out
native operation as cancelled or quiescent. This intentionally prices safety above availability: the
current shared protocol has no non-condemning `stalled` result, and resolving would let the same backend
object reacquire with its prior epoch's engine and mutable queue still active.

The record conversion loop avoids `Object.entries()`, the second `Object.keys()` emptiness scan, and a
duplicate scan of array contents. It preserves the own-enumerable-property rule and returns no field
map when no string or array field exists. Fulltext validates array contents while performing the exact
frame encoding it already owns; Harper does not repeat that work on the event loop.

Wrapper rejection counts remain adapter-owned in this inert slice. Activation must add them to the
operator-visible derived-index metrics before the index can be enabled; changing the shared runtime
interface solely for an adapter that nothing constructs yet would widen this PR without making the
metric observable.

Committed cursor decoding uses Harper's fixed 64 KiB format bound rather than the current publication
limit. Lowering the publication limit therefore preserves an existing valid checkpoint. If a future
cursor cannot fit, the adapter rollback-closes accepted work, reports it lost once, and then defers
delivery without condemning the generation; reset cannot make the cursor smaller.

### Stacked follow-ups

The schema PR will declare and validate `@fullText` without activating a native writer.

The activation PR will be redesigned against current `main`. It may extract registration coordination
only after preserving the HNSW characterization tests for generation replacement, coverage, drop,
failed-drop restoration, and unavailable-generation recovery. HNSW-specific coverage/barrier policy
stays in the HNSW adapter; Tantivy-specific writer policy stays in the full-text adapter.

The query PR will reuse the runtime's readiness and coverage model. Readiness answers whether the
generation is usable; coverage answers whether it is sufficiently current for a request. The initial
full-text policy can be strict without creating another freshness protocol.

Activation will also choose and benchmark full-text-specific runtime flush thresholds. The backend
honors every runtime flush as a native durability barrier; changing that meaning inside the adapter
would violate the shared protocol. The thresholds therefore control the tradeoff between Tantivy
publication cost, rebuild throughput, replay work after a crash, and transaction-log retention.

## Approaches considered

### Different layer: implement Harper replay and lifecycle in Fulltext

Rejected. The package has no authoritative record store, transaction-log cursor source, worker lock,
schema generation, or table-drop identity. Adding those concepts would couple the standalone package
to Harper and duplicate the protocol already implemented by `DerivedIndexRuntime`.

### Different layer: make full-text an ordinary transactional secondary index

Rejected. Tantivy mutation and segment publication cannot participate atomically in the record's
RocksDB transaction. Performing the native work on the commit path would add indexing latency and still
need a replay cursor after a process failure between the two storage engines.

### Deeper cause: replace the current runtime and HNSW registration with the older combined module

Rejected. A final-file comparison shows that this removes current-main HNSW coverage publication and
waiting, barrier interruption and idle throttling, generation settlement, failed-drop restoration,
and unavailable-generation recovery. Those are existing correctness and performance contracts, not
merge-conflict noise.

### Do less: keep the old backend commits and resolve only textual conflicts

Rejected. The conflicting files changed semantically on both sides, and the old branch modifies
shared lifecycle code that the backend slice no longer needs. A textual rebase would preserve obsolete
runtime hooks and make it difficult to prove that current HNSW behavior survived.

### Do less: derive the document key in the adapter and change nothing shared

Chosen for this backend slice. The adapter uses the same ordered-binary encoder as Harper's stores,
and the encode occurs only for records headed to full-text. This avoids adding an allocation to every
HNSW mutation and keeps the PR inert until activation. Symbol identities are skipped explicitly so
replay and rebuild produce the same document set.

### Performance boundary: hand the whole runtime batch to Fulltext

Rejected. The runtime can offer 4,096 records, and its turn budget cannot bound work performed after
`deliver()` returns. The adapter retains the queue and applies smaller logical batches in bounded turns;
Fulltext still owns byte-exact frame partitioning inside each call.

### Performance boundary: extract a shared queued-native-backend base from HNSW

Rejected for the first backend PR. The common seam is not stable: HNSW applies individual graph
mutations around mmap barriers, while Fulltext applies logical document batches through one exclusive
Tantivy writer. A base class derived from one implementation would either expose backend-specific state
or erase the ordering rules this review needs to see. The duplicated queue pattern can be reconsidered
after both adapters have production measurements.

### Coverage timing: publish full-text query coverage now

Rejected. `publishCoverage` activates additional committed-position sampling and publication so a
query can prove freshness even when replay has no new transaction cursor to publish. The backend
preserves existing coverage in cursor payloads, but the query PR owns that policy and its extra
publication cost. This does not eliminate ordinary cursor-only publications while replay advances
past unrelated transactions.

### Chosen: reconstruct the backend slice from current main

This keeps the first PR inside its ownership boundary with no shared runtime or HNSW production-code
change. It beats the other options because current HNSW remains unchanged, Fulltext owns its native
mechanisms, and later activation work can be reviewed separately against characterization tests rather
than hidden inside a conflict resolution.

### Different layer: add ownership acquisition and native-operation cancellation to the shared protocol

Rejected. The existing protocol deliberately uses `getDurableCursor()` as the acquisition read, and
HNSW already returns current storage there. Adding a new acquisition hook would change every backend to
solve a cache local to this adapter. The Fulltext wrapper cannot safely cancel an admitted Tantivy
operation or decide when Harper may release its cross-worker owner lock; Harper must bound the handoff.

### Different layer: use the native writer lock as the only handoff authority

Rejected for this adapter state machine. Fulltext does retain process-registry and Tantivy filesystem
exclusion until a writer closes, so a different backend object cannot open concurrently. But resolving
Harper shutdown before this backend settles permits the same worker and backend object to reacquire;
its prior epoch's engine, drain, and queue are still live, while `DerivedIndexRuntime` interprets a
resolved `shutdown()` as quiescence. Making native exclusion authoritative would require per-epoch
detached engine contexts or a shared-runtime rule that prevents reacquisition until late settlement.
Neither is an adapter-local timeout correction.

### Different layer: add a non-condemning stalled state to `DerivedIndexBackend`

Rejected for this inert slice. Today `failed` means condemn and rebuild, while a rejected `shutdown`
means retain the runner lock and publish unavailable. A third state could distinguish valid-but-stalled
native state, but it changes the shared runner state machine, readiness semantics, recovery API, and
both backends' characterization surface. That work should be evaluated as a derived-index protocol
change rather than introduced to activate no production index.

### Deeper cause: make construction-time inspection authoritative for the backend object's lifetime

Rejected. Backend objects exist independently in every worker while the native files are shared. A
worker can be constructed before another worker publishes, so no construction-time value can satisfy
the current-checkpoint invariant across ownership rotation.

### Do less: tolerate stale inspection and let lazy writer open reconcile it

Rejected. A stale present cursor wastes replay before writer-open reconciliation. A stale missing cursor
never reaches writer open: the runtime condemns and resets the valid generation first.

### Do less: surface wrapper rejections through the existing runtime metric now

Deferred to activation. `DerivedIndexRunnerMetrics.unindexableRecords` already exists, and an optional
backend counter could feed it without changing HNSW. This backend is not constructed in production,
however, so changing the shared interface in this PR would not make the count observable. Activation
must wire the counter before enabling full-text and includes that requirement in the open-item gate.

### Open retry: fail after the immediate burst or retry a named allowlist

Rejected. Three attempts over roughly 20 ms are not evidence that native state is invalid, and a named
retry allowlist makes every future transient wrapper code destructive by default. Retry-by-default with
a closed terminal set makes unknown failures stale the index rather than retire it; status and lag policy
must expose a prolonged stall.

### Shutdown expiry: resolve as detached, reject as unproven, or wait forever

Resolving as detached is rejected because the current backend object can reacquire while its old epoch
still owns mutable engine state. Waiting forever leaves worker handoff unbounded. The chosen rejection
preserves the runtime's existing safety contract and makes the severe availability cost explicit; a
future shared `stalled` state is the path to improving that cost without weakening mutual exclusion.

### Chosen: keep recovery policy local to the full-text adapter

Acquisition-scoped inspection, retry-by-default open classification, and a bounded unproven handoff
preserve the shared protocol and HNSW implementation. The adapter is the first layer that knows both
the native lifecycle error codes and Harper's owner epoch, so it is the narrowest layer that can enforce
all three invariants. The conversion path also allocates its field map lazily, only after finding the
first indexable value.

## Verification

- **Observed:** `npm run build` passes. All 153 focused backend, lifecycle, shared-runtime, native-backend,
  and audited-RocksDB tests pass in this worktree. This includes two-owner checkpoint rotation and a
  runtime stop whose native writer-open promise remains unsettled past the handoff bound.
- **Observed:** oxlint reports no warnings in the three changed implementation and test files. The
  repository-wide lint command reports 15 pre-existing warnings outside this diff and exits successfully.
- **Observed:** the complete resources shard reaches 2,882 passing and 51 pending. Its three failures
  reproduce unchanged on detached Harper `origin/main`: two condition-delete visibility assertions and
  the range-read activity read-your-writes assertion.
- **Verified by tests:** the real `DerivedIndexRuntime` produces the same fake-native document set by
  transaction-log replay and authoritative rebuild. Separate converter tests cover Harper-internal
  symbol identities.
- **Verified by source diff:** the shared runtime, HNSW, table, and database production files are
  unchanged.
- **Observed locally:** the adapter opened, applied, and published against the native module built from
  [Add exact native mutation batch partitioning #37](https://github.com/HarperFast/fulltext/pull/37).
  The lifecycle then reopened the native engine, searched the indexed document, reset the index, and
  reclaimed its retired directory. A separate multi-record native call verified the v3 contract:
  `processed` counted both records while one invalid-field upsert appeared in `rejected` and was
  replaced by a delete. These smokes are not yet a packaged dependency or CI gate.
- **Verified by source diff:** the wrapper tree used for those local smokes is identical to merged
  Fulltext `main` at
  [`ecbb7a5`](https://github.com/HarperFast/fulltext/commit/ecbb7a51e5b0fa929079b1de54cb1018f94b83b6).
- **Untested:** a packaged native module across Linux, macOS, and Windows; HNSW and full-text active on
  the same audited table/root; actual-native deletion and rebuild after restart.

## Known prerequisites

- Before the activation stack becomes mergeable, Harper must exact-pin the published wrapper, document it in
  `dependencies.md`, load it on Linux, macOS, and Windows CI, and verify the expected lifecycle and
  mutation-batch API versions. If a supported platform has no prebuild, activation fails clearly rather
  than silently omitting the index.
- The existing [Add a full-text derived-index backend #2569](https://github.com/HarperFast/harper/pull/2569)
  branch remains the recovery reference until the reconstructed branch passes its
  focused and full gates.

## Open items

- Publish the wrapper from merged Fulltext `main`, then exact-pin it in Harper.
- Add `dependencies.md` rationale and Linux, macOS, and Windows native-load CI. The packaged-native gate
  must verify mutation-batch v3 rejected-upsert counting and representative terminal/retryable open codes.
- Define a non-condemning acquisition result for a transient inspection failure. The adapter cannot
  safely fall back to a cached checkpoint because the runtime may publish `ready` before lazy writer
  reconciliation; the shared runtime currently treats the inspection throw as a backend failure.
  Full-text activation must not merge until this protocol gap is resolved or the supported native
  inspection path is proven not to throw transient failures.
- Feed wrapper rejection counts into the existing operator-visible unindexable-record metric before
  activation.
- Add activation, schema, and query coverage in separate reviewable slices.
- Run the HNSW/full-text coexistence matrix before activation merges.

## Sources

- [Derived-index protocol #2489](https://github.com/HarperFast/harper/issues/2489)
- [Add a full-text derived-index backend #2569](https://github.com/HarperFast/harper/pull/2569)
- [Add exact native mutation batch partitioning #37](https://github.com/HarperFast/fulltext/pull/37)
- `DESIGN.md`, `resources/DESIGN.md`, `resources/derivedIndexRuntime.ts`, and
  `resources/indexes/hnswDerivedIndex.ts` in this checkout
