---
section: 'Storage'
---

### New Tables Use Store Names 5.2 Can Read

On RocksDB, a table first created from this release on uses store names that Harper 5.2.15 can read, so a 5.2 install no longer opens it as empty, and writes made there are no longer lost when you upgrade again. Tables first created on 5.3, and tables recreated after a drop, still use names 5.2.15 cannot read. This is store-name compatibility only: it does not make a downgrade safe. After a node has run 5.4 with transaction-log abort markers on (the default), do not downgrade it to 5.3.4 or earlier, which read a failed transaction as committed; see [Failed Transactions Are Marked Aborted](#failed-transactions-are-marked-aborted-in-the-transaction-log) ([harper#3118](https://github.com/HarperFast/harper/pull/3118)).
