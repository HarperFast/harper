---
section: 'Analytics'
---

### Event-Loop Delay and Request Time in Analytics

Analytics now record three more metrics, so one busy worker among idle ones shows up: `event-loop-delay`, how late each thread's event loop runs, per thread and period, in milliseconds (not recorded on Bun, which lacks `monitorEventLoopDelay`); `duration-by-thread`, the count and mean of each worker thread's `duration` entries, in `hdb_analytics` only; and `request-time`, from dispatch to response, including time in the HTTP request queue, for requests other than `GET`, `HEAD` and `OPTIONS` on Node and uWS. Existing `duration` rows are unchanged ([harper#3110](https://github.com/HarperFast/harper/pull/3110)).
