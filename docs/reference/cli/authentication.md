---
title: CLI Authentication
sidebar_position: 40
sidebar_label: 'Authentication'
---

<!-- Source: versioned_docs/version-4.7/deployments/harper-cli.md (primary) -->
<!-- Source: versioned_docs/version-4.4/deployments/harper-cli.md (for baseline features) -->

# CLI Authentication

The Harper CLI handles authentication differently for local and remote operations.

## Local Operations

Available since: v4.1.0

For local operations (operations executed on the same machine where Harper is installed), the CLI communicates with Harper via Unix domain sockets instead of HTTP. Domain socket requests are automatically authorized as a super user, so no additional authentication parameters are required. From v5.4.0, these requests run as the built-in [`local` user](../security/configuration.md#local-request-identity), independently of stored users.

**Example**:

```bash
# No authentication needed for local operations
harper describe_database database=dev
harper get_components
harper set_configuration logging_level=info
```

When no `target` parameter is specified, the CLI falls back to a target set in the environment, then to the target saved by a previous `harper login` if there is one, and only otherwise to the local domain socket connection, which gives authenticated access to the local Harper instance. See [How the CLI Picks a Target](#how-the-cli-picks-a-target), and [Authentication Precedence](#authentication-precedence) for what that means on a shared machine.

## Remote Operations

Available since: v4.1.0; expanded in: v4.3.0

For remote operations (operations executed on a remote Harper instance via the `target` parameter), you must provide authentication credentials.

### How the CLI Picks a Target

The CLI connects to the first of these it finds:

1. `target=<url>` on the command
2. The `HARPER_CLI_TARGET` environment variable, then the legacy `CLI_TARGET`
3. The target saved in `~/.harperdb/credentials.json`
4. The local domain socket

The saved target belongs to your OS user, not to a project: it is the target of your last `harper login`, or of the last saved token the CLI refreshed. A command with no target goes there from any directory, so to keep a project's commands on one cluster, pass `target=` or export `HARPER_CLI_TARGET`. `harper logout <url>` clears the saved target if it is that URL, and `harper logout` with no URL removes every saved login.

### Authentication Precedence

<VersionBadge type="changed" version="v5.2.0" />

For remote Operations API commands, the CLI uses the first complete authentication source in this order:

1. Dedicated `auth_username=` and `auth_password=` command parameters
2. Credentials embedded in the `target` URL
3. `HARPER_CLI_USERNAME` and `HARPER_CLI_PASSWORD` environment variables
4. Legacy `CLI_TARGET_USERNAME` and `CLI_TARGET_PASSWORD` environment variables
5. `HARPER_CLI_OPERATION_TOKEN` and `HARPER_CLI_REFRESH_TOKEN` environment variables, or their legacy `CLI_TARGET_` equivalents — see [Token credentials for CI/CD](#token-credentials-for-cicd)
6. A token saved by `harper login`
7. A [workload identity token](#workload-identity-oidc) exchanged with the runtime's OIDC provider (v5.3.0)
8. `username=` and `password=` operation parameters (legacy fallback)

:::tip
**Configure one credential style per context, not two.** Precedence exists to resolve a conflict, but it resolves it silently, and the ways this page describes for authentication to go wrong all need two styles live at once: a payload `username=`/`password=` pair takes over when a token stops resolving, a blank token variable hands the run to whatever saved login the machine has. Pick one and leave the others unset:

| Context                 | Use                                                                                                              |
| ----------------------- | ---------------------------------------------------------------------------------------------------------------- |
| CI/CD pipeline          | [Workload identity](#workload-identity-oidc) where the runtime supports it; otherwise `HARPER_CLI_REFRESH_TOKEN` |
| A one-off admin command | `auth_username=` / `auth_password=`                                                                              |
| Local development       | `harper login`                                                                                                   |

Setting a token _and_ leaving `username=`/`password=` on the command is the combination that turns a token failure into an identity change rather than an error. One caveat: this rule bounds _which_ credential is used, not what happens when none resolves. A loopback node authorizes a request that arrives with no credential at all as superuser, so the style matters less there than whether a credential is attached — see the refresh-behavior note below.
:::

Credentials are resolved as a pair and are never combined across sources. An incomplete pair supplied with dedicated authentication parameters or in the target URL causes the command to fail. An incomplete environment-variable pair is skipped with a warning so that a saved login token can still be used.

Entry 5 is not a two-step fallback the way 3 and 4 are: whichever token namespace is merely **set** claims the choice, so a blank `HARPER_CLI_REFRESH_TOKEN` shadows a complete `CLI_TARGET_REFRESH_TOKEN` instead of deferring to it — see below.

Entries 5 through 7 authenticate with a bearer token and apply to **remote targets only**. A local operation goes over the domain socket, which the server already trusts — as, by default, it trusts any loopback address, since `authentication.authorizeLocal` defaults to `true`. Token environment variables are deliberately ignored on the socket path — a token minted for one instance would otherwise be attached to every local `harper` command in that shell and rejected. Note what that trust means on a self-hosted runner: an unset or blank `target` does not fail. The CLI falls back to the target saved by a previous `harper login` on that machine, and only if there is none does it go local — where it runs as superuser on the socket's ambient trust, with no credential checked at all. So a job that loses its `HARPER_CLI_TARGET` either deploys to whatever remote that runner last logged into, or to the runner's own node. Neither is an error, and the first is the wider blast radius.

Before v5.2.0, `username=` and `password=` operation parameters took precedence over environment variables and saved login tokens. This could authenticate an operation as the wrong user when those fields were part of the operation payload, such as the user being created by `add_user`.

### Authentication Methods

#### Method 1: Persistent Login (Recommended for Local Development)

Available since: v5.1.0

Use `harper login` to store authentication tokens for a specific target and make it the CLI's saved target. This is the most convenient method for local development as it removes the need to pass credentials with every command.

```bash
# Log in once
harper login https://server.com:9925
# Provide username and password when prompted

# Subsequently execute operations without credentials
harper describe_database database=dev target=https://server.com:9925
harper deploy target=https://server.com:9925

# target= is optional while this is the saved target
harper describe_database database=dev
```

<VersionBadge type="changed" version="v5.4.0" />

`harper login` writes only to `~/.harperdb/credentials.json`, never to a project `.env`. It saves and prints the URL you gave it, in normalized form, never a target named in the server's reply.

When you are finished, you can log out to remove the stored token:

```bash
harper logout https://server.com:9925
```

**Benefits**:

- Credentials are not stored in command history for every operation
- Simplifies frequent remote operations
- No need to maintain environment variables in multiple terminal sessions

A complete environment-variable credential pair takes precedence over a saved login token. Check the [authentication precedence](#authentication-precedence) when environment variables and `harper login` are both configured for the same target.

#### Method 2: Environment Variables (Recommended for CI/CD)

<VersionBadge type="changed" version="v5.2.0" />

The CLI reads these variables from your shell or CI environment. A `.env` file in the current directory cannot set them: see [Project `.env` files](#project-env-files). This is the recommended method for CI/CD pipelines and for pre-populating the `target` parameter for specific projects.

Starting in v5.2.0, a complete environment-variable credential pair takes precedence over a saved login token and the legacy `username=` and `password=` fallback. This makes the configured CI identity authoritative even when the operation payload also contains username or password fields.

**Supported Variables**:

- `HARPER_CLI_TARGET` - Sets the default `target` for CLI commands. `CLI_TARGET` is the legacy equivalent.
- `HARPER_CLI_USERNAME` and `HARPER_CLI_PASSWORD` - Preferred credential pair for the target.
- `CLI_TARGET_USERNAME` and `CLI_TARGET_PASSWORD` - Lower-priority legacy credential pair.
- `HARPER_CLI_REFRESH_TOKEN` - Long-lived token the CLI exchanges for a fresh operation token on each run. `CLI_TARGET_REFRESH_TOKEN` is the legacy equivalent.
- `HARPER_CLI_OPERATION_TOKEN` - A short-lived operation token supplied directly, for callers that mint their own. `CLI_TARGET_OPERATION_TOKEN` is the legacy equivalent.

Each credential namespace is independent. For example, the CLI never combines `HARPER_CLI_USERNAME` with `CLI_TARGET_PASSWORD`. If either namespace supplies only a username or only a password, that incomplete pair is skipped with a warning.

The same rule holds for tokens: whichever namespace supplies a token owns both halves of it, so an operation token from one namespace is never paired with a refresh token from the other.

The namespace is chosen by which one is **set**, not by which one has a usable value — so `HARPER_CLI_REFRESH_TOKEN=` (present but empty) claims the choice and shadows a perfectly good `CLI_TARGET_REFRESH_TOKEN`, which is never consulted. The run then falls through to the saved login token. Unset the preferred variable rather than blanking it.

For a pipeline, a token is the right style: it is scoped to authentication, it can be revoked without changing the account password, and it cannot be used to log in interactively. Use it _instead of_ a password or payload credentials, not alongside them — see [Token credentials for CI/CD](#token-credentials-for-cicd).

**Manual Environment Variables**:

Set these variables in your shell to avoid exposing credentials in command history:

```bash
export HARPER_CLI_TARGET=https://example.com:9925
export HARPER_CLI_USERNAME=HDB_ADMIN
export HARPER_CLI_PASSWORD=password
```

**Benefits**:

- Credentials not visible in command history
- More secure for scripting and CI/CD systems
- Can be set once per session

**Example Script**:

```bash
#!/bin/bash

# Set credentials from secure environment
export HARPER_CLI_USERNAME=HDB_ADMIN
export HARPER_CLI_PASSWORD=$SECURE_PASSWORD  # from secret manager

# Execute operations without passing credentials or target (if set)
harper deploy target=https://prod-server.com:9925 replicated=true
harper restart target=https://prod-server.com:9925 replicated=true

# The environment variables authenticate the admin; username/password remain payload fields.
# NEW_USER_PASSWORD is provided by a secret manager.
harper add_user \
  role=app \
  active=true \
  username=svc_app \
  password="$NEW_USER_PASSWORD" \
  target=https://prod-server.com:9925
```

##### Project `.env` files

<VersionBadge type="changed" version="v5.4.0" />

A `.env` or `.env.vault` file in the current directory cannot configure the CLI's target, credentials or connection trust. That directory is often a cloned project, and a file it ships must not decide where your credentials go ([harper#4001: Refuse a project .env CLI target or credential](https://github.com/HarperFast/harper/pull/4001)).

Every Operations API command, including `harper deploy` and `harper preview`, as well as `harper login` and the backup commands, reads the file first. If it sets one of these names and the shell or CI environment does not, the command stops with an error naming the keys. It stops before contacting a server or touching a file, for local operations too:

| Purpose              | Names, in any letter case                                                                                                                                     |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Target               | `HARPER_CLI_TARGET`, `CLI_TARGET`                                                                                                                             |
| Credentials          | `HARPER_CLI_USERNAME`, `HARPER_CLI_PASSWORD`, `HARPER_CLI_OPERATION_TOKEN`, `HARPER_CLI_REFRESH_TOKEN`, and the same four names with the `CLI_TARGET_` prefix |
| Workload identity    | `ACTIONS_ID_TOKEN_REQUEST_URL`, `ACTIONS_ID_TOKEN_REQUEST_TOKEN`                                                                                              |
| GitHub deploy inputs | `GITHUB_REPOSITORY`, `GITHUB_SHA`, `GITHUB_REF`, `GITHUB_EVENT_PATH`                                                                                          |
| Saved login location | `HOME`, `USERPROFILE`                                                                                                                                         |
| TLS                  | `NODE_TLS_REJECT_UNAUTHORIZED`, `NODE_EXTRA_CA_CERTS`, `SSL_CERT_FILE`, `SSL_CERT_DIR`                                                                        |
| Proxy                | `NODE_USE_ENV_PROXY`, `HTTP_PROXY`, `HTTPS_PROXY`, `NO_PROXY`                                                                                                 |

```text
error: HARPER_CLI_TARGET must not come from a .env or .env.vault file in /path/to/project: a project's .env no longer sets the Harper CLI's target, credentials or connection settings ...
```

- **`target=` does not get past the error.** The line has to leave the file, or the name has to be set in the environment.
- **Shell and CI values win.** When the environment already sets a name, the CLI ignores the file's value and runs. On Linux and macOS the spelling has to match: exporting `HTTPS_PROXY` does not clear `https_proxy` in the file.
- **Other keys still load.** A file with none of these names is applied as before, and `.env.example` and `.env.local` are not read at all.
- **Applications are unaffected.** `.env` handling in `harper run`, `harper dev` and a component's [`loadEnv`](../environment-variables/overview.md) is unchanged. `harper status`, `harper version`, `harper logout`, `harper agent` and `harper mcp` do not read the file.

To migrate a project, remove the listed names from its `.env`. Other names with these prefixes, such as `HARPER_CLI_TIMEOUT_MS`, still load. `npm create harper@latest` writes `HARPER_CLI_TARGET` there, and `harper login` before v5.4.0 could append it. Then choose where the target comes from:

| Route                                        | Scope                                                                                                                                                                    |
| -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `harper login <url>`                         | Your OS user. Later commands use the saved target from any directory, so this suits one cluster at a time.                                                               |
| `target=<url>`                               | One command. To share a target with your team, put it in a `package.json` script: `"deploy": "harper deploy project=my-app target=https://my-cluster.example.com:9925"`. |
| `export HARPER_CLI_TARGET=<url>`             | One shell session, or a CI job through its variables and secrets.                                                                                                        |
| `dotenv -- harper deploy`, from `dotenv-cli` | One script. This hands the CLI every value in the file, including the names above, so use it only on a file you trust.                                                   |

CI that stores `harper login --for-ci` output as secrets is unaffected, because those values reach the job as environment variables. A job that relied on a committed `.env` for its target needs `HARPER_CLI_TARGET` in its environment instead.

If your application reads one of these names at runtime, such as a proxy setting, the CLI still stops when it finds that name in `.env`. Set the name in the process environment, or keep it in a differently named file listed under [`loadEnv`'s `files`](../environment-variables/overview.md).

##### Token credentials for CI/CD

<VersionBadge version="v5.2.0" />

Rather than storing an admin password in your CI provider, log in once locally and hand CI a **refresh token**. The CLI mints a fresh, short-lived operation token from it on every run, so the only durable secret the pipeline holds is a revocable token.

`harper login --for-ci` writes the variables CI needs to **stdout** in `.env` format — and nothing else, so the output pipes cleanly. Everything a human reads (banner, prompts, status, warnings) goes to stderr:

```bash
# Set both GitHub Actions secrets in one command — the token is never displayed
harper login --for-ci | gh secret set --env-file -
```

The block it emits:

```bash
HARPER_CLI_TARGET=https://example.com:9925/
HARPER_CLI_REFRESH_TOKEN=eyJhbGciOi...
```

Because stdout carries only these two lines, piping it into a secret store keeps the token off your screen and out of your shell history. Piping it to the clipboard does not: a clipboard-history tool will keep a copy on disk, and since a user holds exactly one refresh token at a time, that copy is the pipeline's live credential. Pipe it to the thing that will store it — which is not true of copying it out of terminal output by hand. **Pipe it.** There is no guard on a terminal stdout, so running `harper login --for-ci` bare prints the refresh token into your scrollback, where the terminal may persist it. (Interactively the command does first ask you to confirm minting for that user, since doing so revokes any token the user already holds; that prompt is skipped when stdin is not a TTY.) If the cluster returns no refresh token, the command fails rather than emitting a half-block that would "succeed" at storing nothing.

Expose the two values to the deploy step and no other credentials are needed:

```yaml
- name: Deploy
  run: harper deploy project=my-app restart=true replicated=true
  env:
    HARPER_CLI_TARGET: ${{ secrets.HARPER_CLI_TARGET }}
    HARPER_CLI_REFRESH_TOKEN: ${{ secrets.HARPER_CLI_REFRESH_TOKEN }}
```

**Refresh behavior.** The CLI mints an operation token from the refresh token when none is supplied, and again whenever the supplied one has expired. A token refreshed from an environment variable is held in memory for that invocation only — nothing is written to `~/.harperdb/credentials.json`, because there is no file entry for an environment-supplied credential. A refresh token the server rejects as **malformed or unrecognized** answers `401`, and the CLI stops with a non-zero exit and a "run harper login again" message.

:::warning
**An expired refresh token does not stop the command.** Harper answers expiry with `403`, not `401`, and the CLI's halt branch keys on `401` alone. This is a defect rather than intended behavior, tracked as [harper#2297](https://github.com/HarperFast/harper/issues/2297); this note should come out when it is fixed. Expiry is the guaranteed end state of every `--for-ci` token once `refreshTokenTimeout` elapses, so this is the failure a pipeline is most likely to meet, and it takes the continue path below rather than halting.

Do not build a runbook around a non-zero exit at day 31 — watch the operation's own result. That is sufficient for a **remote** target, where removing payload credentials makes expiry fail visibly.

It is not sufficient for a **loopback** target. `authentication.authorizeLocal` defaults to `true` and grants superuser to any request from `127.0.0.1` or `::1`, so an expired token there produces a genuinely successful, fully privileged run — indistinguishable from a correctly authenticated one. No check on the exit code or the result can catch it, because there is nothing failing to observe.

**The fix is configuration, not monitoring**, and it belongs to the node rather than the CLI: local authorization has to be turned off on any Harper instance a CI runner can reach. `authentication.authorizeLocal: false` closes the loopback-TCP path, but it is not the whole story — the operations API domain socket is trusted by a separate rule the flag does not gate, and a same-host reverse proxy makes ordinary remote traffic arrive as loopback. Get the full picture, and the restart requirement, from [`authorizeLocal`](../security/configuration.md#authorizelocal) before relying on any of it.

The point for a pipeline author is narrower: **an expired token against a node with local authorization enabled produces a successful, fully privileged run.** No exit code and no result check can detect it. If you cannot confirm how local authorization is configured on the node you deploy to, do not rely on token expiry surfacing as a failure.
:::

A `403`, and any other refresh failure — a 5xx, a timeout, a connection error — does not stop the command, and what happens next depends on which credentials you supplied:

- **Refresh token only** (what `--for-ci` provisions): no bearer token is attached. Against a remote target the command fails as unauthenticated — unless it also carries `username=` and `password=` operation parameters, in which case it authenticates as that pair instead, a different identity than the one you configured.
- **Refresh token only, against a loopback target**: it does not fail at all. `authentication.authorizeLocal` defaults to `true`, so a request from `127.0.0.1` or `::1` is authenticated as **superuser** with no credential checked. On a self-hosted runner pointed at its own node, an expired token therefore produces a green, fully privileged run rather than an error. This is the failure mode least likely to be noticed.
- **An expired operation token as well**: that token is still attached, so the request carries an `Authorization` header and the server validates it — rejecting it with `403`, since expiry answers `403` on the operations path too. You get a rejection rather than a silent identity switch, but do not alarm on `401` for it.

The difference between those two outcomes is whether an `Authorization` header is sent at all, and it is the hinge for the loopback case above: local authorization is only consulted when a request arrives with **no** credential. A request carrying a token — even an expired one — is validated and rejected on its merits, loopback or not. A request carrying nothing is what a loopback node authorizes as superuser. So the dangerous shape is precisely the refresh-token-only one, where a failed refresh leaves no header to validate.

A `200` response that contains no `operation_token` is not reported at all. A refresh failure therefore does not reliably halt a pipeline, and a zero exit is not proof that the identity you configured is the one that ran.

**A blank token variable is reported, then skipped.** If a namespace is set but empty — the usual shape of a misconfigured CI secret — the CLI warns and continues down the precedence list, so the run proceeds under the saved `harper login` token if that machine has one. Treat that warning as a CI failure signal: a blank secret does not stop the run, it changes which identity performs it.

**Lifetimes.** Operation tokens expire after `authentication.operationTokenTimeout` (default `1d`) and refresh tokens after `authentication.refreshTokenTimeout` (default `30d`). The pipeline needs a new refresh token when that window closes.

:::warning
**Each user holds only one valid refresh token at a time.** Harper stores a single refresh-token hash per user, so minting a new one revokes that user's previous token. A routine local `harper login` as the same account will break a pipeline holding the older token, and the failure only surfaces on the pipeline's next refresh.

Create a **dedicated CI user** and run `harper login --for-ci` as that user. That scopes the pipeline's permissions to what it actually needs, and confines the blast radius of a leak to that account.

There is no operation that revokes a refresh token directly. To invalidate one, either run `harper login --for-ci` again as that user — minting overwrites the stored hash, so the previous token stops working — or deactivate the user with `alter_user`. `harper logout` is not a revocation: it deletes your local copy and leaves the server-side hash valid.
:::

##### Workload identity (OIDC)

<VersionBadge version="v5.3.0" />

On a runner that can prove its own identity, the CLI needs **no stored credential at all**. It asks the runtime for an identity token addressed to your instance and trades it for a one-hour operation token. Nothing durable is stored in your CI provider, and there is no 30-day token to rotate.

Configure the instance to trust the workflow once with [`add_oidc_trust`](../operations-api/operations.md#add_oidc_trust). For a GitHub Actions workflow that deploys from a branch, [`harper deploy setup=true provider=github-actions`](./commands.md#github-actions-deploys-oidc) (v5.4.0) does it in one command: a deploy-only role and user, the policy, and the repository's `HARPER_CLI_TARGET` variable.

###### Using it in a workflow

**Nothing in the workflow names the policy, and no `harper` command takes an option for it.** Once the policy exists, every `harper` command in a job authenticates through it by itself — `harper deploy`, `harper get_job`, or any other operation — when all four of these hold. What each command may then do is up to the role of the user the policy names: one that lists only `deploy_component`, `get_deployment`, `get_job` and `registration_info`, like the role setup creates, refuses anything else with a `403`.

1. **The job may request an identity token.** On GitHub Actions that is `permissions: id-token: write` on the job.
2. **`HARPER_CLI_TARGET` is the policy's `audience`.** The CLI requests its token for the target it connects to, so the target must be the URL the policy names, with its port and trailing slash (`https://my-instance.harperdb.io:9925/`). It is not sensitive, so a repository variable (`vars`) rather than a secret.
3. **The run matches the policy's claims**: its repository, its workflow file and branch, and its environment.
4. **Nothing else is configured to authenticate.** `auth_username=`/`auth_password=`, credentials in the target URL, `HARPER_CLI_USERNAME`/`HARPER_CLI_PASSWORD`, `HARPER_CLI_REFRESH_TOKEN` or `HARPER_CLI_OPERATION_TOKEN` (or their `CLI_TARGET_` forms), and a saved `harper login` all outrank the exchange — see [Authentication Precedence](#authentication-precedence).

For example, this job deploys with nothing but the target:

```yaml
deploy:
  runs-on: ubuntu-latest
  environment: production
  permissions:
    contents: read
    id-token: write
  env:
    HARPER_CLI_TARGET: ${{ vars.HARPER_CLI_TARGET }}
  steps:
    - uses: actions/checkout@v7
      with:
        persist-credentials: false
    - run: npm install --global harper@^5.3
    - run: harper deploy project=my-app restart=rolling
```

It is one job, not a whole workflow. [Deploying from a CI/CD Pipeline](/learn/developers/deploying-from-ci#path-a-deploy-a-tagged-release-from-your-repository) has complete workflows that run as written, including the step that waits for a rolling deploy to reach every node.

Every step in a job with `id-token: write` can request an identity token, not only `harper`: GitHub gives each one `ACTIONS_ID_TOKEN_REQUEST_URL` and `ACTIONS_ID_TOKEN_REQUEST_TOKEN`. So the job above runs none of the repository's code, and `persist-credentials: false` stops `actions/checkout` from saving the job's GitHub token for later steps. Before v6, checkout saved it in `.git/config`, which `harper deploy` uploads with the rest of the checkout. A workflow that installs dependencies or builds should do that in a job without `id-token: write`, as [Path B](/learn/developers/deploying-from-ci#path-b-build-in-ci-publish-to-github-packages-deploy-the-artifact) does.

Harper currently detects GitHub Actions only. Other CI systems expose the same idea differently; on one Harper does not recognize, the CLI falls through to its other credential sources rather than failing.

If your pipeline already sets a token or password, remove it. Leaving it in place is not harmful but it does keep winning — a configured credential outranks the exchange, deliberately, so that enabling this does not silently re-point an existing pipeline at a different user. See [Authentication Precedence](#authentication-precedence) if you need the full order for a mixed setup.

The exchange is attempted only when the runtime actually offers an identity. GitHub Actions sets `ACTIONS_ID_TOKEN_REQUEST_URL` and `ACTIONS_ID_TOKEN_REQUEST_TOKEN` together on a job that declares `id-token: write`; without both, the CLI falls through to its other credential sources rather than reporting a failure. An unrecognized runtime falls through the same way.

On success the CLI prints, to stderr, which policy authenticated it and as whom:

```
Requesting a GitHub Actions identity token for https://my-instance.harperdb.io:9925/...
Authenticated as 'ci-deploy' via OIDC trust policy 'my-app-prod'.
```

If Harper rejects the token, the CLI reports it and carries on rather than aborting. On a workflow configured as above there is nothing left to try, so the operation itself fails with a 401 — but do not treat a rejected exchange as a guaranteed hard stop: if anything else on the runner can authenticate, the command proceeds under that identity instead. [Authentication Precedence](#authentication-precedence) covers those cases.

The server deliberately does not report which check failed — see [`exchange_oidc_token`](../operations-api/operations.md#exchange_oidc_token) — so diagnose with `list_oidc_trust` and the instance's `oidc-trust` log.

#### Method 3: Dedicated Authentication Parameters

<VersionBadge version="v5.2.0" />

Use `auth_username=` and `auth_password=` to authenticate a single command explicitly. These parameters are used only for transport authentication and are not included in the Operations API request body.

```bash
# NEW_USER_PASSWORD is provided by a secret manager.
harper add_user \
  role=app \
  active=true \
  username=svc_app \
  password="$NEW_USER_PASSWORD" \
  target=https://server.com:9925 \
  auth_username=HDB_ADMIN \
  auth_password="$ADMIN_PASSWORD"
```

In this example, `auth_username` and `auth_password` identify the administrator making the request. The plain `username` and `password` fields remain in the `add_user` payload and identify the user being created.

**Authentication Parameters**:

- `auth_username=<username>` - Username used to authenticate the request
- `auth_password=<password>` - Password used to authenticate the request

**Cautions**:

- Credentials visible in command history
- Less secure for production environments
- Exposed in process listings
- For scripts, prefer environment-variable authentication

#### Legacy `username` and `password` Fallback

<VersionBadge type="changed" version="v5.2.0" />

For backward compatibility, the CLI can use `username=` and `password=` as transport credentials when both are present and no higher-priority source is available:

```bash
harper describe_database \
  database=dev \
  target=https://server.com:9925 \
  username=HDB_ADMIN \
  password=password
```

These names are also legitimate payload fields for operations such as `add_user`, `alter_user`, and `create_authentication_tokens`. Use environment variables, a saved login, or the dedicated `auth_` parameters whenever the payload user differs from the user authenticating the request.

### Target Parameter

The `target` parameter specifies the full HTTP/HTTPS URL of the remote Harper instance:

**Format**: `target=<protocol>://<host>:<port>`

**Examples**:

```bash
# HTTPS on default operations API port
target=https://server.example.com:9925

# HTTP (not recommended for production)
target=http://localhost:9925

# Custom port
target=https://server.example.com:8080
```

The target URL can also contain a complete username and password, which the CLI ranks above environment variables:

```bash
target=https://username:password@server.example.com:9925
```

Percent-encode reserved characters in either value (`@` becomes `%40`, for example). Avoid this form when possible: the URL can be exposed in shell history and process listings. Prefer environment variables or a saved login for routine use.

## Security Best Practices

### 1. Use Environment Variables

Always use environment variables for credentials in scripts and automation:

```bash
export HARPER_CLI_USERNAME=HDB_ADMIN
export HARPER_CLI_PASSWORD=$SECURE_PASSWORD
```

### 2. Use HTTPS

Always use HTTPS for remote operations to encrypt credentials in transit:

```bash
# Good
target=https://server.com:9925

# Bad - credentials sent in plain text
target=http://server.com:9925
```

### 3. Manage Secrets Securely

Store credentials in secure secret management systems:

- Environment variables from secret managers (AWS Secrets Manager, HashiCorp Vault, etc.)
- CI/CD secret storage (GitHub Secrets, GitLab CI Variables, etc.)
- Operating system credential stores

**Example with AWS Secrets Manager**:

```bash
#!/bin/bash

# Retrieve credentials from AWS Secrets Manager
export HARPER_CLI_USERNAME=$(aws secretsmanager get-secret-value \
  --secret-id harper-admin-user \
  --query SecretString \
  --output text)

export HARPER_CLI_PASSWORD=$(aws secretsmanager get-secret-value \
  --secret-id harper-admin-password \
  --query SecretString \
  --output text)

# Execute operations
harper deploy target=https://prod.example.com:9925
```

### 4. Use Least Privilege

Create dedicated users with minimal required permissions for CLI operations instead of using the main admin account. See [Users and Roles](../users-and-roles/overview.md) for more information.

### 5. Rotate Credentials

Regularly rotate credentials, especially for automated systems and CI/CD pipelines.

### 6. Audit Access

Monitor and audit CLI operations, especially for production environments. See [Logging](../logging/overview.md) for more information on logging.

## Troubleshooting

### Authentication Failures

If you receive authentication errors:

1. **Verify credentials are correct**:
   - Check username and password
   - Ensure no extra whitespace

2. **Verify the target URL**:
   - Ensure the URL is correct and reachable
   - Check the port number
   - Verify HTTPS/HTTP protocol

3. **Check network connectivity**:

   ```bash
   curl https://server.com:9925
   ```

4. **Verify user permissions**:
   - Ensure the user has permission to execute the operation
   - Check user roles and permissions

5. **Clear or override a stale saved token**:
   - If a token in `~/.harperdb/credentials.json` expires and cannot be refreshed, the command can fail authentication without trying the legacy `username=` and `password=` fallback because the saved token has higher precedence
   - Run `harper logout <target>` and then `harper login <target>` to replace the saved token
   - For a one-off command, use a complete environment-variable pair or provide `auth_username=` and `auth_password=` to take precedence over the saved token

### Environment Variable Issues

If environment variables aren't working:

1. **Verify variables are set**:

   ```bash
   echo $HARPER_CLI_USERNAME
   echo $HARPER_CLI_PASSWORD
   ```

2. **Export variables**:
   Ensure you used `export`, not just assignment:

   ```bash
   # Wrong - variable only available in current shell
   HARPER_CLI_USERNAME=admin

   # Correct - variable available to child processes
   export HARPER_CLI_USERNAME=admin
   ```

3. **Check variable scope**:
   - Variables must be exported before running commands
   - Variables set in one terminal don't affect other terminals

4. **Check for a refused project `.env`**:
   - If the error says a name `must not come from a .env or .env.vault file`, remove that line or set the name in your environment. See [Project `.env` files](#project-env-files)

## See Also

- [CLI Overview](./overview.md) - General CLI information
- [CLI Commands](./commands.md) - Core CLI commands
- [Operations API Commands](./operations-api-commands.md) - Operations available through CLI
- [Security Overview](../security/overview.md) - Harper security features
- [Users and Roles](../users-and-roles/overview.md) - User management
