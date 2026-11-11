---
title: SQL
sidebar_position: 30
sidebar_label: 'SQL'
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
As of Harper 5.2, SQL runs on a new engine built directly on Harper's indexed storage and Resource API. Queries that can be planned against an index now execute as streaming, index-driven operations with memory bounded by the size of the result — not the size of the table. Queries the engine can't plan against an index automatically fall back to the legacy execution path, returning the legacy engine's results (which [differ from the new engine's in a few behaviors](#behavior-changes-from-the-legacy-engine), such as `LIKE` case sensitivity) with the older full-scan cost — each fallback is logged at the `info` level (`SQL engine v2 fallback: ...`) with the reason, so you have direct visibility into which queries aren't being planned. See [Query Performance](#query-performance) for how to keep your queries on the fast path.

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

Every `SET` expression reads the row as it was before the `UPDATE`, so `SET a = b, b = a` swaps two columns and `SET qty = qty + 5, total = qty * 2` computes `total` from the old `qty`. <VersionBadge type="changed" version="v5.4.0" /> A column assigned more than once takes every assignment in order, each reading the value the one before it produced: `SET qty = qty + 2, qty = qty + 3` adds 5, and `SET qty = 20, qty = qty + 5` sets 25. On the legacy engine only the last assignment counts.

`SET col = col + N` (or `col - N`) on a column that holds a number or a `BigInt` is applied as an atomic increment, so concurrent updates of the same row do not lose increments. On a value that is neither, the column gets the expression's result, as any other `SET` would: `NULL + 5` is `NULL`.

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

### NULL and Omitted Values

`WHERE` treats an omitted attribute as `NULL`:

- `IS NULL` matches records that store `null` and records that omit the attribute. `IS NOT NULL` matches the rest.
- `<>` and `NOT IN` with non-null values exclude `NULL` and omitted values.
- <VersionBadge type="changed" version="v5.4.0" /> With the default `auto` engine, a range (`<`, `<=`, `>`, `>=`, `BETWEEN`) compared with a `NULL` literal matches no rows. Before v5.4.0, it could fail with an `Invalid value for attribute` error, and `BETWEEN NULL AND x` could return rows whose value is `NULL`. This change is pending release; see [Match null and omitted values the same way whether a condition leads the scan or filters](https://github.com/HarperFast/harper/pull/3925).

Use `IS NULL` and `IS NOT NULL` to test for `NULL`. REST and Resource API conditions follow different rules: `ne` with a non-null value matches null and omitted values, and a `null` lower bound means no lower bound. See [Null and Omitted Values](../rest/querying.md#null-and-omitted-values).

### Relationship Columns

<VersionBadge type="changed" version="v5.4.0" />

A `@relationship` attribute is a column whose value is the related record. Reading it reads the related table, so it follows the role's permissions on that table, as REST and the NoSQL operations do. Super users and roles that can read the related table see the whole related record.

- A statement that reads a relationship whose related table the role cannot read returns HTTP 403, wherever the column appears: the select list or an alias, `WHERE`, `ORDER BY`, `GROUP BY`, an aggregate, a join, legacy SQL's `->`, or the rows an `UPDATE` or `DELETE` reads. `SELECT *` leaves that relationship out.
- With `attribute_permissions` on the related table, the related record holds only the attributes the role may read, in every one of those uses. An `UPDATE` that copies the relationship into another attribute never stores an attribute the role cannot read.
- Legacy SQL evaluates a relationship column's value as data: member access (`dept->name`) and functions such as `SEARCH_JSON` see the related record SQL returns for that column, never a further relationship of it, except for super users. In a `SELECT`, a related attribute the role cannot read is absent (`dept->budget` is null). An `UPDATE` or `DELETE` would pick or compute rows by that absent value, so there member access through a relationship returns HTTP 403 when its path names a table or attribute the role cannot read, or when it does not follow the relationship column directly with literal member names (`COALESCE(dept, x)->name`).

```sql
-- the role can read Emp, and Dept's id and name but not its budget
SELECT id, dept FROM data.Emp WHERE id = 'e1'
-- [{ "id": "e1", "dept": { "id": "d1", "name": "Eng" } }]
```

---

## Query Performance

Harper 5.2's SQL engine maps SQL clauses onto Harper's native indexed storage. When a query can be planned against an index, it runs as a streaming, index-driven operation with memory bounded by the size of the result — not the size of the table. When it can't, the engine falls back to the legacy path, which fetches candidate rows and evaluates the query in memory, with cost and memory growing with the number of rows scanned. This section describes the default `auto` mode; see [The fallback contract](#the-fallback-contract) for `sql.engine: new` and `sql.allowFullScan`.

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
- **Prefix `LIKE`** — `WHERE name LIKE 'Har%'` compiles to an indexed `starts_with` scan. The new engine matches it case-sensitively; see [LIKE Pattern Matching](#like-pattern-matching).
- **`ORDER BY` on an indexed attribute, combined with an indexed `WHERE`** — served directly from index order, with no separate in-memory sort; `LIMIT`/`OFFSET` push into the scan so only the rows you return are read. Without an index-driving `WHERE` condition, an `ORDER BY` on a _secondary_ indexed attribute runs on the legacy path — except when sorting on the table's **primary key**, which drives the scan from the primary key's natural index order even with no `WHERE` clause.
- **`GROUP BY` on an indexed attribute, combined with an indexed `WHERE`** — aggregates stream group-by-group with O(1) memory per group (memory is bounded by the group count; every matching row is still read). Without an index-driving `WHERE` condition, a `GROUP BY` currently runs on the legacy path.
- **`INNER`/`LEFT JOIN` on an indexed join key** — executed as an index-nested-loop join (stream the outer table, probe the inner by index). Keep the join key indexed on the inner (probed) table.
- **Column projections** — selecting a subset of columns pushes down so only those attributes are read.

### Queries that fall back to a full scan (avoid on large tables)

These can't be served from an index. Under the default `auto` mode with `sql.allowFullScan` off, the engine falls back to the legacy full-scan path, so cost and memory grow with table size. Under `sql.engine: new`, a statement the new engine can't plan is rejected with a 400 error instead, and `sql.allowFullScan: true` lets the new engine scan the table for a filter it can't serve from an index (see [The fallback contract](#the-fallback-contract)):

- **Filters on un-indexed attributes** — any equality, range, or `IN` on an attribute with no index, _when it's the only predicate_. Combined via `AND` with an indexed predicate, it's applied as a cheap residual filter after the index narrows the scan, and the query stays index-served overall — it's only a standalone un-indexed filter (or one joined by `OR`) that forces a full scan.
- **`OR` where a branch isn't index-driving** — e.g. `WHERE a = 1 OR b = 2` when `b` is un-indexed, or `WHERE a = 1 OR name LIKE '%x%'`. A single un-indexed (or non-index-comparator) branch taints the whole disjunction and forces a scan. When **every** branch is an indexed, index-driving predicate, the `OR` stays on the fast path (see above).
- **Suffix / substring `LIKE`** — `LIKE '%x'` and `LIKE '%x%'` (only prefix `LIKE 'x%'` is index-served). A suffix/contains `LIKE` combined (via `AND`) with an indexed predicate is applied as a cheap residual filter on the indexed result, so pair it with an indexed condition. That runs the statement on the new engine, where `LIKE` is [case-sensitive](#case-sensitivity-depends-on-the-engine).
- **`!=` / `<>` and `NOT` negations** — matching "everything except" a value can't use an index.
- **`ORDER BY` with no indexed filter to drive it** — a table-wide ordered scan on an un-indexed sort key.
- **`SEARCH_JSON`** — evaluates JSONata over each candidate row's nested JSON; it is not index-backed. Narrow the candidate set with an indexed `WHERE` condition first.
- **`RIGHT`/`FULL OUTER JOIN`, no-`WHERE` `UPDATE`/`DELETE`, `COUNT(DISTINCT ...)`** — the new engine doesn't plan these yet, so they run on the legacy engine (legacy results and cost).

Note that `UNION`, sub-`SELECT`, and `INSERT … SELECT` are not supported by either engine — see the [Features Matrix](#features-matrix).

### The fallback contract

The engine runs in `auto` mode by default: it executes every query it can plan on the new engine and transparently falls back to the legacy engine for anything it can't. A query that falls back returns exactly what the legacy engine would, at the legacy engine's cost. Fallbacks are logged (`SQL engine v2 fallback: ...`) with the reason, which is a useful signal for finding queries worth an added index or a reshape. They are logged at the `info` level, below the default `warn`, so set [`logging.level`](../logging/configuration.md#logginglevel) to `info` to see them. (Where the two engines differ, which engine runs a statement decides its results: for queries the new engine _does_ plan, it corrects a few long-standing legacy quirks, and `LIKE` matches differently — see [Behavior changes from the legacy engine](#behavior-changes-from-the-legacy-engine).)

The `sql.engine` setting in the [configuration file](../configuration/overview.md) selects the mode, and the `HARPER_SQL_ENGINE` environment variable overrides it:

- `auto` (default) — runs each statement on the new engine when it can, and on the legacy engine otherwise.
- `new` — runs every statement on the new engine. A statement the new engine can't plan is rejected with a 400 error instead of falling back.
- `legacy` — runs every statement on the legacy engine.

By default (`sql.allowFullScan: false`), the new engine does not run a query that has neither an index-driving condition nor an `ORDER BY` on the primary key, which is one reason `auto` falls back. With `sql.allowFullScan: true`, the new engine runs such a query as a full scan instead of falling back (under `auto`) or rejecting it (under `new`). A full scan on the new engine is not a fallback, so it is not logged.

### Behavior changes from the legacy engine

For queries the new engine plans (the default under `auto`), `LIKE` is case-sensitive and a handful of non-standard legacy behaviors are corrected, so you may see different results after upgrading:

- **Aggregates over an empty result set** return `NULL` for `SUM`, `AVG`, `MIN`, and `MAX` (and `0` for `COUNT`), per the SQL standard. The legacy engine returned `0` for `SUM` and omitted `MIN`/`MAX` from the response entirely.
- **`MIN`/`MAX` over text columns** return the lexicographically smallest/largest value. The legacy engine produced no result for string `MIN`/`MAX`.
- **`NULL` never equals `NULL` in a join key.** Rows whose join key is `NULL` on either side no longer match each other (three-valued logic). The legacy engine incorrectly joined `NULL` to `NULL`.
- **`OFFSET` past the end of a result returns no rows.** The legacy engine could still return rows when the `OFFSET` exceeded the number of matches.
- **`LIKE` is case-sensitive, and `[...]` in a pattern is literal text.** The legacy engine matches case-insensitively and reads `[...]` as a character class. Under `auto`, adding or removing an index, or changing the other conditions in a statement, can move it between engines, which changes the rows a `LIKE` matches, including the rows an `UPDATE` or `DELETE` changes. See [LIKE Pattern Matching](#like-pattern-matching).
- **A column assigned more than once in an `UPDATE` takes every assignment**, in order: `SET qty = qty + 2, qty = qty + 3` adds 5. The legacy engine kept only the last assignment, so under `auto` an `UPDATE` that falls back (no `WHERE`, or no index-driving condition) still does. See [Update](#update).
- **A `NULL`-valued expression result is returned as an explicit `null`** rather than omitted from the row. A computed column or `COALESCE` that evaluates to `NULL` — or `UPPER(<null>)` — now yields `null` (the legacy engine dropped the key, and `UPPER` of a `NULL` returned the literal string `"NULL"`).

These differences apply whenever the new engine serves the query — not on fallbacks. If your application depended on the legacy behavior, adjust your queries accordingly. For how `WHERE` compares `NULL` and omitted values, including the v5.4.0 change to ranges compared with `NULL`, see [NULL and Omitted Values](#null-and-omitted-values).

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

| Keyword   | Description                                                                                                                      |
| --------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `BETWEEN` | Returns values within a given range (inclusive).                                                                                 |
| `IN`      | Specifies multiple values in a WHERE clause.                                                                                     |
| `LIKE`    | Matches a string against a pattern. Case sensitivity depends on the engine; see [LIKE Pattern Matching](#like-pattern-matching). |

---

## LIKE Pattern Matching

`value LIKE pattern` is true when the whole value matches the pattern, and `NOT LIKE` negates it. The value is matched as a string. The pattern can contain these elements:

| Pattern element            | Matches                                                                                                                                 |
| -------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| `%`                        | Any run of characters, including none, and including line breaks (`\n`, `\r`, U+2028, U+2029).                                          |
| `_`                        | Exactly one character, including a line break (`\n`, `\r`, U+2028, U+2029). <VersionBadge type="changed" version="v5.4.0" />            |
| `[abc]`, `[a-z]`, `[^abc]` | Legacy engine only: one character in the set or range, or with `^`, one character not in it. See the list below.                        |
| Any other character        | Itself. `*`, `\`, `^`, `$`, `.`, `?` and `+` have no special meaning on either engine. <VersionBadge type="changed" version="v5.4.0" /> |

`_` matches one UTF-16 code unit, so a character outside the Basic Multilingual Plane, such as most emoji, takes two: `__`. Before v5.4.0, `_` did not match line breaks on either engine, and `%` did not match line breaks on the new engine.

```sql
SELECT * FROM dev.dog WHERE dog_name LIKE 'Pen%'    -- starts with "Pen"
SELECT * FROM dev.dog WHERE dog_name LIKE '%y'      -- ends with "y"
SELECT * FROM dev.dog WHERE dog_name LIKE '_ack'    -- "Jack", "Mack", ...
```

### Matching `%` and `_` Literally With ESCAPE

<VersionBadge type="changed" version="v5.4.0" /> Add `ESCAPE 'c'` to name an escape character. In the pattern, the escape character makes the character after it literal, and writing it twice matches the escape character itself:

```sql
SELECT * FROM dev.addr WHERE ip LIKE 't0!%' ESCAPE '!'          -- exactly "t0%"
SELECT * FROM dev.product WHERE label LIKE '50!%%' ESCAPE '!'   -- starts with "50%"
SELECT * FROM dev.addr WHERE ip LIKE 't0!!%' ESCAPE '!'         -- starts with "t0!"
```

Without `ESCAPE`, a pattern has no escape character: `ip LIKE 't0!%'` matches `t0!` followed by anything. `ESCAPE` works in `SELECT`, `UPDATE` and `DELETE`, on both engines.

These are rejected with a 400 error, and no rows are changed:

- A pattern that ends in the escape character, such as `'t0!' ESCAPE '!'`.
- An `ESCAPE` value that is empty (`''`) or longer than one character (`'!!'`, or a character such as an emoji that takes two UTF-16 code units).
- An `ESCAPE` value that is not a string, such as `ESCAPE 1`.

The new engine checks a literal pattern before any row is read (including under `auto`, unless the statement falls back earlier on an unsupported clause such as `RIGHT JOIN`). When the legacy engine checks a pattern, or when the pattern comes from an expression rather than a string literal, it is checked when a row is tested against it, so a statement that tests no rows does not fail.

Before v5.4.0, `ESCAPE` was ignored, so `ip LIKE 't0!%' ESCAPE '!'` matched every value starting with `t0!`, and an `UPDATE` or `DELETE` using it changed those rows.

### Case Sensitivity Depends on the Engine

| Engine that runs the statement                                                                          | `LIKE` is                                     |
| ------------------------------------------------------------------------------------------------------- | --------------------------------------------- |
| New engine: `sql.engine: new`, and statements that `auto` runs on the new engine                        | Case-sensitive: `'t0%'` does not match `T0b`. |
| Legacy engine: `sql.engine: legacy`, and statements that `auto` [falls back](#the-fallback-contract) on | Case-insensitive: `'t0%'` matches `T0b`.      |

Under the default `sql.engine: auto`, the same pattern can be either, and the whole statement decides which. For example, with `ip` indexed and `note` not indexed:

- `ip LIKE 't0%'` is a prefix pattern on an indexed attribute, so the new engine serves it from the index, and it is case-sensitive.
- `ip LIKE '%T0B'` is not a prefix pattern, so the index can't drive it. `auto` runs it on the legacy engine, and it matches `T0b`.
- `note LIKE 't0%'` alone has no index to drive it, so `auto` runs it on the legacy engine, and it is case-insensitive.
- `note LIKE 't0%'` is case-sensitive when something else keeps the statement on the new engine: an indexed condition joined with `AND`, an `ORDER BY` on the primary key, or `sql.allowFullScan: true`.

This applies to `UPDATE` and `DELETE` as well: adding an index on `note` moves `DELETE FROM dev.addr WHERE note LIKE 't0%'` to the new engine, and it stops deleting `T0b`. With `logging.level` set to `info`, a statement that falls back is logged, which tells you which engine ran it (see [The fallback contract](#the-fallback-contract)).

To match regardless of case on both engines, lower-case both the value and the pattern: `LOWER(note) LIKE 't0%'` (write the pattern in lower case, or lower-case a user-supplied pattern before sending it). `LOWER()` uses JavaScript's lower-casing, which treats a few non-ASCII characters differently from the legacy engine's case-insensitive matching. The index can't serve an expression, so combine it with an indexed condition using `AND`. Otherwise the statement scans the whole table, or is rejected with a 400 error under `sql.engine: new` with `sql.allowFullScan: false`. To keep a case-insensitive prefix search on the index, store a lower-cased copy of the value in its own indexed attribute and query that.

### Character Classes on the Legacy Engine

The legacy engine also reads `[...]` in a pattern as a character class, matched without regard to case like the rest of the pattern:

- `[abc]` matches one of `a`, `b` or `c`.
- `[a-z]` matches one character in the range.
- `[^abc]` matches one character that is not in the set.
- A range written backwards, such as `[z-a]`, is rejected with a 400 error when a row is tested against it.
- A `[` with no closing `]` is a literal, as is an escaped `[` (such as `![` with `ESCAPE '!'`).

The new engine has no character classes: `[` and `]` match themselves. Under `auto`, a pattern such as `'[a]%'` is a class on the legacy engine and literal text on the new engine, so avoid `[` in patterns unless you know which engine runs the statement.

### Matching Cost

<VersionBadge type="changed" version="v5.4.0" /> Testing one value takes time at most proportional to the value's length times the pattern's length, for any mix of `%` and `_`. Before v5.4.0, a short pattern such as `'%_%_%_%_%_%_%_%_%_%_%_%_%_%_Z'` against a long value could block a thread. Both lengths still multiply, so a pattern thousands of characters long tested against values millions of characters long is slow. If users supply patterns, limit their length.

Each segment of a pattern (the text between `%` wildcards, or the whole pattern when it has no `%`) can be at most 10,000 characters long. Each literal character, `_` wildcard, escaped character (such as `!%` with `ESCAPE '!'`), or legacy `[...]` character class counts as one character toward that limit; a pattern can have multiple segments of up to 10,000 characters separated by `%`. A pattern with a segment longer than 10,000 characters is rejected with a 400 error:

```json
{
	"error": "SQL engine v2: LIKE pattern must not have more than 10000 characters between % wildcards"
}
```

When the legacy engine checks the pattern, the error message omits the `SQL engine v2: ` prefix (`{"error": "LIKE pattern must not have more than 10000 characters between % wildcards"}`).

On the legacy engine, a pattern with more than 64 `_` wildcards across segments that also contain literal characters or `[...]` classes is also rejected with a 400 error in the rare case that the pattern contains at least one code unit from every consecutive two-code-unit pair in the reserved Unicode noncharacter ranges (`U+FDD0` to `U+FDEF`, `U+FFFE` to `U+FFFF`) and Private Use Area (`U+E000` to `U+F8FF`, about 3,200 pairs in all):

```json
{
	"error": "LIKE pattern with more than 64 _ names too many private-use characters"
}
```

The total cost of a `LIKE` is still the number of rows it tests. On an indexed attribute, the index serves a prefix pattern, which is literal text followed by one `%` (`'abc%'`, or `'50!%%' ESCAPE '!'` for values starting with `50%`), and a pattern with no wildcards, which is an equality test. Any other `LIKE` filters the rows that the rest of the query selects, so with no indexed condition it tests every row in the table. Whether such a statement falls back to the legacy engine, scans on the new engine, or is rejected with a 400 error depends on `sql.engine`, `sql.allowFullScan` and the rest of the statement; see [The fallback contract](#the-fallback-contract) and [Query Performance](#query-performance).

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
