---
title: Operations API Commands
---

<!-- Source: versioned_docs/version-4.7/deployments/harper-cli.md (primary) -->
<!-- Source: release-notes/v4-tucker/4.3.0.md (confirmed CLI expansion with operations API commands in v4.3.0) -->

# Operations API Commands

<VersionBadge version="v4.3.0" />

The Harper CLI supports executing operations from the [Operations API](../operations-api/overview.md) directly from the command line. This enables powerful automation and scripting capabilities.

## General Syntax

```bash
harper <operation> <parameter>=<value>
```

**Output Format**:

- Default: YAML
- JSON: Pass `json=true` as a parameter

## Supported Operations

<!-- Source: Harper CLI source code (SUPPORTED_OPS and OP_ALIASES arrays) -->

The following operations are available through the CLI. Operations that require complex nested parameters or object structures are not supported via CLI and must be executed through the HTTP API.

### Complete Operations List

:::note
This is just a brief overview of all operations available as CLI commands. Review the respective operation documentation for more information on available arguments and expected behavior. Keep in mind that all operations options are converted to CLI arguments in the same way (using `snake_case`).
:::

| Operation                        | Description                           | Category                                                               | Available Since |
| -------------------------------- | ------------------------------------- | ---------------------------------------------------------------------- | --------------- |
| `describe_table`                 | Describe table structure and metadata | [Database](../operations-api/operations.md#databases--tables)          | v4.3.0          |
| `describe_all`                   | Describe all databases and tables     | [Database](../operations-api/operations.md#databases--tables)          | v4.3.0          |
| `describe_database`              | Describe database structure           | [Database](../operations-api/operations.md#databases--tables)          | v4.3.0          |
| `create_database`                | Create a new database                 | [Database](../operations-api/operations.md#databases--tables)          | v4.3.0          |
| `drop_database`                  | Delete a database                     | [Database](../operations-api/operations.md#databases--tables)          | v4.3.0          |
| `create_table`                   | Create a new table                    | [Database](../operations-api/operations.md#databases--tables)          | v4.3.0          |
| `drop_table`                     | Delete a table                        | [Database](../operations-api/operations.md#databases--tables)          | v4.3.0          |
| `create_attribute`               | Create a table attribute              | [Database](../operations-api/operations.md#databases--tables)          | v4.3.0          |
| `drop_attribute`                 | Delete a table attribute              | [Database](../operations-api/operations.md#databases--tables)          | v4.3.0          |
| `search_by_id`                   | Search records by ID                  | [Data](../operations-api/operations.md#nosql-operations)               | v4.3.0          |
| `search_by_value`                | Search records by attribute value     | [Data](../operations-api/operations.md#nosql-operations)               | v4.3.0          |
| `insert`                         | Insert new records                    | [Data](../operations-api/operations.md#nosql-operations)               | v4.4.9          |
| `update`                         | Update existing records               | [Data](../operations-api/operations.md#nosql-operations)               | v4.4.9          |
| `upsert`                         | Insert or update records              | [Data](../operations-api/operations.md#nosql-operations)               | v4.4.9          |
| `delete`                         | Delete records                        | [Data](../operations-api/operations.md#nosql-operations)               | v4.3.0          |
| `sql`                            | Execute SQL queries                   | [Data](../operations-api/operations.md#nosql-operations)               | v4.3.0          |
| `csv_file_load`                  | Load data from CSV file               | [Data](../operations-api/operations.md#nosql-operations)               | v4.3.0          |
| `csv_url_load`                   | Load data from CSV URL                | [Data](../operations-api/operations.md#nosql-operations)               | v4.3.0          |
| `list_users`                     | List all users                        | [Security](../operations-api/operations.md#certificate-management)     | v4.3.0          |
| `add_user`                       | Create a new user                     | [Security](../operations-api/operations.md#certificate-management)     | v4.3.0          |
| `alter_user`                     | Modify user properties                | [Security](../operations-api/operations.md#certificate-management)     | v4.3.0          |
| `drop_user`                      | Delete a user                         | [Security](../operations-api/operations.md#certificate-management)     | v4.3.0          |
| `list_roles`                     | List all roles                        | [Security](../operations-api/operations.md#certificate-management)     | v4.3.0          |
| `drop_role`                      | Delete a role                         | [Security](../operations-api/operations.md#certificate-management)     | v4.3.0          |
| `create_csr`                     | Create certificate signing request    | [Security](../operations-api/operations.md#certificate-management)     | v4.4.0          |
| `sign_certificate`               | Sign a certificate                    | [Security](../operations-api/operations.md#certificate-management)     | v4.4.0          |
| `list_certificates`              | List SSL/TLS certificates             | [Security](../operations-api/operations.md#certificate-management)     | v4.4.0          |
| `add_certificate`                | Add SSL/TLS certificate               | [Security](../operations-api/operations.md#certificate-management)     | v4.4.0          |
| `remove_certificate`             | Remove SSL/TLS certificate            | [Security](../operations-api/operations.md#certificate-management)     | v4.4.0          |
| `add_ssh_key`                    | Add SSH key                           | [Security](../operations-api/operations.md#certificate-management)     | v4.4.0          |
| `get_ssh_key`                    | Get SSH key                           | [Security](../operations-api/operations.md#certificate-management)     | v4.7.2          |
| `update_ssh_key`                 | Update SSH key                        | [Security](../operations-api/operations.md#certificate-management)     | v4.4.0          |
| `delete_ssh_key`                 | Delete SSH key                        | [Security](../operations-api/operations.md#certificate-management)     | v4.4.0          |
| `list_ssh_keys`                  | List all SSH keys                     | [Security](../operations-api/operations.md#certificate-management)     | v4.4.0          |
| `set_ssh_known_hosts`            | Set SSH known hosts                   | [Security](../operations-api/operations.md#certificate-management)     | v4.4.0          |
| `get_ssh_known_hosts`            | Get SSH known hosts                   | [Security](../operations-api/operations.md#certificate-management)     | v4.4.0          |
| `cluster_get_routes`             | Get cluster routing information       | [Clustering](../operations-api/operations.md#replication--clustering)  | v4.3.0          |
| `cluster_network`                | Get cluster network status            | [Clustering](../operations-api/operations.md#replication--clustering)  | v4.3.0          |
| `cluster_status`                 | Get cluster status                    | [Clustering](../operations-api/operations.md#replication--clustering)  | v4.3.0          |
| `remove_node`                    | Remove node from cluster              | [Clustering](../operations-api/operations.md#replication--clustering)  | v4.3.0          |
| `add_component`                  | Add a component                       | [Components](../operations-api/operations.md#components)               | v4.3.0          |
| `deploy_component`               | Deploy a component                    | [Components](../operations-api/operations.md#components)               | v4.3.0          |
| `deploy` (alias)                 | Alias for `deploy_component`          | [Components](../operations-api/operations.md#components)               | v4.3.0          |
| `package_component`              | Package a component                   | [Components](../operations-api/operations.md#components)               | v4.3.0          |
| `package` (alias)                | Alias for `package_component`         | [Components](../operations-api/operations.md#components)               | v4.3.0          |
| `drop_component`                 | Remove a component                    | [Components](../operations-api/operations.md#components)               | v4.3.0          |
| `get_components`                 | List all components                   | [Components](../operations-api/operations.md#components)               | v4.3.0          |
| `get_component_file`             | Get component file contents           | [Components](../operations-api/operations.md#components)               | v4.3.0          |
| `set_component_file`             | Set component file contents           | [Components](../operations-api/operations.md#components)               | v4.3.0          |
| `install_node_modules`           | Install Node.js dependencies          | [Components](../operations-api/operations.md#components)               | v4.3.0          |
| `set_configuration`              | Update configuration settings         | [Configuration](../operations-api/operations.md#configuration)         | v4.3.0          |
| `get_configuration`              | Get current configuration             | [Configuration](../operations-api/operations.md#configuration)         | v4.3.0          |
| `create_authentication_tokens`   | Create authentication tokens          | [Authentication](../operations-api/operations.md#token-authentication) | v4.3.0          |
| `refresh_operation_token`        | Refresh operation token               | [Authentication](../operations-api/operations.md#token-authentication) | v4.3.0          |
| `restart_service`                | Restart Harper service                | [System](../operations-api/operations.md#registration--licensing)      | v4.3.0          |
| `restart`                        | Restart Harper instance               | [System](../operations-api/operations.md#registration--licensing)      | v4.3.0          |
| `system_information`             | Get system information                | [System](../operations-api/operations.md#registration--licensing)      | v4.3.0          |
| `registration_info`              | Get registration information          | [Licensing](../operations-api/operations.md#registration--licensing)   | v4.3.0          |
| `get_fingerprint`                | Get instance fingerprint              | [Licensing](../operations-api/operations.md#registration--licensing)   | v4.3.0          |
| `set_license`                    | Set license key                       | [Licensing](../operations-api/operations.md#registration--licensing)   | v4.3.0          |
| `get_usage_licenses`             | Get usage and license info            | [Licensing](../operations-api/operations.md#registration--licensing)   | v4.7.3          |
| `get_job`                        | Get job status                        | [Jobs](../operations-api/operations.md#jobs)                           | v4.3.0          |
| `search_jobs_by_start_date`      | Search jobs by start date             | [Jobs](../operations-api/operations.md#jobs)                           | v4.3.0          |
| `read_log`                       | Read application logs                 | [Logging](../operations-api/operations.md#logs)                        | v4.3.0          |
| `read_transaction_log`           | Read transaction logs                 | [Logging](../operations-api/operations.md#logs)                        | v4.3.0          |
| `read_audit_log`                 | Read audit logs                       | [Logging](../operations-api/operations.md#logs)                        | v4.3.0          |
| `delete_transaction_logs_before` | Delete old transaction logs           | [Logging](../operations-api/operations.md#logs)                        | v4.3.0          |
| `purge_stream`                   | Purge streaming data                  | [Maintenance](../operations-api/operations.md#jobs)                    | v4.3.0          |
| `delete_records_before`          | Delete old records                    | [Maintenance](../operations-api/operations.md#jobs)                    | v4.3.0          |
| `get_status`                     | Get custom status information         | [Status](../operations-api/operations.md#registration--licensing)      | v4.6.0          |
| `set_status`                     | Set custom status information         | [Status](../operations-api/operations.md#registration--licensing)      | v4.6.0          |
| `clear_status`                   | Clear custom status information       | [Status](../operations-api/operations.md#registration--licensing)      | v4.6.0          |

### Command Aliases

The following aliases are available for convenience:

- `deploy` → `deploy_component`
- `package` → `package_component`

For detailed parameter information for each operation, see the [Operations API documentation](../operations-api/operations.md).

## Command Examples

### Database Operations

**Describe a database**:

```bash
harper describe_database database=dev
```

**Describe a table** (with YAML output):

```bash
harper describe_table database=dev table=dog
```

**Example Output**:

```yaml
schema: dev
name: dog
hash_attribute: id
audit: true
schema_defined: false
attributes:
  - attribute: id
    is_primary_key: true
  - attribute: name
    indexed: true
clustering_stream_name: 3307bb542e0081253klnfd3f1cf551b
record_count: 10
last_updated_record: 1724483231970.9949
```

:::tip
For detailed information on database and table structures, see the [Database Reference](../database/overview.md).
:::

### Data Operations

**Search by ID** (with JSON output):

```bash
harper search_by_id database=dev table=dog ids='["1"]' get_attributes='["*"]' json=true
```

**Search by value**:

```bash
harper search_by_value table=dog search_attribute=name search_value=harper get_attributes='["id", "name"]'
```

:::tip
For more information on querying data, see the [REST Reference](../rest/overview.md) and [GraphQL Querying](../graphql-querying/overview.md).
:::

### Configuration Operations

**Set configuration**:

```bash
harper set_configuration logging_level=error
```

**Get configuration**:

```bash
harper get_configuration
```

:::tip
For comprehensive configuration options, see the [Configuration Reference](../configuration/overview.md).
:::

### Component Operations

**Deploy a component**:

```bash
harper deploy_component project=my-cool-app package=https://github.com/HarperDB/application-template
```

**Get all components**:

```bash
harper get_components
```

**Note**: `deploy` is an alias for `deploy_component`:

```bash
harper deploy project=my-app package=https://github.com/user/repo
```

:::tip
For more information on components and applications, see the [Components Reference](../components/overview.md).
:::

### User and Role Operations

**List users**:

```bash
harper list_users
```

**List roles**:

```bash
harper list_roles
```

:::tip
For detailed information on users, roles, and authentication, see the [Security Reference](../security/overview.md).
:::

## Remote Operations

All CLI operations can be executed on remote Harper instances. See [CLI Overview - Remote Operations](./overview.md#remote-operations) for details on authentication and remote execution.

### Remote Component Deployment

When using remote operations, you can deploy a local component or application to the remote instance.

**Deploy current directory**:

If you omit the `package` parameter, the current directory will be packaged and deployed:

```bash
harper deploy target=https://server.com:9925
```

**Note**: `deploy` is an alias for `deploy_component`.

**Deploy to clustered environment**:

For clustered environments, use the `replicated=true` parameter to ensure the deployment is replicated to all nodes:

```bash
harper deploy target=https://server.com:9925 replicated=true
```

**Restart after deployment** (with replication):

After deploying to a clustered environment, restart all nodes to apply changes:

```bash
harper restart target=https://server.com:9925 replicated=true
```

For more information on Harper applications and components, see:

- [Components](../components/overview.md) - Application architecture and structure
- [Deploying Harper Applications](/learn/getting-started/install-and-connect-harper) - Step-by-step deployment guide

## Parameter Formatting

### String Parameters

Simple string values can be passed directly:

```bash
harper describe_table database=dev table=dog
```

### Array Parameters

Array parameters must be quoted and formatted as JSON:

```bash
harper search_by_id database=dev table=dog ids='["1","2","3"]'
```

### Object Parameters

Object parameters are not supported via CLI. For operations requiring complex nested objects, use:

- The [Operations API](../operations-api/overview.md) via HTTP
- A custom script or tool

### Boolean Parameters

Boolean values can be passed as strings:

```bash
harper get_configuration json=true
harper deploy target=https://server.com:9925 replicated=true
```

## Output Formatting

### YAML (Default)

By default, CLI operation results are formatted as YAML for readability:

```bash
harper describe_table database=dev table=dog
```

### JSON

Pass `json=true` to get JSON output (useful for scripting):

```bash
harper describe_table database=dev table=dog json=true
```

## Scripting and Automation

The Operations API commands through the CLI are ideal for:

- Build and deployment scripts
- Automation workflows
- CI/CD pipelines
- Administrative tasks
- Monitoring and health checks

**Example Script**:

```bash
#!/bin/bash

# Deploy component to remote cluster
export CLI_TARGET_USERNAME=HDB_ADMIN
export CLI_TARGET_PASSWORD=$SECURE_PASSWORD

harper deploy \
  target=https://cluster-node-1.example.com:9925 \
  replicated=true \
  package=https://github.com/myorg/my-component

# Restart the cluster
harper restart \
  target=https://cluster-node-1.example.com:9925 \
  replicated=true

# Check status
harper get_components \
  target=https://cluster-node-1.example.com:9925 \
  json=true
```

## Limitations

The following operation types are **not supported** via CLI:

- Operations requiring complex nested JSON structures
- Operations with array-of-objects parameters
- File upload operations
- Streaming operations

For these operations, use the [Operations API](../operations-api/overview.md) directly via HTTP.

## See Also

- [CLI Overview](./overview.md) - General CLI information
- [CLI Commands](./commands.md) - Core CLI commands
- [Operations API Overview](../operations-api/overview.md) - Operations API documentation
- [Operations API Reference](../operations-api/operations.md) - Complete operations list
- [CLI Authentication](./authentication.md) - Authentication details
