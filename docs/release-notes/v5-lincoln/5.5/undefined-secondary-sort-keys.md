---
section: Querying
---

### Undefined Secondary Sort Keys Are Refused

A secondary sort (`next`) on an attribute the table does not define is now rejected with a 404, as a first sort attribute already was, rather than silently ignored. Record metadata such as `$updatedtime`, `$distance`, and paths into a plain object remain valid sort keys. See [`sort`](/reference/v5/resources/resource-api#sort).
