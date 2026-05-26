---
title: Storage Tuning
---

# Storage Tuning

Harper's `storage` configuration section controls how database files are written, cached, and reclaimed on disk. Defaults are tuned for safety and balanced throughput; this page covers the knobs that matter for production deployments with specific workload profiles.

For a quick reference of every option, see [Configuration Options — `storage`](../configuration/options.md#storage). For the underlying mechanics, see [Storage Algorithm](./storage-algorithm.md).

## Durability vs. Throughput

### `storage.writeAsync`

Type: `boolean`

Default: `false`

Disables `fsync` on commit. Writes return as soon as data is queued to the page cache, dramatically increasing throughput on write-heavy workloads.

**This disables durability guarantees.** A power loss or OS crash between the application commit and the OS flushing pages to disk can lose recently committed transactions. The database itself remains structurally consistent — only the most recent writes are at risk.

Enable only when:

- The data is reproducible from an upstream source (e.g., caches with `sourcedFrom`).
- The workload is bulk ingest where some loss on crash is acceptable and the operation can be re-run.
- Replication provides durability — peers acknowledge writes before they could be lost.

```yaml
storage:
  writeAsync: true
```

### `storage.maxTransactionQueueTime`

Type: `string` (duration)

Default: `45s`

The maximum estimated time a write may wait in the commit queue before Harper rejects new writes with HTTP 503. Acts as backpressure when downstream disk I/O cannot keep up with incoming writes.

Lower this in latency-sensitive systems where it is better to shed load early than to let request queues grow. Raise it when occasional disk-write bursts are expected and the application can tolerate longer commit latency.

```yaml
storage:
  maxTransactionQueueTime: 30s
```

## Compression

### `storage.compression`

Type: `boolean | object`

Default: `true`

LZ4 record compression is enabled by default. It typically reduces on-disk size by 2–4× for JSON-like records with modest CPU cost.

For object form:

| Property     | Type     | Description                                                                                                                                                                        |
| ------------ | -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `dictionary` | `string` | Path to a [Zstd-style](https://github.com/facebook/zstd) compression dictionary. Training a dictionary on representative records improves the compression ratio for small records. |
| `threshold`  | `number` | Records smaller than this many bytes are stored uncompressed. Useful when small records dominate and the overhead of compression headers outweighs gains.                          |

```yaml
storage:
  compression:
    threshold: 256
    dictionary: ~/hdb/keys/records.dict
```

Disable entirely for workloads dominated by small numeric records or pre-compressed payloads (e.g., images, video):

```yaml
storage:
  compression: false
```

## Blob Storage Paths

### `storage.blobPaths`

Type: `string | string[]`

Default: `<rootPath>/blobs`

Blob attributes (declared with `Blob` in `schema.graphql` or written via [`createBlob`](./api.md)) are stored outside the main database files. `blobPaths` accepts a single path or an array — Harper distributes blob writes across the listed paths.

Common configurations:

- **Separate fast disk for blobs:** Place `blobPaths` on a higher-bandwidth volume (e.g., NVMe) while keeping the index on a smaller, lower-latency drive.
- **Multiple volumes:** Provide an array to spread storage across drives. Harper picks the path with the most free space for each new blob, providing crude load-balancing without RAID.
- **Storage tiers:** Mount large but slower object storage at one of the paths to absorb older blobs while keeping hot blobs on fast storage.

```yaml
storage:
  blobPaths:
    - /mnt/nvme0/harper-blobs
    - /mnt/nvme1/harper-blobs
```

Blobs are not relocated when `blobPaths` changes — only new blobs honor the updated configuration. Existing blob references continue to resolve at their original path.

## Read & Write Behavior

### `storage.prefetchWrites`

Type: `boolean`

Default: `true`

Before a write transaction commits, Harper loads the affected pages into memory if not already present. This avoids stalling the commit on a page fault.

Disable only when memory pressure makes the prefetch counterproductive — for example, when transactions touch records on cold pages that are not expected to be re-read soon.

### `storage.noReadAhead`

Type: `boolean`

Default: `false`

Advises the OS via `posix_fadvise` not to read ahead beyond the requested pages. Useful for random-access workloads on rotational disks where speculative reads pollute the page cache. Leave at the default for sequential or scan-heavy workloads.

### `storage.pageSize`

Type: `number`

Default: OS page size (typically 4096 bytes)

Changes the database page size. Larger pages can reduce write amplification for large records but increase the minimum I/O unit. **Only set this on a fresh database** — existing files cannot be migrated to a different page size.

### `storage.caching`

Type: `boolean`

Default: `true`

In-memory record caching of decoded records. Disable to reduce heap usage when records are large and unlikely to be re-read in the same process.

## RocksDB Memory

RocksDB exposes two large native memory pools that Harper makes tunable: a shared **block cache** for hot SST blocks, and an optional **WriteBufferManager** that caps total memtable memory across every database in the process. These options apply only when `storage.engine` is `rocksdb`.

### How RocksDB reads are cached

A read of a record that isn't in the memtable goes through three tiers before reaching disk:

1. **Block cache** (in-process, decompressed) — sized by `storage.rocks.blockCacheSize`. A hit returns in roughly a microsecond with no syscall and no decompression cost.
2. **OS page cache** (kernel, compressed SST file pages) — sized dynamically by the kernel from whatever memory isn't claimed by the process. A block-cache miss that hits the page cache costs a `read` syscall plus decompression — still on the order of microseconds, just an order of magnitude slower than the block cache.
3. **Disk** — if neither cache holds the page, RocksDB reads from the SST file directly.

Harper uses buffered I/O, so the OS page cache is always in play. The implication for sizing: shrinking the block cache doesn't directly translate to more disk reads — it shifts hits from the block cache (decompressed) to the OS page cache (compressed). The OS page cache also adjusts dynamically to host-wide memory pressure, which the block cache does not. Reserving less memory for the block cache leaves more for the page cache and for unrelated allocations on the host.

The trade-off favors a larger block cache when read latency matters and the working set fits; it favors a smaller block cache when memory pressure or noisy neighbors are the dominant concern.

### `storage.rocks.blockCacheSize`

<VersionBadge version="v5.1.0" />

Type: `number` (bytes)

Default: 25% of constrained (cgroup) or total memory

The shared LRU cache for decompressed SST blocks. Every RocksDB database in the process draws from this single pool.

The cache fills as blocks are read; it does **not** shrink on idle. Once the cache reaches its high-water mark for a workload, entries persist until LRU eviction or a manual capacity change. A long-running instance with a brief burst of activity will hold the cached blocks for the lifetime of the process.

```yaml
storage:
  rocks:
    blockCacheSize: 268435456 # 256 MB
```

Lower the cache size when:

- The host has limited memory headroom and the OS page cache is a meaningful second tier.
- Read access patterns favor a warm working set far smaller than 25% of memory.
- The instance runs under a strict cgroup limit and the headroom is needed for memtables or application heap.

Raise it (or leave at the default) when reads dominate and the working set comfortably fits at 25%.

### `storage.rocks.writeBufferManagerSize`

<VersionBadge version="v5.1.0" />

Type: `number` (bytes)

Default: `0` (disabled)

When set, Harper attaches a single RocksDB `WriteBufferManager` to every opened database in the process. Total memtable memory — including active memtables, immutable memtables awaiting flush, and the maintain-window history that RocksDB's OptimisticTransactionDB retains for conflict checking — is capped at this size across the entire process.

Without a `WriteBufferManager`, each column family (table) manages its own memtable budget. The total grows with the number of column families: each one retains roughly `max_write_buffer_size_to_maintain` worth of recently-flushed memtables for snapshot reads and conflict detection. A database with many tables can accumulate hundreds of megabytes to a few gigabytes of resident anonymous memory before any cap is reached.

Enabling the manager bounds that growth at a single configurable limit:

```yaml
storage:
  rocks:
    writeBufferManagerSize: 268435456 # 256 MB total memtable budget
```

The manager affects new databases opened after it is configured; existing open databases retain whatever budget they were attached with.

### `storage.rocks.writeBufferManagerCostToCache`

<VersionBadge version="v5.1.0" />

Type: `boolean`

Default: `false`

When `true`, memtable memory tracked by the `WriteBufferManager` is **charged against the block cache** as pinned cache entries. The block cache and write buffers then share a single accounting pool, visible through one operational metric (`rocksdb.block-cache-usage`).

This does not let the cache "shrink" to make room for writes — pinned entries cannot be evicted by LRU — but it unifies observability and bounds the combined memory footprint when `writeBufferManagerSize` is at or below `blockCacheSize`.

Has no effect when `storage.rocks.writeBufferManagerSize` is `0` or when the block cache is disabled.

```yaml
storage:
  rocks:
    blockCacheSize: 536870912 # 512 MB
    writeBufferManagerSize: 268435456 # 256 MB
    writeBufferManagerCostToCache: true
```

### `storage.rocks.writeBufferManagerAllowStall`

<VersionBadge version="v5.1.0" />

Type: `boolean`

Default: `false`

Controls behavior when memtable memory reaches `writeBufferManagerSize`:

- `false` (soft cap) — Memtables may briefly exceed the limit. RocksDB compensates by flushing more aggressively. Writes proceed without latency spikes; total memory may temporarily overshoot during bursts.
- `true` (hard cap) — Writes are stalled until flushes free up memory. Total memtable memory is strictly bounded; write latency can spike during bursts.

Use the default (`false`) for most workloads. Enable stalling only when a strict OOM-prevention guarantee is required and the application can tolerate occasional write-latency spikes.

This option is the only `WriteBufferManager` setting that can be changed at runtime — `costToCache` is fixed at first creation.

## Storage Reclamation

`storage.reclamation` controls how Harper evicts data from caching tables (tables with [`sourcedFrom`](../resources/resource-api.md#sourcedfromresource-options)) when disk usage runs high. Reclamation does **not** affect non-caching tables — those rely on explicit deletion, TTL expiration, or [compaction](./compaction.md).

### `storage.reclamation.threshold`

Type: `number` (ratio)

Default: `0.4`

Minimum fraction of the volume that should remain free. When free space falls below this ratio, reclamation begins evicting expired and lightly-used entries from caching tables. A larger value reclaims earlier and more aggressively; a smaller value defers reclamation closer to the volume filling.

### `storage.reclamation.interval`

Type: `string` (duration)

Default: `1h`

How often Harper checks free space against the threshold. Lower intervals catch fast-filling volumes sooner at the cost of more periodic I/O.

### `storage.reclamation.evictionFactor`

Type: `number`

Default: `100000`

Tunes the heuristic used to evict entries early when reclamation priority is high. The heuristic considers each entry's remaining time-to-expiration, record size, and how long ago it was last refreshed. Lowering this evicts more aggressively when free space is critical; raising it preserves entries longer.

```yaml
storage:
  reclamation:
    threshold: 0.3 # start reclaiming at 30% free
    interval: 30m
    evictionFactor: 50000
```

For a deeper discussion of how `sourcedFrom` interacts with reclamation, see [Resource API — `sourcedFrom`](../resources/resource-api.md#sourcedfromresource-options).

## Compaction on Start

### `storage.compactOnStart`

Type: `boolean`

Default: `false`

Runs [compaction](./compaction.md) on all non-system databases at startup. Useful when deployments include scheduled restarts and you want to reclaim fragmented space as part of the maintenance window.

### `storage.compactOnStartKeepBackup`

Type: `boolean`

Default: `false`

Retains the pre-compaction backup files after `compactOnStart` runs. Recommended for the first few cycles in production while validating compaction behavior; the backups can be removed manually once confidence is established.

## Workload Recipes

**Write-heavy ingest, durability via replication:**

```yaml
storage:
  writeAsync: true
  prefetchWrites: true
  maxTransactionQueueTime: 60s
```

**Read-heavy cache layer with large blobs:**

```yaml
storage:
  caching: true
  blobPaths:
    - /mnt/fast-ssd/harper-blobs
  reclamation:
    threshold: 0.2
    interval: 15m
```

**Memory-constrained edge deployment:**

```yaml
storage:
  caching: false
  noReadAhead: true
  compression: true
```

## Related

- [Configuration Options](../configuration/options.md) — full list of `storage` options
- [Storage Algorithm](./storage-algorithm.md) — how Harper stores records and indexes on disk
- [Compaction](./compaction.md) — reclaiming space inside existing database files
- [Resource API — `sourcedFrom`](../resources/resource-api.md#sourcedfromresource-options) — caching tables that interact with reclamation
- [Database API — `createBlob`](./api.md) — creating blobs that live under `blobPaths`
