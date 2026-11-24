---
section: SQL
---

### Legacy SQL Selects the Rows a WHERE Matches

The legacy SQL engine, which runs under `sql.engine: legacy` and for the statements the default `auto` engine [falls back on](/reference/v5/operations-api/sql#the-fallback-contract), selected the wrong rows in two cases, with no error. A `SELECT` returned the wrong rows, and an `UPDATE` or `DELETE` changed them. Usually it missed rows that matched, but under `NOT` it also took rows that did not match:

- A WHERE clause nested more than about 100 levels deep, such as an `OR` of 100 or more primary keys, an `AND` of 100 or more conditions, or a condition inside 100 parentheses. Legacy SQL stopped reading the clause at that depth, so `WHERE id = 1 OR ... OR id = 99` returned 97 rows, and `DELETE ... WHERE NOT (id = 1 OR ... OR id = 99)` also deleted rows 1 to 4. It now reads the whole clause, and an unknown column nested that deep is reported as one.
- An `UPDATE` or `DELETE` whose WHERE uses `IS NOT NULL`. It treated `v IS NOT NULL` as true only when `v` was loosely equal to `true` (such as `1` or `'1'`) or a negative number, so it changed too few rows, and with `NOT (v IS NOT NULL)` it also changed rows that had a value. It now selects the rows the same `SELECT` returns.
