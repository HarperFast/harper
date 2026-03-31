---
title: System Tables
---

<!-- Source: versioned_docs/version-4.7/reference/analytics.md (primary — analytics system tables) -->
<!-- Source: versioned_docs/version-4.7/developers/applications/data-loader.md (hdb_dataloader_hash) -->
<!-- Source: versioned_docs/version-4.7/developers/replication/index.md (hdb_nodes, hdb_certificate) -->

# System Tables

Harper maintains a set of internal system tables in the `system` database. These tables store analytics, job tracking, replication configuration, and other internal state. Most are read-only from the application perspective; some can be queried for observability or management purposes.

System tables are prefixed with `hdb_` and reside in the `system` database.

## Analytics Tables

<VersionBadge version="v4.5.0" /> (resource and storage analytics expansion)

### `hdb_raw_analytics`

Stores per-second, per-thread performance metrics. Records are written once per second (when there is activity) and include metrics for all operations, URL endpoints, and messaging topics, plus system resource information such as memory and CPU utilization.

Records have a primary key equal to the timestamp in milliseconds since Unix epoch.

Query with `search_by_conditions` (requires `superuser` permission):

```json
{
	"operation": "search_by_conditions",
	"schema": "system",
	"table": "hdb_raw_analytics",
	"conditions": [
		{
			"search_attribute": "id",
			"search_type": "between",
			"search_value": [1688594000000, 1688594010000]
		}
	]
}
```

A typical record:

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

### `hdb_analytics`

Stores per-minute aggregate analytics. Once per minute, Harper aggregates all per-second raw entries from all threads into summary records in this table. Query it for longer-term performance trends.

```json
{
	"operation": "search_by_conditions",
	"schema": "system",
	"table": "hdb_analytics",
	"conditions": [
		{
			"search_attribute": "id",
			"search_type": "between",
			"search_value": [1688194100000, 1688594990000]
		}
	]
}
```

A typical aggregate record:

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

For a full reference of available metrics and their fields, see [Analytics](../analytics/overview.md 'Complete analytics metrics reference').

## Data Loader Table

### `hdb_dataloader_hash`

<VersionBadge version="v4.6.0" />

Used internally by the [Data Loader](./data-loader.md) to track which records have been loaded and detect changes. Stores SHA-256 content hashes of data file records so that unchanged records are not re-written on subsequent deployments.

This table is managed automatically by the Data Loader. No direct interaction is required.

## Replication Tables

### `hdb_nodes`

Stores the configuration and state of known nodes in a cluster, including connection details, replication settings, and revoked certificate serial numbers.

Can be queried to inspect the current replication topology:

```json
{
	"operation": "search_by_hash",
	"schema": "system",
	"table": "hdb_nodes",
	"hash_values": ["node-id"]
}
```

Used by the `add_node`, `update_node`, and related clustering operations. See [Replication](../replication/clustering.md) for details.

### `hdb_certificate`

Stores TLS certificates used in replication. Can be queried to inspect the certificates currently known to the cluster.

## Related Documentation

- [Analytics](../analytics/overview.md) — Full reference for analytics metrics tracked in `hdb_analytics` and `hdb_raw_analytics`
- [Data Loader](./data-loader.md) — Component that writes to `hdb_dataloader_hash`
- [Replication](../replication/overview.md) — Clustering and replication system that uses `hdb_nodes` and `hdb_certificate`
- [Operations API](../operations-api/overview.md) — Querying system tables using `search_by_conditions`
