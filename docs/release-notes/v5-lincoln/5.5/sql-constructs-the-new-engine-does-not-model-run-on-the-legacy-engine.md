---
section: 'SQL'
---

### SQL Constructs the New Engine Does Not Model Run on the Legacy Engine

Under the default `sql.engine: auto`, a statement that uses `DISTINCT ON`, `SELECT VALUE` (or `ROW`, `COLUMN`, `MATRIX`, `INDEX`, `RECORDSET`), a window function (`OVER`), `ORDER BY ... COLLATE NOCASE`, `NULLS FIRST` or `NULLS LAST`, an `ORDER BY` column position, `MAX` or `MIN` with more than one argument, `UNION`, `EXCEPT` or `INTERSECT`, `EXISTS`, a JavaScript or JSON object expression, `INTO`, `PIVOT` or `UNPIVOT` now runs on the legacy engine and returns what it returns. Before, the new engine ran the statement without the construct: `DISTINCT ON`, `OVER`, `COLLATE NOCASE` and `ORDER BY 2` returned the wrong rows, `SELECT VALUE` returned objects instead of values, and `DELETE FROM t WHERE id = 1 AND EXISTS (SELECT ...)` deleted the record whether or not the subquery matched. Under `sql.engine: new` these statements are rejected with a 400 error. See [The fallback contract](/reference/v5/operations-api/sql#the-fallback-contract).

The legacy engine cannot run an `UPDATE` or `DELETE` with a subquery or JavaScript predicate, so those now fail with an error and change nothing.

A role that cannot read a column can no longer use it in `DISTINCT ON`: the statement is refused with a 403, on every engine, because the column decides how many rows come back.

**Upgrade impact:** if you ran `UPDATE` or `DELETE` statements with `EXISTS` or a JavaScript predicate as a super user, check the records they changed.
