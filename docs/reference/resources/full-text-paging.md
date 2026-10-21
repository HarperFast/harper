---
title: Full-text paging
---

# Full-text paging

<VersionBadge type="changed" version="v5.4.0" />

Full-text and autocomplete searches use Harper's existing paging options. Each request runs a new search; Harper does not retain a search between pages.

## Request a page

Inside an authenticated Resource handler, use `limit` and `offset` with `Table.search()`. `Table.search()` returns an iterable, including when a custom Resource forwards or filters it.

```javascript
return Product.search(
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

Use a bounded `limit` for large result sets. An unbounded query that exceeds the native result window returns 400. Offset requests revisit earlier matches; deep offsets and restrictive filters can exhaust the work or time budget. An exhausted search returns its remaining eligible records, including an empty result. A budget failure returns an error instead of a successful incomplete page.

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

Harper captures native runtime budgets before loading application components, or on an earlier main-thread native load or managed worker spawn. Application-created workers inherit that configuration. A worker created before capture fails with `FullTextWorkerInitializationError` (500, non-retryable); recreate it after Harper initializes. Replacement workers keep the established budgets after a live configuration change. Restart the Harper process to apply new native runtime budgets; restarting only HTTP workers is insufficient.

Harper does not configure the library's native filter metadata or submit native filter or candidate-ID requests. Ordinary conditions continue through Harper's secondary-index gates and authoritative record predicates. Native page, response-byte and highlight limits still apply. Query terms and clauses remain limited by the installed library.

## Upgrade considerations

This change uses the fulltext 0.6.0 native package. A format-incompatible upgrade rebuilds the local index from stored records; queries on that node return 503 until the index is ready. Full-text indexes require RocksDB and audit logging.

The initial native autocomplete batch is not a total-result cap. Harper continues through later batches when needed to satisfy the requested page after filtering. Work and time limits still apply.

Full-text counts are unavailable: a count response does not turn a native hit total into an authorized record count. For the ordinary REST paging syntax, see [Querying](../rest/querying.md#pagination-and-total-count). The JSON Operations API does not accept REST query syntax; use exported table routes or `Table.search()`.
