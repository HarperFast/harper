---
title: CLI Commands
---

<!-- Source: versioned_docs/version-4.7/deployments/harper-cli.md (primary) -->
<!-- Source: versioned_docs/version-4.4/deployments/harper-cli.md (for baseline features) -->
<!-- Source: release-notes/v4-tucker/4.2.0.md (confirmed dev mode commands) -->
<!-- Source: release-notes/v4-tucker/4.1.0.md (confirmed foreground mode changes) -->

# CLI Commands

This page documents the core Harper CLI commands for managing Harper instances. For Operations API commands available through the CLI, see [Operations API Commands](./operations-api-commands.md).

## Process Management Commands

### `harper`

<VersionBadge version="v4.1.0" />

Run Harper in the foreground as a standard process. This is the recommended way to run Harper.

```bash
harper
```

When you run `harper`:

- If Harper is not installed, it will guide you through the installation process
- Once installed, it runs Harper in the foreground as a standard process, compatible with systemd, Docker, and other process management tools

**First-Time Installation**:

If Harper is not installed, you can provide configuration parameters via environment variables or command line arguments:

**Using Environment Variables**:

```bash
# Minimum required parameters for no additional CLI prompts
export TC_AGREEMENT=yes
export HDB_ADMIN_USERNAME=HDB_ADMIN
export HDB_ADMIN_PASSWORD=password
export ROOTPATH=/hdb/
harper
```

:::note
If you specify `DEFAULT_MODE=dev` you will also need to specify the `REPLICATION_HOSTNAME=localhost`
:::

**Using Command Line Arguments**:

```bash
# Minimum required parameters for no additional CLI prompts
harper \
  --TC_AGREEMENT=yes \
  --HDB_ADMIN_USERNAME=HDB_ADMIN \
  --HDB_ADMIN_PASSWORD=password \
  --ROOTPATH='/hdb'
```

**Note**: When used in conjunction, command line arguments override environment variables. See [Configuration](../configuration/overview.md) for a full list of configuration parameters.

:::info
For more information on installation, see [Getting Started / Install and Connect Harper](/learn/getting-started/install-and-connect-harper).
:::

### `harper run`

<VersionBadge version="v4.2.0" />

Run a Harper application from any location as a foreground, standard process (similar to `harper`).

```bash
harper run /path/to/app
```

This command runs Harper with the specified application directory without automatic reloading or dev-specific features.

### `harper dev`

<VersionBadge version="v4.2.0" />

Run Harper in development mode from a specified directory with automatic reloading. Recommended for local application development. Operates similar to `harper` and `harper run`.

```bash
harper dev /path/to/app
```

**Features**:

- Pushes logs to standard streams automatically
- Uses a single thread for simpler debugging
- Auto-restart on file changes

### `harper restart`

Available since: v4.1.0

Restart a running Harper instance regardless if its a foreground (`harper`, `harper run`, or `harper dev`) or background (`harper start`) process.

```bash
harper restart
```

### `harper start`

Available since: v4.1.0

Start Harper in background (daemon mode).

```bash
harper start
```

After installation, this command launches Harper as a background process. Remember that the Harper PID is available in a `hdb.pid` file within the installation directory.

### `harper stop`

Available since: v4.1.0

Stop a running Harper instance.

```bash
harper stop
```

## Installation Commands

### `harper install`

Available since: v4.1.0

Install Harper with interactive prompts or automated configuration.

```bash
harper install
```

The `harper install` command operates exactly like the [`harper`](#harper) command, but exits as soon as the installation completes. See the [`harper`](#harper) command documentation above for details on providing configuration parameters via environment variables or command line arguments.

**Note**: We recommend using `harper` instead of `harper install` as it provides a consistent workflow for both installation and running Harper.

## Information Commands

### `harper version`

Available since: v4.1.0

Display the installed Harper version.

```bash
harper version
```

**Example Output**:

```
4.7.0
```

### `harper status`

Available since: v4.1.0

Display the status of Harper and clustering.

```bash
harper status
```

Shows:

- Harper process status
- Clustering network status
- Replication statuses

In Harper versions where NATS is supported, this command also shows the clustering hub and leaf processes too.

### `harper help`

Available since: v4.1.0

Display all available Harper CLI commands with brief descriptions.

```bash
harper help
```

## Maintenance Commands

### `harper renew-certs`

Available since: v4.1.0

Renew Harper-generated self-signed certificates.

```bash
harper renew-certs
```

This command regenerates the self-signed SSL/TLS certificates used by Harper.

### `harper copy-db`

Available since: v4.1.0

Copy a Harper database with compaction to eliminate free-space and fragmentation.

```bash
harper copy-db <source-database> <target-database-path>
```

**Parameters**:

- `<source-database>` - Name of the source database
- `<target-database-path>` - Full path to the target database file

**Example**:

```bash
harper copy-db data /home/user/hdb/database/copy.mdb
```

This copies the default `data` database to a new location with compaction applied.

**Use Cases**:

- Database optimization
- Eliminating fragmentation
- Creating compacted backups
- Reclaiming free space

See also: [Database Compaction](../database/compaction.md) for more information.

#### How Backups Work

Harper uses a transactional commit process that ensures data on disk is always transactionally consistent with storage. This means Harper maintains database integrity in the event of a crash and allows you to use standard volume snapshot tools to make backups.

**Backup Process**:

Database files are stored in the `hdb/database` directory. As long as the snapshot is an atomic snapshot of these database files, the data can be copied/moved back into the database directory to restore a previous backup (with Harper shut down), and database integrity will be preserved.

**Important Notes**:

- **Atomic Snapshots**: Use volume snapshot tools that create atomic snapshots
- **Not Safe**: Simply copying an in-use database file using `cp` is **not reliable**
  - Progressive reads occur at different points in time
  - Results in an unreliable copy that likely won't be usable
- **Safe Copying**: Standard file copying is only reliable for database files that are **not in use**

**Recommended Backup Tools**:

- LVM snapshots
- ZFS snapshots
- BTRFS snapshots
- Cloud provider volume snapshots (AWS EBS, Azure Disk, GCP Persistent Disk)
- Enterprise backup solutions with snapshot capabilities

## Remote Operations

The CLI supports executing commands on remote Harper instances. For details, see [CLI Overview - Remote Operations](./overview.md#remote-operations).

## See Also

- [CLI Overview](./overview.md) - General CLI information
- [Operations API Commands](./operations-api-commands.md) - Operations available through CLI
- [CLI Authentication](./authentication.md) - Authentication mechanisms
- [Configuration](../configuration/overview.md) - Configuration parameters for installation
- [Database Compaction](../database/compaction.md) - More on database compaction
