---
id: configuration
title: Configuration
---

<!-- Source: versioned_docs/version-4.7/reference/roles.md (roles config file format) -->
<!-- Source: release-notes/v4-tucker/4.5.0.md (password hashing upgrade: sha256, argon2id) -->
<!-- Source: release-notes/v4-tucker/4.2.0.md (cookie-based sessions) -->

## Managing Roles with Config Files

In addition to managing roles via the Operations API, Harper supports declaring roles in a configuration file. When the application starts, Harper ensures all declared roles exist with the specified permissions.

Configure in your application's `config.yaml`:

```yaml
roles:
  files: roles.yaml
```

Example `roles.yaml`:

```yaml
analyst:
  super_user: false
  data:
    Sales:
      read: true
      insert: false
      update: false
      delete: false

editor:
  data:
    Articles:
      read: true
      insert: true
      update: true
      attributes:
        title:
          read: true
          update: true
        author:
          read: true
          update: false
```

**Startup behavior:**

- If a declared role does not exist, Harper creates it.
- If a declared role already exists, Harper updates its permissions to match the definition.

## Password Hashing

<VersionBadge version="v4.5.0" />

Harper supports two password hashing algorithms, replacing the previous MD5 hashing:

- **`sha256`** — Default algorithm. Good security and excellent performance.
- **`argon2id`** — Highest security. More CPU-intensive; recommended for high-security environments.

Password hashing is configured via the `authentication.hashFunction` key in `harperdb-config.yaml`. See [Security / Configuration](../security/configuration.md#hashfunction) for details.

## Related

- [Overview](./overview)
- [Operations](./operations)
