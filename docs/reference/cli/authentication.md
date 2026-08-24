---
title: CLI Authentication
---

<!-- Source: versioned_docs/version-4.7/deployments/harper-cli.md (primary) -->
<!-- Source: versioned_docs/version-4.4/deployments/harper-cli.md (for baseline features) -->

# CLI Authentication

The Harper CLI handles authentication differently for local and remote operations.

## Local Operations

Available since: v4.1.0

For local operations (operations executed on the same machine where Harper is installed), the CLI communicates with Harper via Unix domain sockets instead of HTTP. Domain socket requests are automatically authenticated as the superuser, so no additional authentication parameters are required.

**Example**:

```bash
# No authentication needed for local operations
harper describe_database database=dev
harper get_components
harper set_configuration logging_level=info
```

When no `target` parameter is specified, the CLI defaults to using the local domain socket connection, providing secure, authenticated access to the local Harper instance.

## Remote Operations

Available since: v4.1.0; expanded in: v4.3.0

For remote operations (operations executed on a remote Harper instance via the `target` parameter), you must provide authentication credentials.

### Authentication Precedence

<VersionBadge type="changed" version="v5.2.0" />

For remote Operations API commands, the CLI uses the first complete authentication source in this order:

1. Dedicated `auth_username=` and `auth_password=` command parameters
2. Credentials embedded in the `target` URL
3. `HARPER_CLI_USERNAME` and `HARPER_CLI_PASSWORD` environment variables
4. Legacy `CLI_TARGET_USERNAME` and `CLI_TARGET_PASSWORD` environment variables
5. `HARPER_CLI_OPERATION_TOKEN` and `HARPER_CLI_REFRESH_TOKEN` environment variables, or their legacy `CLI_TARGET_` equivalents — see [Token credentials for CI/CD](#token-credentials-for-cicd)
6. A token saved by `harper login`
7. `username=` and `password=` operation parameters (legacy fallback)

Credentials are resolved as a pair and are never combined across sources. An incomplete pair supplied with dedicated authentication parameters or in the target URL causes the command to fail. An incomplete environment-variable pair is skipped with a warning so that a saved login token can still be used.

Entries 5 and 6 authenticate with a bearer token and apply to **remote targets only**. A local operation goes over the domain socket, which the server already trusts, so token environment variables are deliberately ignored there — a token minted for one instance would otherwise be attached to every local `harper` command in that shell and rejected.

Before v5.2.0, `username=` and `password=` operation parameters took precedence over environment variables and saved login tokens. This could authenticate an operation as the wrong user when those fields were part of the operation payload, such as the user being created by `add_user`.

### Authentication Methods

#### Method 1: Persistent Login (Recommended for Local Development)

Available since: v5.1.0

Use `harper login` to store authentication tokens for a specific target. This is the most convenient method for local development as it removes the need to pass credentials with every command.

```bash
# Log in once
harper login https://server.com:9925
# Provide username and password when prompted

# Subsequently execute operations without credentials
harper describe_database database=dev target=https://server.com:9925
harper deploy target=https://server.com:9925
```

When you are finished, you can log out to remove the stored token:

```bash
harper logout https://server.com:9925
```

**Benefits**:

- Credentials are not stored in command history for every operation
- Simplifies frequent remote operations
- No need to maintain environment variables in multiple terminal sessions

A complete environment-variable credential pair takes precedence over a saved login token. Check the [authentication precedence](#authentication-precedence) when a project `.env` file and `harper login` are both configured for the same target.

#### Method 2: Environment Variables (Recommended for CI/CD)

<VersionBadge type="changed" version="v5.2.0" />

The CLI supports loading environment variables from your shell environment (or optionally from a `.env` file in the current directory). This is the recommended method for CI/CD pipelines and for pre-populating the `target` parameter for specific projects.

Starting in v5.2.0, a complete environment-variable credential pair takes precedence over a saved login token and the legacy `username=` and `password=` fallback. This makes the configured CI identity authoritative even when the operation payload also contains username or password fields.

**Supported Variables**:

- `HARPER_CLI_TARGET` - Sets the default `target` for CLI commands. `CLI_TARGET` is the legacy equivalent.
- `HARPER_CLI_USERNAME` and `HARPER_CLI_PASSWORD` - Preferred credential pair for the target.
- `CLI_TARGET_USERNAME` and `CLI_TARGET_PASSWORD` - Lower-priority legacy credential pair.
- `HARPER_CLI_REFRESH_TOKEN` - Long-lived token the CLI exchanges for a fresh operation token on each run. `CLI_TARGET_REFRESH_TOKEN` is the legacy equivalent.
- `HARPER_CLI_OPERATION_TOKEN` - A short-lived operation token supplied directly, for callers that mint their own.

Each credential namespace is independent. For example, the CLI never combines `HARPER_CLI_USERNAME` with `CLI_TARGET_PASSWORD`. If either namespace supplies only a username or only a password, that incomplete pair is skipped with a warning.

The same rule holds for tokens, and for the same reason: whichever namespace supplies a token owns both halves of it. If `HARPER_CLI_OPERATION_TOKEN` were allowed to pair with `CLI_TARGET_REFRESH_TOKEN`, commands would run as the first identity until its operation token expired and then silently continue as the second.

The namespace is chosen by which one is **set**, not by which one has a usable value — so `HARPER_CLI_REFRESH_TOKEN=` (present but empty) claims the choice and shadows a perfectly good `CLI_TARGET_REFRESH_TOKEN`, which is never consulted. The run then falls through to the saved login token. Unset the preferred variable rather than blanking it.

For a pipeline, prefer a token over `HARPER_CLI_PASSWORD`: it is scoped to authentication, it can be revoked without changing the account password, and it cannot be used to log in interactively. See [Token credentials for CI/CD](#token-credentials-for-cicd).

**Example `.env` file**:

```bash
HARPER_CLI_TARGET=https://example.com:9925
HARPER_CLI_USERNAME=HDB_ADMIN
HARPER_CLI_PASSWORD=password
```

**Manual Environment Variables**:

Set these variables in your shell to avoid exposing credentials in command history:

```bash
export HARPER_CLI_USERNAME=HDB_ADMIN
export HARPER_CLI_PASSWORD=password
```

**Benefits**:

- Credentials not visible in command history
- More secure for scripting and CI/CD systems
- Can be set once per session or project directory

**Automatic `.env` Updates**:

When you run `harper login <URL>`, the CLI will automatically update your `.env` file in your current directory and set `HARPER_CLI_TARGET` to the specified URL.

```bash
# Automatically sets HARPER_CLI_TARGET in .env
harper login https://my-project.harperdb.cloud
```

Then you can run commands without specifying the `target` or credentials (if they are also in `.env` or exported):

```bash
# Respects HARPER_CLI_TARGET from .env
harper deploy
harper describe_database database=dev
harper get_components
harper logout
```

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

##### Token credentials for CI/CD

<VersionBadge version="v5.2.0" />

Rather than storing an admin password in your CI provider, log in once locally and hand CI a **refresh token**. The CLI mints a fresh, short-lived operation token from it on every run, so the only durable secret the pipeline holds is a revocable token.

`harper login --for-ci` writes the variables CI needs to **stdout** in `.env` format — and nothing else, so the output pipes cleanly. Everything a human reads (banner, prompts, status, warnings) goes to stderr:

```bash
# Set both GitHub Actions secrets in one command — the token is never displayed
harper login --for-ci | gh secret set --env-file -

# Or copy them to the clipboard to paste in by hand
harper login --for-ci | pbcopy
```

The block it emits:

```bash
HARPER_CLI_TARGET=https://example.com:9925/
HARPER_CLI_REFRESH_TOKEN=eyJhbGciOi...
```

Because stdout carries only these two lines, the token never appears on screen or in your shell history — which is not true of copying it out of terminal output by hand. If the cluster returns no refresh token, the command fails rather than emitting a half-block that would "succeed" at storing nothing.

Expose the two values to the deploy step and no other credentials are needed:

```yaml
- name: Deploy
  run: harper deploy project=my-app restart=true replicated=true
  env:
    HARPER_CLI_TARGET: ${{ secrets.HARPER_CLI_TARGET }}
    HARPER_CLI_REFRESH_TOKEN: ${{ secrets.HARPER_CLI_REFRESH_TOKEN }}
```

**Refresh behavior.** The CLI mints an operation token from the refresh token when none is supplied, and again whenever the supplied one has expired. A token refreshed from an environment variable is held in memory for that invocation only — nothing is written to `~/.harperdb/credentials.json`, because there is no file entry for an environment-supplied credential. A refresh token the server rejects as expired or invalid (401) stops the command with a non-zero exit and a "run harper login again" message. Any _other_ refresh failure — a 5xx, a timeout, a connection error — is only reported: the command carries on with no bearer token, so it either fails as unauthenticated or, if it happens to carry `username=` and `password=` operation parameters, authenticates as that pair instead. Don't rely on a refresh failure to halt a pipeline.

**A blank token variable is reported, then skipped.** If a namespace is set but empty — the usual shape of a misconfigured CI secret — the CLI warns and continues down the precedence list, so the run proceeds under the saved `harper login` token if that machine has one. The warning is the only thing separating this from silently deploying as whoever last logged in, so treat it as a failure signal in CI rather than assuming a blank secret stops the run.

**Lifetimes.** Operation tokens expire after `authentication.operationTokenTimeout` (default `1d`) and refresh tokens after `authentication.refreshTokenTimeout` (default `30d`). The pipeline needs a new refresh token when that window closes.

:::warning
**Each user holds only one valid refresh token at a time.** Harper stores a single refresh-token hash per user, so minting a new one revokes that user's previous token. A routine local `harper login` as the same account will break a pipeline holding the older token, and the failure only surfaces on the pipeline's next refresh.

Create a **dedicated CI user** and run `harper login --for-ci` as that user. That scopes the pipeline's permissions to what it actually needs, and lets you revoke its access without disturbing anyone else.
:::

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

Percent-encode reserved characters in either value (`@` becomes `%40`, for example). Avoid this form when possible: the URL can be exposed in shell history and process listings, and `harper login` can save its target to the project `.env` file. Prefer environment variables or a saved login for routine use.

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

## See Also

- [CLI Overview](./overview.md) - General CLI information
- [CLI Commands](./commands.md) - Core CLI commands
- [Operations API Commands](./operations-api-commands.md) - Operations available through CLI
- [Security Overview](../security/overview.md) - Harper security features
- [Users and Roles](../users-and-roles/overview.md) - User management
