# Audit Entry Storage Format Specification

## Overview

This document describes the binary format used to store audit/transaction log entries in Harper. The format is designed for efficient storage and retrieval of database operation records with support for CRDT operations, replication, and change tracking.

## Transaction Log Entry Structure

Each transaction log entry consists of two parts:

1. **Transaction Log Header** (stored in RocksDB transaction log)
2. **Audit Entry Data** (the binary payload)

### Transaction Log Header (RocksTransactionLogStore)

Located at the beginning of each transaction log entry before the audit entry data:

| Offset | Size    | Field                            | Description                                                                     |
| ------ | ------- | -------------------------------- | ------------------------------------------------------------------------------- |
| 0      | 4 bytes | Structure Version + Header Flags | Lower 24 bits: version number, Upper 8 bits: flags                              |
| 4      | 4 bytes | Previous Residency ID            | Optional, present if `HAS_PREVIOUS_RESIDENCY_ID` (0x40) flag is set             |
| 8/12   | 8 bytes | Previous Version                 | Optional, present if `HAS_PREVIOUS_VERSION` (0x20) flag is set. IEEE 754 double |

**Header Flags:**

- `0x80` - HAS_32_BIT_FLAG (reserved for future use)
- `0x40` - HAS_PREVIOUS_RESIDENCY_ID
- `0x20` - HAS_PREVIOUS_VERSION

## Audit Entry Data Format

The audit entry data follows the transaction log header and contains the actual operation details.

### Structure

| Section               | Size                   | Description                                             |
| --------------------- | ---------------------- | ------------------------------------------------------- |
| Previous Local Time   | 0 or 8 bytes           | Optional previous version timestamp                     |
| Action + Flags        | 1, 2, or 4 bytes       | Operation type and extended flags                       |
| Node ID               | 1, 2, 4, or 5 bytes    | Node identifier (variable-length integer)               |
| Table ID              | 1, 2, 4, or 5 bytes    | Table identifier (variable-length integer)              |
| Record ID Length      | 1, 2, 4, or 5 bytes    | Length of record ID                                     |
| Record ID             | Variable               | Binary-encoded record identifier                        |
| Version               | 8 bytes                | IEEE 754 double timestamp                               |
| Current Residency ID  | 0, 1, 2, 4, or 5 bytes | Optional, if `HAS_CURRENT_RESIDENCY_ID` flag            |
| Previous Residency ID | 0, 1, 2, 4, or 5 bytes | Optional, if `HAS_PREVIOUS_RESIDENCY_ID` flag           |
| Expiration Time       | 0 or 8 bytes           | Optional, if `HAS_EXPIRATION_EXTENDED_TYPE` flag        |
| Originating Operation | 0, 1, 2, 4, or 5 bytes | Optional, if `HAS_ORIGINATING_OPERATION` flag           |
| Username Length       | 1 or 2 bytes           | Length of username (0 if no username)                   |
| Username              | Variable               | Binary-encoded username string                          |
| Record Value          | Variable               | Optional, encoded record data (not present for deletes) |

## Field Details

### Previous Local Time (Optional)

- **Present when:** The first byte is `0x42` (66 decimal, which is the first byte of an IEEE 754 double)
- **Format:** 8-byte IEEE 754 double-precision float
- **Purpose:** Stores the previous version timestamp for change tracking

### Action + Flags

Variable-length integer encoding the operation type and extended type flags.

**Base Action Types (bits 0-3):**

| Value | Name                   | Description                        |
| ----- | ---------------------- | ---------------------------------- |
| 1     | PUT                    | Insert or update a record          |
| 2     | DELETE                 | Delete a record                    |
| 3     | MESSAGE                | Message/event record               |
| 4     | INVALIDATE             | Invalidate a record (CRDT)         |
| 5     | PATCH                  | Partial update (CRDT)              |
| 6     | RELOCATE               | Move record to different residency |
| 7     | STRUCTURES             | Schema/structure change            |
| 11    | REMOTE_SEQUENCE_UPDATE | Remote local time update           |
| 14    | ACTION_32_BIT          | 32-bit action flag                 |
| 15    | ACTION_64_BIT          | 64-bit action flag                 |

**Record Content Flags (bits 4-5):**

| Value     | Name               | Description                     |
| --------- | ------------------ | ------------------------------- |
| 16 (0x10) | HAS_RECORD         | Full record data included       |
| 32 (0x20) | HAS_PARTIAL_RECORD | Partial record data (for CRDTs) |

**Additional Flags (upper bits):**

| Value           | Name                         | Description                          |
| --------------- | ---------------------------- | ------------------------------------ |
| 64 (0x40)       | HAS_PREVIOUS_VERSION         | Previous version timestamp included  |
| 128 (0x80)      | HAS_EXTENDED_TYPE            | Extended type information            |
| 512 (0x200)     | HAS_CURRENT_RESIDENCY_ID     | Current residency ID included        |
| 1024 (0x400)    | HAS_PREVIOUS_RESIDENCY_ID    | Previous residency ID included       |
| 2048 (0x800)    | HAS_ORIGINATING_OPERATION    | Originating operation type included  |
| 4096 (0x1000)   | HAS_EXPIRATION_EXTENDED_TYPE | Expiration timestamp included        |
| 8192 (0x2000)   | HAS_BLOBS                    | Binary blob data included            |
| 65536 (0x10000) | HAS_EXPIRATION_DECISION      | Expiration decision is authoritative |

`HAS_EXPIRATION_DECISION` carries no payload. It is mirrored in the primary record metadata and audit
entry so a missing `HAS_EXPIRATION_EXTENDED_TYPE` bit means an explicit no-expiration decision rather
than missing legacy metadata. Records and audit events without the decision bit retain the legacy
fallback to a public `@expiresAt` field during upgrades.

#### `@expiresAt` migration and mixed-version compatibility

Source-backed tables now treat the source request context as authoritative for cache expiration. A
source that intends a returned record to expire must set `context.expiresAt`; an `@expiresAt` field in
the returned record is application data and no longer schedules expiration by itself. Omitting
`context.expiresAt` records an explicit no-expiration decision, even when the returned record contains
an `@expiresAt` field. This is a breaking change for source adapters that previously relied on that
returned field: update them to set `context.expiresAt` before upgrading.

New readers remain compatible with records written before `HAS_EXPIRATION_DECISION`: when the decision
bit is absent, they fall back to the public `@expiresAt` field. The reverse is not safe during a rolling
mixed-version deployment. An older worker does not understand an explicit no-expiration decision and
can reinterpret the public field as an expiration. Do not run mixed versions for source-backed tables
that return an `@expiresAt` field while intentionally omitting `context.expiresAt`; upgrade those
workers together, or remove/neutralize the returned field until every worker understands the decision
bit.

### Variable-Length Integer Encoding

Integers (Node ID, Table ID, lengths) use a variable-length encoding scheme:

| First Byte | Total Size | Value Range          | Encoding                    |
| ---------- | ---------- | -------------------- | --------------------------- |
| 0x00-0x7F  | 1 byte     | 0-127                | Direct value                |
| 0x80-0xBF  | 2 bytes    | 128-16,383           | `(uint16 & 0x7FFF)`         |
| 0xC0-0xFE  | 4 bytes    | 16,384-1,073,741,823 | `(uint32 & 0x3FFFFFFF)`     |
| 0xFF       | 5 bytes    | 1,073,741,824+       | Next 4 bytes = uint32 value |

### Record ID and Username Encoding

Both Record ID and Username use a length-prefixed encoding:

**Length Encoding:**

- **1 byte:** If length ≤ 127 (0x7F)
  - Value: direct length
- **2 bytes:** If 128 ≤ length ≤ 16,383 (0x3FFF)
  - Value: `(uint16 & 0x7FFF) | 0x8000`
- **Maximum:** 16,383 bytes

**Data Encoding:**

- Uses `ordered-binary` encoding for proper sorting and comparison
- Binary data follows immediately after length prefix

### Originating Operation

When `HAS_ORIGINATING_OPERATION` flag is set, indicates the SQL operation that created this entry:

| Value | Operation |
| ----- | --------- |
| 1     | insert    |
| 2     | update    |
| 3     | upsert    |

### Record Value

- **Present for:** PUT, MESSAGE, PATCH, INVALIDATE operations
- **Absent for:** DELETE, RELOCATE operations
- **Format:** Binary-encoded using the same encoding as the primary record store
- **Location:** Starts at `decoder.position` after all header fields
- **Size:** Extends to end of entry buffer

## Key Encoding

Transaction log keys are timestamps encoded as IEEE 754 doubles:

- **Format:** 8-byte IEEE 754 double-precision float
- **Value:** Milliseconds since Unix epoch (Date.now())
- **Special Values:**
  - `LAST_TIMESTAMP_PLACEHOLDER`: Reserved placeholder value
  - `PREVIOUS_TIMESTAMP_PLACEHOLDER`: Reserved placeholder value

## Size Constraints

- **Maximum key/username size:** 16,383 bytes (2-byte length header)
- **Entry header buffer size:** 2,816 bytes (accommodates max key size + large usernames)
- **Total entry size:** Limited by RocksDB/LMDB constraints

## Examples

### Minimal Delete Entry

```
Byte sequence for a delete operation:
[0x02] [0x05] [0x0A] [0x04] [0x61,0x62,0x63,0x64] [64-bit timestamp] [0x00]
 │      │      │      │      │                       │                 │
 │      │      │      │      │                       │                 └─ No username (0 length)
 │      │      │      │      │                       └─ Version timestamp
 │      │      │      │      └─ Record ID: "abcd"
 │      │      │      └─ Record ID length: 4
 │      │      └─ Table ID: 10
 │      └─ Node ID: 5
 └─ Action: DELETE (2)
```

### PUT Entry with Previous Version

```
[0x42,...] [0x11] [0x05] [0x0A] [...] [...] [...] [0x04] [0x75,0x73,0x65,0x72] [...]
 │          │      │      │      │     │     │     │      │                       │
 │          │      │      │      │     │     │     │      │                       └─ Encoded record value
 │          │      │      │      │     │     │     │      └─ Username: "user"
 │          │      │      │      │     │     │     └─ Username length: 4
 │          │      │      │      │     │     └─ Version timestamp
 │          │      │      │      │     └─ Record ID
 │          │      │      │      └─ Record ID length
 │          │      │      └─ Table ID: 10
 │          │      └─ Node ID: 5
 │          └─ Action: PUT (1) | HAS_RECORD (16) = 17
 └─ Previous local time (8-byte double starting with 0x42)
```

## Implementation Notes

1. **Endianness:** All multi-byte integers use big-endian encoding
2. **Buffer Reuse:** Implementation uses a reusable 2,816-byte buffer (`ENTRY_HEADER`) to reduce allocations
3. **Lazy Decoding:** Record IDs, usernames, and values use lazy getters to decode only when accessed
4. **Sorting:** Transaction log entries are naturally sorted by timestamp key
5. **Cleanup:** Old entries are periodically removed based on audit retention policies

## Version History

- **Structure Version:** Stored in lower 24 bits of transaction log header
- **Compatibility:** Extended type flags allow backward-compatible schema evolution
