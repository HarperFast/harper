---
id: overview
title: Users & Roles
---

<!-- Source: versioned_docs/version-4.7/developers/security/users-and-roles.md (primary) -->
<!-- Source: versioned_docs/version-4.7/reference/roles.md (roles config file format) -->

Harper uses a Role-Based Access Control (RBAC) framework to manage access to Harper instances. Each user is assigned a role that determines their permissions to access database resources and run operations.

## Roles

Role permissions in Harper are divided into two categories:

**Database Manipulation** — CRUD (create, read, update, delete) permissions against database data (tables and attributes).

**Database Definition** — Permissions to manage databases, tables, roles, users, and other system settings. These are restricted to the built-in `super_user` role.

### Built-In Roles

| Role             | Description                                                                                                                                     |
| ---------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `super_user`     | Full access to all operations and methods. The admin role.                                                                                      |
| `structure_user` | Access to create and delete databases and tables. Can be set to `true` (all databases) or an array of database names (specific databases only). |

### User-Defined Roles

Admins (`super_user` users) can create custom roles with explicit permissions on specific tables and attributes.

- Unless a user-defined role has `super_user: true`, all permissions must be defined explicitly.
- Any table or database not included in the role's permission set will be inaccessible.
- `describe` operations return metadata only for databases, tables, and attributes that the role has CRUD permissions for.

## Permission Structure

When creating or altering a role, you define a `permission` object:

```json
{
	"operation": "add_role",
	"role": "software_developer",
	"permission": {
		"super_user": false,
		"database_name": {
			"tables": {
				"table_name1": {
					"read": true,
					"insert": true,
					"update": true,
					"delete": false,
					"attribute_permissions": [
						{
							"attribute_name": "attribute1",
							"read": true,
							"insert": true,
							"update": true
						}
					]
				},
				"table_name2": {
					"read": true,
					"insert": true,
					"update": true,
					"delete": false,
					"attribute_permissions": []
				}
			}
		}
	}
}
```

### Operation Permissions

The `operations` field in a permission object restricts which Operations API calls this role can make. When set, it acts as a two-gate check:

1. Only listed operations are reachable — any unlisted operation is denied regardless of table CRUD permissions.
2. For data operations that pass gate one, table-level CRUD permissions still apply as normal.

Operations normally restricted to `super_user` can be selectively granted by including them in the list. If `operations` is not set, the role can call any non-`super_user` operation, subject to table CRUD permissions.

**Permission Groups**

Groups expand to a predefined set of operations and can be mixed with individual operation names:

- `read_only` — Search, SQL SELECT, describe, and monitoring operations. No data modification. Operations: `search`, `search_by_conditions`, `search_by_hash`, `search_by_id`, `search_by_value`, `sql`, `describe_all`, `describe_schema`, `describe_database`, `describe_table`, `user_info`, `get_job`, `get_analytics`, `list_metrics`, `describe_metric`

- `standard_user` — Everything in `read_only` plus full data manipulation and bulk load. Does not include any `super_user`-restricted operations, schema DDL (`create_attribute`), or token management. Additional operations beyond `read_only`: `insert`, `update`, `upsert`, `delete`, `csv_data_load`, `csv_file_load`, `csv_url_load`, `import_from_s3`

**Example: read-only role**

```json
{
	"operation": "add_role",
	"role": "read_only_analyst",
	"permission": {
		"operations": ["read_only"],
		"orders_db": {
			"tables": {
				"orders": {
					"read": true,
					"insert": false,
					"update": false,
					"delete": false,
					"attribute_permissions": []
				}
			}
		}
	}
}
```

**Example: full data access + targeted admin operations**

```json
{
	"operation": "add_role",
	"role": "ops_engineer",
	"permission": {
		"operations": ["standard_user", "get_configuration", "system_information"],
		"orders_db": {
			"tables": {
				"orders": {
					"read": true,
					"insert": true,
					"update": true,
					"delete": true,
					"attribute_permissions": []
				}
			}
		}
	}
}
```

### Table Permissions

Each table entry defines CRUD access:

```jsonc
{
  "table_name": {
    "read": boolean,    // Access to read from this table
    "insert": boolean,  // Access to insert data
    "update": boolean,  // Access to update data
    "delete": boolean,  // Access to delete rows
    "attribute_permissions": [
      {
        "attribute_name": "attribute_name",
        "read": boolean,
        "insert": boolean,
        "update": boolean
        // Note: "delete" is not an attribute-level permission
      }
    ]
  }
}
```

### Important Rules

**Table-level:**

- If a database or table is not included in the permissions, the role has no access to it.
- If a table-level CRUD permission is `false`, setting the same CRUD permission to `true` on an attribute returns an error.

**Attribute-level:**

- If `attribute_permissions` is a non-empty array, only the listed attributes are accessible (plus the table's hash attribute — see below).
- If `attribute_permissions` is empty (`[]`), attribute access follows the table-level CRUD permissions.
- If any non-hash attribute is given CRUD access, the table's `hash_attribute` (primary key) automatically receives the same access, even if not explicitly listed.
- Any attribute not explicitly listed in a non-empty `attribute_permissions` array has no access.
- `DELETE` is not an attribute-level permission. Deleting rows is controlled at the table level.
- The `__createdtime__` and `__updatedtime__` attributes managed by Harper can have `read` permissions set; other attribute-level permissions for these fields are ignored.

## Role-Based Operation Restrictions

### Databases and Tables

| Operation           | Restricted to Super User |
| ------------------- | :----------------------: |
| `describe_all`      |                          |
| `describe_database` |                          |
| `describe_table`    |                          |
| `create_database`   |            X             |
| `drop_database`     |            X             |
| `create_table`      |            X             |
| `drop_table`        |            X             |
| `create_attribute`  |                          |
| `drop_attribute`    |            X             |

### NoSQL Operations

| Operation              | Restricted to Super User |
| ---------------------- | :----------------------: |
| `insert`               |                          |
| `update`               |                          |
| `upsert`               |                          |
| `delete`               |                          |
| `search_by_hash`       |                          |
| `search_by_value`      |                          |
| `search_by_conditions` |                          |

### SQL Operations

| Operation | Restricted to Super User |
| --------- | :----------------------: |
| `select`  |                          |
| `insert`  |                          |
| `update`  |                          |
| `delete`  |                          |

### Bulk Operations

| Operation        | Restricted to Super User |
| ---------------- | :----------------------: |
| `csv_data_load`  |                          |
| `csv_file_load`  |                          |
| `csv_url_load`   |                          |
| `import_from_s3` |                          |

### Users and Roles

| Operation    | Restricted to Super User |
| ------------ | :----------------------: |
| `list_roles` |            X             |
| `add_role`   |            X             |
| `alter_role` |            X             |
| `drop_role`  |            X             |
| `list_users` |            X             |
| `user_info`  |                          |
| `add_user`   |            X             |
| `alter_user` |            X             |
| `drop_user`  |            X             |

### Clustering

| Operation               | Restricted to Super User |
| ----------------------- | :----------------------: |
| `cluster_set_routes`    |            X             |
| `cluster_get_routes`    |            X             |
| `cluster_delete_routes` |            X             |
| `add_node`              |            X             |
| `update_node`           |            X             |
| `cluster_status`        |            X             |
| `remove_node`           |            X             |
| `configure_cluster`     |            X             |

### Components

| Operation            | Restricted to Super User |
| -------------------- | :----------------------: |
| `get_components`     |            X             |
| `get_component_file` |            X             |
| `set_component_file` |            X             |
| `drop_component`     |            X             |
| `add_component`      |            X             |
| `package_component`  |            X             |
| `deploy_component`   |            X             |

### Registration

| Operation           | Restricted to Super User |
| ------------------- | :----------------------: |
| `registration_info` |                          |
| `get_fingerprint`   |            X             |
| `set_license`       |            X             |

### Jobs

| Operation                   | Restricted to Super User |
| --------------------------- | :----------------------: |
| `get_job`                   |                          |
| `search_jobs_by_start_date` |            X             |

### Logs

| Operation                        | Restricted to Super User |
| -------------------------------- | :----------------------: |
| `read_log`                       |            X             |
| `read_transaction_log`           |            X             |
| `delete_transaction_logs_before` |            X             |
| `read_audit_log`                 |            X             |
| `delete_audit_logs_before`       |            X             |

### Utilities

| Operation               | Restricted to Super User |
| ----------------------- | :----------------------: |
| `delete_records_before` |            X             |
| `export_local`          |            X             |
| `export_to_s3`          |            X             |
| `system_information`    |            X             |
| `restart`               |            X             |
| `restart_service`       |            X             |
| `get_configuration`     |            X             |

### Token Authentication

| Operation                      | Restricted to Super User |
| ------------------------------ | :----------------------: |
| `create_authentication_tokens` |                          |
| `refresh_operation_token`      |                          |

## Troubleshooting: "Must execute as User"

If you see the error `Error: Must execute as <<username>>`, it means Harper was installed as a specific OS user and must be run by that same user. Harper stores files natively on the operating system and only allows the Harper executable to be run by a single user — this prevents file permission issues and keeps the installation secure.

To resolve: run Harper with the same OS user account used during installation.

## Related

- [Configuration](./configuration)
- [Operations](./operations)
