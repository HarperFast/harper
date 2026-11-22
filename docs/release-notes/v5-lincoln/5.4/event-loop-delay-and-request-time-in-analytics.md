---
section: 'Analytics'
---

### Event-Loop Delay and Request Time in Analytics

Analytics now record three more metrics, so one busy worker among idle ones shows up: `event-loop-delay`, how late each thread's event loop runs, per thread and period, in milliseconds (not recorded on Bun, which lacks `monitorEventLoopDelay`); `duration-by-thread`, one row per worker thread with the count and mean of its `duration` entries, in `hdb_analytics` only; and `request-time`, from dispatch to response, including time in the HTTP request queue, for requests other than `GET`, `HEAD` and `OPTIONS` on Node and uWS. Existing `duration` rows are unchanged. Aggregate rows for gauges summed across threads, such as `memory`, now carry the aggregation `period` instead of `0`, and `memory` and queue-depth rows no longer carry a summed `threadId` ([harper#3110](https://github.com/HarperFast/harper/pull/3110)). See [Per-Thread Metrics](/reference/v5/analytics/overview#per-thread-metrics) and [`request-time`](/reference/v5/analytics/overview#request-time).
