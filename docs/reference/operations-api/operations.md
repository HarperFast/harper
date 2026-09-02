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

```yaml
permissions:
  id-token: write
  contents: read
environment: production
steps:
  - run: harper deploy by_ref=true
    env:
      HARPER_CLI_TARGET: ${{ vars.HARPER_CLI_TARGET }} # a var, not a secret
```

No secret at all — `HARPER_CLI_TARGET` is not sensitive. See [CLI Authentication](../cli/authentication.md#workload-identity-oidc) for the client half and where the exchange sits in credential precedence.

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

`claims` is a JSON object, so quote it as a single shell argument — the CLI parses each value as JSON, which is what turns that string into the nested object the operation expects. `operations` works the same way if you scope the policy: `operations='["deploy_component","get_deployment"]'`.

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
	"operations": ["deploy_component", "get_deployment", "restart_service"],
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

### `deploy_component`

Deploys a component. The `package` option accepts any valid NPM reference including GitHub repos (`HarperDB/app#semver:v1.0.0`), tarballs, or NPM packages. The `payload` option accepts a base64-encoded tar string from `package_component`. Supports `"replicated": true` and `"restart": true` or `"restart": "rolling"`.

Additional parameters:

- `urlPath` — the HTTP URL path the component is mounted at (e.g. `"/api/v2"`). Must not contain `..` or `.` path segments. Persisted on the component's root-config entry; see [HTTP middleware routing](../http/overview.md#middleware-routing).
- `host` <VersionBadge version="v5.2.0" /> — the virtual hostname the component is served on (e.g. `"api.example.com"`). Must be a bare hostname or IPv6 literal — no scheme, port, path, or brackets. Persisted alongside `urlPath`.
- `install_allow_scripts` — set to `true` to allow npm pre/post install scripts (disabled by default)
- `credentials` — credentials for installing a component from a private npm registry or private git repository (see below)
- `deployment_timeout` <VersionBadge version="v5.1.4" /> — how long, in milliseconds, a peer waits to receive the replicated deployment payload before failing (default: `120000`)
- `ignore_replication_errors` <VersionBadge version="v5.1.4" /> — set to `true` to treat a peer that fails to receive the deploy as non-fatal instead of failing the whole operation. By default a failed peer causes `deploy_component` to return a non-2xx status; the component is still deployed (and, if requested, restarted) on the origin node.

`urlPath` and `host` both require `package` and are rejected on a payload-only deploy. To mount a payload-deployed component, add `host`/`urlPath` to its entry in the root `harper-config.yaml` instead.

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
	"credentials": [{ "host": "github.com", "secret": "deploy.my-app.git.github_com" }]
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
	"message": "Component deployed successfully"
}
```

#### Restarting (`restart`)

<VersionBadge type="changed" version="v5.3.0" />

`"restart": true` restarts this node's HTTP worker threads and waits for that restart to finish before responding, so a successful response means every worker thread is serving the newly deployed code. Until a worker has been replaced it is still running the previous code, and on platforms where replacements share a listening port it keeps accepting connections for the whole rolling restart — before this, a client that treated the immediate response as "the component is live" could be served by a worker that had never loaded it.

The wait follows the restart's own progress rather than a fixed timeout, so a wide thread pool, a slow component install, or a worker draining in-flight work does not cut it short. That also means the response can take as long as the install plus the restart — tens of seconds on a slow install with many worker threads — so a caller with a short request timeout should use `"restart": "rolling"` and poll its job instead. If it does give up — the restart stopped reporting progress, ran past the wait's absolute ceiling, or left a worker thread that could not be replaced — the restart continues in the background and the Harper log says which of those happened. A restart that fails does not fail the deploy: the component is already installed and replicated.

`"restart": "rolling"` is unchanged: instead of restarting inline it starts a replicated `restart_service` job and returns its `restartJobId` to poll.

`drop_component` accepts `"restart": true` and waits for the restart the same way (v5.3.0).

### Deployment Operations

Harper records every `deploy_component` call in the `system.hdb_deployment` table, capturing the full lifecycle of a deployment including phase transitions (prepare → load → replicate → restart → success/failed), per-node outcomes, and a bounded event log of install output.

### `list_deployments`

Returns a list of deployment records, newest first. All filter parameters are optional.

| Parameter | Type   | Description                                      |
| --------- | ------ | ------------------------------------------------ |
| `project` | string | Filter to a specific component project           |
| `status`  | string | Filter by status: `pending`, `success`, `failed` |
| `since`   | number | Start of time range (Unix timestamp ms)          |
| `until`   | number | End of time range (Unix timestamp ms)            |
| `limit`   | number | Maximum number of results (default: 100)         |
| `offset`  | number | Pagination offset                                |

```json
{
	"operation": "list_deployments",
	"project": "my-app",
	"status": "success",
	"limit": 20
}
```

Response includes a `deployments` array and a `total` count. The `payload_blob` field is stripped from list responses for size; use `get_deployment_payload` to retrieve the tarball.

### `get_deployment`

Returns a single deployment record by `deployment_id`. When called on an in-progress deployment via a request that accepts `text/event-stream`, the response streams live phase events and install output as Server-Sent Events, replaying the buffered event log then tailing until the deployment reaches a terminal status.

```json
{
	"operation": "get_deployment",
	"deployment_id": "a3f8c2d1..."
}
```

The deployment record includes:

| Field                | Description                                                             |
| -------------------- | ----------------------------------------------------------------------- |
| `deployment_id`      | Unique identifier (content hash)                                        |
| `project`            | Component project name                                                  |
| `package_identifier` | Package reference or `payload` for tar uploads                          |
| `status`             | `pending`, `success`, `failed`, or `rolled_back`                        |
| `phase`              | Current lifecycle phase: `prepare`, `load`, `replicate`, `restart`      |
| `event_log`          | Bounded log of install output and phase transitions (up to 200 entries) |
| `peer_results`       | Per-node outcome map for replicated deployments                         |
| `payload_hash`       | SHA-256 hash of the deployment tarball                                  |
| `payload_size`       | Byte size of the deployment tarball                                     |
| `started_at`         | Timestamp when deployment began                                         |
| `completed_at`       | Timestamp when deployment finished                                      |
| `user`               | User who initiated the deployment                                       |
| `rollback_of`        | `deployment_id` of the deployment this rolls back, if applicable        |
| `error`              | Error message for failed deployments                                    |

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

The deployment must be in a terminal status (`success`, `failed`, or `rolled_back`); deleting the payload of an in-progress deployment fails with `409`, since its payload may still be replicating to peers. Deleting an already-reclaimed payload succeeds with `freed_bytes: 0` (the operation is idempotent). A `payload_dropped` entry recording the deleting user is appended to the deployment's `event_log`.

### `add_ssh_key`

Adds an SSH key (must be ed25519) for authenticating deployments from private repositories. Supply the private key with `key`, or omit it and pass `generate: true` to have Harper mint the keypair itself.

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
| `get_status`         | Returns a previously set status value                 | super_user    |
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
- `http_fetch` blocks only the known cloud-metadata hostnames and the IPv4 link-local range `169.254.0.0/16`, and it checks the literal hostname you pass — a name that resolves to a blocked address is not caught, and redirects are followed without re-checking. Every other host, including anything private or internal the server can route to, is reachable. Reading is ungated too: `read_file` covers the log and configuration directories as well as the component tree, so an enabled agent puts a read path and an egress path in the same toolset. Treat it as an outbound network client and apply egress policy to the host.
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

Updates agent settings and returns the resulting configuration. Accepts any of `enabled`, `provider`, `model`, `maxTurns`, `maxCostUsd`, `autoApprove`, `allowDestructive`, and `systemPromptAppend`; keys not supplied are left unchanged. Each field is described under [`agent`](../configuration/options.md#agent).

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
