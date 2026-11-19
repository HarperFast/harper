---
section: 'Upgrade Notes'
order: 30
---

Other changes that can affect an application or client after upgrading:

- **CommonJS `require()` follows the same rules as `import`** under the VM loader, so a CommonJS component that loads a file outside its directory or spawns a child process without a `name` now fails. See [CommonJS require() Follows the Same Rules as import](#commonjs-require-follows-the-same-rules-as-import).
- **A malformed `harper-config.yaml` stops Harper from starting**, and `HARPER_CONFIG` and `HARPER_SET_CONFIG` now take precedence over overlapping individual variables such as `HTTP_PORT`. See [Malformed Configuration and Install-Time Settings](#malformed-configuration-and-install-time-settings).
- **`GET`, `HEAD` and `OPTIONS` can now get a `503`** when a worker's event loop is overloaded. See [Read Requests Get Admission Control](#read-requests-get-admission-control).
- **Reads through a relationship, SQL statements and attribute-restricted roles are checked more strictly**, so some requests that returned data now return `403`, and a full `PUT` from an attribute-restricted role no longer erases attributes it cannot update. See [Relationship Reads Follow the Related Table's Permissions](#relationship-reads-follow-the-related-tables-permissions), [SQL Attribute Permissions Cover Every Referenced Column](#sql-attribute-permissions-cover-every-referenced-column) and [Attribute-Restricted Roles Keep Their Primary Key and Protected Attributes](#attribute-restricted-roles-keep-their-primary-key-and-protected-attributes).
- **`X-Replicate-To` and the operations API `replicateTo` and `replicatedConfirmation` fields require a super user.** See [Replication Controls Require a Super User](#replication-controls-require-a-super-user).
- **`get_components`, `list_deployments` and `get_deployment` redact package URL credentials** for anyone but a super user. See [Package URL Credentials Are Redacted](#package-url-credentials-are-redacted).
- **In read-only mode (`storage.readOnly` or `HARPER_READONLY`), every staged write fails with `405`** on both storage engines, before authorization. Before, LMDB threw a `TypeError` and RocksDB returned a `500` ([harper#3427](https://github.com/HarperFast/harper/pull/3427)).
- **`drop_attribute` on a table's primary key returns `400`** and changes nothing. Before, on a table created without `attributes`, it stripped the key from every stored record ([harper#3574](https://github.com/HarperFast/harper/pull/3574)).
- **`search_by_value` and `search_by_hash` validation failures return `400`** instead of `500`. `search_value: null` now succeeds, and an array containing `'*'` is refused with `400` ([harper#3654](https://github.com/HarperFast/harper/pull/3654)).
- **An explicit full-text query policy beyond what the native engine supports stops Harper from starting**, before it serves requests. Before, every affected search failed. Installs that set no policy are unaffected ([harper#3839](https://github.com/HarperFast/harper/pull/3839)).
- **`Table.setResidency`, `Table.setResidencyById` and `setComputedAttribute` resolvers for indexed attributes are deprecated** and warn when registered. See [Residency Hooks and Indexed Computed Resolvers Are Deprecated](#residency-hooks-and-indexed-computed-resolvers-are-deprecated).
