---
section: 'SQL'
---

### Literal-on-the-Left Range Comparisons

Under `sql.engine: auto` and `new`, range comparisons with a literal on the left (`WHERE 5 < id`, `WHERE 7 >= id`, `WHERE NOT (5 >= id)`, `WHERE 5 <= id AND id <= 7`) now flip the comparator when pushed down to table search, returning, updating, and deleting the same rows as the column-on-the-left form.
