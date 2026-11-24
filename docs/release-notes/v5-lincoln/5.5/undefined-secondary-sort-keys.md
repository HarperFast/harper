---
section: Querying
---

### Undefined Secondary Sort Keys Are Refused on Sealed Tables

On a sealed table, a secondary sort (`next`) on an attribute the current schema does not declare is now rejected with a 404, as a first sort attribute already was, rather than silently ignored. If rows written before the table was sealed hold that attribute, declare it to sort by it again. Record metadata such as `$updatedtime` and `$distance`, and paths that start at a defined attribute, remain valid sort keys. An open table can store attributes it does not declare, so its secondary sorts are not checked. See [`sort`](/reference/v5/resources/resource-api#sort).
