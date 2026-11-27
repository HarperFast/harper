---
section: 'SQL'
---

### SQL Refuses Names That Could Break Out of Generated Code

Harper's SQL parser, AlaSQL, is updated from 4.22.0 to 4.22.4. It fixes two advisories: prototype pollution through `GROUP BY` keys (GHSA-834p-3m5w-q478) and code injection through quoted names, JSON strings and parameter names that AlaSQL pastes into the JavaScript it generates for a statement (GHSA-67vj-hh8j-j94f). A `GROUP BY` over a column whose value is the string `__proto__` now returns that group as an ordinary row.

**Upgrade impact:** SQL text with either of these fails with a `400` parse error instead of running. Backticks do not make it parse.

- `__proto__`, in any letter case, as a name (`SELECT __proto__`, `a AS __proto__`, `[__proto__]`) or as a whole string literal (`WHERE a = '__proto__'`). A longer string such as `'a __proto__ b'` still works, and so does a stored value of `__proto__` that a query does not spell out.
- A table, column, database or table alias name that holds a backslash or a line break, written in brackets or backticks.

Legacy SQL also writes names back out as text, so it fails in two more places:

- For any role other than super user, `SELECT *` expands to the attributes the role can read. It now fails with `400` when one of them is named `__proto__` or holds a backslash or a line break. Name the attributes you need instead of `*`.
- A table whose primary key attribute is named `__proto__` or holds a backslash was already unreliable through legacy SQL: filtered reads could return missing rows. Statements that rebuild SQL from that key can now fail with a `500` error, and an `UPDATE` or `DELETE` that does fails before it writes anything. A key that is a reserved word, such as `order`, already failed this way.
