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
  there: worker report delivery does not await its `primaryStore.put`, so a report can be uncommitted and
  invisible to the scan while carrying a key older than anything the cycle could compare against. No
  wall-clock reading is safe to put in the cursor for the same reason.

`lastAggregationTime` stays a pure cadence marker, stamped `now` at the end of every completed
cycle, so an idle node still aggregates once per period (#1538). A cycle that stopped at its window
edge sets `aggregationBehind`, which lets the next tick skip that guard: a backlog then drains one
window per half-period tick instead of waiting out the cadence it is already behind on.

Cycles must not overlap. `setInterval` does not await its async callback, so `runAggregationCycle`
holds a single-flight flag — two cycles reading the same cursor roll the same window up twice and
double every count in it.

`storeMetric` handles synchronous and asynchronous write failures: overload (503) is debug-logged,
other errors are warned, and the sample is dropped without retry. The wedged-commit regression in
`noAbortAfterTxnLog.test.js` keeps rejected metrics from escaping the collector or leaking rejections.

Still open: restart markers come from the newest stored analytics record, which can skip backlog;
aggregate writes are not joined before advancing the cursor, so failed rows are lost. Synchronous
refusals now drop a row instead of aborting a partially written cycle. Durable replay needs a cursor
persisted with the rows.

**Retention cleanup keeps a cursor of its own.** `cleanupExpiredAnalytics` (`cleanup.ts`, used by
`hdb_raw_analytics`, `hdb_analytics` and the model-call writer) deletes keys below `now - retention`
starting from the end of the previous pass on the same store, not from the first key. Keys start with
a timestamp, so the expired rows are a prefix, and a RocksDB delete leaves the row and its tombstone
on disk until compaction: a scan from the first key steps over everything earlier passes deleted, a
cost that grows without bound (#4570). The cursor moves past a batch only after all of that batch's
removals settled successfully; a failed removal leaves it at the start of its batch for the next pass
to retry. A row written below the cursor is left until the next process starts.

Passes are single-flight per store and yield between batches. Where the store has `compact()`, a
process's first pass compacts the expired range before it scans (the scan from the first key would
otherwise walk an earlier process's tombstones; if that compaction fails, the scan runs anyway, since
deletion must not wait on compaction), and later passes compact at most hourly while any deletes are
uncompacted, including after a failed removal; a failed compaction is retried on that cadence. Manual
compaction is exclusive in rocksdb-js, so automatic compaction of the whole database waits while it
runs, and the three tables' compactions, uncoordinated, can queue back to back. Raw and aggregate
cleanup run only on the main thread; the model-call writer's timer runs on every worker that loads it,
so only the worker that owns store maintenance (`ownsStoreMaintenance`) cleans that table.

## A reset ends the window that was being flushed too (`resources/analytics/write.ts`)

After `setAnalyticsEnabled()` returns, no listener or sink on that thread receives a sample recorded on
it before the call; other threads keep their own windows. Dropping `activeActions` and the timer covers
the window still being recorded, and the queue-depth high-water marks restart with it. `actionIndex`
holds only actions an `activeActions` lookup returned, and only for primitive arguments (an object
would key by identity and split per call), so alias spellings and key collisions that `actionKey`
merges stay one action; it is replaced with `activeActions` here and at each rotation, since
a stale index would take later samples into an action nothing reports. The last tuple each metric
remembers lives on its index entry for the same reason, and only an indexed tuple is remembered.
`flushAnalytics()` has already rotated the previous window out and yields after each action it may spend long on
(every action on the main thread, which sorts; only callbacks on a worker), so it also
captures `analyticsGeneration`, which every reset advances, and stops after a yield, before each
listener and before the sink once it changes. A listener that resets keeps the report it was handed, as
do the listeners before it; later listeners and the sink do not get it. Pinned by the three in-flight
cases in `../../unitTests/resources/analytics/aggregationCycle.test.js`.

An `actionRecorder` keeps the action it looked up for one window: `analyticsWindow` advances wherever
`activeActions` is replaced (a reset, and each flush's rotation), and a recorder from an earlier window looks
its action up again. Without the advance it would keep writing into an action a flush already took. Within a
window the flush timer is armed, since only a rotation or an exit disarms it.

A numeric action keeps its samples as runs (a value and a 16-bit count), so a fan-out's sample per subscriber
fills one slot. Runs need not be maximal: 0 and -0 never share one, and a full run starts another.
`distributionOfRuns` gives exactly the distribution sorting every sample gave, radix-sorting the float32 bits
into `Float32Array#sort`'s order (-0 before 0, NaN last). A worker does not sort: its report message lists
each numeric entry's runs beside the report, by the entry's position after its listeners ran, and transfers their
buffers; `recordAnalytics` on the main thread computes the distribution, in a local flush's field order, before
anything stores or reads the row. No entry holds runs, so a callback metric's fields are stored as returned, whatever
their names. A worker's own analytics listeners see `mean` and `count` but no `distribution`. Every worker flushes each
second, so their reports arrive together: the main thread queues them in arrival order and summarizes within
`SUMMARY_TURN_MS` per event-loop turn, a large sort stopping between its passes (`summarizePending`), so a turn
ends at the first check past that budget, the checks falling between linear passes over a report's runs, instead of
after every worker's sorts (8 workers at 1M samples/s each stalled it 84-90 ms when summarized on arrival). The
once-a-second burst is not a backlog: only once the oldest queued report has waited `SUMMARY_BEHIND_MS`, or past
`MAX_PENDING_RUNS` queued (a memory bound, so counted at the room their transferred buffers hold), is a report stored without its distributions, keeping every metric's mean
and count (warned at most once a minute);
aggregation takes a key's percentiles from the bins its rows carry, not from its count, so such a row cannot run
that walk past them. The main thread's own report, queued behind them, follows the reset rule above: one from
before a reset is not stored after it. The final main-thread flush waits for the queue before the raw store's
commit barrier, or a worker's last report would be lost at exit. On RocksDB a raw report is written through a
transaction (`PrimaryRocksDatabase.putOffThread`), since a plain `put` writes on the calling thread and a write stall
would stall the main thread with it. Those commits run on the database's commit threads, which can finish them out of
key order, and the raw cursor above skips a key below one it has read, so they go one at a time; and a RocksDB store
has no commit barrier, so exit waits for them itself. At most `MAX_REPORT_WRITES` reports, and `MAX_REPORT_WRITE_BYTES`
of heap as `estimateReportBytes` overestimates it (every top-level field of every entry, and for a queued report
the distributions it will gain), wait for commits, and the same bound covers the summary queue and the commits together (`admitsWaiting`),
since a report with nothing to summarize still queues behind one being summarized; past it a report is dropped whole
(warned at most once a minute), though one is always admitted when nothing waits. A report waiting behind another
write is encoded when its own write starts, so an entry a listener keeps changing is stored as it is then. A report
from before a reset is not written after it. These commits are not tracked as the thread's
outstanding writes, so a stuck one makes the main thread refuse no writes to other databases. Pinned by
`../../unitTests/resources/analytics/sampleRuns.test.js`.

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

## Full-text collection follows actual handle ownership

`fullTextTelemetry.ts` keeps private per-handle baselines and carries exact counters into a stable worker/index/role series. `nativeFullTextTelemetry.test.js` pins reader churn, wrap/precision, optional recording unions and peer-gauge aggregation; cached aggregate names include null leaves, so a live peer's queue age survives a newest null observation. `nativeFullTextTelemetryClose.test.js` holds backend close across live-peer timer ticks and recording changes: closing handles are neither sampled nor reconfigured until settlement. Completed registrations release references; inactive groups remain until their final row drains. Pending export has a 128-row bound with explicit drop counts. Graceful HTTP/job exit reuses the serialized analytics flush after owner cleanup, drains pending rows and samples open handles without overflowing that bound (`nativeFullTextTelemetryShutdown.test.js`).

`fullTextTelemetryRuntime.ts` joins removable internal consumer demand with live operator policy. The consumer hook is an internal diagnostic/test seam with no production caller yet. Only operator demand enables persistence; persisted optional fields reflect the union of recording requests. No demand means no timer; no cold handles open. Exact counters are decimal strings; `cumulative` retains the newest worker row instead of averaging. Lost final counts force a new series on the next live observation. Overflow prefers replaceable live rows, ordered by last refresh, before final rows; dropped live totals remain recoverable. Main also filters worker rows by its receive-time policy; transition losses, including final rows, do not increment `droppedRows`. Failed closes reconcile deferred recording even with no demand; a never-enabled handle may receive an idempotent configure-off call. `aggregationCycle.test.js` verifies counters above 2^53 survive storage and `get_analytics`.

`watchFullTextTelemetryConfiguration` initializes and reloads through the shared watcher's nested root, environment overlay and transactional `refreshConfigSubtree`; it never reads the missing camel-case flat aggregate. Invalid edits retain valid policy. Missing files retain valid policy and overrides, matching the root watcher; valid edits retire only changed overrides. `fullTextTelemetryConfiguration.test.js` pins initialization, override retirement and deletion/recreation. Native runtime/query policy remains frozen separately. Binding telemetry types are structural: `buildDist.test.mjs` checks compilation and emitted declarations without the optional package.

Final main-thread analytics flush awaits its own raw write, the queued worker reports and their raw writes, then the raw store's commit barrier where it has one. This is commit completion, not a new disk-sync guarantee; the process shutdown deadline still bounds it. `describe_metric` omits null-valued attributes from inferred metadata rather than describing unavailable scalar observations as objects; stored rows and `get_analytics` retain their null values.
