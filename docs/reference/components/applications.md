---
title: Applications
---

<!-- Source: versioned_docs/version-4.7/reference/components/applications.md (primary) -->
<!-- Source: versioned_docs/version-4.7/reference/components/configuration.md (configuration reference) -->
<!-- Source: versioned_docs/version-4.7/reference/components/built-in-extensions.md (built-in extensions) -->
<!-- Source: versioned_docs/version-4.7/developers/operations-api/components.md (operations API) -->
<!-- Source: release-notes/v4-tucker/4.2.0.md (component architecture, NPM/GitHub deployment) -->

# Applications

> The contents of this page primarily relate to **application** components. The term "components" in the Operations API and CLI generally refers to applications specifically. See the [Components Overview](./overview.md) for a full explanation of terminology.

Harper offers several approaches to managing applications that differ between local development and remote Harper instances.

## Local Development

### `dev` and `run` Commands

<VersionBadge version="v4.2.0" />

The quickest way to run an application locally is with the `dev` command inside the application directory:

```sh
harperdb dev .
```

The `dev` command watches for file changes and restarts Harper worker threads automatically.

The `run` command is similar but does not watch for changes. Use `run` when the main thread needs to be restarted (the `dev` command does not restart the main thread).

Stop either process with SIGINT (Ctrl+C).

### Deploying to a Local Harper Instance

To mimic interaction with a hosted Harper instance locally:

1. Start Harper: `harperdb`
2. Deploy the application:

   ```sh
   harperdb deploy \
     project=<name> \
     package=<path-to-project> \
     restart=true
   ```

   - Omit `target` to deploy to the locally running instance.
   - Setting `package=<path-to-project>` creates a symlink so file changes are picked up automatically between restarts.
   - `restart=true` restarts worker threads after deploy. Use `restart=rolling` for a rolling restart.

3. Use `harperdb restart` in another terminal to restart threads at any time.
4. Remove an application: `harperdb drop_component project=<name>`

> Not all [component operations](#operations-api) are available via CLI. When in doubt, use the Operations API via direct HTTP requests to the local Harper instance.

Example:

```sh
harperdb deploy \
  project=test-application \
  package=/Users/dev/test-application \
  restart=true
```

> Use `package=$(pwd)` if your current directory is the application directory.

## Remote Management

Managing applications on a remote Harper instance uses the same operations as local management. The key difference is specifying a `target` along with credentials:

```sh
harperdb deploy \
  project=<name> \
  package=<package> \
  username=<username> \
  password=<password> \
  target=<remote> \
  restart=true \
  replicated=true
```

Credentials can also be provided via environment variables:

```sh
export CLI_TARGET_USERNAME=<username>
export CLI_TARGET_PASSWORD=<password>
harperdb deploy \
  project=<name> \
  package=<package> \
  target=<remote> \
  restart=true \
  replicated=true
```

### Package Sources

When deploying remotely, the `package` field can be any valid npm dependency value:

- **Omit** `package` to package and deploy the current local directory
- **npm package**: `package="@harperdb/status-check"`
- **GitHub**: `package="HarperDB/status-check"` or `package="https://github.com/HarperDB/status-check"`
- **Private repo (SSH)**: `package="git+ssh://git@github.com:HarperDB/secret-app.git"`
- **Tarball**: `package="https://example.com/application.tar.gz"`

When using git tags, use the `semver` directive for reliable versioning:

```
HarperDB/application-template#semver:v1.0.0
```

Harper generates a `package.json` from component configurations and uses a form of `npm install` to resolve them. This is why specifying a local file path creates a symlink (changes are picked up between restarts without redeploying).

For SSH-based private repos, use the [Add SSH Key](#add_ssh_key) operation to register keys first.

## Dependency Management

Harper uses `npm` and `package.json` for dependency management.

During application loading, Harper follows this resolution order to determine how to install dependencies:

1. If `node_modules` exists, or if `package.json` is absent — skip installation
2. Check the application's `harperdb-config.yaml` for `install: { command, timeout }` fields
3. Derive the package manager from [`package.json#devEngines#packageManager`](https://docs.npmjs.com/cli/v10/configuring-npm/package-json#devengines)
4. Default to `npm install`

The `add_component` and `deploy_component` operations support `install_command` and `install_timeout` fields for customizing this behavior.

### Example `harperdb-config.yaml` with Custom Install

```yaml
myApp:
  package: ./my-app
  install:
    command: yarn install
    timeout: 600000 # 10 minutes
    allowInstallScripts: true
```

### Example `package.json` with `devEngines`

```json
{
	"name": "my-app",
	"version": "1.0.0",
	"devEngines": {
		"packageManager": {
			"name": "pnpm",
			"onFail": "error"
		}
	}
}
```

> If you plan to use an alternative package manager, ensure it is installed on the host machine. Harper does not support the `"onFail": "download"` option and falls back to `"onFail": "error"` behavior.

## Advanced: Direct `harperdb-config.yaml` Configuration

Applications can be added to Harper by adding them directly to `harperdb-config.yaml` (located in the Harper `rootPath`, typically `~/hdb`).

```yaml
status-check:
  package: '@harperdb/status-check'
```

The entry name does not need to match a `package.json` dependency. Harper transforms these entries into a `package.json` and runs `npm install`.

Any valid npm dependency specifier works:

```yaml
myGithubComponent:
  package: HarperDB-Add-Ons/package#v2.2.0
myNPMComponent:
  package: harperdb
myTarBall:
  package: /Users/harper/cool-component.tar
myLocal:
  package: /Users/harper/local
myWebsite:
  package: https://harperdb-component
```

Harper generates a `package.json` and installs all components into `<componentsRoot>` (default: `~/hdb/components`). A symlink back to `<rootPath>/node_modules` is created for dependency resolution.

> Use `harperdb get_configuration` to find the `rootPath` and `componentsRoot` values on your instance.

## Operations API

Component operations are restricted to `super_user` roles.

### `add_component`

Creates a new component project in the component root directory using a template.

- `project` _(required)_ — Name of the project to create
- `template` _(optional)_ — Git URL of a template repository. Defaults to `https://github.com/HarperFast/application-template`
- `install_command` _(optional)_ — Install command. Defaults to `npm install`
- `install_timeout` _(optional)_ — Install timeout in milliseconds. Defaults to `300000` (5 minutes)
- `install_allowInstallScripts` _(optional)_ — Allow install scripts to run. Defaults to `false`, which causes `--ignore-scripts` to be passed to the install command (this is ignored with `install_command`).
- `replicated` _(optional)_ — Replicate to all cluster nodes

```json
{
	"operation": "add_component",
	"project": "my-component"
}
```

### `deploy_component`

Deploys a component using a package reference or a base64-encoded `.tar` payload.

- `project` _(required)_ — Name of the project
- `package` _(optional)_ — Any valid npm reference (GitHub, npm, tarball, local path, URL)
- `payload` _(optional)_ — Base64-encoded `.tar` file content
- `force` _(optional)_ — Allow deploying over protected core components. Defaults to `false`
- `restart` _(optional)_ — `true` for immediate restart, `'rolling'` for sequential cluster restart
- `replicated` _(optional)_ — Replicate to all cluster nodes
- `install_command` _(optional)_ — Install command override
- `install_timeout` _(optional)_ — Install timeout override in milliseconds
- `install_allowInstallScripts` _(optional)_ — Allow install scripts to run. Defaults to `false`, which causes `--ignore-scripts` to be passed to the install command (this is ignored with `install_command`).

```json
{
	"operation": "deploy_component",
	"project": "my-component",
	"package": "HarperDB/application-template#semver:v1.0.0",
	"replicated": true,
	"restart": "rolling"
}
```

### `drop_component`

Deletes a component project or a specific file within it.

- `project` _(required)_ — Project name
- `file` _(optional)_ — Path relative to project folder. If omitted, deletes the entire project
- `replicated` _(optional)_ — Replicate deletion to all cluster nodes
- `restart` _(optional)_ — Restart Harper after dropping

```json
{
	"operation": "drop_component",
	"project": "my-component"
}
```

### `package_component`

Packages a project folder as a base64-encoded `.tar` string.

- `project` _(required)_ — Project name
- `skip_node_modules` _(optional)_ — Exclude `node_modules` from the package

```json
{
	"operation": "package_component",
	"project": "my-component",
	"skip_node_modules": true
}
```

### `get_components`

Returns all local component files, folders, and configuration from `harperdb-config.yaml`.

```json
{
	"operation": "get_components"
}
```

### `get_component_file`

Returns the contents of a file within a component project.

- `project` _(required)_ — Project name
- `file` _(required)_ — Path relative to project folder
- `encoding` _(optional)_ — File encoding. Defaults to `utf8`

```json
{
	"operation": "get_component_file",
	"project": "my-component",
	"file": "resources.js"
}
```

### `set_component_file`

Creates or updates a file within a component project.

- `project` _(required)_ — Project name
- `file` _(required)_ — Path relative to project folder
- `payload` _(required)_ — File content to write
- `encoding` _(optional)_ — File encoding. Defaults to `utf8`
- `replicated` _(optional)_ — Replicate update to all cluster nodes

```json
{
	"operation": "set_component_file",
	"project": "my-component",
	"file": "test.js",
	"payload": "console.log('hello world')"
}
```

### SSH Key Management

For deploying from private repositories, SSH keys must be registered on the Harper instance.

#### `add_ssh_key`

- `name` _(required)_ — Key name
- `key` _(required)_ — Private key contents (must be ed25519; use `\n` for line breaks with trailing `\n`)
- `host` _(required)_ — Host alias for SSH config (used in `package` URL)
- `hostname` _(required)_ — Actual domain (e.g., `github.com`)
- `known_hosts` _(optional)_ — Public SSH keys of the host. Auto-retrieved for `github.com`
- `replicated` _(optional)_ — Replicate to all cluster nodes

```json
{
	"operation": "add_ssh_key",
	"name": "my-key",
	"key": "-----BEGIN OPENSSH PRIVATE KEY-----\n...\n-----END OPENSSH PRIVATE KEY-----\n",
	"host": "my-key.github.com",
	"hostname": "github.com"
}
```

After adding a key, use the configured host in deploy package URLs:

```
"package": "git+ssh://git@my-key.github.com:my-org/my-repo.git#semver:v1.0.0"
```

Additional SSH key operations: `update_ssh_key`, `delete_ssh_key`, `list_ssh_keys`, `set_ssh_known_hosts`, `get_ssh_known_hosts`.
