---
section: 'Replication'
---

### Restarts Behind a Backward Clock Step Stay Above the Origin Floor

On RocksDB, opening a database now raises the transaction clock above the origin-closed floor and issuance ceiling the database last persisted. After a restart behind a backward wall-clock step, every transaction therefore starts above the floor this node advertised to peers and above every key it issued ahead of the clock. Before, only the transaction-log keys Harper assigned to its own writes were moved up, and once a record lock was admitted ahead of the clock, every write paid an extra atomic step for the rest of the process ([harper#2629](https://github.com/HarperFast/harper/issues/2629)).

- A database whose persisted floor or ceiling is more than ten years ahead of the host clock now refuses to open, and the error names both values. This usually means the host clock is wrong (for example, a reset hardware clock): correct it and restart. If the clock is already correct, the bound was persisted while the clock ran more than ten years ahead: the database opens only once wall time is within ten years of it, and its transaction clock then runs that far ahead.
- `storage.maxLockClockSkew` is now measured from wall time only, so a lock admitted ahead of the clock can no longer stretch the limit for the next one.
