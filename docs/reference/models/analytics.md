---
id: analytics
title: Analytics
---

<!-- Source: harper resources/models/analyticsTable.ts, resources/models/Models.ts (v5.1) -->

<VersionBadge version="v5.1.0" />

Every model call is recorded for observability and usage accounting, at two levels of granularity: a per-call log table for forensics, and aggregate counters in Harper's [general analytics](../analytics/overview) for dashboards and trends.

## Per-call log: `hdb_model_calls`

<VersionBadge type="changed" version="v5.3.0" />

Each `embed()`, `generate()`, `generateStream()`, and `decide()` call writes a row to the `hdb_model_calls` system table for every attempt, except on a read-only node, which discards the log rather than write it — on success, on failure, and for each fallback candidate it tries. With `toolMode: 'auto'`, each backend round inside the loop records its own row (the outer loop itself does not add one). With the [generative decision adapter](./backends#generative-decision-adapter), each vote sample is a `generate` row of its own, each scoring call a `scoreChoices` row, and the `decide` row carries the decision's latency but no token counts. A scoring call the backend declined is a failed `scoreChoices` row with `error_code: scoring_unsupported`, carrying the tokens the attempt consumed when it consumed any (a decline before any request carries none), followed by the rows of the next scoring candidate when the generative name has a fallback group, and, when every candidate declined under `scoring: auto`, by the `generate` rows of the vote that replaced it; when every candidate declined under `scoring: score`, or when no candidate succeeded and one failed, the `decide` row fails instead and no vote rows follow. Sibling scoring calls cut short by that decline are failed rows without tokens, usually `aborted`; one cancelled while reading its response can record `backend_error`. A generative backend that reports no `scoreChoices` capability writes no scoring row when the default router filters it out; a custom router that returns it anyway meets the invocation check, which writes one `capability_unsupported` row. A `decide()` call rejected for a malformed schema or state writes no row.

| Field               | Description                                                                                                                            |
| ------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `tenant`            | Tenant identifier, when the call carried one                                                                                           |
| `app`               | Resource path of the calling resource, when called from one                                                                            |
| `model`             | Logical model name the caller used                                                                                                     |
| `backend`           | Backend that served the call (`ollama`, `openai`, …); `unknown` for pre-dispatch failures                                              |
| `method`            | `embed`, `generate`, `generateStream`, `decide`, or `scoreChoices` (the decision adapter's scoring calls)                              |
| `prompt_tokens`     | Prompt token count, when the backend reported usage                                                                                    |
| `completion_tokens` | Completion token count, when the backend reported usage                                                                                |
| `embedding_tokens`  | Embedding token count, when the backend reported usage                                                                                 |
| `latency_ms`        | Wall-clock call duration                                                                                                               |
| `success`           | Whether the call completed                                                                                                             |
| `error_code`        | On failure: `backend_error`, `aborted`, `capability_unsupported`, `scoring_unsupported`, `backend_not_found`, or `pending_unsupported` |

Rows are buffered in memory and flushed every 10 seconds, or immediately once 1,000 rows accumulate; rows older than 90 days are purged. Buffered rows may be lost on abrupt shutdown — treat the table as operational telemetry, not an audit log. Decisions themselves are kept durably in [`hdb_model_decisions`](#durable-decisions).

Query it like any table, for example through the operations API:

```json
{
	"operation": "search_by_conditions",
	"database": "system",
	"table": "hdb_model_calls",
	"conditions": [{ "search_attribute": "success", "search_type": "equals", "search_value": false }]
}
```

## Durable decisions

<VersionBadge version="v5.3.0" />

A decision made with [`persist: true`](./api#recording-decisions) has one row in the `hdb_model_decisions` system table, committed before the call returns (a call that rejects writes none), and every other decision, including those of a `@decide` directive without a `decision` field, appears only in the per-call log above; and each fact recorded with [`recordOutcome()`](./api#recordoutcome) has one row in `hdb_model_outcomes`: a repeated identical report writes nothing, and a correction replaces that fact's row. Unlike the per-call log, these rows are written through the resource API, replicate to every node, and are never buffered or dropped; `Decision.id` is the decision row's key, and its `callId` names the `hdb_model_calls` row of the call that produced it; that row is buffered and can be lost on an abrupt shutdown, so the link is for correlation, not a join to rely on. Each recorded `decide()` performs one local commit before it returns, small next to the model call; replication is asynchronous, so the caller does not wait on the cluster.

`hdb_model_decisions` holds one immutable row per decision: `id`, `callId`, `at`, `expiresAt`, `tenant`, `app`, `backend`, `model`, `signature`, `configHash`, `instructionsHash`, `schema` (the allowed values, without descriptions), `schemaHash` (of the full schema), `value`, `probability`, `distribution`, `fields`, `noMatch`, and `calibrated`. `hdb_model_outcomes` holds one row per recorded fact, keyed `<decision id>/truth` or `<decision id>/action` (with `/<field>` appended for object schemas): `decisionId`, `fact`, `field`, `state`, `at`, and `expiresAt`. The decision's `state` and `instructions` are not stored.

Rows expire 365 days after the decision was made; a recorded outcome carries the same instant and never extends it. Expired rows stop being returned immediately and are removed by the table's expiry pruner shortly afterwards. Both tables can be queried like any other. This example lists every recorded truth fact, retractions included (a retraction is a truth fact whose `state.kind` is `unknown`):

```json
{
	"operation": "search_by_conditions",
	"database": "system",
	"table": "hdb_model_outcomes",
	"conditions": [{ "search_attribute": "fact", "search_type": "equals", "search_value": "truth" }]
}
```

From v5.3.1, a decision corrected by a [fitted calibration](./calibration) also keeps its uncorrected scores (`rawDistribution`, or `rawFields` for an object schema) and the correction it applied (`calibration`), and a decision recorded while calibration is enabled carries the `population` it belongs to. The corrections themselves are versions in the replicating `hdb_model_calibrations` table; read them with [`models.getCalibrations()`](./calibration#getcalibrations).

## Aggregate metrics

<VersionBadge type="changed" version="v5.3.0" />

Each call also increments Harper's aggregate analytics (visible in `hdb_raw_analytics` alongside the other [analytics metrics](../analytics/overview)):

- `model-embed`, `model-generate`, `model-generateStream`, `model-decide`, `model-scoreChoices`: call counts
- `model-embed-tokens`, `model-generate-tokens`, `model-generateStream-tokens`, `model-decide-tokens`, `model-scoreChoices-tokens`: token totals

Metrics are broken down by backend name, so usage can be charted per provider. Call counts count successful calls; token totals also include the tokens a failed attempt reported, such as a scoring call the backend declined after the completion was billed.
