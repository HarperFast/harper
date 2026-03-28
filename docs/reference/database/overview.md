---
title: Overview
---

<!-- Source: versioned_docs/version-4.7/reference/architecture.md (primary) -->
<!-- Source: versioned_docs/version-4.7/reference/dynamic-schema.md (databases/tables concepts) -->
<!-- Source: release-notes/v4-tucker/4.2.0.md (database structure changes) -->

# Database

Harper's database system is the foundation of its data storage and retrieval capabilities. Harper supports two storage enginers, [RocksDB](https://github.com/facebook/rocksdb/wiki/RocksDB-Overview) and [LMDB](https://www.symas.com/lmdb) (Lightning Memory-Mapped Database) and is designed to provide high performance, ACID-compliant storage with indexing and flexible schema support.

## How Harper Stores Data

Harper organizes data in a three-tier hierarchy:

- **Databases** — containers that group related tables together in a single transactional file
- **Tables** — collections of records with a common data pattern
- **Records** — individual data objects with a primary key and any number of attributes

All tables within a database share the same transaction context, meaning reads and writes across tables in the same database can be performed atomically.

### The Schema System and Auto-REST

The most common way to use Harper's database is through the **schema system**. By defining a [GraphQL schema](./schema.md), you can:

- Declare tables and their attribute types
- Control which attributes are indexed
- Define relationships between tables
- Automatically expose data via REST, MQTT, and other interfaces

You do not need to build custom application code to use the database. A schema definition alone is enough to create fully functional, queryable REST endpoints for your data.

For more advanced use cases, you can extend table behavior using the [Resource API](TODO:reference_versioned_docs/version-v4/resources/resource-api.md 'Custom resource logic layered on top of tables').

### Architecture Overview

```
           ┌──────────┐    ┌──────────┐
           │ Clients  │    │ Clients  │
           └────┬─────┘    └────┬─────┘
                │               │
                ▼               ▼
   ┌────────────────────────────────────────┐
   │                                        │
   │        Socket routing/management       │
   ├───────────────────────┬────────────────┤
   │                       │                │
   │ Server Interfaces   ─►│ Authentication │
   │ RESTful HTTP, MQTT    │ Authorization  │
   │                     ◄─┤                │
   │              ▲        └────────────────┤
   │   │          │                         │
   ├───┼──────────┼─────────────────────────┤
   │   │          │        ▲                │
   │   ▼   Resources ▲     │ ┌───────────┐  │
   │                 │     └─┤           │  │
   ├─────────────────┴────┐  │ App       │  │
   │                      ├─►│ resources │  │
   │  Database tables     │  └───────────┘  │
   │                      │      ▲          │
   ├──────────────────────┘      │          │
   │             ▲  ▼            │          │
   │       ┌────────────────┐    │          │
   │       │ External       │    │          │
   │       │ data sources   ├────┘          │
   │       │                │               │
   │       └────────────────┘               │
   │                                        │
   └────────────────────────────────────────┘
```

## Databases

Harper databases hold a collection of tables in a single transactionally-consistent file. This means reads and writes can be performed atomically across all tables in the same database, and multi-table transactions are replicated as a single atomic unit.

The default database is named `data`. Most applications will use this default. Additional databases can be created for namespace separation — this is particularly useful for components designed for reuse across multiple applications, where a unique database name avoids naming collisions.

> **Note:** Transactions do not preserve atomicity across different databases, only across tables within the same database.

## Tables

Tables group records with a common data pattern. A table must have:

- **Table name** — used to identify the table
- **Primary key** — the unique identifier for each record (also referred to as `hash_attribute` in the Operations API)

Primary keys must be unique. If a primary key is not provided on insert, Harper auto-generates one:

- A **UUID string** for primary keys typed as `String` or `ID`
- An **auto-incrementing integer** for primary keys typed as `Int`, `Long`, or `Any`

Numeric primary keys are more efficient than UUIDs for large tables.

## Dynamic vs. Defined Schemas

Harper tables can operate in two modes:

**Defined schemas** (recommended): Tables with schemas explicitly declared using [GraphQL schema syntax](./schema.md). This provides predictable structure, precise control over indexing, and data integrity. Schemas are declared in a component's `schema.graphql` file.

**Dynamic schemas**: Tables created through the Operations API or Studio without a schema definition. Attributes are reflexively added as data is ingested. All top-level attributes are automatically indexed. Dynamic schema tables automatically maintain `__createdtime__` and `__updatedtime__` audit attributes on every record.

It is best practice to define schemas for production tables. Dynamic schemas are convenient for experimentation and prototyping.

## Key Concepts

For deeper coverage of each database feature, see the dedicated pages in this section:

- **[Schema](./schema.md)** — Defining table structure, types, indexes, relationships, and computed properties using GraphQL schema syntax
- **[API](./api.md)** — The `tables`, `databases`, `transaction()`, and `createBlob()` globals for interacting with the database from code
- **[Data Loader](./data-loader.md)** — Loading seed or initial data into tables as part of component deployment
- **[Storage Algorithm](./storage-algorithm.md)** — How Harper stores data using LMDB with universal indexing and ACID compliance
- **[Jobs](./jobs.md)** — Asynchronous bulk data operations (CSV import/export, S3 import/export)
- **[System Tables](./system-tables.md)** — Harper internal tables for analytics, data loader state, and other system features
- **[Compaction](./compaction.md)** — Reducing database file size by eliminating fragmentation and free space
- **[Transaction Logging](./transaction.md)** — Recording and querying a history of data changes via audit log and transaction log

## Related Documentation

- [REST](../rest/overview.md) — HTTP interface built on top of the database resource system
- [Resources](TODO:reference_versioned_docs/version-v4/resources/overview.md) — Custom application logic extending database tables
- [Operations API](TODO:reference_versioned_docs/version-v4/operations-api/overview.md) — Direct database management operations (create/drop databases and tables, insert/update/delete records)
- [Configuration](TODO:reference_versioned_docs/version-v4/configuration/overview.md) — Storage configuration options (compression, blob paths, compaction)
