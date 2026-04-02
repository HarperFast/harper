---
id: operations
title: Analytics Operations
---

<!-- Source: versioned_docs/version-4.7/developers/operations-api/analytics.md (primary) -->
<!-- Source: versioned_docs/version-4.7/reference/analytics.md (metric names and descriptions) -->
<!-- Source: release-notes/v4-tucker/4.7.0.md (confirmed new analytics/licensing functionality) -->

Operations for querying Harper analytics data. All operations require `superuser` permission.

Analytics data can also be queried directly via `search_by_conditions` on the `hdb_raw_analytics` and `hdb_analytics` tables in the `system` database — see [Analytics Overview](./overview) for details on the table structure.

---

## `list_metrics`

Returns the list of available metric names that can be queried with `get_analytics`.

### Parameters

| Parameter      | Required | Type     | Description                                                              |
| -------------- | -------- | -------- | ------------------------------------------------------------------------ |
| `operation`    | Yes      | string   | Must be `"list_metrics"`                                                 |
| `metric_types` | No       | string[] | Filter by type: `"builtin"`, `"custom"`, or both. Default: `["builtin"]` |

### Request

```json
{
	"operation": "list_metrics",
	"metric_types": ["custom", "builtin"]
}
```

### Response

```json
["resource-usage", "table-size", "database-size", "main-thread-utilization", "utilization", "storage-volume"]
```

---

## `describe_metric`

Returns the structure and available attributes for a specific metric.

### Parameters

| Parameter   | Required | Type   | Description                    |
| ----------- | -------- | ------ | ------------------------------ |
| `operation` | Yes      | string | Must be `"describe_metric"`    |
| `metric`    | Yes      | string | Name of the metric to describe |

### Request

```json
{
	"operation": "describe_metric",
	"metric": "resource-usage"
}
```

### Response

```json
{
	"attributes": [
		{ "name": "id", "type": "number" },
		{ "name": "metric", "type": "string" },
		{ "name": "userCPUTime", "type": "number" },
		{ "name": "systemCPUTime", "type": "number" },
		{ "name": "node", "type": "string" }
	]
}
```

---

## `get_analytics`

Queries analytics data for a specific metric over a time range.

### Parameters

| Parameter        | Required | Type     | Description                                                                                                             |
| ---------------- | -------- | -------- | ----------------------------------------------------------------------------------------------------------------------- |
| `operation`      | Yes      | string   | Must be `"get_analytics"`                                                                                               |
| `metric`         | Yes      | string   | Metric name — use `list_metrics` to get valid values                                                                    |
| `start_time`     | No       | number   | Start of time range as Unix timestamp in milliseconds                                                                   |
| `end_time`       | No       | number   | End of time range as Unix timestamp in milliseconds                                                                     |
| `get_attributes` | No       | string[] | Attributes to include in each result. If omitted, all attributes are returned                                           |
| `conditions`     | No       | object[] | Additional filter conditions. Same format as [`search_by_conditions`](../operations-api/operations.md#nosql-operations) |

### Request

```json
{
	"operation": "get_analytics",
	"metric": "resource-usage",
	"start_time": 1769198332754,
	"end_time": 1769198532754,
	"get_attributes": ["id", "metric", "userCPUTime", "systemCPUTime"],
	"conditions": [
		{
			"attribute": "node",
			"operator": "equals",
			"value": "node1.example.com"
		}
	]
}
```

### Response

```json
[
	{
		"id": "12345",
		"metric": "resource-usage",
		"userCPUTime": 100,
		"systemCPUTime": 50
	},
	{
		"id": "67890",
		"metric": "resource-usage",
		"userCPUTime": 150,
		"systemCPUTime": 75
	}
]
```

## Related

- [Analytics Overview](./overview)
- [Operations API Overview](../operations-api/overview.md)
