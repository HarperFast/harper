---
section: 'SQL'
---

### Falsy, Blank and NaN Values in SQL Conditions

On the new SQL engine, a bare value used as a condition (`WHERE active`, a join `ON`, `HAVING`) no longer selects rows whose value is `0`, `''` or `NaN`, in `SELECT`, `UPDATE` or `DELETE`. It now selects exactly the truthy values, as the legacy engine does. Before, `DELETE FROM t WHERE region = 'west' AND active` also deleted the rows where `active` was `0` or `''`.

Everything below applies to a statement the new engine runs. Under the default `sql.engine: auto`, a statement with no index-driving condition (for example, its only condition is on an unindexed column) falls back to the legacy engine, `UPDATE` and `DELETE` included, and keeps the legacy results, which this change does not touch. The new engine runs it when `sql.allowFullScan` is `true`, or always under `sql.engine: new`, which otherwise rejects it with a 400 error. An indexed condition joined with `AND` (`WHERE grp = 'a' AND qty <> 0`, with `grp` indexed) keeps a statement on the new engine. See [The fallback contract](/reference/v5/operations-api/sql#the-fallback-contract).

An empty or whitespace-only string is no longer read as `0`: `qty = 0` and `qty IN (0)` no longer match it. A join no longer pairs two `NaN` keys.

**Upgrade impact:**

- On the new engine, `qty <> 0` and `qty NOT IN (0)` now match blank strings, as they already did on an indexed column. On an unindexed column, an `UPDATE` or `DELETE` with them now also changes those rows. The legacy engine already matched blank strings with `qty NOT IN (0)` and still excludes them from `qty <> 0`, so a statement that falls back keeps both.
- Against a number, a string that is not a number (blank or not) sorts after every number on an unindexed column too, as indexes and REST conditions already order it. `qty > 0` and `qty >= 5` now match blank strings, and `qty <= 0` and `qty BETWEEN 0 AND 1` no longer do.
- Arithmetic on a blank string is `NaN`, so `UPDATE t SET total = qty * 2` stores `NaN` where `qty` is `''`, as does `SET qty = qty + 1`. Before, they stored `0` and `1`.
- A comparison with `NaN` on a column without an index is now `NULL`. Before, it was false against a number and compared as text against a quoted number, so `v > '0'` matched a `NaN` value. Neither that nor `v NOT BETWEEN 0 AND 1` matches it now, and `NOT (v < 1)` in a select list returns `null` for one.
- A bare `WHERE v` no longer selects a `0n` BigInt.
- Equal infinities are now equal in ordering comparisons: on a column without an index, `Infinity <= Infinity` and `v BETWEEN 0 AND v` are true for an `Infinity` value, where they were false.
- `v NOT BETWEEN NULL AND 1` now matches values above `1`, as `NOT (v >= NULL AND v <= 1)` does. `BETWEEN` with a `NULL` bound still matches no rows.

See [Falsy, Blank and NaN Values](/reference/v5/operations-api/sql#falsy-blank-and-nan-values).
