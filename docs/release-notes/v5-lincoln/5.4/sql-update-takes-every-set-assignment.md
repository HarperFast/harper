---
section: 'SQL'
---

### SQL UPDATE Takes Every SET Assignment

On the new SQL engine, an `UPDATE` that assigns a column more than once now applies every assignment in order: `SET qty = qty + 2, qty = qty + 3` adds 5 and `SET qty = 20, qty = qty + 5` sets 25. Before, only the last assignment counted (`qty + 3`, and `15`). Every other `SET` expression still reads the row as it was before the `UPDATE`.

`SET qty = T.qty + 1`, naming the target table, is now an atomic increment like `SET qty = qty + 1`; before, concurrent statements lost increments.

**Upgrade impact:**

- `SET col = col + N` on a value that is not a number writes the expression's result instead of `N`: `NULL + 5` is `NULL` (it was `5`), and `'abc' + 5` is `NaN` (it was `5`). A missing value also counts as `NULL`.
- `SET name = name + 5` on a `String` attribute no longer fails with `Operation add ... requires a numeric property`. A `NULL` value stays `NULL`; any other value is rejected as a number written to a `String` attribute, as `SET name = 5` is.
- `SET at = at + 5000` on a `Date` attribute, which failed the same way, now moves the date 5 seconds later.
- The legacy engine still keeps only the last assignment, so under the default `sql.engine: auto`, an `UPDATE` that falls back to it gives the old result. See [Update](/reference/v5/operations-api/sql#update).
