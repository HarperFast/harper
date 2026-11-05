---
section: 'Data Loader'
order: 10
---

### Records Matched by the Table's Primary Key

The [Data Loader](/reference/v5/database/data-loader#change-detection) now matches and tracks records by the table's primary key. On a table with a custom `@primaryKey`, user edits to loaded records are kept and data file changes apply; versions before v5.4.0 looked up records by their `id` field, rewriting any record whose `id` field did not match its primary key on each load. A data file that names a `database` now loads only into that database, creating the table there if needed, instead of into a same-named table in the default `data` database. Reordering keys in a nested object no longer counts as a content change. After upgrading, some records loaded by an earlier version stop receiving data file updates; see [Upgrading from versions before 5.4.0](/reference/v5/database/data-loader#change-detection) ([harper#3582](https://github.com/HarperFast/harper/pull/3582)).
