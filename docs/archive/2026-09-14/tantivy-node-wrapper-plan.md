# Tantivy Node wrapper implementation plan

> Storage architecture superseded September 14, 2026. The current design is
> [Native Tantivy storage and Harper derived indexes](https://github.com/HarperFast/fulltext/blob/codex/native-storage-design/docs/native-storage-integration.md).
> The wrapper and Harper now use native Tantivy files only, with local replay/rebuild on each node.
> RocksDB Directory, host transport, and dual-backend release requirements below are historical,
> not implementation requirements. Existing storage-independent schema, analysis, query, API safety,
> and packaging decisions remain requirements unless explicitly superseded by the current design.


- **Status:** implementation proposal
- **Package:** `@harperfast/fulltext`
- **Repository:** `HarperFast/fulltext`
- **Initial consumer:** Harper native full-text indexing
- **Binding storage modes:** Tantivy `MmapDirectory` and `RocksDbDirectory`
- **Harper release storage:** `RocksDbDirectory` over Harper's already-open RocksDB instance only
- **Pinned search engine:** Tantivy 0.26.1 for the initial implementation
- **License:** Apache License 2.0

## Objective

Build a production-quality Node-API wrapper around one shared Tantivy engine. Deliver standalone
`@harperfast/fulltext/native` and the planned `@harperfast/fulltext/harper` integration. Harper stores
all persistent fulltext index state in its existing RocksDB database and never selects native files.

The wrapper owns search, indexing, bounded execution and Tantivy handles. Harper owns schema, records,
authorization, derived delivery/replay, store registration and lifecycle. Engineering will not add
the proposed native storage capabilities to rocksdb-js; the integration must use supported existing
APIs. The experimental native-lease branch remains unmerged, with no supported standalone rocksdb-js
backend and no mandatory third benchmark arm.

See [Tantivy storage through Harper](./tantivy-rocksdb-directory-design.md) for the current architecture, transport proof,
durability requirements and execution sequence. That proof is the next storage milestone; a derived
delivery interface alone does not implement byte storage. Storage-independent schema, query and
engine behavior below remain the design target, not a claim that all features have shipped.

The project and published artifacts use Apache-2.0. Native mode is independently usable. The Harper
entry point is added only after the integrated path passes its own qualification.

## Reference implementations

This plan was grounded in the following repository revisions:

- [`HarperFast/hnsw`](https://github.com/HarperFast/hnsw/tree/95c80763746ae080f38f0fcc7398fec265ede175)
- [`HarperFast/symphony`](https://github.com/HarperFast/symphony/tree/eb2c1b6760605f908475345672f9cab3ae5548cc)

The September 4, 2026 accuracy pass additionally used Harper `9f469c079a` (5.2.5), rocksdb-js
`7ab102ca3e` (package 2.8.0, RocksDB 11.8.1), and Tantivy tag `0.26.1` (`d8f4c0b703`). Tantivy main was
checked at `b5d8deb80c` (0.27.0) for upstream drift, but main does not silently change the
implementation target: the pinned 0.26.1 source and behavior remain normative until the
compatibility gate approves an upgrade.

### Reuse from HNSW

The HNSW package provides the closest algorithm-wrapper pattern:

- an independent Rust crate and npm package;
- `cdylib` plus `rlib`, allowing the engine to be tested without Node;
- a narrow N-API class backed by `Arc`-owned native state;
- one native crossing per complete operation rather than per inner-loop action;
- typed-array and `Buffer` inputs for bulk data;
- pooled native scratch memory;
- platform-specific optional dependencies with an actionable loader error;
- Rust tests, Node smoke tests, platform builds, and release-time native smoke testing;
- explicit durability, compatibility, and invalidation behavior.

The full-text wrapper should not copy HNSW's filesystem-path API into the Harper adapter,
synchronous mutation methods, manually maintained declaration file, or use of N-API `AsyncTask`
for sustained work on Node's shared libuv pool. The native entry point necessarily accepts a path,
but that path never appears in Harper schema, runtime, or REST. Full-text indexing and search need
package-owned bounded execution lanes.

### Reuse from Symphony

Symphony provides the stronger package and façade pattern:

- `@napi-rs/cli` generates the low-level addon declarations;
- a hand-written TypeScript façade converts public types to the flatter native ABI;
- raw generated addon types are not the package's public API;
- lifecycle methods are asynchronous and idempotent;
- metrics are pulled as snapshots instead of emitted for every operation;
- Rust/Tokio work remains off the JavaScript event loop;
- Linux glibc/musl and x64/arm64 artifacts are built separately;
- macOS x64/arm64 and Windows x64 artifacts plus multiple Node versions are exercised;
- platform packages are assembled by the napi-rs artifact tooling;
- CI includes a real Harper integration test, not only addon unit tests;
- npm releases use platform packages and provenance.

The wrapper should not copy Symphony's EventEmitter surface. Indexing and searching are
request/response operations; failures belong on their promises and durable generation status,
while low-rate health information belongs in `status()` and metrics.

## Design assessment

This changes the Harper/fulltext boundary and therefore requires a storage feasibility proof.
The invariant is that Harper remains the single storage and recovery authority while the shared
Tantivy engine publishes only complete, durable index state.

- Post-commit delivery performs bounded projection and nonblocking admission; queue saturation
  defers to Harper replay without failing a committed record write.
- One Tantivy writer exists per actual database/index/generation identity. Independent indexes
  progress concurrently within shared native and storage-transport budgets.
- Indexing, merging and searching run on bounded native execution lanes. Storage may cross into
  a Harper-owned JS environment through a bounded transport; no native thread invokes JS directly.
- Neither a JS storage worker nor shutdown may synchronously wait on native work that requires that
  same worker. Every wait has completion, failure and teardown behavior.
- Aggregate native budgets include threads blocked on storage across all indexes. A native wait
  cannot hold a lock or permit needed by the storage service or completion path.
- Object durability precedes metadata/checkpoint publication; reload determines searchable visibility.
- Harper owns cursor semantics, retention, authoritative replay and rebuild. The wrapper does not
  implement a second log service or require an addon-to-addon cursor ABI.
- Both backends share codecs, query builders, engine, commit/reload and error behavior. Neither
  backend becomes a silent fallback.
- Native-versus-Harper measurements identify their scope. End-to-end Harper time is not labeled
  pure storage overhead.
- Exact supported storage methods, durability options and transport topology remain to be proven
  before the Harper factory freezes. No private rocksdb-js patch or native lease is assumed.

### `DerivedIndexBackend` contract required before the wrapper API freezes

The planned Harper entry point adapts
[Derived-index delivery protocol (DerivedIndexBackend): shared post-commit delivery, watermark/replay, and blob-content contract for HNSW and full-text indexes](https://github.com/HarperFast/harper/issues/2489).
The issue describes proposed shared runtime work, not an already shipped binary-storage interface.
Harper owns committed positions, exact replay, retention and rebuild; fulltext receives opaque
progress context and reports what it completed and durably published. No native log-cursor lease is
part of the wrapper contract.

The transaction log is the recovery queue. There is no fulltext dirty-marker CF, maintenance lock,
epoch rotation or second per-record journal. Store registration uses Harper's existing storage
lifecycle, while fulltext implements Tantivy logical-file semantics through the supported storage
operations selected by the integration proof. See [Tantivy storage through Harper](./tantivy-rocksdb-directory-design.md) for ownership and the concrete proof gates.

### Required integration work at existing ownership boundaries

Harper implements the shared derived runtime, final-record projection, source retry, retention-gap
detection, rebuild handoff and derived-store lifecycle. fulltext implements the Harper-backed
Directory and bounded transport using existing storage APIs, alongside its shared engine.

The protocol details below express required behavior. Exact cursor/resume APIs and replay tests
must be resolved in Harper's protocol work before activation. They do not mandate the formerly
proposed rocksdb-js cursor ABI, reservations service or native storage lease. If a guarantee cannot
be provided by the supported stack, report the blocker rather than silently inventing a primitive.

Blob extraction continues to use Harper's content ownership and codec boundary. A native blob ABI
is not assumed by this storage decision; its implementation must be justified independently.
All schema, query and recovery changes remain in their owning layer.

#### Committed delivery contract

The shared core contract is conceptually:

```ts
type LogPosition = Uint8Array; // one committed entry in one physical log
type LogWatermark = Uint8Array; // versioned aggregate across all required logs

interface CommittedRecordEntry {
	tableId: number;
	recordId: Id;
	version: number;
	previousVersion?: number;
	nodeId: number;
	txnTime: number;
	logPosition: LogPosition;
	type: 'upsert' | 'delete' | 'invalidated' | 'evicted';
	record?: unknown;
}

interface CommittedBaseCopyControlEntry {
	tableId: number;
	txnTime: number;
	logPosition: LogPosition;
	type: 'base-copy-start' | 'reload';
	copyId: Uint8Array;
	copyCursor: Uint8Array;
}

type CommittedEntry = CommittedRecordEntry | CommittedBaseCopyControlEntry;

type DeliveryOutcome =
	| { status: 'accepted' }
	| { status: 'deferred'; reason: 'busy' | 'source-required' | 'closed' | 'failed' };

interface DerivedIndexBackend {
	readonly needsPreviousValue: boolean;
	deliver(entries: CommittedEntry[]): DeliveryOutcome;
	getWatermark(): LogWatermark | undefined;
	status(): DerivedIndexStatus;
	close(options: DerivedCloseOptions): Promise<void>;
	beginRebuild(context: RebuildContext): RebuildHandle;
}
```

[`hnsw-fulltext-coordination.md`](hnsw-fulltext-coordination.md) is normative for this shared
interface; the copy here is included for implementation context. These types belong to Harper core,
not the package's public exports. `RebuildContext` contains the opaque boundary plus optional copy
identity/cursor. `record` is the final
query-visible local record after conflict resolution and residency handling; it is absent for
deletes and may be absent from a pre-encoded log entry.
`beginRebuild()` returns an internal handle that accepts normalized full-record batches with either
an opaque scan resume key or `{ copyId, copyCursor }` progress. Base-copy rows use that rebuild
channel and never fabricate per-record `LogPosition` values; only the start/completion control facts
participate in the ordinary committed-entry stream.
The immediate delivery outcome is a small refinement to the issue's `void` sketch: it lets the
shared runtime latch durable-log catch-up when a backend cannot accept a batch, without a
cross-worker callback or exception on the commit path. `deferred` never means the source commit
failed.
The full-text backend sets `needsPreviousValue = false`: it deletes by encoded primary-key term and
then adds the current projection. A future backend that requests a previous value explicitly pays
the existing pre-commit capture cost; the common runtime does not impose it on every write.

The normalizer exhaustively maps every decoded audit operation before backend delivery. Ordinary
create/update/patch operations become `upsert` only with a proven full post-merge record. An
invalidation that preserves local indexed discoverability is a position-only no-op; cache eviction,
delete, or loss of local searchable residency becomes a term delete. Base copy is explicit because its rows may be
applied without per-row audit entries. Before the first copy batch, Harper durably records
`base-copy-start` with the existing copy identity/resume cursor and marks each registered backend's
active generation incomplete. The copy applier already owns each full record, so after every source
batch commit it projects and feeds those records directly into a private `BUILDING` generation using
the same packed mutation format. That generation commits the copy cursor with its progress. The
completion `reload` marker may publish the generation only when its committed cursor covers the
copy's durable completion cursor and ordinary log catch-up is contiguous; otherwise it remains
building and fills the gap from authoritative records. A crash or abandoned copy before `reload`
therefore leaves an explicit incomplete fact, never a healthy stale generation.

Current Harper eviction/TTL paths intentionally bypass customer audit. When a RocksDB table has
derived-index interest, Harper adds a derived-only `EVICT` control entry using the existing audit
format's next reserved low-nibble action (`9`) and `LOCAL_ONLY` flag, committing it in the same raw
transaction as the version-guarded record removal. It is filtered from replication and customer
audit/subscription delivery but remains visible to derived-consumer replay and retention. The wrapper
does not create this entry or a second queue.

`message` is an explicit record-neutral no-op. `relocate` resolves final residency and becomes a
delete or full-record upsert. `structures` delegates to schema/catalog handling and triggers a new
generation when an indexed source or analyzer changes. A `corrupt-header` sentinel is quarantined,
counted, and operator-visible; because its table cannot be proven, every active derived generation
is marked `NEEDS_REBUILD` once, and a rebuild captured after that position may cover and advance it
without entering a repeat loop. Any future unrecognized type fails generations closed instead of
advancing their watermarks.

`RocksTransactionLogStore` emits the batch after the source transaction and its transaction-log
append commit. The log is the durable recovery fact; a WAL-disabled primary/index memtable may still
require Harper replay after a crash. `RocksTransactionLogStore.put()` does not own or reconstruct the
post-merge record: a PATCH audit value may be only the delta. The Table save/conflict-resolution path
that produces the final query-visible stored value places that exact object reference and effective
change mask in the transaction-local post-commit context keyed to its audit entry. After log commit,
the log store attaches committed native positions and the dispatcher joins those positions with the
saved full records once per transaction. Out-of-order patches contribute only the final winning
merged value after resequencing/conflict resolution; an absent or unproven full value becomes
`source-required`, never a delta projection. Projection selects only schema-declared fields and blob
references on that originating worker. It does not invoke customer code or perform tokenization,
content extraction, Tantivy work, or RocksDB Directory I/O.

Retained-log replay is deliberately more conservative than hot delivery. It uses each decoded entry
to identify the table and record, then asks Harper for the current authoritative record/version before
projecting anything. The encoded record body is only a hint because a RocksDB transaction retry can
durably retain the losing attempt's body while the retry stores different content under the same
version. A current record is applied with its actual version; a confirmed absence/nonresident state
is a delete; an already represented newer version suppresses the older position. This adds point reads
only to catch-up/recovery, not the successful write path, and makes retry-plus-crash convergence
testable.

Derived registrations also declare their direct source-attribute dependencies. The table write path
already distinguishes partial changes from replacement/delete operations; Harper converts that
information to a compact table-local attribute mask after conflict resolution and intersects it
with each registration before retaining the final record or projecting text. A partial mutation
whose effective mask does not intersect an index's sources becomes a position-only no-op for that
index. The native watermark tracker marks the position complete without calling `IndexWriter`, so
the contiguous frontier can advance without fabricating a document mutation. Deletes, residency
changes, full replacements, computed dependencies that cannot be proven unchanged, and replay
records without a trustworthy mask are conservatively treated as affecting the index. This avoids
comparing large strings or fetching a previous record merely to discover that price or inventory
was the only changed field.

The mask is an internal schema-ordinal bitset, not an array of customer field names in every event.
One mask is computed per committed record and reused across all registered backends. If no backend
for the table intersects it, the existing log entry remains the recovery fact and the record object
is not retained for derived dispatch. Each registered backend receives only a compact,
transaction-coalesced position completion; no record content or text projection crosses N-API. If
some targets are affected and others are not, the packed batch for each target carries affected
mutations plus compact no-op positions; it never copies unchanged text merely to move a watermark.

The Harper normalizer owns ambiguous source shapes before calling a backend. The
`RocksTransactionLogStore.put()` options contract gains a required fixed-width `tableId` and one
`derivedInterest` bit supplied by the table-specific call site before audit encoding. A pre-encoded
replication frame therefore reaches `put()` with table identity and interest outside the frame; the
interest check never parses or decodes the audit bytes merely to discover that no derived consumer
exists. Only an interested entry is decoded through `RocksTransactionLogStore`; the wrapper never
parses Harper audit bytes. A bodyless `upsert`
returns `deferred` with reason `source-required` and leaves only that position unresolved in the
bounded background source-resolution lane. It does not latch generation-wide catch-up unless the
lane itself reaches its byte/entry limit, at which point it degrades to the ordinary `busy`/replay
path. Resolution asks Harper's resource/store layer for the current query-visible record; the wrapper
never reads or decodes a primary CF. If a newer record is returned, its actual version is applied and
the older position completes under normal version suppression. A confirmed current delete or
nonresident state deletes the local index term and completes the position. Only an unresolved read
remains `source-required`; it may hold the contiguous position only inside the release-qualified
blocking-gap budget, after which Harper must produce an explicit terminal quarantine/failure outcome
or rebuild rather than let one entry make the whole index unavailable. An unknown or transient read
result is never guessed to be a delete.
Operation type is resolved before record-fullness flags: `delete`, `evicted`, and nonresident
transitions explicitly delete the primary-key term and complete without a body; an ordinary
invalidation completes without changing the existing term. For a local PATCH, the Table save path
supplies the final post-merge query-visible `record`; that transaction-local object reference is
the fast path even when its encoded audit body carries `HAS_PARTIAL_RECORD`. A pre-encoded replication frame
marked `HAS_PARTIAL_RECORD`, or any upsert body whose fullness cannot be proven, is never projected
directly when an indexed source changed. Full-text replacement deletes the primary-key term before
adding one complete document, so projecting that partial body would silently erase terms from
unchanged indexed fields. Such an entry follows `source-required` resolution to obtain the current
full record. Only a proven full post-merge record may enter the delete-then-add path; an unaffected
partial mask may still complete as a no-op. A record excluded by residency is not indexed from the
fuller audit body, because
that would retain nonresident content in the local term dictionary. If a partial resident record
does not contain every required full-text source, schema activation rejects that residency/index
combination or the mutation remains `source-required`; it never publishes an incomplete document as
healthy.

```text
record transaction commits with its existing log batch
                    │
                    ▼
originating worker: aftercommit(entries + records + positions)
                    │ intersect changed-field mask with registered sources
                    ├── unaffected target ─► complete position as no-op
                    │
                    │ project affected fields; one packed batch
                    ▼
@harperfast/fulltext: nonblocking native admission
       ├── accepted ──► package-owned ingestion lanes ──► shared IndexWriter
       ├── source-required ─► bounded background resolution; one position remains open
       └── busy/overflow ───► latch catch-up; durable log remains the queue
                                                     │
                                      commit/publication actor
                                                     ▼
                            Tantivy head + contiguous log watermark
```

The hook must enqueue and return. It is on the commit path and may run under the LMDB inter-thread
lock even though the first full-text release rejects LMDB. Harper owns one bounded, same-thread
coalescer per target index in each environment. Its post-commit callback appends packed mutations and
position completions in commit order, schedules at most one next-turn flush, and returns without
crossing N-API. Reaching Harper's configured byte or entry threshold flushes earlier. One coalesced
`deliver()` call may therefore cover several source transactions while preserving their opaque
positions. There is no timer per transaction or cross-worker JavaScript hop.

The next-turn flush runs outside `DatabaseTransaction`'s post-commit catch, so the scheduled callback
has its own top-level nonthrowing boundary around masking, projection, packing, and the N-API call.
A synchronous JavaScript error or rejected native call records a bounded failure ID, releases the
buffer, and latches catch-up from the published watermark; it never becomes an uncaught exception or
worker exit. Tests inject failures before packing, during packing, and at `deliver()` and assert both
worker survival and eventual replay convergence.

The coalescer's byte/entry thresholds, scheduling primitive, retained-content charge, and shutdown
behavior are trusted Harper runtime policy. They are not fields in `FullTextRuntimeOptions`, wrapper
index options, or `@fullText`. Harper charges retained content before the N-API boundary against its
own dispatcher budget. The wrapper neither observes event-loop turns nor instructs Harper how to
batch; it validates each received batch against its independent hard decoding and admission limits.
If Harper cannot retain an item, it discards the projection, records only that catch-up is required,
and returns; durable-log replay starts from the published watermark. Native admission likewise never
waits for a queue slot, another worker, Tantivy's pipeline, a blob, or a commit. Queue saturation
cannot fail or delay the authoritative write: `busy`, overflow, close, or failure latches catch-up
for the generation and releases the delivered buffer. `source-required` instead holds its one
position in the bounded resolution lane unless that lane overflows. Once catch-up is latched, later
hot deliveries reduce to a coalesced wakeup until replay closes the gap, avoiding unbounded duplicate
buffers.

`deliver()` is total and nonthrowing at the protocol boundary. Validation failure, allocation
pressure, a closed handle, or a native fault returns `deferred` and latches the backend's degraded
or failed state for the runtime to observe. Core dispatch isolates each registered backend so a bug in
one listener cannot prevent delivery to later backends. The authoritative commit fact already
exists in Harper's transaction log, so no post-commit failure may escape as a record-write failure.

The runtime attaches this listener in every environment that can commit table writes, including
replication apply. No worker routes its steady-state records through another worker's JavaScript
event loop. An environment that exits before native application loses only an optimization; its
durable entries remain after the published watermark and replay.

Registration is table-scoped. Current `RocksTransactionLogStore.put()` retains in-memory audit
objects whenever the database-level `aftercommit` emitter has any listener; a single derived index
must not impose additional work on unrelated tables in the same database. Harper separates the
existing change-feed retention decision from derived retention. If an existing change-feed/MQTT/
subscription listener already requires the `auditRecord`, derived dispatch reuses that same object;
it never creates a second retained copy. Otherwise, derived record/projection retention occurs only
when the call metadata's `derivedInterest` bit, maintained with the table descriptor during schema/
backend activation, is set. The per-record path reads that bit; it performs no per-index registry or
`Map` scan. Commit dispatch then visits only backends registered for interested
entries in that transaction. The zero-feature performance gate uses an unindexed hot table sharing a
database with an active full-text table and includes a separate arm with an active change-feed
listener elsewhere in that database; benchmarking an entirely unindexed database is insufficient.
It asserts allocation counts as well as throughput and latency and proves derived indexing adds no
second retention to the listener-owned path. Local-write and pre-encoded replication-apply arms
prove an uninterested entry requires neither header parsing nor body decode. A companion correctness
test keeps an active subscription on that unindexed table and proves the optimization does not
suppress its notifications.

The generic `EventEmitter.emit()` call is not the derived-backend isolation boundary because one
throwing listener prevents later listeners from running. Harper replaces that call site with an
owned post-commit dispatcher that snapshots registered consumers and invokes the change-feed path
and each derived backend behind independent nonthrowing boundaries. Changed-field masking,
projection, packing, and coalescer admission occur inside that backend's boundary, not before the
dispatcher. It preserves registration order and required one-shot behavior, reports a bounded
failure ID, and continues to later consumers. A throwing mask/projection/backend must not suppress
MQTT/change-feed delivery or another derived index after the authoritative commit has succeeded.
These per-consumer boundaries supplement rather than replace `DatabaseTransaction`'s outer
post-commit catch; an already-durable write can never become an unhandled rejection because the
dispatcher itself fails. The fault suite injects both JavaScript exceptions and a real native panic
through `deliver()` and proves the generation becomes failed without unwinding into Harper.

#### Position and watermark contract

Harper's shared protocol must identify exact committed work across local and replicated-origin logs and detect gaps after retention or log recreation. The storage integration does not prescribe a new rocksdb-js cursor API. Verify the supported Harper resume mechanism and multi-log behavior before freezing the backend contract; the wrapper treats progress as opaque.

Harper tracks the ordered source frontier and provides bounded progress context to fulltext. Fulltext reports completed mutations and publishes only the contiguous frontier represented by the committed Tantivy state. Transport or engine-local sequence numbers must never be substituted for source-log positions.

The package tracks admission, native application, content retry, and failure against those opaque
positions. The watermark advances only across a contiguous prefix; later completed entries cannot
bridge an unresolved gap. The commit actor:

1. captures a commit boundary while public queue admission remains open;
2. prevents work after that boundary from entering the writer and drains every accepted mutation
   through the boundary;
3. obtains the highest contiguous `LogWatermark` represented by the pending Tantivy state;
4. calls `writer.prepare_commit()`, encodes the watermark as a canonical versioned base64url string,
   and sets it with `PreparedCommit::set_payload()`;
5. completes the object durability barrier; and
6. publishes `meta.json` atomically; the watermark is part of that Tantivy metadata.

There is no independent `setWatermark()` write after commit. A crash exposes either the old commit
and payload or the new commit and payload. Every successful commit writes a versioned envelope with
an explicit delivery-mode tag, including a standalone commit that omits its optional checkpoint.
The envelope discriminates a derived aggregate watermark from a standalone caller checkpoint; it
never accepts both. The decoder accepts only the pinned format version, canonical alphabet, and
variant-specific decoded-length limit. A standalone checkpoint is at most 65,536 bytes before
base64url encoding; the envelope's total encoded length is checked with overflow-safe arithmetic
before allocation. It is fuzzed as untrusted durable input. Merge-only publications must preserve the source payload; a
pinned-Tantivy-version test proves that behavior instead of assuming it. In derived mode, the active
commit's watermark is the only authoritative full-text resume point; in standalone mode, that role
belongs to the caller-provided checkpoint. In-memory acknowledgments, wrapper-local apply sequences,
and Tantivy opstamps are diagnostics.

Harper owns the retention policy, including every age/byte limit, pressure response, reservation
lifecycle, and decision to rebuild a lagging consumer. Through the shared derived-index protocol it
creates each conservative minimum-required-watermark reservation before a build captures its
boundary, advances the reservation only after the matching derived commit is durable, and releases
it during catalog-controlled drop/generation lifecycle. The fulltext wrapper receives opaque log
positions and completion operations only; it has no retention duration, byte limit, expiry timer,
purge API, or configuration surface.

Retention protection and boot-time purge coordination belong to Harper's shared protocol. Their exact implementation is a prerequisite to reliable replay, but this wrapper plan does not require a rocksdb-js reservation service or define a new persisted purge-floor format.

When history can no longer be retained or exact resume cannot be validated, Harper marks the generation NEEDS_REBUILD before allowing it to serve as current. Rebuild scheduling respects storage pressure. Test boot-time and steady-state retention gaps against the actual Harper protocol; the wrapper neither expires history nor implements a reservation store.

At startup Harper validates retained replay coverage before trusting the saved derived watermark.
A missing, recreated, truncated or incompatible required log makes the generation NEEDS_REBUILD;
it never silently resumes at the oldest remaining entry. The shared protocol must prove retention
behavior across boot, pressure, restore and rebuild using supported APIs. This design does not
specify a new persistent purge floor or ask the wrapper to operate the log service.

#### Mutation ordering and idempotence

Direct calls from multiple workers may arrive out of source order in either mode. Every mutation
therefore carries the record ID, exact numeric record-version bits, node ID/tie-breaker, and
operation; the derived envelope additionally carries its log position. One canonical comparison is
frozen before the packed protocol is stable and the shared runtime uses it to reject an older,
duplicate, or late mutation within the current uncommitted window. A standalone caller owns
assigning and durably replaying stable version and node/tie-breaker values and must not deliver a
mutation older than its last published checkpoint. In derived mode, Harper supplies the values from
the accepted source record and remains the authority on source acceptance. The wrapper never uses
N-API arrival order as record truth while competing mutations are in its current window.

Equal record-version bits do not authorize node-ID or arrival-order conflict resolution. The wrapper
compares the complete canonical mutation—operation plus encoded projected fields—before changing
Tantivy state. An exact match is an idempotent duplicate. Different content or operation for the same
record and version is `FULLTEXT_VERSION_CONFLICT`; a node/tie-breaker may order transport work but may
not choose which content wins. This check uses exact canonical bytes, with any digest serving only as
an accelerator whose match is confirmed, so a hash collision cannot suppress a conflict.

Standalone `apply()` detects such a conflict during serialized preflight and rejects that complete
call before applying any entry from it. The caller may resubmit one canonical state under a strictly
newer version or rebuild; the wrapper has no authority to select either equal-version mutation.
Derived delivery instead keeps the conflicting opaque log position unresolved and reports
`version-conflict` with that earliest position through the bounded status surface. Harper rereads the
current authoritative record and submits a derived-only authoritative-repair mutation bound to the
same pending record and position. The repair contains the current complete projection, a delete when
the record is absent/nonresident, or a newer accepted version. The wrapper accepts the repair flag
only for the exact outstanding conflict, atomically replaces any staged equal-version state, and
advances through the position only after the repaired state is durably published. If Harper cannot
resolve the record or its required log position is gone, the generation becomes `NEEDS_REBUILD`.
Neither path adds a durable per-record version ledger or continuously rereads records on healthy
delivery.

While the repair is pending, the conflict changes no published document and cannot advance a partial
successor past the gap. The index is `DEGRADED` and searches continue against the complete previous
validated searcher only within `maxStaleSearcherAgeMs`, measured from the durable conflicting log-
entry timestamp. The wrapper does not temporarily delete the record or publish unrelated later work
around it. If repair has not published by that deadline, new query admission fails with
`FULLTEXT_INDEX_UNAVAILABLE` while reconciliation continues or Harper marks the generation for
rebuild. Retry and restart preserve the original deadline.

A later successful repair recovers automatically, but neither enqueue, writer application, nor
Tantivy commit alone reopens query admission. The wrapper first durably publishes the repaired
watermark, loads the corresponding searcher, completes its required structural validation, and then
atomically installs a new healthy searcher epoch. Only that activation clears the conflict, stale
deadline, and unavailable/degraded state and admits new queries. A reload failure keeps admission
closed and follows the ordinary bounded retry path; it cannot reactivate the prior expired snapshot.
No operator resume is required after the validated activation. Status and metrics retain the failure
ID, unavailable duration, repair attempts, and recovery transition for diagnosis.

Within the uncommitted window, a sharded native latest-version table serializes mutations for the
same primary key and retains delete tombstones until publication. Derived mode releases them only
after the contiguous watermark commits; standalone mode releases them after the corresponding
commit barrier publishes. Derived entries at or behind the published watermark are ignored. Each
accepted upsert is one ordered Tantivy batch: delete the primary-key term, then add the projected
document with its exact version metadata only when the complete projection emits at least one
searchable term. A termless upsert and an explicit delete both emit only the term deletion, while
still completing their standalone sequence or derived log position. The wrapper stores no key/
version-only empty document. Replay and hot delivery in derived mode can overlap without resurrecting
an older document or losing a newer one.

Standalone mode deliberately adds no durable per-record version ledger or point read before every
mutation. Its checkpoint is an opaque source frontier, not a record-version map. After a standalone
commit releases the in-memory latest-version entry, preventing an older mutation from crossing that
checkpoint is the caller's responsibility. The wrapper's receipt reports how many entries were
applied or suppressed within the current window. A caller that cannot provide ordered replay must
rebuild rather than submit uncertain older work.

The latest-version table is bounded by the current unpublished window, not table cardinality, and it
participates in one process-global byte and cardinality budget that also covers queued batches,
tombstones, retained blob holds, and extraction state. Standalone mode clears eligible entries at
its commit boundary. In derived mode, the table also covers out-of-order completion gaps in the
current watermark window. When work ahead of an unresolved gap reaches the budget, hot delivery
returns `deferred` and replay stops at that window; it does not continue accumulating later state.

In derived mode, the initial implementation does not apply mutations beyond a watermark gap to `IndexWriter`.
Tantivy commit publishes every operation accepted since the preceding commit; there is no way to
commit only a prefix after later operations have entered the writer. Work beyond a gap therefore
stays in bounded native staging, outside Tantivy, until the gap closes. The staging table participates
in the same byte and cardinality budget. If a gap exhausts the wrapper's bounded memory/freshness
envelope, it defers and reports the gap to Harper. If Harper's separately owned retention policy
expires that consumer, Harper marks the generation `NEEDS_REBUILD`; the wrapper does not accumulate
unbounded work or publish past the gap. This avoids a separate durable version/tombstone ledger and prevents restart
replay from resurrecting an older upsert or a document deleted beyond the old watermark. The
latest-version table discards a key only after the published watermark advances past that key's
latest contributing position.

A persistent failure is classified before choosing rebuild. A structural failure—invalid cursor
ordering, an unreadable authoritative record, corrupt index state, or expired log retention—fails
the generation and may require rebuild. Retryable Blob unavailability holds that record version's
position only within a release-qualified blocking-gap budget bounded by staging capacity and the
mutation-to-searchable freshness envelope. Age is measured from the durable source-log entry
timestamp so restart cannot reset it. A deterministic extraction failure that retry cannot change
enters the same terminal path immediately; it does not rebuild the entire generation and then fail on
the same content again.

At blocking-gap expiry, Harper submits an explicit record-quarantine mutation. The writer deletes the
record's preceding full-text document, indexes none of that version's sibling sources, advances its
position, records an operator-visible quarantined-content count and failure ID, and marks the
generation degraded. A later source version retries normally and clears the quarantine on success;
a delete clears it without indexing. The first release does not let customer schema choose between
silent omission and endless retry. Quarantine is explicit in status and metrics and never reported
as a healthy complete index.

A deterministic per-source byte, emitted-token, or token-length limit breach does not benefit from
retry and enters source quarantine immediately for that record version. The wrapper never truncates
the source. It deletes the prior document and rebuilds it from the remaining valid sources, or leaves
it absent when none emit terms, then completes the sequence/watermark position. The error record and
status distinguish quarantined sources from affected records. Harper's adapter fixes these limits;
standalone callers may select only equal or lower ceilings within the package hard maximum.
Harper exposes those counters and opaque failure IDs only through operator health surfaces. Search
hits do not carry a quarantined-source flag, and quarantines outside or inside a matching record do
not fail a query that can otherwise return valid hits.

Malformed JavaScript text is handled before lossy UTF-8 conversion. The TypeScript façade validates
every string source for unpaired UTF-16 surrogates; if any source fails, it sends an explicit keyed,
versioned record-quarantine mutation rather than the malformed text. The writer deletes the prior
document, indexes none of that record version's sibling sources, advances progress, and reports the
degraded record. A later valid version clears it. Query input with an unpaired surrogate fails as
`FULLTEXT_INVALID_REQUEST` before normalization or search admission. Native packed decoders also
require strict UTF-8 and reject malformed buffers defensively; no layer substitutes `U+FFFD`. This
record-level rule is intentionally distinct from per-source size quarantine and from invalid UTF-8
Blob extraction.

Fault tests must cover equal versions from different nodes, repeated delivery, delayed post-commit
callbacks, delete followed by stale upsert, the same record updated on multiple workers, a crash
with prepared work beyond a gap, one permanently pending structural entry followed by sustained
traffic, and one permanently unextractable record that enters quarantine without causing a rebuild
loop. Sustained deferral must prove that the retention lease remains valid, replay converges after
pressure clears, and an expired lease transitions once to `NEEDS_REBUILD` rather than repeatedly
restarting catch-up.
Standalone tests cover competing versions within one commit window and verify that checkpoint replay
never submits work at or behind the caller's durable frontier. Cross-commit stale rejection is tested
only in derived mode.

#### Blob and deferred-content contract

Scalar text is packed from the committed record without a second decode. Blob-backed fields carry
an internal opaque blob reference; neither Harper core nor the wrapper interprets raw compressed
file bytes as text. Content is read through a versioned native blob-reader lease that understands
the header, codec, and Harper's cross-worker reclamation protocol. A blob filesystem path is never a
public package argument and is unrelated to Tantivy Directory selection.

The post-commit hook packs only that opaque reference and submits the bounded batch. It performs no
blob lease acquisition, decompression, parsing, or shared atomic operation per blob. After native
admission, the wrapper's bounded extraction lane asks Harper's versioned blob ABI for a
derived-consumer content lease. Losing a race with reclamation or encountering content that has not
yet replicated makes the entry `deferred` with reason `source-required`; it does not turn an already
committed record write into an error. The entry's log position remains an unresolved gap and the
watermark cannot pass it. Any
other entries in the admitted batch may complete, but publication remains limited to the contiguous
prefix.

The content lease is a generic extension of the blob owner's existing cross-worker reclamation
coordination, not a full-text or rocksdb-js blob store. Unlike the current age-capped hash-slot hold,
it has per-content identity, renewable expiry, and an observable expiration result. It is renewed
only within Harper's short blocking-gap budget and released when the mutation is durably represented
by a published watermark, superseded by a newer nonresident version, quarantined, or abandoned during
close. If renewal fails transiently, replay may reacquire or origin-refetch within the remaining
budget. At expiry, Harper publishes the record-quarantine transition before reclamation proceeds; it
does not turn an unavailable Blob into a full-generation rebuild. The wrapper never assumes an
uncapped hold and never reimplements Harper's file identity, codec, reclamation queue, or disk-
retention policy.

Blob reads, decompression, and configured text extraction run on the bounded background extraction
lane while a lease is held. A generation-level pending-work signal, observed through status polling
or a low-rate wakeup, asks the shared runtime to replay from the watermark; there is no per-record
JavaScript callback. Bounded native backoff may retry while the lease remains valid. Harper freezes
the maximum blocking age during qualification; it is not an `@fullText` option and may not exceed the
freshness/staging envelope. The durable source-entry timestamp supplies the age anchor. Expiry emits the explicit record-quarantine
mutation described above, removes the old document, and advances progress. Unsupported media,
invalid UTF-8, or corrupt content that is deterministically terminal takes that path without waiting
for the budget; no failure silently advances under a retry classification. A 24-hour blocking window
is explicitly rejected without a durable out-of-order ledger because one missing Blob would stall the
complete index.

The initial security boundary is narrow: record string values and declared `text/plain` Blob
content with no charset or with `charset=utf-8` only. Tantivy is not a document extractor. PDF, DOCX,
HTML, archives, images, and other binary formats are deferred until a separate extractor design
defines process or sandbox isolation, per-document byte/CPU/deadline limits, decompression-ratio
limits, a malformed-document fuzz corpus, crash containment, and media-type-specific normalization.
An extractor failure cannot panic or poison the writer. An invalidated caching-table record may no
longer contain the fields needed for rebuild. The rebuild coordinator uses Harper's existing table
source resolution to refetch the complete record, including any Blob; the wrapper does not receive a
URL, source callback, or second fetch API. An actual cache eviction has already removed the local
full-text document and does not participate in the rebuild scan. Because `getFromSource()` may
resolve before its cache-fill transaction commits, rebuild
publication waits for the resulting committed log position to be covered. Delivery from both the
scan and the cache-fill log is safe under the wrapper's version/idempotence contract. A missing or
failed source response follows the bounded retry and terminal extraction policy rather than silently
indexing stale content.

A required fault test accepts a blob-backed mutation, pauses extraction before lease acquisition,
supersedes the record with a nonresident version from a different Worker, runs reclamation, and
crashes before the newer mutation publishes. The nonresident version must win, remove searchable
text, cancel or release any older lease, and prevent the stale extraction result from entering the
writer. After restart, replay converges and no hold survives its owning work. Companion cases cover
lease-acquisition races, successful extraction, terminal failure, and shutdown.

#### Rebuild handoff

Rebuild remains generation-based and never clears an active Directory:

1. Capture the current aggregate `LogWatermark` before scanning. Starting the scan later is safe because a
   mutation between boundary and scan may appear in both sources, and application is idempotent.
2. Scan authoritative records into a private `BUILDING` generation in bounded batches.
3. Replay from the captured watermark until close to the current tail.
4. Under the shared dispatcher fence, register the building generation for live delivery and capture
   the exact handoff watermark. Every later commit is either delivered to the building generation or
   lies beyond a replay cursor it still owns.
5. Drain through that handoff watermark, commit the new generation with its contiguous watermark, and
   atomically swap the active head.
6. Release the old generation only after its readers and leases drain.

Completeness requires either a finished authoritative scan or derived coverage through a completed
base-copy cursor, plus contiguous log coverage from the captured boundary through handoff. The log
watermark alone is insufficient because replication base-copy rows can be represented by one table
`reload` control entry rather than per-row mutations. Any
`base-copy-start` observed after the boundary invalidates the active completeness claim and creates a
private generation. Committed copy batches feed full records directly into it, and its copy-scoped
cursor is durable with each derived commit. At completion, the runtime asks the existing copy source
to replay any interval between the derived cursor and the copy completion cursor, or performs an
authoritative scan when that interval cannot be replayed; it never treats `reload` as a no-op. Only
then does ordinary log catch-up and handoff publish the generation. If the log boundary falls behind
retention, the build restarts from a new boundary rather than publishing a partial generation. Scan
progress and the copy cursor are resume keys, not standalone completeness claims. Clear and
source-option changes use the same shadow-generation protocol. The runtime owns this scan/replay/
handoff once for both HNSW and full text.

Generation state is explicit in the query contract. `BUILDING` without an older active generation
returns `FULLTEXT_INDEX_REBUILDING`; `NEEDS_REBUILD`, failed activation, or a stale generation beyond
policy returns the corresponding unavailable error. It never opens an empty generation and reports
an empty exhausted result. When a prior active generation remains inside the freshness policy,
queries may continue against that pinned snapshot while status exposes the building generation and
lag.

A continuous primary-key reconciliation sweep is not the first-release completeness authority. A
one-way primary scan cannot detect ghost terms for deleted/evicted records, a matching record version
cannot prove correct analyzed terms, and comparing two asynchronously changing stores without a
shared snapshot creates false repair decisions. A bidirectional snapshot-pinned verifier could be a
future operator diagnostic, but at 100 million records its primary/index I/O must be independently
budgeted and it must report divergence rather than silently mask delivery defects. The initial design
uses explicit `reload` invalidation, retained log positions, shadow rebuilds, and independent golden
oracles as fail-closed mechanisms.

#### Rebuild ownership and API boundary

The wrapper never orchestrates a source rebuild. It can create an empty generation, accept bounded
complete mutation batches, commit/checkpoint them, validate the resulting Tantivy generation, report
a terminal `rebuildRequired` state with a reason, and close it. It cannot enumerate Harper records,
open a table, inspect a catalog, acquire application credentials, invoke a source URL/callback, choose
a scan boundary, decide whether an old generation remains serviceable, or publish a Harper schema
generation. The public API contains no source iterator or callback registration.

Harper maps terminal wrapper failures to its persisted NEEDS_REBUILD lifecycle, creates a shadow store/generation, scans authoritative records, replays retained changes, validates coverage and activates through the catalog. fulltext reports storage/engine health and completion; it does not choose sources, scan records or define log cursor operations.

A standalone native caller owns its equivalent source scan, checkpoint, replay and active-generation selection. Both entry points use the shared engine; only Harper orchestrates Harper rebuilds.

## Package architecture

```text
@harperfast/fulltext/native ── MmapDirectory ─────────────┐
                                                       ├─ shared IndexRuntime
@harperfast/fulltext/harper ─ Harper-backed Directory ────┘
                                  │
                       bounded storage transport
                                  │
                       Harper's existing store APIs
                                  │
                       Harper-owned RocksDB
```

The native factory accepts a filesystem path. The planned Harper factory accepts an internal,
lifecycle-scoped Harper integration context; its exact shape follows the storage proof, and it
accepts no database path or raw native RocksDB handle. It does not open another database.

One implementation owns mutation decoding, indexing, query construction, commit, reload, status,
cancellation and close. Harper adapts nonblocking delivery and durable progress reporting; it owns
replay and rebuild orchestration. Standalone native callers use awaited apply and explicit commits.

Keep Rust engine code, Node-API glue, TypeScript façade and Directory implementations in separate
modules. Reuse the current repository layout; add a Harper integration module and tests when its
behavior is implemented. Do not add a standalone rocks factory, native capability table or a second
platform-artifact matrix. The native filesystem path delegates to Tantivy rather than implementing
filesystem I/O again.

Build and test artifacts, API documentation, examples, provenance, supported platforms and
Apache-2.0 metadata remain library release requirements. [Tantivy storage through Harper](./tantivy-rocksdb-directory-design.md) contains the packaging boundary.

## Runtime model

### Writer

Tantivy permits one `IndexWriter` for a directory and gives that writer its own indexing workers
and bounded shared pipeline. “One writer” means one native writer object and one exclusive commit
authority, not one Harper worker feeding it. In Tantivy 0.26.1, `add_document`, `delete_term`, and
`run` take shared access; `prepare_commit` and `commit` take exclusive mutable access. The wrapper
uses that distinction directly:

```text
Worker A ─┐
Worker B ─┼── bounded same-thread coalescing, then one nonblocking N-API enqueue
Worker N ─┘                         │
                                   ▼
               sharded bounded admission queues
                    + aggregate byte budget
                                   │
                         admission policy
                    ┌──────────────┴──────────────┐
                    │                             │
          standalone apply order        derived multi-log gate
                                                  ├── post-gap work ─► bounded staging
                                                  └── contiguous prefix
                    │                             │
                    └──────────────┬──────────────┘
                                   │
                      sharded native ingestion lanes
                                   │ shared writer access
                                   ▼
                       one Tantivy IndexWriter
                                   │
                         exclusive commit barrier
  ├── capture sequence B; queue admission remains open
  ├── hold operations after B outside the writer
  ├── drain every accepted operation ≤ B
  ├── derive PublicationState for completed work
  ├── prepare_commit; set the canonical tagged payload
  ├── invoke the Directory durability barrier
  ├── atomically publish meta.json with PublicationState
  └── reopen the writer gate and return the typed commit receipt
```

Admission has one single-writer shard per write-capable Node environment and index. Each shard
borrows byte and cardinality credits from the process budget in coarse bounded blocks, spends them
on its owning environment without a cross-worker cache-line write per delivery, and returns or
reconciles them at low-water, idle, and environment teardown. The global budget bounds the sum of
outstanding blocks regardless of the operator-configured Worker count; registration does not hash
multiple Workers onto one hot counter. Each environment/index shard is an SPSC ring: the owning
worker publishes one tail update per coalesced batch, and the native consumer advances its head.
Wakeups are edge-triggered and amortized while the shard remains nonempty. There is no global enqueue
mutex or shared budget atomic read-modify-write on every record; the unavoidable queue handoff is
bounded to one producer/consumer cache-line exchange per coalesced delivery. Contention while
acquiring a new credit block, queue-tail handoffs, and wakeups per batch are measured separately.
At the maximum supported Worker count, the indexed-write gate asserts no global hot counter and the
frozen upper bounds for these handoffs rather than the impossible absence of all shared cache lines.
After one shard latches catch-up, later deliveries read an environment-local latch and perform no
shared budget load or credit-acquisition retry until the native consumer clears that latch through
the normal shard handoff. The sustained-saturation gate reports global-credit acquisition attempts
per delivered record and requires O(1) attempts per shard/latch interval, not O(1) per record, while
also enforcing the unrelated primary-write p99 bound.

The minimum credit block is a frozen process value, not a per-index default. Preflight computes the
worst-case active shard floor as write-capable environments × concurrently resident index
generations, including an admitted shadow generation, × minimum block. That floor must fit the
process admission budget with its reserved replay/commit margin before activation. If it does not,
Harper rejects the index/worker configuration or refuses the shadow-build admission explicitly; it
does not create shards that can never acquire credit and then serve permanently stale indexes.
Because Harper can change/restart its Worker set after schema activation, the same floor is
recalculated at every environment/shard registration and before applying a thread-count change. An
unfundable new shard is not registered: that environment is explicitly `replay-only` for the index,
its status names the capacity refusal, and its writes remain covered by the log reservation. The
background replay budget is separately reserved, so refusal cannot consume the mechanism needed to
converge. Qualification adds an N+1 environment after activation and requires this visible state
instead of silent permanent deferral.

Projection and UTF-8 encoding also have strict per-field, per-document, per-batch, and hot-path byte
ceilings. The packed decoder validates them before allocation or any Tantivy call; caller policy may
lower but never raise the package hard maxima. A larger transaction returns `deferred` without
retaining its projection and is replayed under the separately bounded background budget. The
wrapper queues are bounded by command count and retained bytes. Their nonblocking admission protects
the post-commit hook from Tantivy's documented behavior of blocking when its own pipeline is full.
Only package-owned ingestion lanes may wait inside `IndexWriter.run()`. The lanes share the writer
under a read side of the commit gate, while the commit actor takes the exclusive side. Tantivy's own
indexing threads still build segments in parallel. `catch_unwind` cannot contain an allocator abort
inside Tantivy, and wrapper document ceilings do not bound peak memory while Tantivy merges large
segments. Qualification therefore records peak memory by merge class and runs merge-heavy indexing
inside the minimum supported container/cgroup limit. A measured merge peak plus the process-wide
resident-writer/merger budget must retain the configured safety margin without OOM or allocator
abort. Failure blocks the in-process Harper release and reopens the process-isolation or engine
decision; the design does not describe an allocator abort as recoverable.

The commit barrier closes only the gate into that index's `IndexWriter`; it does not close its public
admission queue. Calls arriving after boundary B may still be accepted within the global budget and
remain queued for the next commit. Derived delivery therefore does not fall back to log replay merely
because a normal commit is in progress.

Each resident generation carries a monotonic health epoch covering the wrapper lanes, Tantivy
indexing workers, updater, and merger supervision. Admission and commit capture that epoch. A
detected critical-task failure increments it, poisons the generation, and prevents the commit actor
from publishing a watermark for work accepted under the older epoch. The watchdog's maximum
detection interval is a frozen internal operating value and is shorter than the minimum publication
deadline; qualification injects a failure immediately before publication and proves that the
watermark cannot advance. `catch_unwind` protects wrapper-owned entries, while the epoch and
watchdog cover failure in Tantivy-owned threads.

If a failure occurs after mutation application begins and the runtime cannot prove the applied set,
the current operation and every queued operation fail with `FULLTEXT_WRITER_FAILED`; the poisoned
writer accepts no retry or commit. The wrapper never retries only the visible failure on that writer
or invokes a broad rollback that could discard earlier uncommitted batches while pretending the
failed call was isolated. Reopen starts from the last durable commit payload and a new writer epoch.
Standalone callers replay from their committed checkpoint; derived mode resumes through its durable
log cursor and rebuilds only when retained replay or index validation cannot recover. No unknown
partial state can become searchable or advance a watermark.

#### Writer residency and resource accounting

Tantivy 0.26.1 requires at least 15 MB for each indexing worker and its `IndexWriterOptions`
defaults to one indexing worker and four merger threads. The wrapper always supplies explicit
values; it never creates a writer with Tantivy's defaults. The initial operating point is one
indexing worker and one merger thread per resident generation. Additional indexing or merge
parallelism is granted only from the process-level governor after the workload proves that it
improves throughput without violating query or primary-write p99.

A permit around individual operations is not enough because an idle `IndexWriter` still owns its
threads, queues, and arena. The registry therefore distinguishes `resident`, `draining`, and
`parked` writer states and enforces a hard resident-writer count, total indexing arenas, merger
threads, and shadow-generation budget. A parked derived index retains only its identity, durable
published watermark, and health metadata. Hot delivery to it returns `deferred` without retaining
record content, and its next fair activation resumes from the transaction log. Closing or parking a
writer, including waiting for merge threads, happens on wrapper-owned background execution and
never on a committing worker or query path. Search readers may remain resident independently of a
parked writer.

Declared capacity and resident-writer capacity are separate. The process-global registry rejects a
new logical index after the host-supplied registered-index cap; Harper also rejects a table schema
after its server-level full-text-target/fan-out cap. Within those caps, declarations may exceed the
resident-writer envelope. A fair scheduler rotates writable generations by lag, oldest pending
position, and live-versus-rebuild class. A rebuild receives bounded quanta and cannot monopolize the
resident set; repeatedly opening and closing a sparse index for individual mutations is forbidden.
An active shadow generation consumes a resident-writer permit independently of the serving
generation.

Parking removes only the writable runtime. The last validated published reader may remain resident
and searchable within the process-level `maxStaleSearcherAgeMs` bound; it is not evicted merely
because its writer parks. Delivery defers without retaining record content, and reactivation catches
up from the retained log. If a parked index cannot publish within its freshness/degraded bound, it becomes
operator-visible as stale and then unavailable under the normal fail-closed policy. Runtime status
reports parked indexes, activation wait, resident and declared capacity, publication lag, and
estimated log-retention headroom.

Qualification freezes the shipped defaults and supported maxima for registered indexes, Harper
targets per table, resident writers and readers, concurrent shadow generations, writer-residency
quantum, shard credit block, and their thread/memory envelope. Preflight and every environment or
thread-count change must prove that the worst-case shard floor plus replay/commit reserve fits the
host budget. A value outside the published envelope is unsupported even if it happens to open on a
larger machine; the design does not invent numerical limits before the multi-index workload measures
them.

#### Derived publication scheduling

Current Rocks-backed HNSW has no separate publication cadence: graph-node writes use the record's
RocksDB transaction. The opt-in native HNSW plane proposed in PR #2430 mirrors mutations immediately
and uses a relaxed durability barrier every 4,096 mirrored mutations because the RocksDB graph is
authoritative and the mmap plane can be rebuilt. That number is not a Tantivy default. A Tantivy
commit controls search visibility as well as the durable metadata head, so a mutation-count-only
policy could leave a quiet index stale indefinitely.

Derived full text uses a hybrid scheduler. For every resident generation it records the first
unpublished time, affected-document count, encoded bytes, pending watermark span, and merge debt.
A commit becomes eligible when either the affected-document threshold or byte threshold is reached,
and it becomes due when maximum unpublished age expires. A minimum interval coalesces bursts; a
forced lifecycle operation such as graceful close, rebuild handoff, or backup barrier may bypass the
interval. Position-only no-ops advance the in-memory contiguous frontier but do not by themselves
force an empty Tantivy commit; when the frontier needs durable publication, the scheduler may publish
metadata without pretending a document was indexed.

Under the qualified steady-state workload, commit-to-searchable latency for a successful
source-changing record commit has a one-second p99 objective. The internal maximum unpublished age
must leave measured budget for Tantivy commit, the RocksDB durability barrier, head publication, and
reader reload inside that objective. This is an operational SLO, not transaction visibility and not
a customer schema setting; rebuild, recovery, and storage-pressure states report their own lag.

The process governor supplies a global commit permit and, initially, one concurrent
commit/durability barrier per rocksdb-js `DBDescriptor`. Different databases may publish in
parallel within the global limit; indexes sharing one database are selected fairly by oldest due
time, then lag and accumulated bytes. The selected commit captures one boundary and coalesces all
eligible work through it. Concurrent source delivery remains open for the next boundary.

RocksDB stall, flush, compaction, or disk-pressure signals suppress threshold-triggered commits and
rebuild publications before they worsen primary traffic. Maximum age is a freshness objective, not
permission to force a dangerous flush: if pressure prevents safe publication through the age bound,
Harper continues serving the last published snapshot while policy marks the index stale or
unavailable and exposes the lag. The first release keeps interval, byte/document thresholds,
per-database concurrency, and pressure response in trusted runtime configuration rather than the
customer schema. A customer-visible freshness class can be added later only if measured operating
points support a stable contract.

Every write-capable Harper worker uses the shared runtime for nonblocking delivery. The registry identifies the actual Harper store, logical index and generation; store closure or recreation invalidates old handles. The integration proof must establish cross-worker identity and duplicate-writer exclusion using supported host APIs, without a native rocksdb-js lease.

Each registry entry also records one immutable delivery mode: `standalone` or `derived`. Reopening
the same storage identity and generation in the same mode may share the writer; attempting to open
it through the other factory fails with `FULLTEXT_INVALID_REQUEST`. On open, the factory also
validates the active commit payload's mode tag. An empty generation adopts the requested mode; an
existing generation with the other tag cannot be reinterpreted and must be replaced by a new
generation/rebuild. This keeps one physical Directory, one writer, and one recovery authority from
ever sitting behind conflicting JavaScript interfaces.

Native mode delegates locks to MmapDirectory. The Harper Directory must preserve Tantivy writer/meta-lock semantics within the shared per-index runtime and Harper store lifecycle. Prove exclusion across worker attachments and drop/recreate; do not add native lock tokens to rocksdb-js or a persistent distributed lock service.

Lock ownership and generation activation are separate. The lock prevents simultaneous writers for
the same Directory. When Harper activates a rebuilt generation, its existing catalog transaction
must verify the expected active generation before replacing it. A stale build may finish, but it
cannot become active. The wrapper does not create an epoch protocol or a second metadata authority.

Prepared commit is not a publication boundary. After `writer.prepare_commit()`, the shared actor
calls `PreparedCommit::set_payload()` with the canonical tagged `PublicationState`: standalone mode
contains its optional caller checkpoint, while derived mode contains the contiguous aggregate log
watermark. The subsequent `atomic_write(meta.json)` makes the matching segments and publication
state searchable together. `MmapDirectory` supplies the native durability behavior;
`RocksDbDirectory` maps the same Directory calls to its object flush and one bounded rocksdb-js
`WriteBatch` for atomic replacement. A kill immediately before or after publication yields either
the prior complete commit or the new complete commit.

Tantivy's `ManagedDirectory` remains responsible for the logical managed-path list and garbage-
collection decisions. `.managed.json` uses the same ordinary Directory `atomic_write` path and is
not parsed, version-paired, or rewritten by Harper. `META_LOCK` continues to protect reload versus
GC. `RocksDbDirectory::delete()` removes only the named logical binding; any live `FileHandle`
continues to own immutable bytes as required by the Directory contract. Unreferenced immutable
objects may be reclaimed after handles drain, but the wrapper does not decide which Tantivy files
are live.

The Harper proof selects a durability sequence using existing supported storage APIs. Evaluate WAL-enabled derived writes and supported atomic transactions before assuming WAL-disabled objects need a specialized flush. Record exact write options and demonstrate object durability before durable metadata acknowledgement.

Measure shared RocksDB memory, automatic flush, compaction and write-stall pressure alongside authoritative writes. A narrow logical index namespace does not establish physical isolation. Existing database configuration and log-flush accounting remain owned by Harper and rocksdb-js.

If throughput or interference misses its gate, first profile queue wait, transport crossings, copying, batching, database pressure and query execution. Revise the integration within supported APIs. A performance miss does not automatically authorize target-CF flush, external SST ingestion or another base rocksdb-js interface.

The recovery invariant is simple: a durable published head may be behind authoritative records but
may not reference missing derived objects. The aggregate log watermark then drives catch-up. A kill
matrix must prove that every recovered head is either the prior complete commit or the new complete
commit and that no recovered metadata names an absent object. If the supported RocksDB matrix cannot
prove this ordering or the automatic flush path misses the primary-write gate, the Rocks adapter
does not ship.

Backup and restore use the same invariant. In rocksdb-js 2.8.0, directory and streaming backup derive
the default `flushBeforeBackup` from the handle on which backup is invoked. Harper's root handle uses
WAL, so the default is false even though derived CF handles disable WAL. Harper must explicitly
request `flushBeforeBackup: true` (or a future equivalent DB-owned barrier) and wait for registered
derived-store operations before snapshot capture. `createCheckpoint()` already flushes every column
family, including WAL-disabled writes, but it needs the same derived-operation fence. The wrapper
does not add a backup format or copy files.
After restore, `RocksDbDirectory` validates that every binding in the selected head resolves to
a complete object before opening the reader. An incomplete current head falls back to the retained
preceding manifest when it validates, using that head's older checkpoint/watermark for catch-up; only
two invalid heads fail the generation closed. In derived mode, Harper also asks the transaction-log
owner to reject a restored watermark that is ahead of a restored log tail, belongs to a different
log incarnation, or otherwise cannot resume exactly; the generation becomes `NEEDS_REBUILD`. In
standalone mode, the caller compares the restored checkpoint with its source and either replays
after it or rebuilds. Backup/restore qualification is a correctness gate, not only a latency
measurement.

A Harper replica join/reseed that uses a physical RocksDB checkpoint follows this same validation
path and retains a compatible complete derived generation. It does not transfer the full-text CF and
then discard it for an unconditional 100-million-record rebuild. A logical-record-only join has no
derived bytes and uses the normal scan-plus-log rebuild; live replication continues to derive from
local authoritative commits.

The workload manifest varies publication cadence and batch bytes and measures CF-count-sensitive L0
creation, fsync/flush/ingest latency, forced memtable flushes, temporary-file cleanup, DB-wide
stalls, and search freshness. Any future WAL-enabled candidate must also prove checkpoint/backup,
mixed write-policy, and WAL-retention behavior under large segment writes; the ingest candidate must
prove orphan recovery and restore/backup behavior. The chosen strategy must meet freshness and
unrelated-primary-write gates; otherwise the feature does not ship.

### Multiple indexes and parallelism

The registry owns one runtime and one Tantivy `IndexWriter` per storage identity, logical index ID,
and generation. “One writer” therefore does not mean one writer for the process or database. Two
different full-text indexes have independent writers, queues, commit actors, readers, watermarks or
checkpoints, and failure states. Their ingestion and publication may execute concurrently. Within
one index, many Node Workers and native ingestion lanes may apply mutations in parallel, while that
index's commit actor alone serializes its publication boundary.

```text
committed record batch
         │ one Harper interest/projection pass
         ├──► index A queue ─► writer A ─► commit A / watermark A
         ├──► index B queue ─► writer B ─► commit B / watermark B
         └──► index C queue ─► writer C ─► commit C / watermark C

                 all writers share process-level work and memory budgets
                                      │
                                      ▼
                         one rocksdb-js database lifecycle
```

Harper discovers interested derived indexes once for each committed batch, normalizes the committed
records once, and emits one packed projection per target index. Delivery to one index never waits
for another index: a saturated or failed target returns `deferred` and catches up from its own log
watermark while healthy targets continue. Text analysis and Tantivy mutation work remain inside
each target runtime. Identical projections may share encoded input only if measurement justifies
the ownership complexity; the initial contract does not require cross-index buffer sharing.

Parallelism remains bounded across the process. Per-index queues sit under the existing global
in-flight byte and command budget. The wrapper also enforces process-level permits for active
indexing work, commits/durability barriers, and searches. Every resident writer uses explicit
`IndexWriterOptions`, and its indexing arena and merger threads are charged before construction. An
active shadow rebuild counts as another generation. The hard resident set and parked-state replay
described above prevent the number of declared indexes from multiplying Tantivy's worker, merger,
and memory defaults. Search uses one shared process executor; Tantivy writer and merger execution
that cannot use it remains bounded by the resident-writer cap rather than another unbounded pool per
index.

These are trusted process-level resource settings, not per-index schema options. Schema activation
enforces an operator-owned maximum number of full-text targets per table so the post-commit fan-out
is bounded. The wrapper independently enforces the host-supplied registered-index and resident-
writer caps. Declared indexes within the first cap may exceed the second and use fair parking/replay;
there is no unlimited registration mode. Runtime status reports process capacity, queued and parked
indexes, fairness, freshness, and throttling. The writer scheduler must prevent a large rebuild or
hot index from starving other live indexes.
Tantivy commit actors for different indexes are independent, but the initial Rocks implementation
admits only one commit/durability barrier at a time per `DBDescriptor`. That is the actual
publication throughput boundary for indexes sharing a database; ingestion, segment construction,
merging, and search can still overlap. rocksdb-js 2.8.0 likewise sends asynchronous
`Transaction.commit()` through one dedicated commit thread per database by default. A native
synchronous-publication batch does not create a second wrapper-owned commit lane: it joins the
DB-owned publication permit and ordering/lifecycle controls. RocksDB can still serialize or stall
work below that permit because every Rocks index shares database-wide write buffers, compaction,
cache, WAL, and disk. The mixed-workload qualification measures the queue, barrier, and storage
contention rather than promising linear scaling.

Publication is intentionally not atomic across full-text indexes. Each is a replayable derived view
with its own freshness boundary, so a record may become searchable in index A before index B. A
failure or rebuild in one index does not roll back another. Querying multiple full-text indexes in a
single expression is a separate Harper planner capability and is not implied by supporting multiple
declared indexes.

### Search

Search runs in a package-owned bounded pool. Each process-global index runtime owns one
`IndexReader` and an atomically replaceable `Arc<Searcher>` pinned to a published generation;
environment-local handles borrow that snapshot. The runtime also owns an atomically replaceable
`Arc<RankingConfig>`. A search captures the searcher and ranking configuration once before building
its query, so an in-flight search cannot mix revisions. One request contains one bounded full-text
query tree, analyzed terms, limits, work budget, deadline, and optional encoded eligible-key set.
The eligible-key set compiles to a `TermSetQuery` over the untokenized internal primary-key field,
wrapped in `BoostQuery` with boost `0.0`. The wrapper is required because a bare Tantivy 0.26.1
`TermSetQuery` reports a constant score. With the zero boost it constrains membership without
contributing to `$score`, so structured-first and text-first plans produce identical scores for the
same documents and generation.
Field boosts are taken only from the captured ranking configuration; the request has no boost or
ranking-profile field. It also has no minimum-score field: raw BM25 magnitude is not stable across
corpus, ranking, schema, or engine revisions and is not a filtering contract. The tree contains
bounded AND, OR, and negation nodes over one logical index, with a positive scoring anchor in every
disjunctive branch. The native layer builds Tantivy query objects directly; it never accepts
Tantivy's query-string language.

The first release keeps no result-set or compiled customer-query-plan cache in either backend. Each
request analyzes and constructs its bounded query against one captured searcher/ranking revision,
while warm reuse comes from Tantivy's reader structures and the backend's existing mmap/page or
RocksDB block cache. This avoids stale-generation results, authorization/eligible-key/filter key
explosion, and native memory competition with primary data. Benchmarks must meet p99 without
repeated identical-query hits; response caching remains an embedding-application concern.

Ordinary term clauses sum every matching field's weighted BM25 contribution. Cross-field occurrence
is evidence, not an alternative from which only the strongest field is retained. Prefix completions,
exact-versus-fuzzy alternatives, and exact-prefix-versus-fuzzy-prefix alternatives remain zero-tie
disjunction-max groups because those clauses are generated from one logical input token. Tantivy's
fuzzy automaton is constant-scored. The exact branch is a Boolean sum of the BM25 `TermQuery` and a
fixed exact-match preference bonus supplied by `ConstScoreQuery` over the same term. Both clauses
are `Must`, so they match the same documents and their scores add; the outer
zero-tie `DisjunctionMaxQuery` then compares that summed exact branch with the constant-scored fuzzy
branch. Keeping the two exact clauses inside one branch is required—placing the bonus beside it in
the outer disjunction would select rather than add it. The bonus is strictly greater than the fuzzy
branch's fixed score; exact matching therefore wins the group without claiming that raw fuzzy score
is BM25. Exact-prefix uses the same higher-constant-score rule. All constants are release-owned and
benchmark-qualified.

The wrapper uses Tantivy 0.26.1's fixed BM25 constants, `k1 = 1.2` and `b = 0.75`. They do not appear
in open-index, ranking-update, or search-request options because this Tantivy revision exposes them as
implementation constants. Postings retain term-frequency and field-norm inputs from which block
maxima are derived at query time, so a future parameter-only change is not presumed to require a
rebuild. It stays inside Tantivy, must pass relevance/pruning qualification, and changes the ranking
revision; the pinned dependency revision must prove index-format compatibility before reuse of an
existing generation. The wrapper does not fork scoring into a Harper-owned BM25 implementation.

Term-any, term-all, and fuzzy query builders deduplicate identical terms after analysis and before
clause accounting or expansion. Exact-prefix and fuzzy-prefix builders deduplicate the completed
exact terms while keeping the final prefix as a distinct required clause. Phrase builders preserve
duplicates and order. Canonicalization therefore prevents score and work-budget inflation without
changing positional meaning.

`updateRanking()` canonicalizes and validates positive finite weights, requires the exact structural
field set of the open generation, verifies the supplied ranking fingerprint, and atomically swaps the
configuration. It performs no Tantivy commit or Directory write. The caller owns durable declaration
state and supplies the desired configuration again on reopen; status exposes the active fingerprint
for rollout and benchmark attribution. Reapplying the same fingerprint is idempotent.

Generation creation sorts unique structural fields by canonical field name before assigning Tantivy
field identities. Open and ranking update resolve persisted fields by name, not input array position.
Reordering an otherwise identical `fields` array therefore changes neither the structural nor
ranking fingerprint and performs no Directory work. The wrapper does not receive Harper's
presentation-only source order used for highlight tie-breaking.

Maximum result window, Boolean-tree depth, total Boolean clauses, and
prefix/fuzzy/fuzzy-prefix expansion and automaton work are fixed package release limits with no
open-index or search-request override. Both native and Harper backends enforce the same ceilings, so
standalone or embedding callers cannot bypass them. Their values are selected with adversarial
benchmarks and published with each release. Harper rejects violations before Node-API and may impose
equal-or-lower internal eligible-key, result-window, candidate-production, deadline, and work budgets;
it can never raise a package ceiling. These are not customer-controlled full-text options. The
initial implementation permits one candidate-production pass. Metrics label query classes and
outcomes only; they never contain query text, record keys, or caller-provided strings.

The low-level wrapper accepts one absolute deadline and `AbortSignal` for standalone and embedding
use. Harper derives that deadline from its existing request context, capped by the wrapper/server
safety ceiling; it does not expose a second full-text timeout in schema, `Table.search()`, or REST.
Queue wait, analysis, scoring, candidate work, and match tracing share the original deadline and
cannot reset it between phases.

Every full-text query requires a finite `limit`, and `offset + limit` must fit the package's fixed
hard result-window ceiling. An omitted, infinite, or oversized value fails with
`FULLTEXT_QUERY_LIMIT`; the wrapper never substitutes an implicit page and presents it as an
exhausted result set. Harper applies its equal-or-lower benchmark-defined maximum before calling the
wrapper, while the wrapper enforces its own ceiling defensively in both storage modes. A direct
standalone caller receives the same error at the package ceiling. `FULLTEXT_QUERY_UNSUPPORTED` is
reserved for query shapes or capabilities the implementation does not support. `minResults` begins
at `offset + limit`, and companion-filter acquisition either reaches that window, proves exhaustion,
or returns the explicit bounded-work failure defined by Harper's approximate-index contract. The
internal native cursor, if present, cannot be supplied to or resumed through this public query
shape.

Harper search requests contain no source watermark, commit receipt, or wait-until position. They
acquire the latest published searcher immediately. The wrapper retains explicit `commit()`,
`reload()`, checkpoint, and status facilities for standalone ownership, Harper coordination,
backup, tests, and operator tooling, but Harper does not translate those facilities into a customer
consistency option.

Results are returned in one packed buffer containing encoded Harper primary keys, exact record
version bits, scores, and exhaustion metadata. Native top-k ordering is descending score followed by
ascending bytewise encoded primary key for equal scores; the tie-breaker is mandatory rather than a
request option. Harper loads and authorizes the current records. The wrapper does not call JavaScript
predicates during scoring.

When the internal request opts into highlighting, the result also contains a bounded opaque match
plan produced from the already validated native query. Harper batches the current top-k source values
into `traceMatches(plan, sources)`. The wrapper reruns the same versioned analyzer and query-match
semantics over those values and returns packed source/value identities, match kinds, quality, and
original-source UTF-16 spans. It handles term, phrase, stemming, prefix, fuzzy, fuzzy-prefix, and
index-time synonym provenance; positive scoring clauses produce traces and exclusions do not. The plan and
source buffers are process-local, size-bounded, never persisted or logged, and rejected if their
protocol, analyzer, structural schema, or ranking fingerprints do not match. Tracing performs no
Directory reads or writes and is one batch crossing rather than a callback per record or token.
Stemmed, folded, prefix, fuzzy, fuzzy-prefix, and synonym-derived matches return the complete original
source-token span rather than a query-length or edit-aligned substring. A phrase returns one span from the first
matched token's start through the last token's end and cannot cross a field or repeated-value
boundary.

Match kind and quality remain wrapper-internal inputs used to select and order fragments. Harper's
public `$highlights.fragments[].matches[]` entries contain only `{ start, end }`; the façade does not
translate exact, stemmed, folded, prefix, fuzzy, fuzzy-prefix, or synonym provenance into a customer
compatibility contract or expose a detailed tracing mode.

Each fragment also carries zero-based UTF-16 `sourceStart`. Its text is an exact source substring
without an injected ellipsis, and match spans remain fragment-relative; clients can add
`sourceStart` to recover source-relative spans. The packed trace result supplies source offsets, and
the façade validates every source, fragment, and match boundary before serialization.

The configured `fragmentLength` is a context target. Native tracing may expand a fragment beyond it
to preserve a complete matched token or phrase, but only up to the fixed server-supplied hard cap. A
match that itself exceeds the cap produces no partial fragment: the wrapper marks tracing incomplete
for that record and may return other valid fragments. Search hits and scores remain valid.

The wrapper forms context windows and merges overlapping or touching windows only within the same
source/value identity and only when the union fits the hard cap. It emits the union as one exact
source substring and coalesces overlapping spans. Over-cap unions remain separate bounded candidates.
Ranking and `maxFragments` run after merging, so duplicate context does not consume multiple fragment
slots.

Candidate ranking is descending distinct positive-clause coverage, then descending query-plan match
quality combined with the active source weight, then descending match density. Synonym-derived and
literal terms remain equal; fixed lower-quality paths such as fuzzy use the same plan semantics as
search. Ties resolve by Harper's presentation-only source order, ascending value identity, and
ascending UTF-16 source offset. This native tracing rank affects only fragment selection and cannot
change document scores or hit order.

The wrapper selects from one global merged-candidate pool per hit. It applies no per-source or per-
value reservation or diversity quota before `maxFragments`; multiple nonoverlapping fragments from
one value may win when they rank highest. The existing deterministic tie sequence remains unchanged.

The packed trace result includes the originating value identity already used during batched source
submission. Harper exposes it as optional zero-based `valueIndex` only for `[String]` fragments;
scalar `String` and `Blob` fragments omit it. Harper validates the index against the materialized
source array before serialization. The value is not persisted in Tantivy, and the wrapper or façade
does not define a generic source-path language.

The wrapper budget excludes neither candidate validation nor record materialization from the
product goal: wrapper-only latency is reported separately, but release qualification measures the
complete `Table.search()`/REST path including every primary-store point read. In the initial release,
Harper rejects full-text queries requiring record-level `allowRead` or row filtering because global
BM25 statistics, ranking, short pages, and exhaustion can leak information about hidden records.
Attribute permissions are role-scoped rather than schema properties, so activation does not claim to
validate them globally. On every request, Harper uses the existing resolved
`getTablePermissions(user, target)` result and rejects full-text execution when the resolved
permission object cannot read every indexed source attribute: hiding the returned field does not
hide its contribution to global BM25 statistics or ranking. Before asynchronous `allowRead` can
clear or replace `target.checkPermission`, the query captures an immutable per-request
`fullTextPermissionContext` containing that resolved permission object and eligibility verdict.
Re-entrant search reads only this captured context and fails closed if permission resolution returned
`undefined`; it never falls back to the broader role after a target-supplied permission object was
cleared. A new request resolves permissions again, so role changes take effect through Harper's
existing permission path without inventing a schema/permission revision primitive or a cross-request
eligibility cache. Ordinary table/field authorization still applies to unrestricted indexed sources.
The first release assumes one row-read audience per full-text generation and does not introduce a
partitioned authorization or BM25-statistics model.

The first-release predicate is conservative and mechanical: full-text query execution is unavailable
when the concrete resource overrides the base table's `allowRead`, when the resolved target has any
`rowFilter`, or when an indexed source attribute has attribute-level read restrictions. Static
table-level permission checks that do not vary record visibility remain supported. Harper does not
inspect custom code and guess that an `allowRead` override is table-invariant; applications using
such an override must use a separate unrestricted resource/table for full text until a partitioned
authorization contract exists. That decision is evaluated for every request after protocol
overrides attach `allowRead` or `target.rowFilter`; schema-time validation alone is insufficient.
The initial release also rejects a full-text condition combined with `vectorFilter`. That opaque
record predicate cannot run inside Tantivy, and post-applying it to one bounded candidate window
would make page completeness undefined. A later implementation may admit it only through the same
bounded asynchronous candidate-acquisition/exhaustion contract as supported companion filters.
Supported companion AND filters use that new shared derived-index contract in Harper's resource
layer.
HNSW's current `minResults` widening informs the semantics, but the current
`customIndex.search(...).map(...)` path is synchronous and performs only one call; it is not reused
by assertion. The new path performs bounded text-first candidate production, asynchronous
primary-record materialization, cumulative candidate/work accounting, and exact exhaustion
reporting. A filter too broad for the bounded encoded-key path uses that acquisition path; it never
returns an unmarked underfilled or empty page as complete.

One logical query pins one `Searcher` snapshot and considers each candidate at most once. The
initial implementation requests
`min(maxCandidateWindow, max(offset + limit, ceil((offset + limit) * candidateOverfetchFactor)))`
candidates, where both values are immutable process hard limits reported by
`getFullTextCapabilities()` and `maxCandidateWindow >= maxResultWindow`. Phase 0 freezes the numeric
values against named filter-selectivity classes; an implementation cannot choose a private factor.
The wrapper performs that one bounded over-fetch up to the server-owned candidate budget and
returns it as one packed buffer; Harper materializes that buffer in bounded `MultiGet` slices until
it fills the requested page or exhausts the candidates. It does not rerun top-k from rank one with
successively larger limits. This is a release gate rather than a deferred optimization: the
supported filtered-query workload must meet both page-correctness and p99 targets with that single
pass. If it does not, the release must add an opaque, deadline-bound native cursor that owns the
same `Searcher`, total-order tie breaker, cumulative work budget, and cancellation state. Passing
the gate means the cursor is omitted from the first wrapper API. If required, the cursor is an
internal execution primitive scoped to one active query: Harper owns it, never serializes it, and
closes it on completion, cancellation, deadline expiry, request teardown, or index close. It cannot
be resumed by another request or process and is not exposed through `Table.search()` or REST. A
client-visible offset or a document address from a different reader generation is not a
continuation token.

A denied native allocation, read-assembly budget, deadline, or work permit at any point in scoring
or materialization fails the request with `FULLTEXT_RESOURCE_LIMIT` or the more specific typed
deadline/cancellation error. It never converts partial candidates into a short page marked
exhausted and never returns accumulated hits alongside the error. A successful short page requires
proven exhaustion of the captured `Searcher`. The failure includes only bounded counters and a
native failure ID, never query text or
record keys.

These companion conditions are ordinary predicates over records the caller is already authorized
to read; they are not security row filters. Record-level `allowRead` and attached security
`rowFilter` remain rejected before native search because they can change which ranking statistics
the caller is permitted to observe.

Harper enforces that rejection after request guards and protocol overrides have been assembled but
before the new derived-index dispatcher invokes full text. Full-text descriptors never enter
`Table.indices`, so the adapter does not claim a `customIndex.filteredSearch` value or route through
`openIndex()`. The query planner nevertheless marks every condition resolved by a derived index as
an approximate result set through a storage-neutral `touchesDerivedIndex()` capability. That signal
feeds the existing REST count decision. `Prefer: count=exact` returns an unavailable total (`null`,
rendered as `*`) and never drains a bounded full-text candidate set as though it were an exact table
scan. `Prefer: count=estimated` may return a cached estimate from published-generation statistics
only when it can do so without traversing the match set; it remains explicitly inexact. The existing
callback-based HNSW predicate path must never be pushed into Tantivy. Table and field permission
checks occur before native search, and returned record versions are revalidated during
materialization.

The guard keys on whether the resource overrides record-level `allowRead` or has an attached
`rowFilter`, not on the mutable `target.checkPermission` flag. Harper's asynchronous authorization
path re-enters `Table.search()` with that flag disabled after permission resolution, so flag-based
detection is bypassable. The same resource-level guard applies to delete/update scans and every
other route that can construct a full-text condition; tests cover both the initial and re-entrant
paths.

Candidate materialization is explicitly bounded and asynchronous. The integration adds a raw
primary-store `MultiGet` capability for a batch of versioned keys when the store can provide it;
otherwise it uses bounded point-read batches separated by event-loop yields. It does not perform a
long synchronous `.map(getEntry)` over a native result page. Candidate acquisition stops at the
shared deadline and cumulative work ceiling. Release tests budget event-loop delay as well as complete
query p99 from request receipt through authorized records.

### Async execution

Use the Symphony pattern of promise-returning napi-rs methods, but enqueue work into wrapper-owned
actors and pools. Exported async methods wait on native completion channels; they do not perform
CPU-heavy or blocking work on the async runtime itself.

Do not use HNSW's current `AsyncTask` pattern for full-text queries or commits because `AsyncTask`
uses Node's shared libuv pool. Do not allocate a new thread per request. Pool sizes and queue bytes
are process-level internal controls reported through metrics.

### Cancellation and close

The TypeScript façade owns every submitted promise. It translates an `AbortSignal` into a native
request token and unregisters the listener on completion. Cancellation is checked:

- before queue admission;
- between query expansion stages;
- at collector work-budget checkpoints;
- between complete mutation batches;
- before a Directory call that has not entered RocksDB.

Once an atomic RocksDB operation begins, it completes and its result is classified; cancellation
does not pretend to roll it back.

For standalone `apply()`, cancellation before writer admission removes the whole validated batch
and rejects with `FULLTEXT_CANCELLED`; no receipt or writer mutation exists. Once application of the
first mutation begins, the bounded batch is indivisible for ordinary `AbortSignal` handling. The
writer finishes it and the promise resolves with its authoritative `ApplyReceipt` even if the signal
becomes aborted meanwhile. It never rejects as cancelled after changing writer state, stops at a
record boundary with an unreported suffix, or rolls back unrelated uncommitted batches. This remains
an application-order guarantee only; `commit()` defines durability.

`close()` is asynchronous and idempotent after a successful close. Standalone `close()` defaults to
`require-clean`: its writer-queue barrier checks for queued, applying, or applied-uncommitted work,
and if any exists rejects with `FULLTEXT_UNCOMMITTED_WORK` while leaving the handle open and able to
commit. It never auto-commits. `close({ mode: 'rollback' })` is the only close path that discards
standalone work since the last commit: it stops new admission, cancels not-yet-started batches, lets
an already-started bounded batch reach its safe boundary, rolls back the complete uncommitted writer
state, then closes. Derived close retains its runtime-owned `drain`/`rollback` modes. A successful
close rejects new work, cancels queued searches, releases readers, and unregisters the environment
handle. Native mode then drops the Tantivy/MmapDirectory handles.

On graceful Harper shutdown, Harper first stops new derived delivery and immediately flushes every
same-worker coalescer. It then calls derived `close({ mode: 'drain', timeoutMs })` with the time
remaining on Harper's existing shutdown deadline. Drain waits for already accepted bounded batches,
commits and durably publishes their contiguous watermark, and does not wait for optional searcher
warming or merge optimization. If the deadline expires first, derived close stops publication,
cancels work that has not started, lets an active atomic storage operation reach a safe boundary,
rolls back uncommitted writer state, and closes in the validated Harper store lifecycle order. Harper retains no content
buffer and restart replays exactly after the last durable published watermark. A timeout never
extends record-commit semantics, advances a speculative watermark, or permits force-freeing a live
RocksDB operation.

Harper starts drain intent for every backend promptly, but drain work acquires the existing global
commit permits and the existing per-`DBDescriptor` permit; shutdown creates no separate pool or
flush path. Different databases may drain concurrently within the global limit. Initially, one index
per database may enter its commit/durability barrier at a time. The scheduler prioritizes active
serving generations over shadow rebuilds, then the oldest pending log position, publication lag, and
accumulated bytes, while preserving fair progress among equal-priority indexes. Storage-pressure
guards remain active: an unsafe flush is abandoned to replay rather than forced during shutdown.
Each database closes only after all of its derived backends have either published or safely rolled
back, and all still share the one Harper shutdown deadline.

This is graceful-shutdown optimization, not a new durability mechanism. Crash and forced termination
skip the drain and recover through the same watermark/replay path. The current HNSW implementation
has no comparable accepted queue; if HNSW later adopts the shared derived protocol, its backend uses
this Harper-owned bounded-drain policy rather than copying phase 1's disposable asynchronous mmap
flush behavior.

Harper controls store shutdown. Graceful close stops admission and keeps storage servicing alive
while accepted work drains or cancels, writers finish or roll back, merge threads exit and searches
release slices. Quiesce native store users and settle transport requests before stopping storage
servicing and releasing the store view. The JS thread servicing storage must remain runnable;
close cannot synchronously join native threads that need it.

Forced worker loss and deadline expiry require a surviving lifecycle path to fail pending requests
and wake native waiters. Cancellation does not roll back an executing storage call. Keep request
state and buffers alive until native users and late completions can no longer access them, and
prove safe store release separately. A shutdown timeout never permits freeing state still in use.

Restore, drop, schema replacement and process shutdown remain Harper-owned. Verify that Harper's
existing lifecycle can enforce this ordering with supported storage APIs; any missing ordering
belongs in Harper's shared lifecycle, not a private rocksdb-js close hook or native handle API.
Test normal close, deadline expiry and worker loss during reads, merges and publication, including
late responses, under the detailed contract in
[Tantivy storage through Harper](./tantivy-rocksdb-directory-design.md).

## JavaScript API

The generated addon API remains package-private. The hand-written TypeScript façade is the stable
contract.

```ts
export interface FullTextRuntimeBudget {
	maxRegisteredIndexes: number;
	maxResidentWriters: number;
	maxResidentReaders: number;
	maxShadowGenerations: number;
	maxIndexingWorkers: number;
	maxMergerThreads: number;
	maxWriterArenaBytes: number;
	maxAdmissionBytes: number;
	reservedReplayBytes: number;
	searchThreads: number;
	maxConcurrentSearches: number;
	maxConcurrentCommits: number;
	maxObjectCacheBytes: number;
}

export interface FullTextRuntimeOptions {
	resourceBudget: FullTextRuntimeBudget;
	// Required host policy; no package default and no per-index override.
	maxStaleSearcherAgeMs: number;
}

export interface FullTextHardLimits {
	maxResultWindow: number;
	maxCandidateWindow: number;
	candidateOverfetchFactor: number;
	maxQueryUtf8Bytes: number;
	maxAnalyzedTerms: number;
	maxBooleanDepth: number;
	maxBooleanClauses: number;
	maxTermExpansions: number;
	maxPackedRequestBytes: number;
	maxPackedResultBytes: number;
}

export interface FullTextCapabilities {
	apiVersion: 1;
	packageVersion: string;
	hardLimits: Readonly<FullTextHardLimits>;
}

// Exported by both storage subpaths from the loaded native package.
export function getFullTextCapabilities(): Readonly<FullTextCapabilities>;

// Exported by both storage subpaths and backed by the same process-global runtime.
export function initializeFullTextRuntime(options: FullTextRuntimeOptions): void;

export interface FullTextIndexOptions {
	indexId: string;
	generation: string;
	schemaFingerprint: string;
	fields: Array<{ name: string; weight: number }>;
	rankingFingerprint: string;
	analyzer: 'english@1';
	stopWords: boolean;
	positions: boolean;
	surfaceTerms: boolean;
	synonyms: Array<{ source: string; replacements: string[] }>;
}

export interface FullTextRankingConfig {
	rankingFingerprint: string;
	fields: Array<{ name: string; weight: number }>;
}

// Exported only by @harperfast/fulltext/native.
export interface NativeFullTextIndexOptions extends FullTextIndexOptions {
	path: string;
}

// Planned Harper-only integration; not an implemented public export.
// Exact host context is frozen by the real storage and lifecycle proof.

export type DeliveryReceipt =
	| { status: 'accepted' }
	| { status: 'deferred'; reason: 'busy' | 'source-required' | 'closed' | 'failed' };
export type ApplyReceipt = {
	sequence: bigint;
	applied: number;
	suppressed: number;
	quarantinedRecords: number;
	quarantinedSources: number;
	failureIds: string[];
	failureIdsTruncated: boolean;
};
export type CommitReceipt = { opstamp: bigint; checkpoint?: Uint8Array };

export interface StandaloneCommitOptions {
	signal?: AbortSignal;
	// Opaque caller-owned bytes; maximum byteLength is 65,536.
	checkpoint?: Uint8Array;
}

export interface StandaloneCloseOptions {
	mode?: 'require-clean' | 'rollback';
	timeoutMs?: number;
}

export interface DerivedCloseOptions {
	// Drain publishes accepted work until timeout; timeout safely rolls back to the durable watermark.
	mode?: 'drain' | 'rollback';
	timeoutMs?: number;
}

export interface FullTextSearchIndex {
	updateRanking(config: FullTextRankingConfig): void;
	search(request: SearchRequest, options?: { signal?: AbortSignal }): Promise<SearchResult>;
	traceMatches(plan: Uint8Array, sources: Uint8Array, options?: { signal?: AbortSignal }): Promise<Uint8Array>;
	// Wait until the searcher covers the publication current when this call begins.
	// Harper queries never call this on admission.
	reload(): Promise<void>;
	status(): FullTextStatus;
}

export interface WritableFullTextIndex extends FullTextSearchIndex {
	apply(batch: Uint8Array, options?: { signal?: AbortSignal }): Promise<ApplyReceipt>;
	commit(options?: StandaloneCommitOptions): Promise<CommitReceipt>;
	close(options?: StandaloneCloseOptions): Promise<void>;
}

export interface HarperFullTextIndex extends FullTextSearchIndex {
	deliver(batch: Uint8Array): DeliveryReceipt;
	commit(options?: { signal?: AbortSignal }): Promise<CommitReceipt>;
	close(options?: DerivedCloseOptions): Promise<void>;
}

// @harperfast/fulltext/native
export function openNativeFullTextIndex(options: NativeFullTextIndexOptions): Promise<WritableFullTextIndex>;

// @harperfast/fulltext/harper: planned factory signature is intentionally deferred.
// It takes Harper-owned integration context, never a path or native RocksDB lease.
```

`getFullTextCapabilities()` is the authoritative read-only discovery surface for compiled package
limits. It performs no index open, storage access, or runtime initialization. Both storage subpaths
return the same storage-neutral values from the loaded native artifact; callers do not maintain a
copied constants table. Returned objects are immutable snapshots, `apiVersion` changes only when the
shape or meaning changes incompatibly, and additive fields require a compatible API evolution.
Harper calls it during full-text capability preflight, verifies every configured host limit is equal
to or below the package value, and fails startup/schema activation with the offending field and both
values when they are incompatible. The native decoder still enforces every advertised limit at each
call, so discovery is not authorization and stale JavaScript state cannot bypass a ceiling.

The host must call `initializeFullTextRuntime()` before any factory. The first valid call freezes the
resource budget and stale-searcher policy for the process lifetime. Repeating the exact configuration
is an idempotent no-op, which allows independently loaded components to establish the same
prerequisite; a different later configuration fails with `FULLTEXT_ALREADY_INITIALIZED`, and opening
before initialization fails with `FULLTEXT_NOT_INITIALIZED`. There is no public reset because live
native handles, permits, resident accounting, and availability deadlines cannot be safely reparented.
Tests that require a different configuration use a fresh process.

The wrapper validates positive values, cross-field feasibility, compiled safety ceilings, and the
minimum resources needed to construct one index before freezing the configuration. It then owns
permit allocation, parking, fairness, and accounting across all native and Harper indexes. It does
not inspect host memory, CPU count, or cgroup limits to silently enlarge or replace the supplied
budget. Harper computes its trusted budget from server-level policy during startup; standalone
applications do the same explicitly. Index factories and Harper table schemas expose no worker,
thread, arena, cache, or concurrency override.

`maxStaleSearcherAgeMs` is a required nonnegative safe integer supplied by the host. It controls how
long a previously validated searcher may serve after a newer durable publication cannot be loaded or
an unresolved durable delivery gap prevents publication.
The wrapper supplies no implicit duration and no index factory may override it. Harper obtains the
value from trusted server runtime policy; standalone applications choose it during the same one-time
initialization. The interval is anchored to the oldest persisted blocking fact: the publication
timestamp for a reload failure or the durable source-log entry timestamp for a delivery gap. It is
never measured from process uptime or retry time, so restart and repeated attempts cannot reset it. A
value of zero disables degraded stale serving. Status reports the stale-since timestamp, deadline,
reason, retry state, and remaining interval without exposing a customer-controlled schema option.

Native and Harper are explicit entry points over the same engine, query, commit, status and lifecycle code. Native callers use awaited apply and explicit commits; Harper adapts nonblocking delivery and source-progress reporting through the shared protocol. The Harper context and factory signature freeze only after storage transport, lifecycle and replay are demonstrated. No Harper-backed factory is exported.

`ApplyReceipt.applied` counts mutations admitted to the current in-memory writer state, including
an applied delete/quarantine transition; it is not a count of fully searchable documents. The two
quarantine counters let a standalone caller distinguish successful indexing from deterministic
content omission without rejecting otherwise valid work. `failureIds` contains only a fixed maximum
number of opaque IDs, never record keys or source text, and `failureIdsTruncated: true` directs the
caller to `status()`/metrics for aggregate diagnosis. The fixed-size receipt is identical for native
and Harper-backed factories. Harper's nonblocking `deliver()` does not synthesize a synchronous
receipt; its adapter reports the same outcomes through operator status and metrics when the writer
applies the batch.

Each returned handle represents one logical index generation. A standalone rocksdb-js caller may
open several handles over separate index generations and issue `apply()`, `commit()`,
and `search()` operations concurrently; their runtimes share only the process-level resource
governor. Harper's post-commit fan-out invokes each target's synchronous nonblocking `deliver()` in
a bounded loop and returns. It does not await a cross-index `Promise.all`; parallel indexing begins
behind those admissions in the native runtimes.

Derived Rocks `deliver()` is the one deliberately synchronous façade method: it performs validation and a
bounded copy or ownership transfer into the process-global native queue, then immediately returns
`accepted` or `deferred`. It never waits for Tantivy, a queue slot, blob content, or RocksDB. A
`deferred` result tells Harper's shared runtime to latch log replay; it is not a failed record write.
The same packed operation format is used for hot delivery, replay, and rebuild. Replay and rebuild
apply backpressure outside the commit hook by retrying admission and waiting on the published
watermark rather than by introducing a second mutation API.

Standalone `apply()` is asynchronous in both storage modes: it resolves after the batch is accepted
and applied or rejects with the same stable error categories. This is ordinary caller-visible
backpressure, not Harper's post-commit fast path. `ApplyReceipt.sequence` is a wrapper-local ordering
receipt, not a durability point; its counts distinguish entries applied in the current window from
older or duplicate entries suppressed there. The caller controls source ordering and replay across
published checkpoints.

An `AbortSignal` can cancel the standalone batch only while it is waiting for writer admission. Once
application starts, the wrapper completes the bounded batch and resolves its receipt; cancellation
cannot create an applied-but-rejected ambiguity. Batch-size limits bound the time to that safe
boundary.

Standalone `commit()` resolves after Tantivy commit payload and Directory publication are durable;
it does not wait for `IndexReader` reload or structural warming. Publication schedules the same
coalescing background reload used by derived mode. A subsequent `await index.reload()` captures the
current published revision and resolves only when the process-global searcher covers at least that
revision, possibly a newer coalesced publication. It does not force duplicate reload I/O when the
background task has already reached the target. Search without that barrier may briefly use the
previous immutable snapshot, and this distinction is documented in the README and examples.

Neither standalone factory starts a timer, threshold trigger, or automatic commit task. Pending
`apply()` work remains unpublished until the application explicitly calls `commit()`, supplies any
opaque checkpoint it owns, or closes with a documented rollback/drain choice. This keeps commit
cadence, checkpoint meaning, and replay authority with the standalone application. Only the derived
factory accepts the cursor capability and participates in Harper's bounded hybrid publication
scheduler; both modes still invoke the same writer actor and commit implementation.

In derived-delivery mode, the caller may request a commit but cannot supply or advance its
watermark. The commit actor derives the aggregate watermark only from positions actually completed
by the active writer. Tantivy opstamps and commit IDs remain diagnostics and are not accepted as
reload authority. A standalone caller may attach a bounded opaque checkpoint to `commit()`. The
commit barrier covers every successful `apply()` ordered before that call, and the checkpoint is
published through the same `prepare_commit()`/`set_payload()`/`atomic_write(meta.json)` boundary. On
reopen, `status().checkpoint` and `CommitReceipt.checkpoint` return the exact bytes. The payload
envelope tags standalone and derived variants so derived mode rejects caller checkpoints and can
never confuse one with a log watermark. A caller that omits checkpoints explicitly accepts
full-source rebuild as its only crash-recovery strategy; the commit still persists the standalone
mode tag.

The standalone checkpoint limit is exactly 65,536 bytes of caller-supplied `Uint8Array` content,
independent of document count. The TypeScript façade checks `byteLength` before copying or entering
N-API, and the native decoder enforces the same limit. An oversized checkpoint rejects the commit
with `FULLTEXT_RESOURCE_LIMIT` before `prepare_commit()` and leaves all applied work uncommitted and
available for a later valid commit. The wrapper preserves accepted bytes bit-for-bit and assigns no
schema, cursor, or semantic version to them at its API boundary. Tantivy 0.26.1 stores only an
`Option<String>` payload, so the durable `meta.json` value is the wrapper's canonical versioned
base64url text envelope; reopen decodes it back to the exact caller bytes. The caller owns decoding
and migration; if its source
checkpoint format is no longer readable, it must recover from an older supported application or
rebuild from the authoritative source. Wrapper payload-envelope evolution must continue returning
the same caller bytes or declare an incompatible index-format boundary.

In derived-delivery mode, `status()` includes the published aggregate watermark, earliest unresolved
position and reason (`content`, `version-conflict`, or structural gap), `catchUpRequired`, pending
content count and age, queue and total pending bytes, and generation health. A version conflict also
identifies its record through the same opaque packed identity used for replay, never by placing the
primary key in an error string. Harper's shared derived-index runtime polls this low-rate control
surface to schedule source reconciliation, replay, and publication; mutation completion never emits
a per-record JavaScript event.
Standalone status omits log-specific fields but exposes its last published caller checkpoint.

This shape is provisional until the protocol spike proves buffer ownership and multi-worker
lifecycle. The Rocks storage contract nevertheless has fixed exclusions:

- no `path` argument;
- no `directory` or backend discriminator;
- no raw Tantivy schema;
- no Tantivy query string;
- no synchronous search or commit, and no blocking delivery;
- no per-document mutation method;
- no high-frequency callback or EventEmitter channel.

### Packed protocols

Mutation and result arrays must not become thousands of N-API object conversions. Define one shared
versioned document-batch body and a derived-delivery envelope. The body contains:

- magic and protocol version;
- bounded entry count and total length;
- encoded primary-key length and bytes;
- raw eight-byte numeric record-version representation plus node/tie-breaker value;
- operation kind;
- field count and UTF-8 field slices;
- result score and exhaustion/page metadata;
- checked offset arithmetic and exact trailing-byte validation.

The derived-delivery envelope adds one length-delimited opaque `rocksdb-js` position token per
committed entry and a derived-only authoritative-repair marker that is valid solely for an exact
outstanding version conflict at that record and position. Standalone `apply()` does not accept or
synthesize either field.

Keep small control requests as typed objects for readability. Fuzz every packed decoder and reject
oversized allocations before reserving memory. Every input-derived allocation uses checked length
arithmetic and `try_reserve`; allocation failure returns a typed resource error instead of aborting
the Harper process. One process-global in-flight byte budget, distributed to shards as bounded
credit blocks, covers every index and environment, including admitted batches, latest-version/
tombstone state, completion gaps, blob holds, extraction, searches, and results. Many individually
legal requests therefore cannot exhaust memory together without putting a shared cache-line update
on every delivery.

Packed mutation validation is batch-atomic. Before queue admission or access to `IndexWriter`, the
native boundary validates the complete header, protocol version, schema/generation fingerprints,
field identities, record and field counts, offsets, lengths, strict UTF-8, trailing bytes, and every
applicable hard bound. Any structural failure rejects the whole `apply()` or defers/fails the whole
derived delivery unit with no mutation from that buffer applied. It never applies a valid prefix or
skips an unrecognized record. A validated explicit quarantine marker is an ordinary mutation, not a
structural error. Failures after admission are governed by writer-health and replay recovery; this
prevalidation guarantee does not claim transactional durability before `commit()`.

### Errors

The native layer returns stable categories; the TypeScript façade maps them to exported error
classes with `code`, `retryable`, and an optional native failure ID. Initial categories include:

- `FULLTEXT_BUSY`;
- `FULLTEXT_CANCELLED`;
- `FULLTEXT_CLOSED`;
- `FULLTEXT_NOT_INITIALIZED`;
- `FULLTEXT_ALREADY_INITIALIZED`;
- `FULLTEXT_STALE_GENERATION`;
- `FULLTEXT_INVALID_REQUEST`;
- `FULLTEXT_UNCOMMITTED_WORK`;
- `FULLTEXT_QUERY_LIMIT`;
- `FULLTEXT_QUERY_UNSUPPORTED`;
- `FULLTEXT_RESOURCE_LIMIT`;
- `FULLTEXT_INDEX_REBUILDING`;
- `FULLTEXT_INDEX_UNAVAILABLE`;
- `FULLTEXT_DIRECTORY_ERROR`;
- `FULLTEXT_COMMIT_FAILED`;
- `FULLTEXT_WRITER_FAILED`;
- `FULLTEXT_LOG_GAP`;
- `FULLTEXT_LOG_RETENTION_EXPIRED`;
- `FULLTEXT_VERSION_CONFLICT`;
- `FULLTEXT_CONTENT_PENDING`;
- `FULLTEXT_INCOMPATIBLE_FORMAT`;
- `FULLTEXT_STORAGE_INCOMPATIBLE`;
- `FULLTEXT_NATIVE_UNAVAILABLE`.

`FULLTEXT_QUERY_LIMIT` uses the existing exported error object rather than a new response envelope.
Its bounded `detail` contains a stable constraint identifier, a reason such as `required`,
`nonFinite`, or `maximum`, and the effective numeric maximum when one exists. The TypeScript façade
preserves the same detail for programmatic callers, and Harper's existing RFC 9457 serializer carries
it to REST. Native and Harper-side preflight violations therefore produce the same safe diagnostic.
Do not put the supplied query value, primary keys, indexed text, analyzed terms, query text, or raw
RocksDB keys in production error messages or detail.

## Storage integration

Native storage delegates to Tantivy `MmapDirectory`. The Harper-backed Directory preserves Tantivy's
logical files inside Harper RocksDB through supported store operations and bounded transport.

[Tantivy storage through Harper](./tantivy-rocksdb-directory-design.md) is the storage design: object mapping, visibility,
atomic publication, durability, immutable slices, writer exclusion, lifecycle and qualification.
No versioned rocksdb-js native lease, pinned-read API, target-CF flush or external SST extension is
a prerequisite. The initial proof evaluates existing write/transaction/durability APIs before
selecting the production path.

The rejected native bridge remains an experiment. Existing Directory harness and immutable-object
tests can be reused where they express engine semantics. Reusing them does not imply the bridge
consumer or its dependency belongs in a production package.

## Build and packaging

### Toolchain choice

Start with napi-rs v2, matching both reference repositories and Harper's existing native package
experience. Pin the Rust toolchain, napi crates, `@napi-rs/cli`, Tantivy, and the compatible
Harper integration version. A future napi-rs v3 migration is separate work and must not be combined
with the initial storage integration.

Use Symphony's generated-binding layout:

```json
{
	"main": "dist/index.js",
	"types": "dist/index.d.ts",
	"engines": { "node": "^22.18.0 || >=24.0.0" },
	"license": "Apache-2.0",
	"exports": {
		".": "./dist/index.js",
		"./native": "./dist/native.js",
		"./harper": "./dist/harper.js"
	},
	"files": ["dist/", "fulltext.*.node"],
	"scripts": {
		"build": "tsc -p tsconfig.json && napi build --platform --js false --dts ts/addon.d.ts --release",
		"artifacts": "napi artifacts",
		"prepublishOnly": "napi prepublish -t npm"
	}
}
```

The target matrix remains Linux x64/arm64 glibc and musl, macOS x64/arm64 and Windows x64. Advertise only combinations qualified by their relevant gates. Native artifacts load independently; Harper storage is tested against the supported Harper stack on each advertised Harper platform, including Directory/reopen/lifecycle tests. No matching lease prebuild is required.

The root package uses Harper's current `engines.node` declaration, `^22.18.0 || >=24.0.0`. Initial
release qualification explicitly runs Node majors 22, 24, and 26 against the same Node-API artifact,
plus packaged loading/lifecycle smoke coverage across every platform target. The wrapper does not
invent a narrower runtime policy than Harper. Later or odd-numbered majors admitted by that range
follow Harper's support policy and become independently certified only when Harper adds them to its
intentional CI matrix.

The HNSW loader's accumulated load-failure diagnostics should be retained, while napi-rs manages
the platform package names and artifacts as in Symphony. Local source builds are allowed for
development. A missing production prebuild becomes `FULLTEXT_NATIVE_UNAVAILABLE` during Harper
schema/startup preflight.

### Dependency, compatibility and persisted formats

Native mode has no rocksdb-js dependency. The library does not add the formerly proposed optional
rocksdb-js peer or link RocksDB in Rust. Harper owns its installed RocksDB version and supplies the
integration using its supported storage APIs.

Compatibility records identify fulltext/Tantivy, Harper, Harper's resolved rocksdb-js/RocksDB,
Node/platform, storage format and benchmark configuration. A changed storage stack needs
conformance, crash/reopen, backup and performance qualification. There is no lease ABI tuple.

The package begins on a `0.x` release line. Declared minor releases may change public APIs or
persisted formats; patch releases must not silently do so. Publish readable/writable format
versions, limits and upgrade/rebuild requirements with each release. Unsupported persisted state
fails closed. Harper owns shadow rebuild and activation; native callers own source recovery.

Document supported package/Harper combinations and test packed artifacts. Keep the latest supported
feature line, security policy and changelog explicit; do not imply support for a standalone
rocksdb-js factory.

### Documentation and open-source package contract

The repository uses the Apache License 2.0, matching Harper's other open-source native packages.
`LICENSE`, the root `package.json`, the Rust crate metadata, every generated platform package, and
each packed npm artifact must agree on `Apache-2.0`. `NOTICE` is added only when bundled material
requires notices; dependency license attribution is generated or checked during release rather than
maintained as an unaudited hand-written list.

The root `README.md` is the supported entry point for a developer who has not read this design. It
must include:

- the package purpose, supported Node/platform matrix, and the pinned Tantivy compatibility line;
- installation for native mode and the qualified Harper integration;
- executable native and Harper examples covering schema, apply/delivery, commit, search and close;
- a capability table for term, boolean, phrase, prefix, fuzzy, preview fuzzy-prefix, autocomplete,
  and suggestion APIs, plus an example of inspecting the authoritative package hard limits;
- the difference between awaited standalone `apply()` and Harper's nonblocking derived `deliver()`;
- storage ownership and durability: native files are Tantivy-owned, Rocks data remains inside the
  caller's database, and Harper never uses native storage or fallback;
- concurrency and lifecycle rules, including one writer per index generation, multiple independent
  indexes, Worker use, background reader reload, and `index.close()` before database close;
- bounded-work behavior, typed error categories, recovery/checkpoint responsibility, compatibility
  expectations, and links to detailed documentation;
- REST count behavior and the initial authorization boundary: derived totals are unavailable rather
  than falsely exact, and record-filtered or attribute-restricted indexed sources are rejected;
- the initial text-only extraction boundary and the fact that rich document formats require a
  separately isolated and resource-bounded extractor rather than being parsed by Tantivy;
- how to reproduce benchmark manifests, inspect the GitHub Pages release comparison, download and
  verify release evidence, and interpret compatible versus diagnostic-only comparisons;
- an explicit statement that the package is Apache-2.0 licensed and how to report vulnerabilities.

Detailed documentation owns the material that would make the README unreadable: complete stable
TypeScript signatures, packed-protocol versioning, analyzer behavior, scoring semantics, storage
mode differences, backup/restore, crash recovery, operational metrics, memory/thread budgets,
benchmark reproduction, troubleshooting, and the boundary between generic rocksdb-js use and
Harper's derived-index integration. The derived factory is documented as an advanced integration
capability using Harper-owned progress tracking; examples do not imitate Harper's protocol or teach callers
to synthesize Harper watermarks. Performance documentation identifies the default branch, protected
result branch, release assets, and Pages view by role; it states that Pages is not evidence and that
only schema-valid same-cohort results can clear a gate.

CI compiles public TypeScript examples and runs native quick starts from packed artifacts. Harper examples run against the qualified Harper checkout and package. Verify documented exports, errors, compatibility, README/license contents and no fallback; experimental entry points stay absent.

CONTRIBUTING.md documents toolchains, builds, checks, benchmarks and artifact inspection. SECURITY.md gives the reporting route and supported versions. Compatibility fixtures track the Harper integration and persisted formats rather than a native rocksdb-js lease ABI.

### Mechanical storage-boundary gate

- Native mode loads independently and delegates its file operations to Tantivy.
- Add the Harper export only when exercised against the actual Harper storage integration.
- Package tests reject a public `/rocks` export, production use of the experimental lease and a
  bundled RocksDB runtime.
- Harper tests reject filesystem-path selection or fallback to native Tantivy storage.
- Panics and environment shutdown cannot strand promises or native storage waiters.
- Qualify both modes through their supported public entry points and the real Harper harness.

## Implementation phases

The existing scaffold and native implementation provide the starting point. The next storage work
is the Harper vertical slice in [tantivy storage through harper](./tantivy-rocksdb-directory-design.md).
It proves supported storage access, Directory semantics, publication, reopen and multi-worker
lifecycle before the Harper storage API freezes.

Engine/API work can proceed alongside the shared Harper delivery protocol. There is no standalone
Rocks qualification stage and no base rocksdb-js bridge PR on the critical path. Harper product
qualification composes its actual storage path, derived runtime, schema, Table.search and REST.

### Phase 0 — Harper protocol and storage proof

The repository, pinned toolchain and native vertical slice are implemented. The current next step
is [the Harper storage proof](./tantivy-rocksdb-directory-design.md#first-milestone-a-real-harper-vertical-slice).

Prove post-commit admission, exact replay and retention-gap handling through Harper's shared runtime
with a test backend before freezing the fulltext API. Cover local writes, pre-encoded replication,
PATCH final-record projection, deletes, eviction/TTL, base-copy/reload, source retries, equal-version
conflicts, queue saturation and rebuild handoff. Protocol details are Harper-owned implementation
work, not wrapper-owned native cursor or retention extensions.

The actual storage proof must persist and reopen Tantivy through supported APIs, survive publication
crashes, settle pending work during shutdown and permit concurrent indexes. Native-lease experiments
do not clear it. Profile the commit hook separately from background storage, including an unindexed
table sharing a database with an indexed one and multiple consumers with isolated failures.

### Phase 1 — pure Tantivy engine

1. Build the Tantivy schema for weighted scalar/repeated fields, encoded primary-key term, exact
   numeric record-version bits and node/tie-breaker, positions, and surface terms. Verify native
   repeated-field BM25 aggregation, phrase isolation between array elements, and canonical field
   identity across reordered input arrays.
2. Implement English analyzer `english@1` and the bounded index-only synonym token filter with
   golden token, position, surface-term, and synonym fixtures.
3. Implement packed batch decode and idempotent delete-by-key plus conditional add-document
   operations. Verify all-null, all-empty, and stop-word-only upserts remove prior searchable content,
   add no empty document, and still advance standalone and derived progress. Exercise per-source
   byte/token/term-length breaches: no truncation, remaining-source replacement, immediate
   quarantine, later-version recovery, and bounded status/error cardinality. Verify standalone
   `apply()` resolves with exact quarantine counters and bounded opaque failure IDs while healthy
   sibling mutations remain applied; derived delivery exposes the same outcome asynchronously.
   Corrupt every header, fingerprint, field ID, count, offset, length, UTF-8 sequence, and trailing-
   byte case and prove prevalidation rejects the complete batch before writer-state mutation.
4. Implement explicit query builders for term-any, term-all, phrase, prefix, fuzzy, preview fuzzy-
   prefix, and bounded eligible-key filtering. Verify term-all conjunction across different fields
   and phrase isolation within one field/value. Verify duplicate-term canonicalization for set modes
   and preserved repetition for positional modes, conjunctive cross-field prefix behavior, fuzzy
   any-term behavior, zero-tie exact-versus-fuzzy grouping, zero-tie disjunction-max prefix scoring,
   and fuzzy-prefix final-token-only behavior, identifier exclusion, minimum length, exact preference,
   and automaton/work-budget enforcement. Do not use `QueryParser` on customer input.
5. Implement weighted BM25 top-k, atomic immutable ranking-config replacement, and packed result
   encoding. Prove a weight-only change performs no Directory write or commit, in-flight searches
   retain one revision, ordinary cross-field term contributions sum, generated alternatives do not,
   fixed `k1 = 1.2`/`b = 0.75` results match a no-pruning oracle, invalid field sets/fingerprints fail,
   and native/Harper results remain equal.
6. Implement bounded opaque match plans and batched `traceMatches` for every released comparator,
   stemming, and index-time synonym provenance. Verify full-source-token spans for non-exact modes,
   continuous phrase spans, Unicode/UTF-16 boundaries, positive-clause-only traces, stale-plan
   rejection, cancellation, and zero Directory activity.
7. Use `RamDirectory` for deterministic Rust unit tests and `MmapDirectory` for native-mode
   conformance, reopen, locking, and crash tests.

**Exit gate:** pure Rust tests prove update/delete idempotence, analyzer stability, expected ranking,
phrase positions, bounded expansions, malformed-buffer rejection, and commit/reopen behavior.

### Phase 2 — shared writer, pools, and lifecycle

1. Implement the process-global registry keyed by native canonical path or stable RocksDB/CF
   incarnation identity, index ID, and generation, with immutable standalone/derived mode per entry.
2. Implement sharded bounded admission queues, one aggregate atomic byte/cardinality budget, and
   native ingestion lanes sharing one `IndexWriter` per resident index generation. Construct every
   writer with explicit indexing-worker, merger-thread, and arena settings; add the hard resident,
   draining, and parked states. Standalone `apply()` waits for admission/application; derived
   `deliver()` returns immediately with `accepted` or `deferred`, including when its writer is parked.
3. Implement an exclusive commit barrier over the shared writer. Keep post-gap work outside
   `IndexWriter`, use `IndexWriter.run()` for the contiguous prefix, then call
   `prepare_commit()`, `set_payload()` with the canonical tagged `PublicationState`, and `commit()`.
   The same actor publishes an optional standalone checkpoint or a derived aggregate watermark.
4. Implement the hybrid derived publication scheduler: document/byte eligibility, maximum
   unpublished age, minimum interval, no empty commits, fair selection, one commit permit per
   Harper database, global commit limits, and pressure-aware suppression. Standalone commit timing
   remains caller-controlled. Prove the standalone native factory create no timer/threshold commit task,
   leave applied work unpublished until explicit commit, and use the same low-level commit actor as
   derived mode.
5. Implement a bounded search pool, per-thread reusable scratch where applicable, deadlines, and
   query-class admission.
6. Implement request cancellation and idempotent drain/rollback close.
   Prove a queued standalone `apply()` cancels without writer mutation, while cancellation at every
   point after application starts still completes the entire bounded batch and resolves the exact
   receipt. No test may observe an applied prefix paired with a cancellation rejection.
   Verify default standalone close rejects every queued/applying/applied-uncommitted state without
   changing or disabling the handle, clean close succeeds idempotently, explicit rollback discards
   only work after the last commit, and no close path auto-commits. Keep derived drain/rollback tests
   separate.
7. Add the monotonic opstamp/publication-progress watchdog, maximum detection interval, health epoch,
   and failure transition. A commit whose captured epoch is stale must not publish its watermark.
8. Surface indexing-worker, updater, and merge-task health independently of write opstamps so an
   idle writer still reports a dead merge pipeline and transitions to `NEEDS_REBUILD`.
9. Inject admission, ingestion-lane, commit-actor, indexing-worker, updater, and merge failures.
   Inject failures after every mutation boundary and prove unknown partial application poisons the
   writer, rejects pending work, blocks commit/publication, and recovers only from the last durable
   standalone checkpoint or derived watermark. The same writer must never accept a batch retry.
10. Test multiple Node Workers, environment teardown, addon reload, and duplicate-addon-image
    detection.
11. Open one process-global reader lazily per queried generation, background-reload and atomically
    swap its `Searcher`, coalesce successive publications, and prove query admission never performs
    reload I/O. Exclude job/utility environments and test native close plus Harper store closure
    through rocksdb-js's existing database lifecycle.
    Verify standalone `commit()` can resolve before visibility, `reload()` waits for the publication
    current at invocation, concurrent publications coalesce safely, and an already-current reload
    performs no Directory work. Inject reload I/O, checksum, and decode failures; prove the previous
    validated snapshot serves only within the host-supplied degraded interval, explicit reload
    rejects, retries restore health when possible, restart does not renew the persisted deadline,
    and admission fails closed when the interval expires.
12. Test several concurrently active index generations. Enforce process-wide indexing, commit,
    search, thread, and memory permits above per-index queues; prove fairness and that a rebuild
    generation cannot starve live indexes. Exceed the resident limit and prove parked indexes retain
    no content buffers, catch up fairly from the log, and do not churn writers open and closed.

**Exit gate:** standalone operations provide awaited backpressure, the derived post-commit call
remains nonblocking under saturation, and both modes use the same writer/commit implementation.
Every accepted derived operation is either represented by a published watermark or replayed after
failure; writer failure becomes observable within its deadline. Multiple indexes make fair parallel
progress without event-loop/libuv starvation or multiplicative unbounded resources.

### Phase 3 — Node façade and transfer efficiency

1. Implement the stable TypeScript types and façade over generated addon declarations.
2. Add packed mutation/query/result codecs with zero-copy views where ownership permits. Test
   standalone checkpoints at 0, 65,535, 65,536, and 65,537 bytes, exact reopen round-trip, malformed
   durable envelopes, and rejection before writer preparation or native allocation.
3. Normalize native failures into typed JavaScript errors without exposing record/query content.
4. Implement `AbortSignal` ownership and abandoned-promise tests.
5. Implement snapshot `status()` and metrics for queues, bytes, latency, cancellation, writer
   progress, segments, merges, and failures.
6. Measure N-API boundary cost across batch sizes and result sizes.

**Exit gate:** there is one boundary crossing per operation, no per-document native callback, no
unhandled rejection after cancellation or environment teardown, and transfer cost fits the wrapper
budget.

### Phase 4 — Harper-backed Directory

1. Execute the real Harper storage vertical slice and freeze only the APIs it proves.
2. Select fixed-size chunks or a bounded offset index, then implement bounded working chunks and
   immutable opened slices. Qualify offset lookup bounds, amplification, append/flush behavior and
   format versioning. Reclaim crash orphans with resumable bounded scan/delete batches that cannot
   race live writers, publication or open slices; a whole-generation startup scan is not bounded.
3. Prove metadata atomicity and object-before-publication durability through existing APIs.
4. Test close/drop/recreate, environment exit, cancellation and storage-worker failure without deadlock.
5. Reuse Directory conformance and add process-crash, power-loss-equivalent durability qualification,
   online backup/restore, orphan reclamation and shadow-generation cases.
6. Prove independent indexes progress within aggregate native and transport limits, alongside
   foreground Harper writes.
7. Integrate durable progress reporting with Harper's shared replay/rebuild contract.
8. Measure the actual Harper backend against the native reference with explicit measurement scopes.

**Exit gate:** the real Harper store passes Directory, recovery, lifecycle and multi-index tests.
Every published head resolves complete durable objects. No test relies on the unmerged native
lease, a private rocksdb-js build or local Tantivy files.

### Phase 5 — platform and package qualification

Run Rust, Node, worker/lifecycle and Directory tests on supported targets. Qualify Node-API artifacts
through packed installs, confirm native independence, reject experimental exports and bundled
RocksDB, and test the actual Harper dependency stack. Add crash, malformed-object, ENOSPC, panic and
storage-worker-exit coverage on appropriate runners.

Complete API reference, native/Harper examples, support matrix, troubleshooting, contribution,
security and Apache-2.0 documentation. Test documented behavior from packed artifacts.

PR CI runs correctness/parity and benchmark-output smoke tests. Stable hardware runs scheduled and
release qualification with versioned manifests, explicit scopes and reviewed thresholds. Store
GitHub summaries and immutable evidence, preserve release comparisons, and keep publication
permissions out of benchmark execution. Requalify changed Harper/storage fingerprints.

Native releases are independent. Harper releases require the Harper-backed adapter and product
gates; no native filesystem or experimental-bridge result substitutes for them.

### Phase 6 — Harper integration

1. Implement the reviewed `DerivedIndexRuntime` and `DerivedIndexBackend` contract already
   exercised by the Phase-0 test adapter. Attach it to `RocksTransactionLogStore.aftercommit` in
   every write-capable environment, including replication apply.
2. Store canonical `FULLTEXT` declarations in a separate `derivedIndices`/backend-descriptor
   collection. They never enter `indices`, call `openIndex()`, or participate in transactional
   secondary-index value resolution. Load the package lazily only when such a descriptor activates
   in a serving or derived-runtime environment.
3. Add `openDerivedIndexStore()` beside `openIndex()`. It creates one CF per declared full-text
   index through the root Rocks store's existing `use()` API, records it in `openedStores`, and reuses the
   existing cleanup, close, drop, backup, and restore graph without applying secondary-index
   encoders or `CUSTOM_INDEXES` behavior.
4. Register direct source-attribute dependency masks. For partial writes, intersect the effective
   changed-field mask before retaining or projecting the committed record. Send affected mutations
   plus position-only no-ops in one packed, nonblocking delivery per target. When no target is
   affected, retain and transmit no record content; send only transaction-coalesced position
   completions so every derived watermark can advance. On `busy`, overflow, close, or failure,
   latch replay from the published watermark; `source-required` holds only its position in the
   bounded resolution lane until that lane overflows. Do not route records through worker 0 or
   expose the package to application code. For a transaction affecting multiple full-text indexes,
   resolve interest and normalize
   records once, then enqueue each target independently so one deferred index cannot block another.
   Extend the log-store call metadata with fixed-width `tableId` and `derivedInterest` fields so
   pre-encoded uninterested replication entries require no audit-frame decode.
5. Connect position-based replay, retention checks, generation build/catch-up/handoff, publication,
   background reload, failure, clear, drop, and shutdown. Drive the wrapper's hybrid publication
   scheduler from the shared derived-index runtime. Combine rocksdb-js pressure with wrapper
   queue/merge status in that policy; do not add a full-text RocksDB circuit breaker. Connect the
   base-copy applier's existing durable identity/resume cursor: record start before the first batch,
   feed each committed full-record batch into the private generation, and require derived cursor
   coverage plus log catch-up before completion activation.
   For graceful shutdown, stop new delivery, flush Harper coalescers, and drain/publish each backend
   only within the remaining existing shutdown deadline and existing global/per-database commit
   permits. Fault-inject before delivery, during apply, during publication, and at timeout; prove a
   completed drain advances the durable watermark, multiple databases progress concurrently, one
   database does not flush all indexes simultaneously, and timeout retains no content while exact
   restart replay produces the same index without loss or duplicate visible documents.
   Assert that the wrapper exposes no Harper table/source callback and never starts a rebuild itself:
   Harper must persist `NEEDS_REBUILD`, create the shadow generation, scan/project records, replay,
   validate handoff coverage, and perform the catalog-fenced swap.
6. Add an asynchronous derived-index dispatcher to Harper's resource query layer and connect
   `Table.search()` and REST comparators through it. Do not put full-text descriptors into the
   synchronous `customIndex.search(...).map(...)` path.
7. Add end-to-end schema, replication, authorization, crash, rebuild, and 100-million-record
   qualification workloads.
8. Reject LMDB `@fullText` declarations during schema activation. On Windows x64, run the supported
   Harper storage, schema activation, Directory, crash/reopen, close, and packaged-prebuild gates; also
   exercise the generic missing-package path and require `FULLTEXT_NATIVE_UNAVAILABLE` during
   preflight rather than table open.
9. Run a fault-oracle test through real insert, update, delete, TTL, eviction, invalidation, and
   replication paths, including base-copy start, committed copy batches, completion `reload`, and a
   kill/abandon before that marker; pre-encoded log entries; a multi-field index receiving
   `HAS_PARTIAL_RECORD`, and residency-omitted records: kill at randomized boundaries,
   restart/replay, and compare the recovered generation with a clean from-scratch rebuild of the
   same authoritative records. Also compare sampled postings and positions with expectations from
   the committed Phase-1 golden English token/position fixtures, applied directly to authoritative
   record values without calling the live analyzer or projection path. The fixture is keyed to
   `english@1` and the schema fingerprint and fails on mismatch; its field list comes from the
   canonical schema declaration rather than the projection implementation. This prevents a
   symmetric analyzer or wrong-field projection defect from making both indexes and the oracle agree
   incorrectly. Force `RETRY_NOW_VALUE` with a winning second-attempt record different from the
   durable first-attempt audit body, kill before derived commit, and prove replay source-resolves the
   winner. For RocksDB eviction/TTL, prove the derived-only `LOCAL_ONLY` control fact commits
   atomically with removal, survives deferral/restart, and is absent from replication and customer
   audit/subscription output. Include a
   sustained-saturation arm that repeatedly
   overflows hot-delivery/coalescer admission while writes continue, then drains replay and compares
   every result, score, and final watermark with both oracles; latency alone does not qualify the
   deferral path.
10. Prove Harper online backup during active indexing, merge, commit, and log advancement. After
    restore, reject a derived watermark ahead of any restored log tail or from a different log
    incarnation. Use Harper's catalog transaction to reject stale-generation activation.
11. Intercept existing index-clear/rebuild handling so it publishes a new generation rather than
    clearing an object CF under pinned readers; test clear and option change during active searches.
12. Reject branch-database full-text writers and queries initially. Key the native registry by the
    resolved physical database identity so a checkpoint-backed branch cannot fence or reuse the
    base generation accidentally.
13. Benchmark the ordinary write path with no full-text attribute and require no measurable
    throughput or p99 regression, allocation, or derived-index lookup. Include a database-level
    change-feed listener and prove derived dispatch reuses its retained audit object without a second
    copy or decode.
14. Benchmark writes to tables with active full-text indexes at production concurrency. Report the
    same-thread `aftercommit` projection, packed-buffer construction, and N-API admission cost
    separately from asynchronous extraction/indexing/commit cost. Require the agreed indexed-write
    throughput and p99 gate.
15. Benchmark one, several, and the agreed maximum supported number of simultaneously active
    full-text indexes, including a shadow rebuild. Verify per-index progress, publication lag,
    fairness, total memory/thread bounds, and impact on unrelated primary writes.
16. Activate derived dispatch only for tables with registered backends. Keep projection out of the
    existing secondary-index value-resolution loop so a large indexed body is not compared during
    the record transaction; verify this with allocation profiles and the large-body workload.
17. Integrate the bounded storage transport with Harper close/drop/backup. Test worker exit,
    outstanding request cancellation and wakeup, stale handles after recreation, and no deadlock
    between JS storage servicing and native joins. Reuse supported host lifecycle APIs.

18. Reject row-filtered or record-`allowRead` full-text requests before derived-index execution and
    capture the existing per-request `getTablePermissions(user, target)` result before asynchronous
    permission re-entry can clear `target.checkPermission`. Reject when that resolved object restricts
    an indexed source or is undefined; the re-entrant path must reuse the immutable captured verdict,
    not fall back to the user's broader role. Do not add a schema-time global check or a new
    permission-revision cache. Prove a newly created/changed restricted role fails on its next
    request, and combine a target-supplied permission narrower than the role with asynchronous
    `allowRead` to prove re-entry still rejects. Reject `vectorFilter` combined with full text until
    it participates in the bounded candidate-acquisition contract. Test that no query text, score ordering, or
    result-shape information crosses those guards.
19. Execute one bounded over-fetch against one pinned native `Searcher`, then materialize versioned
    candidates with raw `MultiGet` slices or bounded asynchronous point-read batches. Assert that
    every candidate is considered at most once and no publication can change the snapshot mid-query.
    For the same query/generation, force both structured-first and text-first plans and assert bit-
    identical `$score`; prove a bare `TermSetQuery` contributes Tantivy's constant and its required
    `BoostQuery(0.0)` wrapper contributes zero.
    Treat correctness and p99 failures in the supported filtered-query benchmark as release blockers:
    add the opaque cursor described in the search contract before release rather than rerunning top-k
    from rank one or shipping an underfilled result path. If the single pass clears the gate, omit the
    cursor from the initial API. Cover cumulative work/deadline accounting, cancellation,
    authorization, event-loop delay, and full endpoint p99. If the cursor is required, also cover
    lifetime, cancellation, expiry, retained-searcher memory, and snapshot-stable continuation.
    Prove it cannot be serialized, resumed across requests, or used after completion, cancellation,
    deadline expiry, request teardown, or index close; `Table.search()` and REST must expose no
    cursor field or continuation token.
20. Extend Harper's approximate-result detection with `touchesDerivedIndex()`; do not depend on
    derived descriptors appearing in `Table.indices`. Verify `Prefer: count=exact` returns an
    unavailable total (`null`, rendered as `*`). Permit `Prefer: count=estimated` only from cached
    published-generation statistics and mark it inexact. Never drain or label a bounded candidate
    count as an exact table total.
21. Add a composed product-path test: insert documents, delete and expire a subset, query with a
    full-text condition plus companion AND filter and `Prefer: count=exact`, and compare page
    contents with a brute-force oracle while asserting `Content-Range` uses `*`. Repeat with two
    different limits and assert neither response invents a different exact total or scans the tail
    past its bounded candidate work. Separately, run the request through asynchronous permission
    re-entry and assert it is rejected before native acquisition. Use `unitTests/waitFor.js` for
    observable state transitions rather than fixed sleeps.
22. Reject missing, infinite, and oversized full-text result windows through both `Table.search()`
    and REST with `FULLTEXT_QUERY_LIMIT`; reserve `FULLTEXT_QUERY_UNSUPPORTED` for unsupported query
    shapes or capabilities. Prove bounded candidate acquisition never reports a short page as
    exhausted when work limits stop it. Assert programmatic and RFC 9457 errors identify the violated
    constraint, reason, and effective maximum without echoing the supplied value or query text.
    Construct equal-score corpora with mixed primary-key types and verify ascending canonical encoded-
    key order is identical in native and Harper modes, across commits/reopens, and through both APIs.
23. Add the Harper benchmark arm to the shared workload manifests. Compare no-full-text, the existing
    computed-field approach, one Rocks full-text index, multiple Rocks indexes, shadow rebuild, and
    sustained deferral/replay through the real record, authorization, `Table.search()`, REST, and SQL
    condition-construction paths. Run this complete product arm in the fixed-host 10-million weekly
    tier so integration defects do not wait for release qualification.
24. Before release, require matching 100-million-record native/Harper adapter qualification for the
    current storage-stack fingerprint and run the complete 100-million Harper Rocks product arm.
    Regenerate paired evidence when the fingerprint changed; otherwise valid retained evidence may
    be reused. Append the canonical Harper result to Harper's protected result branch and attach its
    hash-linked raw bundle to the immutable Harper release. Fail qualification on publication
    failure, parity errors, p99/search-budget failure, excessive primary-store regression,
    publication lag, unbounded resources, or unresolved RocksDB stall/automatic-flush behavior.

**Exit gate:** the complete full-text design's correctness, p99, primary-store isolation, and
packaging criteria pass. If the RocksDB-backed path fails, Harper does not release full text.

## Verification matrix

| Layer               | Required verification                                                                                                |
| ------------------- | -------------------------------------------------------------------------------------------------------------------- |
| Pure Rust engine    | Analyzer/ranking goldens, property tests, update/delete idempotence, query budgets, commit/reopen                    |
| Protocol            | Round trips, hard document limits, truncation/overflow, allocation bounds, multi-log cursor compatibility, fuzzing   |
| Shared writer       | Per-index writers, parallel progress, global permits/fairness, commit barriers, watermark gaps, rollback, failures   |
| Search pool         | Concurrency, cancellation, deadline, fairness, bounded expansion, stable packed results                              |
| N-API lifecycle     | Multiple Workers, environment teardown, abandoned promises, repeated close, duplicate addon loads                    |
| Directory/transport | Tantivy conformance, immutable slices, atomic durability, bounded queues, worker exit and store close                |
| Package             | Shared runtime, independently usable native mode, qualified Harper integration, typings, tarball, no fallback        |
| Documentation       | Public-export examples, API/error coverage, links, compatibility, lifecycle, README/license in every packed artifact |
| Harper integration  | Real post-commit delivery, exact-count composition, zero-decode replication, replay, rebuild, auth, REST parity      |
| Compatibility       | Paired rocksdb-js update, persisted-format rebuild, LMDB rejection, unsupported-platform preflight                   |
| Lifecycle           | Lazy handles, graceful merge shutdown, storage request drain, worker exit, drop/recreate                             |
| Performance         | Paired native/Harper A/B, Harper p99, multi-index fairness, bounded resources, DB stalls, recovery/rebuild           |
| CI/CD               | PR isolation, protected summary append, artifact retention, Pages rebuild, hashed release evidence, release gates    |

The top-level recovery oracle is required in addition to these layer tests: after randomized
process kills and Harper replay, the active full-text result set and versions must equal a fresh
rebuild from the same authoritative records. It covers every distinct delete, TTL, eviction,
invalidation, retry, and replicated-write path.

Every asynchronous timing test waits on a condition or explicit barrier. Fixed sleeps are reserved
for testing actual timeout behavior.

## Native and Harper performance benchmarks

Compare the existing native backend with the actual Harper RocksDB-backed integration. Hold engine,
corpus, analysis, mutation/commit sequence, queries and budgets constant wherever possible.
Distinguish engine/storage measurements from Table.search/REST measurements that include Harper
authorization, filtering and record retrieval. Never label an end-to-end ratio pure adapter cost.

Instrument projection, packing, native and storage queue wait, copied bytes, storage service time,
Tantivy execution, commit, reload and materialization. Investigate measured differences before
adding infrastructure. Direct rocksdb-js or Directory trace experiments are optional diagnostics,
not a third supported backend or mandatory release dependency.

The workload and GitHub history requirements below apply to the two delivered paths. A paired
engine/storage measurement must use the real Harper integration; if identical isolation is not
available, publish separate results and their scopes instead of fabricating an apples-to-apples ratio.

### Reproducible workload contract

Every run is driven by a versioned manifest committed with the harness. It records the random seed,
corpus generator version, record and indexed-text size distributions, field counts, vocabulary and
term-frequency distribution, query and mutation mix, result windows, hit-rate classes, index count,
shadow generations, concurrency, commit boundaries, cache state, and warm-up/measurement periods.
It also records all values that can move the result outside the adapter: wrapper/Tantivy/rocksdb-js
revisions, release profiles, Node version, CPU and memory limits, filesystem and storage device,
worker and native thread counts, Tantivy writer/merge settings, RocksDB CF/cache/write-buffer/WAL/
compression/atomic-flush settings, chunk size, and publication policy.

The canonical product-catalog generator has four deterministic record tiers rather than one guessed
average document:

| Tier         | Workload shape                                                                                                   |
| ------------ | ---------------------------------------------------------------------------------------------------------------- |
| `small`      | Short titles, identifiers, and sparse metadata; exposes fixed per-record and call overhead.                      |
| `typical`    | Titles, descriptions, keywords, and ordinary arrays across the expected field count.                             |
| `large`      | Longer multi-value descriptions and denser fields; exercises token, batch, and storage amplification.            |
| `heavy-tail` | A deterministic skew of very large values, high array cardinality, common terms, and near-limit valid documents. |

The checked-in Phase-0 manifest assigns exact UTF-8 byte, field-count, array-cardinality, token, and
term-frequency distributions to each tier and explicit weights that sum to the 100-million-record
qualification corpus. Every profile reports latency, throughput, publication lag, memory, and index
amplification by tier as well as for the blend; a passing blend cannot hide a failing required tier.
The same seed and generated records feed native, Rocks, and Harper product arms.

Until representative production measurements exist, the tier boundaries and weights are labeled
provisional and are stress-oriented rather than claimed to represent a customer average. Recalibration
requires a reviewed workload-manifest revision, creates a new comparison cohort and baselines, and
retains the old results. It never silently rewrites historical comparisons. Customer records are not
committed or required to reproduce the corpus.

The initial profiles are:

| Profile           | Purpose                                            | Default corpus |
| ----------------- | -------------------------------------------------- | -------------- |
| `smoke`           | Harness, parity, packaging, and gross bounds       | small and fast |
| `nightly`         | Stable regression and paired adapter ratios        | 1 million      |
| `weekly`          | Paired scale trends plus full Harper product path  | 10 million     |
| `adapter-release` | Storage-stack qualification for a new fingerprint  | 100 million    |
| `harper-release`  | Harper Rocks product qualification for a candidate | 100 million    |

The exact smoke size, tier boundaries and weights, term distribution, query rate, and concurrency
are frozen in the Phase-0 manifest before numeric gates are selected. Representative production
measurements may later recalibrate them through the versioned-cohort process above. Both 100-million-
record qualification profiles are fixed; reducing them requires an explicit design/release decision,
not an expedient CI change.

Within a run, native and Harper arms use fresh stores and an ABBA order across build repetitions so
JIT, thermal, cache, and machine drift are not assigned to one adapter. Once both query stores are
built, warm-query measurement alternates matched, short native/Harper epochs rather than timing one
complete query suite and then the other. Cold-reopen arms remain isolated and alternate order.
Timings count only after result parity passes for keys, ordering, exhaustion, and scores within the
specified floating-point tolerance. The harness preserves the seed and failed fixture when parity
diverges. Arms do not execute concurrently on the benchmark host.

Two comparison modes prevent durability or background work from being hidden:

- **Quiescent search:** both arms complete the same commits and configured merge settling before
  warm-cache and cold-after-reopen queries. This isolates read-path and storage-layout cost.
- **Production mixed load:** each arm uses its real durability implementation at the same logical
  commit boundaries while reads, updates, deletes, and merges continue. Native uses Tantivy's
  filesystem barriers; Rocks uses object durability plus synchronous metadata publication. Neither
  mode weakens durability to manufacture parity.

Focused storage microbenchmarks are optional diagnostics selected after profiling the actual Harper integration. Results from the retained experimental native-lease branch are labeled experimental and cannot satisfy a product gate.

### Measurements and result contract

The paired result reports absolute values and `Harper / native` ratios with explicit measurement scope for:

- initial build and replay-catch-up documents/second and MiB/second;
- incremental insert, indexed update, unaffected partial update, and delete throughput;
- commit latency and commit-to-searchable publication/reload latency;
- term-any, term-all, phrase, prefix, fuzzy, fuzzy-prefix autocomplete, exact autocomplete, and suggestion
  p50/p95/p99/p99.9, separated by selective/common term and result-window class;
- warm-cache, cold-after-reopen, and concurrent indexing/search behavior;
- CPU, peak/steady resident memory, native allocation, thread count, and event-loop delay;
- storage-serving event-loop delay, native blocked-thread count and wait duration, transport queue
  wait and request/response handoff time, separating inclusive waits from nested storage spans;
- logical index bytes, physical bytes, write/read/space amplification, bytes read per query,
  block-cache pressure, pinned bytes, assembled bytes, and chunk fan-out;
- segment count, merge throughput/debt, flush/compaction time, shared-WBM occupancy and attributed
  stall time, unrelated-primary-write latency, and automatic all-CF flushes;
- reopen, crash recovery, backup/restore, full rebuild, and saturation catch-up duration; and
- one, several, and maximum-supported index scaling, including a shadow rebuild and unrelated
  primary traffic in the Harper arm.

Machine-readable results conform to a versioned JSON schema and include the manifest, revisions,
environment fingerprint, raw latency histograms, error/timeout counts, RocksDB and wrapper metric
snapshots, absolute measurements, paired ratios, and gate decisions. Human output summarizes the
same artifact rather than calculating a second set of numbers. Results are invalid, rather than
slow, when parity fails, errors are silently dropped, the host is outside its configured thermal or
disk envelope, background work violates the declared starting state, or the environment fingerprint
does not match the baseline class.

That result schema is the canonical cross-repository contract. The wrapper owns its version; the
Harper benchmark arm emits the same envelope with Harper-specific measurements, and existing
Harper result conversion/trend jobs consume it rather than creating a second full-text history.
Schema compatibility is checked in both repositories whenever either side changes.

Harper's existing stdout `RESULT` scraping is retired as an input contract.
`benchmarks/storage-to-benchmark-json.mts` reads and validates the canonical envelope, then projects
the legacy shape needed by Harper's existing `gh-pages` ST/YCSB visualization. The workflow no
longer greps benchmark logs for authoritative values. ST-2 and every other affected regression gate
run through the manifest-owned nonzero threshold evaluator; `github-action-benchmark` and its
`fail-on-alert` setting remain visualization only and cannot clear or fail a full-text release.

### GitHub result storage and release comparison

GitHub is the durable publication system for benchmark results. This does not make Actions
artifacts the historical database and does not introduce another result format. Each producer
repository owns its evidence:

- `HarperFast/fulltext` publishes adapter, native, Rocks, packaging, and wrapper results;
- `HarperFast/harper` publishes the complete Harper Rocks product-path results using the same
  versioned result schema; and
- neither workflow writes across repositories. The shared schema's producer repository, commit,
  workflow run, package versions, and evidence links let the Pages view join both histories.

The default branch remains the source of truth for benchmark code, workload manifests, the result
schema, and reviewed baseline thresholds. Workflows cannot update `benches/baselines/`; a threshold
or compatible-cohort change requires a normal reviewed pull request. Each repository also has a
protected, bot-managed orphan branch named `benchmark-results`. It contains append-only canonical
result JSON, not source code or large binaries:

```text
benchmark-results
└── v1/
    ├── nightly/YYYY/MM/<run-id>.json
    ├── weekly/YYYY/MM/<run-id>.json
    ├── qualifications/<storage-fingerprint>/<run-id>.json
    └── releases/<package-or-harper-version>/<run-id>.json
```

One idempotent result publisher validates the canonical schema and size bounds, verifies that the
producer SHA and workflow identity match the invoking run, applies a schema allowlist with
`additionalProperties: false`, and appends a uniquely named result. It accepts only normalized host
class and bounded enumerated failure information; hostnames, paths, arbitrary error strings, secrets,
customer data, and other unstable machine identity are not valid schema fields. It fetches the full
result branch, creates a commit against the observed head, and retries a bounded compare-and-swap
push after a non-fast-forward. Evidence and source links are schema-constrained to HTTPS URLs under
`github.com/HarperFast/fulltext` or `github.com/HarperFast/harper`; escaping alone is not a trust
boundary, and non-HTTPS, off-origin, credential-bearing, and `javascript:` URLs are invalid. GitHub
workflow concurrency may reduce collisions but is never the correctness mechanism because a
concurrency group can cancel pending runs. Idempotence by producer repository and run ID makes
retries safe.

Branch protection restricts writers and forbids force-push and branch deletion, but it is not
claimed to enforce content-level append-only behavior. A required integrity workflow on every
`benchmark-results` push verifies that the commit adds only new schema-valid result paths, changes no
existing result, and deletes nothing. Pages and release gates consume only commits with that passing
check. The renderer enumerates the branch tree at build time rather than trusting a workflow-written
`index.json`; a partial checkout cannot hide earlier runs. Failed, timed-out, and parity-invalid
scheduled runs still publish a status result so missing data cannot make a regression disappear;
invalid runs never become a baseline or numeric comparison point. The concurrent-publisher test
injects at least three simultaneous completions and non-fast-forward retries.

The canonical JSON contains the compact comparison evidence, including histogram buckets. Large
traces, profiles, logs, crash fixtures, and full diagnostic bundles are never committed to Git.
Pull-request and scheduled workflows upload those as temporary Actions artifacts with explicit
retention. Initial policy is 14 days for pull requests, 30 days for nightly runs, and 90 days for
weekly runs, bounded by the repository's available retention. The workflow always uploads the
diagnostic bundle on failure.

Qualification and release workflows additionally create a deterministic compressed evidence bundle
containing the canonical result, manifest, raw diagnostics, checksums, and environment fingerprint.
The adapter bundle is promoted when qualification completes to a dedicated immutable
`HarperFast/fulltext` prerelease tagged by storage fingerprint and run ID, so a delayed product
release cannot expire multi-hour evidence or consume benchmark capacity by forcing an avoidable
rerun. The first consuming package and Harper releases link that qualification asset and checksum;
Harper's complete product bundle is attached directly to the matching immutable Harper release.
Evidence assets are assembled before publication, named by result-schema version, storage
fingerprint, and run ID, and referenced by URL and SHA-256 from the append-only summary. If an asset
exceeds GitHub's current per-file limit, it is split into hashed parts described by the same
manifest. Release evidence is retained for the repository's lifetime unless a documented migration
copies every asset and preserves its hashes and URLs.

GitHub Pages is a generated view, not a source of truth. It is hosted by
`HarperFast/fulltext` through a custom Actions deployment; Harper's existing `gh-pages` benchmark
site and its ST/YCSB views remain in place. The new renderer reads validated summaries from both
repositories and renders release-over-release latency, throughput, memory, storage, recovery,
rebuild, publication-lag, and Rocks/native-ratio charts. The default comparison includes only runs
with compatible result-schema, workload-manifest, host-class, platform, build profile, and
storage-stack fingerprints. An explicit diagnostic override may display incompatible runs, but
labels the comparison invalid for gating. Every plotted point links to its immutable result,
producing workflow run, source commit, and release evidence.

Result-branch commits made with `GITHUB_TOKEN` are not relied upon to trigger Pages implicitly. The
publisher explicitly dispatches or calls the Pages deployment after a successful append, and a
scheduled reconciliation rebuilds the site from branch state so a missed deployment signal is
self-healing. The renderer treats every result field as untrusted data, escapes labels, refuses
arbitrary HTML/URLs, and publishes static files only. Failure to fetch either producer, validate its
branch head, or locate a required release cohort produces a visible dated gap marker and a failing
reconciliation check; it cannot silently publish a one-sided comparison or leave an undated stale
site looking current.

A separate daily reconciliation runs on a GitHub-hosted runner, independent of the fixed benchmark
host. It verifies that every required nightly and weekly tier has produced either a valid result or
an explicit failure observation within its expected period. A missing or perpetually queued run
creates or updates one operator-owned GitHub issue, marks Pages degraded, and fails the reconciliation
workflow until evidence appears. This covers a stopped JIT runner or a benchmark job that never
reaches its publisher; Pages deployment reconciliation alone is insufficient.

Only trusted default-branch scheduled, manually approved qualification, and release workflows may
write durable results or release assets. Pull-request workflows, including forks, have read-only
repository permissions and can upload only temporary run artifacts. Publisher and Pages jobs use
separate least-privilege permissions; benchmark execution receives no contents-write or Pages-write
token. Harper's existing `.github/workflows/perf-benchmarks-nightly.yml` and
`.github/workflows/ycsb-nightly.yml` are split so dependency installation and benchmark execution run
with `contents: read`; only a separate hosted publisher receives narrowly scoped write permission.
A publication failure fails the benchmark workflow and leaves the benchmark result ungated until
its durable summary and required release evidence exist.

### CI/CD execution tiers

Benchmarks are part of CI/CD, with cost and signal separated by tier:

| Pipeline tier            | Runs                                                                                                          | Gate behavior                                                                                                                                             |
| ------------------------ | ------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Pull request             | Correctness, packed examples, parity, result-schema validation, representative Directory conformance smoke    | Required. Uploads temporary diagnostics only; it cannot write the result branch, releases, baselines, or Pages.                                           |
| Fixed-host nightly       | Repeated 1-million paired A/B, mixed Harper read/write, multi-index, publication, and Rocks pressure          | Required for trend health. Publishes one permanent canonical summary and 30-day diagnostics.                                                              |
| Fixed-host weekly        | 10-million paired scale plus the complete Harper product path, cold reopen, rebuild, deferral, backup/restore | Required for integration and scale health. Publishes one permanent canonical summary and 90-day diagnostics.                                              |
| Adapter qualification    | 100-million native/Harper workload qualification for a new storage-stack fingerprint                          | Required when the fingerprint changes. Publishes the summary and immediately promotes the hashed raw bundle to an immutable fulltext evidence prerelease. |
| Harper release candidate | 100-million Harper Rocks product workload                                                                     | Hard release gate. Publishes the Harper summary and attaches the immutable evidence bundle to the matching release.                                       |
| Platform/package release | Supported-platform correctness, Harper compatibility, tarball examples, license/docs contents, native smoke   | Blocks publishing an affected package and requires its GitHub summary/assets; performance uses designated stable hardware.                                |
| Hosted reconciliation    | Expected nightly/weekly result or explicit failure, branch integrity, evidence links, and Pages freshness     | Required operational check. Opens or updates the maintainer issue and leaves Pages visibly degraded until repaired.                                       |

The fixed benchmark service extends Harper's existing self-hosted performance workflow and result
format rather than creating an unrelated runner system. The existing runner is repository-scoped
and serialized, so implementation must either route `HarperFast/fulltext` jobs through its JIT
supervisor with an explicit capacity allocation or provision another equivalently controlled host.
No workflow is marked required until that routing is proven. Before enabling schedules, the team
freezes per-tier wall-clock, durable-disk, temporary-space, and cleanup budgets and decides which
existing jobs yield capacity; the 100-million arms must not inherit the current two-hour job timeout
without measurement.

The workflow serializes comparable performance jobs, uses durable local storage, cleans and
recreates stores between arms, records host health, and uploads diagnostic artifacts even on
failure. The result publisher then validates and appends the canonical summary. A storage-stack
fingerprint covers Tantivy, napi-rs and Rust release profile, wrapper storage-format/chunk-layout
versions, Harper/storage build identity, RocksDB version, and relevant option class. Changing it
triggers a fresh adapter qualification. A Harper release with an unchanged fingerprint may reuse
still-valid paired evidence but must run its own 100-million Rocks product arm.

Trend publication and gating are separate steps over the same result artifact. Once baseline
variance is frozen, the manifest threshold evaluator exits nonzero for a violated required gate;
an advisory trend action or `fail-on-alert: false` setting cannot turn that result green. Baseline
changes require an explicit reviewed default-branch change and preserve the preceding baseline
rather than rewriting history. The Pages workflow renders that history but cannot approve or write
a baseline.

Thresholds are configuration checked into the benchmark manifest, not undocumented workflow
constants. Phase 0 first establishes variance on fixed hardware, then freezes the allowable adapter
ratio, memory/storage amplification, indexed-write regression, publication lag, Rocks stall/flush
rate, and recovery/rebuild bounds. The end-to-end Harper Rocks query workload has the already chosen
p99-under-50-ms objective; its exact corpus shape, concurrency, query classes, and result windows
must be frozen beside that threshold so the number remains meaningful.

## Performance gates for the wrapper

The wrapper receives a budget inside the full end-to-end p99 target; it does not get to consume the
entire 50 ms. The provisional pre-PR-3 deadline envelope on the reference workload is 20 ms for
native candidate production, 20 ms for bounded primary-record materialization and authorization,
and 10 ms for Harper planning, scheduling, and REST overhead. These are work/deadline allocations,
not additive percentile claims; the end-to-end 50 ms measurement remains authoritative. Phase 0
records the workload manifest and fixed-host variance before adjusting or freezing them. Candidate
over-fetch must fit the first two allocations, and publication cadence is selected against its
separate freshness/primary-write gate rather than borrowing query time. At minimum, measure:

- queue time separately from execution time;
- admission-shard contention, coarse global-credit acquisition frequency, and proof that ordinary
  deliveries perform no shared atomic read-modify-write across writing workers;
- saturated-path global-credit attempts per record, environment-local catch-up-latch hits, and
  primary-write p99 while every shard remains deferred;
- mutations and bytes per second by batch size;
- projection, UTF-8 encoding, N-API serialization, and copy time, including hot-path deferral;
- search p50/p95/p99/p99.9 by comparator class;
- commit duration and commit-induced tail latency;
- cancellation response time and wasted native work;
- Rust, Tantivy, and RocksDB memory separately where possible;
- segment count, merge debt, and writer queue occupancy;
- merge peak memory by input-segment class and safety margin at the minimum supported cgroup limit;
- active and queued writer generations, aggregate indexing threads and writer memory, cross-index
  fairness, and concurrent commit/flush occupancy as the declared index count increases;
- event-loop delay and unrelated libuv workload latency;
- storage requests, copied bytes and bytes fetched per requested byte;
- assembled versus pinned bytes, peak resident bytes per segment/reader, and total reader residency;
- primary-record read/write regression under mixed load;
- complete query latency including candidate validation, authorization, and primary-record point
  reads at each supported result-window size;
- writes to tables with active full-text indexes, separating post-commit projection and native
  admission from queue/index/commit cost under production concurrency;
- direct-delivery acceptance ratio, replay fallback volume, watermark lag, retention headroom, and
  time to catch up after saturation;
- worker-0 event-loop delay while writes originate across all workers, proving no JavaScript
  cross-worker delivery bottleneck;
- blob acquisition latency, pending-content retry age, and the effect of extraction on watermark
  progress;
- the zero-feature path: writes to tables without full-text attributes perform no derived-index
  allocation, encoding, native load, or additional per-index work.

Native mode is both a supported binding mode and the reference path for isolating engine cost from
the custom Rocks Directory. Its performance does not clear a Harper release gate.

## Approaches considered

<!-- prettier-ignore -->
| Axis                | Candidate                                                       | Disposition                                                                                                                                                                                                |
| ------------------- | --------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Repository boundary | Implement directly inside Harper                                | Rejected: native artifacts, Rust dependencies, platform releases, and engine tests need an independent lifecycle like HNSW and Symphony.                                                                   |
| Public API          | Expose raw Tantivy schemas, Directory objects, or query strings | Rejected: it couples callers to a third-party API and creates an alternate Harper query surface.                                                                                                           |
| Public API          | Typed façade with explicit storage subpaths                     | Chosen: native and Harper storage are deliberate binding modes, while generated declarations and raw Tantivy types stay private.                                                                       |
| Authorization       | Run on record-filtered resources and document score leakage     | Rejected: global document frequency, rank order, short pages, and exhaustion reveal hidden-record information; the first release uses a mechanical conservative rejection.                                 |
| Async execution     | Use N-API `AsyncTask` for sustained work                        | Rejected: it consumes Node's shared libuv pool and can interfere with unrelated Harper work.                                                                                                               |
| Async execution     | Use wrapper-owned ingestion lanes and bounded pools             | Chosen: nonblocking multi-worker admission, one writer per index generation, serialized per-index commits, controlled process-wide concurrency, and deterministic lifecycle.                               |
| Binding storage     | Support only Tantivy native files                               | Rejected: the binding supports both explicit modes and shares one engine across them.                                                                                                                      |
| Binding storage     | Native factory using `MmapDirectory`                            | Chosen: reuse Tantivy's implementation directly; do not implement another filesystem Directory.                                                                                                            |
| Harper storage      | Native files with a Rocks-published pointer                     | Rejected by the product boundary: a Harper release must keep the derived store inside its existing RocksDB lifecycle and backup domain. This is not presented as a conclusion from an unmeasured rebuild time; native files remain a standalone mode and benchmark reference, never a Harper fallback. |
| Harper storage      | `RocksDbDirectory` over the existing database                   | Chosen and required for Harper release.                                                                                                                                                                    |
| Search engine       | Build KV postings, document-frequency counters, positions, and block-max WAND directly in the index CF | Rejected: it would recreate BM25 execution, phrase positions, prefix/fuzzy/fuzzy-prefix expansion, segment maintenance, and top-k pruning that Tantivy already supplies. The design customizes storage integration, not the search engine. |
| Storage isolation   | Dedicated CFs in Harper's existing RocksDB                      | Chosen to preserve one datastore and lifecycle authority. DB-wide stall coupling remains a measured release blocker rather than assumed isolation.                                                         |
| Storage isolation   | A second `rocksdb-js`-owned RocksDB database                    | Rejected for this release because it creates another WAL, backup/restore unit, cache, lifecycle, and recovery boundary.                                                                                    |
| Process isolation   | Run Tantivy in a supervised sidecar over UDS                    | Rejected because it cannot borrow Harper's already-open RocksDB handles, so it requires a second store or storage IPC and adds an IPC hop to every query.                                                  |
| Service boundary    | Feed an external search service from replication                | Rejected for the native feature because it creates a separately operated store, backup/restore lifecycle, consistency contract, and network dependency, and violates Harper's single-runtime product goal. |
| Stall response      | Wrapper-owned RocksDB circuit breaker                           | Rejected: rocksdb-js already owns RocksDB observability and Harper owns product admission policy.                                                                                                          |
| Stall response      | Harper policy using rocksdb-js and wrapper status               | Chosen: the wrapper supplies bounded pause/resume controls and reports only its own queue/merge state.                                                                                                     |
| Change delivery     | Synchronous native apply inside the record txn                  | Rejected because Tantivy cannot join the transaction and projection encoding/native queueing would extend the authoritative write path.                                                                    |
| Change delivery     | Consume RocksDB `GetUpdatesSince`/WAL events                    | Rejected: Harper's primary/index CF writes are WAL-disabled, so RocksDB's native update stream omits exactly the authoritative record changes the derived index needs. |
| Change delivery     | Versioned dirty-marker epochs                                   | Rejected: they duplicate the transaction log and add `GetForUpdate` serialization, marker writes, epoch rotation, and reclamation to the authoritative write path.                                         |
| Change delivery     | Continuous log tailer only                                      | Rejected for steady state because it cannot meet the chosen same-thread freshness path without rereading/redecoding committed records. Log tailing remains the required recovery/saturation path, and Phase 0 measures its actual lag/throughput rather than assuming a bottleneck. |
| Change delivery     | Catch up by record-version range scan                           | Rejected: it cannot observe deletes, evictions, or invalidations without the log and would require a new version-ordered index on every source table. It does not remove the durable delivery problem. |
| Base-copy delivery  | Wait for completion `reload`, then rescan the whole table       | Rejected: copy rows are audit-free, a crash before the completion marker creates a silent gap, and a successful copy needlessly rereads every row. A durable start fact is required. |
| Base-copy delivery  | Feed committed copy batches into a cursor-gated private generation | Chosen: the applier already owns full records and a durable resume cursor. Start invalidates active completeness; derived cursor coverage plus ordinary log catch-up gates completion, with scan fallback only for an unreplayable gap. |
| Verification        | Continuously sweep primary keys and repair version mismatches   | Rejected as the first-release authority: a one-way scan misses ghost deletes, equal versions do not prove analyzed terms, and the primary/index stores lack one shared snapshot. A future bidirectional diagnostic requires a separately budgeted design and reports rather than masks divergence. |
| Change delivery     | Push positions only and pull every record during indexing       | Rejected: native pull couples the wrapper to Harper's primary store/encoding; JS pull recreates cross-worker read/decode and adds a point read per mutation. Use only for bodyless replay.                 |
| Change delivery     | Push projections; pull only unresolved replay bodies            | Chosen by issue #2489: the originating worker owns the record/schema, bounded coalescing reduces N-API calls, and the transaction log remains the recovery queue.                                          |
| Writer topology     | Send every mutation through worker 0                            | Rejected: it creates a JavaScript cross-worker bottleneck and forces record re-read/re-decode. Every committing worker projects locally and feeds each target index's process-global native writer.        |
| Writer topology     | One writer shared by all logical indexes                        | Rejected: Tantivy writers are bound to one index schema and Directory, and one global publication lock would couple unrelated index progress and failure.                                                  |
| Writer topology     | One writer per index generation with multiple ingestion lanes   | Chosen: Tantivy permits shared add/delete/run access within an index; different indexes progress in parallel while process-level permits bound aggregate work, memory, and commit concurrency.             |
| Smaller first scope | Periodic rebuild-only read-only generations                     | Rejected because it cannot meet the product's continuously updated search requirement. It remains a useful early test mode; Phase 1 measures rebuild throughput for operational recovery planning, not to revisit the Rocks-only Harper storage boundary. |
| Smaller first scope | Hot-only delivery; rebuild after every restart                  | Rejected: a 100-million-record index remains unavailable or stale for the measured rebuild duration, and crash loops can prevent convergence. Phase 1 measures that cost.                                  |
| Smaller first scope | Token arrays in Harper secondary indexes                        | Rejected because common terms require unbounded key scans before top-k, with no native positions, fuzzy dictionary, or scalable BM25 execution.                                                            |
| Node surface        | Export raw napi-rs declarations                                 | Rejected: native representation and public TypeScript evolution have different constraints.                                                                                                                |
| Node surface        | Hand-written façade over generated declarations                 | Chosen, following Symphony; it centralizes validation, cancellation, codecs, error normalization, and loader behavior.                                                                                     |
| Perf baseline       | Compare Tantivy results with unrelated raw RocksDB operations   | Rejected as the headline result: RocksDB has no equivalent search semantics. Direct primitive measurements remain diagnostic only.                                                                         |
| Perf automation     | Apply absolute performance gates on every hosted PR runner      | Rejected: variable hardware turns noise into policy. PR CI gates harness correctness; stable self-hosted tiers own numeric performance gates.                                                              |
| Perf automation     | PR smoke plus fixed-host nightly/weekly/release qualification   | Chosen: it reuses Harper's benchmark infrastructure and makes the 100-million-record Rocks product result a release artifact.                                                                              |
| Perf automation     | Use `github-action-benchmark` as the regression gate            | Rejected: comparison with the previously published point can ratchet a bad run into the baseline and cannot enforce compatible cohort fingerprints. It remains a legacy visualization consumer only.       |
| Expensive evidence  | Re-run 100-million paired native/Harper for every Harper release | Rejected: adapter evidence is unchanged when the storage stack is unchanged and would consume serialized benchmark capacity without new attribution.                                                       |
| Expensive evidence  | Key paired evidence to the storage-stack fingerprint            | Chosen: relevant dependency/format/config changes invalidate it, while every Harper candidate still runs the complete 100-million Rocks product workload.                                                  |
| Result retention    | Keep history only as GitHub Actions artifacts                   | Rejected: artifact expiry would eventually erase the release comparison and its evidence links.                                                                                                            |
| Result retention    | Commit raw traces, profiles, and logs to Git                    | Rejected: large append-only binaries would bloat every clone and are not needed to render comparable trends.                                                                                               |
| Result retention    | Protected summaries, release assets, and GitHub Pages           | Chosen: canonical JSON stays reviewable, raw release evidence remains downloadable, and Pages is a replaceable view over immutable sources.                                                                |
| Result retention    | Make an external metrics service authoritative                  | Rejected initially: GitHub already owns source, workflows, releases, permissions, and public documentation. A mirror may consume the same schema later without becoming the release gate.                  |
| Documentation       | README examples maintained as unexecuted prose                  | Rejected: native packaging and subpath exports can drift while examples still look plausible.                                                                                                              |
| Documentation       | Compile and execute examples from packed artifacts              | Chosen: users exercise the same exports, peer resolution, loader, files, and license that npm publishes.                                                                                                   |

## Decisions fixed by this plan

- Deliver native Tantivy and Harper-backed storage; no standalone rocksdb-js export or base native
  bridge. Harper persists Tantivy state solely in its existing RocksDB database.
- The next milestone is the actual Harper storage/protocol proof. Existing APIs, transport,
  publication and replay must be demonstrated before the integration factory freezes.
- Native and Harper performance results retain distinct measurement scopes. Optional experimental
  benchmarks do not gate either supported backend.
- Harper owns its storage dependency version. Integration compatibility uses the qualified Harper
  stack and persisted formats rather than a lease ABI.

- The package is the independent `HarperFast/fulltext` repository and is published as
  `@harperfast/fulltext`.
- The package declares Node `^22.18.0 || >=24.0.0`, matching Harper, and initial CI qualifies majors
  22, 24, and 26 against the same Node-API artifacts. The wrapper has no separate narrower Node
  compatibility policy.
- The host supplies one explicit process-wide resource budget before any index opens. The wrapper
  validates, freezes, and enforces it across all factories, indexes, and generations; repeated
  identical initialization is harmless, conflicting initialization fails, and no index or schema
  can override the budget. The wrapper never infers a larger budget from machine or cgroup capacity.
- The same process initialization requires `maxStaleSearcherAgeMs`. Harper chooses it as trusted
  server policy, standalone hosts choose it explicitly, and no schema or index factory overrides it.
  The wrapper enforces the deadline from the oldest unresolved durable publication timestamp, so
  retries and restart cannot renew stale service; zero disables stale serving.
- Harper owns post-commit coalescing, its thresholds, event-loop scheduling, retained-content budget,
  and shutdown behavior. The wrapper receives only bounded batches, exposes no batching control, and
  applies its own independent decode and admission limits. Neither policy appears in `@fullText`.
- Graceful shutdown performs a bounded parallel drain within Harper's existing deadline and ordinary
  global/per-database commit permits: coalescers flush, active serving generations are prioritized by
  oldest pending work and lag, and accepted work commits and publishes when time permits. Remaining
  uncommitted work rolls back and is recovered from the last durable watermark. Crash skips the
  optimization. The protocol never force-frees an active RocksDB operation, creates a shutdown-only
  flush pool, or waits without a bound.
- The repository and every published package use the Apache License 2.0 with consistent npm and
  Rust metadata and the license text included in packed artifacts.
- Full text is declared only through Harper's new `@fullText` derived descriptor. The wrapper has no
  knowledge of Harper schema directives or ordinary index types.
- The public package name describes the Harper capability, not Tantivy.
- napi-rs v2 is used initially to match the existing Harper native packages.
- Native and Harper-backed indexes expose awaited `apply()`. The separately named derived Rocks
  factory adapts Harper progress context and exposes nonblocking watermarked `deliver()`.
- Deterministic record or source quarantine does not reject standalone `apply()`. Its fixed-size
  receipt reports applied/suppressed/quarantined counts and a bounded opaque failure-ID sample with
  an explicit truncation bit; full aggregates remain in status/metrics. Derived `deliver()` remains
  nonblocking and reports applied quarantine asynchronously through Harper operator surfaces.
- Retryable Blob unavailability preserves the previous searchable document and its progress gap only
  inside the release-qualified freshness/staging budget, anchored to the durable log-entry timestamp. Expiry emits a record-level
  quarantine that removes the entire prior full-text document, advances progress, and remains
  operator-visible until a newer valid version or delete clears it. The duration is frozen Harper
  system policy, not schema configuration; a 24-hour blocking window is rejected without a durable
  out-of-order ledger.
- A standalone `apply()` receipt proves application order only. Standalone durability and replay
  authority come from `commit({ checkpoint })`; the opaque caller-owned checkpoint is limited to
  65,536 input bytes and round-trips bit-for-bit with the indexed state through a versioned
  base64url text envelope in Tantivy's `IndexMeta.payload`. The wrapper does not interpret the
  caller bytes. Omitting them means recovery requires a full source rebuild.
- Standalone `commit()` resolves at durable Directory publication and schedules background reload;
  it does not wait for searcher warming. `reload()` is the explicit visibility barrier and waits
  until the shared searcher covers the publication current when called. Search without that wait
  may briefly observe the preceding immutable snapshot.
- Standalone native and Harper factories never auto-commit by time, count, bytes, or idleness. Their
  caller owns explicit commit cadence, checkpoint bytes, and replay policy. Only Harper's separately
  named derived factory uses the hybrid automatic scheduler, over the shared commit implementation.
- Standalone `close()` defaults to a clean-state requirement. Pending or uncommitted work returns
  `FULLTEXT_UNCOMMITTED_WORK` and leaves the handle open; only explicit `mode: 'rollback'` discards
  work after the last commit. Derived mode separately retains runtime-owned drain/rollback
  behavior, and no standalone close path commits implicitly.
- A failed reload preserves the preceding validated searcher only during the host-supplied, process-
  level `maxStaleSearcherAgeMs` interval and retries in the background. Explicit `reload()` rejects
  that attempt. If no reader reaches the durable publication before the persisted deadline, all new
  search admission fails with `FULLTEXT_INDEX_UNAVAILABLE` until recovery; stale service never
  continues indefinitely or gains a new interval after restart.
- A standalone `apply()` may be cancelled only before writer admission, in which case no mutation
  occurs. After application starts, the bounded batch completes and resolves its authoritative
  receipt even if its signal is later aborted; it never returns a cancellation rejection after
  changing writer state. Durability still requires `commit()`.
- An internal failure after application starts that leaves the applied set unprovable poisons that
  writer epoch, rejects pending work with `FULLTEXT_WRITER_FAILED`, and blocks commit/publication.
  Recovery reopens from the last durable commit and replays through the standalone checkpoint or
  derived log cursor; the wrapper neither retries the batch nor broadly rolls back and continues on
  the same writer.
- Standalone callers own ordering across published checkpoints; the wrapper adds no durable
  per-record version ledger. The shared runtime suppresses stale/duplicate mutations within the
  current window, while Harper's derived watermark supplies its cross-commit frontier.
- Equal record-version bits with identical canonical operation/content are duplicates; differing
  operation/content is `FULLTEXT_VERSION_CONFLICT`, never node-ID or arrival-order last-wins. A
  standalone apply rejects before changing that batch. Derived mode holds the opaque position while
  Harper rereads its authoritative record and submits an exact-bound repair; an unresolvable conflict
  rebuilds the generation. Until repair, the complete prior snapshot serves only within the stale
  limit anchored to the conflict's durable log timestamp; no temporary deletion or partial successor
  publishes. After expiry, service recovers automatically only when the repaired watermark is durable
  and its searcher validates and atomically activates; accepting or committing the repair is not
  sufficient. Healthy delivery gains no record reread or durable per-record ledger.
- Delivery mode is immutable for a storage identity and generation. The process-global registry and
  active commit payload reject cross-mode opens; switching modes requires a new generation/rebuild.
- The wrapper exposes explicit query operations, not Tantivy query strings or raw schemas.
- Both storage subpaths expose the same read-only, versioned hard-limit capability metadata directly
  from the loaded native artifact. Embedders inspect it instead of duplicating constants; native
  enforcement remains authoritative on every call.
- Batches and hits use versioned packed buffers.
- Packed mutation input is fully and boundedly validated before queue admission or writer access.
  A structural protocol, schema/generation, field, offset/length, strict-UTF-8, trailing-byte, or
  limit failure rejects the complete batch with no valid-prefix application or record skipping.
  Explicit content-quarantine markers remain valid mutations; `commit()` remains the durability
  boundary.
- The decoder enforces hard per-field, per-document, per-batch, result-window, clause, and allocation ceilings
  before invoking Tantivy. Callers may lower but cannot raise them. Those ceilings do not bound
  merge-time allocation: merge-heavy qualification at the minimum supported cgroup limit must prove
  the process-wide writer/merger budget and safety margin. An allocator abort is process-fatal and
  blocks release rather than becoming a recoverable wrapper error.
- Indexing uses one process-global `IndexWriter` per canonical storage identity, logical index, and
  generation. Every write-capable Harper worker may feed it through bounded native admission; the
  wrapper serializes commit and publication per index while different indexes may progress in
  parallel.
- All factories use one storage-neutral runtime, query IR, writer pipeline, commit/publication
  implementation, reader/search path, and close path. Only the Directory, admission behavior, and
  typed publication state vary.
- Process-level permits and budgets bound aggregate indexing threads, resident writer memory,
  queues, searches, commits, and rebuild generations across all indexes. These are trusted runtime
  settings, not customer schema tuning.
- Registered-index and resident-writer limits are separate. Harper enforces a server-level per-table
  declaration/fan-out cap, and the wrapper enforces the process registered-index cap. Within both,
  excess writers park and fairly replay from retained logs while their last validated readers remain
  searchable only within the process-level `maxStaleSearcherAgeMs` bound. Unlimited registration is
  not supported.
- Every `IndexWriter` uses explicit worker, merger, and arena settings. The registry caps resident
  generations and parks excess derived writers on their durable log frontier; operation permits do
  not stand in for resource residency accounting.
- Derived publication uses document and byte thresholds plus a maximum unpublished age and minimum
  interval. One commit/durability barrier runs per `DBDescriptor` initially. HNSW's proposed
  4,096-mutation mmap durability interval is not reused because Tantivy commit also controls search
  visibility.
- Under the qualified steady-state workload, a successful source-changing commit becomes visible to
  full-text search within one second at p99. Storage pressure, rebuild, and recovery expose separate
  lag states rather than pretending to meet this SLO.
- One process-global `IndexReader` and atomically replaceable `Searcher` snapshot serve every
  environment for an index generation. Publication reloads in the background; query admission never
  reloads.
- Search and indexing do not use the shared libuv pool.
- A TypeScript façade, not generated addon declarations, is the stable contract.
- The aggregate multi-log transaction watermark is stored in Tantivy's standard string commit
  payload and becomes visible with `atomic_write(meta.json)`. Tantivy owns `.managed.json` and
  logical GC.
- Harper's transaction log is the normal per-record durable delivery fact. Full text adds no dirty
  marker column family, `GetForUpdate` control row, marker epoch, or marker-range reclamation. The
  deliberate exception is replication base copy, whose existing durable copy identity/resume cursor
  governs audit-free rows.
- A durable base-copy start invalidates active completeness, and the copy applier feeds committed
  full-record batches directly into a private derived generation. Completion `reload` can publish
  only after the derived copy cursor covers the source completion cursor and log catch-up is
  contiguous; a crash before completion remains explicitly incomplete. Unknown audit operations
  fail closed and never advance a watermark.
- Projection occurs on the committing worker after the source/log commit. Native admission never
  waits; saturation defers to position-based replay.
- Each worker coalesces ordered post-commit deliveries per target on the next event-loop turn under
  Harper-owned runtime byte/entry bounds. Threshold flushes may run earlier; overflow retains no
  record content and latches replay rather than creating one N-API crossing per source transaction.
  The wrapper has no coalescer settings and independently rejects a malformed or oversized batch.
- Position-only push with universal pull-side projection is rejected for steady state because it
  either couples the generic native wrapper to Harper record internals or rebuilds a JavaScript
  cross-worker decode bottleneck. Harper pull-side resolution is limited to bodyless replay entries.
- Harper's owned post-commit dispatcher isolates change feeds and every derived backend individually;
  one consumer failure cannot suppress later consumers after a successful record commit.
- Direct source-dependency masks suppress projection and Tantivy mutation for proven-unaffected
  partial updates. Their log positions complete as no-ops so optimization cannot stall a watermark.
- An affected pre-encoded `HAS_PARTIAL_RECORD` body is not a document replacement. It remains
  `source-required` until Harper supplies a proven full post-merge record; otherwise delete-then-add
  would erase terms from unchanged indexed fields. Local PATCH uses the full post-merge in-memory
  record already held by its originating worker, while invalidation/delete semantics are dispatched
  before fullness flags and require no point read.
- Full-text descriptors are derived-index registrations, not transactional secondary indexes; they
  never enter `indices` or `openIndex()`.
- Rocks `deliver()` is total and nonthrowing. One process-global bound covers queued and all
  ahead-of-watermark state, and replay stops rather than exceeding it.
- The first release applies only a contiguous watermark prefix to `IndexWriter`. Work beyond a gap
  remains in bounded pre-Tantivy staging until the gap resolves; there is no separate durable
  version/tombstone ledger.
- Blob-backed work carries only an opaque reference through post-commit admission. The bounded
  background extraction lane then acquires a renewable Harper-owned content lease. Expiry is
  observable and triggers the configured rebuild/refetch/failure policy before reclamation; the
  wrapper owns no blob hold table or disk-retention policy.
- The initial extraction surface is record strings and explicitly declared UTF-8 plain-text blobs.
  Rich document formats require a separately reviewed isolation, resource-limit, fuzzing, and crash-
  containment design; Tantivy is not used as a document parser.
- Token positions and normalized unstemmed surface terms are default-enabled structural options.
  Disabling positions removes phrase capabilities; disabling surface terms removes
  prefix/autocomplete and fuzzy capabilities. Capability checks fail explicitly rather than
  scanning, changing either option creates a new generation, and every configuration has format and
  benchmark coverage.
- `matches_phrase` means exact ordered adjacency (`slop = 0`) in the first release. Phrase slop is a
  later bounded query capability, not a schema or storage-format requirement, and cannot cross
  source-field or repeated-value boundaries.
- `matches_fuzzy` uses a fixed maximum edit distance of one, counts adjacent transposition as one
  edit, uses term-any semantics for multi-term input, and offers no first-release schema or request
  override. Each eligible term is a zero-tie native `DisjunctionMaxQuery` whose exact branch is a
  `Must` Boolean sum of weighted BM25 and a fixed exact-match preference bonus, and whose alternative
  is a lower constant-score native fuzzy clause. Tests prove the bonus adds inside the exact branch
  while alternatives do not stack, so an exact spelling wins its group. Both constants are benchmark-
  qualified release values rather than options. Documents matching more distinct
  terms accumulate more score, and expansion stays within Harper-owned work limits. Only terms of
  four or more characters are fuzzed; shorter terms remain exact without rejecting a mixed query.
  Numeric tokens, mixed letter/digit tokens, and tokens containing identifier punctuation remain
  exact under fuzzy search and are frozen by versioned golden query fixtures. Strict all-term fuzzy
  matching requires AND-composed single-term leaves; a `matches_all_fuzzy` comparator is deferred.
- `matches_prefix` and autocomplete require at least three characters in the final analyzed token.
  Every completed term and the final prefix are required record-level groups, each matching across
  all declared weighted fields; adjacency and order are not required. Only the final token expands.
  Each completion retains normal schema field boosts, while Tantivy's native `DisjunctionMaxQuery`
  with a zero tie-breaker selects the strongest completion contribution for the prefix group.
  Matching several expansions cannot multiply the score of one logical prefix token.
  The final completion token remains required after analysis. If enabled stop-word processing
  removes it, both exact-prefix and fuzzy-prefix leaves compile to match-none even when completed
  terms remain. The wrapper never drops the final group, broadens the query to those terms, or uses a
  prefix-specific analyzer fallback.
  If the original input instead ends at an analyzer-recognized token boundary, all surviving terms
  are completed exact requirements and the query has no prefix group. The request protocol preserves
  this trailing-boundary fact; neither façade may trim it into an incomplete final token, and the
  native implementation never performs an empty-prefix dictionary walk. If no completed term
  survives, the leaf is match-none.
  One- and two-character prefixes fail before native execution; the minimum is not customer-
  configurable in the first release. Exact ordered phrase-prefix behavior is deferred to a distinct
  future comparator.
- Preview `matches_fuzzy_prefix` is a distinct structured mode backed by Tantivy
  `FuzzyTermQuery::new_prefix`; it is not an option hidden inside exact prefix. Completed terms remain
  exact required record-level groups, and only a final normalized surface token of at least four
  characters may use edit distance one with adjacent transposition costing one. Numeric and product-
  identifier tokens take only the exact-prefix branch. The final group is a zero-tie disjunction-max
  of the exact-prefix branch with its higher fixed score and a lower-scored fuzzy-prefix fallback, so
  exact completion wins without stacking. Fixed automaton, term, time, cancellation, cumulative-work,
  admission, and result budgets apply. The wrapper accepts no wildcard syntax or distance option,
  and Harper does not promote this mode from preview until adversarial catalog-scale benchmarks meet
  its latency and saturation gates.
- One bounded full-text subtree may use Harper's existing AND, OR, and negation nodes when every leaf
  targets the same logical index and every disjunctive branch has a positive scoring anchor. Harper
  sends it as one recursively constructed native Boolean query, deduplicates canonical leaves without
  changing polarity, and sums Tantivy's normal boosted positive scores. Negated leaves become
  `MustNot` and contribute no score. Mixed structured/text or cross-index Boolean trees, pure-negative
  trees, and OR branches formed from an unanchored negative remain unsupported.
- Maximum Boolean-tree depth, total clause count, and prefix/fuzzy expansion are fixed, published
  release limits selected through adversarial benchmarks. They are not schema, index-open, or
  per-request options. Harper validates them before Node-API and the native package enforces them
  again for both Harper and Harper-backedDB use.
- Minimum lengths use the normalized pre-stem surface term's Unicode scalar count: two for emitted
  identifier components, three for exact prefix, and four for fuzzy or fuzzy-prefix eligibility.
  UTF-8 bytes and UTF-16 code units never substitute for that count. Independent maximum byte, term,
  source, and allocation ceilings remain in force, and shared golden fixtures keep Harper preflight
  and native validation identical across normalization expansions and non-ASCII input.
- Fuzzy and fuzzy-prefix edit distance uses `levenshtein_automata`'s native Unicode-character
  semantics over the normalized surface term. Its DFA is constructed from Rust `char` values and
  compiled to consume the term dictionary's UTF-8 bytes without turning one multibyte scalar into
  several edits. The wrapper does not add byte-, UTF-16-, or grapheme-cluster distance. Shared
  non-ASCII edit and transposition fixtures are a mandatory Tantivy-upgrade compatibility gate.
- Ranked results use descending score with the encoded primary key ascending as the mandatory equal-
  score tie-breaker. The wrapper applies this order identically in native and Harper modes; callers
  cannot select a storage-order or nondeterministic alternative.
- The search request has no `minScore` or equivalent threshold. Scores support ordering and
  diagnostics within one captured index/ranking revision, not durable filtering.
- BM25 parameters are fixed at `k1 = 1.2` and `b = 0.75` and are absent from every public options
  object. A future effective-value change requires native Tantivy support, a new ranking revision,
  and relevance/pruning-correctness qualification. It reuses an existing generation only when the
  pinned Tantivy upgrade proves index-format compatibility; it is not inherently a rebuild trigger.
- Schema-defined source weights are the only field boosts. Search requests cannot override them or
  name ranking profiles. A weight-only schema change atomically replaces the immutable runtime
  ranking configuration and does not rebuild postings in native or Rocks mode; structural field
  changes still require a new generation.
- Structural field identity is a canonical order-independent name/type set. The wrapper assigns and
  reopens Tantivy fields by that canonical identity; array reordering does not rebuild. Harper keeps
  declaration order outside the wrapper solely for highlight-fragment ties.
- A string-array source is one repeated Tantivy field. BM25 term frequency and field length
  aggregate across non-null elements, while positions reset so a phrase cannot cross an element
  boundary. The wrapper adds neither best-element scoring nor per-element hidden documents.
- A projection that emits no searchable terms becomes a delete-only mutation and still completes
  its sequence/watermark position. No key/version-only Tantivy document is stored, and wrapper
  document-count status therefore reports searchable documents rather than source-record count.
- Term-all builds one required clause per analyzed term, with each clause matching across all
  schema-declared weighted fields. Required terms may occur in different fields of the same document;
  phrase queries remain confined to one field and one repeated value.
- An ordinary query term accumulates the weighted BM25 contribution from every field it matches.
  Only alternatives generated for one prefix or fuzzy input use strongest-clause scoring.
- Term-any, term-all, and fuzzy modes deduplicate analyzed query terms before scoring, clause
  accounting, and expansion. Prefix mode deduplicates completed terms but retains its final prefix
  clause; phrase mode preserves duplicate tokens and order.
- `analyzer` is a visible, versioned structural option. The first release accepts only `english@1`,
  uses it when the option is omitted, and rejects aliases, unversioned identifiers, and component-
  level analyzer settings. A different analyzer identifier always creates a new generation.
  `english@1` first rejects unpaired UTF-16 surrogates, then applies Unicode NFKC compatibility
  normalization and broad, bounded Latin-
  to-ASCII folding for both document and query analysis while preserving original Harper source text
  and highlight spelling. Between those steps it applies locale-independent full Unicode default
  case folding, including multi-character and script-specific folds such as `ß` to `ss` and
  consistent Greek sigma forms. Latin folding covers combining accents and common special letters
  such as `ø`, `ł`, `œ`, and `æ`; it emits only the folded term and does not transliterate non-Latin
  scripts. Full-width, ligature, and circled forms follow their compatibility equivalents. The
  analyzer carries original UTF-16 offset provenance across expansions and contractions. Its Unicode
  normalization, case-table, and Latin-folding-table versions participate in the structural
  fingerprint, and golden fixtures force a new analyzer version and generation if those tables
  change.
- Non-Latin text receives the same NFKC, Unicode case-folding, and Unicode word-segmentation stages,
  but bypasses Latin folding and English stemming and is not transliterated. The first release does
  not promise language-specific morphology or dictionary segmentation, so contiguous Chinese and
  Japanese text has documented recall limitations. Future language support uses explicit versioned
  analyzer identifiers such as `cjk@1`; the wrapper never selects an analyzer through automatic
  language detection inside one generation.
- English prose uses Tantivy's native `Stemmer::new(Language::English)` as one filter in the wrapper's
  explicit custom analyzer; it does not adopt Tantivy's complete `en_stem` default tokenizer or add a
  direct API path to the transitive Rust stemming crate. Tantivy and stemmer dependency versions are
  structural fingerprint inputs, golden fixtures pin every supported stem, and changed output
  requires a new analyzer identifier and generation.
- `english@1` recognizes product identifiers as typed analyzer output. An identifier such as
  `AB-123/XL` emits the normalized unstemmed whole token plus exact components `ab`, `123`, and `xl`;
  both paths bypass stop-word removal and stemming and are never fuzzy-expanded. Exact whole-
  identifier matches use the strongest native boost, while components support ordinary term and
  prefix discovery. A zero-tie disjunction-max group prevents whole/component double counting. The
  classifier, separator grammar, positions, and highlight provenance are versioned golden fixtures.
  Only `-`, `_`, and `/` join non-empty identifier components; period, colon, plus, hash, and every
  other punctuation character remain boundaries except for the inter-digit decimal and compact
  symbolic rules below. This set is fixed for `english@1`, not configurable, and any change requires
  a new analyzer version and generation. Classification is symmetric at index and query time: a
  joined unit is an identifier only when it contains a decimal digit, underscore, or slash. A hyphen
  alone is insufficient, so `state-of-the-art` and `ABC-XL` remain prose while `AB-123`, `ABC_XXL`,
  and `ABC/XL` use identifier analysis. The first release exposes no per-source override.
- Contiguous mixed letter/digit tokens are identifiers without requiring punctuation. The analyzer
  emits the normalized unstemmed whole plus components at each letter/digit transition: `RTX4090`
  emits `rtx4090`, `rtx`, and `4090`, while `128GB` emits `128gb`, `128`, and `gb`. The exact whole
  form receives the strongest boost through the same zero-tie disjunction-max construction, and the
  components permit a separated query to discover the joined source term. All forms bypass stop-word
  removal and stemming, are excluded from fuzzy expansion, and consume fixed term/clause budgets.
- Every identifier family emits a component only when its normalized form contains at least two
  Unicode scalar values. The whole term always survives: `X-1`, `5G`, and `A/B` emit no one-character
  components but remain searchable as exact whole identifiers. Index and query paths discard the same
  components before term/clause accounting. The minimum is fixed in `english@1` and golden-tested,
  with no schema override.
- A whole identifier and all of its components share one Tantivy position; the following lexical
  source unit advances once. Phrase construction uses the whole term when the query contains a joined
  identifier. Thus `"AB-123/XL case"` follows source adjacency, while separately typed
  `"AB 123 XL"` does not match components that co-occupy one position. Component conjunction remains
  available through `matches_all`. Golden fixtures pin positions and offsets; the wrapper adds no
  token-graph representation or separate positional stream.
- A separate narrow classifier preserves a compact alphanumeric name containing attached `+`, `#`,
  or `&` as a symbolic identifier. The whole always survives, while only alphanumeric components of
  at least two characters are emitted: `C++` emits only `c++`, `C#` only `c#`, `AT&T` emits `at&t`
  and `at`, and `R&D` only `r&d`, all at one position. Discarded one-character components consume no
  posting or clause budget. Whitespace ends the unit, symbol-only runs emit nothing, and period/colon
  remain boundaries. Whole and retained components bypass stop words/stemming, remain exact or
  bounded-prefix eligible, and never enter fuzzy or fuzzy-prefix automata. The rule is symmetric,
  versioned, bounded, golden-tested, and not source configurable.
- `english@1` retains an ASCII period directly between decimal digits as part of the numeric term.
  `12.5` emits only `12.5`, not weak alternatives `12` and `5`; mixed `12.5mm` emits the exact whole
  plus components `12.5` and `mm`. Period remains a token boundary in every other context. Index and
  query analysis use the same rule, and golden fixtures pin its term, position, and offset output.
- The analyzer and wrapper attach no measurement semantics to those terms. They do not embed unit
  aliases, convert values, or make `12in`, `12 inch`, and `30.48cm` equivalent. Applications may use
  the existing explicit synonym rules for lexical aliases; Harper composes quantitative constraints
  through structured attributes and its existing filters. The wrapper adds no unit table, conversion
  engine, or unit-specific scorer.
- `english@1` normalizes straight and Unicode curly apostrophes to one lexical form. It preserves an
  internal apostrophe in a contraction (`can't` stays one token) and removes a trailing English
  possessive `'s` before stemming (`women's` follows `women`). It must not emit contraction fragments
  such as `t` or conflate `can't` with `cant`. Analyzer output retains original-source offsets so
  highlights cover the complete visible token. Golden fixtures pin index/query symmetry and Unicode
  behavior.
- The fixed `english@1` stop-word list is enabled by default through the structural `stopWords`
  option. It is a local, Apache-2.0-compatible frozen copy of Apache Lucene
  [`EnglishAnalyzer.ENGLISH_STOP_WORDS_SET`](https://github.com/apache/lucene/blob/main/lucene/analysis/common/src/java/org/apache/lucene/analysis/en/EnglishAnalyzer.java):
  `a an and are as at be but by for if in into is it no not of on or such that the their then there`
  `these they this to was will with`. The 33 newline-delimited terms in that order have SHA-256
  `2f66c0e3dde5d31c7e919e2ed4d9d91390696480be361bfa143ca9ae0cb7ca13`; tests assert the literal set
  and hash, and repository licensing records its provenance. This creates no Lucene runtime
  dependency and does not track upstream changes. Disabling stop words preserves every otherwise
  valid token. Customers cannot edit the list in the first release, and changing the Boolean creates
  a new generation. A query leaf that produces no searchable terms compiles to match-none and does
  not enter the native search pool. A standalone query therefore returns an ordinary empty result;
  a supported Boolean parent applies normal match-none conjunction/disjunction semantics. The
  wrapper never converts it into an unfiltered query or retries under different analyzer behavior.
- Stop-word filtering preserves position increments in both document and query streams. For
  `state of the art`, `state` and `art` retain the removed terms' gap: the equivalently analyzed full
  phrase can match, while `state art` cannot claim false adjacency. Golden phrase fixtures pin the
  offsets and gaps. The rule is inert when positions are disabled, where phrase queries already fail
  their capability check.
- Invalidation that preserves Harper's indexed discoverability leaves the active full-text document
  unchanged so a match can trigger normal source rehydration. Actual cache eviction, delete, or loss
  of local searchable residency removes the document. Full-text sources are not retained separately
  in partial records.
- Retryable Blob unavailability preserves the preceding document and position only for the restart-
  stable, release-qualified blocking-gap budget. Expiry, or an immediately deterministic per-record extraction failure,
  enters observable record-level quarantine, removes the prior document, and advances progress; it
  does not force an endless full-generation rebuild. Structural cursor, source, retention, or index
  failures still fail the generation.
- A deterministic source-size/token-limit breach is quarantined immediately for that record version
  without truncation. Remaining valid sources are reindexed, progress advances, and a later valid
  version clears the source quarantine; Harper does not expose schema-level limit controls.
- An unpaired UTF-16 surrogate in any JavaScript string source produces an explicit record-level
  quarantine mutation: the writer deletes the prior document, indexes no sibling source for that
  version, advances progress, and clears the condition only on a later valid version or delete.
  Malformed query text returns `FULLTEXT_INVALID_REQUEST`; neither path performs lossy replacement.
- Harper keeps quarantine detail on operator status/metrics and out of hit payloads. Healthy-source
  matches continue normally, and one quarantined source cannot make the complete index unavailable.
- Full-text queries require a finite bounded result window. The package publishes and enforces one
  non-bypassable hard ceiling in both native and Harper modes; embedding callers may impose a lower
  ceiling but cannot raise it. The wrapper never invents an implicit page for an unbounded query.
- Harper exposes no customer read-your-write token or checkpoint wait. `Table.search()` and REST
  acquire the latest published searcher immediately; explicit wrapper synchronization remains for
  standalone callers and Harper/operator lifecycle code only.
- Harper adds no full-text-specific customer timeout. Its adapter derives one absolute deadline from
  the existing request and passes the existing cancellation signal; every native phase consumes the
  same budget. Standalone wrapper callers retain the low-level deadline and `AbortSignal` controls.
- Query deadline, cancellation, or work/resource-budget exhaustion returns no hit buffer. A
  successful underfilled page requires proven exhaustion; optional highlight tracing may separately
  return incomplete metadata without invalidating already valid hits.
- Exact full-text totals are unavailable in the first release. Estimated totals may use cached
  published-generation statistics only when they require no match-set traversal and are always
  marked inexact.
- Suggestion records use the same bounded search API and BM25 ordering as other records. Popularity,
  conversion, or other business fields may remain Harper record metadata and supported companion
  filters, but the wrapper accepts no business-signal ranking input or arbitrary post-sort. A future
  blend requires a separate normalized ranking contract; the initial API does not imply one.
- Neither backend caches full-text result sets or compiled customer query plans in the first release.
  Tantivy readers and the supplied storage backend own warm data reuse; applications may cache only
  complete authorized responses under their own freshness policy.
- The first release uses Harper's existing `offset` and `limit` with a benchmark-defined maximum
  offset shared by `Table.search()` and REST. The limit is release-owned rather than schema- or
  request-configurable. Larger offsets fail with `FULLTEXT_QUERY_LIMIT` before native execution;
  there is no customer continuation token or arbitrary deep-pagination path, and the internal
  cursor cannot be used to bypass the limit.
- Index-time synonyms are optional and default empty. The wrapper receives canonical, bounded rules,
  applies them through a custom Tantivy token filter only while indexing documents, fingerprints the
  exact rules, and requires a new generation for any change. Query-time synonym expansion is not
  part of the first release. Harper supplies rules declared inline in `@fullText`; the wrapper does
  not load synonym files, watch a registry, or query a synonym table. Rules are directional,
  reciprocal rules are valid, and expansion is one level rather than recursively traversing the
  rule graph. Each source and replacement is canonicalized through the complete base analyzer with
  synonym expansion disabled—including stop-word handling and stemming—and must yield exactly one
  final token; zero-token and multi-token rules fail validation. The filter matches after stemming
  and emits an already canonical replacement, so `laptop → computer` applies to an indexed
  `laptops` that shares the `laptop` stem. Emitted replacements never re-enter the matcher. Phrase
  synonyms require a later versioned token-graph contract and a rebuilt generation.
- Synonym-derived and literal terms share the ordinary Tantivy posting stream and have identical
  BM25 treatment in the same weighted source. There is no synonym penalty or configurable boost;
  implementing one would require duplicate companion postings or a custom scorer because Tantivy
  postings carry no per-token boost. Canonical no-op and duplicate replacement emissions at one
  source position collapse before indexing, while genuine occurrences at distinct positions retain
  normal term-frequency behavior.
- The positioned replacement is eligible for ordinary Tantivy phrase matching. For a
  `laptop → computer` rule, indexed `laptop bag` may satisfy phrase `computer bag` without a query-
  time rewrite or wrapper token graph. Match tracing maps that replacement back to the original
  `laptop` span and extends a multi-token phrase highlight through the final matched source token.
- When `surfaceTerms` is enabled, canonicalization also retains each synonym replacement's normalized
  pre-stem surface term and indexes it in the bounded surface stream with the originating source
  token's field, position, and highlight provenance. Prefix `compu`, fuzzy `computor`, autocomplete,
  and suggestion-record searches may therefore discover a document-side `laptop → computer`
  expansion. No invented replacement text is stored as Harper record source. The entry is omitted
  when surface terms are disabled, all synonym and expansion budgets still apply, and alternatives
  for one logical query term use the existing zero-tie disjunction-max scoring contract.
- The wrapper does not store record source text or token offsets for highlighting. Harper may opt a
  query into `$highlights` and sends only its materialized top-k source values through one bounded
  native `traceMatches` batch using the opaque plan returned by search. The wrapper applies the same
  analyzer, stemming, phrase, prefix, fuzzy, fuzzy-prefix, and index-time synonym logic as indexing/query
  construction and returns original-source spans; Harper does not duplicate this logic. Non-exact
  modes mark the complete original token, and phrases mark the continuous matched sequence. Harper
  returns structured plain-text fragments with source-attribute names and half-open UTF-16 code-unit
  match spans, never injected HTML. Highlighted queries are separately bounded and benchmarked, including
  Unicode and surrogate-pair fixtures. This keeps highlighting out of the Directory format and the
  standalone wrapper's record-ownership boundary. Harper chooses the strongest bounded fragments
  across all readable declared sources using match quality, field weight, and deterministic schema
  order; the wrapper adds no highlight-field selection API. Per-source eligibility is Harper
  metadata, defaults on for strings and off for Blobs, and never enters the native schema or
  generation fingerprint. A Blob participates only when its source declaration explicitly sets
  `highlight: true`. Highlight source failures or exhausted highlight budgets preserve valid hits
  and scores and set the record's `$highlights.complete` to `false`; detailed causes remain
  operator-only. The schema sets bounded `maxFragments` and `fragmentLength` presentation defaults;
  omission resolves to three fragments per record and 160 UTF-16 code units per fragment. They
  remain Harper search-only metadata and are not wrapper options or rebuild triggers.
- Product autocomplete uses bounded prefix search. Curated query suggestions are ordinary,
  customer-managed Harper records queried through the same full-text API; the wrapper adds no
  suggestion datastore, event collector, or separate suggestion query surface.
- Derived-index conditions participate in Harper's approximate-result detection even though their
  descriptors do not enter `Table.indices`; REST never presents a bounded candidate count as exact.
- The initial authorization boundary rejects record-filtered resources and full-text sources with
  attribute-level read restrictions because BM25 statistics and rank order are observable. Eligibility
  is derived from Harper's resolved per-request permission object rather than schema activation or a
  new cache, captured before asynchronous re-entry can clear a target-supplied restriction.
  `vectorFilter` plus full text is rejected until it can use the same bounded candidate-acquisition/exhaustion
  contract.
- Companion-filter materialization starts from one bounded candidate over-fetch pinned to one
  `Searcher`; it does not rerun progressively larger top-k queries. Shipping that path requires it
  to pass the supported filtered-query correctness and p99 gates. A failure makes an opaque native
  cursor over that same snapshot mandatory before release; a pass keeps the cursor out of the
  initial API. If required, the cursor is internal and request-scoped, is always closed with its
  owning query, and never becomes a `Table.search()` or REST continuation mechanism.
- Native handles are lazy and attributable. Rocks handles reuse DBDescriptor `OperationGuard` and
  `Closable`; native handles close independently.
- Harper creates one full-text CF per declared index in its existing RocksDB database and prefixes
  generations inside it. There is no second database or per-generation CF.
- Existing Harper durability and transaction-log purge accounting remain authoritative. Prove that
  derived publication cannot cause log truncation past durable authoritative records.

- Every Rocks publication stores a bounded adapter manifest of object IDs, lengths, and chunk counts
  and retains one prior manifest plus its objects. Open/reload validates the selected head with
  batched `MultiGet`; an incomplete current head rolls back to the valid prior checkpoint/watermark
  and catches up before resorting to a full rebuild.
- LMDB schema declarations fail during activation rather than producing a partially usable index.
- The package may ship both qualified binding modes; no Harper full-text release occurs before the
  RocksDB Directory qualifies.
- The canonical benchmark uses deterministic `small`, `typical`, `large`, and `heavy-tail` catalog
  tiers and reports each tier separately plus an explicitly weighted 100-million-record blend. The
  first manifest is provisional and stress-oriented; representative production measurements may
  recalibrate it only through a reviewed new workload cohort that preserves prior results.
- Benchmark execution is part of CI/CD: PR smoke is required, stable-host nightly and weekly runs
  enforce regression health, current-fingerprint 100-million paired evidence qualifies the adapter,
  and every Harper candidate runs the 100-million Rocks product workload as a hard release gate.
- GitHub is the benchmark publication authority. Each producing repository keeps reviewed manifests
  and baselines on its default branch, appends canonical summaries to its protected
  `benchmark-results` branch through the idempotent compare-and-swap publisher, and validates every
  branch update with an additions-only integrity check. No cross-repository write token is required.
- Pull-request diagnostics expire after 14 days, nightly diagnostics after 30 days, and weekly
  diagnostics after 90 days, subject to the repository limit. Canonical summaries are permanent
  history. Adapter qualification evidence is promoted immediately to a fingerprint/run-tagged
  immutable fulltext prerelease; Harper product evidence is attached to the matching Harper
  release. Large diagnostics never enter Git.
- The new GitHub Pages comparison dashboard is hosted from `HarperFast/fulltext`; Harper's existing
  `gh-pages` benchmark site is unchanged. Pages cannot write baselines or clear gates. By default it
  compares only compatible schema, workload, host, platform, build, and storage fingerprints and
  links every point to its workflow, commit, summary, and release asset.
- A hosted daily reconciler detects a scheduled job or publisher that never ran, creates or updates
  the fulltext-maintainer issue, and leaves a dated degraded marker on Pages. Missing evidence never
  becomes a successful or silently stale comparison.
- README, detailed developer documentation, executable native and Harper examples, compatibility and
  support policy, contribution guidance, security reporting, and release notes are release
  deliverables verified from packed artifacts.

## Decisions required before implementation

1. **Harper replay contract:** resolve exact committed positions, multi-log coverage, exclusive
   resume and retention-gap handling in the shared Harper protocol using the supported stack.
   Fulltext must not parse log formats or invent a native cursor ABI.

2. **Version ordering:** freeze the exact comparison key for duplicate and out-of-order delivery,
   including bitwise float64 versions, the transport-only role of node ID/tie-breaking, and deletes.
   Equal-version duplicate/conflict behavior is fixed: differing content never uses a tie-breaker and
   derived mode reconciles from Harper's authoritative record. Standalone mode, HNSW, and full text
   use the same in-window wrapper comparison. Standalone callers own assigning durable values and
   preventing old work from crossing a published checkpoint; Harper maps its accepted record metadata
   into the comparison and uses its watermark for the cross-commit frontier.
3. **Harper storage transport:** prove worker/view ownership, bounded handoff and shutdown,
   immutable Directory reads, atomic writes and durable publication through existing APIs.
   Choose write options and batching from evidence; no native rocksdb-js additions are assumed.

4. **Indexed-write gate:** fix the record-size distribution, field count, update mix, production
   concurrency, fraction of partial writes that do not touch indexed sources, acceptable post-commit
   projection/admission regression, and maximum publication lag used for qualification. Include a
   majority-PATCH workload, the expected local versus pre-encoded replication split, and the bounded
   source-resolution lane capacity/lag threshold.
5. **Native package ownership:** identify maintainers and the release approver for the Rust/npm
   package pair.
6. **Publication operating point:** choose the internal minimum commit interval, maximum unpublished
   age, affected-document and byte thresholds, stale/unavailable boundary, and global/per-database
   commit concurrency from the mixed workload so normal commit-to-searchable latency meets the fixed
   one-second p99 objective. These are not first-release schema options.
7. **Candidate-window calibration:** choose the bounded over-fetch factor and absolute candidate/byte
   limit by query class and result-window size. The first implementation uses one pass. If it cannot
   meet the supported filtered-query correctness and p99 gates, the opaque native cursor is required
   before release; this is not a later-release decision. Do not substitute repeated top-k calls or
   an underfilled success response. Its request-scoped, non-serializable, non-customer lifecycle is
   fixed rather than part of this calibration. Freeze the maximum public offset from the same
   workload; larger offsets are rejected before native execution and cannot fall through to the
   cursor.
8. **Benchmark workload calibration:** freeze the smoke document count, exact tier boundaries and
   provisional weights, term-frequency, query, mutation, concurrency, result-window, and index-count
   distributions used by all paired profiles. The four-tier deterministic structure and versioned-
   cohort recalibration policy are fixed; these numeric values must be recorded with the shareable
   seed/generator without customer data.
9. **Performance thresholds:** after measuring fixed-host variance, choose Rocks/native ratio,
   memory/storage amplification, indexed-write regression, publication lag, Rocks stall/flush,
   recovery, rebuild, autocomplete/suggestion limits, and package-hard result-window and
   field/document/batch byte ceilings. Record the full workload beside every threshold; the Harper Rocks p99 objective
   remains under 50 ms for the agreed product workload, with the provisional 20/20/10 deadline
   envelope frozen or deliberately revised before PR 3.
10. **Benchmark operations:** select the fixed performance host class, baseline-reset approvers, and
    per-tier wall-clock/durable-disk/temporary-space budgets. Extend the current repo-scoped JIT
    routing or provision equivalent capacity before requiring fulltext jobs. Confirm the GitHub
    organization policy permits the fixed 14/30/90-day temporary artifact retention and immutable
    releases. Confirm the fulltext maintainer team that owns reconciliation failures and its issue
    escalation policy. A changed host or environment fingerprint cannot silently become the old
    baseline.
11. **Health-watchdog calibration:** freeze the maximum critical-task detection interval and its
    publication-deadline relationship from fault-injection measurements. The host-owned stale-
    searcher duration, health-epoch transition rules, and fail-closed query behavior are fixed. A
    watermark cannot publish under an epoch captured before a detected failure.
12. **Harper coalescer calibration:** choose Harper's internal per-target byte/entry thresholds,
    next-turn scheduling primitive, and global retained-content charge from the production-
    concurrency write benchmark. Ownership and bounded shutdown drain/replay behavior are fixed in
    Harper runtime policy; these values are not wrapper or schema options.
13. **Restart availability:** set the maximum acceptable rebuild duration and minimum measured
    rebuild throughput for the 100-million-record workload. Durable Rocks generations are fixed for
    the Harper release; this Harper-owned product gate quantifies recovery capacity and prevents a
    future no-durable-state or wrapper-owned source-scanning shortcut from being accepted without
    operational evidence.

## Recommended PR sequence

1. Preserve the shipped scaffold and native backend; update their documentation and scope.
2. Prove the Harper-backed storage vertical slice through existing APIs: batching, threading,
   Directory semantics, durability, restart and lifecycle. Reuse the shared engine and tests.
3. Implement the shared Harper derived runtime and exact replay/retention/rebuild behavior, with
   HNSW or a test backend proving that the protocol is not fulltext-specific.
4. Complete the Harper-backed Directory and integration factory, generation lifecycle and
   multi-index resource accounting. No rocksdb-js native bridge is a dependency.
5. Complete schema, analysis/query capabilities, Table.search and REST integration in their owners.
6. Add comparable native/Harper benchmarks, profiling, GitHub history, CI gates and release evidence.
7. Qualify crash recovery, replication, backup/restore, scale, package contents and developer docs.

Native package releases may proceed independently. Harper fulltext remains gated on its actual
RocksDB storage, shared recovery protocol and product performance. The experimental rocksdb-js
branch remains unmerged and is not a release dependency.

## References

- [Derived-index delivery protocol (DerivedIndexBackend): shared post-commit delivery, watermark/replay, and blob-content contract for HNSW and full-text indexes #2489](https://github.com/HarperFast/harper/issues/2489)
- [Native HNSW traversal plane: mmap graph file, off-event-loop search, opt-in dual-write (phase 1) #2430](https://github.com/HarperFast/harper/pull/2430)
- [Enable compression for file-backed blobs (opt-in, per-content-type), and stream-inflate on read #2443](https://github.com/HarperFast/harper/issues/2443)
- [HNSW N-API surface](https://github.com/HarperFast/hnsw/blob/main/src/napi.rs)
- [HNSW platform loader](https://github.com/HarperFast/hnsw/blob/main/index.js)
- [HNSW native package workflow](https://github.com/HarperFast/hnsw/blob/main/.github/workflows/publish.yml)
- [Symphony TypeScript façade](https://github.com/HarperFast/symphony/blob/main/ts/proxy.ts)
- [Symphony package configuration](https://github.com/HarperFast/symphony/blob/main/package.json)
- [Symphony CI matrix and Harper integration](https://github.com/HarperFast/symphony/blob/main/.github/workflows/CI.yml)
- [Symphony native release workflow](https://github.com/HarperFast/symphony/blob/main/.github/workflows/release.yml)
- [Tantivy 0.26.1 `IndexWriter`](https://docs.rs/tantivy/0.26.1/tantivy/indexer/struct.IndexWriter.html)
- [Tantivy 0.26.1 `IndexWriter` implementation and resource defaults](https://docs.rs/tantivy/0.26.1/src/tantivy/indexer/index_writer.rs.html)
- [Tantivy 0.26.1 `Directory`](https://docs.rs/tantivy/0.26.1/tantivy/directory/trait.Directory.html)
- [Tantivy 0.26.1 `MmapDirectory`](https://docs.rs/tantivy/0.26.1/tantivy/directory/struct.MmapDirectory.html)
- [Tantivy 0.26.1 `ManagedDirectory`](https://docs.rs/tantivy/0.26.1/tantivy/directory/struct.ManagedDirectory.html)
- [Tantivy 0.26.1 query implementations](https://docs.rs/tantivy/0.26.1/tantivy/query/index.html)
- [Tantivy 0.26.1 BM25 implementation](https://docs.rs/tantivy/0.26.1/src/tantivy/query/bm25.rs.html)
- [Tantivy configurable-BM25 discussion and block-max implications](https://github.com/quickwit-oss/tantivy/issues/2924)
- [Tantivy 0.26.1 `DisjunctionMaxQuery`](https://docs.rs/tantivy/0.26.1/tantivy/query/struct.DisjunctionMaxQuery.html)
- [Tantivy 0.26.1 reload policy](https://docs.rs/tantivy/0.26.1/tantivy/enum.ReloadPolicy.html)
- [RocksDB column families and cross-CF atomic writes](https://github.com/facebook/rocksdb/wiki/Column-Families)
- [RocksDB WAL behavior](https://github.com/facebook/rocksdb/wiki/Write-Ahead-Log-%28WAL%29)
- [RocksDB `WriteBatch`, `MultiGet`, and `PinnableSlice`](https://github.com/facebook/rocksdb/wiki/Basic-Operations)
- [RocksDB atomic flush](https://github.com/facebook/rocksdb/wiki/Atomic-flush)
- [napi-rs package and platform-package structure](https://napi.rs/docs/introduction/simple-package)
- [napi-rs async and concurrency guidance](https://napi.rs/docs/more/examples)
- [GitHub Actions artifact and log retention](https://docs.github.com/en/organizations/managing-organization-settings/configuring-the-retention-period-for-github-actions-artifacts-and-logs-in-your-organization)
- [GitHub Pages custom Actions workflows](https://docs.github.com/en/pages/getting-started-with-github-pages/using-custom-workflows-with-github-pages)
- [GitHub release management](https://docs.github.com/en/repositories/releasing-projects-on-github/managing-releases-in-a-repository?tool=cli)
