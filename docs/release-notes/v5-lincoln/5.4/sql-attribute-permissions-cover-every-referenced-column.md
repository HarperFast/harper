---
section: 'SQL'
---

### SQL Attribute Permissions Cover Every Referenced Column

SQL now checks a role's attribute permissions on every column a statement references, on both engines, except the primary key of an `UPDATE` or `DELETE` target. Before, a role denied `read` on a column could still filter or join on it through `JOIN … USING`, an unqualified column in `JOIN … ON`, a deeply nested column, or the `WHERE` of an `UPDATE` or `DELETE`. A denied column now returns `403`.

**Upgrade impact:**

- `UPDATE` and `DELETE` need `read` on the columns they filter on or read, other than the primary key: a role denied `read` on `id` can still run `DELETE … WHERE id = 'x'`.
- For roles other than super user, a qualifier that names no single table returns `403`, and so do whole-row expressions: `_`, a bare `SELECT VALUE` or `ROW`, JavaScript expressions and parameters.
- Legacy SQL refuses with `400` a statement whose text would read back as more columns than it names ([harper#3804](https://github.com/HarperFast/harper/pull/3804)).
