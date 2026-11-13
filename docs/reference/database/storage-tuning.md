---
title: Storage Tuning
sidebar_position: 60
sidebar_label: 'Storage Tuning'
---

# Storage Tuning

Harper's `storage` configuration section controls how database files are written, cached, and reclaimed on disk. Defaults are tuned for safety and balanced throughput; this page covers the knobs that matter for production deployments with specific workload profiles.

For a quick reference of every option, see [Configuration Options — `storage`](../configuration/options.md#storage). For the underlying mechanics, see [Storage Algorithm](./storage-algorithm.md).

## Durability vs. Throughput

On RocksDB (the default storage engine), Harper does not call `fsync` or `fdatasync` when committing a transaction, and RocksDB's own Write-Ahead Log (WAL) is disabled for table stores. When the [transaction log](./transaction.md) is enabled (the default via [`logging.auditLog: true`](../logging/configuration.md), inherited by tables unless [`@table(audit: false)`](./transaction.md#enabling-the-transaction-log-per-table)), each acknowledged commit is written to Harper's transaction log (`database/<db>/transaction_logs/`) using a standard write to the OS page cache. On startup, Harper replays the transaction log to recover any committed writes that had not yet been flushed from RocksDB's in-memory memtables to table files.

What an acknowledged write survives on a single node:

- **Harper process crash or restart**: Survived when transaction logging is enabled (the default). Committed bytes are already in the OS page cache, so the operating system preserves and flushes them to disk even if the Harper process terminates unexpectedly, and Harper replays the transaction log on restart. If transaction logging is disabled globally (`logging.auditLog: false`) or for a table (`@table(audit: false)`), no transaction-log entry is written while RocksDB's WAL remains off, so unflushed memtable writes are also lost on a Harper process crash.
- **OS crash, kernel panic, power loss, or host failure**: Recent writes that the OS has not yet flushed from the page cache to disk can be lost. On a single-node or Harper core deployment (where replication is not available), durability against OS or power failure depends on periodic OS page-cache writeback. The database remains structurally consistent — only the most recent un-flushed commits are at risk.

For durability against machine, OS, power, or storage failure in a multi-node (Harper Pro) cluster, Harper relies on **replication confirmation** rather than local disk `fsync`. In production failures such as host failure or storage hardware loss, a local disk fails or becomes unreachable together with the rest of the machine, whereas an acknowledgement from a peer node on an independent machine means the write has been committed off-host. Because confirming RocksDB peers also commit to their own OS page cache without `fsync` and confirmation counts any `<k>` responding peers, surviving a power outage or site-wide failure requires peers in separate power or failure domains and setting `<k>` greater than the number of peers that share the writer's failure domain.

To require confirmation from `<k>` peer nodes before a write returns, use [replication confirmation](../replication/sharding.md):

- **Operations API**: Set [`replicatedConfirmation: <k>`](../replication/sharding.md#replication-control-via-operations-api) in the operation payload. Omit `replicateTo` to use the database's configured replication (every node by default, unless [`replication.databases[].replicateTo`](../replication/sharding.md#replication-count) is set), or set `replicateTo` only when you also want to limit residency (dynamic sharding) to a fixed set of nodes.
- **Resource API**: Set [`context.replicatedConfirmation = <k>`](../replication/sharding.md#programmatic-replication-control) in your resource method (leaving `context.replicateTo` unset to use the database's configured replication, unless you also want to restrict residency).
- **REST**: Pass [`X-Replicate-To: *;confirm=<k>`](../replication/sharding.md#replication-control-via-rest-header) on the request (requires `super_user` permissions; for non-superuser write paths, set `context.replicatedConfirmation` in a Resource method instead) to wait for `<k>` confirmations while keeping the database's configured replication (`*` leaves per-request residency unset; passing a number `<n>` or node list in `X-Replicate-To: <n>;confirm=<k>` pins the record's residency to `<n>` additional nodes from those present at write time).

### `storage.writeAsync`

<EngineBadge engines="LMDB" />

Type: `boolean`

Default: `false`

Applies only to the legacy LMDB storage engine. This setting has no effect on RocksDB, which never calls `fsync` on commit.

On LMDB, enabling `writeAsync` disables `fsync` on commit so writes return as soon as data is queued to the OS page cache, matching RocksDB's commit behavior and increasing throughput on write-heavy workloads. A power loss or OS crash before the OS flushes pages to disk can lose recently committed transactions, while the database remains structurally consistent.

Enable on LMDB databases when:

- Durability across machine failures is handled via [replication confirmation](../replication/sharding.md).
- The data is reproducible from an upstream source (e.g., caches with `sourcedFrom`).
- The workload is bulk ingest where some loss on OS crash or power loss is acceptable and the operation can be re-run.

```yaml
storage:
  writeAsync: true
```

### `storage.maxTransactionQueueTime`

<VersionBadge type="changed" version="v5.2.1" />

Type: `string` (duration)

Default: `45s`

The maximum time a tracked write commit may remain unsettled before Harper rejects new application-originated record updates and publishes on that thread with HTTP 503. This is a per-commit duration check, not a queue-length threshold — it acts as backpressure when downstream disk I/O cannot keep up with incoming writes. Deletes and writes applied from a canonical source (e.g. replication or a caching source) bypass this check.

Beginning with v5.2.1, Harper tracks every outstanding commit attempt for this check. In v5.2.0, only one commit per thread was tracked at a time, so any commit — including a conflict retry or a chained commit — submitted while another was already outstanding could be omitted from overload detection.

The [`transaction-commit-time` metric](../analytics/overview.md#storage-metrics) provides the corresponding commit-latency distribution, but only records each attempt after it settles.

The same duration also limits how long one write keeps retrying conflicts with other writes before it fails with a different HTTP 503, code `TRANSACTION_COMMIT_CONFLICT_TIMEOUT`. See [`storage.rocks.transactionLogAbortMarkers`](#storagerockstransactionlogabortmarkers) for which writes this applies to.

Lower this in latency-sensitive systems where it is better to shed load early than to let request queues grow. Raise it when occasional disk-write bursts are expected and the application can tolerate longer commit latency.

```yaml
storage:
  maxTransactionQueueTime: 30s
```

### `storage.maxTransactionOpenTime`

<EngineBadge engines="RocksDB" /> <VersionBadge version="v5.0.0" />

Type: `number` (milliseconds)

Default: `30000`

The maximum time a transaction may stay open without activity. Give a number of milliseconds; unlike `maxTransactionQueueTime`, this option does not take a duration string such as `30s`. Available since v5.0.0; LMDB databases ignore it and use a fixed 30 seconds. Harper checks open transactions once per this interval, so a stalled transaction is closed between one and two intervals after its last qualifying activity:

- A transaction with uncommitted writes from an application request must keep writing; reads alone do not renew its timeout. When it expires, the writes are aborted and the request fails with status `422`. Split long-running work into smaller transactions.
- A read-only transaction is renewed by reads. When it expires, its read snapshot is released; on RocksDB, a read that continues afterwards fails with `ReadSnapshotExpiredError` (status `503`).

A streamed response, such as a REST collection query, holds its read snapshot while the client reads. On RocksDB, if the client stops reading for longer than this limit, the read fails when the client resumes. <VersionBadge type="changed" version="v5.4.0" /> The `200` status is already sent by then, so a JSON response is cut off rather than returned as a `503`; see [When a Streamed Response Fails](../rest/content-types.md#when-a-streamed-response-fails). Clients that read large results slowly should read promptly, page with [`limit(start,end)`](../rest/querying.md#limitend-or-limitstartend), or raise this limit.

```yaml
storage:
  maxTransactionOpenTime: 60000
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

### `storage.blobRetention`

Type: `number` (milliseconds)

Default: `2000`

How long a superseded blob file is kept on disk after the record that referenced it is overwritten or removed.

A blob's bytes are read lazily: a request resolves the record first, then opens the backing file when it starts streaming the response. If the record is overwritten in between, the file it pointed at is on its way out — and because the failure surfaces after the response headers are already committed, the client sees a truncated body rather than an error status. `blobRetention` is the window that lets those in-flight reads finish.

Raise it when reads are slow enough to outlive the default window — large blobs, slow or heavily backpressured clients, or a busy cache table whose entries are rewritten while being served. Replication peers that have not yet fetched a superseded blob are also covered by this window, so a cluster with significant replication lag wants a value comfortably above that lag.

The cost is disk: superseded blobs written during the window stay on disk for its duration, so the overhang is roughly your blob write rate multiplied by the retention window. Set it to `0` to reclaim as soon as the queue drains.

```yaml
storage:
  blobRetention: 30000
```

If the process exits before a deferred reclamation runs, the file is left behind until the `cleanup_orphan_blobs` operation reclaims it — a longer window widens that gap.

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

### `storage.recordCacheSize`

<VersionBadge version="v5.4.0" /> <EngineBadge engines="RocksDB" />

Type: `number` (entries)

Default: `32768`

How many entries each thread's in-memory record cache holds. The count is per thread: the main thread and every worker thread that opens tables has a cache of this size, and all the tables a thread opens share it, vector indexes included. A record under 1 KB is one entry; a larger record counts as about one entry per 512 bytes, so fewer large records fit. Records past the limit stay readable from the cache until garbage collection reclaims them, but only the limit is protected from collection.

Each cached record costs JavaScript heap on its thread: roughly 2 KB for a small record (about 1,965 bytes per cached 1 KB record, measured with YCSB). `65536` on 4 worker threads and the main thread can hold about 330,000 records, about 640 MB of heap, so leave room for it in [`threads.maxHeapMemory`](../configuration/options.md#threads). A larger cache helps when the records it adds are re-read often. Memory it takes from the RocksDB block cache and the OS page cache can instead make disk reads rise when the data is larger than memory.

The value also sizes RocksDB's verification table, which is what lets a cache hit return without reading RocksDB. Harper sizes the table once, at startup: two slots for each record the threads it starts can cache, rounded up to a power of two. The table is never smaller than RocksDB's default of 131,072 slots, and Harper does not grow it past 1/64 of memory. A slot is 8 bytes, and the whole table is allocated when it is first used, before the caches fill: the default cache on 4 worker threads gets 524,288 slots (4 MB). The threads counted are the main thread, the HTTP worker threads, the replication worker threads and the isolated applications configured at startup. Threads started later, such as job workers or an application later deployed as isolated, are not counted. When [`storage.caching`](#storagecaching) is `false`, the table keeps RocksDB's default size.

The value must be an integer from `4` to `16777215`. Each thread reads it when it opens its first table, so a change takes effect on [restart](../operations-api/operations.md#restart). `restart_service` gives restarted worker threads the new size, but the main thread and the verification table keep theirs until a full restart.

```yaml
storage:
  recordCacheSize: 65536
```

## Record Encoding

### `storage.randomAccessFields`

<VersionBadge version="v5.1.0" />

Type: `boolean`

Default: `false`

Chooses how Harper lays out a table's records on disk.

Either way, a record does not store its own field names: they live in a shared **structure** that the record references by id. What differs is what else the structure captures and how the values are laid out. Under the default _classic_ encoding the structure holds just the ordered field names, and the values follow packed one after another, each carrying its own type tag — so reading any single field means decoding the values ahead of it. Under _random-access (typed)_ encoding the structure also fixes each field's type and width, so a record becomes a fixed-width slot per field followed by a section holding the variable-length values (strings, nested objects). Reading a field is then an offset lookup into the stored bytes instead of a decode of the record, and untagged slots sized to the field make a stable scalar schema somewhat smaller on disk.

The trade is that a structure is minted per distinct record _shape_, where shape means the ordered list of fields plus the encoded type and width each field's value takes — so `{a, b}` and `{b, a}` are different shapes, and so are `{v: 1}`, `{v: 70000}`, and `{v: "ok"}`. A table whose records vary in shape mints many structures, and the dictionary only ever grows.

Enable it when:

- Records are large and requests read only part of them — the fields a request does not touch are never decoded.
- The fields are mostly scalars (numbers, booleans, dates, short strings) with types that do not vary from record to record.
- Records are written in a consistent shape: the same fields, in the same order, with values in a stable magnitude range.

Leave it off when:

- The schema is wide, sparse, or variably typed — a table where each write carries a different subset of fields, or where a field holds a small integer in one record and a large one (or a string) in the next, mints a new structure for each variation.
- Records are small, or reads generally deserialize the whole record anyway. There is little to skip past, so the layout has little to give back.
- The table stores mostly nested objects or long strings, which land in the variable-length section either way.

```yaml
storage:
  randomAccessFields: true
```

Changing this setting is safe for existing data — records already written keep decoding under whichever encoding wrote them, and only new writes change. It is not, however, applied on the fly: a table reads the setting when its store is opened, so like every other configuration change it takes effect on [restart](../operations-api/operations.md#restart). Until then an already-open table keeps reporting the encoding it opened with.

To pin one table's encoding regardless of the global setting, use the [`@table(randomAccessFields:)`](./schema.md#randomaccessfields) directive when creating the table; editing the directive later does not repin an existing table. Tables that carry the directive ignore this option entirely, which also means a fleet-wide change to this setting will not move them.

The typed dictionary is bounded, and reaching the bound is not an error: records with novel shapes past that point still write and read correctly, they are simply stored without random-access field encoding. [`describe_table`](../operations-api/operations.md#record-structure-dictionaries) reports both the current size and the ceiling in force (`typed_structure_count` against `typed_structure_limit`, 256 by default), which is the reliable way to see whether a table's shapes are staying within it. The classic dictionary is bounded far lower — 32 shared named-record structures — so a table with more than 32 distinct field-name sets sits at that number as a matter of course; it is a normal reading, not a leak.

## RocksDB Memory

RocksDB exposes two large native memory pools that Harper makes tunable: a shared **block cache** for hot SST blocks and a **WriteBufferManager** (enabled by default) that caps total memtable memory across every database in the process. These options apply only when `storage.engine` is `rocksdb`.

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

Default: one third of `blockCacheSize` (enabled). Set to `0` to disable.

Harper attaches a single RocksDB `WriteBufferManager` to every opened database in the process. Total memtable memory — including active memtables, immutable memtables awaiting flush, and the maintain-window history that RocksDB's `OptimisticTransactionDB` retains for conflict checking — is capped at this size across the entire process.

Without a `WriteBufferManager`, each column family (table) manages its own memtable budget. The total grows with the number of column families: each one retains roughly `max_write_buffer_size_to_maintain` worth of recently-flushed memtables for snapshot reads and conflict detection. A database with many tables can accumulate hundreds of megabytes to a few gigabytes of resident anonymous memory before any cap is reached. The manager is enabled by default to bound that growth at a single limit.

Override the default to set an explicit budget, or disable it entirely:

```yaml
storage:
  rocks:
    writeBufferManagerSize: 268435456 # 256 MB total memtable budget (0 disables)
```

The configured size affects new databases opened after it is changed; existing open databases retain whatever budget they were attached with.

### `storage.rocks.writeBufferManagerCostToCache`

<VersionBadge version="v5.1.0" />

Type: `boolean`

Default: `true`

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

<VersionBadge version="v5.1.0" /> <VersionBadge type="changed" version="v5.3.0" />

Type: `boolean`

Default: `false` (`true` in v5.2.8 and earlier)

Controls behavior when memtable memory reaches `writeBufferManagerSize`:

- `false` (soft cap) — Memtables may briefly exceed the limit. RocksDB compensates by flushing more aggressively. Writes proceed without latency spikes; total memory may temporarily overshoot during bursts.
- `true` (hard cap) — Writes are stalled until flushes free up memory. Total memtable memory is strictly bounded; write latency can spike during bursts.

The default (`false`) is a soft cap because a stalling manager pauses every writer in the process. When the budget is held across enough column families, nothing triggers the flush that would release the writers, and only a restart recovers. The cost of the soft cap is memory: total memtable memory can overshoot the budget during bursts. Set to `true` for a strict memory bound when write backpressure is acceptable. With stalls allowed, the default [flush policy](#storagerockswritebuffermanagerflushpolicy) is `largestAcrossDBs` (as of v5.4.0), which flushes memory held by idle databases instead of waiting on it.

`allowStall` and `writeBufferManagerFlushPolicy` are re-applied to the running manager when they change, so restarting the worker threads (`restart_service`) is enough to change them. `costToCache` is fixed when the manager is first created.

### `storage.rocks.writeBufferManagerFlushPolicy`

<VersionBadge version="v5.4.0" />

Type: `string` (`oldest`, `largest`, or `largestAcrossDBs`)

Default: `largestAcrossDBs` when `writeBufferManagerAllowStall` is `true`, otherwise `oldest`

Selects which memtable is flushed when memtable memory is over `writeBufferManagerSize`:

- `oldest` — Flush the oldest memtable of the database being written.
- `largest` — Currently behaves like `oldest`, because Harper's databases use atomic flush.
- `largestAcrossDBs` — A background thread flushes whichever database holds the most memtable memory, even if it is not being written.

While no policy is set, the default follows `writeBufferManagerAllowStall`, including later changes to it. With stalls allowed, `oldest` can stall writes forever: the writer waits for memory that is held by idle databases, and `oldest` only flushes the database being written.

```yaml
storage:
  rocks:
    writeBufferManagerAllowStall: true
    writeBufferManagerFlushPolicy: largestAcrossDBs
```

Has no effect when `storage.rocks.writeBufferManagerSize` is `0`. A changed value applies when the worker threads restart (`restart_service`). Once set, though, a policy stays in effect until Harper fully restarts (the `restart` operation): removing it from the configuration and restarting only the worker threads does not restore the default. An invalid value is ignored, the same as removing the key: the default applies if no policy was set earlier in the process, otherwise the earlier policy stays.

### `storage.rocks.arenaBlockSize`

<VersionBadge version="v5.4.0" />

Type: `number` (bytes)

Default: automatic — `writeBufferManagerSize / 2048`, at least 64 KiB and at most 1 MiB

The size of the blocks each RocksDB column family's memtable allocates memory from. Every column family that has been written holds at least one block, and that block is charged to the `writeBufferManagerSize` budget even while the table is idle. With many tables, large blocks can use up a small budget and cause constant small flushes.

The automatic size scales with the budget:

| `writeBufferManagerSize` | Arena block size |
| ------------------------ | ---------------- |
| 64 MiB                   | 64 KiB           |
| 1 GiB                    | 512 KiB          |
| 2 GiB or more            | 1 MiB            |

The automatic size is also capped at one eighth of the memtable size. Without a write buffer manager (`writeBufferManagerSize: 0`), RocksDB's own default of 1 MiB applies. Set to `0`, or leave unset, for the automatic size.

```yaml
storage:
  rocks:
    arenaBlockSize: 131072 # 128 KiB
```

The size is read when a database is opened, so a full [`restart`](../operations-api/operations.md#restart) is what reliably applies a change. Invalid values (non-integers, negatives, strings) are ignored and the default is used.

## RocksDB Transaction Log

### `storage.rocks.transactionLogAbortMarkers`

<VersionBadge version="v5.4.0" /> <EngineBadge engines="RocksDB" />

Type: `boolean`

Default: `true`

Applies only when `storage.engine` is `rocksdb`. Harper writes a transaction's entry to the [transaction log](./transaction.md) before the transaction commits. With this setting on, when a transaction fails after that point, its entry is marked aborted, and every reader of the log skips it: replication, subscriptions, [`read_audit_log`](./transaction.md#read_audit_log), and replay after a crash. A transaction is still replayed on restart if the process crashes before it commits or is marked, including when a disk error delays its marker.

It also bounds a write that keeps conflicting with other writes. The write fails with HTTP `500` after 40 commit conflicts, or with HTTP `503` and code `TRANSACTION_COMMIT_CONFLICT_TIMEOUT` once it has been in conflict for longer than [`storage.maxTransactionQueueTime`](#storagemaxtransactionqueuetime), whichever comes first. A `503` that carries `retryable: false` may have been partly applied, so do not resend that request as is. Writes applied from replication or a caching source, and a transaction part of which has already committed, still retry until they commit.

Set it to `false` to keep the 5.3 behavior, where a write whose log entry was already written retries without limit. Any value other than `false`, `0`, `no` or `off` leaves it on. Harper reads the setting once per process, so a change takes effect after a [`restart`](../operations-api/operations.md#restart) of each node, or a process or container restart. [`restart_service`](../operations-api/operations.md#restart_service) restarts only worker threads and does not apply it.

**Downgrades:** Harper 5.3.4 and earlier cannot read abort markers and would treat a marked transaction as committed. Do not run them on a node's database files, or a backup of them, after the node has run 5.4 with this setting on. Harper 5.3.5 and later read the markers. Setting it to `false` later stops new markers but does not remove ones already written.

```yaml
storage:
  rocks:
    transactionLogAbortMarkers: false
```

### `storage.rocks.transactionLogWriteIntents`

<VersionBadge version="v5.4.0" /> <EngineBadge engines="RocksDB" />

Type: `boolean`

Default: `false`

When `true`, a commit that would conflict with a write from an older transaction that is still open is refused before it writes its transaction-log entry, or before it commits if an earlier attempt already wrote that entry. It then waits for that transaction to commit or abort, and retries. A refused attempt does not count toward the 40-conflict limit of [`transactionLogAbortMarkers`](#storagerockstransactionlogabortmarkers).

This shortens the longest waits when many transactions write the same records at once. It adds retries and lowers throughput when transactions are large or contention is low, so leave it off unless overlapping writes to the same records see long commit delays.

It has no effect when `transactionLogAbortMarkers` is `false`. Like that setting, it is read once per process: a change takes effect after a [`restart`](../operations-api/operations.md#restart) of each node, not [`restart_service`](../operations-api/operations.md#restart_service).

```yaml
storage:
  rocks:
    transactionLogWriteIntents: true
```

## Storage Reclamation

`storage.reclamation` controls how Harper evicts data from caching tables (tables with [`sourcedFrom`](../resources/resource-api.md#sourcedfromresource-options)) and demotes [local replicas](./schema.md#replicaexpiration-and-replicarefreshfraction) when disk usage runs high. Reclamation does **not** affect other records — those rely on explicit deletion, TTL expiration, or [compaction](./compaction.md).

### `storage.reclamation.threshold`

Type: `number` (ratio)

Default: `0.4`

Minimum fraction of the volume that should remain free. When free space falls below this ratio, reclamation begins evicting expired and lightly-used entries from caching tables and demoting local replicas. A larger value reclaims earlier and more aggressively; a smaller value defers reclamation closer to the volume filling.

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

### Local replicas under storage pressure

<VersionBadge version="v5.4.0" />

<EngineBadge engines="RocksDB" />

A [local replica](./schema.md#replicaexpiration-and-replicarefreshfraction) is a copy of a record owned by another node, so dropping one loses nothing: the next read fetches the record again. When free space is below the threshold, each reclamation check demotes replicas back to their indexed stubs, oldest deadline first, instead of waiting for `replicaExpiration` to pass.

The _priority_ is the threshold divided by the free-space ratio. At priority `p`, a replica is kept for about `replicaExpiration / p`. With a threshold of `0.4` and 20% free, the priority is `2`, so a one-hour lifetime becomes about 30 minutes; on a full volume every replica older than 30 seconds is demoted. A record written in the last 30 seconds stays at any pressure, because it may be this node's own write that its owner has not received yet, and a `replicaExpiration` of 30 seconds or less is not shortened. A replica whose deadline is left from a longer earlier `replicaExpiration` goes last, at any pressure. Records this node owns and existing stubs are not touched. When free space is back above the threshold, replicas expire at their normal deadlines.

Replicas are only demoted when `storage.reclamation.interval` runs a check, and each check spends about a minute at most on a table (one batch at least, however long it takes), then moves on; what is left waits for the next check. A check also waits for a sweep already running on the table, and the first check after a restart can walk the table's rows once, if the normal sweep has not done so yet. Lower the interval if replicas accumulate faster than one run per interval can demote them.

Demoting a replica does not free disk at once. It replaces the row with a smaller stub, and RocksDB returns the space when compaction rewrites the old version, which ongoing writes trigger over time. Free space may not rise during a check, and on a volume with no room left the demotions themselves can fail to write. Reclamation slows the growth of a node's cache and shrinks it over time; it does not replace keeping enough free space for the data the node owns.

To see how much of a table is cache, use the `replica_count` and `replica_size_estimate` fields of [`describe_table`](../operations-api/operations.md#replicas).

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

On RocksDB (the default), commits already avoid local disk `fsync`. When writes must be confirmed by peer nodes before returning, pair a higher queue-time threshold in `harper-config.yaml` with [replication confirmation](../replication/sharding.md). Set it on each write (`replicatedConfirmation` in the Operations or Resource API, or `X-Replicate-To: *;confirm=<k>` over REST), or, from v5.5, for every write with `replication.confirmation` in `harper-config.yaml` on Harper Pro (see [`replication`](../configuration/options.md#replication)). On legacy LMDB databases, also add `writeAsync: true`:

```yaml
storage:
  prefetchWrites: true
  maxTransactionQueueTime: 60s
replication:
  confirmation: 1
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

## `storage.fullText`

<VersionBadge version="v5.4.0" />

Type: `object`

Default: See the [storage option reference](../configuration/options.md#storage).

The [storage option reference](../configuration/options.md#storage) lists the full-text request and native process defaults. Raise the fetched-hit budget to allow more filtering work; raising it does not raise the separate retained-result limit. Larger limits can increase CPU, source reads and memory use for every permitted query. Native process budgets also share capacity across indexes, so tune them with concurrent workloads rather than a single query. See [full-text query execution](../resources/query-optimization.md#full-text-search-work-and-paging) for paging costs and restart requirements; see [readiness and recovery](../resources/query-optimization.md#readiness-and-recovery) for failures.

## Related

- [Configuration Options](../configuration/options.md) — full list of `storage` options
- [Storage Algorithm](./storage-algorithm.md) — how Harper stores records and indexes on disk
- [Sharding](../replication/sharding.md) — configuring `replicateTo` and replication confirmation for cross-node durability
- [Schema — `@table(randomAccessFields:)`](./schema.md#randomaccessfields) — pinning one table's record encoding
- [Compaction](./compaction.md) — reclaiming space inside existing database files
- [Resource API — `sourcedFrom`](../resources/resource-api.md#sourcedfromresource-options) — caching tables that interact with reclamation
- [Database API — `createBlob`](./api.md) — creating blobs that live under `blobPaths`
