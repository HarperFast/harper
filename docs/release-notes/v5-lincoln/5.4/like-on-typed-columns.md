---
section: SQL
---

### LIKE Keeps Numeric Values and Patterns Distinct

SQL `LIKE` on a non-String column now matches the stringified value in `SELECT`, `UPDATE`, and `DELETE`. Numeric `105` matches `%05%` and `1%`, but not `0105` or `05%`; an empty pattern matches no numeric, null, or omitted value. Previously, converting a pattern to the column type could select or modify the wrong rows.

Only declared scalar `String` columns use LIKE index rewrites. `ID` columns (which also permit tuple values), untyped columns, `Any`, and lists now use row filtering too. Lists match their comma-joined text rather than individual elements: `['news', 'sports']` matches `news,sports` and `%s,sp%`, but not `sports%`. Without another index driver, standalone LIKE queries fall back to legacy under `auto` with the default `sql.allowFullScan: false`; `sql.allowFullScan: true` keeps them on the new engine. Under `new`, they need another index driver or `sql.allowFullScan: true`. **Upgrade impact:** a standalone prefix or exact LIKE on an `ID`, `Any`, list, or untyped column can now run case-insensitively under `auto`. For example, `mixed LIKE 'Pen%'` can match both `Penny` and `penelope`, including in `UPDATE` and `DELETE`. Add an indexed condition to keep residual matching on the new engine, or declare a scalar `String` column to retain prefix index service. See [LIKE Pattern Matching](/reference/v5/operations-api/sql#like-pattern-matching).

REST and Resource conditions also preserve string operands for `contains`, `ends_with`, and `starts_with`, including aliases and negation. Leading zeros stay significant: `contains '05'` no longer matches numeric `5`. On numeric fields, empty `contains` and `ends_with` operands now match every non-null value. Text operands are no longer parsed as numeric, Boolean, or Date values; text that previously caused a conversion error now runs the text comparison. Resource `starts_with` retains its string-only matching behavior; SQL uses its own matcher for other types.
