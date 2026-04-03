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

### Authentication Methods

#### Method 1: Environment Variables (Recommended)

Set the following environment variables to avoid exposing credentials in command history:

```bash
export CLI_TARGET_USERNAME=HDB_ADMIN
export CLI_TARGET_PASSWORD=password
```

Then execute remote operations without including credentials in the command:

```bash
harper describe_database database=dev target=https://server.com:9925
harper get_components target=https://remote-instance.example.com:9925
```

**Benefits**:

- Credentials not visible in command history
- More secure for scripting
- Can be set once per session
- Supported by most CI/CD systems

**Example Script**:

```bash
#!/bin/bash

# Set credentials from secure environment
export CLI_TARGET_USERNAME=HDB_ADMIN
export CLI_TARGET_PASSWORD=$SECURE_PASSWORD  # from secret manager

# Execute operations
harper deploy target=https://prod-server.com:9925 replicated=true
harper restart target=https://prod-server.com:9925 replicated=true
```

#### Method 2: Command Parameters

Provide credentials directly as command parameters:

```bash
harper describe_database \
  database=dev \
  target=https://server.com:9925 \
  username=HDB_ADMIN \
  password=password
```

**Parameters**:

- `username=<username>` - Harper admin username
- `password=<password>` - Harper admin password

**Cautions**:

- Credentials visible in command history
- Less secure for production environments
- Exposed in process listings
- Not recommended for scripts

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

## Security Best Practices

### 1. Use Environment Variables

Always use environment variables for credentials in scripts and automation:

```bash
export CLI_TARGET_USERNAME=HDB_ADMIN
export CLI_TARGET_PASSWORD=$SECURE_PASSWORD
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
export CLI_TARGET_USERNAME=$(aws secretsmanager get-secret-value \
  --secret-id harper-admin-user \
  --query SecretString \
  --output text)

export CLI_TARGET_PASSWORD=$(aws secretsmanager get-secret-value \
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

### Environment Variable Issues

If environment variables aren't working:

1. **Verify variables are set**:

   ```bash
   echo $CLI_TARGET_USERNAME
   echo $CLI_TARGET_PASSWORD
   ```

2. **Export variables**:
   Ensure you used `export`, not just assignment:

   ```bash
   # Wrong - variable only available in current shell
   CLI_TARGET_USERNAME=admin

   # Correct - variable available to child processes
   export CLI_TARGET_USERNAME=admin
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
