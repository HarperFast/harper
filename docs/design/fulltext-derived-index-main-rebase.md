# Full-text derived-index integration on current main

## Intent

Replace the conflicted full-text backend stack with a current-`main` implementation that uses
Tantivy's native files as node-local derived state. Harper remains authoritative for records,
transaction-log replay, ownership, readiness, rebuild policy, and schema lifecycle. The Fulltext
package remains Harper-agnostic and owns native mutation encoding, its single writer, publication,
inspection, reset, and retired-directory reclamation.

This first unit replaces [Add a full-text derived-index backend #2569](https://github.com/HarperFast/harper/pull/2569).
Schema declaration and runtime activation remain stacked follow-ups. It depends on
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
  close. Fulltext PR #37 adds exact logical mutation-batch partitioning, replacement deletes for
  rejected upserts, retired-directory reclamation, and the API version Harper's adapter expects.
- The conflicted backend branch changes the shared runtime, table/database lifecycle, and HNSW
  adapter. Applying those files over current `main` would remove newer HNSW behavior.

## Invariant

Adding a full-text backend must not change the derived-index protocol or weaken an existing backend:
Harper offers committed work once per elected epoch, and a backend advances its cursor only with the
native state made durable by the same publication barrier.

## Chosen design

### Backend PR

Rebuild #2569 from current `main` rather than resolving its conflicts commit by commit.

The backend PR will:

1. Add a `DerivedIndexBackend` adapter under `resources/indexes/` and a lazy optional Fulltext binding
   modeled on the HNSW binding. The adapter reads `batch.records` by named property; it never spreads,
   enumerates, or serializes `DerivedIndexBatch`, whose `records` and `bytes` properties are deliberately
   non-enumerable.
2. Queue each accepted runtime batch and apply it in bounded adapter-owned slices. Fulltext owns exact
   encoding, native frame partitioning, rejected-upsert replacement deletes, and writer state, but one
   native call never receives the entire 4,096-record runtime chunk. The cursor is publishable only
   after every slice from that runtime batch has completed.
3. Inspect the selected Tantivy generation synchronously for the durable cursor before registration.
   Open the exclusive writer lazily on first delivery or publication.
4. Publish the Harper cursor as Tantivy's commit payload after accepted mutations. On apply or
   publication failure, rollback-close, discard queued work, and report accepted work lost so the
   runtime resumes from the durable payload.
5. Preserve every field in the current `DerivedIndexCursor`, including optional coverage, when
   encoding and decoding the native commit payload. A normal publication merges any coverage already
   stored in the durable payload because the runtime's `batch.through` clone intentionally omits it.
   The backend will not implement `publishCoverage` in this PR; query coverage arrives with the query
   integration so idle indexes do not pay cursor-only Tantivy commits yet.
6. Use the runtime's existing rebuild and condemnation protocol. Fulltext owns reset, invalid native
   generation classification, and retired-directory cleanup.
7. Leave `derivedIndexRuntime.ts`, table/database lifecycle, and HNSW unchanged. The adapter derives
   its stable document key from `writeKeyId(record.recordId)` and `tableId`, rejects symbol identities,
   and pays that encoding only on the full-text path. No activation or query policy belongs here.
8. Treat `E_LOCK_BUSY` as retryable ownership contention, never as a reason to reset. Every deferred
   retry has a timer-backed wake. Per-record encoding failures, including invalid surrogate input, are
   returned by Fulltext's logical-batch API as rejected upserts, replaced by deletes, counted, and
   warned once without record values. Native paths and error messages are not logged.
9. `shutdown(epoch)` drops queued work, epoch-fences publication, and settles the writer. It may reject
   only when quiescence cannot be proven; the runtime then deliberately holds the runner lock rather
   than allowing two native writers. Native close needs a bounded failure result so this state is
   observable instead of hanging worker shutdown indefinitely.

### Stacked follow-ups

The schema PR will declare and validate `@fullText` without activating a native writer.

The activation PR will be redesigned against current `main`. It may extract registration coordination
only after preserving the HNSW characterization tests for generation replacement, coverage, drop,
failed-drop restoration, and unavailable-generation recovery. HNSW-specific coverage/barrier policy
stays in the HNSW adapter; Tantivy-specific writer policy stays in the full-text adapter.

The query PR will reuse the runtime's readiness and coverage model. Readiness answers whether the
generation is usable; coverage answers whether it is sufficiently current for a request. The initial
full-text policy can be strict without creating another freshness protocol.

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

Chosen for this backend slice. `writeKeyId` is already exported, and the duplicate encode occurs only
for records headed to full-text. This avoids adding an allocation to every HNSW mutation and keeps the
PR inert until activation. Symbol identities are skipped explicitly so replay and rebuild produce the
same document set.

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

Rejected. `publishCoverage` activates committed-position sampling in the runtime and would require
cursor-only Tantivy publications before a query consumes that proof. The backend preserves existing
coverage in cursor payloads, but the query PR owns the policy and the extra publication cost.

### Chosen: reconstruct the backend slice from current main

This keeps the first PR inside its ownership boundary with no shared runtime or HNSW production-code
change. It beats the other options because current HNSW remains unchanged, Fulltext owns its native
mechanisms, and later activation work can be reviewed separately against characterization tests rather
than hidden inside a conflict resolution.

## Verification

- Backend unit tests cover inspection, lazy open, bounded and time-sliced queueing, epoch fencing,
  apply/publish
  ordering, cursor round trips including coverage, rollback and replay, reset, corruption/missing-file
  rebuild classification, rejected upserts, unindexable records, shutdown, and cleanup failure.
- Existing derived-index runtime and HNSW suites run unchanged.
- A real-runtime test constructs batches through `DerivedIndexRuntime`, proving named access to the
  non-enumerable records, and compares replay output with rebuild output, including symbol entries.
- The real Fulltext package is exercised in a cross-repository test after #37 is green; fake bindings
  remain for deterministic failure-path tests.
- End-to-end route for the backend slice: audited RocksDB records feed the real runtime and native
  wrapper, restart reuses the native directory and replays after its cursor, and deleting the directory
  forces a local rebuild before readiness.
- Before restacking activation, run HNSW and full-text together on the same audited table/root and
  verify independent ownership, progress, backpressure, replacement, shutdown, rebuild, and drop.

## Known prerequisites

- Fulltext #37 must resolve its Windows Node 24 failure and merge before Harper can pin and exercise
  the required native API in CI.
- Before this stack becomes mergeable, Harper must exact-pin the published wrapper, document it in
  `dependencies.md`, load it on Linux, macOS, and Windows CI, and verify the expected lifecycle and
  mutation-batch API versions. If a supported platform has no prebuild, activation fails clearly rather
  than silently omitting the index.
- The existing #2569 branch remains the recovery reference until the reconstructed branch passes its
  focused and full gates.

## Planning-review resolution

The first planning review found the option set too focused on merge mechanics. The revised design
adopts its missing alternatives and constraints: no shared runtime change, adapter-owned apply slices,
deferred coverage publication, explicit native-package gates, named access to non-enumerable runtime
batches, lock-contention wakeups, sanitized errors, and replay/rebuild parity. Its suggestion that
`shutdown()` always resolve is not adopted: current `DerivedIndexRuntime` deliberately holds the lock
when a backend cannot prove quiescence, preventing a successor writer from overlapping an unresolved
predecessor. The adapter instead requires a bounded close result and rejects only when that safety proof
fails.
