---
section: 'SQL'
---

### Literal-on-the-Left Range Comparisons

Under `sql.engine: auto` and `new`, a range comparison with the literal on the left of an indexed attribute (`WHERE 5 < id`, `WHERE 7 >= id`, `WHERE NOT (5 >= id)`, `WHERE 5 <= id AND id <= 7`) now matches the same rows as the column-on-the-left form in `SELECT`, `UPDATE` and `DELETE`. Before, it matched the mirror-image range: `DELETE FROM t WHERE 5 < id` deleted the records with `id` below 5 instead of above it. Comparisons on unindexed attributes, and statements that ran on the legacy engine, were not affected.

**Upgrade impact:** if you ran `UPDATE` or `DELETE` statements with a literal before `<`, `<=`, `>` or `>=` on an indexed attribute, check the affected records.
