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

### `harper deploy`

<VersionBadge version="v4.3.0" />

Package and deploy a Harper component (application). With no `package`, `harper deploy` packages the current working directory into a tarball and deploys it; with `package=<reference>` it deploys from an npm, GitHub, or tarball reference instead of packaging local files. It deploys to the local Harper instance by default, or to a remote instance with `target=<url>`.

`deploy` is an alias for the `deploy_component` operation, available through the CLI since v4.3.0. Deploying from a package reference was added in v4.4.18.

`harper deploy` is a shorthand for the [`deploy_component`](../operations-api/operations.md#deploy_component) operation run against the current directory. See that operation for the full server-side behavior (deployment records, credentials, replication semantics); this page covers CLI-specific usage.

**Deploy the current directory to the local instance**:

```bash
harper deploy
```

The project name defaults to the current directory's name. Override it with `project=<name>`.

**Deploy a package reference**:

```bash
harper deploy package=HarperDB/application-template
```

**Deploy to a remote instance and restart it afterward**:

```bash
harper deploy target=https://server.com:9925 restart=true
```

Remote deploys authenticate the same way as any other remote CLI operation (stored login token, `auth_username`/`auth_password` or the legacy `username`/`password`, environment variables, or on GitHub Actions a [workload identity token](./authentication.md#workload-identity-oidc)). See [Remote Operations](./overview.md#remote-operations).

#### Live progress

<VersionBadge type="changed" version="v5.1.0" />

A directory deploy streams live progress to stderr: an upload progress bar followed by real-time install output, as the deploy advances through its phases (prepare → load → replicate → restart). A `package` or `by_ref` deploy prints only its result. From v5.4.0, the `load` phase is the [canary](../operations-api/operations.md#certifying-a-release-in-a-canary-worker) deciding whether the release loads, so a deploy that does not restart has no `load` phase. Against Harper servers older than 5.1, the CLI automatically falls back to a non-streaming deploy without live progress.

The result goes to stdout, so `json=true` gives a script a parseable result to read, such as `harper deploy restart=rolling json=true > deploy.json`.

Every deploy is recorded in the `system.hdb_deployment` table and the response includes a `deployment_id` you can use to query the deployment record. See [Deployment Operations](../operations-api/operations.md#deployment-operations).

#### Parameters

All parameters are passed as `key=value` arguments. Every parameter is optional.

- `project=<name>` - Component project name. Defaults to the current directory's name for a directory deploy, or is derived from the package for a package deploy.
- `package=<reference>` - An npm, GitHub, or tarball reference to deploy instead of the current directory (e.g. `HarperDB/app#semver:v1.0.0`).
- `target=<url>` - Remote Harper instance to deploy to. Omit to deploy to the local instance. A bare host defaults to `https://<host>:9925`.
- `restart=true` or `restart=rolling` - Restart Harper after deploying. Use `rolling` for a staggered, zero-downtime restart across a cluster. With `rolling`, the command exits `0` once the node you called has taken the release and started the rolling restart's job; see [Waiting for a rolling deploy](#waiting-for-a-rolling-deploy). Cannot be combined with `activate=false`.
- `replicated=false` - Deploy to the node you called only. On Harper Pro and Fabric, a deploy goes to every node in the cluster unless you pass this; Harper core on its own does not replicate.
- `install_command=<command>` - Override the install command run for the component.
- `install_timeout=<ms>` - Maximum time, in milliseconds, to allow the install to run.
- `install_allow_scripts=true` - Allow npm pre/post-install scripts to run (disabled by default).
- `deployment_timeout=<ms>` - How long, in milliseconds, a peer waits to receive the replicated payload before failing (default: `120000`). (Added in: v5.1.4)
- `ignore_replication_errors=true` - Treat a peer that fails to receive the deploy as non-fatal instead of failing the whole operation. (Added in: v5.1.4)
- `force=true` - Allow deploying over a protected core component name.
- `urlPath=<path>` - HTTP path the component is mounted at (e.g. `/api/v2`). Requires `package`.
- `host=<hostname>` - Virtual hostname the component is served on (e.g. `api.example.com`). Requires `package`. (Added in: v5.2.0)
- `credentials='<json>'` - JSON array of credential objects for installing from a private npm registry or git repository. See [Private deploy sources](#private-deploy-sources). (Added in: v5.2.0)
- `activate=false` - Build and install the release on each node without making it live. The result's `deployment_id` names the staged build. Cannot be combined with `restart`. See [Staging a build and activating it later](../operations-api/operations.md#staging-a-build-and-activating-it-later). (Added in: v5.3.0)
- `deployment_id=<id>` - Make a staged build live, or go back to a release a later deploy replaced, with no rebuild or reinstall. Takes no `package`, `by_ref`, or other build inputs. Pass `restart` here rather than on the stage. See [Going back to a previous release](../operations-api/operations.md#going-back-to-a-previous-release). (Added in: v5.3.0)
- `json=true` - Print output as JSON instead of the default YAML.

**Packaging options** (directory deploy only):

- `skip_node_modules=false` - Include the `node_modules` directory in the packaged tarball. Excluded by default.
- `skip_symlinks=true` - Exclude symlinks from the packaged tarball. Included by default; broken (dangling) symlinks are always skipped with a warning.

**Deploy-by-reference options** (see [Deploy by reference](#deploy-by-reference)):

- `by_ref=true` - Deploy the current project from its GitHub `origin` remote as a pinned commit (`git+https`) instead of uploading a packaged tarball. (Added in: v5.2.3)
- `ref=<committish>` - The branch, tag, or commit to deploy. Resolved to an immutable commit SHA so every cluster node deploys the same commit. Defaults to the current `HEAD`; implies `by_ref`. (Added in: v5.2.3)
- `credential=true` - Attach the sealed credential reference so the cluster can clone a private repository. Provision it first with `harper deploy setup=true`. (Added in: v5.2.3)
- `setup=true` - Provision (seal) a durable encrypted credential for a private deploy source instead of deploying. Interactive. (Added in: v5.2.3)

#### Waiting for a rolling deploy

`harper deploy restart=rolling` exits `0` once the node you called has taken the release and started a job that restarts the nodes one at a time. What the job does depends on the release:

- On v5.4.0 and later, unless the result's `certification` is `unavailable`, the other nodes only stage the release, and the job activates it on each in turn, certifying it in a [canary worker](../operations-api/operations.md#certifying-a-release-in-a-canary-worker). They take the release after the command has exited, and a node that rejects it fails the job, not the command. The failed job's `message` lists each node's outcome under `activated`.
- Otherwise, every node has installed the release before the command exits, and the job only restarts them.

Either way, the exit status does not say whether every node is serving the release. Poll the job named by the result's `restartJobId` with `harper get_job` until it ends `COMPLETE` or `ERROR`:

```bash
set -euo pipefail
harper deploy restart=rolling json=true > deploy.json
JOB_ID=$(jq -r '.restartJobId // empty' deploy.json)
[ -n "$JOB_ID" ] || exit 0
LAST="could not be read"
for attempt in $(seq 60); do
  sleep 10
  harper get_job id="$JOB_ID" json=true > job.json || continue
  case $(jq -r '.[0].status // "MISSING"' job.json) in
    COMPLETE) exit 0 ;;
    ERROR) jq -r '.[0].message' job.json; exit 1 ;;
    MISSING) LAST="was not on the node that answered" ;;
    *) LAST="was still running" ;;
  esac
done
echo "Job $JOB_ID $LAST after 60 polls"
exit 1
```

The loop retries a poll that fails, such as one that reaches a node while it restarts. Harper does not replicate jobs, so a node other than the one that received the deploy answers `get_job` with an empty list; the loop keeps polling, and through a load-balanced cluster URL it sees the job on the polls that reach that node. A user whose role has an `operations` allowlist needs `get_job` in it to poll. On Harper core alone, a job that only restarts, as in the second case above, ends `ERROR` with `Replication not implemented`, because it restarts across the cluster. With `restart=true` there is no job: the command fails when a node rejects the release, unless you pass `ignore_replication_errors=true`.

[Deploying from a CI/CD Pipeline](/learn/developers/deploying-from-ci) uses this in a complete GitHub Actions workflow.

#### Deploy by reference

<VersionBadge version="v5.2.3" />

Instead of packaging and uploading the working directory, `harper deploy by_ref=true` deploys a pinned git commit by reference: it resolves the project's GitHub `origin` remote and commit (from the local checkout or the GitHub Actions environment) and hands the cluster a `git+https://github.com/<owner>/<repo>.git#<sha>` package to clone. The commit is pinned to an immutable SHA so every cluster node deploys the same code.

```bash
# Deploy the current HEAD by reference
harper deploy by_ref=true

# Deploy a specific branch, tag, or commit
harper deploy by_ref=true ref=v1.2.3
```

The commit must be pushed to the remote before deploying, so the cluster can clone it; the CLI warns if the working tree is dirty or the commit is not on any remote branch. Only GitHub `origin` remotes are supported.

#### Private deploy sources

<VersionBadge version="v5.2.3" />

Installing a component from a private npm registry or a private git repository requires the `deploy_component` operation's [`credentials`](../operations-api/operations.md#deploy-credentials-credentials) field, an array of credential objects. Rather than passing a raw token on the command line (where it is exposed in shell history, process listings, and CI logs), provision a sealed credential once with `harper deploy setup=true`:

```bash
harper deploy setup=true
```

This interactive flow prompts for the provider (a private GitHub repository or a private npm registry) unless you pass `provider=github` or `provider=npm`, encrypts a token you supply (from `gh auth token`, `npm token create`, or a pasted PAT) on your machine using the cluster's public key, and stores only the ciphertext. It then prints a `credentials='[...]'` reference — containing the sealed secret's name, not the token — to use in your deploy.

- **Private git repository** - After `setup=true`, deploy by reference with `credential=true`, which attaches the sealed credential reference for the clone automatically:

  ```bash
  harper deploy by_ref=true credential=true
  ```

- **Private npm registry** - The flow does not ask which registry: pass `registry=<url>` (and `scope=@my-org` to apply it to one scope), or it uses `registry.npmjs.org`. After `setup=true`, pass the printed `credentials` reference on your deploy. CLI argument values are parsed as JSON, so a shell-quoted array works:

  ```bash
  harper deploy package=npm:@my-org/my-app@1.2.3 \
    credentials='[{"registry":"registry.my-org.com","secret":"deploy.my-app.registry.my-org.com"}]'
  ```

See [`deploy_component` credentials](../operations-api/operations.md#deploy-credentials-credentials) for the full credential-entry shape, including passing a literal `token` instead of a sealed `secret` reference.

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

### `harper login`

Available since: v5.1.0

Log in to a Harper instance to store authentication tokens locally. Once logged in, subsequent commands targeting this instance (via `target`) will automatically use the stored token.

The CLI also supports `.env` files. When you log in in a directory that already has a `.env` file, and neither that file nor your environment sets `HARPER_CLI_TARGET` or `CLI_TARGET`, the CLI appends `HARPER_CLI_TARGET` to it. It never creates the file. This allows you to omit the `target` parameter in subsequent commands within that directory.

```bash
harper login <URL>
```

**Optional Parameters**:

- `<URL>` - The URL of the Harper instance to log in to.
- `--for-ci` - After logging in, print CI/CD credentials to stdout. Available since v5.2.0.

**Prompts**:

You'll be asked to type in the following information:

- `<URL>` - If a URL parameter is not provided, you'll be prompted to enter the URL of the Harper instance to log in to.
- `<username>` - Harper admin username.
- `<password>` - Harper admin password.

#### `--for-ci`

<VersionBadge version="v5.2.0" />

Prints `HARPER_CLI_TARGET` and `HARPER_CLI_REFRESH_TOKEN` to **stdout** in `.env` format — and nothing else, so the output pipes directly into a secret store without the token being displayed. Everything else (banner, prompts, status, warnings) goes to stderr:

```bash
# Set both GitHub Actions secrets in one command
harper login --for-ci | gh secret set --env-file -
```

Run this as a **dedicated CI user**, not your own account: a user holds only one valid refresh token at a time, so issuing one for CI revokes any other token that user already had. See [Token credentials for CI/CD](authentication.md#token-credentials-for-cicd) for how the CLI consumes these variables and where they sit in authentication precedence.

### `harper logout`

Available since: v5.1.0

Log out of a Harper instance and remove the stored authentication token.

```bash
harper logout <URL>
```

**Optional Parameters**:

- `<URL>` - The URL of the Harper instance to log out from. If none is provided, you'll be signed out of all instances.

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

<VersionBadge type="changed" version="v5.3.0" /> <EngineBadge engines="LMDB" />

Copy a Harper database with compaction to eliminate free-space and fragmentation.

```bash
harper copy-db <source-database> <target-database-path>
```

**Parameters**:

- `<source-database>` - Name of the source database (a name, not a file path)
- `<target-database-path>` - Full path to the target database file; neither it nor its `<target-database-path>-blobs` companion directory may already exist. A failed copy makes a best-effort attempt to remove what it created, so a retry is usually not blocked by it; remove both by hand if a retry is refused, as it is after a previous successful copy to the same path.

**Example**:

```bash
harper copy-db data /home/user/hdb/database/copy.mdb
```

This copies the default `data` database to a new location with compaction applied.

As of v5.3.0 the database's `Blob` files are copied to `<target-database-path>-blobs/<rootIndex>/`, since blob files live outside the database file and are addressed by database name. If the database holds `Blob` values, the copy is not restorable without that companion directory — see [Database Compaction](../database/compaction.md#file-backed-blobs-copied-separately) for the restore steps. LMDB databases only — `copy-db` fails if the source database is stored in RocksDB, which compacts itself. It also fails, rather than copying part of the database, if the source database's tables span more than one storage environment (per-table `path` settings).

**Use Cases**:

- Database optimization
- Eliminating fragmentation
- Creating compacted backups
- Reclaiming free space

See also: [Database Compaction](../database/compaction.md) for more information.

#### How Backups Work

Which backup approach to use depends on the storage engine: use **volume snapshots** for **LMDB** databases, and the [**RocksDB backup engine**](../backups/overview.md) (`harper create_backup`) for **RocksDB** databases. The RocksDB backup engine produces incremental, checksum-verified backups directly, with no need for atomic volume snapshots. The rest of this section covers the volume-snapshot approach.

Harper uses a transactional commit process that ensures data on disk is always transactionally consistent with storage. This means Harper maintains database integrity in the event of a crash and allows you to use standard volume snapshot tools to make backups.

**Backup Process**:

Database files are stored in the `hdb/database` directory. As long as the snapshot is an atomic snapshot of these database files, the data can be copied/moved back into the database directory to restore a previous backup (with Harper shut down), and database integrity will be preserved.

**Important Notes**:

- **Atomic Snapshots**: Use volume snapshot tools for LMDB databases and the [RocksDB backup engine](../backups/overview.md) for RocksDB databases.
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
