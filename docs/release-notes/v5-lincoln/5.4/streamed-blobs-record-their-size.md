---
section: 'Storage'
---

### Streamed Blobs Record Their Size

On RocksDB, a blob saved from a stream of unknown length (`createBlob(stream)` without a `size`, an uploaded request body, or a body fetched from a caching table's source) as a record attribute is now stored with its final size, in the record and in its transaction log entry, as it already was on LMDB. A blob file that was later cut short is then detected: reading it fails with a 500 instead of returning the short content, replication no longer sends it as complete, and the blob repair sweep reports it. Two cases still store no size: a blob nested inside an object or array, and a blob streamed in by a table's `subscribe` source ([#4329](https://github.com/HarperFast/harper/issues/4329)). Records written before this release keep their size-less blob references. A transaction that saves such a blob stages its writes a second time when it commits, so keep large batches of other writes out of the transaction that carries a streamed upload. See [`createBlob`](/reference/v5/database/api#createblobdata-options).
