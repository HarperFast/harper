---
id: overview
title: Analytics
sidebar_position: 10
sidebar_label: 'Overview'
---

<!-- Source: versioned_docs/version-4.7/reference/analytics.md (primary) -->
<!-- Source: release-notes/v4-tucker/4.5.0.md (confirmed resource and storage analytics added) -->
<!-- Source: release-notes/v4-tucker/4.7.0.md (confirmed new analytics/licensing functionality) -->

<VersionBadge version="v4.5.0" /> (resource and storage analytics)

Harper collects real-time telemetry and statistics across all operations, URL endpoints, and messaging topics. This data can be used to monitor server health, understand traffic and usage patterns, identify resource-intensive queries, and inform scaling decisions.

## Storage Tables

Analytics data is stored in two system tables in the `system` database:

| Table               | Description                                                                                 |
| ------------------- | ------------------------------------------------------------------------------------------- |
| `hdb_raw_analytics` | Per-second raw entries recorded by each thread. One record per second per active thread.    |
| `hdb_analytics`     | Aggregate entries recorded once per minute, summarizing all per-second data across threads. |

Both tables require `superuser` permission to query.

## Raw Analytics (`hdb_raw_analytics`)

Raw entries are recorded once per second (when there is activity) by each thread. Each record captures all activity in the last second along with system resource information. Records use the timestamp in milliseconds since epoch as the primary key.

Query raw analytics using `search_by_conditions` on the `hdb_raw_analytics` table. The example below fetches 10 seconds of raw entries:

```http
POST http://localhost:9925
Content-Type: application/json

{
    "operation": "search_by_conditions",
    "schema": "system",
    "table": "hdb_raw_analytics",
    "conditions": [{
        "search_attribute": "id",
        "search_type": "between",
        "search_value": [1688594000000, 1688594010000]
    }]
}
```

Example raw entry:

```json
{
	"time": 1688594390708,
	"period": 1000.8336279988289,
	"metrics": [
		{
			"metric": "bytes-sent",
			"path": "search_by_conditions",
			"type": "operation",
			"mean": 201,
			"distribution": [198, { "value": 202, "count": 3 }],
			"count": 4
		},
		{
			"metric": "memory",
			"threadId": 2,
			"rss": 1492664320,
			"heapTotal": 124596224,
			"heapUsed": 119563120,
			"external": 3469790,
			"arrayBuffers": 798721
		},
		{
			"metric": "utilization",
			"idle": 138227.52767700003,
			"active": 70.5066209952347,
			"utilization": 0.0005098165086230495
		}
	],
	"threadId": 2,
	"totalBytesProcessed": 12182820,
	"id": 1688594390708.6853
}
```

Metrics that record sampled values carry `mean`, `distribution`, and `count`. `distribution` is a
percentile-bucket summary of the period's samples rather than every sample: at most ten entries, one
per percentile boundary (`p1`, `p10`, `p25`, `median`, `p75`, `p90`, `p95`, `p99`, `p999`, and the
maximum). An entry is a bare number when its bucket covers a single sample, or
`{ "value": <sample>, "count": <samples> }` when it covers several, so a consumer reading raw
entries must handle both shapes. The aggregate table's percentile fields are rolled up from these
buckets.

## Aggregate Analytics (`hdb_analytics`)

Aggregate entries are recorded once per minute, combining per-second raw entries from all threads into a single summary record. Use `search_by_conditions` on the `hdb_analytics` table with a broader time range:

```http
POST http://localhost:9925
Content-Type: application/json

{
    "operation": "search_by_conditions",
    "schema": "system",
    "table": "hdb_analytics",
    "conditions": [{
        "search_attribute": "id",
        "search_type": "between",
        "search_value": [1688194100000, 1688594990000]
    }]
}
```

Example aggregate entry:

```json
{
	"period": 60000,
	"metric": "bytes-sent",
	"method": "connack",
	"type": "mqtt",
	"mean": 4,
	"p1": 4,
	"p10": 4,
	"p25": 4,
	"median": 4,
	"p75": 4,
	"p90": 4,
	"p95": 4,
	"p99": 4,
	"p999": 4,
	"count": 1,
	"id": 1688589569646,
	"time": 1688589569646
}
```

## Standard Metrics

Harper automatically tracks the following metrics for all services. Applications can also define custom metrics via [`server.recordAnalytics()`](../http/api.md#serverrecordanalyticsvalue-metric-path-method-type).

### HTTP Metrics

| `metric`           | `path`        | `method`       | `type`                      | Unit  | Description                              |
| ------------------ | ------------- | -------------- | --------------------------- | ----- | ---------------------------------------- |
| `duration`         | resource path | request method | `cache-hit` or `cache-miss` | ms    | Duration of request handler              |
| `duration`         | route path    | request method | `fastify-route`             | ms    | Duration of Fastify route handler        |
| `duration`         | operation     |                | `operation`                 | ms    | Duration of Operations API operation     |
| `success`          | resource path | request method |                             | %     | Percentage of successful requests        |
| `success`          | route path    | request method | `fastify-route`             | %     |                                          |
| `success`          | operation     |                | `operation`                 | %     |                                          |
| `bytes-sent`       | resource path | request method |                             | bytes | Response bytes sent                      |
| `bytes-sent`       | route path    | request method | `fastify-route`             | bytes |                                          |
| `bytes-sent`       | operation     |                | `operation`                 | bytes |                                          |
| `transfer`         | resource path | request method | `operation`                 | ms    | Duration of response transfer            |
| `transfer`         | route path    | request method | `fastify-route`             | ms    |                                          |
| `transfer`         | operation     |                | `operation`                 | ms    |                                          |
| `socket-routed`    |               |                |                             | %     | Percentage of sockets immediately routed |
| `tls-handshake`    |               |                |                             | ms    | TLS handshake duration                   |
| `tls-reused`       |               |                |                             | %     | Percentage of TLS sessions reused        |
| `cache-hit`        | table name    |                |                             | %     | Percentage of cache hits                 |
| `cache-resolution` | table name    |                |                             | ms    | Duration of resolving uncached entries   |

### MQTT / WebSocket Metrics

| `metric`           | `path` | `method`     | `type` | Unit  | Description                                      |
| ------------------ | ------ | ------------ | ------ | ----- | ------------------------------------------------ |
| `mqtt-connections` |        |              |        | count | Number of open direct MQTT connections           |
| `ws-connections`   |        |              |        | count | Number of open WebSocket connections             |
| `connection`       | `mqtt` | `connect`    |        | %     | Percentage of successful direct MQTT connections |
| `connection`       | `mqtt` | `disconnect` |        | %     | Percentage of explicit direct MQTT disconnects   |
| `connection`       | `ws`   | `connect`    |        | %     | Percentage of successful WebSocket connections   |
| `connection`       | `ws`   | `disconnect` |        | %     | Percentage of explicit WebSocket disconnects     |
| `bytes-sent`       | topic  | mqtt command | `mqtt` | bytes | Bytes sent for a given MQTT command and topic    |

### Replication Metrics

| `metric`              | `path`              | `method`      | `type`    | Unit  | Description                                                |
| --------------------- | ------------------- | ------------- | --------- | ----- | ---------------------------------------------------------- |
| `bytes-sent`          | node.database       | `replication` | `egress`  | bytes | Bytes sent for replication                                 |
| `bytes-sent`          | node.database       | `replication` | `blob`    | bytes | Bytes sent for blob replication                            |
| `bytes-received`      | node.database       | `replication` | `ingress` | bytes | Bytes received for replication                             |
| `bytes-received`      | node.database       | `replication` | `blob`    | bytes | Bytes received for blob replication                        |
| `replication-latency` | node.database.table |               | `ingest`  | ms    | Time difference from source commit timestamp to local time |

### Storage Metrics

<VersionBadge version="v5.2.0" />

| `metric`                  | `path` | `method` | `type` | Unit | Description                                                         |
| ------------------------- | ------ | -------- | ------ | ---- | ------------------------------------------------------------------- |
| `transaction-commit-time` |        |          |        | ms   | RocksDB write-commit duration, submit to settle, per commit attempt |

`transaction-commit-time` is recorded on the RocksDB asynchronous commit path only; it is not
emitted for LMDB-backed databases, and not for the synchronous `commitSync()` path used during
transaction-log replay. Each sample covers one commit attempt, not one logical write transaction — a
sample is recorded whether the attempt succeeds or fails, and a transient-conflict retry records its
own sample, so `count` can exceed the number of logical writes. A sample is only recorded once an
attempt settles, so a commit that is still outstanding contributes nothing yet. Raw entries
(`hdb_raw_analytics`) carry `mean`,
`distribution`, and `count`; percentiles (`p1`, `p10`, `p25`, `median`, `p75`, `p90`, `p95`, `p99`,
`p999`) are only available on the aggregate (`hdb_analytics`) once raw entries are rolled up. Query
the aggregate table for percentile-based alerting. With the default
[`analytics.aggregatePeriod`](#analyticsaggregateperiod) of 60 seconds, those alerts can observe new
aggregate values no more than once per minute.

The metric shares a timebase with the RocksDB storage engine's overload guard. When a tracked
outstanding commit on a thread exceeds
[`storage.maxTransactionQueueTime`](../database/storage-tuning.md#storagemaxtransactionqueuetime)
(default 45s), Harper rejects new record updates and publishes from new application requests on that
thread with `Outstanding write transactions have too long of queue, please try again later` (HTTP
503). Deletes and writes applied from a canonical source (e.g. replication or a caching source)
bypass this check. The same duration also limits how long a write keeps retrying conflicts with other
writes, which fails with a separate 503, code `TRANSACTION_COMMIT_CONFLICT_TIMEOUT`; see
[`storage.rocks.transactionLogAbortMarkers`](../database/storage-tuning.md#storagerockstransactionlogabortmarkers).

<VersionBadge type="changed" version="v5.2.1" />

Beginning with v5.2.1, the guard tracks every outstanding commit attempt on the thread, including
conflict retries and chained commits, and rejects once the oldest tracked attempt exceeds the limit.
In v5.2.0, only one commit per thread was tracked at a time, so an attempt submitted while another
was already outstanding could be omitted from overload detection.

A rising `p99`/`p999` signals commits are taking longer to drain — from write volume, large
transactions, or a saturated storage volume — and provides an early warning to shed or throttle
write load. However, a wedged commit contributes no sample until it settles —
[`write-transaction-queue-depth`](#transaction-queue-depth-metrics) stays elevated instead. Use this
distribution with the server log: the "Rejecting writes on this thread" error is the authoritative
signal when the guard trips. Tune the threshold against a baseline for your workload.

### Resource Usage Metrics

| `metric`                        | Key attributes                                                                                   | Other               | Unit    | Description                                                                                                                                                                                                                       |
| ------------------------------- | ------------------------------------------------------------------------------------------------ | ------------------- | ------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `cpu-usage`                     | `mean`, `count`                                                                                  | `path`, `method`    | seconds | CPU time the Harper Pro profiler attributes to Harper code (`path: harper`), application code (`path: user`), a hot function (`path: <file>:<line>`), or child processes (`method: child-processes`, Linux only)                  |
| `database-size`                 | `size`, `used`, `free`, `audit`                                                                  | `database`          | bytes   | Database file size breakdown                                                                                                                                                                                                      |
| `main-thread-utilization`       | `idle`, `active`, `taskQueueLatency`, `rss`, `heapTotal`, `heapUsed`, `external`, `arrayBuffers` | `time`              | various | Main thread resource usage: idle/active time, queue latency, and memory breakdown                                                                                                                                                 |
| `profiler-sampling`             | `total`, `count`                                                                                 |                     | ms      | New in v5.4.0. Time the Harper Pro CPU profiler sampled the worker since its previous entry, with `count` 1; that entry's `utilization` is inflated (see [`utilization` and the CPU profiler](#utilization-and-the-cpu-profiler)) |
| `read-transaction-queue-depth`  | `depth`, `maxDepth`                                                                              |                     | count   | Open tracked transactions holding a read handle (see [transaction queue depth](#transaction-queue-depth-metrics))                                                                                                                 |
| `resource-usage`                | (see below)                                                                                      |                     | various | Node.js process resource usage (see [resource-usage](#resource-usage-metric))                                                                                                                                                     |
| `storage-volume`                | `available`, `free`, `size`                                                                      | `database`          | bytes   | Storage volume size breakdown                                                                                                                                                                                                     |
| `table-size`                    | `size`                                                                                           | `database`, `table` | bytes   | Table file size                                                                                                                                                                                                                   |
| `utilization`                   |                                                                                                  |                     | %       | Percentage of time the worker thread was processing requests; inflated while the Harper Pro CPU profiler samples the thread (see [`utilization` and the CPU profiler](#utilization-and-the-cpu-profiler))                         |
| `write-transaction-queue-depth` | `depth`, `maxDepth`                                                                              |                     | count   | In-flight write transaction commits (see [transaction queue depth](#transaction-queue-depth-metrics))                                                                                                                             |

#### Transaction Queue Depth Metrics

<VersionBadge version="v5.2.0" />

`write-transaction-queue-depth` and `read-transaction-queue-depth` expose how many transactions are
in flight against the storage engine per worker thread — a concurrency and throughput signal, not a
reliable predictor on their own of the `Outstanding write transactions have too long of queue, please
try again later` (HTTP 503) rejection: `maxDepth` amplitude reflects concurrent commits, not whether
any single one is approaching the
[`storage.maxTransactionQueueTime`](../database/storage-tuning.md#storagemaxtransactionqueuetime)
duration limit (default 45s) that actually trips the 503.

[`transaction-commit-time`](#storage-metrics) records each commit's submit-to-settle duration on
that same clock, and a rising `p99`/`p999` is a leading indicator of _gradual_ slowdowns approaching
that limit. It doesn't help with a single commit that hangs indefinitely, though: the metric only
records once a commit settles, so a genuinely wedged commit contributes no sample at all, while
`write-transaction-queue-depth`'s `depth` stays elevated on that thread for as long as the commit
remains outstanding. Harper also logs `Rejecting writes on this thread: a commit has been outstanding
for ...` once per stuck commit when the 503 check itself fires, which is the authoritative signal for
that specific failure.

| Field      | Unit  | Description                                             |
| ---------- | ----- | ------------------------------------------------------- |
| `depth`    | count | Instantaneous depth sampled at emit time                |
| `maxDepth` | count | High-water mark since this thread's last emitted sample |

- **`write-transaction-queue-depth`** counts write commits handed to the storage engine whose commit
  promises have not yet settled — how many commits this thread is juggling concurrently. This is
  in-flight, not durability: a settled commit promise means the storage engine accepted the write,
  not that it has been synced to disk.
- **`read-transaction-queue-depth`** counts concurrently open tracked transactions holding a read
  handle, including write transactions and transactions opened with snapshot disabled. A high count
  can mean either many short-lived transactions or a few long-lived ones — the count alone can't
  distinguish them, so use it as a concurrency signal; a duration-based metric would be needed to
  identify a single transaction held open long enough to hold back compaction.

Both metrics are gauges tracked only on the RocksDB write/read path, sampled per worker thread, so
activity against LMDB-backed databases is not counted at all. On a mixed install they report RocksDB
traffic only and silently under-count. They also carry no `database` dimension, so a reported depth
cannot be attributed to a specific database. On an install with no RocksDB databases
(`storage.engine: lmdb`), both always read `0` — indistinguishable from a healthy, empty queue —
regardless of actual read/write load. All per-thread analytics reporting, including these gauges,
piggybacks on the thread having recorded some other analytics-eligible activity in the period — a
thread with no recordable activity in a given second emits no row at all rather than an explicit
`depth: 0`. Absence of a sample is not the same as a healthy reading, particularly for
`read-transaction-queue-depth` on an otherwise-quiet thread holding a single long-lived read.

The raw per-thread entries in `hdb_raw_analytics` retain each thread's true instantaneous `depth` and
per-period `maxDepth`; treat those as the reliable source for spike detection. The aggregate
`hdb_analytics` table is not a sum of per-thread peaks — each thread's `maxDepth` is first averaged
across its raw samples for the period, then those per-thread averages are summed — so a brief
single-thread spike is diluted rather than preserved. Always alert on the `maxDepth` field of each
queue-depth entry in an `hdb_raw_analytics` record's `metrics` array (or lower the
sampling/aggregation period) rather than relying on the aggregate table to catch short spikes. Tune
the concrete alert threshold against a baseline for your workload, since absolute depth scales with
worker-thread count and per-transaction size.

#### `resource-usage` Metric

Includes everything returned by Node.js [`process.resourceUsage()`](https://nodejs.org/api/process.html#processresourceusage) (with `userCPUTime` and `systemCPUTime` converted to milliseconds), plus:

| Field            | Unit | Description                                 |
| ---------------- | ---- | ------------------------------------------- |
| `time`           | ms   | Unix timestamp when the metric was recorded |
| `period`         | ms   | Duration of the measurement period          |
| `cpuUtilization` | %    | CPU utilization (user + system combined)    |

#### `utilization` and the CPU profiler

<VersionBadge type="changed" version="v5.4.0" />

Harper Pro's CPU profiler (see [`analytics.profiling`](#analyticsprofiling)) samples a worker's stack with a timer signal, and while it runs the worker's event-loop idle time is under-counted, so `utilization` reads high: an idle worker can report 70%. The profiler captures one and two `aggregatePeriod`s after application load and then every thousand periods, about 16.7 hours at the default 60 seconds. It now samples only for one period before each capture: from application load until the second capture, and then for one period in every thousand.

A `hdb_raw_analytics` entry whose `metrics` include `profiler-sampling` is one whose `utilization` sample overlapped sampling. Its `total` is the milliseconds sampled since that worker's previous entry, and its `count` is 1. In `hdb_analytics`, the period's `total` is summed over the node's workers, and `count` is the number of entries that overlapped sampling. When using `utilization` as a load signal, set the flagged raw entries aside. An aggregate `utilization` row already includes them, so discard a period whose `profiler-sampling` row has a `count` above 0, or set `analytics.profiling: false`.

## Full-text Analytics

<VersionBadge version="v5.4.0" /> <EngineBadge engines="RocksDB" />

The optional `fulltext` metric reports native search/indexing operations, queues and phases, wrapper logical batches and preparation failures, and cached reader observations. [Configure `analytics.fullText`](../configuration/options.md#analyticsfulltext) to enable it. The omitted block creates no polling timer or full-text export; native accounting still accumulates. Operator collection and persistence also require Harper analytics to be enabled on a writable node: `analytics.aggregatePeriod: -1` disables analytics, and read-only mode (`storage.readOnly`, `HARPER_READONLY` or the `--readonly` flag) disables it. Collection uses already-open handles and never opens a cold index.

The implied cadence is 60 seconds per handle, staggered across writers and readers. Rows use the existing raw/aggregate analytics pipeline, retention and protected [analytics operations](./operations.md). Synchronous snapshots and export have measurable cost; qualify your index count and cadence before enabling them broadly. No production overhead bound is implied.

Read the metric with:

```json
{
	"operation": "get_analytics",
	"metric": "fulltext"
}
```

Rows are flat JSON scalars. `path` is `<database>.<table>/<index>`, with each component percent-encoded and literal dots escaped (`a.b` becomes `a%2Eb`) to keep names distinct. Ordinary names such as `catalog.Product/search` retain that form. Labels with unencodable components or more than 256 encoded bytes use the existing `index:<sha256>` fallback; `method` is `writer` or `reader`. Aggregate rows retain the originating worker `thread`, a bounded-lifetime `series` reset marker and actual `sampledAt` time. Rollups select the newest cumulative row per worker/index/role instead of averaging its counters.

| Field example                                   | Interpretation                                                                        |
| ----------------------------------------------- | ------------------------------------------------------------------------------------- |
| `native_operations_search_completed`            | Cumulative completed native search count.                                             |
| `native_operations_search_queue_sumNanoseconds` | Cumulative native search queue time.                                                  |
| `logicalBatches_completed`                      | Cumulative completed wrapper batches; one batch can contain multiple native frames.   |
| `native_queues_ordinarySearch_commands`         | Current observed queue occupancy, not a cumulative count.                             |
| `native_reader_snapshotBytes`                   | Cached bytes for the observed reader snapshot, not directory size or resident memory. |

Exact bigint counters, nanoseconds, bytes, histogram counts and finite bounds are decimal strings. Decode counters with `BigInt`. Calculate a rate only between complete, available observations of the same `series`, using their exact counter difference and actual `sampledAt` elapsed time. Check integer safety before converting a difference to a JavaScript number. A new series, unavailable sample or incomplete coverage requires a new baseline; a missing interval is not zero activity.

Check `available` and `collectionError` before interpreting observations; `observationAgeMilliseconds` identifies retained data. `activeHandles` and `closingHandles` count handles in that worker/index/role group. `native_reader_snapshotBytesPending` means a byte observation is still pending, not zero bytes. `native_reader_snapshotBytesError` and `native_reader_snapshotBytesAgeNanoseconds` describe that cached observation separately.

`complete: false` flags lost final-handle counts. The next successful live observation starts a new `series` and restores complete coverage; use that observation as a new rate baseline.

Pending rows coalesce in a 128-row buffer per worker, dropping the oldest by first pending insertion on overflow; updating a pending row retains its position. While a group still has live handles, dropping a pending row preserves its cumulative counters for the next observation. After its last handle closes, losing its final pending row can lose those final totals; no later observation or `complete: false` row is guaranteed. `droppedRows` counts buffer evictions per worker and is repeated on its rows; do not sum it across indexes or roles. Workers and the receiving main thread enforce their current collection policy independently. During configuration transitions, the receiver can discard exported rows; those policy-filtered rows are not included in `droppedRows`.

Null can mean unavailable data, an empty queue's oldest age, or the unbounded final histogram bucket. Histogram buckets are noncumulative; their changes cover only intervals when histogram recording was enabled. Harper does not invent percentiles.

Reader reopen and overlapping retired readers carry counters forward while their logical series remains alive. Reader document/segment/generation gauges use the newest eligible observation rather than summing duplicate snapshots. Queue occupancy (`commands` and `bytes`), capacities (`maxCommands` and `maxBytes`) and operation `dispatched` gauges sum live handles of the same role; oldest age uses their maximum. During a reader reopen, overlapping live handles can therefore increase the reported capacity. Shared queue capacities also overlap between ordinary and expensive search, so do not add those capacities or interpret them as a process-wide budget.

Optional histogram recording and reader-byte observation default to off. Byte values can remain pending until a successful index publication or reader reload; enabling observation does not trigger either operation. Setting `analytics.fullText.enabled: false` removes its scheduled collection and export and disables options no remaining internal consumer needs on live handles. Disabling Harper analytics (`aggregatePeriod: -1`) also disables collection and export requested by `analytics.fullText`. A synchronous observation already executing completes, and a closing handle keeps its last options until close settles. Internal consumers are implementation hooks, not a public SDK or subscription API or a requirement for operators to enable analytics; consumer-only collection does not enable persistent analytics.

A `logicalBatches_completed` count describes wrapper batches; `logicalBatches_encodedFrames` and `native_operations_applyFrame_completed` describe transport frames at different stages, not additional batches. One batch can contain several frames, and direct low-level frames have no logical batch, so do not add these counts. Native operation execution timing includes phase work such as commit, reader reload or teardown; do not add `native_phases_*_sumNanoseconds` to the enclosing `native_operations_*_execution_sumNanoseconds`. Do not sum reader document counts across workers. Generation IDs are not source-log positions or freshness timestamps. Metrics do not replace [index readiness](../full-text-search/configuration.md#inspecting-an-index) or [freshness and catch-up controls](../full-text-search/querying.md#freshness-controls). Detailed automatic merge statistics, native cancellation and per-index RSS are unsupported. Query text, terms, record IDs, users, raw cursors, filesystem paths and raw exception messages are not exported labels.

## Custom Metrics

Applications can record custom metrics using the `server.recordAnalytics()` API. See [HTTP API](../http/api.md) for details.

## Analytics Configuration

The `analytics` configuration section controls aggregation, replication, storage-volume sampling and optional [full-text collection](#full-text-analytics). All options are optional.

```yaml
analytics:
  aggregatePeriod: 60
  storageInterval: 10
  replicate: false
  profiling: true
  logging:
    level: info
```

### `analytics.aggregatePeriod`

Type: `number` (seconds)

Default: `60`

How frequently Harper aggregates raw per-second entries into the `hdb_analytics` summary table. Lowering this gives higher-resolution aggregate data at the cost of more frequent aggregation work and more rows in `hdb_analytics`.

### `analytics.storageInterval`

Type: `number`

Default: `10`

Number of aggregation cycles between disk-volume measurements. With the default `aggregatePeriod` of `60` and `storageInterval` of `10`, Harper records `database-size`, `table-size`, and `storage-volume` metrics every 10 minutes. Set to `0` to disable storage-volume sampling entirely — useful when running on systems where `statfs` is expensive or unavailable (e.g., some FUSE mounts).

### `analytics.replicate`

Type: `boolean`

Default: `false`

When enabled, aggregate analytics entries are replicated across the cluster so a single peer can answer aggregate queries for the whole topology. Raw per-thread entries (`hdb_raw_analytics`) are always node-local. Enable when running a centralized analytics consumer; leave disabled in large clusters to avoid replication overhead for high-cardinality metrics.

### `analytics.profiling`

<VersionBadge type="changed" version="v5.4.0" />

Type: `boolean`

Default: `true`

Harper Pro only. Runs the CPU profiler that records the `cpu-usage` metric, attributing CPU time to Harper code, application code, hot functions, and child processes. The profiler samples only in a window of one `aggregatePeriod` before each capture and marks the `utilization` samples it affects with `profiler-sampling`; see [`utilization` and the CPU profiler](#utilization-and-the-cpu-profiler). Set to `false` to never start it.

### `analytics.fullText`

<VersionBadge version="v5.4.0" /> <EngineBadge engines="RocksDB" />

Type: `object`

Default: omitted; operator collection is disabled

Enable and tune optional full-text collection with the [`analytics.fullText` options](../configuration/options.md#analyticsfulltext). Defaults are implied; the block is absent from the shipped default configuration. Changes apply dynamically without reopening indexes. Removing the configuration file reapplies `HARPER_DEFAULT_CONFIG`, `HARPER_CONFIG` and `HARPER_SET_CONFIG` overlays to an empty file, so collection requested only by that file stops; one of those overlays can keep it enabled.

### `analytics.logging`

Type: `object`

Per-subsystem logging override for the analytics writer. See [Logging Configuration — `analytics.logging`](../logging/configuration.md#analyticslogging).

## Related

- [Analytics Operations](./operations)
- [HTTP API](../http/api.md)
- [Logging Configuration](../logging/configuration.md)
- [Configuration Overview](../configuration/overview.md)
