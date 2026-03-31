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
	brand: Related @relation(from: "brandId")
}
type Brand @table {
	id: Long @primaryKey
	name: String @indexed # indexed — enables efficient brand.name queries
	products: Product @relation(to: "brandId")
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

Avoid storing an iterator and abandoning it (e.g. never calling `.next()` again without calling `.return()`), as the transaction will remain open until the iterator is garbage collected — which is non-deterministic.

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
