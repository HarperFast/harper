# Record-lock successor freshness implementation

Implementation note for harper#2542. The protocol and public guarantee are specified in §§7–8 and
§10 of `record-lock-ownership.md`; this note records the implementation boundary and alternatives.

The stale-read hazard appears when a successor receives a clean grant while one or more predecessor
writes are still queued in its inbound replication streams. The home coordinator owns the
delegation lineage, so it owns this invariant:

> Before a successor delegation can admit, its node has applied and made visible every origin-log
> position inherited from all prior clean holders of the key; when that lineage is unavailable, it
> must complete the explicitly weaker recovery barrier or fail closed.

## Chosen implementation

Core carries a bounded `origin node name -> transaction-log position` dependency set on each held
delegation. Clean release serializes the inherited set; when the home applies that release, it merges
the release author's own audit-entry position into the set. That position is ordered after every
write the holder completed before releasing and, unlike a holder-write timestamp, is necessarily at
the head of the author's stream when committed. The home retains the merged set after clearing the
grant and returns it with the next grant. Before installing that grant, the requester asks the
transport to make every named position applied and visible. Rejection, malformed or unsatisfiable
dependencies, and timeout all hand the unclaimed grant back without discarding known lineage and
fail the lock with 503.

The home retains dependency sets independently of live grants, with a larger bounded LRU. A fixed
add-only Bloom filter records every key delegated in the current generation. Absence means virgin
only when the coordinator has observed the entire generation continuously; cold construction,
coordination loss, and generation change saturate that assumption so every unremembered key takes
recovery. A continuously observed key absent from the filter needs no barrier; a key present with no
retained set (expiry or LRU eviction) receives the recovery marker. The transport resolves that
marker by preferring a retained durable release when available, otherwise draining every reachable
member to captured positions. It must coalesce concurrent recovery snapshots across keys, and it
returns the established positions so the delegation can carry them onward. Bloom false positives
only select the slower safe path; there are no false negatives while absence is trusted.

The release wire format becomes a versioned tuple with a leading version and trailing dependency
set. The decoder still accepts the exact historical five-tuple as a release with unknown lineage;
an old or malformed entry can clear only the exact live fencing token and forces recovery on the
next grant. Unknown future versions are ignored.

No ordinary or locked-write commit path changes. A cached delegation already passed its barrier and
continues to admit locally without a transport call or dependency allocation. Puts, patches, and
tombstone deletes are all covered because the release position follows the entire critical section,
not because each mutation shape needs its own hook.

## Approaches considered

| Axis                | Candidate                                                                                                                                                 | Ruling                                                                                                                                                                                                                                                                                                                                                   |
| ------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Different layer** | Put all lineage and freshness state in harper-pro's replication transport.                                                                                | Rejected: core alone owns delegation grant/release lineage and the exact-token rule. Moving the per-key state outward would duplicate that state and permit coordinator and transport to disagree about which release advanced a key. The transport does own the stream-specific apply-visible wait, so the chosen boundary exposes only that operation. |
| **Deeper cause**    | Use only the immediate predecessor's replicated release entry as the freshness fence.                                                                     | Rejected: release ordering covers only the releasing node's own stream. In `A writes -> B inherits but does not write -> C`, observing B's release says nothing about whether C has applied A's write; the release position must be merged into an inherited transitive set.                                                                             |
| **Do less**         | Carry one scalar record version or wait only for the immediate predecessor.                                                                               | Rejected: record resolution versions are not origin-log positions, equal timestamps from different origins do not identify stream progress, and a dependent patch can require more than the winning record version. Immediate-predecessor waiting also fails the no-write B handoff above.                                                               |
| **Chosen**          | Core-owned inherited dependency sets, advanced by the trusted release-entry position, plus transport-owned apply-visible and coalesced recovery barriers. | This keeps delegation lineage in its owner, expresses progress in coordinates replication can actually wait on, preserves transitivity, leaves cached acquisitions and all commit paths unchanged, and avoids holder timestamps that may sort behind an already-advanced replication cursor.                                                             |

The release-entry position replaces an earlier per-write commit-hook design. It removes a hot-path
callback, covers every write that remains authorized when the release is committed, and cannot sort
behind a replication cursor that has already advanced. Cold-state trust is discarded whenever
history may have been missed, and pending grants remain recallable before admission.

## Applied-prefix holes

An origin's committed `lockBarrier` proves its preceding prefix only up to holes reported to the
transport. A later barrier cannot turn a terminally failed and skipped replicated transaction
into an applied write. Core's `registerReplicatedApplyFailureListener(database, listener)` reports
the failed audit-header origin `nodeId` and origin transaction-log `position`, and awaits every
registered listener before pulling another event (or staging the new `beginTxn` that closed the
failed transaction). The transport must durably record that discontinuity before its listener
resolves and reject freshness proofs crossing it until its own recovery rule clears the hole.
Registration is per apply worker; listener failures remain log-and-continue, so the transport
also owns failing closed when it cannot persist hole state. Core supplies the observation and
ordering hook; durable poison records and their clearing policy belong to the transport.
