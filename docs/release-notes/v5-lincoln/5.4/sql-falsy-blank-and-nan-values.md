---
section: 'SQL'
---

### Falsy, Blank and NaN Values in SQL Conditions

On the new SQL engine, a bare value used as a condition (`WHERE active`, a join `ON`, `HAVING`) no longer selects rows whose value is `0`, `''` or `NaN`, in `SELECT`, `UPDATE` or `DELETE`. It now selects exactly the truthy values, as the legacy engine does. Before, `DELETE FROM t WHERE region = 'west' AND active` also deleted the rows where `active` was `0` or `''`.

An empty or whitespace-only string is no longer read as `0`: `qty = 0` and `qty IN (0)` no longer match it. A join no longer pairs two `NaN` keys.

**Upgrade impact:**

- `qty <> 0` and `qty NOT IN (0)` now match blank strings, as they already did on an indexed column. On an unindexed column, an `UPDATE` or `DELETE` with them now also changes those rows.
- Against a number, a string that is not a number (blank or not) sorts after every number on an unindexed column too, as indexes and REST conditions already order it. `qty > 0` and `qty >= 5` now match blank strings, and `qty <= 0` and `qty BETWEEN 0 AND 1` no longer do.
- Arithmetic on a blank string is `NaN`, so `UPDATE t SET total = qty * 2` stores `NaN` where `qty` is `''`. Before, it stored `0`.
- A comparison with `NaN` on a column without an index is now `NULL`. Before, it was false against a number and compared as text against a quoted number, so `v > '0'` matched a `NaN` value. Neither that nor `v NOT BETWEEN 0 AND 1` matches it now, and `NOT (v < 1)` in a select list returns `null` for one.
- A bare `WHERE v` no longer selects a `0n` BigInt.
- Equal infinities are now equal in ordering comparisons: on a column without an index, `Infinity <= Infinity` and `v BETWEEN 0 AND v` are true for an `Infinity` value, where they were false.
- `v NOT BETWEEN NULL AND 1` now matches values above `1`, as `NOT (v >= NULL AND v <= 1)` does. `BETWEEN` with a `NULL` bound still matches no rows.

See [Falsy, Blank and NaN Values](/reference/v5/operations-api/sql#falsy-blank-and-nan-values).
