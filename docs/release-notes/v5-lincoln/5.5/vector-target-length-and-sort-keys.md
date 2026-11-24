---
section: Querying
---

### Wrong-Length Vector Targets and Undefined Sort Keys Are Refused

A vector search `target` whose length differs from the stored vectors, such as one embedded with a different model, is now rejected with a 400 that names both lengths, instead of returning results ranked by a meaningless distance ([harper#4482](https://github.com/HarperFast/harper/issues/4482)). A secondary sort (`next`) on an attribute the table does not define is rejected with a 404, as a first sort attribute already was, rather than silently ignored. See [Vector Indexing](/reference/v5/database/schema#vector-indexing) and [`sort`](/reference/v5/resources/resource-api#sort).
