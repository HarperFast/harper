---
title: Query Optimization
---

<!-- Source: versioned_docs/version-4.7/reference/resources/query-optimization.md (primary) -->
<!-- Source: release-notes/v4-tucker/4.3.0.md (query optimizations introduced) -->

# Query Optimization

<VersionBadge version="v4.3.0" /> (query planning and execution improvements)

Harper has powerful query functionality with excellent performance characteristics. Like any database, different queries can vary significantly in performance. Understanding how querying works helps you write queries that perform well as your dataset grows.

## Query Execution

At a fundamental level, querying involves defining conditions to find matching data and then executing those conditions against the database. Harper supports indexed fields, and these indexes are used to speed up query execution.

When conditions are specified in a query, Harper attempts to utilize indexes to optimize the speed of query execution. When a field is not indexed, Harper checks each potential record to determine if it matches the condition — this is a full table scan and degrades as data grows (`O(n)`).

When a query has multiple conditions, Harper attempts to optimize their execution order. For intersecting conditions (the default `and` operator), Harper applies the most selective and performant condition first. If one condition can use an index and is more selective than another, it is used first to narrow the candidate set before filtering on the remaining conditions.

The `search` method supports an `explain` flag that returns the query execution order Harper determined, useful for debugging and optimization:

```javascript
const result = await MyTable.search({
	conditions: [...],
	explain: true,
});
```

For union queries (`or` operator), each condition is executed separately and the results are merged.

## Conditions, Operators, and Indexing

When a query is executed, conditions are evaluated against the database. Indexed fields significantly improve query performance.

### Index Performance Characteristics

| Operator                                                             | Uses index         | Notes                                                                    |
| -------------------------------------------------------------------- | ------------------ | ------------------------------------------------------------------------ |
| `equals`                                                             | Yes                | Fast lookup in sorted index                                              |
| `greater_than`, `greater_than_equal`, `less_than`, `less_than_equal` | Yes                | Range scan in sorted index; narrower range = faster                      |
| `starts_with`                                                        | Yes                | Prefix search in sorted index                                            |
| `not_equal`                                                          | No                 | Full scan required (unless combined with selective indexed condition)    |
| `contains`                                                           | No                 | Full scan required                                                       |
| `ends_with`                                                          | No                 | Full scan required                                                       |
| `!= null`                                                            | Yes (special case) | Can use indexes to find non-null records; only helpful for sparse fields |

**Rule of thumb**: Use `equals`, range operators, and `starts_with` on indexed fields. Avoid `contains`, `ends_with`, and `not_equal` as the sole or first condition in large datasets.

### Indexed vs. Non-Indexed Fields

Indexed fields provide `O(log n)` lookup — fast even as the dataset grows. Non-indexed fields require `O(n)` full table scans.

Trade-off: indexes speed up reads but add overhead to writes (insert/update/delete must update the index). This is usually worth it for frequently queried fields.

### Primary Key vs. Secondary Index

Querying on a **primary key** is faster than querying on a secondary (non-primary) index, because the primary key directly addresses the record without cross-referencing.

Secondary indexes are still valuable for query conditions on other fields, but expect slightly more overhead than primary key lookups.

### Cardinality

More unique values (higher cardinality) = more efficient indexed lookups. For example, an index on a boolean field has very low cardinality (only two possible values) and is less efficient than an index on a `UUID` field. High-cardinality fields benefit most from indexing.

### Querying an Attribute Whose Index Is Still Building

<VersionBadge version="v5.1.5" />

When a secondary index is still being built — for example, just after a new `@indexed` attribute is added, or while an index rebuilds following a schema change or upgrade — a query that relies on that index cannot return correct results yet. Rather than silently returning a partial result set, Harper rejects the query with a retryable `503`:

| Property  | Value                                                                 |
| --------- | --------------------------------------------------------------------- |
| Status    | `503`                                                                 |
| Code      | `INDEX_REBUILDING`                                                    |
| Retryable | `true`                                                                |
| Message   | `"<attribute>" is not indexed yet, can not search for this attribute` |

This is a transient condition — the index finishes building in the background, after which the same query succeeds. Clients should retry (with backoff) rather than treating it as an empty result or a permanent failure. On the operations API the error body includes `code` and `retryable`, so callers can branch on `error.code === 'INDEX_REBUILDING'` or `error.retryable`.

## Full-Text Search Work and Paging

<VersionBadge type="changed" version="v5.4.0" />

<EngineBadge engines="RocksDB" />

Full-text and autocomplete queries use Harper's existing `limit` and `offset` options. Each page runs a new query: changed records, permissions or index contents can cause records to repeat or be omitted between pages. There is no retained search across requests. See [REST paging and counts](../rest/querying.md#pagination-and-total-count) for URL syntax and count behavior.

Within one request, Harper uses one native reader to fetch ranked batches. It checks source versions and record filters before counting records toward the requested offset and limit. In v5.4, prefix and fuzzy-prefix searches can return more than the native ordinary autocomplete window. Before v5.4, prefix and fuzzy-prefix requests whose `offset + limit` exceeded 100 were rejected with 400; requests within that window could still return short pages after filtering. In v5.4, the native search window is not a total-result cutoff for bounded Harper queries.

For example, with `offset: 20` and `limit: 10`, Harper skips the first 20 eligible records and returns the next 10. Hits rejected by source-version checks or record filters do not count toward those 30 records, but fetching them still consumes the raw-hit budget. Harper fetches additional batches as needed until it fills the page, exhausts the matches or reaches a request limit.

Use a bounded `limit` for large result sets. An unbounded search that exceeds its native window, fetched-hit limit or retained-result limit throws 400; use a bounded query. Exhausting the execution-time budget instead throws 503. `offset + limit` must not exceed either `storage.fullText.maxResultsPerRequest` or `storage.fullText.maxRawHitsPerRequest`; replayed or rejected hits can exhaust the raw-work budget earlier. Raising only the raw-hit budget allows more filtering work without raising the retained-record target. Offset requests revisit earlier matches and can retain up to `offset + limit` accepted records. Raising work limits can increase CPU, reads and memory use.

The fetched-hit budget includes the initial batch replay when Harper switches to native traversal. It counts hits returned by the native library, not every record Tantivy visits while scoring. Exhausting that budget throws a 400 error; exhausting the execution budget throws 503. The adapter does not return a shortened result as if the search had completed. If a REST response has already started streaming, a later query error ends that stream instead of changing its HTTP status. JSON-array clients must check for a terminal `error` element and treat the response as failed. For other formats, detect stream or decoding failures; status 200 and count headers alone do not prove completion. See [REST paging](../rest/querying.md#pagination-and-total-count). When there are no further native matches, Harper returns the eligible records found, which may be an empty result. This differs from reaching a budget while more matches remain.

Configure the three request limits and six native process budgets under [`storage.fullText`](../configuration/options.md#storage). See [Set Configuration](../configuration/operations.md#set-configuration) for restart requirements. The execution budget is not a hard response-time guarantee: reader acquisition, query construction and some native operations can take additional time. Freshness waiting and reader acquisition use separate bounds.

### Native runtime configuration

Harper captures native process budgets before loading application components, or on an earlier main-thread native load or managed worker spawn. Application-created workers inherit that configuration. Create workers from a Harper application component after initialization. A worker created before capture fails on its first native full-text load with `FullTextWorkerInitializationError` (500, non-retryable); recreate that worker after Harper initializes.

Replacement workers keep the captured budgets after a configuration change. See [Set Configuration](../configuration/operations.md#set-configuration) before changing these budgets.

### Readiness and recovery

Full-text indexes require audit logging. New schema tables must explicitly declare `@table(audit: true)` when adding `@fullText`, even if global audit logging is enabled; an existing audited table can add an index without restating `audit`. Disabling audit logging while an index is declared is rejected. A format-incompatible native upgrade rebuilds the local index from stored records, and queries return 503 while it rebuilds. Harper v5.4 uses `@harperfast/fulltext` 0.7.0 with Tantivy 0.27.0. Indexes from fulltext 0.5.x using current field-based declarations (including fulltext 0.5.0 shipped in Harper 5.3.4), as well as prerelease 0.6 indexes, require a full local rebuild. Earlier beta declarations and indexes have no supported migration path. Drain the node's search traffic and stop old processes before starting the new version; do not mix engine versions against one local index. Verify readiness and current coverage before restoring search traffic. Replay after a long rebuild can also reject ordinary local writes with 503, `code: "DERIVED_INDEX_LAGGING"`, and `retryable: true`; retry with bounded backoff while it catches up. Replication and crash-recovery replay continue. Direct downgrade to fulltext 0.5.x is unsupported: that engine refuses opening or resetting a 0.7 index identity. Stop an accidentally started old version and restore the 0.7.0-based Harper version, keeping search traffic drained until readiness and coverage recover. Do not edit native index files. Missing retained transaction history can require a full rebuild, as described below; this is current-engine recovery, not a general Harper downgrade procedure. English stemming also changes: `added` now stems to `add` rather than `ad`, so review matching and ranking against representative searches.

| Failure                                                | HTTP status | Code and retry guidance                                                                                                                           |
| ------------------------------------------------------ | ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| Raw-hit or retained-result budget                      | 400         | No readiness code. Narrow the query or adjust the named budget.                                                                                   |
| Execution budget                                       | 503         | No readiness code. Narrow the query; the same expensive query can fail again.                                                                     |
| Native busy                                            | 503         | No readiness code. Reduce concurrency or retry with backoff.                                                                                      |
| Index unknown, needs-rebuild or rebuilding             | 503         | `INDEX_REBUILDING`, with `retryable: true`, for a not-ready readiness check. Retry with backoff while the index rebuilds.                         |
| Coverage lag, wait timeout or local write backpressure | 503         | `DERIVED_INDEX_LAGGING`, with `retryable: true`. Retry with backoff while the index catches up.                                                   |
| Index unavailable                                      | 503         | No readiness-specific code or retryable flag. Inspect readiness and logs; fix the reported problem before retrying.                               |
| Query host becomes non-ready during a coverage wait    | 503         | Can return no readiness-specific code or retryable flag. Inspect readiness before deciding whether to retry.                                      |
| Worker loaded native search before runtime capture     | 500         | REST reports `FullTextWorkerInitializationError`; the Operations API can omit that code. Non-retryable; recreate the worker after initialization. |

A native result that exceeds the response-byte envelope can return 413, including an oversized ordinary batch even when each individual hit would fit. Other native failures and invalid query configuration can return 500; inspect the error and server logs rather than assuming they are retryable. The table lists common failures, not every possible error.

For read-after-write queries, `maxIndexLagMilliseconds: 0` requires current coverage. `waitForIndexMilliseconds` lets a query wait for coverage (default `0`, maximum `30000` ms); without an override, the allowed index lag is `3000` ms. These options belong to the full-text condition. They wait for coverage, not for an unavailable index to recover. Readiness is checked first; a query host that becomes rebuilding or unavailable during wait setup can fail immediately with a bare 503.

Concurrent requests each have their own work budget. These per-request budgets do not cap the number of concurrent Harper queries or prevent brief event-loop delays during synchronous source reads. Measure deep offsets and selective filters under the expected concurrency before raising budgets.

`INDEX_REBUILDING` and `DERIVED_INDEX_LAGGING` identify retryable readiness or coverage failures. Retry with backoff while the index makes progress. Transaction history retained under [`logging.auditRetention`](../logging/configuration.md#loggingauditretention) (default `3d`) is used for catch-up. Lost history can require a rebuild; retries alone do not repair an index that cannot catch up. Use [`describe_table`](../operations-api/operations.md#describe_table) to inspect `full_text_indexes[].readiness`, including its state and reason. Correct the reported configuration or storage problem before retrying an unavailable index. Budget and native-busy failures do not carry those readiness codes. A native busy response also returns 503; reduce concurrency or retry with backoff. For an execution-budget failure, narrow the query, reduce the offset or adjust the work budget instead of repeatedly submitting the same expensive query.

Native page, response-byte and highlight limits still apply. That native version also limits each analyzed query leaf to 64 terms and the compiled query to 256 clauses. Raising Harper's work budgets does not raise those native limits. See the [published native limits](https://github.com/HarperFast/fulltext/blob/v0.7.0/docs/limits.md) for page, byte and highlight bounds.

## Relationships and Joins

Harper supports relationship-based queries that join data across tables. See [Schema documentation](../database/schema.md) for how to define relationships.

Join queries involve more lookups and naturally carry more overhead. The same indexing principles apply:

- Conditions on joined table fields should use indexed columns for best performance.
- If a relationship uses a foreign key, that foreign key should be indexed in both tables.
- Higher cardinality foreign keys make joins more efficient.

Example of an indexed foreign key that enables efficient join queries:

```graphql
type Product @table {
	id: Long @primaryKey
	brandId: Long @indexed # foreign key — index this
	brand: Related @relationship(from: "brandId")
}
type Brand @table {
	id: Long @primaryKey
	name: String @indexed # indexed — enables efficient brand.name queries
	products: Product @relationship(to: "brandId")
}
```

<VersionBadge version="v4.3.0" />

## Sorting

Sorting can significantly impact query performance.

- **Aligned sort and index**: If the sort attribute is the same indexed field used in the primary condition, Harper can use the index to retrieve results already in order — very fast.
- **Unaligned sort**: If the sort is on a different field than the condition, or the sort field is not indexed, Harper must retrieve and sort all matching records. For large result sets this can be slow, and it also **defeats streaming** (see below).

Best practice: sort on the same indexed field you are filtering on, or sort on a secondary indexed field with a narrow enough condition to produce a manageable result set.

## Streaming

Harper can stream query results — returning records as they are found rather than waiting for the entire query to complete. This improves time-to-first-byte for large queries and reduces peak memory usage.

**Streaming is defeated** when:

- A sort order is specified that is not aligned with the condition's index
- The full result set must be materialized to perform sorting

When streaming is possible, results are returned as an `AsyncIterable`:

```javascript
for await (const record of MyTable.search({ conditions: [...] })) {
	// process each record as it arrives
}
```

Failing to iterate the `AsyncIterable` to completion keeps a read transaction open, degrading performance. Always ensure you either fully iterate or explicitly release the query.

### Draining or Releasing a Query

An open query holds an active read transaction. While that transaction is open, the underlying data pages and internal state for the query cannot be freed — they remain pinned in memory until the transaction closes. In long-running processes or under high concurrency, accumulating unreleased transactions degrades throughput and increases memory pressure.

The transaction closes automatically once the `AsyncIterable` is fully iterated. If you need to stop early, you must explicitly signal that iteration is complete so Harper can release the transaction.

**Breaking out of a `for await...of` loop** is the most natural way. The JavaScript runtime automatically calls `.return()` on the iterator when a `break`, `return`, or `throw` exits the loop:

```javascript
for await (const record of MyTable.search({ conditions: [...] })) {
	if (meetsStopCriteria(record)) {
		break; // iterator.return() is called automatically — transaction is released
	}
	process(record);
}
```

**Calling `.return()` manually** is useful when you hold an iterator reference directly:

```javascript
const iterator = MyTable.search({ conditions: [...] })[Symbol.asyncIterator]();
try {
	const { value } = await iterator.next();
	process(value);
} finally {
	await iterator.return(); // explicitly closes the iterator and releases the transaction
}
```

Avoid storing an iterator and abandoning it (e.g. never using it in a for-loop or calling `.return()`), as the transaction will remain open until the iterator is garbage collected — which is non-deterministic.

## Practical Guidance

### Index fields you query on frequently

```graphql
type Product @table {
	id: Long @primaryKey
	name: String @indexed # queried frequently
	category: String @indexed # queried frequently
	description: String # not indexed (rarely in conditions)
}
```

### Use `explain` to diagnose slow queries

```javascript
const result = await Product.search({
	conditions: [
		{ attribute: 'category', value: 'electronics' },
		{ attribute: 'price', comparator: 'less_than', value: 100 },
	],
	explain: true,
});
// result shows the actual execution order Harper selected
```

### Prefer selective conditions first

When Harper cannot auto-reorder (e.g. with `enforceExecutionOrder`), put the most selective condition first:

```javascript
// Better: indexed, selective condition first
Product.search({
	conditions: [
		{ attribute: 'sku', value: 'ABC-001' }, // exact match on indexed unique field
		{ attribute: 'active', value: true }, // low cardinality filter
	],
});
```

### Use `limit` and `offset` for pagination

```javascript
Product.search({
	conditions: [...],
	sort: { attribute: 'createdAt', descending: true },
	limit: 20,
	offset: page * 20,
});
```

### Avoid wide range queries on non-indexed fields

```javascript
// Slow: non-indexed field with range condition
Product.search({
	conditions: [{ attribute: 'description', comparator: 'contains', value: 'sale' }],
});

// Better: use an indexed field condition to narrow first
Product.search({
	conditions: [
		{ attribute: 'category', value: 'clothing' }, // indexed — narrows to subset
		{ attribute: 'description', comparator: 'contains', value: 'sale' }, // non-indexed, applied to smaller set
	],
});
```
