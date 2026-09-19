# Resume analytics aggregation from the last raw record it rolled up

Trigger: `main` on HarperFast/harper-pro went red at
[8b570b7db](https://github.com/HarperFast/harper-pro/actions/runs/35429157113) —
`integrationTests/cluster/replicatedAnalyticsUnion.test.mjs:280` "returns each node's local
analytics exactly once after a second write phase", one leg only (`Cluster Integration Tests 5/6
(Node.js v22)`; the same shard passed on v24 and v26.5.0 at the same SHA).

Revision 2 — planning round 1 returned `better-alternative-exists`; what was adopted and what was
overruled is recorded in [Planning round 1](#planning-round-1-resolution).

## The invariant this change enforces

> **The aggregation marker never advances past a raw analytics record that was not rolled up.**
> A cycle rolls up one `toPeriod` window and then stamps the marker with wall-clock `now`, so
> every raw record between the end of that window and the end of the cycle is skipped for good.

## Root cause (traced on `HarperFast/harper` `origin/main` @ `8cef16e05`)

`resources/analytics/write.ts`:

- `recordAnalytics` writes one raw record per thread-report, keyed by `getNextMonotonicTime()` —
  wall-clock milliseconds with sub-ms tie-breaking (`utility/lmdb/commonUtility.ts:111`) — at
  `:1243-1244`.
- `aggregation()` scans raw records from the marker, exclusive (`:941-945`), and **stops one
  `toPeriod` after the first record it saw**: `if (key > firstForPeriod + toPeriod) break;`
  (`:948`).
- At the end of the cycle it sets `lastAggregationTime = now` (`:1100`), where `now = Date.now()`
  is taken _after_ the scan (`:1057`).
- The next cycle starts at that marker, exclusive. Raw records whose key falls in
  `(lastKeyAggregated, now]` are therefore never read again.

Two producers of records in that gap:

1. **A delayed cycle.** The scheduler ticks every `AGGREGATE_PERIOD / 2` (`:1216`) and the cadence
   guard (`:934-935`) only runs a cycle once a whole period has elapsed. When a tick is late by
   more than one period — a loaded host, a busy main thread — the backlog spans more than
   `toPeriod`, the loop breaks partway through it, and the remainder is dropped.
2. **Records written during the cycle itself.** The scan yields to the event loop per record
   (`await rest()`, `:1001`) and the cycle's tail awaits volume metrics and the node-storage walk
   before stamping the marker, so a report arriving in that span is also behind `now`.

The defect predates the O(1) marker: before
[harper#1541](https://github.com/HarperFast/harper/pull/1541) the marker came from a reverse scan
that returned the newest local analytics record's `time`, which is the unconditionally-written
resource-usage record stamped with the same end-of-cycle `now`. #1541 preserved those semantics.

### How that reddens the test

`replicatedAnalyticsUnion` writes 2 records to node A and 3 to node B, then waits up to 45 s for
**at least one** `db-write` aggregate row per node for that table. Those writes produce one raw
record per reporting thread. No further writes to that table happen until the wait succeeds, so if
the one raw record carrying them lands in the dropped gap, no later cycle can recover it and the
wait can only time out. The observed failure is exactly that shape: `last saw 0 in []` for
`127.0.0.6` after 45 s, with the peer node green.

verify: the drop is read off the source above; the CI run supplies the symptom, not the mechanism.
The mechanism is pinned by the regression test below (fails on base, passes with the fix).

## Approaches considered

| Axis                | Candidate                                                                                                                                                      | Disposition                                                                                                                                                                                                                                                                                                                                                                                         |
| ------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Different layer** | Harden the harper-pro test: keep writing to the table while waiting for its analytics, so a lost sample is replaced.                                           | Rejected. The loss is in core's aggregation, and it silently undercounts `get_analytics` for every metric on every node — a test that writes around it removes the only current detector and leaves the product defect in place. It also weakens the suite's stated contract (the union assertions compare exact counts against a settled baseline).                                                |
| **Deeper cause**    | Drop the one-window `break` and aggregate the whole backlog in a single cycle, which makes `marker = now` true by construction.                                | Rejected. The break is the main-thread cost bound: the loop msgpackr-decodes each raw report inline, the cost class #1538 was opened to fix. A backlog up to `analytics.rawRetentionMs` (1 h default, `:1139`) would decode in one cycle. It also collapses distinct periods into one row — `value.time = lastTime` with `period: toPeriod` (`:983`, `:1047`) would misreport the window it covers. |
| **Do less**         | Advance the marker to the window's own end, `firstForPeriod + toPeriod`, instead of the last record read.                                                      | Rejected. When raw records are sparse the window end is later than the last record, and a record written after this cycle's scan with a key below that end would still be skipped — the same defect with a smaller gap. There is no config knob for this and accept-and-detect (log a warning) does not restore the sample.                                                                         |
| **Chosen**          | Resume the next cycle from the last raw record actually rolled up: `lastAggregationTime = lastTime ?? cycleStart`, with `cycleStart` captured before the scan. | Only option that makes the marker a statement about what was consumed rather than about when the cycle ended. Both gap producers close: an over-long backlog resumes at the break, and a record written during the cycle is above `cycleStart`.                                                                                                                                                     |

**No change to the cadence guard is needed, and catch-up is self-limiting.** While the marker is
behind by more than one period, `Date.now() - toPeriod < lastForPeriod` is false, so every
half-period tick drains one more window — draining a stall of S seconds takes S seconds and then
the guard resumes throttling to one cycle per period. An empty window falls back to `cycleStart`,
preserving #1541's idle-cadence behavior.

## Change

`resources/analytics/write.ts`:

- Capture `cycleStart = getNextMonotonicTime()` before the raw scan and set
  `lastAggregationTime = lastTime ?? cycleStart` in place of `= now`, where `lastTime` is the last
  raw key the cycle actually rolled up. `cycleStart` has to come from the sequencer that keys the
  raw records, not from `Date.now()`: the sequencer recalibrates against the wall clock only every
  60 s, so a raw key can fall below a `Date.now()` taken after it.
- Guard `aggregation()` with a single-flight flag released in `finally`, so a tick cannot enter
  while the previous cycle is still scanning.

Advancing to `cycleStart` on an empty window loses nothing — nothing exists after the marker, and
`recordAnalytics` and the cycle share one main-thread sequencer, so a record written after
`cycleStart` carries a higher key — and it keeps #1541's idle cadence.
The rule is safe whether or not the raw `getRange` is a snapshot: a record that the scan did see
sets `lastTime` to its own key, and one it did not see has a key above `cycleStart`.

`unitTests/resources/analytics/aggregationCycle.test.js` (new): drives the real cycle rather than a
helper. With a test DB path and `hdb_raw_analytics` seeded with reports spanning more than one
period, it runs `runAggregationCycle` (the existing `aggregation()`, exported for tests as
`findLastAggregationTime` was) twice and asserts every seeded metric is present in `hdb_analytics`
exactly once, and that a second cycle entered while the first is running does not re-aggregate the
same window.

`DESIGN.md`: record the marker invariant next to the aggregation description.

### Known limits, not addressed here

- **Cold start.** `findLastAggregationTime` (`:890`) seeds the marker from the newest stored
  analytics record, which is still the end-of-cycle-stamped resource-usage row, so a restart
  during a catch-up drain can skip the whole remaining backlog, not one window. Unchanged by this
  fix; closing it needs a durable cursor (see below).
- **Raw retention.** `cleanup` deletes raw records older than `rawRetentionMs` regardless of the
  marker, so a stall longer than that retention still loses the oldest part of its backlog.
- **Catch-up side effects.** While draining, a cycle's per-cycle metrics (resource usage, DB/table
  sizes, RocksDB stats) are written every half period rather than every period, and the
  resource-usage `period` field shortens to match. The node was writing none of them during the
  stall that caused the backlog.

## Verification route

- Core unit gate (`test:unit:resources`) including the new regression tests, plus the fails-on-base
  check (assert the current `= now` rule and show the new tests fail).
- End to end: harper-pro's `integrationTests/cluster/replicatedAnalyticsUnion.test.mjs` against a
  `dist` built from this core. The failure it reproduces is a low-frequency CI flake (first failure
  in ~25 main runs since the test landed 2026-09-03), so a green local run is corroboration, not
  proof; the unit-level fails-on-base check is the mechanism proof.

## Planning round 1 resolution

Verdict: `better-alternative-exists`. The proposed better design was to split the marker into a
cadence timestamp and a raw cursor, persist that cursor in `hdb_analytics` atomically with the
rows derived from the window, await the commit before advancing it, and serialize cycles.

**Adopted**

- **Single-flight guard.** `setInterval` does not await its async callback (`:1209-1217`), so two
  cycles can overlap. Base already allows that whenever a cycle runs longer than a period; this
  change makes it likelier, because during catch-up the cadence guard stops rejecting ticks. Taken.
- **Test the real cycle, not a helper.** The originally-planned fake-store tests would have proved
  only that a new helper returns what it was written to return. The regression test now seeds
  `hdb_raw_analytics` and runs the production `aggregation()` twice, which is what fails on base.
- **Drop the `openRawAnalyticsWindow` export.** With the real cycle under test there is no reason
  to add module surface or a generator step per decoded raw row; the scan loop stays inline.
- **Correct the cold-start bound.** The note claimed restart loss was bounded by one cycle. It is
  not: a restart mid-drain reseeds from an end-of-cycle timestamp and skips the rest of the
  backlog. Restated above.

**Overruled, with the facts**

- **Durable cursor record in `hdb_analytics`.** `hdb_analytics` is a user-visible table: it is what
  `get_analytics` reads, what metric discovery enumerates, and what the replicated union fan-out
  concatenates across peers (harper#1130). A new persisted record shape there is a new API surface
  with its own compatibility, filtering and key-collision design, and it does not touch the
  reported defect, which is loss inside one running process with no restart involved. It is the
  right follow-up, not this change.
- **Commit-tied cursor advancement.** `storeMetric` discards `table.put()`'s result (`:287-296`) on
  base too, so a rejected aggregate write already loses its rows _and_ advances the marker past
  their source. This change does not make that worse, and making the cursor transactional requires
  the durable cursor above to exist first. Filed as a follow-up together with the unhandled
  rejection `storeMetric` can produce.
- **Cleanup constrained by the cursor, cursor-lag metric, alerting.** All downstream of a durable
  cursor; the same follow-up.

## Review round 1 resolution

- **`cycleStart` from `getNextMonotonicTime()`, not `Date.now()`** — adopted. All three graded legs
  reported the clock mismatch (calibration truncation, forward step, backward step); the shared
  sequencer closes all three, where clamping with `Math.max` closes only the backward step.
- **Dead cadence delay in the regression test** — adopted. With the marker held back the guard is
  already open, so the test now runs its cycles back to back and asserts the uninterrupted drain.
- **Test starts the production scheduler** — adopted. The bootstrap `recordAction` starts it, so the
  test pins `analytics.aggregatePeriod` to an hour first.
- **Comment narration** — adopted in the source and the test. Not in this note: `docs/design/` is
  where this repo keeps a design's planning history (see `audit-walk-retention-floor.md`, whose
  revision line and `Planning round 1` section have the same shape).
- **Durable/commit-tied cursor, and the unhandled rejection an aggregation error can raise** —
  still out of scope, for the reasons in the planning resolution above; the adjudicator classed both
  as pre-existing.
