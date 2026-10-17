# resources/analytics/ — Design notes

Analytics recording and aggregation.

**Read this when:** touching `write.ts` aggregation or the raw-analytics cursor.

Index of every design note: [DESIGN.md](../../DESIGN.md).

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

A raw entry marked `perThread: true` is rolled up per `(metric, path, method, type, threadId)` and stored as one row per thread with `thread` set, the way `path`, `method` and `type` are dimensions. `event-loop-delay` is recorded that way by every thread that has `perf_hooks.monitorEventLoopDelay` (Bun does not): a histogram at 20 ms (`server/eventLoopDelay.ts`). It is reset when a report window opens and read before the flush's first yield, so a report's delay covers its own window, and a stall during an idle gap before the window's first request is not reported (`server/DESIGN.md`). A reset discards the interval up to the next firing, so a stall that begins in the same loop turn as a reset, the flush's or the one that opens a window, is not measured, and if it runs past the deadline the report has no `event-loop-delay` entry. The flush reads one timer turn after its deadline, so a stall that began after the sampler's last firing and ran past the deadline is in that report. The sampled metrics in `PER_THREAD_METRICS` are additionally rolled up per thread under a second name (`duration` as `duration-by-thread`, `count` and `mean` only), never as extra rows of their own metric: a consumer that sums every `duration` row would double count. The per-thread rows cost one row per thread per key per period and are bounded only by the aggregate retention; there is no switch, by choice, until a deployment shows the growth matters. Rows stay flat scalars because the Grafana datasource's Go backend has no case for an object-valued attribute and panics on one.

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
