# Audit retention and cleanup

Design notes for the audit/transaction-log retention lifecycle: the floor that makes a short replay
detectable, the self-rearming cleanup cadence, and the removal-loop rules. Indexed from the root
[DESIGN.md](../DESIGN.md). Moved out of `resources/DESIGN.md` intact (harper#2711) so that file stays
under its 1000-line budget; no note's content changed in the move.

## Audit retention floor

`Table.subscribe`'s `startTime` replay just begins wherever the audit log now begins, so a consumer
resuming below the retention horizon is silently handed a short replay. The floor is the primitive
that makes that detectable (harper#2447). It is internal, with deliberately no public accessor, and **no
resume path consumes it yet**: harper#2448 is to put the check inside `Table.subscribe` itself — the same shape as
replication's `shouldForceBaseCopyForRetention`, and the only one where the floor cannot move between
being read and being acted on. Until then the short replay above is unchanged.

**The one consumer today is not a resume**: `Table.commit`'s out-of-order reconciliation reads the
floor before entering the audit walk (harper#2642). The walk terminates at the incoming write only by
reaching an audit entry at or below its version, so below the floor it cannot — it runs the whole
retained chain, one RocksDB end-of-log scan per step, to an outcome the floor already determines.
Two things that consumer does differently from a cursor check, and both are deliberate: it compares
the write's record version rather than a log key, because that is what the walk's own loop condition
compares; and it treats the `Infinity` unknown floor as **walk anyway** rather than as "not safe",
because here the conservative direction is to do the work, not to skip it. Below the floor a write
contributes only its commutative operations — a plain field's survival depends on what newer writes
did to that key, which is exactly what the pruned history no longer answers.

**The invariant: every path that prunes audit history raises the floor BEFORE removing anything.**
There are five, and the ordering is the whole guarantee — a floor written after the removal is lost
if the process dies in between, and the surviving lower floor then certifies a cursor whose history
is gone. Over-reporting (a floor covering more than the prune actually removed) costs a consumer one
unnecessary resync; under-reporting loses its data with no signal. So `raiseAuditFloor` is called
first and a throw from it is what stops the prune.

| Prune path                                                                   | Engine                                                                      |
| ---------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| `scheduleAuditCleanup` retention loop (`auditStore.ts`)                      | LMDB                                                                        |
| `scheduleAuditCleanup` → `purgeLogs`                                         | RocksDB                                                                     |
| `purgeAgedLogs` (boot/recovery, called from `replayLogs.ts`)                 | RocksDB                                                                     |
| `Table.deleteHistory`                                                        | LMDB (`RocksTransactionLogStore.remove()` is a no-op, so it must NOT raise) |
| `delete_transaction_logs_before` whole-database branch (`ResourceBridge.ts`) | RocksDB                                                                     |

Things that are easy to get wrong here:

- **The floor cannot be derived from the surviving log.** For four of the five paths the oldest
  surviving entry would do, because they prune a database-wide time prefix. `Table.deleteHistory`
  removes one table's entries from a database-scoped log, so a sibling's entry survives _below_ the
  newest entry it removed, and a floor taken from that survivor certifies cursors over removed history.
- **The record's presence is the trust marker.** `Symbol.for('audit-floor')` is a different key from
  `last-removed`, which is still live and still maintained by the LMDB retention loop (#2338 hardened
  its write path and added tests for the retry-carry — do not remove it). They coexist because they
  answer different questions: `last-removed` records where the LMDB loop got to, after the fact,
  while the floor is written ahead of every one of the five prune paths and its commit is verified.
  A value found under `last-removed` therefore cannot be told apart from one carrying those
  guarantees, which is why the floor needs its own key rather than reusing it.
- **A store with no floor record is a store whose retention history we cannot account for.** That
  includes the empty audit store an LMDB→RocksDB migration leaves behind, since `bin/copyDb.ts`
  deliberately does not migrate it, and the audit-DBI-less result of a table-scoped backup taken
  without `include_audit` — so `openAuditStore` stamps `max(Date.now(), newest retained key)` as a
  one-time resync epoch. There is no permissive-baseline case: creating the audit DBI proves the
  DBI was absent, not that the database is new.
- **That epoch is a guess, and it is recorded as one.** Its bound is surviving state, which cannot see
  history a selective prune already removed: a legacy `deleteHistory` takes one table's entries out of
  the shared log, so a table that held the newest entries can leave the newest _survivor_ older than
  entries that are gone, and a clock rolled back between the two stamps a floor below them (#2458).
  Refusing to stamp is worse — `AUDIT_FLOOR_UNKNOWN` is absorbing (`raiseAuditFloor` cannot lift it,
  `establishAuditFloor` skips any existing record), so it would make every upgraded deployment fail
  closed forever. So `establishAuditFloor` writes the epoch under `Symbol.for('audit-floor-bootstrap')`
  first, then stamps the floor from what that record holds.

  **The record's presence is the signal; comparing it against the floor is not.** A store carrying one
  has an unverified pre-tracking window for as long as the record exists, however far the floor has
  since moved — a prune raising the floor above the epoch certifies only what that prune removed, and
  says nothing about history removed before tracking began, which may sit _above_ the epoch, since that
  is precisely what the guess could not see. Worked example: a v4-era `deleteHistory` removes tableA up
  to t=1000 while sibling tableB's newest survivor is 900; a rolled-back clock stamps bootstrap=900 and
  floor=900; a later retention pass raises the floor to 950. A repair keyed on `floor > bootstrap` would
  read 950 > 900, call it earned, and leave a consumer at cursor 970 certified over tableA's missing
  950–1000. So the mark is retired by a database generation (#2451), never by a floor that climbed past
  it; what the recorded _value_ is for is telling that repair how far the guess reached.

  Two properties it does depend on. **Ordering:** the record is written first, so a crash between the
  two writes leaves a record with no floor, which the next open retries because the early return tests
  the _floor_. **Undecodable bytes are overwritten** rather than kept — unlike the floor, where a
  present record may be a deliberate `AUDIT_FLOOR_UNKNOWN` and rewriting it would lower a floor.
  Keeping torn bytes pinned the store to unknown _forever_: the resolver skipped the write because a
  record existed, the read back failed identically on every later open, and no retry could succeed.

- **`getHistory` is not in the floor's time domain.** The floor is an audit-log key, which is what
  `subscribe`'s events carry as `localTime`; `getHistory` reports each entry's origin `version` under
  that same name, and a backdated or replicated write makes the two differ. A cursor saved from
  `getHistory` cannot be compared against the floor.
- **On RocksDB the floor tracks the configured retention horizon, not retained reality.** Whole-log-file
  purge granularity means the branch cannot know which entries a purge will drop, and the floor is
  written first, so each pass advances it to `Date.now() - auditRetention/(1+priority²)` whether a
  file was dropped or not. Entries below that horizon are often still on disk, and a cursor among
  them is told to resync — conservative in the safe direction only. LMDB can see a single eligible
  entry, so it raises off the first one it finds instead.
- **A prune's clamped floor can sit past `Date.now() + 1`.** `boundedAuditPruneEnd` records `newest + 1`
  when the newest log key is at or past the clock, and log keys are fractional `getNextMonotonicTime`
  values, not `Date.now()`, so for the rest of that key's millisecond the floor exceeds the wall clock
  by more than one. Bound it by the newest key, never the wall clock alone (`auditFloor.test.js`, the
  far-future `deleteHistory` case — it failed twice on main that way).
- **Untrustworthy metadata resolves to `Infinity`, not to a number.** A wrong-length record, or eight
  bytes decoding to NaN/negative, must not become a floor: `cursor < NaN` is false, so a consumer
  spelling the check that way would read corrupt metadata as safe.
- **A restore is outside what the floor can see.** `restore_backup` reinstalls the backup's floor
  along with everything else, so a cursor from after the backup point reads as safe against it. The
  audit floor is one of three carriers of resumable state a restore rolls back (record versions and
  per-node `Symbol.for('seq')` records are the others), so this wants a database-level generation
  rather than a fix in this one field — harper#2451.

---

## Audit-entry removal loops must track every `removeAuditEntry()`/`removeEntry()` promise

`scheduleAuditCleanup` (`auditStore.ts`) and `Table.deleteHistory` (`Table.ts`, the LMDB path behind
`delete_transaction_logs_before`) both iterate a range of audit records and remove each one. Any loop
that removes audit/primary-store entries in a batch must attach a rejection handler to every removal
immediately and drain all tracked promises before returning — never stash a per-iteration promise in
an outer variable to await only the last one: an overwritten promise's rejection is never awaited or
caught, and surfaces later as an unhandled rejection with no log to explain it. `Table.deleteHistory`
allows up to 1,000 LMDB removals in flight
(ten for RocksDB) so storage writes batch without growing an unbounded pending
set. Live removals are tracked in a `Set`, and each one removes itself and wakes at most one parked
producer when it settles, so any completion releases the loop. In these removal loops, do not repeatedly
race the live set: each race attaches another reaction to every long-pending removal. Both phases drain
their tracked removals before settling, including when iteration throws. `scheduleAuditCleanup` remains
sequential because it is an automatic background loop, and it ends a pass at its first failed removal
rather than continuing past it: its `deleted` count (the backoff input) and the `last-removed` marker it
writes then cover a contiguous removed prefix — nothing above that marker was removed by the pass — and
the next pass retries the failed entry first. Past a failure there is no key the marker can truthfully
record, and counting failures as progress re-armed an all-failing pass at 10 ms. The guarantee is
pass-local: the marker is written after its removals, `deleteHistory` never writes it, and a marker an
older build persisted past a failed entry is not repaired; completeness is the audit floor's question.
Stopping costs liveness only for an entry that fails on every pass, which is why `removeAuditEntry` must
fail only when `auditStore.remove()` does (below). Regression: `auditLog.test.js` "ends a pass at a failed
removal".

Individual removal failures are logged and excluded from the returned count, but a purge that attempted
at least one removal and completed none rejects with the first error after both phases have drained.
Without that, `delete_transaction_logs_before` reports a successful `entries_deleted: 0` whether nothing
was eligible or the store rejected every write, and an operator pruning to bound disk growth has no signal
that pruning did nothing. Drain first, then decide: a failing store should still get every removal it can
accept, and a single success means the purge made progress and reports normally.

The optional primary-store cleanup snapshots each tombstone's key and version before yielding and passes
that version to `remove()`. LMDB enforces the condition natively. Harper's RocksDB adapter re-reads and
removes inside one native transaction, retrying a conflict once, because rocksdb-js's `remove()` accepts
an options object rather than an LMDB-style version argument. Never replace this with a separate live read
followed by an unconditional remove: a record recreated between those operations would be deleted.

`removeAuditEntry` has a second, nested version of the same hazard: for a `'delete'`-type audit record it
also invokes a per-table delete callback (`addDeleteRemovalCallback`) that removes the corresponding
primary-store tombstone. That callback's promise must be returned and joined with the audit-store
removal (currently via `Promise.all`, with the callback's own rejection — and a throwing tombstone
lookup, such as lmdb-js `getEntry(undefined)` for an undecodable recordId — caught and logged through
`warnContained`, so neither a failed tombstone cleanup nor a throwing log sink gets misreported as a failed
audit-entry removal) — otherwise the tombstone removal is fire-and-forget and the same detached-rejection
hazard reappears one level down.
A tombstone whose cleanup fails this way is not swept automatically — `scheduleAuditCleanup`'s automatic
pass never retries it, since the audit entry that would have triggered a retry is already gone. It sits
in the primary store until an operator runs `delete_transaction_logs_before` with `cleanup_deleted_records: true`.

## Audit retention cleanup is a self-rearming, engine-independent lifecycle

One call to `scheduleAuditCleanup` establishes a retention cadence that ends when the root store closes
(or immediately in process-wide read-only mode). Storage-engine selection changes the work inside each pass, not whether the timer,
serialization barrier, error containment, and re-arm exist. LMDB removes bounded batches of audit
entries; RocksDB asks rocksdb-js to purge conservatively eligible log segments before the same time
cutoff. Disk-pressure callbacks may accelerate the next pass and shorten the effective window, but
ordinary retention progress must not depend on pressure.

The two engines do not share a cadence rule, because their units of progress differ. LMDB's adaptive
backoff reads a per-entry delete count: it speeds up while entries are being removed and doubles while
idle. Rocks reclaims whole segments whose eligibility changes only on rotation/flush, so the same
signal would only make it rescan the same files — its delay is instead a pure function of the
pressure-adjusted retention window (a tenth of it, floored at `DEFAULT_AUDIT_CLEANUP_DELAY`).

Exactly one Rocks purge loop exists per store, and that is owned by the **arming** sites, not the
re-arm: `onStorageReclamation` registers its handler only on the last worker (it takes no
`skipThreadCheck`), and the store-open arm gates on the same index. The last-worker conjunct on the
re-arm is therefore unreachable through either of those paths; it is a backstop for a direct caller
of the exported `scheduleAuditCleanup`, because a store-wide segment purge looping on every worker is
duplicated work. If a future change passes `skipThreadCheck: true` at the registration site, that
backstop — not the registration — becomes the thing keeping the loop single.

Both re-arm guards are **Rocks-only**. The LMDB arm re-arms unconditionally, so it neither yields to
an already-pending pass (a pressure-armed 100ms pass can be cancelled and replaced by the idle
backoff) nor restricts itself to one worker — pre-existing LMDB behavior, not an invariant.

Two things a purge does **not** need to coordinate, both load-bearing for the continuous cadence.
Unlinking a segment a consumer has mapped is safe **on POSIX**: the inode outlives the unlink, and the
mapping cache (`_logBuffers`) holds `WeakRef`s, with a strong ref only on the newest segment, which is
never purge-eligible — so nothing pins a purged inode and no cross-worker cache invalidation is
required. Windows does not share that property: deleting a mapped segment raises a sharing violation,
so the purge throws, is warn-logged, re-arms, and makes no progress for as long as a consumer holds the
mapping. The continuous cadence therefore turns a Windows retention stall into a steady state rather
than a one-off, and nothing covers it — the Rocks retention integration test skips win32.
What is _not_ covered is the segment a lagging consumer has not mapped yet: `TransactionLog.query()`'s
iterator returns `done` when its next segment cannot be mapped, indistinguishable from being caught up
(rocksdb-js `src/transaction-log-reader.ts`). A consumer that far behind needs a full copy rather than
log replay, so the gap is a missing escalation signal in the reader, not a reason to hold retention —
tracked as HarperFast/rocksdb-js#805. Continuous retention is what moves it from unreachable-in-steady-state
to routine: a peer offline longer than `logging.auditRetention` now resumes into a purged prefix and is
recorded as caught up, and `txnlogReplayGapBytes` observes the gap without escalating on it.

Retirement is two things, and teardown needs both. `stopAuditCleanup()` latches the loop closed and
cancels the pending timer, and it **returns a drain barrier** — a promise that settles once the pass
already running has finished. The barrier is what makes closing stores safe: lmdb-js stamps the DBI
number into its write instruction synchronously and the native writer consumes it later
(`node_modules/lmdb/write.js`), so a pass suspended inside `await removeAuditEntry()` still has a
delete pending against the primary and audit DBIs, and LMDB forbids closing a DBI an existing
transaction has modified. `dropDatabase()` and the legacy arm of `Table.dropTable()` await it.
`closeDatabase()` and branch `close()` close commit admission, then drain tracked Rocks transactions,
table maintenance, audit cleanup, and derived-index work before closing stores. Every environment
touch remaining in a resumed cleanup pass — cursor advance, cursor release, marker write, re-arm —
also re-checks `rootStore.status`. `resetDatabases()` closes LMDB roots with no retirement call at all,
so that re-check is a routine
path rather than a defensive one.

The last-removed marker is retained until it commits. A rejected write is logged and carried to the
next pass rather than dropped: a pass that deletes nothing never reaches the write again, so one
transient failure would otherwise leave the recorded boundary permanently behind the entries that
were already removed.
