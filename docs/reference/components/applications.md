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
harper dev .
```

The `dev` command watches for file changes and restarts Harper worker threads automatically.

The `run` command is similar but does not watch for changes. Use `run` when the main thread needs to be restarted (the `dev` command does not restart the main thread).

Stop either process with SIGINT (Ctrl+C).

### Deploying to a Local Harper Instance

To mimic interaction with a hosted Harper instance locally:

1. Start Harper: `harper`
2. Deploy the application:

   ```sh
   harper deploy \
     project=<name> \
     package=<path-to-project> \
     restart=true
   ```

   - Omit `target` to deploy to the locally running instance.
   - Setting `package=<path-to-project>` creates a symlink so file changes are picked up automatically between restarts.
   - `restart=true` restarts worker threads after deploy. Use `restart=rolling` for a rolling restart.

3. Use `harper restart` in another terminal to restart threads at any time.
4. Remove an application: `harper drop_component project=<name>`

> Not all [component operations](#operations-api) are available via CLI. When in doubt, use the Operations API via direct HTTP requests to the local Harper instance.

Example:

```sh
harper deploy \
  project=test-application \
  package=/Users/dev/test-application \
  restart=true
```

> Use `package=$(pwd)` if your current directory is the application directory.

## Shutdown Cleanup

Applications with work that must complete, or be acknowledged outside the process, before a thread exits — buffered writes to flush, a registration to withdraw from an external service, a distributed lock to release — need a hook to do it when Harper stops or restarts. Restarts are frequent during local development, since `harper dev` restarts worker threads on every file change, and deploying with `restart=true` does the same on a running instance.

Harper signals this by calling `scope.close()` on each worker thread that loads the application, which emits a `'close'` event on the plugin API [`Scope`](./plugin-api.md#class-scope). Listen for it to run cleanup:

```js
export function handleApplication(scope) {
	const service = startService();
	scope.once('close', async () => {
		await service.close();
	});
}
```

See [Cleanup on Shutdown](./plugin-api.md#cleanup-on-shutdown) for the full shutdown sequence, including how async cleanup is awaited and the time limit it must finish within.

## Remote Management

Managing applications on a remote Harper instance uses the same operations as local management. The recommended approach is to log in first using `harper login` to store an authentication token:

```sh
# Log in once
harper login <remote>
# Provide your username and password when prompted

# Subsequently deploy without credentials
harper deploy \
  project=<name> \
  package=<package> \
  target=<remote> \
  restart=true \
  replicated=true
```

For CI/CD on GitHub Actions, use [workload identity (OIDC)](../cli/authentication.md#workload-identity-oidc) instead: the CLI trades the runner's identity token for an operation token against a trust policy on the cluster, so the pipeline stores no Harper credential, and the policy can name a deploy-only user rather than an administrator. [Deploying from a CI/CD Pipeline](/learn/developers/deploying-from-ci) has a complete workflow. Elsewhere, give the pipeline a refresh token from [`harper login --for-ci`](../cli/authentication.md#token-credentials-for-cicd) rather than a password.

### Dedicated Authentication Parameters

<VersionBadge version="v5.2.0" />

For one-off remote commands, dedicated authentication parameters are also available (not recommended for production):

```sh
harper deploy \
  project=<name> \
  package=<package> \
  auth_username=<username> \
  auth_password=<password> \
  target=<remote> \
  restart=true \
  replicated=true
```

Dedicated authentication parameters take precedence over environment variables and saved login tokens. See [CLI Authentication](../cli/authentication.md#authentication-precedence) for the full order and security guidance.

### Package Sources

When deploying remotely, the `package` field can be any valid npm dependency value:

- **Omit** `package` to package and deploy the current local directory
- **npm package**: `package="@harperdb/status-check"`
- **GitHub**: `package="HarperFast/status-check"` or `package="https://github.com/HarperFast/status-check"`
- **Private repo (SSH)**: `package="git+ssh://git@github.com:HarperDB/secret-app.git"`
- **Tarball**: `package="https://example.com/application.tar.gz"`

When using git tags, use the `semver` directive for reliable versioning:

```
HarperFast/application-template#semver:v1.0.0
```

Harper generates a `package.json` from component configurations and uses a form of `npm install` to resolve them. This is why specifying a local file path creates a symlink (changes are picked up between restarts without redeploying).

For SSH-based private repos, use the [Add SSH Key](#add_ssh_key) operation to register keys first.

### Deploying by Reference

<VersionBadge version="v5.2.3" />

Omitting `package` uploads a snapshot of your working directory. The result is an anonymous artifact: nothing records _which_ commit it came from, so reproducing it later — or stepping back to a previous release — means finding those exact files again.

Deploying by **reference** sends a pinned git reference instead, and the cluster fetches that exact commit. Redeploying the same reference deploys the same source revision.

A pinned SHA fixes the _source_, not the built artifact. The cluster installs and builds from that source on each node, so unpinned dependency ranges, a mutable registry artifact, install scripts, or a different toolchain can still produce different bytes — or a failure — from the same commit. Commit your lockfile if you need the build itself to be reproducible.

`harper deploy by_ref=true` builds that reference from the local git repository, so you don't assemble the URL yourself:

```sh
harper deploy by_ref=true restart=true replicated=true
```

This resolves the repository's `origin` remote and the current commit, then deploys `package=git+https://github.com/<owner>/<repo>.git#<full commit SHA>`.

**Parameters**:

- `by_ref` - Build the package reference from the local repository.
- `ref` _(optional)_ - Deploy a specific commit, tag, or branch instead of `HEAD`. Resolved to a commit SHA before it is sent to the cluster. Implies `by_ref`.
- `credential` _(optional)_ - Set to `true` to authenticate the clone with the stored credential for the repository's host. Omit for public repositories.

`ref` takes a tag or a commit:

```sh
harper deploy ref=v1.2.0 restart=true replicated=true
harper deploy ref=9f8c2a1 restart=true replicated=true
```

To go back to a release a later deploy replaced, activate the kept release by its `deployment_id` instead (v5.3.0). That puts back the exact installed release with no fetch, rebuild, or reinstall, where deploying an older commit installs it again from source:

```sh
harper deploy project=<name> deployment_id=<id> restart=true
```

[`list_deployments`](../operations-api/operations.md#list_deployments) shows each deployment's id, and [Going back to a previous release](../operations-api/operations.md#going-back-to-a-previous-release) says which releases are kept.

**A reference is pinned to a SHA, not to the name you typed.** Tags and branches are resolved to a full commit SHA before the deploy is sent — from your local checkout when it has the ref, and from the remote when it doesn't (a shallow CI clone usually doesn't). Annotated tags resolve to the commit they point at. This matters on a cluster: peers resolve the package independently, so a tag that moves mid-deploy — or a branch that advances — could otherwise leave nodes running different code.

If a `ref` can't be resolved either way, the deploy stops rather than sending the name for the cluster to resolve. Run `git fetch` and retry, or pass a full commit SHA — that needs no resolution and is always accepted.

**A full commit SHA is accepted directly.** An object ID is already immutable, so there is nothing to pin it to and no resolution is attempted — SHA-based rollbacks are always valid. Every other `ref` must name something a clone can fetch: `refs/heads/*` or `refs/tags/*` if you qualify it, or a bare branch or tag name that resolves locally or on the remote. A qualified ref outside those two namespaces — `refs/pull/123/head`, say — is rejected up front, even if your own checkout can resolve it, because the cluster could resolve that commit and still never check it out.

**Commit and push first.** The cluster clones from the remote, so it only sees commits that have been pushed. `by_ref` warns in both directions: when the working tree is dirty (those changes won't be part of the deploy) and when the commit being deployed isn't on any remote branch (the cluster won't be able to clone it). The second check reads your local remote-tracking refs, so run `git fetch` if you get it for a commit you know you pushed.

The unpushed-commit check is **skipped under GitHub Actions**, where the runner's checkout is not a branch a `git branch -r --contains` can see; the dirty-tree warning still applies. On a `pull_request` run the commit is resolved from the event payload instead, as described below.

**In GitHub Actions**, `by_ref` deploys the commit the workflow is running on. On a `pull_request` run that is the pull request's **head** commit rather than the merge commit the runner checks out: the merge commit lives under `refs/pull/<n>/merge`, which a plain clone can't fetch, so the cluster would have no way to resolve it. For a pull request from a fork, the head repository is the fork, and the CLI names it before deploying. If the event payload isn't readable, the deploy stops and asks for the commit explicitly:

```sh
harper deploy ref=${{ github.event.pull_request.head.sha }} restart=true replicated=true
```

#### Private repositories

Pass `credential=true` for a private repository. The CLI attaches a `credentials` reference naming a secret that the cluster resolves in memory at clone time, so no token travels in the operation body or lands on disk:

```sh
harper deploy by_ref=true credential=true restart=true replicated=true
```

The host comes from the package being deployed, so the credential always matches the clone it authenticates. Naming the host explicitly (`credential=github.com`) still works, but one that doesn't match the package's host is rejected instead of deployed — the clone would never ask for it, and the deploy would fail as though no credential were configured.

Provision that credential once with [`harper deploy setup=true`](#provisioning-a-deploy-credential). See [Private-source deploy credentials](../security/secrets.md#private-source-deploy-credentials) for how the secret is named and resolved, and [`add_ssh_key`](#add_ssh_key) for the SSH-key alternative.

:::note
Deploying by reference means the **cluster** installs and builds the component from source. If your application needs a build step that can't run on the node, keep shipping the built output as a payload deploy instead.
:::

### Provisioning a Deploy Credential

<VersionBadge version="v5.2.3" />

`harper deploy setup=true` provisions the credential a private deploy needs. It's interactive, and runs once per component and source. It calls `get_secrets_public_key`, `set_secret`, and `grant_secret`, all of which require **super_user**, so run it with an administrative credential rather than the CI identity it provisions for:

```sh
harper deploy setup=true
```

It asks which private source needs a credential (a GitHub repository or an npm registry), sources a token, and then:

1. Fetches the cluster's public key with `get_secrets_public_key`.
2. **Encrypts the token locally** into an `enc:v1:` envelope.
3. Stores only the ciphertext with `set_secret`, in the component-scoped tier.
4. Grants this component permission to resolve it with `grant_secret`.
5. Prints the `credentials` reference for the deploy to use.

The plaintext never leaves your machine: the operations API, its logs, and replication only ever carry the envelope, and the cluster decrypts it in memory at deploy time. This requires a cluster with secrets custody (Harper Pro / Fabric) — see [Client-side encryption](../security/secrets.md#client-side-encryption-encrypt-before-it-leaves-the-client).

**Prefer a fine-grained PAT.** For a GitHub repository the prompt offers, and defaults to, pasting a fine-grained personal access token with **Contents: Read-only on that one repository**. If you have the `gh` CLI authenticated it also offers its session token, which is one keypress cheaper but typically carries `repo`, `read:org`, `gist`, and `workflow` scopes across your whole account; choosing it prints a warning. What this flow seals is durable and replayed on every cold deploy and rollback, so it is worth being the narrowest credential that does the job.

The secret is stored **scoped to the component**, never in the global `processEnv` tier that every component and child process can read. If a global secret already exists at the derived name, it is converted to the scoped tier — the name is derived from the component, so a global secret there was never serving anything the scoped one doesn't. Existing grants on the row are preserved.

Because the stored token is durable, later deploys — including re-fetching an older reference — reuse it without re-entering anything.

## Dependency Management

Harper uses `npm` and `package.json` for dependency management.

During application loading, Harper follows this resolution order to determine how to install dependencies:

1. If `node_modules` exists, or if `package.json` is absent — skip installation
2. Check the application's `harper-config.yaml` for `install: { command, timeout }` fields
3. Derive the package manager from [`package.json#devEngines#packageManager`](https://docs.npmjs.com/cli/v10/configuring-npm/package-json#devengines)
4. Default to `npm install`

The `add_component` and `deploy_component` operations support `install_command` and `install_timeout` fields for customizing this behavior.

### Example `harper-config.yaml` with Custom Install

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

## Advanced: Direct `harper-config.yaml` Configuration

Applications can be added to Harper by adding them directly to `harper-config.yaml` (located in the Harper `rootPath`, typically `~/hdb`).

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
  package: harper
myTarBall:
  package: /Users/harper/cool-component.tar
myLocal:
  package: /Users/harper/local
myWebsite:
  package: https://harperdb-component
```

Harper generates a `package.json` and installs all components into `<componentsRoot>` (default: `~/hdb/components`). A symlink back to `<rootPath>/node_modules` is created for dependency resolution.

> Use `harper get_configuration` to find the `rootPath` and `componentsRoot` values on your instance.

## Isolated Applications and Branched Databases

<VersionBadge version="v5.3.0" />

Two keys on an application's root-config entry run it apart from the other applications on the instance:

- **`isolated: true`** runs the application in a worker thread of its own.
- **`branchedDatabases`** gives the application a private fork of one or more databases.

```yaml
# <rootPath>/harper-config.yaml
shop-preview:
  package: my-org/shop#3f9c2e1
  host: preview.shop.example.com
  isolated: true
```

Like `host` and `urlPath`, these keys say how one deployment of the application runs, so they belong on its entry in the root config and not in the application's own `config.yaml`. An application that declares `branchedDatabases` in its own `config.yaml` fails to load, with an error saying the key belongs in the root config entry.

### Setting them when you deploy

A `package` deploy, including `harper deploy by_ref=true`, builds the component's root-config entry from the request, so it can set `host`, `urlPath`, `isolated`, and `branchedDatabases` in the same call. The CLI parses `isolated=true` as a boolean and `branchedDatabases='["data"]'` as a list:

```sh
harper deploy project=shop-preview by_ref=true \
  host=preview.shop.example.com isolated=true restart=true
```

- A later `package` deploy that omits `isolated` keeps the current setting, and `isolated=false` removes it.
- A payload deploy (from a directory, or with `payload`) refuses `isolated` with a `400`: `'isolated' is only supported for package deployments; set it on the application's root config entry instead`. It also refuses `host` and `urlPath`. A payload deploy keeps the keys already on the entry.
- On v5.3.0 and v5.3.1, no deploy request gives an application a fork. A `package` deploy writes `branchedDatabases` into the entry, but the application ignores it when it loads ([harper#3071](https://github.com/HarperFast/harper/issues/3071)). A payload deploy accepts `branchedDatabases` and drops it ([harper#3044](https://github.com/HarperFast/harper/issues/3044)). The manual steps under [Branched databases](#branched-databases) do work.

[How a deploy updates the root config](../operations-api/operations.md#how-a-deploy-updates-the-root-config) has the full rules for the entry.

### Isolated applications

By default, every worker thread loads every application. An application whose entry sets `isolated: true` is loaded by one dedicated worker thread instead, that thread loads no other application, and no other thread loads it. Its module state, its globals, and its thread's copy of `process.env` are not shared with another application, and a redeploy that keeps it isolated restarts only its own thread.

Its REST export registry also belongs to that worker: exports registered by an isolated application are not registered in the shared workers. See [Deploying from CI](/learn/developers/deploying-from-ci#per-pr-previews-with-shared-databases) for isolated deployments and a preview workflow.

Isolation is about the thread, not the data. The application still reads and writes the same databases as everything else on the instance, unless it also declares [`branchedDatabases`](#branched-databases). Users, roles, and sessions stay instance-wide.

#### Reaching an isolated application

The dedicated worker does not listen on Harper's HTTP or MQTT ports. A request to those ports never reaches the application, even one addressed to its `host`: the shared workers answer it, and they do not load the application. The worker listens only on Unix domain sockets of its own, one for each secure port:

```
<rootPath>/sockets/app-<application>-<port>.sock
```

In the socket name, every character of the application name outside `A–Z`, `a–z`, `0–9`, `.` and `_` is percent-encoded, so `shop-preview` becomes `app-shop%2Dpreview-<port>.sock`. The proxy in front terminates TLS. The socket for `http.securePort` serves plain HTTP, and the socket for the MQTT secure port serves MQTT. A `.yaml` file beside each socket names the application, its `host`, and the TLS certificates the proxy needs.

- **On Harper Fabric**, the platform's proxy routes the application's `host` to its socket, by TLS SNI. It does so only for a host name the cluster claims as a [custom domain](/fabric/custom-domains). Because it picks the socket by host name alone, give each isolated application its own `host`, used by no other application. An isolated application with no `host`, or with a host it shares with another application split by `urlPath`, loads and reports healthy, but no request reaches it. Harper does not refuse these configurations yet ([harper#2757](https://github.com/HarperFast/harper/issues/2757)).
- **On a self-managed instance**, Harper does not route to the socket. Run a proxy that terminates TLS and forwards the application's requests to its socket, by host name or however your proxy routes.

#### Requirements and refusals

Harper never loads an isolated application in the shared workers. It refuses the application when the instance cannot give it a reachable worker of its own:

- `threads.count` is `0`, so there is no worker thread to dedicate.
- No `http.securePort` is configured.
- [`tls.unixDomainSockets`](../configuration/options.md#tls) is not enabled.
- The instance runs on Windows.
- The socket path would be longer than the platform allows.
- [`threads.maxIsolated`](../configuration/options.md#threads) isolated applications are already running (default `8`).

The node that receives a `deploy_component` checks these before it deploys, and answers `409` with the reason, such as `Cannot deploy 'shop-preview' as an isolated application: the instance already runs 8 isolated application(s) (threads.maxIsolated)`. It answers `503` if it cannot read which isolated applications are running. The other nodes of a replicated deploy do not check: they record the entry, and a node that cannot run the application reports it as failed in [`get_status`](../operations-api/operations.md#set_status--get_status--clear_status) instead.

At startup or restart, an isolated application that is refused is not loaded anywhere. Harper logs `Application '<name>' is isolated but gets no dedicated worker: <reason>; it is not loaded anywhere`.

#### Restarting and dropping

- **A new isolated application starts at the next restart.** Deploy it with `restart=true`, or restart afterward. That first restart, and any deploy that turns isolation on or off, restarts the shared workers as well as starting or stopping the dedicated one.
- **A redeploy of an application that stays isolated restarts only its own worker.** The other applications keep running. The exception is [retrying an activation](../operations-api/operations.md#retrying-an-activation) whose release is already live, which restarts every worker.
- **`restart_service` can target one isolated application.** `{"operation": "restart_service", "service": "http", "scope": "<application>"}` restarts only that application's worker.
- **`drop_component` without `restart` leaves the dedicated worker running** until the next restart. With `restart=true`, a running isolated application's worker is stopped without restarting the shared workers. Dropping normally reclaims retained installs; inspect node logs if storage cleanup fails. Dropping an already-absent application with `restart=true` can restart the shared workers, so check component files and running workers before retrying. On Pro and Fabric, drops propagate to peers by default; inspect the response's `replicated` results for peer failures.
- **`system_information` shows the dedicated worker.** In its `threads` list, the dedicated worker's entry carries `application: '<name>'`.

Each isolated application adds a worker thread on top of `threads.count`. See [`threads.maxIsolated`](../configuration/options.md#threads) for how that affects memory.

### Branched databases

`branchedDatabases` gives an application a private, durable fork of the databases it names. The application addresses them by their usual names. Its reads and writes go to its fork, and every other application keeps using the base database.

```yaml
# <rootPath>/harper-config.yaml
shop-preview:
  branchedDatabases: [data]
```

The value is a list of database names, or `true` for every database except `system` that exists when the application loads. A database created later is not branched.

:::warning Known issue in v5.3.0 and v5.3.1
`branchedDatabases` takes effect only on an entry without `package`. That is an application in the components root, such as one deployed with a payload. On an entry that has `package` (which every `package` and `by_ref` deploy writes), it is ignored. The application then runs on the base databases, and no error is reported ([harper#3071](https://github.com/HarperFast/harper/issues/3071)).

Until that is fixed, use these manual steps for a new application:

1. Deploy it with a payload, without `restart`.
2. Add `branchedDatabases` to its entry in `harper-config.yaml` **on every node**. The root config is per node. A node without this key runs the application on the base database. Writes made on that node replicate to the whole cluster.
3. Restart each node.
4. On each node, confirm the application's fork directory exists before you write through the application.
   :::

#### What the fork is

- **A snapshot of the base, taken the first time the application loads with the key.** Harper takes a RocksDB checkpoint of the base database, which uses hard links when the fork is on the same filesystem as the base. It captures blob files separately, using hard links too; this is not an atomic snapshot of records and blobs together. Blobs still being written or reclaimed before capture can leave markers in the fork, with warnings in the log and errors when those records are read. Later base writes do not refresh the fork.
- **Durable.** The fork survives restarts and redeploys, and is never refreshed from the base. To start again from the current base, drop the application with `restart=true`, confirm its worker has stopped and its fork directory has been removed on every node, then deploy it again. A failed restart can retain storage even after a successful drop response; reusing the name before removal reuses that fork.
- **Stored beside the base database**, at ``<storage path>/`branches`/<application>/<database>``. With the default storage path, that is ``<rootPath>/database/`branches`/<application>/<database>``. The backticks are part of the directory name, so quote the path with single quotes in a shell, as in ``ls '<rootPath>/database/`branches`/'``; inside double quotes, the shell runs the backticks as a command.
- **Private.** The fork is not added to the instance's list of databases, so other applications, `describe_all`, analytics, and replication do not see it.
- **Local to each node.** In a Harper Pro cluster, each node creates its own fork from its own copy of the base when the application first loads there. Writes to a fork stay on the node that took them. The fork's path is the same on every node.
- **Owns its tables.** A table the application declares in a branched database, through a schema's `@table`, `ensureTable`, or `defineTable`, is created in the fork.

#### Reaching the fork from code

Import `databases` from `harper`, and each branched name on it resolves to the fork. `tables` from `harper` is a shortcut for the default database, `data`, so it reaches a fork only when `data` itself is branched; for any other branched database, go through `databases`. The bare `databases` and `tables` globals are shared by every application in the thread. Code that uses them reads and writes the base database without any warning ([harper#3053](https://github.com/HarperFast/harper/issues/3053)).

With `branchedDatabases: [inventory]`, this is the fork's `Product` table:

```js
import { databases } from 'harper';

const { Product } = databases.inventory;
```

#### Requirements and failure modes

Harper never falls back to the base. An application whose fork cannot be created fails to load instead, with an error that names the reason:

- [`storage.engine`](../configuration/options.md#storage) is `lmdb`. Branching requires RocksDB.
- [`applications.moduleLoader`](../configuration/options.md#applications) is `native`, which cannot give the application its own `databases`.
- A named database does not exist when the application loads.
- `storage.blobPaths` is configured as an empty list, which leaves the fork nowhere to keep blobs.
- `<length of application name>_<application>__<database>` is longer than 250 characters.
- An existing fork directory is damaged. Harper refuses to serve it or rebuild it, since rebuilding would discard the fork's data. Delete the directory to have it recreated from the base.

The value itself is checked when you deploy, and again when the application loads. It must be `true` or a list of distinct database names. `system` cannot be branched, and a name cannot contain `/` or `\` or be `.` or `..`. A `deploy_component` that breaks these rules is refused with a `400`.

#### Removing a fork

`drop_component` with `restart=true` removes the application's forks once the restart has completed. If the restart does not complete, the drop can report success while retaining the forks; check worker state, node logs, and the fork directory before redeploying to refresh data. A replicated drop does this on every node, each removing its own fork. If a fork cannot be removed, the drop fails with an error saying the storage was left in place.

Without `restart`, the forks stay, and the response says so: `Successfully dropped: <name>. Any branched database storage this application owns was left in place; drop it again with restart: true to discard that data`. Running `drop_component` with `restart=true` again removes them. Until then, deploying an application under the same name picks up the old fork, with its data.

## Operations API

Component operations require `super_user`, unless a role's [`operations` allowlist](../users-and-roles/overview.md#operation-permissions) lists them, which is how a deploy-only CI role gets `deploy_component`. A few cannot be granted that way, such as `get_deployment_payload`, and a deploy that passes a literal `token` in `credentials` still needs `super_user`.

### `add_component`

Creates a new component project in the component root directory using a template.

- `project` _(required)_ — Name of the project to create
- `template` _(optional)_ — Git URL of a template repository. Defaults to `https://github.com/HarperFast/application-template`
- `install_command` _(optional)_ — Install command. Defaults to `npm install`
- `install_timeout` _(optional)_ — Install timeout in milliseconds. Defaults to `300000` (5 minutes)
- `install_allow_scripts` _(optional)_ — Allow install scripts to run. Defaults to `false`, which causes `--ignore-scripts` to be passed to the install command (this is ignored with `install_command`).
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
- `restart` _(optional)_ — `true` for immediate restart, `'rolling'` for sequential cluster restart. Either one [certifies the release in a canary worker](../operations-api/operations.md#certifying-a-release-in-a-canary-worker) before rolling it out (v5.4.0), unless the response's `certification` says it went out unchecked
- `replicated` _(optional)_ — On Harper Pro and Fabric, a deploy goes to every node in the cluster unless this is `false`. Harper core on its own does not replicate
- `install_command` _(optional)_ — Install command override
- `install_timeout` _(optional)_ — Install timeout override in milliseconds
- `install_allow_scripts` _(optional)_ — Allow install scripts to run. Defaults to `false`, which causes `--ignore-scripts` to be passed to the install command (this is ignored with `install_command`).

```json
{
	"operation": "deploy_component",
	"project": "my-component",
	"package": "HarperFast/application-template#semver:v1.0.0",
	"replicated": true,
	"restart": "rolling"
}
```

### `drop_component`

Deletes a component project or a specific file within it.

- `project` _(required)_ — Project name
- `file` _(optional)_ — Path relative to project folder. If omitted, deletes the entire project
- `replicated` _(optional)_ — On Harper Pro and Fabric, deletion goes to every cluster node unless this is `false`. Inspect the response's `replicated` results for peer failures
- `restart` _(optional)_ — `true` waits for a restart after dropping. A running isolated application stops only its own worker; an already-absent application can restart shared workers

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

Returns all local component files, folders, and configuration from `harper-config.yaml`. The response includes an `entries` array; each direct child's `name` identifies a component. CI cleanup can inspect `entries[].name` to check whether the project is present on this node.

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
- `key` <VersionBadge type="changed" version="v5.3.0" /> _(required unless `generate` is `true`)_ — Private key contents, with `\n` for line breaks: an unencrypted OpenSSH or PEM private key (Ed25519, ECDSA, or RSA of at least 1024 bits)
- `generate` <VersionBadge version="v5.2.4" /> _(optional)_ — `true` to have Harper mint an ed25519 keypair in place of `key`, returning only the public key; see [Server-side key generation](../operations-api/operations.md#server-side-key-generation-generate)
- `host` <VersionBadge type="changed" version="v5.3.0" /> _(required)_ — Host alias for SSH config (used in `package` URL): a single alias, not a pattern
- `hostname` <VersionBadge type="changed" version="v5.3.0" /> _(required)_ — Actual domain (e.g., `github.com`)
- `known_hosts` _(optional)_ — Public SSH keys of the host. Auto-retrieved for `github.com`
- `replicated` _(optional)_ — Replicate to all cluster nodes

A `key`, `host` or `hostname` that ssh couldn't use is refused with a `400` naming the problem; see [what `key`, `host` and `hostname` must be](../operations-api/operations.md#what-key-host-and-hostname-must-be). Each key's settings live in a block of `<rootPath>/ssh/config` that Harper owns; you can edit the file outside those blocks (see [the key's block in the ssh config](../operations-api/operations.md#the-keys-block-in-the-ssh-config)).

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
