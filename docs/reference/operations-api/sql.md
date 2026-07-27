---
title: SQL
---

<!-- Source: versioned_docs/version-4.7/reference/sql-guide/index.md (primary) -->
<!-- Source: versioned_docs/version-4.7/reference/sql-guide/functions.md -->
<!-- Source: versioned_docs/version-4.7/reference/sql-guide/date-functions.md -->
<!-- Source: versioned_docs/version-4.7/reference/sql-guide/json-search.md -->
<!-- Source: versioned_docs/version-4.7/reference/sql-guide/sql-geospatial-functions.md -->
<!-- Source: versioned_docs/version-4.7/reference/sql-guide/features-matrix.md -->
<!-- Source: versioned_docs/version-4.7/reference/sql-guide/reserved-word.md -->
<!-- Source: versioned_docs/version-4.7/developers/operations-api/sql-operations.md -->

:::info Harper 5.2 introduces a new SQL engine
As of Harper 5.2, SQL runs on a new engine built directly on Harper's indexed storage and Resource API. Queries that can be planned against an index now execute as streaming, index-driven operations with memory bounded by the size of the result — not the size of the table. Queries the engine can't plan against an index automatically fall back to the legacy execution path, returning the same results but with the older full-scan cost — each fallback is logged (`SQL engine v2 fallback: ...`) with the reason, so you have direct visibility into which queries aren't being planned. See [Query Performance](#query-performance) for how to keep your queries on the fast path.

For your most performance-critical production read paths, the [REST interface](../rest/overview.md) remains the recommended choice — it provides a stable, cacheable, index-driven contract. SQL is well suited to ad-hoc investigation, administrative queries, joins, and reporting.
:::

Harper includes a SQL interface supporting SELECT, INSERT, UPDATE, and DELETE operations. Tables are referenced using `database.table` notation (e.g., `dev.dog`).

## Operations API

SQL queries are executed via the Operations API using the `sql` operation:

- `operation` _(required)_ — must be `sql`
- `sql` _(required)_ — the SQL statement to execute

### Select

```json
{
	"operation": "sql",
	"sql": "SELECT * FROM dev.dog WHERE id = 1"
}
```

### Insert

```json
{
	"operation": "sql",
	"sql": "INSERT INTO dev.dog (id, dog_name) VALUE (22, 'Simon')"
}
```

Response:

```json
{
	"message": "inserted 1 of 1 records",
	"inserted_hashes": [22],
	"skipped_hashes": []
}
```

### Update

```json
{
	"operation": "sql",
	"sql": "UPDATE dev.dog SET dog_name = 'penelope' WHERE id = 1"
}
```

### Delete

```json
{
	"operation": "sql",
	"sql": "DELETE FROM dev.dog WHERE id = 1"
}
```

---

## SELECT Syntax

```sql
SELECT * FROM dev.dog
SELECT id, dog_name, age FROM dev.dog
SELECT * FROM dev.dog ORDER BY age
SELECT * FROM dev.dog ORDER BY age DESC
SELECT DISTINCT breed_id FROM dev.dog
SELECT COUNT(*) FROM dev.dog WHERE age > 3
```

### Joins

Supported join types: `INNER JOIN`, `LEFT [OUTER] JOIN`, `RIGHT [OUTER] JOIN`, `FULL OUTER JOIN`, `CROSS JOIN`.

```sql
SELECT d.id, d.dog_name, b.name
FROM dev.dog AS d
INNER JOIN dev.breed AS b ON d.breed_id = b.id
WHERE d.owner_name IN ('Kyle', 'Zach')
ORDER BY d.dog_name
```

---

## Query Performance

Harper 5.2's SQL engine maps SQL clauses onto Harper's native indexed storage. When a query can be planned against an index, it runs as a streaming, index-driven operation with memory bounded by the size of the result — not the size of the table. When it can't, the engine falls back to the legacy path, which fetches candidate rows and evaluates the query in memory, with cost and memory growing with the number of rows scanned.

On any non-trivial table the difference between these two paths is large.

:::caution Full-scan fallback cost
A fallback isn't just "slower" — it means every row in the table is read and evaluated in memory for that query, with no bound from the result size. On a large table this can be the difference between a sub-millisecond lookup and a scan that reads millions of rows. The rules below keep your queries on the fast path; see [Queries that fall back to a full scan](#queries-that-fall-back-to-a-full-scan-avoid-on-large-tables) for what to avoid.
:::

### Index your predicates, sorts, and join keys

The single most important factor is whether the attributes you filter, sort, and join on are indexed. An equality or range filter on an indexed attribute becomes an index lookup; the same filter on an un-indexed attribute forces a full scan. Define indexes on the attributes your queries actually constrain.

### Queries that run efficiently (index-served)

These map directly to indexed storage operations:

- **Primary-key lookups** — `WHERE id = ...`, `WHERE id IN (...)`.
- **Equality and `IN` on an indexed attribute** — `WHERE status = 'active'`, `WHERE breed_id IN (1, 2, 3)`.
- **Range predicates on an indexed attribute** — `<`, `<=`, `>`, `>=`, and `BETWEEN` (compiled to a bounded index range).
- **`OR` of indexed predicates** — `WHERE a = 1 OR b = 2` is served as a union of index scans, provided **every** branch is an index-driving predicate on an indexed attribute.
- **Prefix `LIKE`** — `WHERE name LIKE 'Har%'` compiles to an indexed `starts_with` scan.
- **`ORDER BY` on an indexed attribute, combined with an indexed `WHERE`** — served directly from index order, with no separate in-memory sort; `LIMIT`/`OFFSET` push into the scan so only the rows you return are read. Without an index-driving `WHERE` condition, an `ORDER BY` on a _secondary_ indexed attribute runs on the legacy path — except when sorting on the table's **primary key**, which drives the scan from the primary key's natural index order even with no `WHERE` clause.
- **`GROUP BY` on an indexed attribute, combined with an indexed `WHERE`** — aggregates stream group-by-group with O(1) memory per group (memory is bounded by the group count; every matching row is still read). Without an index-driving `WHERE` condition, a `GROUP BY` currently runs on the legacy path.
- **`INNER`/`LEFT JOIN` on an indexed join key** — executed as an index-nested-loop join (stream the outer table, probe the inner by index). Keep the join key indexed on the inner (probed) table.
- **Column projections** — selecting a subset of columns pushes down so only those attributes are read.

### Queries that fall back to a full scan (avoid on large tables)

These can't be served from an index. They still return correct results, but the engine falls back to the legacy full-scan path, so cost and memory grow with table size:

- **Filters on un-indexed attributes** — any equality, range, or `IN` on an attribute with no index, _when it's the only predicate_. Combined via `AND` with an indexed predicate, it's applied as a cheap residual filter after the index narrows the scan, and the query stays index-served overall — it's only a standalone un-indexed filter (or one joined by `OR`) that forces a full scan.
- **`OR` where a branch isn't index-driving** — e.g. `WHERE a = 1 OR b = 2` when `b` is un-indexed, or `WHERE a = 1 OR name LIKE '%x%'`. A single un-indexed (or non-index-comparator) branch taints the whole disjunction and forces a scan. When **every** branch is an indexed, index-driving predicate, the `OR` stays on the fast path (see above).
- **Suffix / substring `LIKE`** — `LIKE '%x'` and `LIKE '%x%'` (only prefix `LIKE 'x%'` is index-served). A suffix/contains `LIKE` combined (via `AND`) with an indexed predicate is applied as a cheap residual filter on the indexed result, so pair it with an indexed condition.
- **`!=` / `<>` and `NOT` negations** — matching "everything except" a value can't use an index.
- **`ORDER BY` with no indexed filter to drive it** — a table-wide ordered scan on an un-indexed sort key.
- **`SEARCH_JSON`** — evaluates JSONata over each candidate row's nested JSON; it is not index-backed. Narrow the candidate set with an indexed `WHERE` condition first.
- **`RIGHT`/`FULL OUTER JOIN`, no-`WHERE` `UPDATE`/`DELETE`, `COUNT(DISTINCT ...)`** — the new engine doesn't plan these yet, so they run on the legacy engine (correct results, legacy cost).

Note that `UNION`, sub-`SELECT`, and `INSERT … SELECT` are not supported by either engine — see the [Features Matrix](#features-matrix).

### The fallback contract

The engine runs in `auto` mode by default: it executes every query it can plan on the new engine and transparently falls back to the legacy engine for anything it can't. A query that falls back returns exactly what the legacy engine would — **its results don't change, only its performance profile.** Fallbacks are logged (`SQL engine v2 fallback: ...`) with the reason, which is a useful signal for finding queries worth an added index or a reshape. (For queries the new engine _does_ plan, it corrects a few long-standing legacy quirks — see [Behavior changes from the legacy engine](#behavior-changes-from-the-legacy-engine).)

### Behavior changes from the legacy engine

For queries the new engine plans (the default under `auto`), a handful of non-standard legacy behaviors are corrected, so you may see different — standard-SQL-conformant — results after upgrading:

- **Aggregates over an empty result set** return `NULL` for `SUM`, `AVG`, `MIN`, and `MAX` (and `0` for `COUNT`), per the SQL standard. The legacy engine returned `0` for `SUM` and omitted `MIN`/`MAX` from the response entirely.
- **`MIN`/`MAX` over text columns** return the lexicographically smallest/largest value. The legacy engine produced no result for string `MIN`/`MAX`.
- **`NULL` never equals `NULL` in a join key.** Rows whose join key is `NULL` on either side no longer match each other (three-valued logic). The legacy engine incorrectly joined `NULL` to `NULL`.
- **`OFFSET` past the end of a result returns no rows.** The legacy engine could still return rows when the `OFFSET` exceeded the number of matches.
- **A `NULL`-valued expression result is returned as an explicit `null`** rather than omitted from the row. A computed column or `COALESCE` that evaluates to `NULL` — or `UPPER(<null>)` — now yields `null` (the legacy engine dropped the key, and `UPPER` of a `NULL` returned the literal string `"NULL"`).

These are deliberate corrections toward standard SQL, applied when the new engine serves the query — not fallbacks. If your application depended on a legacy quirk, adjust for the standard behavior.

### Practical guidance

- Index every attribute you filter, sort, or join on — but no more than that. Each index adds storage and write-time maintenance cost, so index for your actual query patterns rather than every attribute in the table.
- Prefer prefix `LIKE 'x%'` over `LIKE '%x%'`; back a substring search with a separate indexed predicate, or model it as a dedicated indexed attribute.
- Constrain the row set with an indexed `WHERE` before leaning on `ORDER BY`, `GROUP BY`, joins, or `SEARCH_JSON`.
- Reach for the [REST interface](../rest/overview.md) on your hottest production read paths for a cacheable, index-driven contract; keep SQL for ad-hoc investigation, joins, and reporting.

---

## Features Matrix

| INSERT                             |     |
| ---------------------------------- | --- |
| Values — multiple values supported | ✔   |
| Sub-SELECT                         | ✗   |

| UPDATE         |     |
| -------------- | --- |
| SET            | ✔   |
| Sub-SELECT     | ✗   |
| Conditions     | ✔   |
| Date Functions | ✔   |
| Math Functions | ✔   |

| DELETE     |     |
| ---------- | --- |
| FROM       | ✔   |
| Sub-SELECT | ✗   |
| Conditions | ✔   |

| SELECT              |     |
| ------------------- | --- |
| Column SELECT       | ✔   |
| Aliases             | ✔   |
| Aggregate Functions | ✔   |
| Date Functions      | ✔   |
| Math Functions      | ✔   |
| Constant Values     | ✔   |
| DISTINCT            | ✔   |
| Sub-SELECT          | ✗   |

| FROM             |     |
| ---------------- | --- |
| Multi-table JOIN | ✔   |
| INNER JOIN       | ✔   |
| LEFT OUTER JOIN  | ✔   |
| LEFT INNER JOIN  | ✔   |
| RIGHT OUTER JOIN | ✔   |
| RIGHT INNER JOIN | ✔   |
| FULL JOIN        | ✔   |
| UNION            | ✗   |
| Sub-SELECT       | ✗   |
| TOP              | ✔   |

| WHERE            |     |
| ---------------- | --- |
| Multi-Conditions | ✔   |
| Wildcards        | ✔   |
| IN               | ✔   |
| LIKE             | ✔   |
| AND, OR, NOT     | ✔   |
| NULL             | ✔   |
| BETWEEN          | ✔   |
| EXISTS, ANY, ALL | ✔   |
| Compare columns  | ✔   |
| Date Functions   | ✔   |
| Sub-SELECT       | ✗   |

| GROUP BY              |     |
| --------------------- | --- |
| Multi-Column GROUP BY | ✔   |

| HAVING                        |     |
| ----------------------------- | --- |
| Aggregate function conditions | ✔   |

| ORDER BY              |     |
| --------------------- | --- |
| Multi-Column ORDER BY | ✔   |
| Aliases               | ✔   |

---

## Functions

### Aggregate

| Function               | Description                                           |
| ---------------------- | ----------------------------------------------------- |
| `AVG(expr)`            | Average of a numeric expression.                      |
| `COUNT(col)`           | Count of rows matching the criteria (nulls excluded). |
| `MAX(col)`             | Largest value in a column.                            |
| `MIN(col)`             | Smallest value in a column.                           |
| `SUM(col)`             | Sum of numeric values.                                |
| `GROUP_CONCAT(expr)`   | Comma-separated string of non-null values.            |
| `ARRAY(expr)`          | Returns a list of data as a field.                    |
| `DISTINCT_ARRAY(expr)` | Returns a deduplicated list.                          |

### Conversion

| Function                           | Description                                |
| ---------------------------------- | ------------------------------------------ |
| `CAST(expr AS datatype)`           | Converts a value to the specified type.    |
| `CONVERT(datatype, expr[, style])` | Converts a value from one type to another. |

### String

| Function                      | Description                                             |
| ----------------------------- | ------------------------------------------------------- |
| `CONCAT(s1, s2, ...)`         | Joins strings together.                                 |
| `CONCAT_WS(sep, s1, s2, ...)` | Joins strings with a separator.                         |
| `INSTR(s1, s2)`               | Position of s2 within s1.                               |
| `LEN(s)`                      | Length of a string.                                     |
| `LOWER(s)`                    | Converts to lower-case.                                 |
| `UPPER(s)`                    | Converts to upper-case.                                 |
| `REPLACE(s, old, new)`        | Replaces all instances of old with new.                 |
| `SUBSTRING(s, pos, len)`      | Extracts a substring.                                   |
| `TRIM([chars FROM] s)`        | Removes leading and trailing spaces or specified chars. |
| `REGEXP pattern`              | Matches a regular expression pattern.                   |
| `REGEXP_LIKE(col, pattern)`   | Matches a regular expression pattern (function form).   |

### Mathematical

| Function           | Description                             |
| ------------------ | --------------------------------------- |
| `ABS(expr)`        | Absolute value.                         |
| `CEIL(n)`          | Smallest integer ≥ n.                   |
| `FLOOR(n)`         | Largest integer ≤ n.                    |
| `EXP(n)`           | e to the power of n.                    |
| `ROUND(n, places)` | Rounds to the specified decimal places. |
| `SQRT(expr)`       | Square root.                            |
| `RANDOM(seed)`     | Pseudo-random number.                   |

### Logical

| Function                         | Description                                             |
| -------------------------------- | ------------------------------------------------------- |
| `IF(cond, true_val, false_val)`  | Returns one of two values based on a condition.         |
| `IIF(cond, true_val, false_val)` | Alias for IF.                                           |
| `IFNULL(expr, alt)`              | Returns alt if expr is null.                            |
| `NULLIF(expr1, expr2)`           | Returns null if expr1 = expr2, otherwise returns expr1. |

---

## Date & Time Functions

All SQL date operations use UTC internally. Dates are parsed as [ISO 8601](https://en.wikipedia.org/wiki/ISO_8601), then [RFC 2822](https://tools.ietf.org/html/rfc2822#section-3.3), then `new Date(string)`.

| Function                              | Returns                                                                                          |
| ------------------------------------- | ------------------------------------------------------------------------------------------------ |
| `CURRENT_DATE()`                      | Current date as `YYYY-MM-DD`.                                                                    |
| `CURRENT_TIME()`                      | Current time as `HH:mm:ss.SSS`.                                                                  |
| `CURRENT_TIMESTAMP`                   | Current Unix timestamp in milliseconds.                                                          |
| `NOW()`                               | Current Unix timestamp in milliseconds.                                                          |
| `GETDATE()`                           | Current Unix timestamp in milliseconds.                                                          |
| `GET_SERVER_TIME()`                   | Current date/time in server's timezone as `YYYY-MM-DDTHH:mm:ss.SSSZZ`.                           |
| `DATE([date_string])`                 | Date formatted as `YYYY-MM-DDTHH:mm:ss.SSSZZ`.                                                   |
| `DATE_ADD(date, value, interval)`     | Adds time to a date; returns Unix ms.                                                            |
| `DATE_SUB(date, value, interval)`     | Subtracts time from a date; returns Unix ms.                                                     |
| `DATE_DIFF(date1, date2[, interval])` | Difference between two dates.                                                                    |
| `DATE_FORMAT(date, format)`           | Formats a date using [moment.js format strings](https://momentjs.com/docs/#/displaying/format/). |
| `EXTRACT(date, date_part)`            | Extracts a part (year, month, day, hour, minute, second, millisecond).                           |
| `OFFSET_UTC(date, offset)`            | Returns the date adjusted by offset minutes (or hours if < 16).                                  |
| `DAY(date)`                           | Day of the month.                                                                                |
| `DAYOFWEEK(date)`                     | Day of the week (0=Sunday … 6=Saturday).                                                         |
| `HOUR(datetime)`                      | Hour part (0–838).                                                                               |
| `MINUTE(datetime)`                    | Minute part (0–59).                                                                              |
| `MONTH(date)`                         | Month (1–12).                                                                                    |
| `SECOND(datetime)`                    | Seconds part (0–59).                                                                             |
| `YEAR(date)`                          | Year.                                                                                            |

`DATE_ADD` and `DATE_SUB` accept these interval values:

| Key          | Shorthand |
| ------------ | --------- |
| years        | y         |
| quarters     | Q         |
| months       | M         |
| weeks        | w         |
| days         | d         |
| hours        | h         |
| minutes      | m         |
| seconds      | s         |
| milliseconds | ms        |

---

## JSON Search

`SEARCH_JSON(expression, attribute)` queries nested JSON data that is not indexed by Harper. It uses the [JSONata](https://docs.jsonata.org/overview.html) library and works in both SELECT and WHERE clauses.

```sql
-- Find records where the name array contains "Harper"
SELECT * FROM dev.dog
WHERE SEARCH_JSON('"Harper" in *', name)
```

```sql
-- Select and filter nested JSON in one query
SELECT m.title,
    SEARCH_JSON($[name in ["Actor A", "Actor B"]].{"actor": name}, c.`cast`) AS cast
FROM movies.credits c
INNER JOIN movies.movie m ON c.movie_id = m.id
WHERE SEARCH_JSON($count($[name in ["Actor A", "Actor B"]]), c.`cast`) >= 2
```

---

## Geospatial Functions

Geospatial data must be stored using the [GeoJSON standard](https://geojson.org/) in a single column. All coordinates are in `[longitude, latitude]` format.

| Function                                     | Description                                                        |
| -------------------------------------------- | ------------------------------------------------------------------ |
| `geoArea(geoJSON)`                           | Area of features in square meters.                                 |
| `geoLength(geoJSON[, units])`                | Length in km (default), or degrees/radians/miles.                  |
| `geoDistance(point1, point2[, units])`       | Distance between two points.                                       |
| `geoNear(point1, point2, distance[, units])` | Returns boolean: true if points are within the specified distance. |
| `geoContains(geo1, geo2)`                    | Returns boolean: true if geo2 is completely contained by geo1.     |
| `geoDifference(polygon1, polygon2)`          | Returns a new polygon with polygon2 clipped from polygon1.         |
| `geoEqual(geo1, geo2)`                       | Returns boolean: true if two GeoJSON features are identical.       |
| `geoCrosses(geo1, geo2)`                     | Returns boolean: true if the geometries cross each other.          |
| `geoConvert(coordinates, geo_type[, props])` | Converts coordinates into a GeoJSON of the specified type.         |

`units` options: `'degrees'`, `'radians'`, `'miles'`, `'kilometers'` (default).

`geo_type` options for `geoConvert`: `'point'`, `'lineString'`, `'multiLineString'`, `'multiPoint'`, `'multiPolygon'`, `'polygon'`.

---

## Logical Operators

| Keyword   | Description                                      |
| --------- | ------------------------------------------------ |
| `BETWEEN` | Returns values within a given range (inclusive). |
| `IN`      | Specifies multiple values in a WHERE clause.     |
| `LIKE`    | Searches for a pattern.                          |

---

## Reserved Words

If a database, table, attribute, or column-alias name conflicts with a reserved word, wrap it in backticks or brackets. This applies to `AS` aliases too: an unquoted reserved word such as `AS total` fails to parse — quote it, as in the last example below.

```sql
SELECT * FROM data.`ASSERT`
SELECT * FROM data.[ASSERT]
SELECT SUM(qty) AS `total` FROM data.dog
```

<details>
<summary>Full reserved word list</summary>

ABSOLUTE, ACTION, ADD, AGGR, ALL, ALTER, AND, ANTI, ANY, APPLY, ARRAY, AS, ASSERT, ASC, ATTACH, AUTOINCREMENT, AUTO_INCREMENT, AVG, BEGIN, BETWEEN, BREAK, BY, CALL, CASE, CAST, CHECK, CLASS, CLOSE, COLLATE, COLUMN, COLUMNS, COMMIT, CONSTRAINT, CONTENT, CONTINUE, CONVERT, CORRESPONDING, COUNT, CREATE, CROSS, CUBE, CURRENT_TIMESTAMP, CURSOR, DATABASE, DECLARE, DEFAULT, DELETE, DELETED, DESC, DETACH, DISTINCT, DOUBLEPRECISION, DROP, ECHO, EDGE, END, ENUM, ELSE, EXCEPT, EXISTS, EXPLAIN, FALSE, FETCH, FIRST, FOREIGN, FROM, GO, GRAPH, GROUP, GROUPING, HAVING, HDB_HASH, HELP, IF, IDENTITY, IS, IN, INDEX, INNER, INSERT, INSERTED, INTERSECT, INTO, JOIN, KEY, LAST, LET, LEFT, LIKE, LIMIT, LOOP, MATCHED, MATRIX, MAX, MERGE, MIN, MINUS, MODIFY, NATURAL, NEXT, NEW, NOCASE, NO, NOT, NULL, OFF, ON, ONLY, OFFSET, OPEN, OPTION, OR, ORDER, OUTER, OVER, PATH, PARTITION, PERCENT, PLAN, PRIMARY, PRINT, PRIOR, QUERY, READ, RECORDSET, REDUCE, REFERENCES, RELATIVE, REPLACE, REMOVE, RENAME, REQUIRE, RESTORE, RETURN, RETURNS, RIGHT, ROLLBACK, ROLLUP, ROW, SCHEMA, SCHEMAS, SEARCH, SELECT, SEMI, SET, SETS, SHOW, SOME, SOURCE, STRATEGY, STORE, SYSTEM, SUM, TABLE, TABLES, TARGET, TEMP, TEMPORARY, TEXTSTRING, THEN, TIMEOUT, TO, TOP, TOTAL, TRAN, TRANSACTION, TRIGGER, TRUE, TRUNCATE, UNION, UNIQUE, UPDATE, USE, USING, VALUE, VERTEX, VIEW, WHEN, WHERE, WHILE, WITH, WORK

</details>
