---
id: operations
title: Operations
---

<!-- Source: versioned_docs/version-4.7/developers/operations-api/users-and-roles.md (operations API reference) -->

## Roles

### List Roles

_Restricted to `super_user` roles._

```json
{
	"operation": "list_roles"
}
```

### Add Role

_Restricted to `super_user` roles._

- `role` _(required)_ — Name for the new role.
- `permission` _(required)_ — Permissions object. See [Permission Structure](./overview#permission-structure).
  - `super_user` _(optional)_ — If `true`, grants full access. Defaults to `false`.
  - `structure_user` _(optional)_ — Boolean or array of database names. If `true`, can create/drop databases and tables. If array, limited to specified databases.
  - `operations` _(optional)_ — Array of operation names and/or permission group names (`read_only`, `standard_user`) this role may call. When set, any unlisted operation is denied. See [Operation Permissions](./overview#operation-permissions).

```json
{
	"operation": "add_role",
	"role": "developer",
	"permission": {
		"super_user": false,
		"structure_user": false,
		"dev": {
			"tables": {
				"dog": {
					"read": true,
					"insert": true,
					"update": true,
					"delete": false,
					"attribute_permissions": [
						{
							"attribute_name": "name",
							"read": true,
							"insert": true,
							"update": true
						}
					]
				}
			}
		}
	}
}
```

### Alter Role

_Restricted to `super_user` roles._

- `id` _(required)_ — The `id` of the role to alter (from `list_roles`).
- `role` _(optional)_ — New name for the role.
- `permission` _(required)_ — Updated permissions object.

```json
{
	"operation": "alter_role",
	"id": "f92162e2-cd17-450c-aae0-372a76859038",
	"role": "another_developer",
	"permission": {
		"super_user": false,
		"structure_user": false,
		"dev": {
			"tables": {
				"dog": {
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

### Drop Role

_Restricted to `super_user` roles. Roles with associated users cannot be dropped._

- `id` _(required)_ — The `id` of the role to drop.

```json
{
	"operation": "drop_role",
	"id": "developer"
}
```

## Users

### List Users

_Restricted to `super_user` roles._

```json
{
	"operation": "list_users"
}
```

### User Info

Returns user data for the currently authenticated user. Available to all roles.

```json
{
	"operation": "user_info"
}
```

### Add User

_Restricted to `super_user` roles._

- `role` _(required)_ — Role name to assign.
- `username` _(required)_ — Username. Cannot be changed after creation.
- `password` _(required)_ — Plain-text password. Harper encrypts it on receipt.
- `active` _(required)_ — Boolean. If `false`, user cannot access Harper.

```json
{
	"operation": "add_user",
	"role": "role_name",
	"username": "hdb_user",
	"password": "password",
	"active": true
}
```

### Alter User

_Restricted to `super_user` roles._

- `username` _(required)_ — Username to modify.
- `password` _(optional)_ — New password.
- `role` _(optional)_ — New role name.
- `active` _(optional)_ — Enable/disable user access.

```json
{
	"operation": "alter_user",
	"role": "role_name",
	"username": "hdb_user",
	"password": "new_password",
	"active": true
}
```

### Drop User

_Restricted to `super_user` roles._

```json
{
	"operation": "drop_user",
	"username": "harper"
}
```

## Related

- [Overview](./overview)
- [Configuration](./configuration)
