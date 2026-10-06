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

### `describe_all`

Returns the definitions of all databases and tables within the database. Record counts above 5000 records are estimated; the response includes `estimated_record_range` when estimated. To force an exact count (requires full table scan), include `"exact_count": true`. Each table definition includes the [record-structure dictionary fields](#describe_table) described for `describe_table`.

```json
{ "operation": "describe_all" }
```

### `describe_database`

Returns all table definitions within the specified database. Each table definition includes the [record-structure dictionary fields](#describe_table) described for `describe_table`.

```json
{ "operation": "describe_database", "database": "dev" }
```

### `describe_table`

Returns the definition of a specific table.

```json
{ "operation": "describe_table", "table": "dog", "database": "dev" }
```

<VersionBadge type="changed" version="v5.2.5" />

Alongside the schema, the response carries the size of the table's **record-structure dictionaries**
— the physical record layouts Harper has seen for this table. They are how you check whether a table
is getting
[random-access field encoding](../database/storage-tuning.md#storagerandomaccessfields) and how much
room it has left before novel layouts stop receiving it:

| Field                      | Description                                                                          |
| -------------------------- | ------------------------------------------------------------------------------------ |
| `typed_structures_enabled` | Whether random-access (typed) encoding is enabled for this table                     |
| `typed_structure_count`    | Structures in the random-access dictionary                                           |
| `typed_structure_limit`    | Bound past which novel record shapes are stored without random-access field encoding |
| `classic_structure_count`  | Structures in the classic named-record dictionary                                    |

A typed structure is minted per distinct _shape_, where shape means the ordered list of fields plus
the encoded type and width each field's value takes — so `{a, b}` and `{b, a}` are different shapes,
and so are `{v: 1}`, `{v: 70000}`, and `{v: "ok"}`. Dictionary size therefore tracks the variety of
shapes a table has ever written, not its column count, and it only grows: structures are never
pruned, because stored records, transaction-log entries, and replication backlogs all reference them
by id. A classic structure keys on the ordered field names alone, so `classic_structure_count` moves
only when a table writes a field-name set it has not written before, and it stops at 32 — the
classic dictionary's own bound, which is why the response carries no limit field for it.

[`storage.randomAccessFields`](../configuration/options.md#storage) defaults to off, so `typed_structures_enabled: false` with
`typed_structure_count: 0` is the normal state for most tables — that is typed encoding being
disabled, not spare headroom. Where it is enabled, reaching `typed_structure_limit` is not an error:
records with novel shapes past that point still write and read correctly, but are stored without
random-access field encoding, which makes reading individual fields of large records slower. Harper
logs a warning when a thread first observes the bound, but that depends on which thread served the
writes and whether it has loaded the dictionary — the counts here are the reliable signal.

To keep the typed dictionary small, write records in a consistent field order, avoid making the _set_
of present fields vary per write (nest volatile or optional fields inside one sub-object rather than
adding and removing top-level fields), keep a given field to one value type across records, and
expect a small fixed number of extra shapes from numeric fields whose values cross a width boundary.

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

Detailed documentation: [SQL Reference](../operations-api/sql.md)

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

| Operation                      | Description                                                | Role Required          |
| ------------------------------ | ---------------------------------------------------------- | ---------------------- |
| `create_authentication_tokens` | Creates an operation token and refresh token for a user    | none (unauthenticated) |
| `refresh_operation_token`      | Creates a new operation token from a refresh token         | any                    |
| `exchange_oidc_token`          | Trades a CI workload identity token for an operation token | none (unauthenticated) |
| `add_oidc_trust`               | Creates or replaces an OIDC trust policy                   | super_user             |
| `list_oidc_trust`              | Lists all OIDC trust policies, including disabled ones     | super_user             |
| `drop_oidc_trust`              | Deletes an OIDC trust policy                               | super_user             |

### `create_authentication_tokens`

Does not require prior authentication when called with `username`/`password`. Returns `operation_token` (short-lived JWT) and `refresh_token` (long-lived JWT).

```json
{
	"operation": "create_authentication_tokens",
	"username": "my-user",
	"password": "my-password"
}
```

With `role` as an inline role object, instead mints a single **scoped token** whose bearer is limited to the embedded permissions — requires an authenticated `super_user` caller; `username` is attribution only and must not name an existing user (defaults to `scoped:<minter>`); no refresh token is issued and the token cannot be revoked before expiry. See [JWT Authentication / Scoped Tokens](../security/jwt-authentication.md#scoped-tokens-inline-role).

```json
{
	"operation": "create_authentication_tokens",
	"username": "reporting-service",
	"role": { "permission": { "operations": ["read_only"] } },
	"expires_in": "7d"
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

### OIDC Trusted Publishing

<VersionBadge version="v5.3.0" />

A CI runner can authenticate to Harper with **no stored credential**. It presents an identity token minted by its own provider; if that token verifies against a stored **trust policy**, Harper returns a one-hour operation token for the user the policy names. This is the same exchange npm, PyPI, and AWS STS `AssumeRoleWithWebIdentity` use.

The alternative is a `HARPER_CLI_REFRESH_TOKEN` secret: a 30-day credential, one per user, that expires on a schedule nobody tracks. A trust policy replaces it with a rule you configure once, and revoke with `drop_oidc_trust`.

The workflow needs `permissions: id-token: write` and the `HARPER_CLI_TARGET` variable, and no secret at all, since the target is not sensitive. [Deploying from a CI/CD Pipeline](/learn/developers/deploying-from-ci#let-the-workflow-authenticate-with-oidc) has a complete workflow, with the trust policy and deploy-only role it needs. See [CLI Authentication](../cli/authentication.md#workload-identity-oidc) for the client half and where the exchange sits in credential precedence.

Policies live in the replicated `system.hdb_oidc_trust` table, so configuring one on any node applies cluster-wide.

#### `add_oidc_trust`

Creates or replaces a trust policy. **super_user only** — a policy lets an external system authenticate as a Harper user, so granting one is equivalent to handing out a credential.

```json
{
	"operation": "add_oidc_trust",
	"id": "my-app-prod",
	"issuer": "https://token.actions.githubusercontent.com",
	"audience": "https://my-instance.harperdb.io:9925/",
	"user": "ci-deploy",
	"claims": {
		"repository_id": "67890",
		"workflow_ref": "HarperFast/my-app/.github/workflows/deploy.yml@refs/heads/main",
		"environment": "production"
	}
}
```

| Parameter     | Description                                                                                                                |
| ------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `id`          | **Required.** Policy identifier, 1–128 characters of letters, numbers, `_`, `-`, and `.`.                                  |
| `issuer`      | **Required.** The token issuer (`iss`) this policy trusts.                                                                 |
| `audience`    | **Required.** The audience the token must be addressed to. Should identify **this instance**; enforced for GitHub Actions. |
| `claims`      | **Required.** The claim constraints a token must satisfy. At least one, and specific enough for the issuer's profile.      |
| `user`        | **Required.** The Harper user a matching run authenticates as. Must already exist and be active.                           |
| `operations`  | Narrow the minted token to these operations, 1–100 unique names. Omit for the user's full role — see below.                |
| `enabled`     | Defaults to `true`. A disabled policy is kept but never matched.                                                           |
| `description` | Optional free text, up to 1024 characters.                                                                                 |

##### Setting a policy up from the CLI

Every Operations API operation is available as a CLI command of the same name, which is usually the easiest way to configure a policy: log in once from your machine, then run the operation against the cluster.

```sh
# 1. Authenticate to the cluster you are configuring (once, interactively)
harper login https://my-instance.harperdb.io:9925

# 2. Create the trust policy
harper add_oidc_trust \
  id=my-app-prod \
  issuer=https://token.actions.githubusercontent.com \
  audience=https://my-instance.harperdb.io:9925/ \
  user=ci-deploy \
  claims='{"repository_id":"67890","workflow_ref":"HarperFast/my-app/.github/workflows/deploy.yml@refs/heads/main","environment":"production"}'

# 3. Confirm what the cluster now trusts
harper list_oidc_trust
```

`claims` is a JSON object, so quote it as a single shell argument — the CLI parses each value as JSON, which is what turns that string into the nested object the operation expects. `operations` works the same way if you scope the policy: `operations='["deploy_component","get_job","get_deployment"]'`.

`harper login` stores a token for that target, so step 2 needs no credentials of its own. If you would rather not store one, pass the target and credentials explicitly instead:

```sh
harper add_oidc_trust target=https://my-instance.harperdb.io:9925 auth_username=HDB_ADMIN auth_password="$ADMIN_PASSWORD" id=my-app-prod ...
```

Both routes need **super_user**, since that is what the trust-policy operations require.

This **replaces** the policy rather than merging into it. A partial update is how an over-broad policy gets created by accident, and the point of `claims` is that every constraint in it was written deliberately.

##### Narrowing what the token may do (`operations`)

The user the policy names is the privilege boundary: a matching run gets that user's role. `operations` narrows it further, so one CI user can back several policies that each do less than the role allows:

```json
{
	"operation": "add_oidc_trust",
	"id": "my-app-prod",
	"issuer": "https://token.actions.githubusercontent.com",
	"audience": "https://my-instance.harperdb.io:9925/",
	"user": "ci-deploy",
	"operations": ["deploy_component", "get_job", "get_deployment"],
	"claims": {
		"repository_id": "67890",
		"workflow_ref": "HarperFast/my-app/.github/workflows/deploy.yml@refs/heads/main",
		"environment": "production"
	}
}
```

It is **narrowing only** — never widening. An operation the role forbids stays forbidden, so the scope cannot be used to grant something the user does not already have. Omit `operations` and the token carries the user's full role.

Names are validated when the policy is written, against the same registry `add_role` and `alter_role` use, so a typo is rejected there rather than failing later inside CI with nothing to point at. One consequence: an operation a component registered at runtime with `server.registerOperation` is **not** recognized, because that registry is process-local, so a policy naming one is rejected. It fails closed — a rejected policy, never a widened one — and the same gap applies to `add_role` and `alter_role`.

:::warning
**The scope covers the Operations API and SQL, not the application data path.** It is enforced at the `verifyPerms` / `verifyPermsAST` gate, so a scoped token still carries the role's full table-level CRUD when it reaches an application's REST or GraphQL resources, which authorize through `checkPermission` instead.

So `operations` bounds what a CI credential can _administer_, not what data it can read or write. If that matters, point the policy's `user` at a role that is itself least-privilege for the data the token can reach, rather than relying on the scope alone.
:::

A deploy user does not need `super_user`. A role that lists the operations the pipeline calls is enough:

```json
{
	"operation": "add_role",
	"role": "ci_deploy",
	"permission": {
		"operations": ["deploy_component", "get_job", "get_deployment"]
	}
}
```

`get_job` is what a pipeline polls to wait for a `"restart": "rolling"` deploy to reach every node, and `get_deployment` reads the deployment record. Both have to be listed: an `operations` allowlist, and a policy's `operations` scope, refuse every operation they don't name, including ones like `get_job` that any role may otherwise call. `restart_service` is not needed, since Harper starts the rolling restart's job itself.

Deploying is still administrative authority, since the deployed component runs inside the Harper process. A deploy that passes a literal registry or git `token` in `credentials` needs `super_user` on a node that holds secret custody, because Harper seals that token into the secrets store. Give a least-privilege role a `secret` reference instead.

A scoped token also cannot trade itself for a browser session: `create_authentication_tokens` with `purpose: "login"` is refused, because a session carries no operation scope and would silently restore the user's full role.

`user` is resolved at write time. A policy naming a user that does not exist, or one that is inactive, is rejected — otherwise it would fail only at exchange time, inside CI, with nothing to point at. If the named user is a **super_user**, the policy is still created but the response carries a `warning`: any run matching it gains full administrative access.

**Claim constraints** are exact string matches. A value may be a string, or an array of strings meaning any-of:

```json
{ "claims": { "repository": "HarperFast/my-app", "ref": ["refs/heads/main", "refs/heads/release"] } }
```

A constrained claim that is **absent** from the token fails rather than passes, so a policy cannot be weakened by an issuer that stops emitting a claim.

**An http(s) audience must be the exact string the CI client asks for**, which means an explicit port and a trailing slash — `https://my-instance.example.com:9925/`, not `https://my-instance.example.com`. This is checked for **every** issuer, not only GitHub Actions, and the shorter form is rejected at write time. The audience is matched byte-for-byte at verification, and the CLI requests its token for the normalized target, which supplies `:9925` and the trailing slash — so a policy written without them could never authenticate. An audience that is not an http(s) URL (an `api://` identifier, a bare GUID) is not constrained.

**The audience should identify this instance.** For GitHub Actions, Harper rejects the provider's shared default — anything shaped like `https://github.com/<owner>` — because that value is shared by every repository under the owner, so accepting it would make a token minted by any of them valid here.

That check is a guard against the one known-dangerous value, not a proof of correctness: Harper does not compare the audience against its own identity, so an arbitrary or mistyped value is accepted at write time and instead fails to match at exchange time, when the CLI derives the audience from its target URL. Use the instance URL your CI targets. For an issuer with no registered profile the audience is not checked for _specificity_ — the canonical-form rule above still applies — and the required `sub` pin is what binds the policy to one principal.

##### Policy specificity for GitHub Actions

For `https://token.actions.githubusercontent.com`, a policy must satisfy all three of these, each closing a distinct way a policy can be accidentally broad:

| Requirement            | Satisfied by one of                                                      | Left open otherwise                             |
| ---------------------- | ------------------------------------------------------------------------ | ----------------------------------------------- |
| **Pin the repository** | `repository_id`, `repository`                                            | Any repository                                  |
| **Pin the workflow**   | `workflow_ref`, `workflow_path`, `job_workflow_ref`, `job_workflow_path` | Any workflow in that repository                 |
| **Gate the ref**       | `workflow_ref`, `ref`, `environment`                                     | Any branch that can be pushed to the repository |

The ref gate is the one worth understanding, and it is stricter than npm's model. Pinning repository and workflow without also pinning a ref is not safe: anyone who can push a branch can add the trusted workflow to that branch and mint a token. npm accepts that shape and relies on environment protection instead.

Consequences worth planning around:

- **`repository_id` is preferred over `repository`** because it is immutable — it survives a repository rename, and is immune to org-name recycling.
- **A tag-triggered release cannot pin `workflow_ref`**, since the tag is unknown when the policy is written. Pin `workflow_path` instead — Harper derives it from `workflow_ref` by removing the ref — and gate on `environment`.
- **`ref_type: tag` is deliberately not accepted as a ref gate.** Anyone with push access can create a tag.
- **`sub` is not accepted as a pin.** It varies by trigger, and its format changed for repositories created after 2026-07-15 (immutable subjects embed owner and repository ids), so a policy pinning it would have to handle two shapes indefinitely.
- **`job_workflow_ref` pins the workflow but does not gate the ref.** In a reusable workflow, it names the reusable workflow that ran, not the caller that invoked it, and its `@ref` suffix is that workflow's own branch — constant however it is called. Accepting it as a ref gate would admit any branch of any repository that references the reusable workflow. Pin the workflow with it if you like, then gate the ref with `workflow_ref`, `ref`, or `environment`.
- **`pull_request_target` runs are denied** unless the policy explicitly constrains `event_name`. Such a run executes the base repository's workflow, with its secrets, while a fork controls the checked-out code. A plain `pull_request` run from a fork cannot mint at all, since it gets no `id-token: write`.

##### Other issuers

An issuer with no registered profile gets a strict generic profile: the policy must pin **`sub`**. That is the one claim every OIDC issuer defines as identifying a single principal, and it makes workload identity work with no provider-specific code — a Kubernetes service-account token (`system:serviceaccount:<namespace>:<name>`), a GCP service account, and a SPIFFE SVID all carry a stable canonical subject.

GitHub Actions needs its own profile precisely because its `sub` is the one claim you should _not_ pin.

#### `exchange_oidc_token`

Trades an identity token for a Harper operation token. **Unauthenticated by design** — this operation _is_ the authentication, the way `create_authentication_tokens` is against a password. The CLI calls it for you; you would call it directly only from a client that mints its own requests.

```json
{
	"operation": "exchange_oidc_token",
	"token": "eyJhbGciOi..."
}
```

Response:

```json
{
	"operation_token": "eyJhbGciOi...",
	"expires_in": 3600,
	"username": "ci-deploy",
	"policy": "my-app-prod"
}
```

The operation token is valid for **one hour** — long enough to cover a slow deploy, short enough to bound the exposure if it leaks. That is a reduced window, not safety: within the hour it is a live credential carrying the policy's identity, so treat it like any other secret and keep it out of logs and step outputs. No refresh token is issued; a subsequent run performs a new exchange.

:::note
**Every rejection of a well-formed token returns the same message.** The endpoint is unauthenticated, so a caller told which check failed could enumerate a policy one claim at a time. A malformed request — a missing `token`, or one over 8192 characters — is rejected by schema validation before any of that, with its own message; that reveals nothing about a policy. The specific reason is written to the `oidc-trust` logger, which is where to look when a workflow that should match does not.
:::

**An identity token can be exchanged once.** Harper records a SHA-256 fingerprint of each spent token in `system.hdb_oidc_token_use`, expiring with the token itself, so the table stays proportional to in-flight tokens and never holds a credential. The record is written _before_ the operation token is minted: if minting then fails, the identity token is burned, costing a CI re-run, where the reverse order would leave a spendable token behind.

That replay check is replicated, but replication is asynchronous, so two simultaneous replays against **different nodes** can both succeed. This is not a privilege escalation — whoever holds the token could obtain one operation token regardless — and what it does stop is the realistic case: a token that leaks after a legitimate run and is reused inside its window.

Exchanges are recorded in the authentication audit stream alongside Basic, Bearer, and mTLS events, for failures as well as successes — a run repeatedly failing to authenticate is what an audit trail is for. Enable it with `logging.auditAuthEvents.logSuccessful` and `logging.auditAuthEvents.logFailed`.

#### `list_oidc_trust`

Lists every policy, **including disabled ones**, sorted by `id`. **super_user only** — the policy set names exactly which repository and workflow are worth compromising.

```json
{ "operation": "list_oidc_trust" }
```

Returns `{ "policies": [ ... ] }`. Each entry carries `id`, `issuer`, `audience`, `claims`, `user`, `operations` (`null` when unscoped), `enabled`, `description`, `updated_by`, and timestamps.

An entry may also carry **`invalid_reason`** — set when the policy cannot currently authenticate anyone, because it is malformed or because the user it names was deleted or deactivated after the policy was written. Check for it first when diagnosing a rejected exchange: the exchange will not say what failed, so a policy you expected to match that carries an `invalid_reason` is the fastest explanation available.

#### `drop_oidc_trust`

Stops every workflow that matched the policy from exchanging again. **super_user only.** Fails with `404` if no policy has that `id`.

```json
{ "operation": "drop_oidc_trust", "id": "my-app-prod" }
```

:::caution
**This does not revoke operation tokens already issued.** The minted token is a stateless JWT valid until its one-hour expiry, so a token obtained moments before the policy was dropped keeps authorizing for the rest of that hour.

Dropping the policy is therefore containment against _future_ runs. If you are responding to a suspected compromise rather than doing routine cleanup, also deactivate or re-role the user the policy named (`alter_user`), which is what stops a token that is already in someone's hands.
:::

---

## Components

Operations for deploying and managing Harper components (applications, plugins).

Detailed documentation: [Components Overview](../components/overview.md)

| Operation                   | Description                                                             | Role Required |
| --------------------------- | ----------------------------------------------------------------------- | ------------- |
| `add_component`             | Creates a new component project from a template                         | super_user    |
| `deploy_component`          | Deploys a component via payload (tar) or package reference (NPM/GitHub) | super_user    |
| `package_component`         | Packages a component project into a base64-encoded tar                  | super_user    |
| `drop_component`            | Deletes a component or a file within a component                        | super_user    |
| `get_components`            | Lists all component files and config                                    | super_user    |
| `get_component_file`        | Returns the contents of a file within a component                       | super_user    |
| `set_component_file`        | Creates or updates a file within a component                            | super_user    |
| `list_deployments`          | Lists deployment records with optional filters                          | super_user    |
| `get_deployment`            | Fetches a single deployment record by ID; supports SSE streaming        | super_user    |
| `get_deployment_payload`    | Returns the tarball stored for a deployment                             | super_user    |
| `delete_deployment_payload` | Removes the stored tarball to free space                                | super_user    |
| `add_ssh_key`               | Adds an SSH key for deploying from private repositories                 | super_user    |
| `update_ssh_key`            | Updates an existing SSH key                                             | super_user    |
| `delete_ssh_key`            | Deletes an SSH key                                                      | super_user    |
| `list_ssh_keys`             | Lists all configured SSH key names                                      | super_user    |
| `set_ssh_known_hosts`       | Overwrites the SSH known_hosts file                                     | super_user    |
| `get_ssh_known_hosts`       | Returns the contents of the SSH known_hosts file                        | super_user    |
| `install_node_modules`      | _(Deprecated)_ Run npm install on component projects                    | super_user    |

A role that is not `super_user` can be granted these operations by listing them in its [`operations` allowlist](../users-and-roles/overview.md#operation-permissions), which is how a deploy-only CI role gets `deploy_component` and `get_deployment`. A few cannot be granted that way, such as `get_deployment_payload`; that section lists them.

### `deploy_component`

Deploys a component. The `package` option accepts any valid NPM reference including GitHub repos (`HarperDB/app#semver:v1.0.0`), tarballs, or NPM packages. The `payload` option accepts a base64-encoded tar string from `package_component`. Supports `"restart": true` or `"restart": "rolling"`. On Harper Pro and Fabric, a deploy goes to every node in the cluster unless you pass `"replicated": false`; Harper core on its own does not replicate.

Additional parameters:

- `urlPath` — the HTTP URL path the component is mounted at (e.g. `"/api/v2"`). Must not contain `..` or `.` path segments. Persisted on the component's root-config entry; see [HTTP middleware routing](../http/overview.md#middleware-routing).
- `host` <VersionBadge version="v5.2.0" /> — the virtual hostname the component is served on (e.g. `"api.example.com"`). Must be a bare hostname or IPv6 literal — no scheme, port, path, or brackets. Persisted alongside `urlPath`.
- `install_allow_scripts` — set to `true` to allow npm pre/post install scripts (disabled by default)
- `credentials` — credentials for installing a component from a private npm registry or private git repository (see below)
- `deployment_timeout` <VersionBadge version="v5.1.4" /> — how long, in milliseconds, a peer waits to receive the replicated deployment payload before failing (default: `120000`)
- `ignore_replication_errors` <VersionBadge version="v5.1.4" /> — set to `true` to treat a peer that fails to receive the deploy as non-fatal instead of failing the whole operation. By default a failed peer causes `deploy_component` to return a non-2xx status; the component is still deployed (and, if requested, restarted) on the origin node.
- `activate` <VersionBadge version="v5.3.0" /> — set to `false` to build and install the component without making it live. See [Staging a build and activating it later](#staging-a-build-and-activating-it-later).
- `deployment_id` <VersionBadge version="v5.3.0" /> — make a staged build live, or return to a release a later deploy replaced. Takes no build inputs of its own. See [Going back to a previous release](#going-back-to-a-previous-release).

`urlPath` and `host` both require `package` and are rejected on a payload-only deploy. To mount a payload-deployed component, add `host`/`urlPath` to its entry in the root `harper-config.yaml` instead.

:::warning
Only a deploy that restarts workers can be checked before it serves. On a node running v5.4.0 or later, `"restart": true` or `"restart": "rolling"` [certifies the release in a canary worker](#certifying-a-release-in-a-canary-worker) first, unless the response's `certification` is `uncertified` or `unavailable`, which say why it went out unchecked. A release that fails to load is rejected. The release it replaced is put back, or, if there is none, the component is failed closed on that node. A deploy without `restart` is not test-loaded: a release that installs but throws when it loads is deployed, and it reports the failure in the `componentStatus` of [`get_status`](#set_status--get_status--clear_status) once workers load it. The rest of the instance keeps serving.
:::

#### How a deploy updates the root config

<VersionBadge type="changed" version="v5.3.0" />

A deploy changes the component's entry in the root `harper-config.yaml` only once the new release is live on that node. A deploy that fails to install or validate leaves the entry exactly as it was, so a restart does not install a release that never went live. If Harper stops partway through the swap, startup settles it before it installs anything from the root config: either the previous release stays live with its entry, or the new release goes live with its entry, including whether the component runs isolated.

- **A `package` deploy replaces the entry.** The new entry is built from the request: `package`, `install`, `credentials`, `urlPath`, `host`, `branchedDatabases`, and `isolated`.
- **A `payload` deploy removes `package`, `install`, and `credentials`.** Everything else in the entry is kept, such as `host`, `urlPath`, `isolated`, and `branchedDatabases`, and an entry left with no keys is removed. A `package` key left in place would make a node installing from the root config resolve the old package instead of the payload release that is live.
- **`drop_component` removes the entry.**

These writes are serialized with each other and with `set_configuration`, so concurrent deploys, drops, and configuration changes do not overwrite one another.

A deploy that has to change the entry is refused before anything changes if the root config does not parse, or if Harper cannot write to the directory that holds it. A deploy that leaves the entry as it is, such as a `payload` deploy of a component that has no entry, does not need the root config to be writable.

#### Staging a build and activating it later

<VersionBadge version="v5.3.0" />

A deploy normally builds the new version and swaps it in as one operation. `activate: false` stops after the build, so the work that takes time and can fail — fetching, resolving, installing dependencies — happens when you choose, and the cut-over itself is two directory renames you can run in a maintenance window.

Every `deploy_component` response carries a `deployment_id`, staged or not, so a build you deploy today can be named later.

```json
{
	"operation": "deploy_component",
	"project": "my-app",
	"package": "npm:@my-org/my-app@1.2.3",
	"activate": false
}
```

The response names the artifact that is now waiting:

```json
{
	"deployment_id": "a3f8c2d1-...",
	"message": "Staged: my-app. Deploy it with deploy_component deployment_id=a3f8c2d1-..."
}
```

Nothing about the running component changes: the live directory, the root config entry, and the restart-required flag are all untouched, and `get_deployment` reports the deployment as `staged`. Make it live with that id:

```json
{
	"operation": "deploy_component",
	"project": "my-app",
	"deployment_id": "a3f8c2d1-..."
}
```

That request takes no `package`, `payload`, `credentials`, install options, or `urlPath`/`host` — they are rejected rather than ignored, because the staged build already decided them and re-supplying one here would have no effect. It resolves and installs nothing; it swaps in the exact bytes that were verified at staging time, including across a full Harper restart in between.

A few things worth knowing before you rely on it:

- **Activating the release that is already live succeeds and changes nothing.** A retry is therefore safe: see [Retrying an activation](#retrying-an-activation).
- **A staged build outlives later deploys.** Stage v2, deploy v3, and activating v2's id later returns the component to v2.
- **Builds that are not live are bounded.** [`deployment.stagingRetention.maxCount`](../configuration/options.md#deployment) caps how many a component keeps — staged builds and [replaced releases](#going-back-to-a-previous-release) together (default `5`). The oldest are removed at the start of that component's next deploy and at startup. A build pruned before you activate it has to be staged again.
- **A deployment id names one release on a node for as long as the node holds it** — waiting, live, or kept after a later deploy replaced it. Staging again with the same id is rejected rather than rebuilding over it.
- **`file:` directory sources cannot be staged.** A local-directory package is linked rather than copied, so the bytes could change between staging and activation. Deploy those normally.
- **`restart` belongs on the activation, not the stage.** A stage changes nothing that is running, so `restart` is rejected alongside `activate: false`; pass it with `deployment_id` to restart as the new version goes live.
- **Reclaiming the payload does not disable the artifact.** [`delete_deployment_payload`](#delete_deployment_payload) on a staged deployment frees the stored tarball; the build is already installed on disk, so its id still activates.

A refused activation says which kind of refusal it is: `404` when nothing on that node answers to the id — it never existed there, it was pruned, or its release was replaced and not kept — and `409` when the build is there but cannot be activated, such as one belonging to another component or one whose files changed after it was staged.

:::warning
**Upgrade every node before staging.** A stage is replicated like any other deploy. A node still running a version before v5.3.0 does not recognize `activate: false`. It performs an ordinary deploy and serves the release immediately.

The origin cannot detect this in advance, so it checks afterward. Any peer that does not confirm staging fails the operation with the node names. Check those nodes before activating. Pass `ignore_replication_errors: true` only if you have accepted that difference.
:::

#### Going back to a previous release

<VersionBadge version="v5.3.0" />

When a deploy replaces the release that is live, Harper keeps the replaced one under the `deployment_id` that deployed it. Activating that id puts it back, with no rebuild, resolve, or install:

```json
{
	"operation": "deploy_component",
	"project": "my-app",
	"deployment_id": "<id of the deployment you want back>",
	"restart": true
}
```

[`list_deployments`](#list_deployments) shows each deployment's id. The activation publishes the root config entry published by that deployment, so a `package` release gets its `package` entry back and a `payload` release removes the one a later deploy added. The release it replaces is kept in turn, so you can go forward again the same way.

- **Kept releases count against [`deployment.stagingRetention.maxCount`](../configuration/options.md#deployment)**, with staged builds. The most recently replaced ones are kept.
- **Each kept release is a full installed copy of the component, `node_modules` included.** At the default of `5`, budget disk for up to five extra copies per component. `0` keeps no replaced release.
- **A release is kept as it was when it was replaced**, including anything it wrote into its own directory while it was live.
- **Not every release can be kept.** A release made live before v5.3.0, or deployed from a `file:` directory, is not kept. A release whose dependency links use absolute paths is kept but refused (`409`) when you try to activate it; on Windows, npm writes such links for `file:` and workspace dependencies.
- **Each node answers for itself.** A node that never had the release, or no longer keeps it, answers `404`. `deploy_component` reports that as a failed peer.

#### Retrying an activation

<VersionBadge version="v5.3.0" />

An activation of the id that is already live on a node succeeds there without a swap. If an activation fails partway — a peer was unreachable, or the component went live on the origin but its root config entry could not be written — retry the same `deployment_id`. During the retry:

- A node that already switched answers success.
- A node still holding the build switches now.
- A node that holds neither answers `404`.

The retry also finishes anything the failed attempt left half done on that node, such as writing the root config entry. A node that answers "already live" still restarts if you pass `restart` — every worker, including those of isolated applications, since it cannot tell which ones loaded the previous release. Without `restart`, it marks the component as needing a restart, because it cannot tell whether every worker has loaded that release.

A plain deploy (without `activate: false`) that went live only on the origin leaves the peers nothing to activate. Their retry answers `404`, so deploy the release again instead.

#### Deploy credentials (`credentials`)

When a component is installed from a private source, `credentials` supplies the authentication. It is an array of entries; each entry is one of two kinds, identified by its key:

- **npm registry auth** — an entry with a `registry` key, applied to a private npm registry.
- **git host auth** — an entry with a `host` key, applied to a private git repository fetched by reference (e.g. `package: "github:my-org/my-app#semver:v1.2.3"`).

An entry provides its credential exactly one of two ways — a literal `token`, or a `secret` reference:

| Field      | Kind | Description                                                                                                         |
| ---------- | ---- | ------------------------------------------------------------------------------------------------------------------- |
| `registry` | npm  | The registry URL or host the credential applies to. **Required** for an npm entry.                                  |
| `scope`    | npm  | Optional npm `@scope` (e.g. `"@my-org"`) the entry applies to; omit to set the default registry.                    |
| `host`     | git  | The bare git host the credential applies to (e.g. `"github.com"`). **Required** for a git entry.                    |
| `username` | git  | Optional git HTTPS username. Defaults to `x-access-token` (GitHub); GitLab uses `oauth2`, Bitbucket `x-token-auth`. |
| `token`    | both | A literal auth token, **or**                                                                                        |
| `secret`   | both | The name of an [`hdb_secret`](../security/secrets.md) row to resolve the token from.                                |

A provided **`token`** is not treated as ephemeral: Harper ingests it into the encrypted [secrets store](../security/secrets.md) and references it everywhere, so package-reference deploys keep working through rollback, reboot, and new peers joining — without re-supplying the token. The token is encrypted at rest, stripped from the operation before replication and from the operations log, and only ever crosses the cluster as ciphertext. A git-host token is additionally served to git **from memory** (via a credential helper) — it is never written to a file or into a URL. Using a **`secret`** reference names an existing store row directly. Ingesting a token requires custody on the deploying node; on OSS core without custody, a literal token falls back to a transient, this-node-only credential (not persisted or replicated).

Ingested tokens are stored under a derived name granted to the component — `deploy.<component>.<registry>` for a registry entry, `deploy.<component>.git.<host>` for a git entry — so re-deploying with a rotated token idempotently updates the same row.

Private npm registry:

```json
{
	"operation": "deploy_component",
	"project": "my-app",
	"package": "npm:@my-org/my-app@1.2.3",
	"credentials": [{ "registry": "https://registry.my-org.com", "scope": "@my-org", "token": "npm_..." }]
}
```

Private git repository (token resolved from an existing secret):

```json
{
	"operation": "deploy_component",
	"project": "my-app",
	"package": "github:my-org/my-app#semver:v1.2.3",
	"credentials": [{ "host": "github.com", "secret": "deploy.my-app.git.github.com" }]
}
```

:::note
`credentials` replaces the earlier `registryAuth` field (renamed while the feature was in alpha, before it grew to carry git-host credentials). `registryAuth` is now rejected with an error directing you to `credentials`.
:::

The response includes a `deployment_id` that can be used to query the deployment record:

```json
{
	"operation": "deploy_component",
	"project": "my-app",
	"package": "my-org/my-app#semver:v1.2.3",
	"replicated": true,
	"restart": "rolling"
}
```

Response:

```json
{
	"deployment_id": "a3f8c2d1...",
	"restartJobId": "b7d41e09...",
	"certification": "certified",
	"message": "Successfully deployed: my-app, activating it on each other node in turn"
}
```

`restartJobId` is present only for `"restart": "rolling"`, which is the one path that hands the restart to a separate job. An inline `"restart": true` returns `Successfully deployed: my-app, restarting Harper` without it, and a deploy that does not restart returns `Successfully deployed: my-app`. `certification` says whether the release was [certified in a canary worker](#certifying-a-release-in-a-canary-worker).

#### Restarting (`restart`)

<VersionBadge type="changed" version="v5.3.0" />

`"restart": true` restarts this node's HTTP worker threads and waits for that restart to finish before responding, so a successful response means every worker thread is serving the newly deployed code. Until a worker has been replaced it is still running the previous code, and on platforms where replacements share a listening port it keeps accepting connections for the whole rolling restart — before this, a client that treated the immediate response as "the component is live" could be served by a worker that had never loaded it.

The wait follows the restart's own progress rather than a fixed timeout, so a wide thread pool, a slow component install, or a worker draining in-flight work does not cut it short. That also means the response can take as long as the install plus the restart — tens of seconds on a slow install with many worker threads — so a caller with a short request timeout should use `"restart": "rolling"` and poll its job instead. If it does give up — the restart stopped reporting progress, ran past the wait's absolute ceiling, or left a worker thread that could not be replaced — the restart continues in the background and the Harper log says which of those happened. A restart that fails does not fail the deploy: the component is already installed and replicated.

`"restart": "rolling"` does not restart the other nodes inline: it starts a `restart_service` job and returns its `restartJobId` to poll. Both certify the release in a canary worker before rolling it out; see the next section.

`drop_component` accepts `"restart": true` and waits for the restart the same way (v5.3.0).

#### Certifying a release in a canary worker

<VersionBadge version="v5.4.0" />

A deploy with `"restart": true` or `"restart": "rolling"` checks its release before rolling it out. The first worker thread started on the new release, the canary, loads every component as any worker does when it starts, but it is held out of traffic until it reports whether the deployed component loaded. It replaces the first worker thread (worker 0), so code a component runs only in that thread is part of what it checks. Until then the workers already running keep serving the release being replaced. The rollout goes on only if the release loaded, and each later replacement is checked the same way before it serves.

A deploy that succeeds, and is not staged, reports how this went as a string in `certification`:

| `certification` | Meaning                                                                                                                                                                                                                                                  |
| --------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `certified`     | The canary loaded the release, and the rollout went on.                                                                                                                                                                                                  |
| `uncertified`   | The rollout went on unchecked: the component ran nothing as it loaded (`loadComponent: dev-only`, an absent `if-installed` component, or safe mode), or no worker was replaced.                                                                          |
| `unavailable`   | The deploy restarted unchecked: no worker on this node loads the component, its `isolated` setting changed with this deploy, it was already live, or it was deployed from a local directory (`package: file:<dir>`), which is linked rather than copied. |
| `not-requested` | The deploy did not restart.                                                                                                                                                                                                                              |

A release whose canary throws while loading the component, exits, or does not report within a minute is rejected, and the deploy fails with `400`. The release the deploy replaced, when there is one, is made live again first, as in [going back to a previous release](#going-back-to-a-previous-release), so the workers that never stopped serving it continue to do so. Nothing is replicated to other nodes. The error carries the decision as an object in `certification` instead of a string, with `status` set to `rejected`, or to `interrupted` for a restart that stopped before the canary decided:

```json
{
	"error": "my-app was not deployed: release 9b2e... failed to load in its canary worker: my-app.jsResource: ... Deployment a3f8c2d1..., the release it replaced, is live again. No other node received it. Deploy a fix, or activate deployment 9b2e... again once the cause is fixed.",
	"deployment_id": "9b2e...",
	"certification": {
		"status": "rejected",
		"reason": "my-app.jsResource: ...",
		"failures": [{ "key": "my-app.jsResource", "name": "ResourceLoadError", "message": "...", "stack": "..." }],
		"restored": "a3f8c2d1...",
		"failed_closed": false
	}
}
```

- **A release with nothing to go back to fails closed.** A rejected first deploy, or one whose previous release was not kept, stays on disk, but no worker on that node loads it, including after Harper restarts. `get_status` reports the component as failed and says why. Deploy a fixed release, or once the cause is fixed, activate the same `deployment_id` again with `restart`, which certifies it again.
- **Nothing else changes the component while its release rolls out.** Another deploy or a `drop_component` of it on that node is refused with `409` until the canary has decided and the rollout that follows has finished.
- **A restart that stops before the canary decides restores the previous release.** The decision is reported with `status: "interrupted"`. If the process dies first, the next start rejects the undecided release and restores the one it replaced before it loads anything.
- **It checks what a worker loads when it starts.** The release is on disk before the canary starts. Workers that have not been replaced yet keep running the previous release and do not react to the new files until the rollout ends, but one that first imports one of the component's modules while the canary is held gets the new release's copy of it.

With `"restart": "rolling"`, the node that received the deploy certifies the release itself, the other nodes only stage it, and the job then activates it on each of them in turn with `deployment_id` and `"restart": true`, so every node certifies it with a canary of its own. Each node decides for itself. A node whose canary rejects the release keeps the previous one, or fails closed if it had none. Nothing is rolled back on the others, and the job fails naming each node that did not activate it. The deploy responds once it has started the job, and the record [`get_deployment`](#get_deployment) returns is written only by the node that received the deploy, so it reports `success` while the job is still running and after the job fails. Poll the job's `restartJobId` with [`get_job`](#get_job) to learn whether every node took the release: it ends `COMPLETE`, or `ERROR` with a `message` listing each node's outcome under `activated`. A node running a version before v5.4.0 activates the release without a canary.

#### Deploying without a restart

<VersionBadge version="v5.2.0" />

A deploy that does not restart (`"restart": false`, or omitting `restart`) flags a restart as needed when it changed something the running process cannot pick up on its own. `get_status`, called with no `id`, then reports `restartRequired: true`.

Two kinds of deploy set it:

- A component that had no directory before this deploy. It has never been loaded, so its routes cannot be live until Harper restarts.
- A redeploy whose package metadata changed (v5.2.1) — a dependency or module-entry change invalidates loaded code, and package metadata sits outside most plugin file globs, so the component's own watcher does not see it.

An ordinary redeploy sets nothing: the component's watched files are handled by its file watcher, which requests a restart only when the update needs one.

The flag is evaluated per node. A peer applying the replicated deploy checks its own directory state, since whether the component was already active can differ from node to node.

Until the restart happens, a request to a route of a never-loaded component returns a 404 naming the component and saying a restart may be needed, instead of the generic 404. That fuller message is returned only to an authenticated `super_user`. The difference between the two responses would otherwise report which component directories exist on disk.

#### Checking what each node installed

<VersionBadge version="v5.3.1" />

Each node of a replicated deploy resolves and installs the release itself. So a mutable reference can resolve differently between nodes' installs and leave them running different code: a branch or tag that was updated, a `latest` version published in between, or a dependency range that resolved to a newer version. Harper doesn't prevent this, but it reports it.

A deploy or a stage records an install fingerprint on each node after it installs. An activation by `deployment_id` installs nothing, so it records none: its response has no `install`, its deployment record has no `install_fingerprint`, and its `peer_results` carry no comparison fields. The fingerprint has two parts:

- `source`: what the package resolved to, named the way its resolver already names it. That is `git:<commit>` for a git reference, the commit a branch or tag pointed at; `npm:<name>@<version>` for a registry package, where a tag resolves to one version; or npm's `integrity:<sri>` for a tarball URL, or for a git reference npm packed itself because `install_allow_scripts` is set. A source that can't be identified is `unidentified`. A `payload` deploy has no `source`, because every node extracts the same uploaded bytes. A local `file:` path, a directory or a tarball, is `unidentified`, because each node reads its own copy, so a peer on one compares as unknown rather than matching.
- `lockfiles`: the SHA-256 of each lockfile at the component's root (`package-lock.json`, `npm-shrinkwrap.json`, `pnpm-lock.yaml`, `yarn.lock`, `bun.lock` or `bun.lockb`), keyed by file name. A lockfile that exists but can't be read is recorded as an object naming the error instead, such as `{"unreadable": "EISDIR"}`, which leaves the comparison unknown unless another field differs.

Every node that recorded a fingerprint returns it as `install` in its `deploy_component` response. The node that received the deploy compares each peer's fingerprint with its own, and when any differ:

- the response's `message` ends with a sentence naming them, such as `Install fingerprints differ from this node's on 1 of 2 peer node(s): node-b (source npm:web@1.5.0, package-lock.json).`;
- a `warning` event goes to a caller [streaming Server-Sent Events](#streaming-deploy-progress), and the Harper CLI prints it on a directory deploy;
- each peer's entry in the deployment's `peer_results` carries `install`, the peer's fingerprint; `install_matches`; and `install_differs`, the list of fields that differ. `install_matches` is `false` when anything compared differs. Otherwise it is `null` when a fingerprint is missing or unreadable, or a source could not be identified (as from a peer on an earlier version), and `true` only when everything compared matches.

A difference never fails the deploy or changes the CLI's exit status. A match means the evidence is equal, not that the installed trees are: an `install_command` can install different dependencies and leave the same lockfile, and lockfiles written against different registry mirrors differ even when the code matches. A staged deploy reports at stage time, before you activate it.

#### Streaming deploy progress

<VersionBadge version="v5.1.0" />

A `deploy_component` request that accepts `text/event-stream` gets its progress as Server-Sent Events, ending in the result, instead of one JSON response. Once the stream starts the HTTP status is `200`, so a failure arrives in-band as an `error` event. The Harper CLI requests it for every deploy, except to a target older than v5.1.0.

| Event             | Data                                                                                                                                                                                                                                            |
| ----------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `phase`           | `{ phase, status }`. `phase` is `prepare`, `load`, `replicate`, or `restart`, each sent with `status` `start` and then `done`. A deploy that succeeds ends with `{ "phase": "success", "status": "done" }`, or `"staged"` for `activate: false` |
| `install`         | `{ manager, stream, line }`: one line of the package manager's output, and whether it came from `stdout` or `stderr`                                                                                                                            |
| `peer`            | One peer's outcome as it arrives, in the shape of an entry in the record's `peer_results`                                                                                                                                                       |
| `warning`         | `{ message }`, such as [install fingerprints that differ](#checking-what-each-node-installed)                                                                                                                                                   |
| `payload_dropped` | `{ payload_size, max_size }`: payload retention dropped the stored tarball, because it is larger than `max_size`                                                                                                                                |
| `error`           | `{ message, code, phase }`, plus `deployment_id`, and when they apply `install_output`, `failed_peers`, and `certification`. The stream ends after it                                                                                           |
| `done`            | `{ result }`: the response the deploy would have returned as JSON. The stream ends after it                                                                                                                                                     |

From v5.4.0, the `load` phase brackets the [canary's decision](#certifying-a-release-in-a-canary-worker), so a deploy that does not restart, or whose `certification` is `unavailable`, sends no `load` phase. Before v5.4.0, every deploy sends one.

Every event but `done` is also appended to the deployment's `event_log`, which [`get_deployment`](#get_deployment) replays as a stream. A replayed log can also contain `truncated`, `{ dropped_events }`, where the log reached its 200-entry bound and dropped entries from its middle, keeping the start and the most recent, and a `payload_dropped` carrying `deleted_by` instead of `max_size` when [`delete_deployment_payload`](#delete_deployment_payload) reclaimed the tarball.

### Deployment Operations

Harper records every `deploy_component` call in the `system.hdb_deployment` table, capturing the full lifecycle of a deployment including phase transitions (prepare → load → replicate → restart → success/failed), per-node outcomes, and a bounded event log of install output.

The record is written by the node that received the deploy, and describes that deploy, not what each node is running now. With `"restart": "rolling"` on v5.4.0 and later, it can report `success` once that node has taken the release, before the other nodes have, and keeps reporting it if one of them [rejects the release](#certifying-a-release-in-a-canary-worker). To learn whether every node took it, wait for the deploy's `restartJobId` with [`get_job`](#get_job).

### `list_deployments`

Returns a list of deployment records, newest first. All filter parameters are optional.

| Parameter | Type   | Description                                                                  |
| --------- | ------ | ---------------------------------------------------------------------------- |
| `project` | string | Filter to a specific component project                                       |
| `status`  | string | Filter by one status. See `status` under [`get_deployment`](#get_deployment) |
| `since`   | number | Start of time range (Unix timestamp ms)                                      |
| `until`   | number | End of time range (Unix timestamp ms)                                        |
| `limit`   | number | Maximum number of results. Omit to return every matching record              |
| `offset`  | number | Pagination offset                                                            |

```json
{
	"operation": "list_deployments",
	"project": "my-app",
	"status": "success",
	"limit": 20
}
```

Response includes a `deployments` array and a `total` count. The `payload_blob` field is stripped from list responses for size, and replaced by `payload_blob_present`; use `get_deployment_payload` to retrieve the tarball.

A deploy in progress reads `pending`, or `loading` once its release has started loading, so filtering on `pending` alone misses some deploys in flight. List without `status` and check each record's `completed_at` instead, which is set once the deploy finishes.

The list is the history of deploys as each receiving node recorded them, newest first. It answers what was deployed and when, but the newest `success` for a project is not necessarily the release every node is serving: a rolling deploy's record can say `success` before the other nodes have taken the release, and keeps saying it if one rejects it.

### `get_deployment`

Returns a single deployment record by `deployment_id`. A request that accepts `text/event-stream` gets the record's event log replayed as [Server-Sent Events](#streaming-deploy-progress), followed by a `done` event carrying the record.

The replay is followed by a live tail only when the deploy is still running in the same Harper thread that answers the request. Any other request — one answered by another node, as a load balancer may route it, or by another thread on the same node — replays the log and returns at once, with whatever status the record has then, which may not be terminal. Poll until `completed_at` is set if you need the outcome.

```json
{
	"operation": "get_deployment",
	"deployment_id": "a3f8c2d1..."
}
```

The deployment record includes:

| Field                  | Description                                                                                                                                                                                                                                                                                                       |
| ---------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `deployment_id`        | Unique identifier, a random UUID assigned to each deploy. `payload_hash` is the content hash                                                                                                                                                                                                                      |
| `project`              | Component project name                                                                                                                                                                                                                                                                                            |
| `package_identifier`   | Package reference or `payload` for tar uploads                                                                                                                                                                                                                                                                    |
| `status`               | In progress: `pending`, or `loading` once the release has started loading. The record is not rewritten during the replicate and restart phases, so it keeps that status until the deploy finishes. Finished: `success`, `failed`, or `staged` (v5.3.0). A stage whose peers fail stays `staged`, with `error` set |
| `phase`                | The last lifecycle phase reached: `pending` before the first, then `prepare`, `load`, `replicate`, `restart`, and finally `success` or `staged`; a failed deploy keeps the phase it failed in                                                                                                                     |
| `event_log`            | Bounded log of install output and phase transitions (up to 200 entries)                                                                                                                                                                                                                                           |
| `peer_results`         | Per-node outcomes for replicated deployments, one entry per peer; from v5.3.1, on a deploy or a stage, each peer also carries `install`, `install_matches` and `install_differs` (see [Checking what each node installed](#checking-what-each-node-installed))                                                    |
| `payload_hash`         | SHA-256 hash of the deployment tarball                                                                                                                                                                                                                                                                            |
| `payload_size`         | Byte size of the deployment tarball                                                                                                                                                                                                                                                                               |
| `payload_blob_present` | Whether the tarball is still stored. `false` once payload retention or `delete_deployment_payload` has reclaimed it                                                                                                                                                                                               |
| `install_fingerprint`  | (v5.3.1) On a deploy or a stage, this node's install fingerprint: its `source` and `lockfiles`                                                                                                                                                                                                                    |
| `started_at`           | Timestamp when deployment began                                                                                                                                                                                                                                                                                   |
| `completed_at`         | Timestamp when deployment finished                                                                                                                                                                                                                                                                                |
| `user`                 | User who initiated the deployment                                                                                                                                                                                                                                                                                 |
| `origin_node`          | Host name of the node that received the deploy and wrote this record                                                                                                                                                                                                                                              |
| `restart_mode`         | `immediate` for `"restart": true`, `rolling` for `"restart": "rolling"`, or `null` for a deploy that did not restart                                                                                                                                                                                              |
| `credentials`          | The deploy's `credentials`, in reference form (`secret` names, never a token), or `null`                                                                                                                                                                                                                          |
| `activated_from`       | (v5.3.0) On an activation, the id of the deployment it made live: a staged build, or a release a later deploy replaced. [Going back to a previous release](#going-back-to-a-previous-release) writes a new `success` record with this set                                                                         |
| `error`                | For a deploy that failed, or a stage whose peers failed: an object with `message`, `code`, and `phase`, the phase it failed in                                                                                                                                                                                    |

### `get_deployment_payload`

Returns the raw tarball for a deployment. Useful for inspecting or re-deploying a specific version.

```json
{
	"operation": "get_deployment_payload",
	"deployment_id": "a3f8c2d1..."
}
```

The response is the raw tarball bytes (`Content-Type: application/octet-stream`, with a `Content-Disposition` download filename) - not JSON and not base64-encoded, so payloads of any size stream without inflation. Returns `404` if the deployment does not exist or its payload has already been reclaimed (by payload retention or `delete_deployment_payload`).

Unlike most other `super_user` operations, this check is enforced directly in the handler and cannot be satisfied by granting the operation through a role's `operations` allowlist - only an actual `super_user` role can call it.

### `delete_deployment_payload`

Removes the tarball blob from a deployment record. The deployment record itself is retained; only the binary payload is deleted. Use this to reclaim storage after confirming a deployment is stable. The deletion replicates, so one call frees the payload's storage on every node in the cluster.

```json
{
	"operation": "delete_deployment_payload",
	"deployment_id": "a3f8c2d1..."
}
```

Response:

```json
{
	"message": "Deleted payload for deployment 'a3f8c2d1...'",
	"deployment_id": "a3f8c2d1...",
	"freed_bytes": 52428800
}
```

The deployment must be in a terminal status (`success`, `failed`, or `staged`); deleting the payload of an in-progress deployment fails with `409`, since its payload may still be replicating to peers. Deleting an already-reclaimed payload succeeds with `freed_bytes: 0` (the operation is idempotent). A `payload_dropped` entry recording the deleting user is appended to the deployment's `event_log`.

### `add_ssh_key`

Adds an SSH key for authenticating deployments from private repositories. Supply the private key with `key`, or omit it and pass `generate: true` to have Harper mint the keypair itself.

`list_ssh_keys` and the logs never return key material.

The stored private key is encrypted at rest and crosses the cluster as ciphertext **when secret custody is configured**. Custody is present by default — the file tier generates a cluster keypair on first boot — so this is the normal case.

:::warning
On a node with **no** secret custody registered, `add_ssh_key` stores and replicates the private key in **plaintext**. It logs a WARN saying so and the operation still succeeds, because SSH keys predate custody and must keep working on a node that has none.

That means encryption at rest is a property of your configuration, not a guarantee of the operation. If you are relying on it — and `generate: true` in particular reads as though the key can never be exposed — verify `secretCustody` is configured on every node in the cluster, and check the logs for that warning after adding a key. See [Secrets](../security/secrets.md).
:::

Adding an existing key:

```json
{
	"operation": "add_ssh_key",
	"name": "my-key",
	"key": "-----BEGIN OPENSSH PRIVATE KEY-----\n...\n-----END OPENSSH PRIVATE KEY-----\n",
	"host": "my-key.github.com",
	"hostname": "github.com"
}
```

#### What `key`, `host` and `hostname` must be

<VersionBadge type="changed" version="v5.3.0" />

A key ssh can't use would otherwise go unnoticed until ssh loads it for a git deploy, where it fails as a generic authentication error. So `add_ssh_key` and `update_ssh_key` check a supplied key first, and refuse one ssh couldn't use with a `400` that names the problem.

`key` must be an unencrypted **Ed25519**, **ECDSA** (P-256, P-384 or P-521) or **RSA** (at least 1024 bits) private key, in one of the formats ssh reads:

- **OpenSSH** (`-----BEGIN OPENSSH PRIVATE KEY-----`, what `ssh-keygen` writes by default), with nothing before the `BEGIN` line
- **PEM**: PKCS#1 (`RSA PRIVATE KEY`), SEC1 (`EC PRIVATE KEY`) or PKCS#8 (`PRIVATE KEY`)

These are refused:

- a public key — the `.pub` file, or a public key exported as PEM or RFC 4716 — in place of the private one
- a PuTTY key (`.ppk`); export it from PuTTYgen with **Conversions → Export OpenSSH key**
- a passphrase-protected key: Harper runs git without a terminal, so ssh has nowhere to ask for the passphrase
- a DSA key, which OpenSSH 10 no longer supports
- a FIDO security key (`sk-ssh-ed25519@openssh.com`, `sk-ecdsa-sha2-nistp256@openssh.com`), which signs only with its hardware authenticator attached
- any other algorithm or curve ssh doesn't support, or an SSH certificate in place of a plain key
- a key that is cut off, has lines missing or repeated, or is otherwise damaged — including one whose private half doesn't match its public half, which ssh may load but can never authenticate with

Harper stores the key the way ssh needs it: each line trimmed, blank lines dropped, and a final newline added. An indented or CRLF paste therefore works. A value already sealed as `enc:v1:` for this cluster (for example one copied from another node's `get_ssh_key` in the same cluster) is stored as-is, since checking it would mean decrypting it. It must still be a well-formed envelope, and a node with secret custody refuses one sealed for another cluster's key.

`host` and `hostname` are written into the ssh config that every key on the node shares, so a value that would break it is refused: any whitespace or control character, such as a space, tab or line break (`Host my key` matches two aliases, and `HostName my key` stops ssh for every key), a quote, an `=`, or a leading `#`. A leading `-` or any backslash is refused too, since no real host has either, and so is a pattern (`*`, `?`, `!`) in `host`, whose block would also apply to other keys' aliases. In `hostname`, a `%` must be `%h` (replaced by the alias) or `%%` (a literal `%`), the only expansions ssh makes there, so an IPv6 zone needs the doubled form: `fe80::1%%en0`. Surrounding whitespace is trimmed.

#### The key's block in the ssh config

<VersionBadge type="changed" version="v5.3.0" />

Harper writes each key's settings to `<rootPath>/ssh/config`, in a block that starts and ends with lines Harper owns:

```
#my-key
# BEGIN harper ssh key my-key
Host my-key.github.com
	HostName github.com
	User git
	IdentityFile <rootPath>/ssh/my-key.key
	IdentitiesOnly yes
# END harper ssh key my-key
```

`get_ssh_key`, `list_ssh_keys` and `delete_ssh_key` read and change only the lines from `#<name>` through `# END harper ssh key <name>`, so you can add your own sections and settings anywhere outside them. `delete_ssh_key` removes exactly those lines, including anything you put between them, and leaves every other line of the file as it was. ssh_config has no end-of-section marker, so ssh still reads a line placed just after a key's `END` line as part of that key's `Host` section. Put your own settings under a `Host` or `Match` line of your own.

A config written by an earlier version gets these lines when the node starts, without changing what ssh resolves for any host. Only blocks whose `IdentityFile` is exactly `<rootPath>/ssh/<name>.key` get them, so a section of your own under a comment that looks like a key's name stays yours.

If a key's `BEGIN` line has no matching `END` line, where its block ends is unknown. `delete_ssh_key` then refuses that key with a `400` naming the line, until the `END` line is restored or the block is removed by hand. Other keys are unaffected.

#### Server-side key generation (`generate`)

<VersionBadge version="v5.2.4" />

With `generate: true`, Harper mints an ed25519 keypair on the node handling the request and returns only the **public** half. The private key is created inside the cluster and never travels from a client, so it can't be captured in a shell history, CI log, or request body on the way in:

```json
{
	"operation": "add_ssh_key",
	"name": "my-key",
	"generate": true,
	"host": "my-key.github.com",
	"hostname": "github.com"
}
```

Response:

```json
{
	"message": "Added ssh key: my-key",
	"public_key": "ssh-ed25519 AAAAC3Nza... harper:my-key"
}
```

Register that `public_key` with your git host (e.g. as a GitHub deploy key) to authorize the deploy. The generated key is commented `harper:<name>` so it's identifiable in the host's key list.

`key` and `generate` are mutually exclusive — sending both is rejected. Generation happens in-process, so it requires no `ssh-keygen` binary on the host and the minted private key is never written to a temporary file on its way into storage.

:::note
`public_key` is returned **only** on the generating call — that response is the one time the public half is handed back. Harper stores the private key (sealed, subject to the custody caveat above) and the host config; it does not retain the public key for later retrieval, and `update_ssh_key` requires a key you supply (it can't mint one). So capture `public_key` from this response — if you lose it, `delete_ssh_key` then `add_ssh_key` with `generate: true` again to mint a fresh pair, and re-register the new public key with your git host.
:::

---

## Secrets

Operations for managing the encrypted [secrets store](../security/secrets.md) (`system.hdb_secret`). All secret operations are **`super_user` only**. Values are never returned or logged by any of these operations.

Detailed documentation: [Secrets](../security/secrets.md)

:::tip
Prefer a UI? [Harper Studio](../studio/overview.md) provides a graphical interface for creating, granting, and rotating secrets — it drives these operations for you, so you don't have to hand-craft the request bodies below.
:::

| Operation                | Description                                                    | Role Required |
| ------------------------ | -------------------------------------------------------------- | ------------- |
| `set_secret`             | Creates or updates a secret and chooses its delivery tier      | super_user    |
| `grant_secret`           | Adds a component to a scoped secret's grants (idempotent)      | super_user    |
| `revoke_secret`          | Removes a component from a scoped secret's grants (idempotent) | super_user    |
| `list_secrets`           | Lists secret metadata — never envelopes or values              | super_user    |
| `delete_secret`          | Deletes a secret row                                           | super_user    |
| `get_secrets_public_key` | Returns the cluster public key for client-side encryption      | super_user    |

### `set_secret`

Creates or updates a secret. Supply exactly one of `value` (plaintext, encrypted on ingest — requires custody on this node) or `envelope` (an `enc:v1:` ciphertext produced client-side against `get_secrets_public_key`). The delivery tier is `processEnv: true` **or** `grants` — the two are mutually exclusive. On update, tier and metadata default to the stored row, so a value rotation preserves the tier without re-specifying it.

| Parameter    | Type     | Description                                                                     |
| ------------ | -------- | ------------------------------------------------------------------------------- |
| `name`       | string   | Secret name (word characters, dots, dashes). **Required.**                      |
| `value`      | string   | Plaintext value; encrypted immediately, then discarded. Requires custody.       |
| `envelope`   | string   | `enc:v1:` ciphertext (alternative to `value`).                                  |
| `processEnv` | boolean  | `true` delivers the secret via `process.env` (global tier).                     |
| `grants`     | string[] | Components allowed to read the secret via the `secrets` accessor (scoped tier). |
| `metadata`   | object   | Optional free-form label object (not a payload store).                          |

```json
{
	"operation": "set_secret",
	"name": "STRIPE_KEY",
	"value": "sk_live_...",
	"grants": ["payments-service"]
}
```

Response:

```json
{ "name": "STRIPE_KEY", "kid": "<hex fingerprint>", "created": true }
```

### `grant_secret` / `revoke_secret`

Add or remove a component from a scoped secret's grants list. Both are idempotent. A `processEnv` (global) secret cannot be granted — convert it with `set_secret` `processEnv: false` first.

```json
{ "operation": "grant_secret", "name": "STRIPE_KEY", "component": "payments-service" }
```

Response includes the updated `grants` array and a `changed` flag (`false` when the call was a no-op).

### `list_secrets`

Returns metadata for every secret — **never** envelopes or values. Each entry includes `name`, `kid`, `grants`, `processEnv`, `metadata`, `unverified`, `updated_by`, timestamps, and `kid_matches_custody` (so a stale row on a cloned/rekeyed node is immediately visible). The response also carries the node's `custody_fingerprint` (`null` when no custody is held).

```json
{ "operation": "list_secrets" }
```

Response:

```json
{
	"secrets": [
		{
			"name": "STRIPE_KEY",
			"kid": "a1b2c3d4...",
			"grants": ["payments-service"],
			"processEnv": false,
			"metadata": {},
			"unverified": false,
			"updated_by": "admin",
			"__createdtime__": 1700000000000,
			"__updatedtime__": 1700000000000,
			"kid_matches_custody": true
		}
	],
	"custody_fingerprint": "a1b2c3d4..."
}
```

### `delete_secret`

Removes a secret row by `name`. Not cryptographic erasure — audit/transaction logs and backups retain the encrypted envelope.

```json
{ "operation": "delete_secret", "name": "STRIPE_KEY" }
```

### `get_secrets_public_key`

Returns the cluster secrets public key for client-side envelope encryption. Requires custody on the node.

```json
{ "operation": "get_secrets_public_key" }
```

Response:

```json
{ "public_key": "-----BEGIN PUBLIC KEY-----\n...", "fingerprint": "<hex sha256>" }
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

Updates configuration parameters in `harper-config.yaml`. A restart (`restart` or `restart_service`) is required for changes to take effect.

Supports `"replicated": true` <VersionBadge version="v5.2.0" /> to apply the same change to all cluster nodes in one call; per-node outcomes are returned in the response's `replicated` array. Only send cluster-appropriate parameters when replicating — node-local parameters (ports, `node.hostname`, file paths, TLS material, `replication.hostname`/`url`/`routes`) would overwrite every peer's local values. To apply the change cluster-wide, follow with `restart_service` using `"replicated": true` (which restarts nodes one at a time). See [Configuration Operations](../configuration/operations.md#set-configuration) for details.

```json
{
	"operation": "set_configuration",
	"logging_level": "trace",
	"replicated": true
}
```

### `get_configuration`

Returns the full current configuration object.

```json
{ "operation": "get_configuration" }
```

---

## Web Application Firewall

<VersionBadge version="v5.2.0" />

Operations for managing Web Application Firewall rules and cluster-wide enforcement controls.

Detailed documentation: [WAF Operations and Rule Schema](../web-application-firewall/operations.md)

| Operation        | Description                                       | Role Required |
| ---------------- | ------------------------------------------------- | ------------- |
| `add_waf_rule`   | Creates a validated WAF rule                      | super_user    |
| `alter_waf_rule` | Patches and revalidates an existing WAF rule      | super_user    |
| `drop_waf_rule`  | Deletes a WAF rule                                | super_user    |
| `list_waf_rules` | Returns all WAF rules                             | super_user    |
| `set_waf_mode`   | Sets the replicated mode and/or scoring threshold | super_user    |

---

## System

Operations for restarting Harper and managing system state.

| Operation            | Description                                           | Role Required |
| -------------------- | ----------------------------------------------------- | ------------- |
| `restart`            | Restarts the Harper instance                          | super_user    |
| `restart_service`    | Restarts a specific Harper service                    | super_user    |
| `system_information` | Returns detailed host system metrics                  | super_user    |
| `set_status`         | Sets an application-specific status value (in-memory) | super_user    |
| `get_status`         | Returns one status value, or the instance summary     | super_user    |
| `clear_status`       | Removes a status entry                                | super_user    |

### `restart`

Restarts all Harper processes. May take up to 60 seconds.

```json
{ "operation": "restart" }
```

### `restart_service`

Restarts a specific service. `service` must be one of: `http`, `http_workers`, `custom_functions`, `harperdb` (all currently restart the HTTP workers). Supports `"replicated": true` for a rolling cluster restart.

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

`get_status` has two forms, and the one you get depends on whether you pass an `id`.

With an `id`, it returns that one status record:

```json
{ "operation": "get_status", "id": "primary" }
```

**Without an `id`, it returns a summary of the instance** rather than a status value:

```json
{ "operation": "get_status" }
```

| Field              | Description                                                                                                                                                               |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `systemStatus`     | Every status record set with `set_status`                                                                                                                                 |
| `componentStatus`  | Per-component health, aggregated across threads: `name` plus a `status` of `healthy`, `warning`, `error`, `loading`, or `unknown`                                         |
| `restartRequired`  | Whether a restart is pending on this node — set by a deploy that did not restart (see [Deploying without a restart](#deploying-without-a-restart)) and cleared on restart |
| `middlewareChains` | The resolved HTTP, upgrade, and WebSocket middleware order (v5.2.0). Present only when the request passes `middleware: true`                                              |

`restartRequired` is per node: it reports the node that served the request, not the cluster.

---

## Agent

<VersionBadge version="v5.2.0" />

Operations for driving Harper's built-in agent — an LLM loop that operates the instance through Harper's own operations, scoped filesystem access, followup scheduling, the V8 inspector, and outbound HTTP. The loop runs on the main thread, so an active run competes with Harper's other main-thread work; prefer running exploratory prompts against a node that is not serving production traffic.

The agent component is **disabled by default**. Enable it with `agent.enabled: true` in `harper-config.yaml` (see [`agent`](../configuration/options.md#agent)) and configure a generative model under [`models`](../models/overview.md#configuration). With the component disabled at startup none of these operations are registered, so calling one is an unknown-operation error rather than a permission or state error.

All six operations are `super_user` by default. They participate in the role [`operations` allowlist](../users-and-roles/overview.md#operation-permissions), so a non-`super_user` role can be granted a scoped subset without granting full `super_user` — either individual names (`operations: ['agent_prompt', 'get_agent_session']`) or the built-in [`agent` permission group](../users-and-roles/overview.md#operation-permissions), which covers all of these except `set_agent_config`. Note that the read operations are not caller-scoped: a role granted `get_agent_session` or `list_agent_sessions` reads every session on the instance, including transcripts of runs it did not start. Because a transcript records the _arguments and output_ of every tool call, and those calls ran as `agent.user`, delegating a read operation hands that role the results of work done at the agent's privilege — table contents, log excerpts, configuration — regardless of its own permissions. Delegate the read operations only to roles you would trust with the agent itself.

:::warning
Anyone who can call `agent_prompt` can direct whatever the agent does. Understand the boundary before enabling it:

- `agent.user` (default: a `super_user` bootstrap identity) governs only the **operations** tools. Setting it to a restricted user narrows those, and nothing else.
- The agent's other tools — scoped filesystem access, outbound `http_fetch`, followup scheduling, and the V8 inspector — run at the Harper process's own privilege, whatever `agent.user` is. (The inspector tools additionally need `threads.debug`, and fail with an explanatory error without it.)
- By default, `http_fetch` blocks only cloud-metadata hosts and the IPv4 link-local range `169.254.0.0/16`, and it checks host names, not resolved addresses: a name that resolves to a blocked address is not caught. Since v5.3.2, it also checks every redirect hop before following it. Every other host, including anything private or internal the server can route to, is reachable. Reading is ungated too: `read_file` covers the log and configuration directories as well as the component tree, so an enabled agent puts a read path and an egress path in the same toolset. Unless the agent needs the network, set [`agent.httpFetch`](../configuration/options.md#restricting-http_fetch) to `false` to remove the tool, or to an allow-list of the hosts it needs. Otherwise, treat it as an outbound network client and apply egress policy to the host.
- With the default `agent.allowDestructive: false`, destructive tools (including filesystem writes) are removed from the toolset entirely. Turning it on admits component writes, and component code is executed by the Harper process — a write is effectively code execution at process privilege.
- Leave `agent.autoApprove` off so any destructive call that is admitted still pauses for [approval](#approve_agent_action). The gate covers only the tools marked destructive — filesystem writes, the inspector's code-evaluation tools, and the operations on MCP's [curated destructive set](../mcp/tool-metadata.md) (`drop_table`, `delete`, `restart`, `set_configuration`, ...). `http_fetch` and followup scheduling are not gated, so an outbound POST and a self-rescheduling run proceed without an approval prompt.
- That set is an explicit list in core rather than a prefix match, and it is not a list of every damaging operation, so `allowDestructive` and `autoApprove` are not a boundary by themselves. The component operations are the ones to know about: `drop_component` and `deploy_component` are both off the set, so opting either into [`mcp.operations.allow`](../mcp/configuration.md#mcpoperationsallow) puts it in the agent's toolset where `allowDestructive: false` does not remove it and no approval gates it — and `deploy_component` writes code the Harper process then executes. Vet anything you add to that allow list on its own merits rather than assuming these two settings cover it.
  :::

| Operation              | Description                                                   | Role Required |
| ---------------------- | ------------------------------------------------------------- | ------------- |
| `agent_prompt`         | Starts or continues an agent session and kicks off a run      | super_user    |
| `get_agent_session`    | Returns a session: status, full transcript, pending approvals | super_user    |
| `list_agent_sessions`  | Lists agent sessions                                          | super_user    |
| `approve_agent_action` | Approves or denies a gated tool call and resumes the run      | super_user    |
| `cancel_agent_run`     | Cancels a run and marks the session aborted                   | super_user    |
| `set_agent_config`     | Updates agent settings in memory for the life of the process  | super_user    |

### Sessions and run status

Each conversation is a session, persisted to `system.hdb_agent_session` so transcripts survive a restart. Runs are asynchronous: `agent_prompt` returns as soon as the run is started, and you poll `get_agent_session` for progress and results.

Transcripts are retained indefinitely — the table is audited and none of these operations delete a session — and each tool call is recorded with its arguments as well as its output, so a bearer token in an `http_fetch` header or a secret in a `set_configuration` call is stored verbatim. Treat a prompt and everything a run passes to a tool as durably recorded, and keep credentials out of both.

The table also carries no replication opt-out: it is not on core's list of non-replicating system tables, so on a cluster that replicates the `system` database, expect transcripts to reach peer nodes with it, and a backup of `system` to carry them as well. Treat a run's prompts and tool output as cluster-wide rather than local to the node that served the request.

A run does not resume across a restart, and nothing reconciles session status at startup: a session the restart caught in `running` or `awaiting_approval` keeps that status indefinitely, so polling never terminates and `agent_prompt` rejects it with a 409. Clear it with [`cancel_agent_run`](#cancel_agent_run), which reports `"signalledLiveRun": false` because there is no live run left to signal.

A session's `status` is one of:

| Status              | Meaning                                                                                       |
| ------------------- | --------------------------------------------------------------------------------------------- |
| `idle`              | Created, or resumable — no run in flight                                                      |
| `running`           | A run is in progress                                                                          |
| `awaiting_approval` | Paused on one or more destructive tool calls; see `pendingApprovals`                          |
| `completed`         | The run ended without throwing — a final answer, or the `maxTurns` ceiling; check `lastError` |
| `aborted`           | Cancelled by an operator via `cancel_agent_run`                                               |
| `error`             | The run failed; `lastError` carries the message                                               |

`completed` also covers hitting the `agent.maxTurns` ceiling — in that case `lastError` reads `Reached maxTurns=<n> without a final answer.`, so check it before treating a completed session as finished.

### `agent_prompt`

Sends a prompt to the agent. Omit `session_id` to start a new session; supply one to continue an existing conversation. Returns immediately with the session id and `"status": "running"`.

| Parameter    | Type   | Description                                                     |
| ------------ | ------ | --------------------------------------------------------------- |
| `message`    | string | The instruction for the agent. **Required**, must be non-empty. |
| `session_id` | string | Existing session to continue. Omit to create a new session.     |

```json
{
	"operation": "agent_prompt",
	"message": "Create a component called inventory with a Product table keyed by sku, then verify it responds over REST."
}
```

Response:

```json
{ "session_id": "3f7c...", "status": "running" }
```

A session that is `running` or `awaiting_approval` rejects a new prompt with a 409 — resolve the pending approval or cancel the run first.

### `get_agent_session`

Returns the full session record: `status`, `user` (the Operations API caller who created the session, falling back to `agent.user`), the `messages` transcript (user, assistant, and tool messages, including tool calls and their observations), `pendingApprovals`, `model`, `provider`, `createdAt`/`updatedAt`, and `lastError`. This is the polling endpoint for a run in flight.

```json
{ "operation": "get_agent_session", "session_id": "3f7c..." }
```

Unknown `session_id` returns a 404.

### `list_agent_sessions`

Lists agent sessions.

| Parameter | Type    | Description                              |
| --------- | ------- | ---------------------------------------- |
| `limit`   | integer | Maximum sessions to return. Default 100. |

```json
{ "operation": "list_agent_sessions", "limit": 20 }
```

Response:

```json
{ "sessions": [{ "session_id": "3f7c...", "status": "completed", "...": "..." }] }
```

Through v5.2.4 the result order is not chronological — session ids are UUIDs and the listing walks them in reverse key order — and `limit` is applied by that scan, so once there are more sessions than `limit` the ones left out are an arbitrary subset rather than the oldest. On those versions, request a `limit` above your session count and sort on `updatedAt` or `createdAt` yourself if you need recency. The ordering is fixed in core by [harper#2268](https://github.com/HarperFast/harper/issues/2268) — check the release notes for the version it ships in.

### `approve_agent_action`

When `agent.autoApprove` is off (the default), any tool call the agent makes to a destructive operation pauses the run and lands in the session's `pendingApprovals`. This operation resolves one of them and resumes the run. Each entry carries its identifier in an `id` field — pass that as `approval_id` — alongside `toolName`, `arguments`, and `reason`.

| Parameter     | Type    | Description                                                                      |
| ------------- | ------- | -------------------------------------------------------------------------------- |
| `session_id`  | string  | **Required.**                                                                    |
| `approval_id` | string  | The `id` of the entry in `get_agent_session`'s `pendingApprovals`. **Required.** |
| `approved`    | boolean | `true` to approve (default). `false` denies the call.                            |

```json
{
	"operation": "approve_agent_action",
	"session_id": "3f7c...",
	"approval_id": "9b21...",
	"approved": true
}
```

Both decisions resume the loop: an approval executes the saved tool call, and a denial hands the refusal back to the model as an observation so it can adjust. Neither ends the run — use `cancel_agent_run` for that. If a single turn produced several gated calls, the session stays `awaiting_approval` until every one of them is resolved. Resolving an already-resolved approval is an error.

Whether a tool is treated as destructive at all is governed by `agent.allowDestructive`: when it is `false` (the default), destructive tools are removed from the agent's toolset entirely rather than gated. Which tools carry that mark is fixed in core — `write_file`, the inspector's code-evaluation tools, and the operations on MCP's [curated destructive set](../mcp/tool-metadata.md) — so an operation outside it (`drop_component` and `deploy_component` among them) is neither removed nor gated.

### `cancel_agent_run`

Cancels a session's run, clears any followups it scheduled, and marks the session `aborted`. Works on a paused (`awaiting_approval`) or `idle` session as well as an actively running one.

```json
{ "operation": "cancel_agent_run", "session_id": "3f7c..." }
```

Response:

```json
{ "cancelled": true, "signalledLiveRun": true }
```

`cancelled` is `false` if the session had already reached a terminal state (`completed`, `aborted`, `error`). `signalledLiveRun` reports whether there was an in-flight run to abort — a paused session yields `false` while still being marked aborted.

One gap is worth knowing: changing `allowDestructive` with [`set_agent_config`](#set_agent_config) rebuilds the toolset, and followups scheduled before that change are no longer tracked, so a later cancel does not clear them. A stray followup starts a fresh run even after a cancel and even with `enabled` set to `false`. If a run has scheduled followups, avoid toggling `allowDestructive` mid-session, and restart the node if one escapes.

### `set_agent_config`

Updates agent settings and returns the resulting configuration. Accepts any of `enabled`, `provider`, `model`, `maxTurns`, `maxCostUsd`, `autoApprove`, `allowDestructive`, and `systemPromptAppend`; keys not supplied are left unchanged. Each field is described under [`agent`](../configuration/options.md#agent). A request that includes `httpFetch` is rejected with a 400 and nothing in it is applied: the [`http_fetch` policy](../configuration/options.md#restricting-http_fetch) is read at startup only.

```json
{ "operation": "set_agent_config", "autoApprove": false, "maxTurns": 20 }
```

Three limits are worth knowing:

- **The change is in-memory and not persisted.** It applies for the life of the process and is lost on restart; edit `harper-config.yaml` for a durable change.
- **A run already in flight keeps the settings it started with** — its toolset, `autoApprove`, `model`, and `systemPromptAppend` are all captured at start. Changes take effect on the next run. To stop a run immediately, use `cancel_agent_run`.
- **`enabled` is not a kill switch.** It cannot turn the agent on — if it was off at startup, this operation does not exist. Setting it to `false` only makes subsequent `agent_prompt` calls return 409; a run already in flight continues, and `approve_agent_action` still resumes a paused one. Use `cancel_agent_run` to stop a run.

### MCP access

When the [MCP server](../mcp/overview.md) is enabled with the operations profile, `agent_prompt`, `get_agent_session`, `list_agent_sessions`, `approve_agent_action`, and `cancel_agent_run` are also exposed as MCP tools, with no allow-list entry required. They dispatch through the same authorization path as the operations above, and are listed only for users whose role could call them. `set_agent_config` is deliberately not exposed over MCP — it is an operator action.

---

## Backup & Restore

Operations for backing up and restoring databases. Managed backups <VersionBadge version="v5.2.0" /> require the RocksDB storage engine; `get_backup` works with both RocksDB and LMDB.

Detailed documentation: [Backup Operations](../backups/operations.md)

| Operation        | Description                                                         | Role Required |
| ---------------- | ------------------------------------------------------------------- | ------------- |
| `create_backup`  | Creates a managed, incremental directory backup of a database (job) | super_user    |
| `list_backups`   | Lists the managed backups for a database                            | super_user    |
| `verify_backup`  | Verifies a managed backup's integrity (job)                         | super_user    |
| `delete_backup`  | Deletes a single managed backup                                     | super_user    |
| `purge_backups`  | Deletes all but the newest `keep_count` managed backups             | super_user    |
| `restore_backup` | Restores a database from a managed backup (job)                     | super_user    |
| `get_backup`     | Streams a full snapshot of a database in the response for download  | super_user    |

### `create_backup`

Creates an incremental directory backup of the database under the configured backup root. Runs as a background [job](#jobs) that reports the new `backup_id`.

```json
{ "operation": "create_backup", "database": "dev" }
```

### `list_backups`

Returns the managed backups for a database, each with its `backup_id`, `timestamp`, `size`, and `file_count`.

```json
{ "operation": "list_backups", "database": "dev" }
```

### `verify_backup`

Verifies a managed backup's integrity, including checksums when `verify_checksum` is `true` (slower). Runs as a background [job](#jobs).

```json
{ "operation": "verify_backup", "database": "dev", "backup_id": 1, "verify_checksum": true }
```

### `delete_backup`

Deletes a single managed backup.

```json
{ "operation": "delete_backup", "database": "dev", "backup_id": 1 }
```

### `purge_backups`

Deletes all but the newest `keep_count` managed backups.

```json
{ "operation": "purge_backups", "database": "dev", "keep_count": 3 }
```

### `restore_backup`

Restores a database in place from a managed backup, as a background [job](#jobs). `backup_id` defaults to the latest backup. Restoring the `system` database, or a database a loaded component keeps open, requires the server to be stopped — see [when can a database be restored?](../backups/overview.md#when-can-a-database-be-restored)

```json
{ "operation": "restore_backup", "database": "dev", "backup_id": 1 }
```

### `get_backup`

Streams a full snapshot of the specified database in the HTTP response for download. For RocksDB <VersionBadge type="changed" version="v5.2.0" />, a `tar` archive of the current state (including file-backed blobs unless `exclude_blobs` is set), gzipped by default; for LMDB, the `.mdb` file.

```json
{ "operation": "get_backup", "database": "dev" }
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

Returns job status (`COMPLETE`, `IN_PROGRESS`, `ERROR`), timing, and result message for the specified job ID. Bulk import/export operations return a job ID on initiation, as does a `deploy_component` with `"restart": "rolling"`, as `restartJobId`.

```json
{ "operation": "get_job", "id": "4a982782-929a-4507-8794-26dae1132def" }
```

A job is recorded only on the node that ran it, because `system.hdb_job` is not replicated, so `get_job` answers only there; any other node returns an empty array. For a `deploy_component` with `"restart": "rolling"`, that is the node that received the deploy.

Any role may call `get_job`, unless the role has an `operations` allowlist, or the caller's token an `operations` scope, that does not list it. Either one refuses every operation it doesn't name, so a deploy-only role that waits for its rolling deploys must list `get_job`.

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

| Operation                        | Description                                                                                                              | Role Required |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------------ | ------------- |
| `read_log`                       | Returns entries from the primary `hdb.log`                                                                               | super_user    |
| `read_transaction_log`           | Returns transaction history for a table                                                                                  | super_user    |
| `delete_transaction_logs_before` | Deletes transaction log entries older than a timestamp                                                                   | super_user    |
| `read_audit_log`                 | Returns verbose transaction history for a table, including original record values (requires transaction logging enabled) | super_user    |
| `delete_audit_logs_before`       | Deletes transaction log entries older than a timestamp (deprecated alias of `delete_transaction_logs_before`)            | super_user    |

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

Returns verbose transaction history including original record state. Requires transaction logging (`logging.auditLog: true`) in configuration. Filter by `search_type`: `hash_value`, `timestamp`, or `username`.

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

<VersionBadge type="deprecated" version="v4.2.0" /> (moved to legacy in v4.7+)

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
