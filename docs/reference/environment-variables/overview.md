---
id: overview
title: Environment Variables
---

<!-- Source: versioned_docs/version-4.7/reference/components/built-in-extensions.md (primary - loadEnv section) -->
<!-- Source: versioned_docs/version-4.5/developers/components/built-in.md (for v4.5 feature introduction) -->
<!-- Source: release_notes/4.5.0.md (confirmed loadEnv introduction) -->

Harper supports loading environment variables in Harper applications `process.env` using the built-in `loadEnv` plugin. This is the standard way to supply secrets and configuration to your Harper components without hardcoding values. `loadEnv` does **not** need to be installed as it is built into Harper and only needs to be declared in your `config.yaml`.

:::note
If you are looking for information on how to configure your Harper installation using environment variables, see [Configuration](../configuration/overview.md) section for more information.
:::

## Basic Usage

```yaml
loadEnv:
  files: '.env'
```

This loads the `.env` file from the root of your component directory into `process.env`.

## Load Order

> **Important:** Specify `loadEnv` first in your `config.yaml` so that environment variables are loaded before any other components start.

```yaml
# config.yaml — loadEnv must come first
loadEnv:
  files: '.env'

rest: true

myApp:
  files: './src/*.js'
```

Because Harper is a single-process application, environment variables are loaded onto `process.env` and are shared across all components. As long as `loadEnv` is listed before dependent components, those components will have access to the loaded variables.

## Override Behavior

By default, `loadEnv` follows the standard dotenv convention: **existing environment variables take precedence** over values in `.env` files. This means variables already set in the shell or container environment will not be overwritten.

To override existing environment variables, use the `override` option:

```yaml
loadEnv:
  files: '.env'
  override: true
```

## Multiple Files

As a Harper plugin, `loadEnv` supports multiple files using either glob patterns or a list of files in the configuration:

```yaml
loadEnv:
  files:
    - '.env'
    - '.env.local'
```

or

```yaml
loadEnv:
  files: 'env-vars/*'
```

Files are loaded in the order specified.

## Related

- [Components Overview](../components/overview.md)
- [Configuration](../configuration/overview.md)
