---
title: Operations Reference
---

<!-- Source: versioned_docs/version-4.7/developers/operations-api/databases-and-tables.md (primary) -->
<!-- Source: versioned_docs/version-4.7/developers/operations-api/nosql-operations.md (primary) -->
<!-- Source: versioned_docs/version-4.7/developers/operations-api/bulk-operations.md (primary) -->
<!-- Source: versioned_docs/version-4.7/developers/operations-api/sql-operations.md (primary) -->
<!-- Source: versioned_docs/version-4.7/developers/operations-api/users-and-roles.md (primary) -->
<!-- Source: versioned_docs/version-4.7/developers/operations-api/token-authentication.md (primary) -->
<!-- Source: versioned_docs/version-4.7/developers/operations-api/components.md (primary) -->
<!-- Source: versioned_docs/version-4.7/developers/operations-api/clustering.md (primary) -->
<!-- Source: versioned_docs/version-4.7/developers/operations-api/configuration.md (primary) -->
<!-- Source: versioned_docs/version-4.7/developers/operations-api/system-operations.md (primary) -->
<!-- Source: versioned_docs/version-4.7/developers/operations-api/jobs.md (primary) -->
<!-- Source: versioned_docs/version-4.7/developers/operations-api/logs.md (primary) -->
<!-- Source: versioned_docs/version-4.7/developers/operations-api/certificate-management.md (primary) -->
<!-- Source: versioned_docs/version-4.7/developers/operations-api/analytics.md (primary) -->
<!-- Source: versioned_docs/version-4.7/developers/operations-api/registration.md (primary) -->
<!-- Source: versioned_docs/version-4.7/developers/operations-api/custom-functions.md (deprecated operations) -->

# Operations Reference

This page lists all available Operations API operations, grouped by category. Each entry links to the feature section where the full documentation lives.

For endpoint and authentication setup, see the [Operations API Overview](./overview.md).

---

## Databases & Tables

Operations for managing databases, tables, and attributes.

Detailed documentation: [Database Overview](../database/overview.md)

| Operation           | Description                                                         | Role Required |
| ------------------- | ------------------------------------------------------------------- | ------------- |
| `describe_all`      | Returns definitions of all databases and tables, with record counts | any           |
| `describe_database` | Returns all table definitions for a specified database              | any           |
| `describe_table`    | Returns the definition of a specified table                         | any           |
| `create_database`   | Creates a new database                                              | super_user    |
| `drop_database`     | Drops a database and all its tables/records                         | super_user    |
| `create_table`      | Creates a new table with optional schema and expiration             | super_user    |
| `drop_table`        | Drops a table and all its records                                   | super_user    |
| `create_attribute`  | Adds a new attribute to a table                                     | super_user    |
| `drop_attribute`    | Removes an attribute and all its values from a table                | super_user    |
| `get_backup`        | Returns a binary snapshot of a database for backup purposes         | super_user    |

### `describe_all`

Returns the definitions of all databases and tables within the database. Record counts above 5000 records are estimated; the response includes `estimated_record_range` when estimated. To force an exact count (requires full table scan), include `"exact_count": true`.

```json
{ "operation": "describe_all" }
```

### `describe_database`

Returns all table definitions within the specified database.

```json
{ "operation": "describe_database", "database": "dev" }
```

### `describe_table`

Returns the definition of a specific table.

```json
{ "operation": "describe_table", "table": "dog", "database": "dev" }
```

### `create_database`

Creates a new database.

```json
{ "operation": "create_database", "database": "dev" }
```

### `drop_database`

Drops a database and all its tables/records. Supports `"replicated": true` to propagate to all cluster nodes.

```json
{ "operation": "drop_database", "database": "dev" }
```

### `create_table`

Creates a new table. Optional fields: `database` (defaults to `data`), `attributes` (array defining schema), `expiration` (TTL in seconds).

```json
{
	"operation": "create_table",
	"database": "dev",
	"table": "dog",
	"primary_key": "id"
}
```

### `drop_table`

Drops a table and all associated records. Supports `"replicated": true`.

```json
{ "operation": "drop_table", "database": "dev", "table": "dog" }
```

### `create_attribute`

Creates a new attribute within a table. Harper auto-creates attributes on insert/update, but this can be used to pre-define them (e.g., for role-based permission setup).

```json
{
	"operation": "create_attribute",
	"database": "dev",
	"table": "dog",
	"attribute": "is_adorable"
}
```

### `drop_attribute`

Drops an attribute and all its values from the specified table.

```json
{
	"operation": "drop_attribute",
	"database": "dev",
	"table": "dog",
	"attribute": "is_adorable"
}
```

### `get_backup`

Returns a binary snapshot of the specified database (or individual table). Safe for backup while Harper is running. Specify `"table"` for a single table or `"tables"` for a set.

```json
{ "operation": "get_backup", "database": "dev" }
```

---

## NoSQL Operations

Operations for inserting, updating, deleting, and querying records using NoSQL.

Detailed documentation: [REST Querying Reference](../rest/querying.md)

| Operation              | Description                                                               | Role Required |
| ---------------------- | ------------------------------------------------------------------------- | ------------- |
| `insert`               | Inserts one or more records                                               | any           |
| `update`               | Updates one or more records by primary key                                | any           |
| `upsert`               | Inserts or updates records                                                | any           |
| `delete`               | Deletes records by primary key                                            | any           |
| `search_by_id`         | Retrieves records by primary key                                          | any           |
| `search_by_value`      | Retrieves records matching a value on any attribute                       | any           |
| `search_by_conditions` | Retrieves records matching complex conditions with sorting and pagination | any           |

### `insert`

Inserts one or more records. If a primary key is not provided, a GUID or auto-increment value is generated.

```json
{
	"operation": "insert",
	"database": "dev",
	"table": "dog",
	"records": [{ "id": 1, "dog_name": "Penny" }]
}
```

### `update`

Updates one or more records. Primary key must be supplied for each record.

```json
{
	"operation": "update",
	"database": "dev",
	"table": "dog",
	"records": [{ "id": 1, "weight_lbs": 38 }]
}
```

### `upsert`

Updates existing records and inserts new ones. Matches on primary key if provided.

```json
{
	"operation": "upsert",
	"database": "dev",
	"table": "dog",
	"records": [{ "id": 1, "weight_lbs": 40 }]
}
```

### `delete`

Deletes records by primary key values.

```json
{
	"operation": "delete",
	"database": "dev",
	"table": "dog",
	"ids": [1, 2]
}
```

### `search_by_id`

Returns records matching the given primary key values. Use `"get_attributes": ["*"]` to return all attributes.

```json
{
	"operation": "search_by_id",
	"database": "dev",
	"table": "dog",
	"ids": [1, 2],
	"get_attributes": ["dog_name", "breed_id"]
}
```

### `search_by_value`

Returns records with a matching value on any attribute. Supports wildcards (e.g., `"Ky*"`).

```json
{
	"operation": "search_by_value",
	"database": "dev",
	"table": "dog",
	"attribute": "owner_name",
	"value": "Ky*",
	"get_attributes": ["id", "dog_name"]
}
```

### `search_by_conditions`

Returns records matching one or more conditions. Supports `operator` (`and`/`or`), `offset`, `limit`, nested `conditions` groups, and `sort` with multi-level tie-breaking.

```json
{
	"operation": "search_by_conditions",
	"database": "dev",
	"table": "dog",
	"operator": "and",
	"limit": 10,
	"get_attributes": ["*"],
	"conditions": [{ "attribute": "age", "comparator": "between", "value": [5, 8] }]
}
```

---

## Bulk Operations

Operations for bulk import/export of data.

Detailed documentation: [Database Jobs](../database/jobs.md)

| Operation               | Description                                                    | Role Required |
| ----------------------- | -------------------------------------------------------------- | ------------- |
| `export_local`          | Exports query results to a local file in JSON or CSV           | super_user    |
| `csv_data_load`         | Ingests CSV data provided inline                               | any           |
| `csv_file_load`         | Ingests CSV data from a server-local file path                 | any           |
| `csv_url_load`          | Ingests CSV data from a URL                                    | any           |
| `export_to_s3`          | Exports query results to AWS S3                                | super_user    |
| `import_from_s3`        | Imports CSV or JSON data from AWS S3                           | any           |
| `delete_records_before` | Deletes records older than a given timestamp (local node only) | super_user    |

All bulk import/export operations are asynchronous and return a job ID. Use [`get_job`](#get_job) to check status.

### `export_local`

Exports query results to a local path on the server. Formats: `json` or `csv`.

```json
{
	"operation": "export_local",
	"format": "json",
	"path": "/data/",
	"search_operation": { "operation": "sql", "sql": "SELECT * FROM dev.dog" }
}
```

### `csv_data_load`

Ingests inline CSV data. Actions: `insert` (default), `update`, `upsert`.

```json
{
	"operation": "csv_data_load",
	"database": "dev",
	"table": "dog",
	"action": "insert",
	"data": "id,name\n1,Penny\n"
}
```

### `csv_file_load`

Ingests CSV from a file path on the server running Harper.

```json
{
	"operation": "csv_file_load",
	"database": "dev",
	"table": "dog",
	"file_path": "/home/user/imports/dogs.csv"
}
```

### `csv_url_load`

Ingests CSV from a URL.

```json
{
	"operation": "csv_url_load",
	"database": "dev",
	"table": "dog",
	"csv_url": "https://example.com/dogs.csv"
}
```

### `export_to_s3`

Exports query results to an AWS S3 bucket as JSON or CSV.

```json
{
	"operation": "export_to_s3",
	"format": "json",
	"s3": {
		"aws_access_key_id": "YOUR_KEY",
		"aws_secret_access_key": "YOUR_SECRET",
		"bucket": "my-bucket",
		"key": "dogs.json",
		"region": "us-east-1"
	},
	"search_operation": { "operation": "sql", "sql": "SELECT * FROM dev.dog" }
}
```

### `import_from_s3`

Imports CSV or JSON from an AWS S3 bucket. File must include a valid `.csv` or `.json` extension.

```json
{
	"operation": "import_from_s3",
	"database": "dev",
	"table": "dog",
	"s3": {
		"aws_access_key_id": "YOUR_KEY",
		"aws_secret_access_key": "YOUR_SECRET",
		"bucket": "my-bucket",
		"key": "dogs.csv",
		"region": "us-east-1"
	}
}
```

### `delete_records_before`

Deletes records older than the specified timestamp from the local node only. Clustered nodes retain their data.

```json
{
	"operation": "delete_records_before",
	"date": "2021-01-25T23:05:27.464",
	"schema": "dev",
	"table": "dog"
}
```

---

## SQL Operations

Operations for executing SQL statements.

:::warning
Harper SQL is intended for data investigation and use cases where performance is not a priority. For production workloads, use NoSQL or REST operations. SQL performance optimizations are on the roadmap.
:::

Detailed documentation: [SQL Reference](../database/sql.md)

| Operation | Description                                                        | Role Required |
| --------- | ------------------------------------------------------------------ | ------------- |
| `sql`     | Executes a SQL `SELECT`, `INSERT`, `UPDATE`, or `DELETE` statement | any           |

### `sql`

Executes a standard SQL statement.

```json
{ "operation": "sql", "sql": "SELECT * FROM dev.dog WHERE id = 1" }
```

---

## Users & Roles

Operations for managing users and role-based access control (RBAC).

Detailed documentation: [Users & Roles Operations](../users-and-roles/operations.md)

| Operation    | Description                                         | Role Required |
| ------------ | --------------------------------------------------- | ------------- |
| `list_roles` | Returns all roles                                   | super_user    |
| `add_role`   | Creates a new role with permissions                 | super_user    |
| `alter_role` | Modifies an existing role's permissions             | super_user    |
| `drop_role`  | Deletes a role (role must have no associated users) | super_user    |
| `list_users` | Returns all users                                   | super_user    |
| `user_info`  | Returns data for the authenticated user             | any           |
| `add_user`   | Creates a new user                                  | super_user    |
| `alter_user` | Modifies an existing user's credentials or role     | super_user    |
| `drop_user`  | Deletes a user                                      | super_user    |

### `list_roles`

Returns all roles defined in the instance.

```json
{ "operation": "list_roles" }
```

### `add_role`

Creates a new role with the specified permissions. The `permission` object maps database names to table-level access rules (`read`, `insert`, `update`, `delete`). Set `super_user: true` to grant full access.

```json
{
	"operation": "add_role",
	"role": "developer",
	"permission": {
		"super_user": false,
		"dev": {
			"tables": {
				"dog": { "read": true, "insert": true, "update": true, "delete": false }
			}
		}
	}
}
```

### `alter_role`

Modifies an existing role's name or permissions. Requires the role's `id` (returned by `list_roles`).

```json
{
	"operation": "alter_role",
	"id": "f92162e2-cd17-450c-aae0-372a76859038",
	"role": "senior_developer",
	"permission": {
		"super_user": false,
		"dev": {
			"tables": {
				"dog": { "read": true, "insert": true, "update": true, "delete": true }
			}
		}
	}
}
```

### `drop_role`

Deletes a role. The role must have no associated users before it can be dropped.

```json
{ "operation": "drop_role", "id": "f92162e2-cd17-450c-aae0-372a76859038" }
```

### `list_users`

Returns all users.

```json
{ "operation": "list_users" }
```

### `user_info`

Returns data for the currently authenticated user.

```json
{ "operation": "user_info" }
```

### `add_user`

Creates a new user. `username` cannot be changed after creation. `password` is stored encrypted.

```json
{
	"operation": "add_user",
	"role": "developer",
	"username": "hdb_user",
	"password": "password",
	"active": true
}
```

### `alter_user`

Modifies an existing user's password, role, or active status. All fields except `username` are optional.

```json
{
	"operation": "alter_user",
	"username": "hdb_user",
	"password": "new_password",
	"role": "senior_developer",
	"active": true
}
```

### `drop_user`

Deletes a user by username.

```json
{ "operation": "drop_user", "username": "hdb_user" }
```

See [Users & Roles Operations](../users-and-roles/operations.md) for full documentation including permission object structure.

---

## Token Authentication

Operations for JWT token creation and refresh.

Detailed documentation: [JWT Authentication](../security/jwt-authentication.md)

| Operation                      | Description                                             | Role Required          |
| ------------------------------ | ------------------------------------------------------- | ---------------------- |
| `create_authentication_tokens` | Creates an operation token and refresh token for a user | none (unauthenticated) |
| `refresh_operation_token`      | Creates a new operation token from a refresh token      | any                    |

### `create_authentication_tokens`

Does not require prior authentication. Returns `operation_token` (short-lived JWT) and `refresh_token` (long-lived JWT).

```json
{
	"operation": "create_authentication_tokens",
	"username": "my-user",
	"password": "my-password"
}
```

### `refresh_operation_token`

Creates a new operation token from an existing refresh token.

```json
{
	"operation": "refresh_operation_token",
	"refresh_token": "EXISTING_REFRESH_TOKEN"
}
```

---

## Components

Operations for deploying and managing Harper components (applications, extensions, plugins).

Detailed documentation: [Components Overview](../components/overview.md)

| Operation              | Description                                                             | Role Required |
| ---------------------- | ----------------------------------------------------------------------- | ------------- |
| `add_component`        | Creates a new component project from a template                         | super_user    |
| `deploy_component`     | Deploys a component via payload (tar) or package reference (NPM/GitHub) | super_user    |
| `package_component`    | Packages a component project into a base64-encoded tar                  | super_user    |
| `drop_component`       | Deletes a component or a file within a component                        | super_user    |
| `get_components`       | Lists all component files and config                                    | super_user    |
| `get_component_file`   | Returns the contents of a file within a component                       | super_user    |
| `set_component_file`   | Creates or updates a file within a component                            | super_user    |
| `add_ssh_key`          | Adds an SSH key for deploying from private repositories                 | super_user    |
| `update_ssh_key`       | Updates an existing SSH key                                             | super_user    |
| `delete_ssh_key`       | Deletes an SSH key                                                      | super_user    |
| `list_ssh_keys`        | Lists all configured SSH key names                                      | super_user    |
| `set_ssh_known_hosts`  | Overwrites the SSH known_hosts file                                     | super_user    |
| `get_ssh_known_hosts`  | Returns the contents of the SSH known_hosts file                        | super_user    |
| `install_node_modules` | _(Deprecated)_ Run npm install on component projects                    | super_user    |

### `deploy_component`

Deploys a component. The `package` option accepts any valid NPM reference including GitHub repos (`HarperDB/app#semver:v1.0.0`), tarballs, or NPM packages. The `payload` option accepts a base64-encoded tar string from `package_component`. Supports `"replicated": true` and `"restart": true` or `"restart": "rolling"`.

```json
{
	"operation": "deploy_component",
	"project": "my-app",
	"package": "my-org/my-app#semver:v1.2.3",
	"replicated": true,
	"restart": "rolling"
}
```

### `add_ssh_key`

Adds an SSH key (must be ed25519) for authenticating deployments from private repositories.

```json
{
	"operation": "add_ssh_key",
	"name": "my-key",
	"key": "-----BEGIN OPENSSH PRIVATE KEY-----\n...\n-----END OPENSSH PRIVATE KEY-----\n",
	"host": "my-key.github.com",
	"hostname": "github.com"
}
```

---

## Replication & Clustering

Operations for configuring and managing Harper cluster replication.

Detailed documentation: [Replication & Clustering](../replication/clustering.md)

| Operation               | Description                                                     | Role Required |
| ----------------------- | --------------------------------------------------------------- | ------------- |
| `add_node`              | Adds a Harper instance to the cluster                           | super_user    |
| `update_node`           | Modifies an existing node's subscriptions                       | super_user    |
| `remove_node`           | Removes a node from the cluster                                 | super_user    |
| `cluster_status`        | Returns current cluster connection status                       | super_user    |
| `configure_cluster`     | Bulk-creates/resets cluster subscriptions across multiple nodes | super_user    |
| `cluster_set_routes`    | Adds routes to the replication routes config (PATCH/upsert)     | super_user    |
| `cluster_get_routes`    | Returns the current replication routes config                   | super_user    |
| `cluster_delete_routes` | Removes routes from the replication routes config               | super_user    |

### `add_node`

Adds a remote Harper node to the cluster. If `subscriptions` are not provided, a fully replicating cluster is created. Optional fields: `verify_tls`, `authorization`, `retain_authorization`, `revoked_certificates`, `shard`.

```json
{
	"operation": "add_node",
	"hostname": "server-two",
	"verify_tls": false,
	"authorization": { "username": "admin", "password": "password" }
}
```

### `cluster_status`

Returns connection state for all cluster nodes, including per-database socket status and replication timing statistics (`lastCommitConfirmed`, `lastReceivedRemoteTime`, `lastReceivedLocalTime`).

```json
{ "operation": "cluster_status" }
```

### `configure_cluster`

Resets and replaces the entire clustering configuration. Each entry follows the `add_node` schema.

```json
{
	"operation": "configure_cluster",
	"connections": [
		{
			"hostname": "server-two",
			"subscriptions": [{ "database": "dev", "table": "dog", "subscribe": true, "publish": true }]
		}
	]
}
```

---

## Configuration

Operations for reading and updating Harper configuration.

Detailed documentation: [Configuration Overview](../configuration/overview.md)

| Operation           | Description                                                      | Role Required |
| ------------------- | ---------------------------------------------------------------- | ------------- |
| `set_configuration` | Modifies Harper configuration file parameters (requires restart) | super_user    |
| `get_configuration` | Returns the current Harper configuration                         | super_user    |

### `set_configuration`

Updates configuration parameters in `harperdb-config.yaml`. A restart (`restart` or `restart_service`) is required for changes to take effect.

```json
{
	"operation": "set_configuration",
	"logging_level": "trace",
	"clustering_enabled": true
}
```

### `get_configuration`

Returns the full current configuration object.

```json
{ "operation": "get_configuration" }
```

---

## System

Operations for restarting Harper and managing system state.

| Operation            | Description                                           | Role Required |
| -------------------- | ----------------------------------------------------- | ------------- |
| `restart`            | Restarts the Harper instance                          | super_user    |
| `restart_service`    | Restarts a specific Harper service                    | super_user    |
| `system_information` | Returns detailed host system metrics                  | super_user    |
| `set_status`         | Sets an application-specific status value (in-memory) | super_user    |
| `get_status`         | Returns a previously set status value                 | super_user    |
| `clear_status`       | Removes a status entry                                | super_user    |

### `restart`

Restarts all Harper processes. May take up to 60 seconds.

```json
{ "operation": "restart" }
```

### `restart_service`

Restarts a specific service. `service` must be one of: `http_workers`, `clustering_config`, `clustering`. Supports `"replicated": true` for a rolling cluster restart.

```json
{ "operation": "restart_service", "service": "http_workers" }
```

### `system_information`

Returns system metrics including CPU, memory, disk, network, and Harper process info. Optionally filter by `attributes` array (e.g., `["cpu", "memory", "replication"]`).

```json
{ "operation": "system_information" }
```

### `set_status` / `get_status` / `clear_status`

Manage in-memory application status values. Status types: `primary`, `maintenance`, `availability` (availability only accepts `'Available'` or `'Unavailable'`). Status is not persisted across restarts.

```json
{ "operation": "set_status", "id": "primary", "status": "active" }
```

---

## Jobs

Operations for querying background job status.

Detailed documentation: [Database Jobs](../database/jobs.md)

| Operation                   | Description                                      | Role Required |
| --------------------------- | ------------------------------------------------ | ------------- |
| `get_job`                   | Returns status and results for a specific job ID | any           |
| `search_jobs_by_start_date` | Returns jobs within a specified time window      | super_user    |

### `get_job`

Returns job status (`COMPLETE`, `IN_PROGRESS`, `ERROR`), timing, and result message for the specified job ID. Bulk import/export operations return a job ID on initiation.

```json
{ "operation": "get_job", "id": "4a982782-929a-4507-8794-26dae1132def" }
```

### `search_jobs_by_start_date`

Returns all jobs started within the specified datetime range.

```json
{
	"operation": "search_jobs_by_start_date",
	"from_date": "2021-01-25T22:05:27.464+0000",
	"to_date": "2021-01-25T23:05:27.464+0000"
}
```

---

## Logs

Operations for reading Harper logs.

Detailed documentation: [Logging Operations](../logging/operations.md)

| Operation                        | Description                                                            | Role Required |
| -------------------------------- | ---------------------------------------------------------------------- | ------------- |
| `read_log`                       | Returns entries from the primary `hdb.log`                             | super_user    |
| `read_transaction_log`           | Returns transaction history for a table                                | super_user    |
| `delete_transaction_logs_before` | Deletes transaction log entries older than a timestamp                 | super_user    |
| `read_audit_log`                 | Returns verbose audit history for a table (requires audit log enabled) | super_user    |
| `delete_audit_logs_before`       | Deletes audit log entries older than a timestamp                       | super_user    |

### `read_log`

Returns entries from `hdb.log`. Filter by `level` (`notify`, `error`, `warn`, `info`, `debug`, `trace`), date range (`from`, `until`), and text `filter`.

```json
{
	"operation": "read_log",
	"start": 0,
	"limit": 100,
	"level": "error"
}
```

### `read_transaction_log`

Returns transaction history for a specific table. Optionally filter by `from`/`to` (millisecond epoch) and `limit`.

```json
{
	"operation": "read_transaction_log",
	"schema": "dev",
	"table": "dog",
	"limit": 10
}
```

### `read_audit_log`

Returns verbose audit history including original record state. Requires `logging.auditLog: true` in configuration. Filter by `search_type`: `hash_value`, `timestamp`, or `username`.

```json
{
	"operation": "read_audit_log",
	"schema": "dev",
	"table": "dog",
	"search_type": "username",
	"search_values": ["admin"]
}
```

---

## Certificate Management

Operations for managing TLS certificates in the `hdb_certificate` system table.

Detailed documentation: [Certificate Management](../security/certificate-management.md)

| Operation            | Description                                    | Role Required |
| -------------------- | ---------------------------------------------- | ------------- |
| `add_certificate`    | Adds or updates a certificate                  | super_user    |
| `remove_certificate` | Removes a certificate and its private key file | super_user    |
| `list_certificates`  | Lists all certificates                         | super_user    |

### `add_certificate`

Adds a certificate to `hdb_certificate`. If a `private_key` is provided, it is written to `<rootPath>/keys/` (not stored in the table). If no private key is provided, the operation searches for a matching one on disk.

```json
{
	"operation": "add_certificate",
	"name": "my-cert",
	"certificate": "-----BEGIN CERTIFICATE-----...",
	"is_authority": false,
	"private_key": "-----BEGIN RSA PRIVATE KEY-----..."
}
```

---

## Analytics

Operations for querying analytics metrics.

Detailed documentation: [Analytics Operations](../analytics/operations.md)

| Operation         | Description                                     | Role Required |
| ----------------- | ----------------------------------------------- | ------------- |
| `get_analytics`   | Retrieves analytics data for a specified metric | any           |
| `list_metrics`    | Lists available analytics metrics               | any           |
| `describe_metric` | Returns the schema of a specific metric         | any           |

### `get_analytics`

Retrieves analytics data. Supports `start_time`/`end_time` (Unix ms), `get_attributes`, and `conditions` (same format as `search_by_conditions`).

```json
{
	"operation": "get_analytics",
	"metric": "resource-usage",
	"start_time": 1769198332754,
	"end_time": 1769198532754
}
```

### `list_metrics`

Returns available metric names. Filter by `metric_types`: `custom`, `builtin` (default: `builtin`).

```json
{ "operation": "list_metrics" }
```

---

## Registration & Licensing

Operations for license management.

| Operation               | Description                                        | Role Required |
| ----------------------- | -------------------------------------------------- | ------------- |
| `registration_info`     | Returns registration and version information       | any           |
| `install_usage_license` | Installs a Harper usage license block              | super_user    |
| `get_usage_licenses`    | Returns all usage licenses with consumption counts | super_user    |
| `get_fingerprint`       | _(Deprecated)_ Returns the machine fingerprint     | super_user    |
| `set_license`           | _(Deprecated)_ Sets a license key                  | super_user    |

### `registration_info`

Returns the instance registration status, version, RAM allocation, and license expiration.

```json
{ "operation": "registration_info" }
```

### `install_usage_license`

Installs a usage license block. A license is a JWT-like structure (`header.payload.signature`) signed by Harper. Multiple blocks may be installed; earliest blocks are consumed first.

```json
{
	"operation": "install_usage_license",
	"license": "abc...0123.abc...0123.abc...0123"
}
```

### `get_usage_licenses`

Returns all usage licenses (including expired/exhausted) with current consumption counts. Optionally filter by `region`.

```json
{ "operation": "get_usage_licenses" }
```

---

## Deprecated Operations

The following operations are deprecated and should not be used in new code.

### Custom Functions (Deprecated)

Custom Functions were the precursor to the Component architecture introduced in v4.2.0. These operations are preserved for backward compatibility.

Deprecated in: v4.2.0 (moved to legacy in v4.7+)

For modern equivalents, see [Components Overview](../components/overview.md).

| Operation                         | Description                                      |
| --------------------------------- | ------------------------------------------------ |
| `custom_functions_status`         | Returns Custom Functions server status           |
| `get_custom_functions`            | Lists all Custom Function projects               |
| `get_custom_function`             | Returns a Custom Function file's content         |
| `set_custom_function`             | Creates or updates a Custom Function file        |
| `drop_custom_function`            | Deletes a Custom Function file                   |
| `add_custom_function_project`     | Creates a new Custom Function project            |
| `drop_custom_function_project`    | Deletes a Custom Function project                |
| `package_custom_function_project` | Packages a Custom Function project as base64 tar |
| `deploy_custom_function_project`  | Deploys a packaged Custom Function project       |

### Other Deprecated Operations

| Operation              | Replaced By                                                         |
| ---------------------- | ------------------------------------------------------------------- |
| `install_node_modules` | Handled automatically by `deploy_component` and `restart`           |
| `get_fingerprint`      | Use `registration_info`                                             |
| `set_license`          | Use `install_usage_license`                                         |
| `search_by_hash`       | Use `search_by_id`                                                  |
| `search_attribute`     | Use `attribute` field in `search_by_value` / `search_by_conditions` |
| `search_value`         | Use `value` field in `search_by_value` / `search_by_conditions`     |
| `search_type`          | Use `comparator` field in `search_by_conditions`                    |
