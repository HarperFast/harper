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

:::warning
SQL querying is not recommended for production use or on large tables. SQL queries often do not utilize indexes and are not optimized for performance. Use the [REST interface](../rest/overview.md) for production data access — it provides a more stable, secure, and performant interface. SQL is intended for ad-hoc data investigation and administrative queries.
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

If a database, table, or attribute name conflicts with a reserved word, wrap it in backticks or brackets:

```sql
SELECT * FROM data.`ASSERT`
SELECT * FROM data.[ASSERT]
```

<details>
<summary>Full reserved word list</summary>

ABSOLUTE, ACTION, ADD, AGGR, ALL, ALTER, AND, ANTI, ANY, APPLY, ARRAY, AS, ASSERT, ASC, ATTACH, AUTOINCREMENT, AUTO_INCREMENT, AVG, BEGIN, BETWEEN, BREAK, BY, CALL, CASE, CAST, CHECK, CLASS, CLOSE, COLLATE, COLUMN, COLUMNS, COMMIT, CONSTRAINT, CONTENT, CONTINUE, CONVERT, CORRESPONDING, COUNT, CREATE, CROSS, CUBE, CURRENT_TIMESTAMP, CURSOR, DATABASE, DECLARE, DEFAULT, DELETE, DELETED, DESC, DETACH, DISTINCT, DOUBLEPRECISION, DROP, ECHO, EDGE, END, ENUM, ELSE, EXCEPT, EXISTS, EXPLAIN, FALSE, FETCH, FIRST, FOREIGN, FROM, GO, GRAPH, GROUP, GROUPING, HAVING, HDB_HASH, HELP, IF, IDENTITY, IS, IN, INDEX, INNER, INSERT, INSERTED, INTERSECT, INTO, JOIN, KEY, LAST, LET, LEFT, LIKE, LIMIT, LOOP, MATCHED, MATRIX, MAX, MERGE, MIN, MINUS, MODIFY, NATURAL, NEXT, NEW, NOCASE, NO, NOT, NULL, OFF, ON, ONLY, OFFSET, OPEN, OPTION, OR, ORDER, OUTER, OVER, PATH, PARTITION, PERCENT, PLAN, PRIMARY, PRINT, PRIOR, QUERY, READ, RECORDSET, REDUCE, REFERENCES, RELATIVE, REPLACE, REMOVE, RENAME, REQUIRE, RESTORE, RETURN, RETURNS, RIGHT, ROLLBACK, ROLLUP, ROW, SCHEMA, SCHEMAS, SEARCH, SELECT, SEMI, SET, SETS, SHOW, SOME, SOURCE, STRATEGY, STORE, SYSTEM, SUM, TABLE, TABLES, TARGET, TEMP, TEMPORARY, TEXTSTRING, THEN, TIMEOUT, TO, TOP, TRAN, TRANSACTION, TRIGGER, TRUE, TRUNCATE, UNION, UNIQUE, UPDATE, USE, USING, VALUE, VERTEX, VIEW, WHEN, WHERE, WHILE, WITH, WORK

</details>
