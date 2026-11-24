---
section: SQL
---

### Legacy SQL No Longer Skips Matching Rows

The legacy SQL engine, which runs under `sql.engine: legacy` and for the statements the default `auto` engine [falls back on](/reference/v5/operations-api/sql#the-fallback-contract), no longer misses rows in two cases. Each returned, updated or deleted fewer rows than matched, and reported no error:

- A WHERE clause nested more than about 100 levels deep, such as an `OR` of 100 or more primary keys, an `AND` of 100 or more conditions, or a condition inside 100 parentheses. Legacy SQL stopped reading the clause at that depth, so `SELECT ... WHERE id = 1 OR ... OR id = 99` returned 97 rows. It now reads the whole clause, and an unknown column nested that deep is reported as one.
- An `UPDATE` or `DELETE` whose WHERE uses `IS NOT NULL`. It changed only the rows whose value was `1` or `true`; it now changes every row with a value, as the same `SELECT` returns them.
