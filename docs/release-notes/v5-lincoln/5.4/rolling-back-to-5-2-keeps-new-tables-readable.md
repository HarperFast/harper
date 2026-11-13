---
section: 'Storage'
---

### Rolling Back to 5.2 Keeps New Tables Readable

On RocksDB, a table first created from this release on uses store names that Harper 5.2.15 can read, so a rollback to 5.2 no longer opens it as empty, and writes made during the rollback are no longer lost when you upgrade again. Tables first created on 5.3, and tables recreated after a drop, still use names 5.2.15 cannot read ([harper#3118](https://github.com/HarperFast/harper/pull/3118)).
