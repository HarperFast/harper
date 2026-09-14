# Cluster record locks, Phase 1 (revised): amortized per-record ownership

Design note for harper#2498 / harper-pro#822 (Phase 1 of harper#483). It replaces the
Ricart–Agrawala arbitration rule that branch currently implements. Phase 0 (harper#2462) is
unchanged and remains the local primitive everything here builds on.

Planning-review history, because two of its findings changed the design rather than annotating it:

| round              | verdict                     | what it changed                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| ------------------ | --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1 (`453905f0de82`) | `chosen-approach-sound`     | Shape cleared. Five blockers against under-specification: epoch protocol, lease transfer, drain, freshness fence, the LWW claim. §§4–8 exist to close them.                                                                                                                                                                                                                                                                                                                                                                                                               |
| 2 (`4b9648dbab5f`) | `better-alternative-exists` | **Adopted, then superseded by round 7.** My stateless epoch agreement forks; durable agreement state was the better alternative, and its counterexample survives in §4.2 as the reason not to automate rehoming cheaply. Three repairs from that round stand: drain must revoke live handles (§6), the freshness fence is a dependency set not a scalar version (§7.1), and the fencing token must be orderable (§5.1).                                                                                                                                                   |
| 3 (`0a3f817ca56e`) | `chosen-approach-sound`     | Framing clears. Surviving findings were protocol-level and are folded in — see §14 for the map and for what still blocks implementation.                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| 10 (`b01ab54d5`)   | `better-alternative-exists` | **Adopted.** A quiescence acknowledgement does not survive the acknowledger's restart, so activation on a stale one lets a restarted node serve the old generation forever. §4.3 binds acknowledgements to `homeIncarnation` and gathers the transition into one durable, one-shot activation record. Distinct from §9's rejected renewable capabilities, which are the continuous form.                                                                                                                                                                                  |
| 8 (`3a4be9f19`)    | `better-alternative-exists` | **Gap adopted, alternative overruled.** Publishing `g+1` does not revoke a live `g`: a partitioned node keeps serving its own consistent copy, and a digest check cannot see staleness. §4.3 is now stage → acknowledge-or-fence → drain → activate, §4.1 says a digest is not a freshness check, the generation is monotonic per node, and the routing hash is versioned by the protocol capability rather than the generation. Its **leased** generation capabilities are in §9, overruled because they make locking depend on continuously reaching the control plane. |
| 7 (`14c1b5510`)    | `better-alternative-exists` | **Adopted, 2026-09-13.** The membership epoch was a consensus protocol built to _infer_ what an operator can simply state: whether an unreachable node is briefly down or permanently gone. §4 is now an **operator-agreed, immutable home map** and the whole agreement protocol — durable acceptor state, ballots, renewal leases, retirement reservations, transitive activation — is **deleted, not deferred**. §9 records the epoch protocol as the rejected alternative it now is.                                                                                  |

## 1. The problem with what is on the branch

`table.lock(id)` on the branch runs Ricart–Agrawala: the requester writes `LOCK_REQUEST` and waits
for a `LOCK_GRANT` from **every** participant (`resources/recordLockCoordinator.ts:619`). Core sets
`agreedDown` for nobody, so nothing is ever excluded from that set, and harper-pro#822 states the
consequence in its own limitations list: a crashed peer blocks new cluster locks for its databases
until it leaves `hdb_nodes`. Unanimity is not a high-availability protocol.

Two costs follow from the same rule. Every acquisition is `P+1` durable commits and up to `P²−1`
frame deliveries for `P` participants (each participant's grant is a transaction-log entry
replicated to every subscriber), and every acquisition pays a full network round even when the same
node locked the same key a millisecond ago. `P=12` — a size we run today — is 13 commits and 143
deliveries **per lock**.

## 2. The invariants

**Only the first of these two ships in Phase 1**, and the second is narrowed rather than met. They
are stated together because they are what the design is _aimed_ at and what the deferred arms would
close; §10 is the normative wording for what `lock()` actually promises, and it is the text to read
before writing anything user-facing.

> **Exclusive admission.** At most one node may admit a critical section for
> `(database, table, key)` at any instant. Successor authority must exclude every predecessor
> _capability_ that can still admit or commit — not merely every predecessor handle.
>
> **Successor freshness.** A node admitted after a predecessor has applied the predecessor's
> committed writes to that key before it admits.

Freshness holds unconditionally on the clean-handoff path (§7.1). It is **explicitly narrowed on the
recovery path** (§7.2): a barrier over reachable members cannot observe a write the crashed
predecessor committed but never replicated, so the invariant as written is a promise this design
cannot keep in recovery mode for free.

**That narrowing is the shipping guarantee.** The §10 decision is **exclusion-only** (§7.3 (b)):
`lock()` promises exclusive _admission_, and successor freshness after a clean handoff _while the
home still holds that handoff's dependency set_ — a home restart, home-map change or cap eviction routes
the successor to the recovery barrier even after a clean release. It promises
neither conflict-ordering fences nor quorum-confirmed settlement, so the exclusion invariant above
ships narrower than it is written on two counts — the commit half holds only up to the
pre-submission expiry fence, and a predecessor's write can still outrank its successor's under LWW.
§10 states exactly what is and is not promised and is the normative wording; the two arms that would
close the rest are deferred to harper#2540, not rejected. Where the sections below describe fenced or
quorum-confirmed mode, they are describing that issue's scope, not this one's.

They are separate, and expiry establishes neither on its own. Phase 0 enforces part of the first:
expiry is checked synchronously on every staged write and again immediately before the native commit
submits (`resources/DatabaseTransaction.ts:1213`). That fence is reused unchanged — only the thing
that issues the lease changes — but it neither settles an already-submitted commit nor makes an
asynchronous replica fresh, which is what §6 and §7 are for.

## 3. Structure

Three levels, at three very different rates.

**Level 1 — the home map (rare, operator-agreed, immutable).** Per database, a map
`(generation, homes[])`, published by the operator through harper-pro and never derived from
liveness. It is immutable for the life of its generation: nothing a node observes — an unreachable
peer, a restart, a partition — changes it. Consensus does not appear at this level at all; agreement
is that every node holds the same generation, checked by digest before the feature is enabled (§4).
A node that cannot obtain the current map stops acting.

**Level 2 — the home node (derived, free).** Within a generation the arbiter for a key is a
rendezvous hash over `homes[]` (§4.4). A single arbiter per key is trivially exclusive, which removes
the entire grant state machine — no deferral queues, no `(tsR, nodeName)` tiebreak, no synthesized
grants, no split votes, no `INQUIRE`/revocation protocol.

**Level 3 — the delegation (the amortization).** A node that wants to lock `K` asks `K`'s home node
for a _delegation_: the exclusive right to admit critical sections on `K`, for a bounded time. With
a live delegation, `lock()`/`unlock()` are pure Phase 0 — the local rocksdb key lock, no cluster
message. Releasing the application lock does **not** release the delegation. So a node writing the
same record repeatedly pays one round, then nothing, and the delegate is in practice the last writer.

```
first lock on K from node B            steady state (B keeps locking K)      C wants K
  B → home(K): DELEGATE(K)               B: local key lock only                C → home(K): DELEGATE(K)
  home → B:    GRANTED(K, tok, until)    (zero cluster messages)               home → B: RECALL(K, tok)
  B: local key lock, run                                                       B: drain (§6), RELEASE entry
                                                                               home → C: GRANTED(K, tok+1, …)
```

Delegations are **volatile**; the home map is **durable, and written by an operator**. That split is
the design: the only durable, agreed state changes at the rate an administrator reshapes the cluster,
never on an acquisition and never on an ordinary write.

## 4. The home map

harper-pro owns this, because it owns topology. The map is **operator-agreed and immutable per
generation**: an administrator publishes it through harper-pro, and no node ever derives, proposes or
advances one from what it observes.

### 4.1 What core consumes

Per database, `(generation, homes[])`:

- `generation` is a monotonic number. It is the high-order component of the fencing token (§5.1), so
  it must never go backwards, and a delegation minted under one generation is not honoured under
  another.
- `homes[]` is the set of node names that may home a key. It is a **lock-home map, not a residency
  directive** — it says who arbitrates a key, not where the record lives, and it is not derived from
  `hdb_nodes`, which is LWW-replicated and therefore not agreed.

Core fails closed when no map is available and never guesses a ring. `homeIncarnation` (§5.1) rides
alongside as the one remaining durable per-node datum: a monotonic counter persisted by harper-pro
with the node's own identity, and advanced once per **coordination incarnation** — §5.1 states the
rule, and it is not once per process.

**Agreement is a digest comparison, not a protocol.** Before the feature is enabled for a database,
peers exchange a digest of `(generation, homes[])` and refuse to participate on a mismatch. There are
no ballots, no acceptors, no promises and no configuration certificates, because nothing is being
decided at run time — the decision was made by the operator and published.

**A digest check is not a freshness check**, and §4.3 is where that is paid for. It proves two nodes
that can talk to each other hold the same map; it cannot tell a node that its own map is a generation
behind, because a stale map is internally consistent. Nothing here bounds a node that never receives
a new generation — only §4.3's staged transition, with acknowledgements bound to incarnation and one
durable activation record, does.

### 4.2 Why the operator, and what that buys

The hard question in an ownership map is not _how_ to change it but _whether to_: an unreachable
node may be briefly down or permanently gone, and those want opposite answers. A protocol that
decides for itself has to infer intent from timeouts, and the price of inferring it safely is a
durable consensus subsystem. Round 2's counterexample is the proof, and is kept here so the cheap
version is not reinvented:

> Generation `g` = `{A,B,C}`. `A,B` accept successor configuration `X = {A,D,E}`; `X` installs and
> stays live on `D`/`E` renewals. `B` restarts and forgets its acceptance; `C` never learned `X`; `A`
> is unreachable from `B`/`C`. After any quarantine, `B` and `C` observe generation `g` expired and
> accept a different successor `Y = {B,C,F}`. `X` and `Y` now renew on disjoint majorities and derive
> different homes for the same key.

Waiting out old leases cannot extinguish a configuration that has already been chosen and renews on
its _new_ membership, and there is no timing argument that substitutes for persisted promises. An
operator-published map does not have this shape at all: there is exactly one authority, it is
external, and a node either holds the published generation or refuses to act.

So the intent that a protocol would have had to infer is simply **stated**:

| the operator means                         | what they do                                      | what the cluster does                                                 |
| ------------------------------------------ | ------------------------------------------------- | --------------------------------------------------------------------- |
| this node is temporarily down              | nothing                                           | its keys fail closed; every other home keeps serving                  |
| this node is permanently gone, or replaced | stop it, then publish generation `g+1` without it | §4.3's staged transition, then its keys are served by their new homes |

The cost of that is stated just as plainly, and it is the reason this is a decision rather than an
optimization: **an unavailable home's keys stay unavailable until an operator acts.** Automatic,
failure-driven rehoming is not deferred work — it is the thing being declined, and it returns only if
§10's measurements show the manual path is operationally unacceptable.

### 4.3 Changing the map, and restarts

A generation change is **fail-closed and operator-sequenced**, because the danger in any ownership
change is a key acquiring a second arbiter while a delegation issued by the first is still live.
Delegations are volatile and bounded, so the transition is a drain rather than an agreement — but
publishing `g+1` is not by itself what stops `g`, and the note must not pretend otherwise:

1. **Stage** `g+1` to every node named in `homes(g)` and in `homes(g+1)`.
2. **Quiesce.** Each of those nodes acknowledges that it has stopped granting and stopped honouring
   delegations under `g`, and **its acknowledgement carries its `homeIncarnation`** (§5.1). A node
   that does not acknowledge must be **externally fenced** — stopped, isolated, or powered off —
   before the transition may continue. This is the step that carries the whole safety argument, and
   it is why the operator, not a protocol, is the authority: **declaring a node removed is not a
   fence; stopping it is.**
3. **Drain.** Wait `maxDelegationMs + skew` after the last acknowledgement or fence. That interval
   bounds every delegation `g` could have issued before it stopped.
4. **Activate.** One **durable activation record**, issued by the control plane, carries the staged
   generation, the routing-capability version (§4.4), every acknowledgement with the incarnation it
   was given under, the external-fence attestations, and a not-before instant. A node answers
   `homeMap()` with `g+1` only once that record is active. Grants then resume under `g+1`; keys whose
   home did not move are affected by the drain exactly as much as keys that did, because an unchanged
   home is still a new arbiter under a new token prefix.

**An acknowledgement dies with the incarnation that gave it.** Round 10's counterexample, and the
reason step 2 records an incarnation rather than a node name: `A` acknowledges quiescence, then
restarts during the drain. Its new incarnation has none of that state and still holds `g` locally.
If the operator activates `g+1` on `A`'s old acknowledgement, `A` waits out its own §4.3 restart
quarantine and then serves `g` indefinitely, alongside whoever `g+1` homes those keys on. Binding the
acknowledgement to `homeIncarnation` invalidates it the moment `A` restarts, so activation blocks
until `A` re-acknowledges in its new incarnation or is fenced.

The record is **one-shot per reconfiguration, not a renewal**. Steady-state locking never contacts
the control plane; only a transition does. That is the whole distinction from the continuously leased
generation capabilities §9 rejects, and it is why this is a strengthening of the chosen design rather
than a move toward that one.

**Why step 2 is not optional.** Without it, a node that never receives `g+1` keeps serving `g` from
its own retained copy, and nothing in a one-time digest check can tell it that its internally
consistent map is stale. `A` and `B` hold `g={A,B}`; `A` partitions; the operator declares `A`
removed and publishes `g+1={B}`; `B` drains and re-homes `A`'s keys; `A` — still running, still
consistent with itself — grants one of them to whoever it can still reach. Two holders under one key.
A drain measured from _publication_ does not bound that, because `A` never stopped.

**The generation is also monotonic, and enforced as such.** A node refuses a map whose generation is
below one it has already acted under, per database — the scope the generation itself has. Core's half
lasts as long as the coordinating thread; remembering it across a restart, and across threads, is
harper-pro's. The rollback route here is a configuration
restore or a partial publish rather than a protocol bug, which is exactly why it is refused rather
than assumed away: a generation is the high-order component of every fencing token (§5.1), so
re-minting under an older one issues tokens ordering _below_ ones already handed out. Core enforces
this for the life of its process; remembering it across a restart is harper-pro's half.

**A restarted home is the one interval core enforces itself.** Delegations are volatile, so a cold
coordinator has no record of what a previous incarnation granted, and the generation does not change
on a restart — there is no external event to hang the interval on. Core therefore refuses to grant as
a home until `DELEGATION_LEASE_MS + skew` has elapsed **since that coordinator was constructed**, on
its own monotonic clock. It need not remember what it granted, only that everything it could have
granted has expired.

**Construction, not process start and not thread start**, because neither of those is sound. A
worker's `performance.now()` and `timeOrigin` are process-wide, so a process-anchored horizon reads
as long elapsed in a replacement coordinating worker; and a thread can take coordination ownership
long after it booted, so a thread-anchored one has the same hole. Construction is the earliest
instant core can prove nothing else was granting under. Where a predecessor's authority _is_ known —
an adopted transport swap, or an unregister and re-register inside one thread — the horizon is
waived or carried rather than recomputed.

That quarantine costs availability, and the cost is real: for keys a node homes, the first cluster
lock after a cold start waits out the interval. It does not affect keys homed elsewhere — the node
acquires those immediately — and it is bounded by the delegation lease, not by an operator's response
time. A deployment that can prove a previous incarnation issued nothing (a fresh database, a first
start) may override it through the transport, which is the only party that knows that.

### 4.4 Routing — exactly one algorithm

`home(K) = argmax_{m ∈ homes} H(nodeName(m) ‖ 0x00 ‖ canonicalKey(K))`, ties broken by the lexically
greater `nodeName`. Rendezvous (highest-random-weight), **not** modulo indexing: a generation change
then moves only the keys homed to a departing node.

`canonicalKey(K) = utf8(database) ‖ 0x00 ‖ utf8(table) ‖ 0x00 ‖ orderedBinary(key)`, using the same
ordered-binary key encoding the primary store already uses, so two nodes cannot disagree about the
bytes.

**`H` and `canonicalKey` are versioned by the protocol capability, not by the generation.** A
generation is operator-published and says nothing about which hash a binary implements, so two
binaries can accept the same map and still derive different homes for a key — two arbiters, no
disagreement anyone can observe. The routing version therefore rides on the mutually-exclusive
`recordLocks` capability that already gates this protocol (§11), so nodes that would hash differently
cannot both be enabled in one cluster.

## 5. Exclusion

- **One arbiter.** Within a generation every node derives the same home from the same `homes[]`, and
  a digest mismatch stops a node acting rather than letting it derive a second ring (§4.1).
- **Across a generation change** — §4.3's drain.
- **Across a home restart** — §4.3's quarantine, which core enforces on its own process clock. The
  timing argument is sufficient here because a delegation's liveness never migrates to a new set of
  holders: it is one node, one bounded lease.
- **A delegate that loses contact** stops admitting when its delegation expires, enforced by the
  existing commit-time fence. The home may re-grant only after its own issue instant plus
  `durationMs + skew`, on the home's own monotonic clock.

### 5.1 Fencing tokens are ordered, not just unique

A delegation's fencing token is `(generation, homeIncarnation, delegationCounter)`, compared
lexicographically. `homeIncarnation` is a **durably persisted monotonic counter**, carried on the home
map (§4.1) and incremented once per **coordination incarnation** — a process start _or_ a
coordinating-worker restart — not a random id, and not once per process. Coordinator state, the
delegation counter included, is per-thread: a replacement coordinating worker starts counting from
zero, so an incarnation that did not advance with it would let the new worker re-mint tokens its
predecessor already issued, and would leave §4.3's incarnation-bound quiescence acknowledgements
attesting to state that restart discarded. A random incarnation makes a
stale reply identifiable but not orderable, and a home that restarts and re-issues counter 1 after
having issued counter 50 would let a delayed counter-50 write defeat its successor. The token must
also survive key deletion and re-creation, which it does because it is scoped to the home and the
generation, not to the record.

### 5.2 Lease transfer and local handle bounds

A home grants ten seconds and the reply arrives eleven seconds later; a receiver that starts its
clock at receipt overlaps the next delegate.

- The requester reads its monotonic clock at **send** (`t_send`) and sets its delegation deadline to
  `t_send + durationMs`. Never from receipt, never from `deadline − Date.now()`.
- A reply arriving after `t_send + durationMs − minUsefulMs` is **rejected**, not clamped: a
  delegation with no usable window is a retry, not a hold.
- Every message carries `(generation, homeIncarnation, delegationCounter, requestId)` and is bound to
  the authenticated replication origin. A reply that does not match the requester's current generation
  and its outstanding request is discarded; a validly authenticated node that the current generation
  does not name can neither obtain a delegation nor clear one. **The `requestId` half is not
  implemented** — the wire carries no request identity, correlation is the transport's per-call
  promise, and the home therefore cannot tell a duplicate or delayed request from a genuine renewal.
  Core closes the resulting two-holder path by refusing to hand back a grant while any delegation for
  the key is held; the residue, and the protocol fix, are harper#2582. The generation half **is**
  implemented: the map is re-read after the round and a grant minted under a superseded generation is
  handed back rather than installed.
- **Every local handle is bounded by `min(requested lease, delegation deadline)`** — including
  re-entrant acquisition and the `{hold: true}` upgrade. The branch's
  `upgradeToHold` already clamps to the granted round's deadline rather than extending it
  (`resources/recordLock.ts:305`); that clamp is retargeted, and must not be dropped along with the
  round it currently reads.
- **Clock assumptions, stated rather than implied:** every deadline is compared only against readings
  of the _same_ node's `performance.now()`; no remote instant is ever compared against a local one,
  and every cross-node duration travels as a remaining-duration. `skew` covers bounded clock
  _rate_ divergence over one lease period, not offset. A process suspended past a deadline (VM pause,
  container freeze, long GC) resumes with its monotonic clock advanced and observes its own expiry —
  which is why expiry is checked at commit submission and not only on a timer.

## 6. Drain — recall must revoke capability, not just close the door

Two ways a "drained" delegate keeps usable authority, both found in review:

- It `save()`s inside an explicit transaction and `unlock()`s before commit; counting live handles
  reports zero while staged writes can still commit inside the lease.
- It holds a valid `{hold: true}` handle and has staged _nothing_; a recall that only closes new
  admission finds nothing to settle, emits the release, and the holder then writes through its
  still-unexpired handle (`resources/recordLock.ts:32`, `resources/Table.ts:2996`).

So recall is defined as four steps, in order:

1. **Close admission** for `K` under this delegation: no new handle, no re-entrant acquisition, no
   `hold` upgrade.
2. **Revoke** every outstanding handle's write capability synchronously — the same state an expired
   lease produces, so a subsequent write through it fails 409 at staging _and_ at commit submission.
   Calling `release()` is _not_ revocation: `resources/recordLock.ts:145` deliberately distinguishes a
   handle handed back from a lapsed lease, and `resources/DatabaseTransaction.ts:1213` consults that
   predicate immediately before native submission — so revocation must set the lapsed state, and must
   also reach handles a staged write still holds after `unlock()` removed them from the transaction's
   lock registry. A grace window (`min(remaining delegation, recallGraceMs)`) before revocation is a
   fairness knob, not a safety one.
3. **Settle** every transaction that staged a write to `K` under this delegation — committed or
   aborted — including a native commit already submitted, whose completion the pre-submission fence
   does not prove. Settlement follows the **logical** transaction through retry and replay
   (`DatabaseTransaction.ts:1138`, `:1380`); one native attempt completing is not settlement. The
   delegation therefore tracks _staged writes on K_, not live handles, and the release hook hangs off
   transaction settlement.
4. **Then** write the release (§7.1).

If settlement has not completed by the delegation deadline, no release is written and the successor
takes the recovery path (§7.2). A failed or rejected recall never fabricates a release (§8). Delegate
eviction obeys exactly the same rules: a delegate may drop a delegation early, but not while it holds
an active handle or an unsettled write.

## 7. Freshness

### 7.1 Clean handoff: an inherited dependency set, not a version number

The current branch gets successor freshness free, because a grant rides the grantor's own replication
stream behind that grantor's data writes. Unicast delegation messages lose that, so it is
re-established explicitly.

After draining, the delegate writes a **`LOCK_RELEASE` control entry** to the table's transaction log
— the same non-`LOCAL_ONLY` control entry the branch already builds — carrying a **dependency set**:
`{(originNodeName → position)}`, one entry per origin that has written `K` since the last quiesce,
bounded by `|members|`. The entry is ordered behind the delegate's own data writes on its own stream.

A scalar record version is **not** an applied-history fence, and neither is a single predecessor
position:

- `A` writes `K`; `B` acquires, never writes, releases; `C` has applied `B` but not `A`. A
  `B`-position check passes and `C` reads stale — so the set is **inherited**: a delegate that did not
  write `K` passes it through unchanged, a delegate that did write merges its own `(origin, position)`
  in.
- Core breaks equal-`version` conflicts by node name (`resources/Table.ts:6785`), so `C` can hold a
  _losing_ value at the same timestamp as the winner and pass a `version ≥ V` test. A version scalar
  therefore cannot be the fence even for the simple case.
- Receiving `B`'s later patch does not prove receipt of `A`'s earlier change to other fields, which
  is the same reason the set cannot be collapsed to its newest member.

> **The fence:** admit only when, for every `(origin → position)` in the set, this node has _applied
> and made visible_ that origin's stream to at least that position. Applied and visible, not received
> or queued.

Deletes and tombstones are writes and carry positions like any other. An origin whose stream has been
purged past the listed position, or is otherwise unsatisfiable, is a §7.2 recovery case — it must
fail closed, not silently pass.

### 7.2 Recovery paths, and where the guarantee is explicitly weaker

The home holds the dependency set in memory, so a home restart, a generation change, or a delegate
crash with no clean release loses it. `verify:` whether a durable copy is recoverable from the log within
retention — if it is, that is a cheaper recovery than the barrier below and should be preferred.

Without it, the first grant for a key carries no set, and the acquirer must instead **drain its
inbound replication streams from every reachable member to the position each held at grant time**
before admitting (`verify:` the per-connection received position in
harper-pro `replication/subscriptionManager.ts` is exposed at this granularity).

That barrier is the strongest condition available without synchronous replication, and it is
explicitly weaker in two ways that must be documented rather than implied: an unreachable member's
committed writes may not be visible, and a predecessor's native commit submitted before expiry can
settle _after_ the barrier was measured. It is also not cheap — see §10.

**Fail-closed is a fallback, not a fix, and the note must not claim otherwise.** If the barrier
cannot be established, `lock()` rejects with the retryable 503 the branch already uses. But a barrier
that _succeeds_ still admits the forbidden history: `A` commits `K=1`, becomes unreachable before
replication, every reachable member's position is satisfied, and `B` is admitted and reads `K=0`.
Rejecting on failure does not detect that, because nothing failed. Meeting §2 strictly in recovery
mode requires **recoverable commit evidence** — locked writes replicated to a quorum before the
critical section is considered settled — which is the third arm of the §7.3 decision, not a free
default.

### 7.3 The crashed writer: LWW is not enough, and fencing is not free

> **Decided: (b) exclusion-only.** (a) and (c) are deferred to harper#2540. §10 carries the
> normative contract and the reasoning; the analysis below is what those arms would have to build.

The earlier claim — that a crashed holder's unreplicated write is stamped older and dropped by
last-write-wins — does not hold. If `A`'s clock runs ahead, `A` writes under a valid delegation and
becomes unreachable, and `B` later acquires and commits, `A`'s delayed write can carry the greater
timestamp and overwrite `B`. Monotonic lease expiry orders admissions, not timestamps.

Fencing generations fix it, but the comparison rule has to be **total**, and the obvious pairwise rule
is not. "Generation for locked writes, timestamp otherwise" cycles: locked `A(g1,t30)`, locked
`B(g2,t10)`, ordinary `U(t20)` gives `B > A`, `A > U`, `U > B`, and arrival order decides. The two
coherent options:

- **(a) Fenced.** Every write carries a fencing generation (0 when unlocked) and conflict resolution
  is `(generation, timestamp, origin)` lexicographic. Total, no cycle. The costs are real and larger
  than one comparator:
  - It changes `_writeUpdate`'s resolution rule for _all_ writes and adds a field to the record
    contract, so it is a stored-format and older-binary compatibility decision, not just a protocol
    one — including what happens if the feature is disabled after fenced records exist.
  - It **reverses the documented Phase 0 relationship with ordinary writes** (`DESIGN.md:169`): an
    ordinary update landing after a fenced value would permanently lose, regardless of age.
  - Older writes currently enter resequencing and merge logic (`Table.ts:3131`), and deletes take a
    separate path (`Table.ts:3753`), so a generation must be honored by patches and deletes too.
  - A generation alone has no **rejection floor** that survives tombstone cleanup: generation 1 puts,
    generation 2 deletes, the tombstone is reclaimed, and a delayed generation-1 put resurrects the
    record on that replica. Fenced mode therefore also owes a retained floor across tombstone
    reclamation, snapshot copy, restore and replay.
- **(b) Exclusion-only.** No fencing token in conflict resolution. `lock()` promises exclusion of
  concurrent _admission_; conflict resolution stays last-write-wins, and the crashed-clock-ahead
  overwrite is a documented limitation, as is the §7.2 late-settling commit.
- **(c) Quorum-confirmed locked writes.** Orthogonal to (a)/(b), and the arm that addresses §2's
  freshness invariant in recovery mode: a locked write is not considered settled until replicated to
  a majority. Write confirmation alone is not sufficient — intersection needs the read side too, and
  §7.2's barrier has no quorum floor — so this arm is **two** changes: confirm the write to a
  majority, _and_ make the barrier require a majority and fail closed below it.
  `X-Replicate-To;confirm=M` (`server/REST.ts:265`) is the nearest existing mechanism, but it is
  super-user-gated and entangled with residency (§10), so this arm cannot just expose it. It costs
  latency on
  every locked write. Even with both halves it does **not** restore §2 as written: the late-settling
  commit had not settled when the barrier ran, so that route needs the commit _fenced_, which is arm
  (a)'s job. §2 as written needs (a) and (c) together.

The choice is wider than "fenced or not": it settles the _freshness and settlement_ guarantee as well
as conflict ordering. §10 records why (b) was taken and states the resulting contract.

One limit is outside all three answers: an expired holder can resume work _outside_ Harper while its
successor runs. `lock()` promises exclusion of valid lock admissions inside Harper; arbitrary
external effects need idempotency or fencing at that system.

## 8. Failure containment and bounded state

- A recall that meets a rejected send, a disconnected peer, a dropped table, a failed release commit,
  a throwing settlement callback or shutdown must **settle its callers and keep admission closed**.
  An escaping rejection can take the process down; swallowing it and granting onward violates §7. A
  failed handoff enters the expiry path and never fabricates a release. These need executable
  contracts — injected synchronous throws and rejections at each of those points — not prose.
- **Aggregate caps, not just per-key.** The branch's per-key and per-table caps exist to bound what a
  broadcast round accumulates and are removed with it; a scan locking millions of distinct keys would
  otherwise retain millions of delegations, waiters and timers. Bound outstanding delegations per
  database and per requester, bound expiration work per tick, and cancel waiters. Eviction is
  asymmetric, and the asymmetry is the safety rule: a **delegate** may drop a delegation early
  (subject to §6), a **home** may never forget one before its expiry, so its eviction structure
  retains `(key → until)` for expired-but-uncollected entries.
- **Dependency-set retention is a separate lifetime from delegation expiry.** A home that has evicted
  a key's dependency set cannot distinguish it from a key never delegated at all, and would take the
  §7.2 barrier on both — so a workload cycling through more keys than the cap pays the recovery cost
  during _normal_ operation, not only after a restart. The home therefore keeps a compact
  ever-delegated-in-this-generation filter (add-only, so it has no false negatives): outside it, a key has
  no predecessor and needs no barrier; inside it with the set evicted, the barrier is required. Retain
  dependency sets longer than delegations, and size the filter as part of the cap budget.
- Ordinary writes keep their existing ungated path, with no exception: exclusion-only (§7.3) adds
  nothing to a write that was not made under a lock, and delegation bookkeeping lives only on lock
  paths. This is the property the fenced arm would have given up, and it is the main reason it was not
  taken. The requirement on a cached-delegation hit is **zero additional protocol allocation**, not an
  allocation-free `lock()`: Phase 0 itself allocates a handle and a promise, and that is the baseline.
  The implementation does not meet that requirement yet — it allocates an admission record per
  `lock()`. What those records **retain** is bounded, and the bound must be stated exactly rather than
  flatteringly: an admission survives its own `unlock()` on purpose, because the write it staged can
  still commit and the revoker has to stay reachable until the handle's lease runs out (§6 step 2). So
  retention is `lock rate × lease`, which is the floor any correct implementation pays — not a bound
  independent of the lock rate. What the sweep fixes is a different failure: admissions are swept once
  the map has outgrown the live set the previous sweep measured, so mixed lease lengths cannot hide an
  expired admission behind a longer-lived one for the length of _its_ lease. Getting below `rate ×
lease` means carrying the revoker on the Phase 0 handle that already exists instead of allocating a
  second record, which is the redesign §10's measurement gate is meant to justify.
- Home-map membership and message role are authenticated and authorized **before** state is
  allocated, so a malformed payload, a superseded generation or cap exhaustion cannot be used to
  accumulate state. A request from a node the current generation does not name is refused before any
  grant, waiter or timer is allocated. Dependency-set and key payload sizes are bounded before
  allocation. Trusted origin identity stays the transport's responsibility, as it already is
  (`resources/recordLockCoordinator.ts:79`). There are no configuration certificates to validate,
  because there is no election — the map's digest is agreed once, out of band, before the feature is
  enabled (§4.1).

## 9. Approaches considered

| Axis                | Candidate                                                                                                                                                                                                                                                                                                                                              | Why not chosen                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Different layer** | Put arbitration entirely in harper-pro's replication layer, or behind an embedded/external Raft group that owns the lock table.                                                                                                                                                                                                                        | The disqualifier for a full replicated lock table is specific, not "bigger": **replicating per-key ownership puts durable, majority-acknowledged work on every acquisition**, which is exactly what volatile delegations remove and what §10's amortization depends on. It would also still need §7's fence, because it is off-stream. The consensus objection is now clean rather than hypocritical: this design runs no election of its own, at any rate, so "adds consensus" is an argument it is entitled to make. If Harper later wants consensus for membership, shard maps and schema changes, §4's map is the piece to replace with it — and the replacement would be invisible to §§5–8.                                                                                                                                                                                                                                                                                                                                                           |
| **Deeper cause**    | Do not hand out locks at all: make the conflicting operation a conditional/compare-and-swap write evaluated by one authority (the residency owner).                                                                                                                                                                                                    | Covers only retryable single-record read-modify-write. `lock()` exists in harper#483 for a caller holding the lock across arbitrary application work, including calls to other systems, which no CAS expresses. It also does not remove the authority problem: an independent local CAS against asynchronously replicated copies is not cluster-wide exclusion. Worth having _as well_.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| **Do less**         | Keep Ricart–Agrawala and accept the availability limit: it is implemented, tested, and gated off by `replication.recordLocks`.                                                                                                                                                                                                                         | The limit is the feature's value, not a rollout caveat: a lock any single unreachable peer disables is not usable for the correctness-critical work `lock()` exists for. Cost points the same way — 13 durable commits and 143 frame deliveries per lock at `P=12`, per key, with no amortization for a node locking the same record repeatedly.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| **Do more**         | Durable membership epochs: agree `members[]` by single-decree consensus over a majority, with acceptor state persisted before acknowledgement, so an unreachable node is rehomed automatically. **This note's own design through round 6.**                                                                                                            | Rejected 2026-09-13. What it buys over the chosen map is exactly one thing: **unattended rehoming**. What it costs is a durable consensus subsystem in harper-pro — persisted promises and accepted values, ballots, renewal leases as the liveness signal, acceptor-side retirement reservations, transitive activation protection, and a conservative restart quarantine to reconstruct reservations a crash lost. All of that exists to _infer_ whether an unreachable node is briefly down or permanently gone. An operator already knows, and can say so in one published generation. The judgement is not that consensus is too hard; it is that **this particular decision has an authority who can simply state it**, so inferring it is unpaid complexity.                                                                                                                                                                                                                                                                                         |
| **Do more (2)**     | A centrally **leased** operator map: the same published generations, but nodes hold short-lived authenticated capabilities for the current one and must renew them from the control plane. The operator stops renewing `g`, waits capability expiry plus the maximum delegation interval, then activates `g+1`. Raised by the round-8 planning review. | **Overruled, with a concrete disqualifier: it makes every node's ability to lock depend on continuously reaching the control plane.** A control-plane outage longer than the capability lease stops record locking on every node in the cluster, including nodes that are healthy and agree with each other — a strictly larger availability dependency than the transition it replaces, and one that is paid continuously rather than at reconfiguration time. It also reintroduces the renewal lease and the clock-rate bound this revision exists to delete, and it does not remove the operator from the loop: the capability issuer must still decide to stop renewing. What it does buy is real: it fences a partitioned old generation mechanically. **Round 10 showed that half can be had without the dependency** — §4.3's one-shot durable activation record, which is issued once per reconfiguration rather than renewed, so steady-state locking never contacts the control plane. That was adopted; only the continuous renewal is rejected. |
| **Adjacent**        | Derive the map from `server.shards`, which already maps shard id → node list and already routes residency reads.                                                                                                                                                                                                                                       | A shard map is a **residency** directive — it says where records live. Making it the lock-home map couples arbitration to data placement and requires sharding configuration, which one customer uses. The chosen map is a separate, purpose-built `recordLockHomes` generation, so a cluster adopts record locks without adopting sharding. Where sharding _is_ configured the shard map is a valid set of homes and an operator may publish it as one.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| **Chosen**          | Operator-agreed immutable home map + rendezvous homes + volatile per-record delegations, local Phase 0 locks underneath.                                                                                                                                                                                                                               | No agreement protocol runs at any rate: the only agreed state is published out of band and checked by digest. A single arbiter per key removes the contention protocol entirely; a monotonic generation is what makes §5.1's fencing token orderable; repeated locking by one node costs zero cluster messages. The price is stated in §4.2 and is the whole of the tradeoff: **an unavailable home's keys stay unavailable until an operator acts.**                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |

**Quorum-granted bounded delegations** (each voter reserves `K`; `floor(n/2)+1` wins; a preferred
proposer to damp contention) also amortize local locks, and is the closest rejected alternative. The
restart argument against it that appeared earlier in this thread was wrong and is withdrawn: a voter
_can_ forget per-key reservations after outliving every pre-crash vote, given an unexpired
intersecting quorum. The facts that decide against it are cost and complexity, both concrete: quorum
fan-out on every delegation acquisition **and renewal**, where a single home pays two unicast
messages and no renewal fan-out; and a retained contention-arbitration protocol between competing
claimants, which the single-arbiter design deletes rather than simplifies. What it buys is avoiding
§4.3's operator-sequenced transition and restart quarantine. For a lock whose stated goal is
per-record throughput, that trade goes the other way.

## 10. Cost, and the guarantee decision

Per uncontended acquisition, `P` participants, `d` = locks served under one delegation:

|                                                                                           | durable commits | frame deliveries                         | latency                              | one node down                                                      |
| ----------------------------------------------------------------------------------------- | --------------- | ---------------------------------------- | ------------------------------------ | ------------------------------------------------------------------ |
| Ricart–Agrawala (branch today)                                                            | `P+1`           | `P²−1`                                   | slowest participant                  | **all** cluster locks block                                        |
| This design, first lock on a key                                                          | 0               | 2 unicast                                | 1 RTT to the home, 0 if local        | that node's ring share only, until an operator republishes the map |
| This design, handoff to another node                                                      | 1 (release)     | `P−1` + 3 unicast                        | 2 RTT                                | —                                                                  |
| This design, steady state                                                                 | 0               | 0                                        | local key lock                       | —                                                                  |
| **Recovery path (§7.2)** — first access per key after a home restart or generation change | 0               | position query to every reachable member | **1 RTT + replication-backlog wait** | —                                                                  |

The recovery row is the one that can dominate and it is not amortized: a scan touching many distinct
cold keys after a recovery pays it per key. Barriers must be shared or batched across keys without
weakening their ordering, and the cost measured rather than assumed. Steady-state cost is also
bounded below by **re-acquisition when a delegation lapses without contention**, so `durationMs` and
the re-acquisition rate are as load-bearing as the handoff rate.

**No measurement exists yet on a real cluster** — not a round's latency, not audit growth, not the
current `lock()` rate. harper-pro#822 already carries an enablement gate; producing these numbers is
this design's first deliverable, before the protocol change lands. Everything above is a message
count, not a benchmark. The gate needs: acquisition latency distribution; delegation re-acquisition
rate at candidate `durationMs`; the §4.3 restart quarantine's observed effect on lock availability;
hot-key handoff throughput; **cold-key throughput
and backlog sensitivity on the recovery path**; allocation rate on the cached-delegation path; cap
saturation behavior; and throughput with the feature _disabled_, to prove the ungated write path is
untouched.

**The guarantee decision — §7.3.** What `lock()` promises, on two independent axes:

|                       | conflict ordering                 | recovery-mode freshness                                                                                 | cost                                                                                                         |
| --------------------- | --------------------------------- | ------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| **Exclusion-only** ✅ | LWW unchanged                     | narrowed: §2's freshness is not promised on the recovery path                                           | none beyond the protocol                                                                                     |
| **Fenced**            | `(generation, timestamp, origin)` | still narrowed                                                                                          | record-contract + stored-format change, reverses `DESIGN.md:169`, owes a tombstone-surviving rejection floor |
| **Quorum-confirmed**  | either of the above               | closes the crashed/unreachable routes, not the late-settling one; §2 as written needs this _and_ fenced | latency on every locked write                                                                                |

**Exclusion-only is chosen.** The other two arms are deferred to harper#2540, which carries the
limitations, the costs, and what closing them would take.

Why the two arms were not taken now: fenced mode's cost is misplaced — it changes conflict resolution for _every_ write in the database,
including in deployments that never call `lock()`, and it inverts a rule Phase 0 documented and
shipped — in exchange for a predecessor whose write outranks its successor's. Quorum confirmation
costs a replication round trip on every locked write. Neither should sit on the critical path of a
feature that has not yet been measured.

> **The contract, and the text the API documentation owes.** `lock()` guarantees that at most one
> node **admits** a critical section for a key at a time. It further guarantees that a node admitted
> after another node released cleanly has already applied that node's committed writes to the key —
> but **only while the key's home still holds the dependency set from that release**. A home restart,
> a generation change, or cap eviction (§7.2, §8) loses it and routes the successor to the recovery
> barrier instead, which is limitation (2) below: so (2) is reachable after a perfectly clean release,
> not only after a failure. It does **not** guarantee either of the following, and neither of them
> needs a crash:
>
> 1. **A predecessor's write can outrank its successor's under last-write-wins.** LWW compares the
>    transaction timestamp assigned when the write was _staged_ (`resources/Table.ts:3113`), and lease
>    expiry orders admissions, not timestamps. **`lock()` changes nothing about conflict resolution**
>    — a locked write and an unlocked write resolve identically, by timestamp, per field, with CRDT
>    ops folded and the surviving shape depending on both writes' shapes and on whether auditing is
>    on — so whatever the pair would have done to the record without a lock is what they do with one,
>    silently and with no error raised. That is the whole of the limitation, and the contract must not
>    restate the resolution rules: they live in `Table.ts` / `crdt.ts` and are not `lock()`'s to
>    promise. Two routes in, and they fail differently:
>    - **(1a) clock skew.** The predecessor's clock ran ahead of its successor's, and its write is
>      still in flight when the successor writes.
>    - **(1b) a timestamp pushed ahead on purpose, on a completely clean handoff.** A caller-supplied
>      future `context.timestamp`, or a mixed explicit transaction whose later timestamp becomes the
>      handle's floor — both documented as deliberate Phase 0 behavior (`DESIGN.md:305-309`). The
>      predecessor commits, replicates, drains and releases cleanly; the successor is admitted with
>      correct freshness, reads the current value, and writes at real wall-clock time — and its write
>      is the older one, silently, because the stored version is stamped in the future. What the
>      committed record then holds is whatever ordinary resolution produces from the pair — which for
>      overlapping plain fields is not the successor's value, and for disjoint patches or commutative
>      ops may still carry it. No crash, no skew, nothing in flight. **This is the case that
>      makes "exclusion-only" narrower than it sounds**, and the only defense available to a caller
>      today is not to stamp future timestamps under a lock.
> 2. **Successor freshness is not promised on the recovery path.** The §7.2 barrier drains streams
>    from every _reachable_ member, so a write the predecessor committed and did not replicate is
>    invisible to it: the barrier succeeds and the successor reads a stale value. Three routes in, and
>    only the first is a crash — the predecessor crashed; the predecessor is unreachable; or the
>    predecessor passed the pre-commit expiry fence, submitted its native commit, and that commit
>    settles _after_ the barrier was measured. The third needs no failure beyond a commit slower than
>    the remaining lease. **Two damaged effects on the one record, not two records:** the predecessor's
>    committed transaction is not reflected in the result, _and_ the successor's own write is computed
>    from the stale value it read — stored balance 150, successor reads 100 and writes 80, so what
>    survives is wrong on its own terms and not merely stale. That is exactly the
>    read-then-conditionally-write the lock exists for.
>
> **§2's exclusion invariant is wider than what (1) and (2) leave.** It requires a successor to
> exclude every predecessor capability that can still admit _or commit_; what ships excludes
> admission, and the commit half holds only up to the pre-submission expiry fence
> (`resources/DatabaseTransaction.ts:1213`) — a native commit that clears that fence and settles
> afterwards is limitation (2)'s third route.
>
> **There is no caller-side mitigation for (2) — the obvious candidate is unreachable and, where it
> is reachable, makes things worse.** `X-Replicate-To` / `confirm=` is meant to be super-user only —
> `checkContextPermissions` (`resources/Table.ts:7258`) raises 403 otherwise, though its truthiness
> gate lets `X-Replicate-To: 0` through, which is harper#2546 and not a mitigation anyone should
> build on. And where it is legitimately available it is a **residency** directive before it is a
> confirmation knob: absent a `getResidencyById` function, which short-circuits ahead of it
> (`resources/Table.ts:1575`), a numeric value sets residency to `[self, ...N nodes]` and truncates
> existing residency on update (`:1574`), while `*` leaves `replicateTo` undefined and falls back to
> the database's configured `replication.replicateTo` count (`:1578`, `:642`) — neither of which is
> guaranteed to be the whole cluster. In a twelve-node cluster configured `replicateTo: 3`, either
> form leaves the record on four nodes, and a successor's barrier over the other eight reachable
> members satisfies without any of them ever having held the locked write. That is the opposite of
> what the barrier needs.
>
> Even with residency genuinely cluster-wide, confirmation **narrows (2) and closes none of its three
> routes**. For the crashed and unreachable routes it helps only when the confirming and reachable
> sets intersect — `M + reachable > |cluster|` — and §7.2's barrier has no read-quorum floor, because
> it deliberately tolerates unreachable members; forcing that intersection costs any single down node
> blocking every locked write, and `M` is a literal that silently under-confirms after a scale-out.
> **For the third route it does nothing at all**: the predecessor's commit had not settled when the
> barrier was measured, so no confirmation level makes a barrier taken at `T` observe a commit that
> replicates at `T+δ`. Closing (2) needs the barrier to require a majority and fail closed below it,
> _and_ the late-settling commit to be fenced rather than confirmed — which is why harper#2540's
> quorum-confirmed arm is not a one-line header change and needs the fenced arm with it.

**Both limitations ship silent, and that is a choice worth recording rather than a consequence.** A
caller whose locked write loses gets a 200, no log line and no counter, so nothing distinguishes it
from correct behavior. Making it observable is cheap and confined to the lock path — the handle
already carries its floor and the commit path already fences per write on `write.lockHandle`
(`resources/DatabaseTransaction.ts:1211`), so a lock-path-only check that a staged version exceeds
wall-clock, and a counter when a barrier admits with no dependency set, cost nothing on ungated
writes. It is not in scope here because it is detection rather than guarantee, but it belongs in
harper#2541 rather than nowhere.

Nothing above may be softened into "rare" or "best-effort" in the API docs, and neither limitation
may be described as crash-only or as unreachable on a clean handoff: a documented narrowing is what
makes exclusion-only an honest answer rather than an unstated hole, and a narrowing stated more
narrowly than it is is the same hole with a paragraph in front of it.

## 11. What survives from harper#2498

Unchanged and reused:

- `resources/recordLock.ts` — the Phase 0 primitives, the `scope` option, the monotonic lease
  deadline, the contained release hook.
- The commit-time lease fence in `Table.ts` / `DatabaseTransaction.ts`. It moves from a per-round
  lease to a delegation lease with no change to the mechanism; §6 adds revocation and settlement
  tracking on top of it rather than replacing it.
- `lock()` integration: coalescing of concurrent calls on one key, `scope: 'node'` semantics,
  fail-closed behavior with no transport, synchronous `unlock()`, the `LockUnavailableError` / 423 /
  409 contract.
- The `LOCK_RELEASE` control entry end to end — the nibble, the private `Packr`, `recordId: null`
  and the key in the payload (the audit dedup collision at `ts_R` documented in `DESIGN.md` applies
  identically), the receive routing off the record path, and the filters on every surface that
  reports audit entries as record activity.
- `ClusterLockTransport` as the boundary, the per-database registry, fail-closed membership
  validation, and `ownsCoordination()` thread ownership.
- harper-pro#822's topology work: participant derivation from the replication group, per-database
  coordination ownership, the `replication.recordLocks` switch, `cluster_status.recordLocks`.

**Three defects inherited with that substrate.** A cross-model review of the branch at `b26d5e22`
found them in code this note keeps rather than in the arbitration rule it deletes, so they did not go
away on their own. **All three are fixed on this branch** as part of landing the replacement; they are
recorded here because the reasoning is the design's, not the fix's:

- **Transport replacement does not fence live authority** (`resources/Table.ts:5474`). Re-registering
  a transport — a component reload is enough — closes the current coordinator and installs an empty
  one. `close()` clears coordinator state but does not invalidate handles already handed out, and a
  handle checks only its own release and lease fields. The successor coordinator can then grant the
  same key immediately, with no lease time elapsed. Under §5 the equivalent transition is a home
  restart, and §5's answer applies here too: the replacement must either carry live authority across
  the swap or fence and settle every outstanding handle before it may grant. Unregister/re-register
  and transport-object replacement both need coverage.
- **The direct receive callback has no containment** (`resources/recordLockCoordinator.ts:908`). The
  resolver calls `Table.lockCoordinator`, which throws `LockUnavailableError` when the node name is
  unusable, and that throw happens before `applyEntry()`'s own containment can catch it, so it
  escapes `deliverLockControlEntry()`. The source-subscription sink already handles this
  (`resources/Table.ts:884`); the direct callback must too. This is §8's rule — a receive boundary
  settles its callers and keeps admission closed — applied to a path that exists today.
- **The commit fence scans every write on every commit** (`resources/DatabaseTransaction.ts:1213`).
  The loop runs on ordinary transactions in core-only deployments that never register a transport, so
  a bulk transaction with 100,000 plain writes pays 100,000 property checks before submission. §8
  requires ordinary writes to keep their existing ungated path, so the transaction must track whether
  it holds any lease-protected write and skip the pass when it does not — while still fencing a
  released-but-staged locked write, which is the case the loop exists for.

Removed — **done on this branch**:

- The Ricart–Agrawala state machine — `LOCK_REQUEST`/`LOCK_GRANT` nibbles, per-peer round tracking,
  deferral queues, `(tsR, nodeName)` ordering, synthesized grants, withdraw-on-timeout, and
  `agreedDown` DOWN-exclusion. Nibbles 9 and 10 are retired rather than migrated; 9 has since been
  taken by eviction on `main`, so a migration was never available.

Added — **core's half is done on this branch**:

- The home ring (§4.4), the delegation table, recall-and-drain (§6), ordered fencing tokens (§5.1)
  and §8's aggregate caps, in `resources/recordLockCoordinator.ts`.
- The transport interface core needs from harper-pro: `homeMap(database)`,
  `requestDelegation(...)` and `recallDelegation(...)`, plus the inbound handlers core exposes so a
  transport can route a peer's request or recall to the right coordinator.

Added — **harper-pro's delegation server, on harper-pro#822**:

- The wire: `record_lock_delegate` and `record_lock_recall` as registered operations over the
  replication connections that already exist, in `replication/recordLockRpc.ts`. A request prefers
  the live outbound subscription session — whose inbound end already lands on the home's coordinating
  worker — and falls back to `sendOperationToNode`. The requester's identity is the authenticated
  node principal of the connection, never a payload field, so a `super_user` human cannot mint or
  clear a delegation. An operation accepted on a non-owner thread relays through main to the owner
  worker under a bound, and a relay that times out answers `not-home`, never a grant.
- The `ClusterLockTransport` implementation, capability level 2 and the enablement gate, in
  `replication/recordLockTransport.ts` and `replication/protocolCapabilities.ts`.

Still owed by harper-pro — **the one thing that blocks enablement**:

- The operator-agreed home map (§4) behind `transport.homeMap(database)` (harper-pro#825). #822
  already carries a **static** map as scaffolding, and under this design static is the right shape —
  what it lacks is the two properties §4.1 requires: an operator-published `recordLockHomes`
  generation rather than one each node derives for itself, and a digest agreed across peers before
  grants are enabled — plus §4.3's one-shot activation record, which is what makes a generation change
  safe rather than merely announced.
- **The transport registered on every worker thread that can serve a `lock()`**, not only the
  coordinating one, and including a dedicated application worker (harper#2524). Core cannot check
  it: the "this database is clustered" latch is per-thread module state, so a worker that never
  registers never fails closed, and a default-scoped `lock()` there takes the Phase 0 node lock alone
  while a peer runs the cluster protocol — two nodes admitting one key. Registering everywhere is also
  what makes the `ownsCoordination()` 503 reachable, which is the path a non-owner worker is supposed
  to take.
- **`homeIncarnation` advanced per coordination incarnation, not per process** (§5.1). Core cannot mint
  it — it must be durable and monotonic — and cannot check it, which puts it in the same class as
  §4.3's activation record. It matters because coordinator state is per-thread: a replacement
  coordinating worker restarts the delegation counter at zero, so an incarnation that only advanced
  per process would let it re-mint tokens its predecessor issued, and a delayed release carrying one
  of those tokens would clear a live grant. Derived-per-node is why the transport ships gated off: two nodes that disagree
  derive different rings and can both grant one key. #825 is now a config generation, a digest check
  and the §4.3 change runbook — not a consensus protocol.

### Protocol version and mixed deployments

The existing `recordLocks` capability does not distinguish Ricart–Agrawala from delegations, and a
cluster running both would have two independent arbiters for one key. The capability is therefore
**versioned**, the versions are mutually exclusive, and a node advertises exactly one. Since RA never
shipped enabled, nibbles 9/10 are retired rather than migrated, and the `LOCK_RELEASE` payload —
today a fixed five-field tuple `[key, requester, generation, homeIncarnation, counter]` validated on
exact length (`resources/recordLockCoordinator.ts:258`) — grows a leading version field plus §7.1's
dependency set. A historical entry replayed from the log must still decode safely after its producer
is gone, and a delayed old release must not clear a newer delegation.

**Merging the substrate is itself gated:** nothing that still wires RA arbitration may be reachable
as the new protocol.

## 12. Verification route

- **Unit**, coordinator as a pure state machine with **independent per-node clocks** rather than one
  shared fake clock (`unitTests/resources/recordLockCoordinator.test.js:24` uses a shared one, which
  cannot express §5.2): delayed grant reply rejected; renewal/restart overlap; recall against a live
  handle that staged nothing (§6); recall against an unlocked-but-staged write; transitive freshness
  including the equal-timestamp and dependent-patch cases (§7.1); fencing-token ordering across a home
  restart (§5.1); and the negative cases — grant inside the §4.3 restart quarantine, a request naming
  a superseded generation, a grant minted under a generation superseded across the round, a request
  from a node the current generation does not name, admit before the dependency set is satisfied,
  admit with an unsatisfiable set.
- **Integration, multi-process**, with independent message/apply/commit delays: exclusion and
  handoff; **a node down and locks still acquired on the majority side**, with a bounded recovery
  time — the case Ricart–Agrawala cannot pass, and the reason for the change; minority side stops;
  home crash → operator publishes a new generation → keys re-homed, with the §4.3 drain observed;
  home restart after a _clean_ release (the §7.2 set-loss path); delegate crash → expiry → successor;
  native commit delayed past expiry; a generation change that _replaces_ a node rather than removing
  one; a node holding a superseded generation refused rather than served; mixed protocol versions
  refuse to interoperate; feature disabled
  is byte-for-byte the current write path. Counter tests assert observed read/write histories, not
  only final totals, and snapshot-free reload must still work after the applied-history fence
  (`Table.ts:2759`). Under exclusion-only there is no fenced-mode suite to add here; the stale
  writes, patches and deletes against successor records and reclaimed tombstones belong to
  harper#2540 if that arm is ever taken. What this suite **must** assert instead is the documented
  narrowing itself, as expected outcomes rather than test failures. Two schedules, and both must
  assert the observed value rather than only that no error was raised:
  - **A predecessor's write outranking its successor's**, driven by a caller-supplied future
    `context.timestamp` rather than a faked clock — so it runs over a _clean_ handoff with no skew.
    Assert what `lock()` failed to prevent, not a storage disposition: that the committed record
    differs from what a serialized execution of the two critical sections would have produced, and
    that no error reached either caller. Choose a fixture where the two writes overlap on a plain
    field, so the assertion holds under any conflict-resolution change — pinning exact post-resolution
    values would tie this suite to `Table.ts`/`crdt.ts` behavior that is not `lock()`'s to promise.
  - **A barrier that succeeds while a predecessor's unreplicated write is invisible**, including the
    no-crash route where the predecessor's native commit settles after the barrier was measured.
    Assert both damaged effects on the one record, again over an overlapping plain field: the
    predecessor's transaction not reflected in the committed result, and the successor's own write
    computed from the stale value it read.
- Failure injection as an executable contract, not prose: synchronous throws and rejected promises
  through revoke, settlement callbacks, release persistence, shutdown and table removal — callers
  settle, admission stays closed, no unhandled rejection, no fabricated handoff. A release entry that
  commits after its waiting caller timed out must be harmless when replayed later.
- Enablement stays gated on those results and on §10's measurements.

## 13. Rollout

harper#2498 stays a draft and does not ship Ricart–Agrawala as the arbitration rule. The substrate in
§11 lands (reusable under every option considered, and already reviewed); the arbitration **is
replaced on the branch**. harper-pro#822 keeps its capability, participant-set, ownership and switch
work, and its transport implementation is replaced — the delegation wire is in place there. Neither is enabled by default at any point, and with
harper#2542 and harper-pro#825 outstanding the branch cannot be enabled even deliberately: core fails
closed without an agreed home map, and no core build supplies one.

## 14. Planning record, and what still blocks implementation

Round 3 (`0a3f817ca56e`) cleared the framing of the epoch design, and its protocol-level findings are
folded into §6 (revocation vs release, logical-transaction settlement), §7.2 (fail-closed is not
freshness), §7.3 (the third arm and the fenced-mode costs), §8 (dependency-set retention), §10 and
§12. The findings that were specific to the agreement protocol went with it.

**Round 7 (`14c1b5510`) returned `better-alternative-exists` against that framing, and it was
adopted on 2026-09-13.** The reviewer's point, and the ruling that followed it: the epoch protocol
automated a decision that has a human authority. Whether an unreachable node is briefly down or
permanently gone is knowledge an operator holds and a protocol can only infer from timeouts, and
inferring it safely costs a durable consensus subsystem. §4 is now an operator-agreed immutable home
map; the agreement protocol is deleted rather than scheduled, and §9 carries it as the rejected
alternative with the reason. Automatic failure-driven rehoming returns only if §10's measurements
show the operator-sequenced path is unacceptable in practice.

**Round 10's framing recheck named one more option and it was adopted.** An acknowledgement in §4.3
step 2 used to be a node's word, and a node's word does not survive its own restart: `A`
acknowledges quiescence, restarts during the drain with `g` still in its local configuration, the
operator activates `g+1` on that stale acknowledgement, and once `A`'s own restart quarantine elapses
it serves `g` indefinitely alongside the new homes. §4.3 now binds every acknowledgement to the
acknowledger's `homeIncarnation` and gathers the staged generation, the routing-capability version,
those acknowledgements, the fence attestations and a not-before instant into **one durable activation
record**; a node exposes `g+1` only once that record is active. It is one-shot per reconfiguration,
which is exactly what separates it from §9's rejected renewable capabilities: steady-state locking
still never touches the control plane.

**Round 8 reviewed the recut and returned `better-alternative-exists` again**, and it was right about
the gap even though its alternative was not taken. Its blocker: publishing `g+1` does not revoke a
live `g`, because a partitioned node that never receives the new generation keeps serving the old one
from an internally consistent copy, and a one-time digest check cannot detect that. §4.3 now states
the transition that closes it — stage, acknowledge or externally fence, drain, activate — and §4.1
says plainly that a digest check is not a freshness check. Its anti-rollback point is adopted too: a
generation below one already acted on is refused, in core for the life of a process and durably by
harper-pro across one. Its §4.4 point is adopted: the routing hash is versioned by the protocol
capability rather than by the generation, because two binaries can accept one map and still hash a
key to different homes. Its proposed **leased** generation capabilities are recorded in §9 and
overruled on one fact — they make locking depend on continuously reaching the control plane, so a
control-plane outage stops locking cluster-wide.

**A cleared framing is not authorization to implement.** Two things had to be settled first, and one
still is:

1. **The guarantee decision — settled, exclusion-only** (§7.3 (b), §10). The deferred arms are
   harper#2540.
2. **The measurement gate of §10 comes before the protocol change, not after it.** Tracked as
   harper-pro#824, and it is the only piece of this work that is unblocked today.

Everything else above is implementable as written. The work is decomposed as harper-pro#825 (the
operator-agreed home map, §4 — a `recordLockHomes` generation, a peer digest check and the §4.3
change runbook, which is what remains of that issue after the round-7 adoption), harper#2541 (home
ring, delegations, drain and caps, §§5/6/8, plus the three inherited substrate defects in §11) and
harper#2542 (successor freshness, §7).

**Status.** harper#2541's core half is implemented on this branch: the Ricart–Agrawala state machine
is gone, and the home ring, the delegation table, recall with §6 steps 1, 2 and 4, ordered fencing
tokens, the caps, the §4.3 restart quarantine, the generation monotonicity floor and the
transport-swap grant fence are in place, with all three inherited defects fixed. **§6 step 3 — settlement — is not implemented**: a recall revokes capability and then writes
the release without waiting for a native commit already submitted to complete. That is exactly
limitation (2)'s third route in §10, which the contract already states, so the gap is disclosed
rather than hidden — but §6 must not be read as fully implemented. Closing it means hanging the
release hook off logical-transaction settlement rather than off the last admission unlocking. What is not here, and is what keeps the feature unusable rather than merely disabled:
harper-pro#825's operator-agreed home map — core fails closed without one and no core build supplies
one — and harper#2542's freshness fence, without which a handoff carries exclusion but not the
clean-handoff freshness §2 states. **The measurement gate (harper-pro#824) still has not run**, and the decision to
implement ahead of it was the human's, recorded here so the sequence is not mistaken for the one this
note recommends.

One behavior surfaced by implementing §6 is still an open decision, tracked as harper#2580: a
`{hold: true}` write that was staged and then unlocked is **revoked** rather than waited for when a
successor takes the key, so the request fails at commit. That is safe and it is what §6 specifies,
but it is surprising, and the alternative — draining on the transaction rather than the handle —
costs bounded-time handoff. If revoke stands, harper#2547 must say so.

**The documentation obligation is harper#2547, and it is not optional.** §10's rule that the two
limitations may not be softened is the condition on which exclusion-only was chosen over harper#2540;
if Phase 1 ships behind its gate and the public `lock()` page still describes exclusion without them,
the tradeoff that justified the decision was never paid. It lands with or before enablement.
