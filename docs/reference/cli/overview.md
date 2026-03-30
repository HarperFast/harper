---
title: Harper CLI Overview
---

<!-- Source: versioned_docs/version-4.7/deployments/harper-cli.md (primary) -->
<!-- Source: versioned_docs/version-4.4/deployments/harper-cli.md (for baseline features) -->
<!-- Source: release-notes/v4-tucker/4.3.0.md (confirmed CLI expansion in v4.3.0) -->
<!-- Source: release-notes/v4-tucker/4.2.0.md (confirmed dev mode in v4.2.0) -->
<!-- Source: release-notes/v4-tucker/4.1.0.md (confirmed foreground mode changes in v4.1.0) -->

# Harper CLI Overview

The Harper command line interface (CLI) is used to administer self-installed Harper instances.

## Installation

Available since: v4.1.0

Harper is typically installed globally via npm:

```bash
npm i -g harperdb
```

The installation includes the Harper CLI, which provides comprehensive management capabilities for local and remote Harper instances.

For detailed installation instructions, see the [Getting Started / Install And Connect Harper](https://docs.harperdb.io/docs/getting-started/install-and-connect-harper) guide.

## Command Name

Changed in: v4.7.0

The CLI command is `harper`. From v4.1.0 to v4.6.x, the command was only available as `harperdb`. Starting in v4.7.0, the preferred command is `harper`, though `harperdb` continues to work as an alias for backward compatibility.

**Examples**:

```bash
# Modern usage (v4.7.0+)
harper
harper describe_table database=dev table=dog

# Legacy usage (still supported)
harperdb
harperdb describe_table database=dev table=dog
```

All examples in this documentation use `harper`.

## General Usage

The primary way to use Harper is to run the `harper` command. When you run `harper`:

- If Harper is not installed, it will guide you through the installation process
- Once installed, it runs Harper in the foreground as a standard process
- This makes it compatible with systemd, Docker, and other process management tools
- Output logs directly to the console for easy monitoring

The CLI supports two main categories of commands:

1. **System Commands** - Core Harper management commands (start, stop, restart, status, etc.)
2. **Operations API Commands** - Execute operations from the Operations API directly via the CLI

Both system and operations commands can be executed on local or remote Harper instances. For remote operations, authentication credentials can be provided via command parameters or environment variables.

### CLI Installation Targeting

By default, the CLI targets the Harper installation path stored in `~/.harperdb/hdb_boot_properties.file`. You can override this to target a specific Harper installation by specifying the `--ROOTPATH` command line argument or the `ROOTPATH` environment variable.

**Example: Target a specific installation**:

```bash
# Using command line argument
harper status --ROOTPATH /custom/path/to/hdb

# Using environment variable
export ROOTPATH=/custom/path/to/hdb
harper status
```

### Process ID File

When Harper is running, the process identifier (PID) is stored in a file named `hdb.pid` located in the Harper installation directory. This file can be used by external process management tools or scripts to monitor or manage the Harper process.

**Location**: `<ROOTPATH>/hdb.pid`

**Example**:

```bash
# Read the PID
cat /path/to/hdb/hdb.pid

# Use with external tools
kill -0 $(cat /path/to/hdb/hdb.pid)  # Check if process is running
```

## System Management Commands

| Command                            | Description                                                  | Available Since |
| ---------------------------------- | ------------------------------------------------------------ | --------------- |
| `harper`                           | Run Harper in foreground mode (default behavior)             | v4.1.0          |
| `harper run <path/to/app>`         | Run Harper application from any directory                    | v4.2.0          |
| `harper dev <path/to/app>`         | Run Harper in dev mode with auto-restart and console logging | v4.2.0          |
| `harper restart`                   | Restart Harper                                               | v4.1.0          |
| `harper start`                     | Start Harper in background (daemon mode)                     | v4.1.0          |
| `harper stop`                      | Stop a running Harper instance                               | v4.1.0          |
| `harper status`                    | Display Harper and clustering status                         | v4.1.0          |
| `harper version`                   | Show installed Harper version                                | v4.1.0          |
| `harper renew-certs`               | Renew Harper-generated self-signed certificates              | v4.1.0          |
| `harper copy-db <source> <target>` | Copy a database with compaction                              | v4.1.0          |
| `harper help`                      | Display all available CLI commands                           | v4.1.0          |

See [CLI Commands](./commands.md) for detailed documentation on each command.

## Operations API Commands

Added in: v4.3.0

The Harper CLI supports executing most operations from the [Operations API](../operations-api/overview.md) directly from the command line. This includes operations that do not require complex nested parameters.

**Syntax**: `harper <operation> <parameter>=<value>`

**Output Format**: Results are formatted as YAML by default. Pass `json=true` for JSON output.

**Examples**:

```bash
# Describe a table
harper describe_table database=dev table=dog

# Set configuration
harper set_configuration logging_level=error

# Deploy a component
harper deploy_component project=my-app package=https://github.com/user/repo

# Get all components
harper get_components

# Search by ID (JSON output)
harper search_by_id database=dev table=dog ids='["1"]' json=true

# SQL query
harper sql sql='select * from dev.dog where id="1"'
```

See [Operations API Commands](./operations-api-commands.md) for the complete list of available operations.

## Remote Operations

Changed in: v4.3.0 (expanded remote operations support)

The CLI can execute operations on remote Harper instances by passing the `target` parameter with the HTTP address of the remote instance.

**Authentication**: Provide credentials via:

- Parameters: `username=<user> password=<pass>`
- Environment variables: `CLI_TARGET_USERNAME` and `CLI_TARGET_PASSWORD`

See [CLI Authentication](./authentication.md) for detailed information on authentication methods and best practices.

**Example: CLI Target Environment Variables**:

```bash
export CLI_TARGET_USERNAME=HDB_ADMIN
export CLI_TARGET_PASSWORD=password
harper describe_database database=dev target=https://server.com:9925
```

**Example: CLI Options**:

```bash
harper describe_database database=dev target=https://server.com:9925 username=HDB_ADMIN password=password
```

## Development Mode

Added in: v4.2.0

For local application and component development, use `harper dev`:

```bash
harper dev /path/to/app
```

**Features**:

- Console logging for immediate feedback
- Debugging enabled
- Auto-restart on file changes
- Ideal for rapid iteration during development

See [CLI Commands](./commands.md) for detailed information on `harper dev` and other development commands.

## See Also

- [CLI Commands](./commands.md) - Detailed reference for each CLI command
- [Operations API Commands](./operations-api-commands.md) - Operations available through CLI
- [CLI Authentication](./authentication.md) - Authentication mechanisms
- [Configuration](../configuration/overview.md) - Harper configuration options
- [Operations API](../operations-api/overview.md) - Full operations API reference
