# Bound the out-of-order audit reconciliation walk by the audit-retention floor

Issue: [harper#2642](https://github.com/HarperFast/harper/issues/2642) (P1). Scope: proposed
fixes **1** and **3** only. Fixes 2, 4 and 5 are explicitly out of scope.

Revision 2 — rewritten after planning round 1 returned `better-alternative-exists`. What changed
is recorded in [Planning round 1](#planning-round-1-resolution).

## The invariant this change enforces

> **Below the audit-retention floor a write may contribute only its commutative operations.**
> Everything else it carries is a plain field whose survival is decided by what newer writes did to
> that key — exactly what the purged history no longer answers — so applying one is an inference
> about purged history, and the inference is a function of how much of _this node's_ log happens to
> survive.

## Root cause (traced on `origin/main` @ `78271ac75`)

`resources/Table.ts` `commit()` enters the out-of-order reconciliation walk whenever
`precedesExisting <= 0` and `audit` is on. The loop at `resources/Table.ts:3822`:

```ts
while (localTime > txnTime || (auditedVersion >= txnTime && localTime > 0)) {
    …
    const auditRecord = auditStore.get(localTime, tableId, id, nodeId);   // :3834
    if (!auditRecord) break;
```

Two gaps, both v5-only (v4's LMDB audit store is an O(log n) point read with no per-origin log
files and no purge floor to fall below):

1. **No retention gate at walk entry.** `dedupVersionCouldBeRetained`
   ([#1486](https://github.com/HarperFast/harper/pull/1486), `resources/Table.ts:3690`) gates only
   the two _keyed dedup_ lookups; that PR says so explicitly. When the write is older than every
   entry the audit log still covers, the walk cannot terminate by reaching it — it walks the whole
   retained chain to a purged miss (or the 1000-step cap). On RocksDB each step is an `exactStart`
   lookup that scans to end-of-log on a miss (the cost model already documented at
   `resources/Table.ts:3676`, from harper-pro#480).

2. **`nodeId` is passed raw.** `let nodeId = initialAuditHead.nodeId;` (`:3754`) is
   `existingEntry.nodeId`, `undefined` for a local head.
   `RocksTransactionLogStore.getRange` treats `log: undefined` as _aggregate over every log_
   (`resources/RocksTransactionLogStore.ts:340`), so one step opens all per-origin logs and each
   log lacking the exact key scans to end-of-log. The line immediately above (`:3823`) already
   normalises with `nodeId ?? 0` for the cycle-detection identity.

### Measured baseline (field, 2026-09-16, recorded on the issue)

|                       |                                                                                                                                                  |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| Wedged legs           | 2 of 15 `data` replication legs, **>24 h with zero commits**                                                                                     |
| CPU                   | one `http` worker per receiver at 99.9% / 72.7%; 99.2% of samples in rocksdb-js `next` under `Table.commit` → `RocksTransactionLogStore.getSync` |
| Walk progress         | `Debugger.pause` ×4, always `walkSteps=1`, a different record each time — **≈ one record per several minutes**                                   |
| Logs scanned per step | 17 per-origin logs, 30–37 GB each (~500 GB)                                                                                                      |
| Depth-cap hits        | **0** in 30 h — the cap cannot fire when one step never finishes                                                                                 |
| Incoming writes       | `txnTime` ≈ 2.5 days older than the floor; `expiresAt` 1–2 days past                                                                             |

No self-heal until the sender's retention purges the stretch; a receiver restart re-enters the
same records from the same cursor.

## What the walk does below the floor today

Traced, not assumed:

| incoming write                              | can the walk reach `txnTime`? | current outcome                                                                                                                                                                                                                                                                     |
| ------------------------------------------- | ----------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `fullUpdate` put, newer put/delete retained | yes, at step ≥1               | `write.skipped = true` (`:3886`) — correct LWW, reached after an arbitrarily expensive walk                                                                                                                                                                                         |
| `fullUpdate` put, only patches retained     | no                            | folds the retained patches over the old put; `rebuildUpdateBefore(u, newer, fullUpdate=true)` (`resources/crdt.ts:64`) keeps the newer value for shared keys and **the old put's value for keys no _retained_ patch touched** → resurrects pre-floor fields over the current record |
| patch with a commutative `__op__`           | no                            | the op survives every fold (`resources/crdt.ts:47-63`) and is applied — **this is the contribution that must survive**                                                                                                                                                              |
| patch with plain fields                     | no                            | a field survives iff no _retained_ newer write touched it; writes between `txnTime` and the floor were purged, so the answer is a function of this node's retention state                                                                                                           |
| patch, head's own audit entry purged        | step 1 misses                 | `succeedingUpdates` is empty → `incrementalUpdateToApply ?? recordUpdate` applies the **whole** stale patch over the newer record                                                                                                                                                   |

So the status quo below the floor is not exact reconciliation that this change would be giving up.
It is an approximation whose result depends on how much log this particular receiver still holds —
already divergent across a cluster, and in the last row silently destructive. That is the concrete
disqualifier for "keep the walk, just make each step cheaper".

## Approaches considered

**Different layer — bound the scan in the storage engine (rocksdb-js#676).**
A suffix-minimum stop for absent `exactStart` keys makes each miss O(1) instead of O(log file).
_Rejected as the fix for this issue:_ it changes the cost of a step, not the number of steps. At
the depth cap the walk is still up to 1000 lookups per record across 17 logs, and it is still
entered to compute an outcome the floor already determines. Different repository and release train;
the issue scopes it out deliberately. Complementary, not substitutive.

**Deeper cause — stop producing pre-retention replicated writes.**
This stretch came from a v4 bridge replaying from a pinned position, amplified by the pre-#809
relay duplication (harper-pro#399, harper-pro#809). _Rejected as the fix:_ it does not hold the
invariant. Any sender down longer than the receiver's `auditRetention` produces the same input
legitimately, and so do `setTimestamp` writes and base-copy stragglers. Enumerating the producers
shows the bad state is reachable from routes nobody will retire, so the receive path must survive
it.

**Do less — accept-and-detect: the existing 1000-step depth cap, or a wall-clock bound (issue fix 4).**
The mechanism exists and already degrades gracefully. _Rejected:_ measured, the cap fired **0 times
in 30 hours** on the wedged nodes, because a single step takes minutes; a bound that never triggers
is not a bound. A wall-clock bound would cap damage per record but still pay a multi-minute step
per record across a batch of thousands, and it converts a _determinate_ outcome into the capped
approximation. It is a real, separate improvement — which is why the issue lists it separately and
this task excludes it.

**Do less (variant) — derive the boundary from the physical logs (round-1 plan, now rejected).**
Probe `auditStore.getRange({ start: 1 })` for the oldest retained key across every log. _Rejected
on three facts:_ (a) it is a per-node, physical boundary, so two receivers with identical
configuration compute different boundaries and can durably diverge — the exact property this change
exists to remove; (b) the first _physical_ entry is not a bound on the smallest retained key (the
#1486 comment at `resources/Table.ts:3684` says so itself), which is tolerable for an optional dedup
lookup and not for deciding to discard history-dependent state; (c) it costs one iterator
construction and seek **per log per out-of-order commit** — ~17 seeks × 10,000 stale records for the
field batch — where the alternative below costs one 8-byte read.

**Chosen — consult the database's recorded audit floor at walk entry, and resolve the head's own log.**

_Fix 1._ Before the walk, when the write is strictly older than the head (`precedesExisting < 0`)
and `txnTime` is below `getAuditFloor(auditStore)` (`resources/auditStore.ts:832`), do not enter the
walk:

- `fullUpdate`, or a head with no record (a delete, or a residency-omitted record) →
  `write.skipped = true; return;` with no `writeCommit`, matching the superseded-by-newer-put exit
  at `:3886` and the audit-on superseded exit at `:4015`, so no audit record references the losing
  update's pre-saved blobs.
- otherwise → `incrementalUpdateToApply = commutativeOpsOf(recordUpdate)`, a new reducer in
  `resources/crdt.ts` that keeps the incoming `__op__` fields and nothing else. An op-less patch
  takes the same superseded exit as a full update. Push `{ version: txnLogKey, nodeId: options?.nodeId }`
  onto `additionalAuditRefs`, exactly as the walk does at `:3914`, so an immediate re-delivery is
  caught by the read-your-writes `additionalAuditRefs` check at the top of the block.

### Why the residual is ops only, and not "ops plus the fields the head lacks"

The consultation approved a residual that also kept fields the current head does not carry (the
`rebuildUpdateBefore`-against-the-record rule the audit-off branch uses). Implementing it produced a
counterexample from the repository's own suite, so it was narrowed:
`unitTests/resources/auditDedupRetention.test.js` builds a record with `put {name:'original'}` then
`patch {name:'newer'}`, applies a 30-day-stale `patch {name:'should-lose', count:3}`, and asserts
`count === undefined` — _"a write that predates the record's own initial put is fully superseded by
that newer full put"_. `count` is absent from the head precisely **because a newer full put erased
it**, and a head record cannot distinguish that from "no write ever set this key". Keeping
head-absent fields would have resurrected it.

A plain field's survival is therefore not order-independent: it is decided by whether a later write
touched that key, which is the question the purged region answers and the head does not. A
commutative `add` folds to the same value at any position, which is why it is the one thing kept.
That is also the invariant the issue's own framing states. The cost: a stale patch setting a field
nobody else ever touched, arriving below the floor, loses that field — the _other_ direction of the
same unanswerable question, and the direction that cannot invent data.

The fact that beats each rejected option: **no retained audit entry can sit at or below `txnTime`,
so the walk's only reachable outputs below the floor are the ones listed above** — and computing
them directly costs one 8-byte read instead of up to 1000 end-of-log scans.

_Fix 3._ `let nodeId = initialAuditHead.nodeId ?? 0;` at `:3754` — normalise **at the head**, not at
the lookup call site the issue proposed. See below.

## Why `getAuditFloor`, and how its failure modes are handled

`getAuditFloor` is the repository's single durable answer to "below what point is this database's
audit history untrustworthy". It is written **ahead of** every prune that records one
(`raiseAuditFloor`, `resources/auditStore.ts:642`), it is monotonic, its domain is the audit-log key
— the same domain the walk's `auditStore.get(localTime, …)` lookups address — and it is an O(1)
`getBinary` of eight bytes.

- **`Infinity` (unknown) fails _open_ here.** Every other consumer reads `Infinity` as "no cursor is
  safe"; for this gate the same value must mean "cannot decide — walk", or an unreadable floor would
  silently discard every out-of-order write. The gate is therefore
  `Number.isFinite(floor) && txnTime < floor`.
- **On RocksDB the floor tracks the configured horizon, not retained reality** (its own doc comment,
  `resources/auditStore.ts:820`): whole-log-file purge granularity leaves entries below the horizon
  on disk. Writes in that band get the degraded merge instead of the exact walk. That band is
  already outside `auditRetention`'s guarantee, and `subscribe` and MQTT durable sessions already
  resync rather than resume in it — so this makes the walk agree with the rest of the system rather
  than disagree with it. Verified against the field capture: floor ≈ `Date.now() - 3d` ≈
  2026-09-13T03:48Z, `txnTime` = 2026-09-12T22:39Z, so the gate fires on the reported incident.
- **A restored backup or branch database copies the floor without the logs** — a known, recorded gap
  (harper#2451) shared with every other consumer of this primitive. Not made worse here.

### Which coordinate is compared — `txnTime`, not `txnLogKey`

Round 1 called this a blocker; **overruled**, on the walk's own termination test. The loop exits
usefully only when it reaches an entry whose log key is at or below **`txnTime`**
(`while (localTime > txnTime || …)`, `:3822`), so `txnTime` is the coordinate whose reachability
decides whether the walk can terminate at this write. `txnLogKey` addresses _this write's own_
entry, which is a different question and is already the coordinate `dedupVersionCouldBeRetained`
uses for the keyed dedup. The round-1 counterexample (`version=100`, `txnLogKey=200`, floor `150`) is
exactly the case that decides it, and it decides it the other way: with every retained key ≥ 150, no
step can land at or below 100, so the walk still runs the whole chain to a purged miss and reconciles
nothing exactly — while a `txnLogKey` gate would not fire and would pay for that walk.

One claim an earlier revision of this note carried was wrong, and a review round caught it: a
replication apply does **not** commit under the receiver's current log key. The apply transaction
takes the origin's log key (`resources/Table.ts:3715-3717`, and
`unitTests/resources/dualClockAuditRecord.test.js`'s _an applied write keeps the origin version and
takes the origin log key_), so `txnLogKey` is stable across re-deliveries of the same origin event.
That is what makes the audit ref this change records a usable re-delivery guard, asserted directly in
_applies a re-delivered below-floor op once when the record and log clocks differ_.

## Why fix 3 normalises the head, not the lookup call site

`undefined` does not mean the same thing at the two sources that feed `nodeId`:

- **The head** (`initialAuditHead.nodeId`, from `existingEntry.nodeId` or an audit ref) —
  `undefined` provably means _local_. The record's stored id is
  `options?.recordNodeId ?? options?.nodeId ?? (audit ? getThisNodeId(auditStore) : undefined)`
  (`resources/RecordEncoder.ts:933`), while the id its audit entry is **logged** under is the same
  expression with `?? 0` (`:1005`), and `RocksTransactionLogStore.put` routes on that
  (`logById(nodeId) ?? logById(viaNodeId) ?? this.log`, `:85`; `local` is id 0, `:213`). So _record
  nodeId absent ⟹ its audit entry is in log 0_. `precedesExistingVersion`
  (`resources/Table.ts:7545`) and the walk's own identity string already read it that way.

- **`auditRecord.previousNodeId`**, which `advanceToPreviousAudit` assigns after every step —
  `undefined` means _not recorded_. `readAuditEntry` (`resources/auditStore.ts:1196`) never assigns
  it and nothing ever sets it on a written record, so it is **always** `undefined`; the chain link is
  a bare record version (`previousVersion: existingEntry?.version`, `resources/RecordEncoder.ts:1054`)
  with no log identity, and a cross-origin chain resolves it only by the aggregate lookup.

Putting `?? 0` at the lookup call site, as the issue proposed, would therefore send every step after
the first to the `local` log alone, miss a remote-origin predecessor, `break`, and reconcile against
a truncated chain — a correctness regression traded for the same performance win. Normalising the
head gets the case the issue names (a local head at `walkSteps=1`, the aggregate fan-out in three of
the four field pauses) with no such exposure.

Residual, reported as a finding rather than fixed here: steps ≥ 2 still fan out because
`previousNodeId` is never encoded (and `RocksTransactionLogStore.put:132` writes a field no reader
skips, so were it ever set it would misalign the entry). With fix 1 in place those walks happen only
for in-retention writes.

## A latent record-corruption bug this change surfaced

Round 1 of the pre-push review flagged that `additionalAuditRefs` grows by one per applied
out-of-order write and is persisted with a one-byte count, so 256 refs would wrap it. Writing a test
for that bound found the real limit is far lower and the failure is already reachable on `main`.

`RecordEncoder`'s metadata prefix is reserved through msgpackr's `RESERVE_START_SPACE`, whose byte
count is the **low byte** of the same option word as its flags (`encodeOptions & 0xff`, msgpackr
`pack`). The prefix is `8 + 4 + optional expiresAt/residency/nodeId + 1 + 12 × refs`, so it crosses
255 at roughly **19 refs**, not 256 — and then the record is written with a reserved size neither
side agrees on.

Measured, same fixture, same command, RocksDB — a record given 40 out-of-order commutative applies
through the ordinary reconciliation walk (all in retention, so this change's short-circuit is not
involved):

|                             | record after 40 applies                          |
| --------------------------- | ------------------------------------------------ |
| `origin/main` @ `78271ac75` | `{"count":20}` — `name` gone, 20 increments lost |
| this branch                 | `{"id":"many","name":"head","count":40}`         |

The record decoded as empty partway through and the remaining applies rebuilt it from nothing. So
this is a pre-existing silent data-corruption path on the walk, not one this change introduces — but
the short-circuit reaches the same list by the same rule, so it is fixed here rather than left for
the branch to trip over.

The fix is in the encoder, the layer that owns the prefix: clamp the encoded ref count to what the
remaining prefix budget can hold, computed from the actual `valueStart` rather than a guessed
constant, and write that count. What it drops is the **middle**. Both ends are load-bearing — index 0
is the addressable audit head where the record and log clocks diverge, and the last entry is the
identity a re-delivery of this write is matched on — while the entries between them are older branch
heads, which the code already treats as best-effort (a later in-order write drops the whole list).
Both cardinality paths are pinned by tests, including a re-delivery of the newest event at the bound.

**What the bound costs, stated plainly.** Past roughly 19 distinct un-reconciled identities on one
record, some are no longer representable, so a re-delivery of one of _those_ after its audit entry
has aged out can apply its commutative op twice. That is a real limit, and it is the one every bound
has; the alternative is the unbounded list above, which does not merely lose an identity but
destroys the record. Removing the limit needs a wider or versioned ref encoding, which is a change to
the on-disk record format and belongs in its own issue, not in a P1 receive-path fix.

## Compatibility

No public API changes. Replicated conflict-resolution semantics for below-floor writes do change,
so a cluster mid-upgrade can have an old receiver (retention-fragment merge) and a new receiver
(head-only merge) reach different records for the same stale write. Convergence is restored the way
every other best-effort approximation in this block restores it — the authoritative full-copy record
(`resources/Table.ts:3975`, #1148) — and the pre-change behaviour was itself node-dependent, so the
mixed window is not a new class of divergence, only a differently-shaped one.

## Plan claims to verify

- `verify:` a `put` whose timestamp is below the floor issues **no** walk lookup (asserted on
  `auditStore.getSync` never seeing the head's key), while an in-retention `put` still does.
- `verify:` a below-floor patch carrying `{ __op__: 'add' }` still increments a field the head
  already has a numeric value for — the case `rebuildUpdateBefore` drops and the new reducer keeps.
- `verify:` the same below-floor increment delivered twice applies once (the `additionalAuditRefs`
  re-delivery guard).
- `verify:` a below-floor patch contributes no plain field at all — neither one the head carries
  nor one it lacks — which is what keeps `auditDedupRetention.test.js`'s `count === undefined`
  assertion green.
- `verify:` a below-floor write with an unknown floor (`Infinity`) still walks.
- `verify:` with a local head, the walk's first `getRange` receives `log: 0` — asserted on the
  argument, per the acceptance criteria — and a remote-origin predecessor step still aggregates.
- `verify:` `unitTests/resources/auditDedupRetention.test.js`'s "skips the keyed dedup lookup for a
  version older than the oldest retained log entry" asserts the walk _does_ still run for that
  write; that assertion is what fix 1 changes, so it is updated while its record-state assertions
  (`name === 'newer'`, `count === undefined`) stay green unchanged.
- `verify:` `test:unit:resources` and `test:unit:main` green; end-to-end route stated in the PR.

## Planning round 1 resolution

`Framing-Verdict: better-alternative-exists`. Resolved as follows, per
the `harper-engineering-guidelines` step-6 rule:

| round-1 finding                                                                                            | resolution                                                                                                                                                                                                                      |
| ---------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Better alternative: consume the existing `getAuditFloor` primitive instead of deriving a physical boundary | **Adopted.** It is now _Chosen_; the physical probe is a rejected entry with its three disqualifiers.                                                                                                                           |
| Blocker: `rebuildUpdateBefore(update, record, false)` drops the commutative op it was supposed to preserve | **Adopted** — confirmed at `resources/crdt.ts:49-66`: a plain newer value on a patch fold drops the key regardless of the incoming `__op__`. Replaced with a dedicated `commutativeOpsOf` reducer.                              |
| Blocker: compare `txnLogKey`, not `txnTime`                                                                | **Overruled**, with the disqualifier recorded above: `txnTime` is the walk's own termination coordinate, and gating on `txnLogKey` would never fire for a replication apply.                                                    |
| Blocker: a first-entry probe is not proof that no older key exists                                         | **Moot** — the probe is gone with the physical approach.                                                                                                                                                                        |
| Blocker: iterator failure turned into a destructive conclusion                                             | **Moot** for the same reason; the replacement is a single 8-byte read, and an unreadable floor decodes to `Infinity`, which this gate treats as "walk".                                                                         |
| Significant: per-write all-log fan-out                                                                     | **Moot** — one `getBinary`.                                                                                                                                                                                                     |
| Significant: no durable duplicate identity for an applied below-floor op                                   | **Adopted** — the `additionalAuditRefs` push and its two-delivery test.                                                                                                                                                         |
| Significant: mixed-version rollout divergence                                                              | **Adopted** — stated under Compatibility.                                                                                                                                                                                       |
| Tests                                                                                                      | Adopted, minus the "source-apply through real per-origin logs with purge" item, which is an integration-scale fixture; the PR states the end-to-end route rather than shipping a fixture that does not reproduce the scan cost. |

## Not in scope

Issue fix 2 (drop writes whose `expiresAt` has passed), fix 4 (wall-clock bound + yield on the
live-delivery walk), fix 5 (rocksdb-js#676). Unchanged: in-retention reconciliation, the depth cap
and its `Out-of-order audit reconciliation exceeded depth cap` path, and the two keyed dedup lookups
#1486 already guards.
