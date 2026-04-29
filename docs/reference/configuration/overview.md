---
title: Configuration Overview
---

<!-- Source: versioned_docs/version-4.7/deployments/configuration.md (primary) -->
<!-- Source: release_notes/4.7.2.md (confirmed HARPER_DEFAULT_CONFIG and HARPER_SET_CONFIG introduction) -->

# Configuration

Harper is configured through a [YAML](https://yaml.org/) file called `harper-config.yaml` located in the Harper root directory. By default the root directory is a folder named `hdb` in the home directory of the current user.

Some configuration values are pre-populated in the config file on install, regardless of whether they are used.

For a complete reference of all available configuration options, see [Configuration Options](./options.md).

---

## The Configuration File

To change a configuration value, edit `harper-config.yaml` and save. **Harper must be restarted for changes to take effect.**

Configuration keys use camelCase (e.g. `operationsApi`). Nested keys use dot notation conceptually (e.g. `operationsApi.network.port`).

---

## Setting Configuration Values

All configuration values can be set through four mechanisms:

### 1. YAML File (direct edit)

Edit `harper-config.yaml` directly:

```yaml
http:
  port: 9926
logging:
  level: warn
```

### 2. Environment Variables

Map YAML keys to `SCREAMING_SNAKE_CASE`. Use underscores for nesting. Keys are case-insensitive.

Examples:

- `http.port` → `HTTP_PORT=9926`
- `logging.rotation.enabled` → `LOGGING_ROTATION_ENABLED=false`
- `operationsApi.network.port` → `OPERATIONSAPI_NETWORK_PORT=9925`

```bash
HTTP_PORT=9926 harper
```

> **Note:** Component configuration cannot be set via environment variables or CLI arguments.

### 3. CLI Arguments

Same naming convention as environment variables, prefixed with `--`:

```bash
harper --HTTP_PORT 9926 --LOGGING_LEVEL warn
```

### 4. Operations API

Use `set_configuration` with underscore-separated key paths:

```json
{
	"operation": "set_configuration",
	"http_port": 9926,
	"logging_level": "warn"
}
```

See [Configuration Operations](./operations.md) for the full `set_configuration` and `get_configuration` API reference.

---

## Custom Config File Path

To specify a custom config file location at install time, use the `HDB_CONFIG` variable:

```bash
# Use a custom config file path
HDB_CONFIG=/path/to/custom-config.yaml harper

# Install over an existing config
HDB_CONFIG=/existing/rootpath/harper-config.yaml harper
```

---

## Environment Variable-Based Configuration

<VersionBadge version="v4.7.2" />

Harper provides two special environment variables for managing configuration across deployments: `HARPER_DEFAULT_CONFIG` and `HARPER_SET_CONFIG`. Both accept JSON-formatted configuration that mirrors the structure of `harper-config.yaml`.

```bash
export HARPER_DEFAULT_CONFIG='{"http":{"port":8080},"logging":{"level":"info"}}'
export HARPER_SET_CONFIG='{"authentication":{"enabled":true}}'
```

### HARPER_DEFAULT_CONFIG

Provides default configuration values while respecting user modifications. Ideal for supplying sensible defaults without preventing administrators from customizing their instances.

**At installation time:**

- Overrides template default values
- Respects values set by `HARPER_SET_CONFIG`
- Respects values from existing config files (when using `HDB_CONFIG`)

**At runtime:**

- Only updates values it originally set
- Detects and respects manual user edits to the config file
- When a key is removed from the variable, the original value is restored

**Example:**

```bash
export HARPER_DEFAULT_CONFIG='{"http":{"port":8080},"logging":{"level":"info"}}'
harper

# If an administrator manually changes the port to 9000, Harper will
# detect this edit and respect it on subsequent restarts.

# If http.port is removed from HARPER_DEFAULT_CONFIG later,
# the port reverts to the original template default (9926).
```

### HARPER_SET_CONFIG

Forces configuration values that cannot be overridden by user edits. Designed for security policies, compliance requirements, or critical operational settings.

**At runtime:**

- Always overrides all other configuration sources
- Takes precedence over user edits, file values, and `HARPER_DEFAULT_CONFIG`
- When a key is removed from the variable, it is deleted from the config (not restored)

**Example:**

```bash
export HARPER_SET_CONFIG='{"authentication":{"enabled":true},"logging":{"level":"error","stdStreams":true}}'
harper

# Any change to these values in harper-config.yaml will be
# overridden on the next restart.
```

### Combining Both Variables

```bash
# Provide sensible defaults (can be overridden by admins)
export HARPER_DEFAULT_CONFIG='{"http":{"port":8080,"cors":true},"logging":{"level":"info"}}'

# Enforce critical settings (cannot be changed)
export HARPER_SET_CONFIG='{"authentication":{"enabled":true}}'
```

### Configuration Precedence

From highest to lowest:

1. **`HARPER_SET_CONFIG`** — Always wins
2. **User manual edits** — Detected via drift detection
3. **`HARPER_DEFAULT_CONFIG`** — Applied if no user edits detected
4. **File defaults** — Original template values

### State Tracking

Harper maintains a state file at `{rootPath}/backup/.harper-config-state.json` to track the source of each configuration value. This enables:

- **Drift detection**: Identifying when users manually edit values set by `HARPER_DEFAULT_CONFIG`
- **Restoration**: Restoring original values when keys are removed from `HARPER_DEFAULT_CONFIG`
- **Conflict resolution**: Determining which source should take precedence

### Format Reference

The JSON structure mirrors the YAML config file:

**YAML:**

```yaml
http:
  port: 8080
  cors: true
logging:
  level: info
  rotation:
    enabled: true
```

**Environment variable (JSON):**

```json
{ "http": { "port": 8080, "cors": true }, "logging": { "level": "info", "rotation": { "enabled": true } } }
```

### Important Notes

- Both variables must contain valid JSON matching the structure of `harper-config.yaml`
- Invalid values are caught by Harper's configuration validator at startup
- Changes to these variables require a Harper restart to take effect
- The state file is per-instance (stored in the root path)

---

## HARPER_SAFE_MODE

Setting `HARPER_SAFE_MODE` to any value starts Harper without loading user applications or components. Harper's core services (database, operations API, HTTP server) start normally, but no applications from the components directory are loaded and no package-based extensions are initialized.

```bash
HARPER_SAFE_MODE=1 harperdb
```

This is useful when a broken or misbehaving component prevents Harper from starting. Safe mode lets you access the operations API to inspect, repair, or remove the problematic component without needing to manually edit files on disk.

Safe mode skips:

- Installing registered applications
- Loading components from the components directory
- Loading package-based extensions defined in component configs

Built-in plugins (REST, HTTP, operations API, etc.) and the core database are unaffected.
