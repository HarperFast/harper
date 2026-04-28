---
title: Storage Algorithm
---

<!-- Source: versioned_docs/version-4.7/reference/storage-algorithm.md (primary) -->
<!-- Source: release-notes/v4-tucker/4.3.0.md (storage performance improvements, compression by default, compact) -->

# Storage Algorithm

Harper's storage algorithm is the foundation of all database functionality. It is built on top of [RocksDB](https://rocksdb.org/) (the default) or [LMDB](https://www.symas.com/lmdb) (legacy), both high-performance key-value stores, and extends them with automatic indexing, query-language-agnostic data access, and ACID compliance.

RocksDB is the default storage engine for new installations. LMDB databases from prior versions are still supported and loaded automatically when detected.

## Query Language Agnostic

Harper's storage layer is decoupled from any specific query language. Data inserted via NoSQL operations can be read via SQL, REST, or the Resource API — all accessing the same underlying storage. This architecture allows Harper to add new query interfaces without changing how data is stored.

## ACID Compliance

Harper provides full ACID compliance on each node:

- **Atomicity**: All writes in a transaction either fully commit or fully roll back
- **Consistency**: Each transaction moves data from one valid state to another
- **Isolation**: Reads use snapshots and do not block writes; writes do not block reads
- **Durability**: RocksDB commits are persisted via its Write-Ahead Log (WAL); LMDB uses memory-mapped file writes

Harper uses application-level locking to serialize schema changes and table creation, ensuring write ordering without deadlocks.

## Universally Indexed

<VersionBadge type="changed" version="v4.3.0" /> — Storage performance improvements including better free-space management

For [dynamic schema tables](./overview.md#dynamic-vs-defined-schemas), all top-level attributes are automatically indexed immediately upon ingestion — Harper reflexively creates the attribute and its index as new data arrives. For [schema-defined tables](./schema.md), indexes are created for all attributes marked with `@indexed`.

Indexes are type-agnostic, ordering values as follows:

1. Booleans
2. Numbers (ordered numerically)
3. Strings (ordered lexically)

### Storage Layout

Each Harper database corresponds to a separate storage environment:

- **RocksDB** (default): a directory on disk containing all stores for that database
- **LMDB** (legacy): a single `.mdb` file containing all sub-databases for that database

Within each database, a table is represented by multiple key-value stores:

- **Primary store** (`tableName/`): stores the full record for each primary key
- **Secondary index stores** (`tableName/attributeName`): one store per indexed attribute, mapping attribute values to primary keys
- **Metadata store** (`__internal_dbis__`): tracks table and attribute definitions for the database

All stores for a given database reside within the same RocksDB directory (or LMDB environment file), so cross-table operations within a database share the same underlying I/O path.

## Compression

<VersionBadge type="changed" version="v4.3.0" /> — Compression is now enabled by default for all records over 4KB

Harper compresses record data automatically for records over 4KB. Compression settings can be configured in the [storage configuration](../configuration/options.md). Note that compression settings cannot be changed on existing databases without creating a new compacted copy — see [Compaction](./compaction.md).

## Performance Characteristics

Harper inherits strong performance properties from its storage engines:

**RocksDB (default)**:

- **LSM-tree writes**: Optimized for write-heavy workloads via log-structured merge trees
- **Block cache**: Configurable in-memory block cache (defaults to 25% of available system memory)
- **WAL durability**: Write-Ahead Log provides crash recovery without sacrificing throughput
- **Compression**: Native support for multiple compression algorithms per level

**LMDB (legacy)**:

- **Memory-mapped I/O**: Data is accessed via memory mapping, enabling fast reads without data duplication between disk and memory
- **Buffer cache integration**: Fully exploits the OS buffer cache for reduced I/O
- **Zero-copy reads**: Readers access data directly from the memory map without copying
- **Deadlock-free writes**: Full serialization of writers guarantees write ordering without deadlocks

## Indexing Example

Given a table with records like this:

```
┌────┬────────┬────────┐
│ id │ field1 │ field2 │
├────┼────────┼────────┤
│  1 │ A      │ X      │
│  2 │ 25     │ X      │
│  3 │ -1     │ Y      │
│  4 │ A      │        │
│  5 │ true   │ 2      │
└────┴────────┴────────┘
```

Harper maintains three separate key-value stores for that table, all within the same database:

```
Database (RocksDB directory or LMDB environment)
│
├── primary store: "MyTable/"
│   ┌─────┬──────────────────────────────────────┐
│   │ Key │ Value (full record)                  │
│   ├─────┼──────────────────────────────────────┤
│   │  1  │ { id:1, field1:"A",  field2:"X"    } │
│   │  2  │ { id:2, field1:25,   field2:"X"    } │
│   │  3  │ { id:3, field1:-1,   field2:"Y"    } │
│   │  4  │ { id:4, field1:"A"                 } │
│   │  5  │ { id:5, field1:true, field2:2      } │
│   └─────┴──────────────────────────────────────┘
│
├── secondary index: "MyTable/field1"    secondary index: "MyTable/field2"
│   ┌────────┬───────┐                   ┌────────┬───────┐
│   │ Key    │ Value │                   │ Key    │ Value │
│   ├────────┼───────┤                   ├────────┼───────┤
│   │ -1     │  3    │                   │  2     │  5    │
│   │  25    │  2    │                   │  X     │  1    │
│   │  A     │  1    │                   │  X     │  2    │
│   │  A     │  4    │                   │  Y     │  3    │
│   │  true  │  5    │                   └────────┴───────┘
│   └────────┴───────┘
```

Secondary indexes store the attribute value as the key and the record's primary key (`id`) as the value. To resolve a query result, Harper looks up the matching ids in the secondary index, then fetches the full records from the primary store.

Indexes are ordered — booleans first, then numbers (numerically), then strings (lexically) — enabling efficient range queries across all types.

## Related Documentation

- [Schema](./schema.md) — Defining indexed attributes and vector indexes
- [Compaction](./compaction.md) — Reclaiming free space and applying new storage configuration to existing databases
- [Configuration](../configuration/options.md) — Storage configuration options (compression, memory maps, blob paths)
