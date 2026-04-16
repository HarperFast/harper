---
id: overview
title: Analytics
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
			"median": 202,
			"mean": 202,
			"p95": 202,
			"p90": 202,
			"count": 1
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
	"median": 4,
	"mean": 4,
	"p95": 4,
	"p90": 4,
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

### Resource Usage Metrics

| `metric`                  | Key attributes                                                                                   | Other               | Unit    | Description                                                                       |
| ------------------------- | ------------------------------------------------------------------------------------------------ | ------------------- | ------- | --------------------------------------------------------------------------------- |
| `database-size`           | `size`, `used`, `free`, `audit`                                                                  | `database`          | bytes   | Database file size breakdown                                                      |
| `main-thread-utilization` | `idle`, `active`, `taskQueueLatency`, `rss`, `heapTotal`, `heapUsed`, `external`, `arrayBuffers` | `time`              | various | Main thread resource usage: idle/active time, queue latency, and memory breakdown |
| `resource-usage`          | (see below)                                                                                      |                     | various | Node.js process resource usage (see [resource-usage](#resource-usage-metric))     |
| `storage-volume`          | `available`, `free`, `size`                                                                      | `database`          | bytes   | Storage volume size breakdown                                                     |
| `table-size`              | `size`                                                                                           | `database`, `table` | bytes   | Table file size                                                                   |
| `utilization`             |                                                                                                  |                     | %       | Percentage of time the worker thread was processing requests                      |

#### `resource-usage` Metric

Includes everything returned by Node.js [`process.resourceUsage()`](https://nodejs.org/api/process.html#processresourceusage) (with `userCPUTime` and `systemCPUTime` converted to milliseconds), plus:

| Field            | Unit | Description                                 |
| ---------------- | ---- | ------------------------------------------- |
| `time`           | ms   | Unix timestamp when the metric was recorded |
| `period`         | ms   | Duration of the measurement period          |
| `cpuUtilization` | %    | CPU utilization (user + system combined)    |

## Custom Metrics

Applications can record custom metrics using the `server.recordAnalytics()` API. See [HTTP API](../http/api.md) for details.

## Analytics Configuration

The `analytics.aggregatePeriod` configuration option controls how frequently aggregate summaries are written. See [Configuration Overview](../configuration/overview.md) for details.

Per-component analytics logging can be configured via `analytics.logging`. See [Logging Configuration](../logging/configuration.md) for details.

## Related

- [Analytics Operations](./operations)
- [HTTP API](../http/api.md)
- [Logging Configuration](../logging/configuration.md)
- [Configuration Overview](../configuration/overview.md)
