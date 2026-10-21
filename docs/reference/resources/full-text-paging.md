---
title: Full-text paging
---

# Full-text paging

<VersionBadge type="changed" version="v5.4.0" />

Full-text and autocomplete searches use Harper's existing paging options. Each request runs a new search; Harper does not retain a search between pages.

## Before you start

Use an audited RocksDB table with a declared full-text field. For example:

```graphql
type Product @table(audit: true) @export {
	id: ID @primaryKey
	title: String
	catalogSearch: FullText @fullText(fields: [{ name: "title" }])
}
```

`catalogSearch` names the index over `title`; it is not a stored record value. The examples below search that index through an exported table route or an authenticated Resource handler.

## Request a page

Inside an authenticated Resource handler, use `limit` and `offset` with `Table.search()`. `Table.search()` returns an iterable, including when a custom Resource forwards or filters it.

```javascript
return tables.Product.search(
	{
		checkPermission: true,
		conditions: [{ attribute: 'catalogSearch', comparator: 'matches', value: 'trail shoes' }],
		offset: 20,
		limit: 20,
	},
	this.getContext()
);
```

The equivalent REST range has an inclusive start and exclusive end. This request skips 20 matching records and returns up to 20 more:

```text
GET /Product/?catalogSearch=matches=trail%20shoes&limit(20,40)
```

Each page runs a new query. Changes to records, permissions, or the index can move results between requests, so separate pages may omit or repeat records. There is no retained search or cross-request snapshot.

Within one request, Harper reads native batches on the same index reader until enough eligible records have been found or the matches are exhausted. Current source versions and record filters are checked before counting records toward the offset and limit. This traversal also lets prefix and fuzzy-prefix searches return more than the initial autocomplete batch. The library's ordinary search window is not a total-result cutoff for a bounded Harper request.

Use a bounded `limit` for large result sets. An unbounded query that exceeds the native result window returns 400. `offset + limit` must not exceed `maxRawHitsPerRequest`; replay and rejected hits can exhaust that budget even earlier. Offset requests revisit earlier matches; deep offsets and restrictive filters can exhaust the work or time budget. Harper can retain up to `offset + limit` accepted records while building a bounded result, so raising the work limit can also increase memory use. An exhausted search returns its remaining eligible records, including an empty result. A budget failure returns an error instead of a successful incomplete page.

## Configure search work

Search settings are under `storage.fullText` in `harper-config.yaml`:

| Setting                     | Default | Meaning                                                                                                           |
| --------------------------- | ------: | ----------------------------------------------------------------------------------------------------------------- |
| `maxRawHitsPerRequest`      |  10,000 | Fetched native hits, including the initial batch replay when switching to traversal                               |
| `requestBudgetMilliseconds` |   5,000 | Execution budget across native batches, source checks and highlight tracing, capped by the native execution limit |

The hit limit counts fetched hits, not every record Tantivy visits while scoring. Reaching it before the page fills or the search is exhausted returns 400. Exceeding the execution budget returns 503. Narrow the query, reduce the offset, or increase the relevant configured budget. Freshness waiting uses `waitForIndexMilliseconds` separately. Reader acquisition, query construction and some native operations can take additional time; the execution budget is not a hard response-time guarantee.

Each setting has the usual configuration parameter name, such as `storage_fullText_maxRawHitsPerRequest`, for `set_configuration` and environment overrides. Query work limits apply to new searches after configuration changes.

## Configure native runtime admission

Native process admission settings live under `storage.fullText.runtime`:

| Setting                | Default |
| ---------------------- | ------: |
| `maxResidentIndexes`   |     128 |
| `maxIndexingThreads`   |     128 |
| `maxSearchThreads`     |     256 |
| `maxWriterMemoryBytes` |   4 GiB |
| `maxQueuedBytes`       |   8 GiB |
| `maxExpensiveSearches` |       8 |

These limits apply together. For example, two indexing threads and 64 MiB of writer memory per index reach the default thread and memory budgets at 64 indexes. Readers share an index's runtime; they do not allocate another writer. Admission limits are not hard bounds on total resident memory or disk usage.

Harper captures native runtime budgets before loading application components, or on an earlier main-thread native load or managed worker spawn. Application-created workers inherit that configuration. A worker created before capture fails on its first native full-text load with `FullTextWorkerInitializationError` (500, non-retryable). Create application workers from a Harper application component, after runtime configuration has been captured; recreate an early worker rather than retrying inside it. Replacement workers keep the established budgets after a live configuration change. Restart the Harper process to apply new native runtime budgets; restarting only HTTP workers is insufficient.

Native page, response-byte and highlight limits still apply. Fulltext 0.6.0 also limits each analyzed query leaf to 64 terms and the compiled query to 256 clauses. Raising Harper's work budgets does not raise those limits. See the [published library limits](https://github.com/HarperFast/fulltext/blob/v0.6.0/docs/limits.md) for the full list and recovery guidance.

## Upgrade considerations

Harper 5.4 uses the fulltext 0.6.0 native package. A format-incompatible upgrade rebuilds the local index from stored records; queries on that node return 503 until the index is ready. Full-text indexes require RocksDB and audit logging.

The initial native autocomplete batch is not a total-result cap. Harper continues through later batches when needed to satisfy the requested page after filtering. Work and time limits still apply.

Full-text queries do not provide an exact record count. When exact counting is enabled and requested, `Content-Range` uses `*` for the total. Estimated counting can return a planner estimate when no opaque row or vector filter suppresses it. A native hit total is not an authorized record count. See [count preferences](../rest/querying.md#pagination-and-total-count) for the default downgrade from exact to estimated counting. For the ordinary REST paging syntax, see [Querying](../rest/querying.md#pagination-and-total-count). The JSON Operations API uses `search_by_conditions` with `limit` and `offset` rather than REST URL syntax. The same per-request behavior and work limits apply.

## Errors and recovery

| Situation                                                                   | HTTP status | Action                                                                                                             |
| --------------------------------------------------------------------------- | ----------- | ------------------------------------------------------------------------------------------------------------------ |
| Fetched-hit budget exhausted                                                | 400         | Narrow the query, reduce the offset, or raise `maxRawHitsPerRequest`.                                              |
| Execution budget exhausted                                                  | 503         | Narrow the query or adjust `requestBudgetMilliseconds`; retrying the same expensive query can hit the same limit.  |
| Index rebuilding or unavailable                                             | 503         | Wait for the local index to become ready before retrying.                                                          |
| Application worker started before native runtime configuration was captured | 500         | `FullTextWorkerInitializationError` is non-retryable in that worker. Recreate the worker after Harper initializes. |

`INDEX_REBUILDING` and `DERIVED_INDEX_LAGGING` identify retryable readiness or coverage failures. A native busy response also returns 503; reduce concurrency or retry with backoff. HTTP status alone does not distinguish these from an execution-budget failure.
