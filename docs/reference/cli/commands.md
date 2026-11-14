---
title: CLI Commands
sidebar_position: 20
sidebar_label: 'Commands'
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
- On SIGTERM, SIGINT (Ctrl+C) or SIGQUIT, it gives requests in flight a few seconds to finish and closes components before exiting, within [`threads.shutdownTimeout`](../configuration/options.md#shutting-down-on-a-termination-signal) <VersionBadge type="changed" version="v5.4.0" />

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

<VersionBadge version="v5.4.0" /> The CLI also tells Harper where the deploy came from, which the record keeps as its `source`, marked `declared`: on GitHub Actions, the repository, commit, ref, workflow, run and actor from the `GITHUB_*` variables; and for a directory deploy, the checkout's commit and whether the directory had uncommitted changes (`dirty`). A deploy that authenticates through [OIDC](./authentication.md#workload-identity-oidc) records the run's attested claims instead.

#### Parameters

All parameters are passed as `key=value` arguments. Every parameter is optional.

- `project=<name>` - Component project name. Defaults to the current directory's name for a directory deploy, or is derived from the package for a package deploy.
- `package=<reference>` - An npm, GitHub, or tarball reference to deploy instead of the current directory (e.g. `HarperDB/app#semver:v1.0.0`).
- `target=<url>` - Remote Harper instance to deploy to. Omit to deploy to the local instance. A bare host defaults to `https://<host>:9925`.
- `restart=true` or `restart=rolling` - Restart Harper after deploying. Use `rolling` to restart a cluster's nodes one at a time; each node stays in rotation while it restarts. With `rolling`, on a cluster running v5.4.0 or later, the command waits until every node has taken a certified release, unless the result's `certification` is `unavailable`; see [Waiting for a rolling deploy](#waiting-for-a-rolling-deploy). Cannot be combined with `activate=false`.
- `wait=false` - With `restart=rolling`, exit once the node you called has taken the release instead of waiting for the others. (Added in: v5.4.0)
- `wait_timeout=<ms>` - With `restart=rolling`, the longest to wait for the other nodes, in milliseconds. Defaults to ten minutes for each node the deployment record lists. (Added in: v5.4.0)
- `replicated=false` - Deploy to the node you called only. On Harper Pro and Fabric, a deploy goes to every node in the cluster unless you pass this; Harper core on its own does not replicate.
- `install_command=<command>` - Override the install command run for the component.
- `install_timeout=<ms>` - Maximum time, in milliseconds, to allow the install to run.
- `install_allow_scripts=true` - Allow npm pre/post-install scripts to run (disabled by default).
- `deployment_timeout=<ms>` - How long, in milliseconds, a peer waits to receive the replicated payload before failing (default: `120000`). (Added in: v5.1.4)
- `ignore_replication_errors=true` - Treat a peer that fails to receive the deploy as non-fatal instead of failing the whole operation. (Added in: v5.1.4)
- `force=true` - Allow deploying over a protected core component name.
- `urlPath=<path>` - HTTP path the component is mounted at (e.g. `/api/v2`). Before v5.4.0, requires `package`.
- `host=<hostname>` - Virtual hostname the component is served on (e.g. `api.example.com`). Before v5.4.0, requires `package`. (Added in: v5.2.0)
- `isolated=true` - Run the application in a worker thread of its own. See [Isolated applications](../components/applications.md#isolated-applications). Before v5.4.0, requires `package`. (Added in: v5.3.0)
- `branchedDatabases='<json>'` - Give the application a private branch of these databases, as a JSON list, or `true` for all of them. See [Branched databases](../components/applications.md#branched-databases). (Added in: v5.3.0)
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
- `setup=true` - Provision (seal) a durable encrypted credential for a private deploy source instead of deploying; interactive. (Added in: v5.2.3) With `provider=github-actions`, set up [GitHub Actions deploys](#github-actions-deploys-oidc) instead. (Added in: v5.4.0)

#### Waiting for a rolling deploy

<VersionBadge type="changed" version="v5.4.0" />

`harper deploy restart=rolling` starts a job that takes the release to the other nodes one at a time, after the node you called has taken it. On v5.4.0 and later, unless the result's `certification` is `unavailable`, the other nodes only stage the release and the job activates it on each in turn, each certifying it in a [canary worker](../operations-api/operations.md#certifying-a-release-in-a-canary-worker). The deployment record says `rolling_out` until the job has visited every node, then `success`, or `partial` naming the nodes that did not take it.

The command follows that record before it exits. It reads it with `get_deployment` on the same connection and credential the deploy used, prints each node's outcome as it lands, and exits:

- `0` once every node has taken the release;
- non-zero when a node did not take it, naming the node and why, when the deploy otherwise ended `failed`, or when the wait ran out (`wait_timeout=`, ten minutes per node by default), naming the nodes not yet confirmed.

```bash
harper deploy restart=rolling
```

```text
Waiting for the other nodes to take deployment a3f8c2d1-...
  node-b: took the release (certified)
  node-c: did not take the release: my-app was not deployed: release a3f8c2d1-... failed to load in its canary worker: ...
error: Not activated on 1 of 2 peer node(s): node-c (my-app was not deployed: ...)
```

With `json=true`, the printed result also carries `rollout`: the record's final `status`, each node's activation under `nodes`, and its `error`. The result's own `status` stays `rolling_out`, as the deploy answered; `rollout.status` is the outcome. The record replicates, so the wait works through a load-balanced cluster URL. A user whose role has an `operations` allowlist needs `get_deployment` in it, and so does a trust policy scoped with `operations`; a refusal stops the wait at once and says so. A token exchanged through OIDC lasts an hour, longer than the default wait for up to five nodes. `wait=false` exits as soon as the node you called has taken the release.

The command does not wait when the job only restarts the nodes: a deploy whose `certification` is `unavailable`, or one to a cluster running a version before v5.4.0, whose records do not follow the job. Every node has installed the release before the command exits, and the job only restarts them. On v5.4.0 and later, a node that did not restart fails the job, and the job's `result.replicated` says which; see [how a rolling restart reports each node](../operations-api/operations.md#restart_service-replicated). To wait for that job, poll the result's `restartJobId` with `harper get_job` until it ends `COMPLETE` or `ERROR`:

```bash
set -euo pipefail
harper deploy restart=rolling json=true > deploy.json
JOB_ID=$(jq -r '.restartJobId // empty' deploy.json)
[ -n "$JOB_ID" ] || { echo "The rolling deploy returned no restartJobId"; exit 1; }
LAST="could not be read"
for attempt in $(seq 60); do
  sleep 10
  harper get_job id="$JOB_ID" json=true > job.json || continue
  case $(jq -r '.[0].status // "MISSING"' job.json) in
    COMPLETE) exit 0 ;;
    ERROR) jq -r '.[0].message' job.json; exit 1 ;;
    MISSING) LAST="was not on the node that answered; its outcome is unknown" ;;
    *) LAST="was still running" ;;
  esac
done
echo "After 60 polls, job $JOB_ID $LAST"
exit 1
```

The loop retries a poll that fails, such as one that reaches a node while it restarts. Harper does not replicate jobs, so a node other than the one that received the deploy answers `get_job` with an empty list; the loop keeps polling, so through a load-balanced cluster URL at least one poll has to reach that node. If your load balancer sends the polls to a different node than the deploy, use one node's own URL for both, or the loop reports the job's outcome as unknown. A user whose role has an `operations` allowlist needs `get_job` in it to poll. On Harper core alone, a job that only restarts ends `ERROR` with `Replication not implemented`, because it restarts across the cluster. With `restart=true` there is no job: the command fails when a node rejects the release, unless you pass `ignore_replication_errors=true`.

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

<VersionBadge version="v5.4.0" /> With `provider=github` or `provider=npm`, `project` can be a pattern ending in `*`, which grants one credential to every matching component, such as every preview of an application: `harper deploy setup=true provider=github project='my-app-pr-*'`. The secret's name has `_` in place of `*`, as in `deploy.my-app-pr-_.git.github.com`, and a deploy references it by that name with `credentials`, as [`harper preview deploy credential=true`](#harper-preview-deploy) does; `credential=true` on `harper deploy` would derive the one component's name instead.

#### GitHub Actions deploys (OIDC)

<VersionBadge version="v5.4.0" />

`harper deploy setup=true provider=github-actions` sets a cluster up so a GitHub Actions workflow can deploy with its [OIDC identity token](./authentication.md#workload-identity-oidc) instead of a stored credential. Run it once, signed in to the cluster as a `super_user` (`harper login`), from the project's checkout:

```bash
harper deploy setup=true provider=github-actions project=my-app
```

The workflow file defaults to `.github/workflows/deploy.yaml`, the name create-harper projects use. If yours has another name, such as `deploy.yml`, pass it with `workflow=`. Otherwise the policy pins `deploy.yaml`, and the runs of your workflow can't match it:

```bash
harper deploy setup=true provider=github-actions project=my-app workflow=.github/workflows/deploy.yml
```

It needs no secret custody, and it does this:

1. Takes the GitHub repository from the checkout's `origin` remote, or `repo=<owner>/<name>`, and looks it up with the `gh` CLI or GitHub's public API, for its numeric id and for the spelling of its name GitHub uses in the token. When neither answers, such as for a private repository without `gh`, pass the id as `repository_id=<id>` and spell `repo=` as GitHub does; setup says the spelling was not verified.
2. Checks the workflow file, `.github/workflows/deploy.yaml` by default (`workflow=`, a `.yml` or `.yaml` file in `.github/workflows/`): it must be able to run on `main` (`branch=`) and run a job in the `production` environment (`environment=`) with `permissions: id-token: write`. A workflow that could never match or never request a token, such as one whose push filter names only other branches and has no other trigger, one in which no job sets an environment, or one whose job in that environment doesn't grant `id-token: write`, stops setup before it writes anything. What it can't decide, such as a branch pattern, a scheduled or manual trigger, or a reusable workflow, is reported as not verified. So is the whole check when the workflow file isn't in the checkout, or the checkout is of another repository (by its `origin` remote, or `GITHUB_REPOSITORY` when that is set): run setup from the repository's own checkout with the workflow committed, or the policy it writes uses the defaults whether or not they match.
3. Creates a role and a user named `<project>-ci-deploy`, allowed only `deploy_component`, `get_deployment` (what `harper deploy restart=rolling` waits on), `get_job` (for a workflow that polls a rolling deploy's job itself) and `registration_info` (the version check `harper deploy` makes before it uploads), and the trust policy `github-actions-<project>`. The policy's `audience` is the target exactly as the CLI requests its token, and its claims are the repository id, the workflow and branch (`workflow_ref`), and the environment.
4. Reads the policy back and compares it, claim by claim, with what it meant to write.
5. Sets the repository's `HARPER_CLI_TARGET` variable with `gh`, if the repository doesn't have one. One that already names this cluster is left as it is. One that names another cluster is left too, since every workflow in the repository that reads it deploys there: setup prints the command to change it and exits non-zero. Without `gh`, or if the variable can't be read or written, it prints the command to run and exits non-zero.

It only creates. Running it again leaves the cluster and the variable unchanged, and a role, user or policy that already exists but differs, or that someone deactivated or disabled, stops it before it writes, naming what differs. To replace a policy, drop it with `harper drop_oidc_trust id=github-actions-<project>` and run setup again. Because `add_oidc_trust` replaces a policy, setup checks again just before writing it, but a policy with the same id that another super user creates in that moment, enabled or not, would still be overwritten. Setup never writes a policy that already exists, so it can't undo a disable or a drop. It also stops, before and again just before it writes, when another enabled policy could match the same runs and give them a different user or operations, since [the exchange refuses](../operations-api/operations.md#exchange_oidc_token) a token two policies disagree on: give the project its own workflow (`workflow=`) or environment (`environment=`), or drop the other policy.

If the variable wasn't set, the cluster part is already done: run the printed `gh variable set` command, or run setup again, which leaves the cluster as it is and tries the variable again.

The deploy user can deploy any component on the cluster, not only this project, so who can deploy comes down to who can merge to the branch. To revoke, `harper drop_oidc_trust id=github-actions-<project>` stops new runs, and `harper alter_user username=<project>-ci-deploy active=false` also stops a token already issued, which lasts an hour.

The policy pins one branch, so it suits a workflow that deploys when changes merge. A workflow that deploys on tags needs a policy written by hand: see [Deploying from a CI/CD Pipeline](/learn/developers/deploying-from-ci#add-a-trust-policy).

### `harper preview`

<VersionBadge version="v5.4.0" />

Runs a preview of an application for each pull request. `setup` and `teardown` run once per application, from your machine. `deploy`, `drop` and `list` run for each PR, usually from the workflow `setup` writes. [Per-PR previews](/learn/developers/deploying-from-ci#per-pr-previews) walks through the whole flow.

A preview of the application `my-app` for PR `42` is the [isolated application](../components/applications.md#isolated-applications) `my-app-pr-42`. It is served at `<slug>.<domain>`, where the slug comes from the PR's head branch, and on a cluster that supports it, it runs on its own [branch of the databases](../components/applications.md#branched-databases). The cluster drops it when the PR closes, or when it expires.

#### `harper preview setup`

Enables previews of one application on the cluster, and sets up the GitHub side. Run it once, signed in to the cluster as a `super_user` (`harper login`), from a checkout of the application's repository:

```bash
harper preview setup app=my-app target=https://my-cluster.example.com:9925
```

It checks everything it can before it changes anything, so a refusal before step 6 leaves the cluster and the repository as they were.

1. Takes the GitHub repository from the checkout's `origin` remote, or `repo=<owner>/<name>`, and looks it up with the `gh` CLI or GitHub's public API for its numeric id, its default branch, and the spelling of its name that GitHub uses in the token. When neither answers, pass `repository_id=<id>`.
2. Reads the preview workflow, `.github/workflows/preview.yaml`, from the checkout. It refuses a workflow the trust policies could never match, and one that may give the preview identity to a fork or to a PR's own code: see [What setup checks in the workflow](#what-setup-checks-in-the-workflow). If the file doesn't exist, it offers to write the starter workflow (`write_workflow=true` without a prompt). When it can neither check nor write the workflow, such as when it is not run from a checkout of the repository, it stops unless you pass `allow_unverified=true`.
3. For a private repository, offers to seal a credential for the cluster to fetch each PR with (`credential=true`).
4. Reads the repository's `HARPER_PREVIEW_TARGET` variable. One that names another cluster stops setup. One it cannot read, such as when `gh` is not installed, stops it unless you pass `allow_unverified=true`, and you then set the variable yourself afterward.
5. With `credential=true`, asks for the token and checks that the cluster can hold a sealed secret.
6. Calls [`enable_previews`](../operations-api/operations.md#enable_previews), which creates the role, the user and the two trust policies, and stores the application's preview limits.
7. With `credential=true`, seals the token on your machine and grants it to every preview of the application, as the secret `deploy.<app>-pr-_.git.github.com`.
8. Writes the starter workflow, if step 2 said to. Commit it to the default branch: GitHub runs `pull_request_target` workflows from there.
9. Sets `HARPER_PREVIEW_TARGET` to the cluster's URL with `gh`, if the repository doesn't have it.

`enable_previews` only creates. Running setup again with the same arguments leaves the cluster as it is, and one whose records differ from what is already there stops with a `409` that names each difference. To change the limits, run `harper preview teardown`, then setup again.

| Parameter                   | Default                                      | Description                                                                                                                                                                                                                             |
| --------------------------- | -------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `app=<component>`           | required                                     | The application to preview. Its previews deploy as `<app>-pr-<n>`.                                                                                                                                                                      |
| `target=<url>`              | your login's target                          | The cluster. Its URL, with port and trailing slash, is the trust policies' `audience` and the value of `HARPER_PREVIEW_TARGET`.                                                                                                         |
| `repo=<owner>/<name>`       | the checkout's `origin`                      | The GitHub repository.                                                                                                                                                                                                                  |
| `repository_id=<id>`        | looked up                                    | The repository's numeric id, for when setup can't look it up (`gh api repos/<owner>/<name> --jq .id`).                                                                                                                                  |
| `branch=<name>`             | the repository's default branch, else `main` | The branch the workflow runs from. The trust policies pin the workflow at this branch.                                                                                                                                                  |
| `workflow=<path>`           | `.github/workflows/preview.yaml`             | The workflow file, a `.yml` or `.yaml` file in `.github/workflows/`.                                                                                                                                                                    |
| `environment=<name>`        | `preview`                                    | The GitHub environment of the deploy job. The cleanup job's is always `preview-cleanup`.                                                                                                                                                |
| `domain=<domain>`           | `app.<target host>`                          | The domain every preview host sits one label under. Required when the target is an IP address or `localhost`.                                                                                                                           |
| `dataMode=branched\|shared` | `branched`                                   | `branched` requires each preview to run on its own branch of the databases. `shared` lets previews use the cluster's databases, and the starter workflow then deploys with `branchedDatabases=false`.                                   |
| `maxPreviews=<n>`           | `deployment.previews.maxPerApplication`      | How many previews of the application each node keeps live at once. A deploy past it is refused. Without it, the node's [`deployment.previews.maxPerApplication`](../configuration/options.md#deployment) applies, which has no default. |
| `maxTtlDays=<days>`         | `7`                                          | The longest a preview may live after its last deploy. A later expiry is lowered to it.                                                                                                                                                  |
| `credential=true`           | asked, for a private repository              | Seal a GitHub token for the cluster to fetch each PR's commit with.                                                                                                                                                                     |
| `write_workflow=true`       | asked                                        | Write the starter workflow when the file doesn't exist.                                                                                                                                                                                 |
| `allow_unverified=true`     | `false`                                      | Go on when setup cannot check the workflow or the repository variable, or when the workflow has a step it cannot verify. Check the workflow yourself first: it is what keeps forks and PR code from the token.                          |

##### What setup checks in the workflow

The trust policies pin the workflow file at the default branch, `pull_request_target`, and an environment, so a PR cannot change what runs with the preview identity. Whatever that workflow does with the identity is up to the file, so setup reads it first.

It looks only at the jobs that hold the token, those with `permissions: id-token: write`, and at reusable-workflow jobs. It refuses, whatever you pass:

- a workflow that cannot match the trust policies: no `pull_request_target` trigger, a branch filter that leaves out the default branch, no job in the `preview` environment with `id-token: write`, or a job in `preview-cleanup` without it;
- a job that a fork's PR could run: one with no condition such as `github.event.pull_request.head.repo.full_name == github.repository` on it;
- a job that checks out or fetches the PR's head where the file shows the head outright: `gh pr checkout`, or a `git` checkout, switch, fetch, pull, worktree, clone or reset, or an `actions/checkout` `ref` or `repository`, that names the head on its own line, or through a variable whose `env:` value names it and that no script in the job could change.

It stops unless you pass `allow_unverified=true` for what it cannot decide: a same-repository condition in a form it doesn't recognize, or one inherited through `needs`; a head reached through a shell variable, and any `run` step with `git` fetch or checkout code that also takes any input (`$`, a backtick, `<`, `|` or `xargs`), even one that fetches only the base branch; an `actions/checkout` `ref` or `repository` given as an expression; and a reusable-workflow job. It also notes, without stopping, a workflow whose cleanup may not run for a closed PR: one with no job in `preview-cleanup`, one whose `types` leave out `closed`, or one whose cleanup job's condition, or that of a job it needs, excludes `closed` or says more than setup can read. A test that `HARPER_PREVIEW_TARGET` is set, such as `vars.HARPER_PREVIEW_TARGET != ''`, counts as true there, since setup sets that variable: a workflow can use it to stay dormant until setup runs.

The check reads the workflow file only. It does not read scripts or local actions the workflow runs, and a head commit fetched without `git`, such as a downloaded tarball, is not caught.

#### `harper preview teardown`

```bash
harper preview teardown app=my-app
```

Calls [`disable_previews`](../operations-api/operations.md#disable_previews): it revokes the preview identity by dropping its trust policies and deactivating its user, drops every preview of the application on every node, then removes the user and the role, and prints what each node dropped. If a node fails or does not answer, it stops with the identity revoked; run it again to finish, which you have to before setup can enable previews again. It leaves the GitHub side as it is: the workflow file, the `HARPER_PREVIEW_TARGET` variable, and the GitHub environments. A credential setup sealed is left in the secrets store too; remove it with [`delete_secret`](../operations-api/operations.md#delete_secret).

#### `harper preview deploy`

Deploys or updates the preview of one PR. This is what [`HarperFast/deploy-action`](https://github.com/HarperFast/deploy-action) and the starter workflow run, as the preview user:

```bash
harper preview deploy app=my-app pr=42 branch=fix/cart by_ref=true ref=<head commit>
```

`app`, `pr` and `branch` are required. Every argument other than the ones below goes to [`deploy_component`](../operations-api/operations.md#deploy_component) as it does for [`harper deploy`](#harper-deploy), such as `by_ref`, `ref`, `package`, `credentials` and `restart`. With neither `by_ref` nor `package`, it packages and uploads the current directory. With `by_ref=true` on `pull_request_target`, always pass `ref=` the PR's head commit: without it, `by_ref` deploys `GITHUB_SHA`, which for that event is the base branch's commit.

| Parameter           | Default                    | Description                                                                                                                                               |
| ------------------- | -------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `app=<component>`   | required                   | The application. The preview deploys as `<app>-pr-<pr>`.                                                                                                  |
| `pr=<n>`            | required                   | The PR number.                                                                                                                                            |
| `branch=<name>`     | required                   | The PR's head branch, which names the preview's host.                                                                                                     |
| `domain=<domain>`   | `app.<target host>`        | The preview host's domain: the one setup used, or the cluster refuses the deploy. Required when the target is an IP address or `localhost`.               |
| `label=<label>`     | none                       | One DNS label of up to 20 characters added to the end of the slug, such as the application's name, for a cluster that previews more than one application. |
| `ttl=<days>`        | `7`                        | Days until the cluster expires the preview. The application's `maxTtlDays` lowers it.                                                                     |
| `repository=<name>` | `GITHUB_REPOSITORY`        | Recorded with the preview.                                                                                                                                |
| `sha=<commit>`      | `ref`, when it is a commit | Recorded with the preview.                                                                                                                                |
| `credential=true`   | none                       | Fetch a private repository with the credential `harper preview setup credential=true` sealed for every preview of the application.                        |
| `isolated`          | `true`                     | Previews are isolated applications.                                                                                                                       |
| `branchedDatabases` | `true`                     | Every database except `system` is branched. `branchedDatabases=false` shares the cluster's databases, which a role made with `dataMode=branched` refuses. |
| `restart`           | `true`                     | Restarts the preview's own worker.                                                                                                                        |
| `check=false`       | checked                    | Skip the check below.                                                                                                                                     |

The slug is the branch name as one lowercase DNS label: anything outside `a`–`z` and `0`–`9` becomes `-`, runs of them collapse, and leading and trailing `-` are trimmed. A slug longer than 40 characters is cut, and ends in a 6-character hash of the branch name so two long branches stay apart. An empty slug, or one of `www`, `dev`, `stage`, `staging`, `prod`, `production`, `api`, `app`, `admin`, `mail` or `test`, becomes `pr-<n>`. So `fix/Cart` for PR `42` is served at `fix-cart.<domain>`. When another preview already has that host, `-pr<n>` is added; when that is taken too, the deploy stops and asks for `label=`.

The command sends the deploy with a [`preview`](../operations-api/operations.md#preview-deployments) record of the app, the PR, the branch, the repository and commit, and `expiresAt`. A redeploy replaces the record, so each deploy starts the expiry again.

After the deploy, it checks for up to 30 seconds that `https://<host>/` answers from the preview itself, and prints a warning if not; it never fails the command. The warning says why: the host has no DNS record; the certificate doesn't cover it, as on a Fabric instance whose certificate has not yet gained the `*.app.` wildcard; the request reached Harper's shared port rather than the preview's own worker, which means the proxy in front does not route preview hosts to isolated applications, or the worker is still starting; or the host answered `502` or `504`, or `503` from a proxy, which either the preview sent itself or a proxy sent because it does not route the host to the preview.

#### `harper preview drop`

```bash
harper preview drop app=my-app pr=42
```

Sends [`drop_component`](../components/applications.md#drop_component) for `<app>-pr-<pr>`, whether or not the preview is listed, since a drop also stops a leftover worker and removes branches a failed drop left behind. `restart=` and `keepBranches=` are passed through. A drop of a preview that a deploy is still activating answers `409`; the starter workflow's cleanup job retries it.

#### `harper preview list`

```bash
harper preview list app=my-app
```

Lists the cluster's previews, one per line: the component, its PR, branch and commit, its URL, and when it expires. `app=` keeps only that application's previews. Run as the preview user, it lists only the previews that user's role covers.

### `harper restart`

Available since: v4.1.0

Restart a running Harper instance regardless if its a foreground (`harper`, `harper run`, or `harper dev`) or background (`harper start`) process.

```bash
harper restart
```

<VersionBadge type="changed" version="v5.4.0" />

`harper restart` sends the running instance the [`restart`](../operations-api/operations.md#restart) operation over its local domain socket, and prints the reply once the instance accepts it. It returns `0` when the restart has been accepted, before the replacement process is ready. A foreground instance's process exits and Harper continues in the background. When no Harper is running for the root path, `harper restart` starts one, as [`harper start`](#harper-start) does.

If the running instance cannot be reached, has no domain socket, or refuses the restart, `harper restart` prints the error and returns `1`. Before v5.4.0, `harper restart` never reached a running instance: it printed that a restart was under way, then exited `4` with `Harper is already running`.

Without `target=`, `harper restart` always acts on the local instance. It ignores `HARPER_CLI_TARGET`, `CLI_TARGET` and the target saved by `harper login`, which other CLI operations use. To restart a remote instance, name it:

```bash
harper restart target=https://server.com:9925
```

That restarts the one instance, and `harper restart replicated=true` returns `1` without restarting anything. To restart every node in a cluster one at a time, use [`restart_service`](../operations-api/operations.md#restart_service-replicated) with `replicated=true`:

```bash
harper restart_service service=http_workers replicated=true target=https://server.com:9925
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

<VersionBadge type="changed" version="v5.4.0" />

`harper stop` sends Harper SIGTERM and waits for the process to exit. Harper [shuts down gracefully](../configuration/options.md#shutting-down-on-a-termination-signal) first, within `threads.shutdownTimeout`. Until the process exits, [`hdb.pid`](./overview.md#process-id-file) stays in `<rootPath>` and [`harper status`](#harper-status) reports Harper as running. When `harper stop` has signaled a running Harper and returns `0`, Harper has exited and closed its databases.

`harper stop` also prints `Stopping Harper.` and returns `0` when it finds no running Harper to signal, for example when `ROOTPATH` names a different installation. Check that the process is gone before touching database files.

If Harper is still running `threads.shutdownTimeout` + 60 seconds after the signal, `harper stop` prints an error naming the PID and exits with code `1`. It does not kill the process. Running `harper stop` again sends a second signal, which makes Harper exit at once. `harper stop` reads `threads.shutdownTimeout` from the configuration file and cannot see the 30-second default of a running `harper dev`, so for that server it gives up after 8 + 60 seconds unless the value is set.

Before v5.4.0, `harper stop` signals Harper and returns without waiting for it to exit, and Harper removes `hdb.pid` as it begins shutting down, so `harper status` can report `stopped` while Harper is still closing databases. On those versions, capture the PID before stopping Harper and wait for the process itself to exit before touching database or backup files. This also works on v5.4.0 and later:

```bash
# For rootPath ~/hdb
HARPER_PID=$(cat ~/hdb/hdb.pid)
harper stop
while kill -0 "$HARPER_PID" 2>/dev/null; do sleep 1; done
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

From v5.4.0, `harper status` reports Harper as running until the process exits, including while it [shuts down](../configuration/options.md#shutting-down-on-a-termination-signal) after `harper stop`. <VersionBadge type="changed" version="v5.4.0" />

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
