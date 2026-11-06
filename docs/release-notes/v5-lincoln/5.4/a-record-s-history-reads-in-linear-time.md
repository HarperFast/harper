---
section: 'Transactions'
---

### A Record's History Reads in Linear Time

`read_audit_log`, `Table.getHistory()`, `Table.getHistoryOfRecord()` and durable MQTT sessions resuming at QoS 1 or 2 rebuilt each patched version of a record from the record's current value. Their cost grew with the square of the record's patches: a record patched every 90 seconds took tens of seconds of CPU to list once three days of audit history had built up. Each version is now built from the one before it, so the cost grows linearly with the number of patches, and the results are unchanged. Tables without a schema and sharded tables keep the previous per-version rebuild ([harper#3569](https://github.com/HarperFast/harper/issues/3569), [harper#3032](https://github.com/HarperFast/harper/issues/3032)).
