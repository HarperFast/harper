# resources/analytics/ — Design notes

Analytics recording and aggregation.

**Read this when:** touching `write.ts` aggregation or the raw-analytics cursor.

Index of every design note: [DESIGN.md](../../DESIGN.md).

**A reset ends the window that was being flushed too.** After `setAnalyticsEnabled()` returns, no
listener or sink receives a sample recorded before it. Dropping `activeActions` and the timer covers the
window still being recorded; `flushAnalytics()` has already rotated the previous one out and yields once
per action, so it also captures `analyticsGeneration`, which every reset advances, and stops after a
yield, before each listener and before the sink once it changes. A listener that resets keeps the report
it was handed; later listeners and the sink do not get it. Pinned by the two in-flight cases in
`../../unitTests/resources/analytics/aggregationCycle.test.js`.

---

## Analytics aggregation resumes from a raw cursor, which is not a clock (`resources/analytics/write.ts`)

`aggregation()` rolls up the raw reports in `hdb_raw_analytics` one `toPeriod` window at a time —
it stops at `firstForPeriod + toPeriod` so one cycle's main-thread msgpackr decode stays bounded
(#1538) — and resumes, exclusive, from `rawCursor`. Two rules hold that cursor:

- **It only ever moves to a record a cycle actually read.** It used to be one variable with the
  cadence marker, stamped with the cycle's end-of-run `Date.now()`, which discarded the remainder of
  a backlog longer than one window and every report written while the cycle ran, because nothing
  reads below the cursor again.
- **A cycle that reads nothing leaves it where it is.** An empty scan is not proof that nothing is
  there: `recordAnalytics` does not await its `primaryStore.put`, so a report can be uncommitted and
  invisible to the scan while carrying a key older than anything the cycle could compare against. No
  wall-clock reading is safe to put in the cursor for the same reason.

`lastAggregationTime` stays a pure cadence marker, stamped `now` at the end of every completed
cycle, so an idle node still aggregates once per period (#1538). A cycle that stopped at its window
edge sets `aggregationBehind`, which lets the next tick skip that guard: a backlog then drains one
window per half-period tick instead of waiting out the cadence it is already behind on.

Cycles must not overlap. `setInterval` does not await its async callback, so `runAggregationCycle`
holds a single-flight flag — two cycles reading the same cursor roll the same window up twice and
double every count in it.

Still open: `findLastAggregationTime` seeds both markers after a restart from the newest stored
analytics record, whose `time` is an end-of-cycle stamp, so a restart mid-drain can skip the rest of
the backlog; and `storeMetric` discards `table.put()`'s result, so the cursor advances past raw
records whose aggregate rows failed to commit. Both need a cursor persisted with the rows.

## Per-thread rows carry a `thread` attribute under their own metric name (`resources/analytics/write.ts`)

A raw entry marked `perThread: true` is rolled up per `(metric, path, method, type, threadId)` and stored as one row per thread with `thread` set, the way `path`, `method` and `type` are dimensions. `event-loop-delay` is recorded that way by every thread that has `perf_hooks.monitorEventLoopDelay` (Bun does not): a histogram at 20 ms (`server/eventLoopDelay.ts`). The flush reads and resets it before its first yield. A window that opens after an idle gap, more than `analyticsDelay` since the last flush, or at boot, resets it again, so a report's delay covers its own window and a stall during the gap is not reported (`server/DESIGN.md`); a window that opens sooner keeps the histogram, so under sustained load only the flush resets it. A reset discards the interval up to the next firing, so a stall that begins in the same loop turn as a reset is not measured, and if it runs past the deadline the report has no `event-loop-delay` entry. The flush reads one timer turn after its deadline, so a stall that began after the sampler's last firing and ran past the deadline is in that report. The sampled metrics in `PER_THREAD_METRICS` are additionally rolled up once per thread, across all their keys, under a second name (`duration` as `duration-by-thread`, with its `count` and count-weighted `mean`), never as extra rows of their own metric: a consumer that sums every `duration` row would double count. One row per thread per period keeps the cost bounded by the thread count rather than by the number of paths, methods and operation names, so there is no switch; the per-path detail for each thread stays in the raw reports for the raw retention. Rows stay flat scalars because the Grafana datasource's Go backend has no case for an object-valued attribute and panics on one.

`byThread` gauges still fold into one row (sum across threads, peaks per thread). The fold sums the measures the thread records carry and leaves `period` alone, so the row keeps the aggregation window instead of a zeroed `period`, and thread records are built without `threadId`, so the row carries no summed thread id.

## Aggregation folds each measure over only the samples that carry it (`resources/analytics/write.ts`)

A key's raw samples need not carry the same measures: callback metrics (`recordAction(fn)`) and
analytics listeners report whatever fields they have, and a raw backlog can come from another
version. `aggregation()` keeps, per fold target (an action, or one thread's record for `byThread`
metrics), the count of samples that carried each measure in the cycle-local `measureCounts` map —
not on the action, which `storeMetric` persists and aggregate listeners receive. A measure's first
sample seeds it, `max[A-Z]`-named measures fold with `Math.max`, and the rest are a running mean
weighted by that count. A measure in every sample has a count equal to the target's `count`, so it
folds exactly as before; keep the running mean, since sum-then-divide rounds differently.

The `byThread` combination sums every thread record's numeric fields into the entry, so a measure
the key's first sample lacked, or that only some threads carry, is kept. That holds only while a
thread record carries nothing but measures and its `count`, which the thread count then replaces:
the fold keeps `total`/`ratio` on non-thread actions only, so a `ratio` on a thread record is
always a caller's measure.
