---
section: 'REST'
order: 20
---

### HTTP Preconditions on Reads and Writes

REST now honors all four HTTP preconditions: `If-Match`, `If-None-Match`, `If-Modified-Since` and `If-Unmodified-Since`, with the existing ETags. A matching `GET` or `HEAD` returns an empty `304`, and a failed precondition returns `412`. A single-record `PUT`, `PATCH` or `DELETE` checks its precondition once, before any write is staged, so a failed condition leaves nothing in the transaction log. Before, `If-Match` and the date preconditions were ignored, and `If-None-Match` was checked after the write, so a mutation could change data and still return `304`. On RocksDB the check holds the record's lock by default (`rest.preconditionLocks`); see [Conditional Writes Without Cluster Record Locks](#conditional-writes-without-cluster-record-locks) and [Conditional Writes](/reference/v5/rest/headers#conditional-writes) ([harper#3229](https://github.com/HarperFast/harper/pull/3229)).
