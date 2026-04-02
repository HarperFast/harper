---
id: operations
title: Logging Operations
---

<!-- Source: versioned_docs/version-4.7/developers/operations-api/logs.md (primary) -->
<!-- Source: versioned_docs/version-4.7/administration/logging/standard-logging.md (read_log background) -->

Operations for reading the standard Harper log (`hdb.log`). All operations are restricted to `super_user` roles only.

> Audit log and transaction log operations (`read_audit_log`, `read_transaction_log`, `delete_audit_logs_before`, `delete_transaction_logs_before`) are documented in [Database / Transaction Logging](../database/transaction.md).

---

## `read_log`

Returns log entries from the primary Harper log (`hdb.log`) matching the provided criteria.

_Restricted to super_user roles only._

### Parameters

| Parameter   | Required | Type   | Description                                                                                            |
| ----------- | -------- | ------ | ------------------------------------------------------------------------------------------------------ |
| `operation` | Yes      | string | Must be `"read_log"`                                                                                   |
| `start`     | No       | number | Result offset to start from. Default: `0` (first entry in `hdb.log`).                                  |
| `limit`     | No       | number | Maximum number of entries to return. Default: `1000`.                                                  |
| `level`     | No       | string | Filter by log level. One of: `notify`, `error`, `warn`, `info`, `debug`, `trace`. Default: all levels. |
| `from`      | No       | string | Start of time window. Format: `YYYY-MM-DD` or `YYYY-MM-DD hh:mm:ss`. Default: first entry in log.      |
| `until`     | No       | string | End of time window. Format: `YYYY-MM-DD` or `YYYY-MM-DD hh:mm:ss`. Default: last entry in log.         |
| `order`     | No       | string | Sort order: `asc` or `desc` by timestamp. Default: maintains `hdb.log` order.                          |
| `filter`    | No       | string | A substring that must appear in each returned log line.                                                |

### Request

```json
{
	"operation": "read_log",
	"start": 0,
	"limit": 1000,
	"level": "error",
	"from": "2021-01-25T22:05:27.464+0000",
	"until": "2021-01-25T23:05:27.464+0000",
	"order": "desc"
}
```

### Response

```json
[
	{
		"level": "notify",
		"message": "Connected to cluster server.",
		"timestamp": "2021-01-25T23:03:20.710Z",
		"thread": "main/0",
		"tags": []
	},
	{
		"level": "warn",
		"message": "Login failed",
		"timestamp": "2021-01-25T22:24:45.113Z",
		"thread": "http/9",
		"tags": []
	},
	{
		"level": "error",
		"message": "unknown attribute 'name and breed'",
		"timestamp": "2021-01-25T22:23:24.167Z",
		"thread": "http/9",
		"tags": []
	}
]
```

### Response Fields

| Field       | Type   | Description                                                                                             |
| ----------- | ------ | ------------------------------------------------------------------------------------------------------- |
| `level`     | string | Log level of the entry.                                                                                 |
| `message`   | string | Log message.                                                                                            |
| `timestamp` | string | ISO 8601 timestamp when the event occurred.                                                             |
| `thread`    | string | Thread name and ID (e.g., `main/0`, `http/3`).                                                          |
| `tags`      | array  | Additional context tags. Entries from components may include `custom-function` or other component tags. |

## Related

- [Logging Overview](./overview)
- [Logging Configuration](./configuration)
- [Database / Transaction Logging](../database/transaction.md)
- [Operations API Overview](../operations-api/overview.md)
