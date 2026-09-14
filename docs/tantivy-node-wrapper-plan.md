# Tantivy Node wrapper implementation plan

Package: `@harperfast/fulltext`. License: Apache-2.0.
Storage direction updated September 14, 2026.

## Objective and specifications

Deliver one native Tantivy Node.js library using `MmapDirectory`. Standalone callers and Harper
use `@harperfast/fulltext/native`. Harper supplies record projections and opaque checkpoints
through its derived-index runtime; the wrapper owns indexing, search, handles, bounded native
execution, and publication.

The complete architecture, flows, source grounding, failure contract, and implementation sequence
are in [Native Tantivy storage and Harper derived indexes](https://github.com/HarperFast/fulltext/blob/codex/native-storage-design/docs/native-storage-integration.md).
[The product design](native-full-text-search.md) retains the detailed schema, English analysis,
ranking, query safety, autocomplete, and highlighting requirements.
[Shared coordination](hnsw-fulltext-coordination.md) defines the Harper/HNSW boundary.

The earlier detailed proposal is preserved in
[the September 14 archive](archive/2026-09-14/tantivy-node-wrapper-plan.md). Its storage provider,
KV Directory, RocksDB transport, direct-aftercommit delivery, native lease, and dual-backend
release requirements are retired. Storage-independent capability, error, input-validation,
packed-buffer, and public-query requirements remain the product target unless explicitly
superseded by the current design. They are not claims of implemented features.

## Reuse and package boundary

Reuse the existing Rust engine, batch/search codecs, writer actor, native search execution,
Tantivy payload commits, and error/poison handling. Keep the Node-API boundary narrow and the
TypeScript facade authoritative. Follow HNSW's native packaging and Symphony's facade,
platform-package and asynchronous-lifecycle patterns where applicable.

The wrapper needs no rocksdb-js dependency or version pairing. Harper owns its primary storage
dependency independently. Compatibility records the Harper/fulltext/Tantivy versions, native ABI,
platform, and persisted index format. There is no new storage provider, source log, retention
service, replication protocol, or lease system.

## API and next implementation unit

Current native APIs include open, packed apply, commit, reload, search, status, and close.
The next unit adds generic `publish(payload)` and committed-payload readback using existing
engine and hosted publication machinery. Only the publication behavior moves; hosted storage
and its transport leave the delivery scope.

Publication serializes behind accepted mutations, durably commits them with an opaque bounded
payload, reloads the reader, and resolves. Harper reports only an exact offered cursor from that
payload. Missing payload and uncertain publication are distinct states. Commit followed by failed
reload requires recovery/reopen, not continued admission against uncertain state.

Uncheckpointed standalone `commit()`/`reload()` remain supported. Once a generation contains a
checkpoint payload, plain `commit()` rejects instead of erasing it; further commits use
`publish(payload)`. Enforce this after reopen. Update ABI, Rust/TypeScript codecs, loader checks,
and tests together. Harper owns version/conflict resolution and idempotent current-state replay;
the wrapper does not add a durable per-record version ledger.

## Ownership and resources

Tantivy has one exclusive writer per physical directory, with internal indexing and merge threads.
Different indexes may write in parallel. There is no single global writer or permanent worker-0
owner. Harper elects its runner; Tantivy's directory lock guards physical writer ownership.

Bound native queues, bytes, resident writers, search work, indexing/merge threads, and rebuilding
generations across the process. Include retained handles/mappings in accounting; measure resident
memory and shared pages. Per-index limits alone do not establish aggregate safety. Keep sustained
work off JavaScript and libuv and map saturation into Harper's bounded deferral/recovery contract.

Close and handoff prove quiescence before ownership release. A timeout is failure, not proof that
native tasks stopped. Query workers share qualified reader state or attach readers without opening
writers. Cross-worker refresh and owner death before notification are required integration tests.

## Files and lifecycle

Harper selects contained native paths using database/index/generation identities. It owns
selection, restore invalidation, activation, cleanup scheduling, and operator resource policy.
The wrapper supplies native open/close and identity checks, not a second lifecycle catalog.
Storage paths are not schema or REST input.

Reopen/replay on ordinary restart. Missing, corrupt, incompatible, or unresumable state rebuilds.
Fresh replicas and restores build locally before full-text query readiness; source records/schema
suffice for backup. Files and local checkpoints are not replicated. Qualify initial replica copy
separately from ordinary live transaction delivery.

Protect files with permissions and appropriate filesystem/volume encryption. Budget active files,
merges, rebuilds, and retained readers while preserving source-store disk headroom. Retry orphan
cleanup safely across restart. Do not reproduce the retired KV chunk collector.

## Execution and qualification

1. Native checkpoint publication/readback and failure tests.
2. Harper backend integration with reproducible fixtures for replay, real worker handoff, replica
   bootstrap, restore, and reader visibility.
3. Adapt the existing benchmark to native integration and no-index Harper controls.
4. Audit and remove hosted exports, transport, KV Directory, reclamation, build flags and package
   claims. Preserve reusable engine/ABI/fault tests and historical evidence.
5. Complete schema/query/lifecycle qualification, platform packaging, documentation and release.

The design revision itself changes no production code. Existing hosted artifacts are experimental
and superseded until their removal lands.

Measure standalone native performance separately from Harper product performance using matching
corpus, analysis, queries, mutations, publication cadence, and hardware. Include unrelated writes,
multiple indexes, replica catch-up, merges/rebuilds, warm/cold caches, source-write latency, backlog
drain, commit/reload, memory/disk, and errors. Integration overhead is not pure storage overhead.

PR CI runs correctness/output smoke. Controlled scheduled/release runs retain compatible versioned
JSON and immutable environment/workload/revision fingerprints in GitHub. Process-crash tests do not
prove power-loss durability. Qualify supported filesystems/platforms and actual packed artifacts.

Ship a thorough README, API reference, native quick start, Harper example, compatibility/upgrade
policy, error/limit reference, recovery/disk/security guidance, benchmark instructions, changelog,
support policy, and Apache-2.0 license/provenance. Distinguish implemented APIs from planned features.
