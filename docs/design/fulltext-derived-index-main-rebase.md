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
- Activation waits for an exact Fulltext package pin and cross-platform native-load CI.

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
3. Inspects the selected Tantivy generation synchronously for the durable cursor before registration.
   Opens the exclusive writer lazily on first delivery or publication.
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
8. Treats `E_LOCK_BUSY` as retryable ownership contention, never as a reason to reset. Retries use
   exponential backoff to a five-second ceiling and emit one content-free warning when contention
   persists. Per-record encoding failures, including oversized fields and invalid field shapes, are
   returned by Fulltext's logical-batch API as rejected upserts, replaced by deletes, counted, and
   warned once without record values. Native paths and native error messages are not logged;
   adapter-authored messages and stable native error codes are.
9. Makes `shutdown(epoch)` queue a final barrier, drain accepted work, epoch-fence publication, and then
   settles the writer. Native close is bounded at the adapter boundary. Shutdown may reject
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

## Verification

- **Observed:** `npm run build` and all 69 focused backend, lifecycle, and audited-RocksDB tests pass in
  this worktree.
- **Observed:** the complete resources shard reaches 2,876 passing and 51 pending. Its three failures
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
- Add `dependencies.md` rationale and Linux, macOS, and Windows native-load CI.
- Add activation, schema, and query coverage in separate reviewable slices.
- Run the HNSW/full-text coexistence matrix before activation merges.

## Sources

- [Derived-index protocol #2489](https://github.com/HarperFast/harper/issues/2489)
- [Add a full-text derived-index backend #2569](https://github.com/HarperFast/harper/pull/2569)
- [Add exact native mutation batch partitioning #37](https://github.com/HarperFast/fulltext/pull/37)
- `DESIGN.md`, `resources/DESIGN.md`, `resources/derivedIndexRuntime.ts`, and
  `resources/indexes/hnswDerivedIndex.ts` in this checkout
