---
section: Querying
---

### Undefined Secondary Sort Keys Are Refused on Sealed Tables

On a sealed table, a search's secondary sort (`next`) whose attribute the current schema does not declare is now rejected with a 404, as a first sort attribute already was outside an `or` search. A sort inside a relationship's `select` is not checked. Before, it was not checked: it ordered by nothing, or by values that rows written before the table was sealed still hold; declare the attribute to keep sorting by those. Record metadata such as `$updatedtime` and `$distance`, and paths that start at a declared attribute, remain valid sort keys. Open tables skip the schema check. A secondary sort with no attribute, or an empty path, is refused on every table. See [`sort`](/reference/v5/resources/resource-api#sort).
