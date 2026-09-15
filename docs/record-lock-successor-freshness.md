# Record-lock successor freshness implementation

Implementation note for harper#2542. The protocol and public guarantee are already specified in
§§7–8 and §10 of `record-lock-ownership.md`; this note records the current-main investigation and
the implementation boundary used to add that missing half of Phase 1.

## Investigation checkpoint

Base: `origin/main` at `ce78a2232` (fetched 2026-09-14). Recent history for the coordinator,
transaction, lock handle, and table paths contains harper#2498 (`4c353f880`), which deliberately
landed exclusion before freshness; no later core fix exists. The companion harper-pro#822 is still
open and explicitly lists successor freshness as missing.

Current-main reaches the production handoff path, but does not establish freshness:

- `LockCoordinator.acquire()` installs and admits a granted delegation immediately after checking
  its token and lease (`resources/recordLockCoordinator.ts:815-829`). `DelegationReply` has no
  dependency field and `ClusterLockTransport` has no apply-visible barrier (`:170-256`).
- A clean release encodes only `[key, requester, generation, homeIncarnation, counter]`
  (`:268-270`), and `applyEntry()` clears the matching grant without retaining write positions
  (`:928-963`). The existing handoff test therefore passes without invoking any freshness boundary:
  `npx mocha unitTests/resources/recordLockCoordinator.test.js --grep "hands the key over"`.
- `Table` already receives a release event with both its trusted origin and transaction-log position
  (`resources/Table.ts:979-1007`), but the coordinator callback discards that position.

The bad state is produced when a successor receives a clean grant while one or more predecessor
writes are still queued in its inbound replication streams. The home coordinator owns the
delegation lineage, so it owns this invariant:

> Before a successor delegation can admit, its node has applied and made visible every origin-log
> position inherited from all prior clean holders of the key; when that lineage is unavailable, it
> must complete the explicitly weaker recovery barrier or fail closed.

The regression tests will exercise the same `acquire()` → transport barrier → admission boundary as
production, including transitive handoff and barrier rejection. A resource-layer test will pass a
real release through the table apply boundary and prove that its audit-entry position becomes the
next grant's dependency. Those tests must fail against the base commit because the reply contains no
dependency set, the apply callback drops the position, and admission never waits.

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

## Verification route

Unit coverage exercises versioned/legacy payloads, cached acquisition, direct and transitive clean
handoffs, equal-position origins, malformed or unsatisfiable dependencies, recovery after cold,
expired, or generation-changed lineage, recalls before and during a pending barrier, and
lineage-preserving grant handback. A resource-layer integration-style unit test passes a release
through `Table`'s real audit apply boundary and proves its origin-log position reaches the
coordinator. The apply-visible implementation remains in harper-pro, so its multi-process
clean-handoff and recovery tests are the end-to-end enablement gate. The repository's build, resource
unit gate, main unit gate, integration gate, lint, and format checks remain the final validation.
