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

Harper provides two complementary mechanisms for recording a history of data changes on a table: the **audit log** and the **transaction log**. Both are available at the table level and serve different use cases.

| Feature                       | Audit Log                         | Transaction Log                |
| ----------------------------- | --------------------------------- | ------------------------------ |
| Storage                       | Standard Harper table (per-table) | Clustering streams (per-table) |
| Requires clustering           | No                                | Yes                            |
| Available since               | v4.1.0                            | v4.1.0                         |
| Stores original record values | Yes                               | No                             |
| Query by username             | Yes                               | No                             |
| Query by primary key          | Yes                               | No                             |
| Used for real-time messaging  | Yes (required)                    | No                             |

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

Deletes audit log entries older than the specified timestamp.

<VersionBadge type="changed" version="v4.3.0" /> — Audit log cleanup improved to reduce resource consumption during scheduled cleanups

<VersionBadge type="changed" version="v4.5.0" /> — Storage reclamation: Harper automatically evicts older audit log entries when free storage drops below a configurable threshold

```json
{
	"operation": "delete_audit_logs_before",
	"schema": "dev",
	"table": "dog",
	"timestamp": 1598290282817
}
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
