# Tantivy RocksDB storage design — retired

The September 14, 2026 storage decision replaces this design with
[Native Tantivy storage and Harper derived indexes](https://github.com/HarperFast/fulltext/blob/codex/native-storage-design/docs/native-storage-integration.md).

The Fulltext wrapper and Harper use native Tantivy files only. Harper maintains a separate local
derived index on each node through its existing derived-index runtime. Reuse valid files and replay
on restart; rebuild locally after a fresh replica, restore, missing/corrupt index, or unresumable log.

There is no Harper byte-storage provider, hosted Directory, standalone rocksdb-js datasource,
native lease, or RocksDB storage-comparison release gate. The shared Harper delivery/recovery
protocol remains in use. The old experiment remains in git history; its results describe that
experiment and do not establish native integration performance.
