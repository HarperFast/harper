---
title: Storage Tuning
---

# Storage Tuning

Harper's `storage` configuration section controls how database files are written, cached, and reclaimed on disk. Defaults are tuned for safety and balanced throughput; this page covers the knobs that matter for production deployments with specific workload profiles.

For a quick reference of every option, see [Configuration Options — `storage`](../configuration/options.md#storage). For the underlying mechanics, see [Storage Algorithm](./storage-algorithm.md).

## Durability vs. Throughput

### `storage.writeAsync`

Type: `boolean` &nbsp;•&nbsp; Default: `false`

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

Type: `duration string` &nbsp;•&nbsp; Default: `45s`

The maximum estimated time a write may wait in the commit queue before Harper rejects new writes with HTTP 503. Acts as backpressure when downstream disk I/O cannot keep up with incoming writes.

Lower this in latency-sensitive systems where it is better to shed load early than to let request queues grow. Raise it when occasional disk-write bursts are expected and the application can tolerate longer commit latency.

```yaml
storage:
  maxTransactionQueueTime: 30s
```

## Compression

### `storage.compression`

Type: `boolean | object` &nbsp;•&nbsp; Default: `true`

LZ4 record compression is enabled by default. It typically reduces on-disk size by 2–4× for JSON-like records with modest CPU cost.

For object form:

| Property     | Type     | Description                                                                                                                  |
| ------------ | -------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `dictionary` | `string` | Path to a [Zstd-style](https://github.com/facebook/zstd) compression dictionary. Training a dictionary on representative records improves the compression ratio for small records. |
| `threshold`  | `number` | Records smaller than this many bytes are stored uncompressed. Useful when small records dominate and the overhead of compression headers outweighs gains. |

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

Type: `string | string[]` &nbsp;•&nbsp; Default: `<rootPath>/blobs`

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

Type: `boolean` &nbsp;•&nbsp; Default: `true`

Before a write transaction commits, Harper loads the affected pages into memory if not already present. This avoids stalling the commit on a page fault.

Disable only when memory pressure makes the prefetch counterproductive — for example, when transactions touch records on cold pages that are not expected to be re-read soon.

### `storage.noReadAhead`

Type: `boolean` &nbsp;•&nbsp; Default: `false`

Advises the OS via `posix_fadvise` not to read ahead beyond the requested pages. Useful for random-access workloads on rotational disks where speculative reads pollute the page cache. Leave at the default for sequential or scan-heavy workloads.

### `storage.pageSize`

Type: `number` &nbsp;•&nbsp; Default: OS page size (typically 4096 bytes)

Changes the database page size. Larger pages can reduce write amplification for large records but increase the minimum I/O unit. **Only set this on a fresh database** — existing files cannot be migrated to a different page size.

### `storage.caching`

Type: `boolean` &nbsp;•&nbsp; Default: `true`

In-memory record caching of decoded records. Disable to reduce heap usage when records are large and unlikely to be re-read in the same process.

## Storage Reclamation

`storage.reclamation` controls how Harper evicts data from caching tables (tables with [`sourcedFrom`](../resources/resource-api.md#sourcedfromresource-options)) when disk usage runs high. Reclamation does **not** affect non-caching tables — those rely on explicit deletion, TTL expiration, or [compaction](./compaction.md).

### `storage.reclamation.threshold`

Type: `number` (ratio) &nbsp;•&nbsp; Default: `0.4`

Minimum fraction of the volume that should remain free. When free space falls below this ratio, reclamation begins evicting expired and lightly-used entries from caching tables. A larger value reclaims earlier and more aggressively; a smaller value defers reclamation closer to the volume filling.

### `storage.reclamation.interval`

Type: `duration string` &nbsp;•&nbsp; Default: `1h`

How often Harper checks free space against the threshold. Lower intervals catch fast-filling volumes sooner at the cost of more periodic I/O.

### `storage.reclamation.evictionFactor`

Type: `number` &nbsp;•&nbsp; Default: `100000`

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

Type: `boolean` &nbsp;•&nbsp; Default: `false`

Runs [compaction](./compaction.md) on all non-system databases at startup. Useful when deployments include scheduled restarts and you want to reclaim fragmented space as part of the maintenance window.

### `storage.compactOnStartKeepBackup`

Type: `boolean` &nbsp;•&nbsp; Default: `false`

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
