---
section: 'REST'
order: 20
---

### CSV `select(*)` Keeps Declared Columns

A `text/csv` response to `select(*)` from a custom `get` now starts its header with the table's declared attributes, then adds any other key on the first row. An optional attribute missing from the first row keeps its column and the values of later rows. A custom `get` that returns a response envelope (`{ headers, data }`) or throws a `Response` also gets its scalar and tuple `select()` shaped as a plain return is, instead of an empty CSV body. See [CSV](/reference/v5/rest/content-types).
