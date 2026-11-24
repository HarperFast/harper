---
section: Querying
---

### Undefined Secondary Sort Keys Are Refused

A secondary sort (`next`) on an attribute the table does not define is now rejected with a 404, as a first sort attribute already was, rather than silently ignored. The table's record metadata, such as `$updatedtime` and `$distance`, and paths into an untyped field, on this table or a related one, remain valid sort keys; a path that continues past a declared scalar is also refused. See [`sort`](/reference/v5/resources/resource-api#sort).
