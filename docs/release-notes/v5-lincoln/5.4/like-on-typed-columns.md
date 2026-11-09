---
section: SQL
---

### LIKE Keeps Numeric Values and Patterns Distinct

SQL `LIKE` on a non-String column now matches the stringified value in `SELECT`, `UPDATE`, and `DELETE`. Numeric `105` matches `%05%` and `1%`, but not `0105` or `05%`; an empty pattern matches no numeric, null, or omitted value. Previously, converting a pattern to the column type could select or modify the wrong rows.

Only declared scalar `String` columns use LIKE index rewrites. Untyped columns, including dynamic-schema tables created through the Operations API, now use row filtering too: standalone LIKE queries fall back to legacy under `auto`, and need another index driver or `sql.allowFullScan: true` under `new`. See [LIKE Pattern Matching](/reference/v5/operations-api/sql#like-pattern-matching).

REST and Resource conditions also preserve string operands for `contains`, `ends_with`, and `starts_with`, including aliases and negation. Leading zeros stay significant: `contains '05'` no longer matches numeric `5`. Nonnumeric text on a numeric attribute now runs the text comparison instead of returning a numeric-conversion error. Resource `starts_with` retains its string-only matching behavior; SQL uses its own matcher for other types.
