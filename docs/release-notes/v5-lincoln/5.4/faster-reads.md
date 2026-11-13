---
section: 'Performance'
---

### Faster Reads

- A REST `GET` of a record by id takes about 18% fewer instructions on uWS and 16% on Node HTTP, with less garbage-collection time, by dropping per-request work a plain read never uses ([harper#3850](https://github.com/HarperFast/harper/pull/3850), [harper#3740](https://github.com/HarperFast/harper/pull/3740), [harper#3837](https://github.com/HarperFast/harper/pull/3837)).
- A select of only the primary key, or the primary key plus the indexed attribute its one condition scans (`GET /Product/?score=gt=10&select(id,score)`), is answered from the index entries instead of reading each record: 54-56% faster on RocksDB and 66-84% on LMDB at 2,000 rows. On a caching table, such a select returns an expired entry until it is evicted, without refreshing it ([harper#3938](https://github.com/HarperFast/harper/pull/3938)).
- Records of 1 KiB or more now move up in the record cache when read; before, they aged out first in, first out ([harper#3849](https://github.com/HarperFast/harper/pull/3849)).
- A user or role change rechecks only the live subscriptions of the principals it affects, and token expiry runs on a timer, so re-authorizing 100,000 or more subscriptions no longer holds a worker's event loop ([harper#3141](https://github.com/HarperFast/harper/pull/3141)).
