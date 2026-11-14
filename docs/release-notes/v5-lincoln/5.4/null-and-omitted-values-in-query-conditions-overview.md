---
section: 'Null and Omitted Values in Query Conditions'
order: 10
---

[Match null and omitted values the same way whether a condition leads the scan or filters](https://github.com/HarperFast/harper/pull/3925) makes REST, Resource API, and `search_by_conditions` conditions return the same records for null and omitted values whichever condition leads the query, and whether or not the attribute is indexed:

- `ne` with a non-null value (`?discount=ne=5`) matches records whose value is null or omitted. Before, an indexed `ne` that led the query dropped those records.
- No range comparator matches a null or omitted value, and a `null` lower bound means no lower bound: `?discount=between=(null,10)` returns the same records as `?discount=le=10`, and `?discount=ge=null` returns every record with a non-null `discount`. Before, `ge=null` and `between=(null,x)` also returned stored `null` values.
- On an array attribute, `ne=v` matches a record when at least one element is not `v`, and a null or omitted array matches `ne=v` for a non-null `v`. Before, an unindexed `ne` compared the whole array, so `["x", "x"]` and `[]` matched `ne=x`, and `[]` matched `ne=null`; now none of them do.
- A sort on the same attribute as a condition that cannot read that attribute's index, such as a condition on an unindexed attribute or a non-null `ne`, now returns records in sort order instead of primary-key order.
- In SQL, a range compared with a `NULL` literal (`discount >= NULL`, `discount BETWEEN NULL AND 10`) now matches no rows. Before, it could fail with an `Invalid value for attribute` error, or `BETWEEN NULL AND x` could return rows whose value is `NULL`. `<>`, `NOT IN`, and `IS NULL` are unchanged.

**Upgrade impact:** `ne` queries can return more records, and `ge=null` or `between=(null,x)` queries fewer. A sorted `ne` query such as `?discount=ne=5&sort(discount)&limit(10)` now reads every record and sorts in memory, where it used to read its page from the index and skip null and omitted values, so it takes longer on a large table. See [Null and Omitted Values](/reference/v5/rest/querying#null-and-omitted-values), [NULL and omitted values in SQL](/reference/v5/operations-api/sql#null-and-omitted-values), and [Sorting](/reference/v5/resources/query-optimization#sorting).
