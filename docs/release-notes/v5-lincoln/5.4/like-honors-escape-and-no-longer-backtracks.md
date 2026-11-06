---
section: 'SQL'
---

### LIKE Honors ESCAPE and No Longer Backtracks

[Match SQL LIKE in linear time and honor LIKE … ESCAPE, in both SQL engines](https://github.com/HarperFast/harper/pull/3936) fixes two `LIKE` problems on both SQL engines. `LIKE pattern ESCAPE 'c'` now makes the character after `c` literal in `SELECT`, `UPDATE` and `DELETE`. Before, `ESCAPE` was ignored, so `ip LIKE 't0!%' ESCAPE '!'` selected, updated or deleted every value starting with `t0!` instead of only `t0%`. Matching also no longer backtracks: testing a value takes time at most proportional to its length times the pattern's length, where a pattern such as `'%_%_%_%_%_%_%_%_%_%_%_%_%_%_Z'` against a long value could block a thread before.

**Upgrade impact:**

- On both engines, `_` now matches line breaks (`\n`, `\r`, U+2028, U+2029); previously it matched none on either engine, so a pattern such as `'a_b'` in `SELECT`, `UPDATE` or `DELETE` now also matches `a\nb`.
- On the new engine, `*` is now a literal (it acted as a regular-expression quantifier), and `%` now matches line breaks, as it already did on the legacy engine.
- On the legacy engine, `\`, `^` and `$` are now literals. They acted as regular-expression syntax, so `'a\d'` matched `a5`.
- On both engines, these are rejected with a 400 error: a pattern segment between `%` wildcards longer than 10,000 characters, a pattern ending in the escape character, and an `ESCAPE` value that is not a single-character string. On the legacy engine, so is a character-class range written backwards (such as `[z-a]`), or a pattern with more than 64 `_` wildcards across segments that also contain literal characters or `[...]` classes when it also contains a character from every consecutive pair of reserved Unicode noncharacters (`U+FDD0` to `U+FDEF`, `U+FFFE` to `U+FFFF`) and Private Use Area characters (`U+E000` to `U+F8FF`). The legacy engine checks a pattern when it tests a row against it.

`LIKE` is still case-sensitive on the new engine and case-insensitive on the legacy engine. Under the default `sql.engine: auto`, the case behavior depends on which engine runs the statement, so adding or removing an index can change the rows a `LIKE` in an `UPDATE` or `DELETE` matches. See [LIKE Pattern Matching](/reference/v5/operations-api/sql#like-pattern-matching).
