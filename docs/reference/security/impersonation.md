---
title: Impersonation
---

# Impersonation

Impersonation allows a `super_user` to execute operations API requests as if they were a different, less-privileged user. This is useful for testing permissions, debugging access issues, and building admin tools that preview what a given user or role can see and do — all without needing that user's credentials.

## How It Works

Add an `impersonate` property to any operations API request body. Harper will authenticate the request normally (the caller must be a `super_user`), then **downgrade** the effective permissions for that request to match the impersonated identity.

```http
POST https://my-harperdb-server:9925/
Authorization: Basic <super_user credentials>
Content-Type: application/json

{
    "operation": "search_by_hash",
    "database": "dev",
    "table": "dog",
    "hash_values": ["1"],
    "impersonate": {
        "username": "test_user"
    }
}
```

The request above runs the `search_by_hash` as if `test_user` had made it — subject to that user's role permissions.

## Security Constraints

- **Super user only** — only users with `super_user` permissions can use `impersonate`. All other users receive a `403` error.
- **Downgrade only** — impersonation can never escalate privileges. The `super_user` and `cluster_user` flags are always forced to `false` on the impersonated identity.
- **Audit trail** — every impersonated request is logged, recording who initiated the impersonation and which identity was assumed.

## Impersonation Modes

There are three ways to specify the impersonated identity, depending on what you want to test.

### Impersonate an Existing User

Provide a `username` to run the request with that user's current role and permissions.

```json
{
	"operation": "search_by_hash",
	"database": "dev",
	"table": "dog",
	"hash_values": ["1"],
	"impersonate": {
		"username": "test_user"
	}
}
```

The target user must exist and be active. If the user is not found, a `404` error is returned. If the user is inactive, a `403` error is returned.

### Impersonate an Existing Role

Provide a `role_name` to run the request with that role's permissions. You can optionally include a `username` to set the effective username (defaults to the caller's username).

```json
{
	"operation": "search_by_value",
	"database": "dev",
	"table": "dog",
	"search_attribute": "name",
	"search_value": "Penny",
	"impersonate": {
		"role_name": "developer"
	}
}
```

The role must exist. If the role is not found, a `404` error is returned.

### Impersonate with Inline Permissions

Provide a `role` object with a `permission` property to test with an ad-hoc set of permissions. This is useful for previewing the effect of a role you haven't created yet.

```json
{
	"operation": "sql",
	"sql": "SELECT * FROM dev.dog",
	"impersonate": {
		"username": "preview_user",
		"role": {
			"permission": {
				"dev": {
					"tables": {
						"dog": {
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
	}
}
```

The `username` field is optional and defaults to the caller's username. The `permission` object follows the same structure as [role permissions](../users-and-roles/overview.md#operation-permissions).

You can also restrict the impersonated identity to a specific set of operations API calls using the `operations` field inside `permission`:

```json
{
	"operation": "search_by_hash",
	"database": "dev",
	"table": "dog",
	"hash_values": ["1"],
	"impersonate": {
		"role": {
			"permission": {
				"operations": ["read_only"],
				"dev": {
					"tables": {
						"dog": {
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
	}
}
```

## Impersonate Payload Reference

| Field             | Type   | Description                                                                                                                  |
| ----------------- | ------ | ---------------------------------------------------------------------------------------------------------------------------- |
| `username`        | string | Target username. Required for existing-user mode. Optional for role-based modes (defaults to the caller's username).         |
| `role_name`       | string | Name of an existing role to assume.                                                                                          |
| `role`            | object | Inline role definition. Must include a `permission` object.                                                                  |
| `role.permission` | object | Permission object following the standard [role permissions](../users-and-roles/overview.md#operation-permissions) structure. |

Exactly one of `username` (alone), `role_name`, or `role` must be provided. If `role` is present, it takes precedence.

## Use Cases

- **Admin dashboards** — preview what a user sees without switching accounts.
- **Permission testing** — verify that a role grants (or denies) the expected access before assigning it to users.
- **Debugging** — reproduce access issues reported by a user by impersonating them directly.
- **CI/CD** — automated tests can verify permission configurations by impersonating different roles against a single `super_user` credential.
