---
id: analytics
title: Analytics
---

<!-- Source: harper resources/models/analyticsTable.ts, resources/models/Models.ts (v5.1) -->

<VersionBadge version="v5.1.0" />

Every model call is recorded for observability and usage accounting, at two levels of granularity: a per-call log table for forensics, and aggregate counters in Harper's [general analytics](../analytics/overview) for dashboards and trends.

## Per-call log: `hdb_model_calls`

Each `embed()`, `generate()`, and `generateStream()` call writes one row to the `hdb_model_calls` system table — on success and on failure. With `toolMode: 'auto'`, each backend round inside the loop records its own row (the outer loop itself does not add one).

| Field               | Description                                                                               |
| ------------------- | ----------------------------------------------------------------------------------------- |
| `tenant`            | Tenant identifier, when the call carried one                                              |
| `app`               | Resource path of the calling resource, when called from one                               |
| `model`             | Logical model name the caller used                                                        |
| `backend`           | Backend that served the call (`ollama`, `openai`, …); `unknown` for pre-dispatch failures |
| `method`            | `embed`, `generate`, or `generateStream`                                                  |
| `prompt_tokens`     | Prompt token count, when the backend reported usage                                       |
| `completion_tokens` | Completion token count, when the backend reported usage                                   |
| `embedding_tokens`  | Embedding token count, when the backend reported usage                                    |
| `latency_ms`        | Wall-clock call duration                                                                  |
| `success`           | Whether the call completed                                                                |
| `error_code`        | On failure: `backend_error`, `aborted`, `capability_unsupported`, or `backend_not_found`  |

Rows are buffered in memory and flushed every 10 seconds, or immediately once 1,000 rows accumulate; rows older than 90 days are purged. Buffered rows may be lost on abrupt shutdown — treat the table as operational telemetry, not an audit log.

Query it like any table, for example through the operations API:

```json
{
	"operation": "search_by_conditions",
	"database": "system",
	"table": "hdb_model_calls",
	"conditions": [{ "search_attribute": "success", "search_type": "equals", "search_value": false }]
}
```

## Aggregate metrics

Each call also increments Harper's aggregate analytics (visible in `hdb_raw_analytics` alongside the other [analytics metrics](../analytics/overview)):

- `model-embed`, `model-generate`, `model-generateStream` — call counts
- `model-embed-tokens`, `model-generate-tokens`, `model-generateStream-tokens` — token totals

Metrics are broken down by backend name, so usage can be charted per provider.
