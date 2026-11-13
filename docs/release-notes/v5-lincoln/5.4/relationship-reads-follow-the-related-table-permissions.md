---
section: 'Security'
---

### Relationship Reads Follow the Related Table's Permissions

A read through an `@relationship` in REST (`GET` and `QUERY`), GraphQL or the NoSQL operations now needs `read` on the related table and on each related attribute it uses. Before, only REST and GraphQL selects were checked: conditions and sorts through a relationship, `get_attributes` and `*`, reads without a select that return `@enumerable` relationships, property paths such as `/Emp/e1.dept`, and `$record` returned related data unchecked. A denied condition or sort now returns `403`, and a default or `*` read leaves out or narrows the relationships the role cannot read. Nested relationship conditions, including those in boolean groups, are checked the same way, and a property read no longer returns a scalar the caller cannot read. Super users and full-access roles see no change. SQL follows the same rule; see [Relationship Columns Follow the Related Table's Permissions](#relationship-columns-follow-the-related-tables-permissions) ([harper#3316](https://github.com/HarperFast/harper/pull/3316), [harper#3910](https://github.com/HarperFast/harper/pull/3910)).
