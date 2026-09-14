# Shared derived-index coordination for HNSW and full text

## Purpose

The target native HNSW plane and Tantivy maintain non-transactional, node-local indexes derived from
authoritative Harper records. Their physical formats, write mechanics, and query semantics differ,
but mutation delivery, recovery, rebuild boundaries, retention, and operational state should use one
Harper protocol. Current in-tree HNSW is different: it updates its object-store graph synchronously
from `updateIndices()` and receives the enclosing Rocks transaction when one exists. This protocol is
the intended convergence point for the native HNSW work, not a description of that current write
path.

This document extracts that shared protocol. It is based on
[`Derived-index delivery protocol (DerivedIndexBackend): shared post-commit delivery, watermark/replay, and blob-content contract for HNSW and full-text indexes`](https://github.com/HarperFast/harper/issues/2489).
Full text implements the protocol first. Draft HNSW PR
[`Native HNSW traversal plane: mmap graph file, off-event-loop search, opt-in dual-write (phase 1)`](https://github.com/HarperFast/harper/pull/2430)
can adopt it in a later phase; this document does not describe that draft as current Harper behavior.

The September 4, 2026 source pass used Harper `9f469c079a` and rocksdb-js `7ab102ca3e`
(package 2.8.0). Current Harper still invokes HNSW custom-index mutation synchronously from
`updateIndices()` in the table write path and derives replicated records locally. Current
rocksdb-js transaction-log queries expose timestamp/end-of-transaction data but not the exact opaque
committed position required below. Everything described as the shared runtime, cursor, watermark,
retention reservation, or post-commit derived delivery is proposed work from issue #2489, not an
existing runtime contract.

## Core invariant

For every committed source mutation relevant to a derived index, one of these statements is true:

- the active derived generation has durably applied it and published an opaque contiguous log
  watermark covering it; or
- the mutation remains recoverable from Harper's retained transaction log.

If the required log position is no longer retained, the generation becomes `NEEDS_REBUILD`. Harper
never skips an unresolved gap. During replay it may resolve a logged record identity against the
current authoritative record, but the position completes only after the backend has applied or
version-suppressed that authoritative state.

## Storage boundary

Fulltext will use Harper RocksDB exclusively through supported storage APIs. The derived protocol
coordinates source delivery, replay and rebuild; it is not a Tantivy byte-storage provider. No base
rocksdb-js native-lease addition is required by fulltext. The bounded storage transport and publication
proof are specified in [Tantivy storage through Harper](./tantivy-rocksdb-directory-design.md).
HNSW retains its own engine/storage implementation; sharing delivery does not require sharing files,
writer topology or a new native storage ABI. Exact replay support remains a Harper-owned protocol
prerequisite and must not be represented as already implemented.

## Architecture

```text
write-capable Harper worker
  resolve winning record mutation
  capture interested-index projection
              │
              ▼
authoritative record + existing transaction-log entry commit atomically
              │
              ▼ same worker, aftercommit; enqueue and return
     shared DerivedIndexRuntime
       ├── HNSW backend
       └── full-text backend ─► process-global Tantivy writer generation
              │
              ▼
backend durability barrier + opaque contiguous watermark publication
              │
              ▼
reader/searcher activation, status, retention release, rebuild lifecycle

restart / admission deferral / retryable content gap
              │
              └── exact transaction-log replay from last durable watermark
```

The transaction log is the only per-record recovery fact. The protocol adds no dirty-marker column
family, `GetForUpdate` control row, rotating marker epoch, second transaction log, or marker-range
reclamation path.

## Ownership

| Concern                            | Owner                                      |
| ---------------------------------- | ------------------------------------------ |
| Source record and accepted version | Harper table and primary store             |
| Durable mutation fact              | Existing Harper/rocksdb-js transaction log |
| Position encoding and comparison   | rocksdb-js; opaque to backends             |
| Log-retention policy               | Harper                                     |
| Retention representation/purge     | rocksdb-js                                 |
| Delivery, replay, and rebuild      | Shared Harper derived-index runtime        |
| Projection and source dependency   | Originating Harper worker                  |
| Apply and durability barrier       | Engine backend                             |
| Engine format and search           | HNSW or full-text implementation           |
| Desired schema and generation      | Harper attribute lifecycle                 |

The shared runtime attaches once to Harper's existing same-thread `aftercommit` path and isolates
each backend. A backend failure cannot prevent other commit listeners or derived backends from
receiving the committed entry.

## Delivery contract

The winning transaction attempt associates its in-memory final record projection with the log entry.
After the durable commit, the same worker sends the entry to every interested backend. Local writes,
replication applies, deletes, invalidations, and other logged lifecycle mutations use this path.

Current Harper TTL expiration and cache eviction deliberately bypass the transaction log. Harper
must add a derived-only `EVICT` control entry using the existing log format's next reserved action
code (`9`) and `LOCAL_ONLY` flag when a table has derived-index interest. Current record actions end
at `RELOAD = 8`; other numeric constants in `auditStore.ts` that use 11, 14, or 15 belong to key/value
encoding and do not make those values active `EVENT_TYPES`. On RocksDB, the local eviction and
control entry commit in the same raw transaction; the entry is excluded from replication and
customer audit/subscription output but participates in derived-consumer retention. LMDB remains out
of scope for full text. This is a Harper hook, not a wrapper-owned queue or second log.

```ts
type LogPosition = Uint8Array;
type LogWatermark = Uint8Array;

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

interface RebuildContext {
	boundary: LogWatermark;
	copyId?: Uint8Array;
	copyCursor?: Uint8Array;
}

interface DerivedIndexBackend {
	readonly needsPreviousValue: boolean;
	deliver(entries: CommittedEntry[]): DeliveryOutcome;
	getWatermark(): LogWatermark | undefined;
	status(): DerivedIndexStatus;
	close(options: DerivedCloseOptions): Promise<void>;
	beginRebuild(context: RebuildContext): RebuildHandle;
}
```

`deliver()` is bounded, synchronous, nonthrowing at the protocol boundary, and never waits for the
engine pipeline. Its exhaustive result is `{ status: 'accepted' }` or
`{ status: 'deferred', reason: 'busy' | 'source-required' | 'closed' | 'failed' }`. `deferred`
retains no projected content; replay resolves the log entry later under a reserved recovery budget.
Retryable Blob unavailability is `deferred` with reason `source-required`.

This document is normative for the shared interface. `CommittedEntry` includes record mutations and
logged base-copy/reload control entries. `RebuildContext` contains the opaque boundary plus scan and
base-copy identity; `beginRebuild()` returns the backend-specific private-generation handle. The
full-text documents reference this interface rather than defining narrower variants.

Projection happens on the originating worker because it already owns the conflict-resolved record
and schema. The engine receives one packed batch rather than rereading or re-decoding records through
worker 0. A source-dependency mask may prove that a partial update cannot affect an index. That entry
still completes its position as a no-op so the watermark does not stall.

## Watermark, ordering, and replay

Harper's shared protocol must supply exact committed positions, multi-log coverage and gap-detecting resume. Verify how the supported stack provides those guarantees before freezing backend APIs. This plan does not require an addon-to-addon cursor table or native storage lease. Backend progress is opaque, and a missing position or retention gap triggers rebuild rather than approximate checkpoint advancement.

Backends may complete work out of order, but publication advances only through the highest contiguous
completed prefix. A gap caused by deferral, pending Blob replication, or authoritative version repair
holds the watermark. Later work may remain in bounded staging; it cannot bridge the gap.

Retained-log replay treats the log body as a hint, not projection authority. For every record entry,
Harper resolves the current authoritative record and version: it applies that record, applies a
delete when the record is absent/nonresident, or suppresses the entry when a newer version is already
represented. This is required because a RocksDB transaction retry can durably retain the first
attempt's log body while the winning attempt stores different content. Hot same-thread delivery still
uses the winning in-memory projection and performs no point read.

Derived mutations are idempotent by canonical record identity and version. An older version is
ignored. Equal-version, equal-content operations are duplicates. Equal-version but different content
does not use arrival order or node ID as a winner: Harper repairs from the authoritative record or
rebuilds if the state cannot be proven.

## Writer topology is engine-specific

The protocol does not require one common writer topology:

- HNSW may apply locally when its native data structure safely supports concurrent mutation.
- Tantivy uses one process-global `IndexWriter` per storage identity, logical index, and generation.
  Every Harper worker may enqueue directly through bounded native shards. Tantivy's shared writer
  operations and indexing workers provide parallel ingestion; only prepare/commit/publication is
  exclusive per index.

“One Tantivy writer” does not mean one writer for the process, database, node, or cluster. Separate
indexes, generations, databases, and replicas progress independently within shared process and
RocksDB resource budgets. No Harper JavaScript worker is the global write owner.

## Replication

Harper replicates authoritative record mutations, not derived index bytes or watermarks. The replica
accepts the record into its own store and log, then its committing worker delivers locally.

```text
source node                                  replica node
───────────                                  ────────────
commit record + source log entry
     │
     ├── derive locally
     │
     └── replicate record mutation ───────► commit record + replica log entry
                                                   │
                                                   └── derive locally
```

Each node publishes its own backend watermark and may briefly return a different derived snapshot.
Nodes converge from their local authoritative records and logs. There is no derived-file replication
protocol and no cross-node BM25 normalization.

## Rebuild protocol

Rebuilds are backend-specific but use one boundary mechanism:

1. Harper records the current opaque log boundary and durably marks a private generation `BUILDING`.
2. Harper scans authoritative records in bounded primary-key chunks into that generation.
3. Normal delivery continues to the active generation, and the transaction log retains concurrent
   mutations after the boundary.
4. The runtime replays from the boundary into the private generation until its contiguous watermark
   reaches the current log head.
5. Harper validates and atomically activates the new generation; the old compatible generation may
   continue serving until that swap.

The wrapper does not scan Harper records, choose a source, or activate schema. Harper's existing
attribute lifecycle remains the authority for build ownership, progress, failure, and generation
selection.

## Blob content

Backends read Blob content through Harper's Blob ownership boundary, never by treating raw stored
bytes as text. A locally written Blob is complete before commit; a replicated Blob may still be in
flight when the record commits. In that case delivery returns `deferred/source-required` and may hold
the position only inside the release-qualified blocking-gap budget. Before one record can exhaust the
staging budget or violate the freshness envelope, Harper publishes the existing record-level
quarantine outcome and advances the position. A later valid record version or explicit rebuild repairs
the quarantined document. The former 24-hour blocking window is not used: without a durable
out-of-order ledger it would allow one Blob to stop publication for the whole index. Rebuild uses
Harper's existing authoritative source/refetch path; the protocol does not introduce attribute-level
caching or a second Blob store.

## Failure and retention behavior

- Crash after record commit but before delivery: replay from the last published watermark.
- Queue saturation: `deferred`, followed by replay; the source commit is not blocked.
- Engine failure after uncertain partial apply: poison the generation, publish no newer watermark,
  reopen from the last durable backend commit, and replay.
- Watermark behind retention: `NEEDS_REBUILD`; never skip.
- Corrupt or incompatible generation: fail closed and rebuild from records.
- Environment exit: release environment-local handles; do not close a process-global writer still in
  use.
- Process shutdown: bounded drain and publication within Harper's existing deadline, otherwise safe
  rollback and later replay.

## Required Harper integration work

- Add the versioned `DerivedIndexBackend` and shared runtime in Harper core.
- Carry the winning final projection into the same-thread post-commit dispatch.
- Add the local-only derived eviction/TTL control entry and commit it atomically with RocksDB cache
  removal when a table has derived interest.
- Resolve record bodies from the authoritative table during retained-log replay; do not project stale
  first-attempt audit bodies after transaction retry.
- Resolve committed positions, exact resume and retention-gap behavior in Harper's shared protocol
  using the supported stack. These are integration proof obligations, separate from byte storage.
- Keep retention and recovery policy with Harper and use existing log/storage operations.

- Integrate scan-plus-log rebuild with Harper's existing attribute lifecycle.
- Implement a fake backend against the real commit/replay path before freezing the native full-text
  factory.

## Acceptance criteria

- A forced crash between record commit and backend apply converges through exact replay.
- A position older than retained history triggers rebuild and never a silent skip.
- Multi-worker record writes do not increase worker 0 event-loop delay in proportion to other
  workers' commits. Harper's existing expiration sweep may remain worker-0-owned, but each eviction
  performs only its bounded local transaction and derived-log append there.
- Replication applies use the same local post-commit path and converge without derived-byte transfer.
- Source-unchanged entries complete as no-ops; deletes, TTL, eviction, and invalidation follow their
  documented lifecycle semantics.
- Pending replicated Blob content holds the watermark only within the blocking-gap budget, then
  reaches an observable quarantine outcome without making the whole index unavailable.
- Out-of-order completion never advances past a gap.
- HNSW and full-text test backends pass the same delivery/replay/retention/rebuild contract suite
  without sharing physical storage or search APIs.
