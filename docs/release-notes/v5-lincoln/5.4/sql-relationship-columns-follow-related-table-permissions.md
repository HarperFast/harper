---
section: 'SQL'
---

### Relationship Columns Follow the Related Table's Permissions

SQL now applies a role's permissions on the related table when a statement reads a `@relationship` column, on both SQL engines, as REST, GraphQL and the NoSQL operations do ([harper#3509](https://github.com/HarperFast/harper/issues/3509)). Before, `SELECT dept FROM data.Emp` returned the whole related record to any role that could read `Emp`. A statement that reads a relationship whose related table the role cannot read now returns HTTP 403, wherever the column appears, including `WHERE`, aggregates, legacy SQL's `->` and the rows an `UPDATE` or `DELETE` reads, and `SELECT *` leaves that relationship out. A role with `attribute_permissions` on the related table gets only the related attributes it may read. Super users see no change; roles that can read the related table see none apart from the member-access rule below. See [Relationship Columns](/reference/v5/operations-api/sql#relationship-columns).

**Upgrade impact:**

- A statement from a role that cannot read a relationship's related table now fails with HTTP 403 instead of returning related data. Grant `read` on the related table, or leave the relationship column out of the statement.
- For roles other than super user, legacy SQL member access through a relationship must name its path from the relationship column (`dept->name`); over another expression, such as `COALESCE(dept, x)->name`, or with a computed member name, it now returns HTTP 403.
