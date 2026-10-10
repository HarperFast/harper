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

A raw entry marked `perThread: true` is rolled up per `(metric, path, method, type, threadId)` and stored as one row per thread with `thread` set, the way `path`, `method` and `type` are dimensions. `event-loop-delay` is recorded that way by every thread that has `perf_hooks.monitorEventLoopDelay` (Bun does not): a histogram at 20 ms (`server/eventLoopDelay.ts`), read and reset on each flush, with the sampling interval subtracted because the histogram records the raw interval between firings. A reset discards the interval up to the next firing, so a stall that begins in the same loop turn as the flush is not measured; the samples that follow it are. The sampled metrics in `PER_THREAD_METRICS` are additionally rolled up per thread under a second name (`duration` as `duration-by-thread`, `count` and `mean` only), never as extra rows of their own metric: a consumer that sums every `duration` row would double count. The per-thread rows cost one row per thread per key per period and are bounded only by the aggregate retention; there is no switch, by choice, until a deployment shows the growth matters. Rows stay flat scalars because the Grafana datasource's Go backend has no case for an object-valued attribute and panics on one.

`byThread` gauges still fold into one row (sum across threads, peaks per thread). The fold walks the measures the thread entries carry, so `period` keeps the aggregation window instead of being zeroed and the row carries no summed `threadId`.
