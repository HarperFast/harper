---
title: Transaction Logging
---

<!-- Source: versioned_docs/version-4.7/administration/logging/transaction-logging.md (primary) -->
<!-- Source: versioned_docs/version-4.7/administration/logging/audit-logging.md (audit log) -->
<!-- Source: versioned_docs/version-4.1/transaction-logging.md (baseline — transaction logging available since v4.1) -->
<!-- Source: versioned_docs/version-4.1/audit-logging.md (baseline — audit logging available since v4.1) -->
<!-- Source: release-notes/v4-tucker/4.3.0.md (balanced audit log cleanup) -->
<!-- Source: release-notes/v4-tucker/4.5.0.md (transaction reuse, storage reclamation / audit log eviction) -->

# Transaction Logging

Harper provides two complementary mechanisms for recording a history of data changes on a table: the **audit log** and the **transaction log**. Both record and expose history for individual tables, but their underlying storage differs: on RocksDB (the default storage engine) the transaction log is physically a single database-wide log shared by all tables — history is read per table, while deletion operates on the whole database's log.

| Feature                       | Audit Log                         | Transaction Log                                                         |
| ----------------------------- | --------------------------------- | ----------------------------------------------------------------------- |
| Storage                       | Standard Harper table (per-table) | Shared per-database log (RocksDB); clustering streams, per-table (LMDB) |
| Requires clustering           | No                                | No (RocksDB, native WAL); Yes (LMDB, clustering streams)                |
| Available since               | v4.1.0                            | v4.1.0                                                                  |
| Stores original record values | Yes                               | No                                                                      |
| Query by username             | Yes                               | No                                                                      |
| Query by primary key          | Yes                               | No                                                                      |
| Used for real-time messaging  | Yes (required)                    | No                                                                      |

## Audit Log

Available since: v4.1.0

The audit log is a data store that tracks every transaction across all tables in a database. Harper automatically creates and maintains a single audit log per database. The audit log captures the operation type, the user who made the change, the timestamp, and both the new and original record values.

The audit log is **enabled by default**. To disable it, set [`logging.auditLog`](../logging/configuration.md) to `false` in `harper-config.yaml` and restart Harper.

> The audit log is required for real-time messaging (WebSocket and MQTT subscriptions) and replication. Do not disable it if real-time features or replication are in use.

### Audit Log Operations

#### `read_audit_log`

Queries the audit log for a specific table. Supports filtering by timestamp, username, or primary key value.

**By timestamp:**

```json
{
	"operation": "read_audit_log",
	"schema": "dev",
	"table": "dog",
	"search_type": "timestamp",
	"search_values": [1660585740558]
}
```

Timestamp behavior:

| `search_values` | Result                                   |
| --------------- | ---------------------------------------- |
| `[]`            | All records for the table                |
| `[timestamp]`   | All records after the provided timestamp |
| `[from, to]`    | Records between the two timestamps       |

**By username:**

```json
{
	"operation": "read_audit_log",
	"schema": "dev",
	"table": "dog",
	"search_type": "username",
	"search_values": ["admin"]
}
```

**By primary key:**

```json
{
	"operation": "read_audit_log",
	"schema": "dev",
	"table": "dog",
	"search_type": "hash_value",
	"search_values": [318]
}
```

**Response example:**

```json
{
	"operation": "update",
	"user_name": "HDB_ADMIN",
	"timestamp": 1607035559122.277,
	"hash_values": [1, 2],
	"records": [
		{
			"id": 1,
			"breed": "Muttzilla",
			"age": 6,
			"__updatedtime__": 1607035559122
		}
	],
	"original_records": [
		{
			"__createdtime__": 1607035556801,
			"__updatedtime__": 1607035556801,
			"age": 5,
			"breed": "Mutt",
			"id": 1,
			"name": "Harper"
		}
	]
}
```

The `original_records` field contains the record state before the operation was applied.

#### `delete_audit_logs_before`

Deletes audit log entries older than the specified timestamp. Deprecated in favor of [`delete_transaction_logs_before`](#delete_transaction_logs_before).

<VersionBadge type="changed" version="v4.3.0" /> — Audit log cleanup improved to reduce resource consumption during scheduled cleanups

<VersionBadge type="changed" version="v4.5.0" /> — Storage reclamation: Harper automatically evicts older audit log entries when free storage drops below a configurable threshold

<VersionBadge type="changed" version="v5.2.0" /> — This operation is unsupported on the RocksDB storage engine (the default): it requires `table`, but history cannot be deleted for a single table because all tables in a database share one transaction log. For an existing table the job fails with an error directing you to `delete_transaction_logs_before`; for a nonexistent table the job fails with a not-found error. The operation remains usable on LMDB.

```json
{
	"operation": "delete_audit_logs_before",
	"schema": "dev",
	"table": "dog",
	"timestamp": 1598290282817
}
```

### Transaction Log Operations

#### `delete_transaction_logs_before`

<EngineBadge engines="RocksDB, LMDB" />

<VersionBadge type="changed" version="v5.2.0" /> — On RocksDB, a request that includes `table` now fails; previously the `table` scope was silently ignored and the entire database's transaction log was purged. On either engine, a `table` that does not exist now fails with a not-found error (previously a typo'd `table` fell through to the database-wide purge on RocksDB, and was a silent no-op on LMDB). On LMDB, a valid `table` continues to scope the deletion to that table's history, unchanged.

Deletes transaction log entries older than the specified timestamp.

:::warning Database-wide and irreversible
On RocksDB (the default storage engine), deletion is database-wide: all tables in a database share one transaction log, so omit `table` and pass only `database` (or `schema`) and `timestamp`. This deletes whole log files, permanently removing [`read_audit_log`](#read_audit_log) history below the timestamp for **every table in the database** — there is no per-table survivor and no undo. The only recovery route is a [backup](../backups/overview.md), which restores the transaction log alongside the data. Purging below a lagging replica's catch-up position does not lose data on that replica — the sender detects that the requested start predates its retained history and forces a full base copy instead of incremental catch-up — but that full resync is far more expensive than incremental replication, so avoid purging below your slowest replica's position.
:::

Parameters:

- `database` (or the deprecated `schema` alias): `string` (required) — a request naming neither fails validation before a job starts; a `database` that does not exist fails the job with a not-found error.
- `timestamp`: `number` (required) — epoch milliseconds; entries older than this are deleted.
- `table`: `string` (LMDB only) — scopes deletion to that table's history. On RocksDB the job fails (see the warning above).
- `cleanup_deleted_records`: `boolean` (optional) — LMDB only; additionally removes leftover tombstone entries for records deleted before the timestamp, a repair step for tombstones that normal audit log cleanup should already have removed. Ignored on RocksDB.

On LMDB, the table-scoped deletion scans the database's full audit history (and `cleanup_deleted_records: true` adds a second full scan of the table's records), so the cost grows with total history depth — schedule accordingly on databases with deep audit history.

The operation runs as a background job: the request itself returns `200` with a job ID, and any rejection surfaces when the job runs. Poll [`get_job`](jobs.md#get-job) to observe the outcome — a rejected request ends with job status `ERROR` and a message describing the failure (for example, the RocksDB table-scope rejection).

**RocksDB (database-wide — omit `table`):**

```json
{
	"operation": "delete_transaction_logs_before",
	"database": "dev",
	"timestamp": 1598290282817
}
```

**LMDB (`table` is required — omitting it deletes nothing and reports `entries_deleted: 0` with job status `COMPLETE`):**

```json
{
	"operation": "delete_transaction_logs_before",
	"database": "dev",
	"table": "dog",
	"timestamp": 1598290282817
}
```

Response:

```json
{
	"message": "Starting job with id 2fe25039-566e-4670-8bb3-2db3d4e07e69",
	"job_id": "2fe25039-566e-4670-8bb3-2db3d4e07e69"
}
```

`get_job` reports the outcome. A successful job's `result` carries `log_files_deleted` and `entries_deleted` (plus `start_timestamp`/`end_timestamp` on LMDB) — the record of how much was deleted. A rejected request looks like:

```json
[
	{
		"id": "2fe25039-566e-4670-8bb3-2db3d4e07e69",
		"type": "delete_transaction_logs_before",
		"status": "ERROR",
		"message": "There was an error running deleteTransactionLogsBefore job with id 2fe25039-566e-4670-8bb3-2db3d4e07e69 - Table-level transaction log deletion is not supported for RocksDB tables because all tables in a database share one transaction log; to delete the transaction logs for the entire 'dev' database, use delete_transaction_logs_before with only 'database' and 'timestamp'"
	}
]
```

---

## Enabling Audit Log Per Table

You can enable or disable the audit log for individual tables using the `@table` directive's `audit` argument in your schema:

```graphql
type Dog @table(audit: true) {
	id: Long @primaryKey
	name: String
}
```

This overrides the [`logging.auditLog`](../logging/configuration.md) global configuration for that specific table.

## Related Documentation

- [Logging](../logging/overview.md) — Application and system logging (separate from transaction/audit logging)
- [Replication](../replication/overview.md) — Clustering setup required for transaction logs
- [Logging Configuration](../logging/configuration.md) — Global audit log configuration (`logging.auditLog`)
- [Operations API](../operations-api/overview.md) — Sending operations to Harper
