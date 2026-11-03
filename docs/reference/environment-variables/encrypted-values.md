---
id: encrypted-values
title: Encrypted Environment Values
---

<VersionBadge version="v5.2.0" />

An individual value in a component's `.env` file can be stored as **ciphertext** instead of plaintext. Encrypted values carry the literal marker `enc:v1:` and are decrypted only in memory, at the moment Harper loads the file into `process.env`:

```bash
# .env
LOG_LEVEL=debug
STRIPE_KEY=enc:v1:eyJraWQiOiJhYzNm...
```

Plaintext and encrypted values coexist in the same file — encryption is per-value and opt-in.

Because a client can encrypt the value **before** sending it, the plaintext never reaches the operations API, its logs, the replication payload, or the on-disk file. The same `enc:v1:` envelope backs the [secrets store](../security/secrets.md), so a value encrypted once works with either.

:::tip
For production credentials, the [secrets store](../security/secrets.md) is the better mechanism: it is replicated, audited, rotatable, and scopable per component, and it never puts the ciphertext in a file that can be committed to version control. Reach for encrypted `.env` values when you already have a `.env` workflow and want to keep individual values out of plaintext on disk.
:::

## Requirements

Decryption requires **secret custody** — the cluster's secrets private key — which is provided by a Harper Pro component. Open-source core recognizes the `enc:v1:` marker but ships no decryptor.

| Node                             | Behavior at load                                                                     |
| -------------------------------- | ------------------------------------------------------------------------------------ |
| Custody registered (Harper Pro)  | The value is decrypted, then loaded like a plaintext value.                          |
| No custody (core, or key absent) | The value is **skipped** with an error logged, and queued for a decryptor.           |
| Custody registers later          | Queued values are decrypted and loaded as soon as it registers.                      |
| Value cannot be decrypted        | Skipped with an error logged — a wrong key, a tampered envelope, or a malformed one. |

A decrypted value is loaded under the same [override rule](./overview.md#override-behavior) as a plaintext one, so by default it does not replace a variable that is already set.

A skipped value is never written to `process.env`, so the ciphertext never becomes the value. If nothing else set that variable, it is **absent**, and your component fails on a missing variable rather than silently receiving an unusable string. If the variable was already set, by the shell or container environment or by an earlier `.env` file, it keeps that value.

Skipping is never fatal to the node. It still boots, so you can correct a bad value with `set_env_value` and restart the workers, and a node without Pro is not crashed by a replicated encrypted value.

A decryptor that comes up after component `.env` loading replays the values it missed into `process.env`. Replaying sets the variable but does not rerun code that has already read it. A component that reads the value while it initializes, before custody registers, finds it missing and keeps whatever it did with that result. For such a component, read the variable when you use it rather than at startup, or restart the workers once custody is available. Each deferred value is logged as an error that ends in `deferring`.

## Encrypting a value

The flow is the same one the secrets store uses for client-side encryption.

### 1. Fetch the cluster public key

`get_secrets_public_key` is `super_user` only and requires custody on the answering node:

```json
{ "operation": "get_secrets_public_key" }
```

Response:

```json
{
	"public_key": "-----BEGIN PUBLIC KEY-----\n...",
	"fingerprint": "<hex sha256>"
}
```

Cache the key by its `fingerprint`; that value is the `kid` you seal into the envelope.

### 2. Build the envelope

An encrypted value is the literal prefix `enc:v1:` followed by the base64url encoding of a JSON envelope. Hybrid encryption is used — AES-256-GCM encrypts the value, RSA-OAEP (SHA-256) wraps the AES key — because the RSA key is too small to directly encrypt multi-line secrets such as PEM keys:

```
enc:v1:<base64url( JSON )>
```

```jsonc
{
	"kid": "<hex SHA-256 fingerprint of the DER SPKI public key>", // which key encrypted this
	"k": "<base64: RSA-OAEP(SHA-256) wrap of the 32-byte AES key>",
	"iv": "<base64: 12-byte AES-GCM nonce>",
	"ct": "<base64: AES-256-GCM ciphertext of the UTF-8 value>",
	"tag": "<base64: 16-byte AES-GCM authentication tag>",
}
```

A reference Node.js implementation is in [Secrets — Reference client](../security/secrets.md#reference-client-nodejs); the function it defines returns exactly the string to use as the `value` below.

`kid` lets multiple keypairs coexist during a rotation: the decryptor selects the matching private key, or rejects the value if it holds no key for that `kid`.

### 3. Write it with `set_env_value`

Send the envelope as an ordinary value. Harper stores the string verbatim:

```json
{
	"operation": "set_env_value",
	"project": "my-app",
	"key": "STRIPE_KEY",
	"value": "enc:v1:<base64url-envelope>"
}
```

Like any edit to a `.env` file a component has already loaded, the new value reaches running code when the node's worker threads restart. See [Environment File Operations](../operations-api/operations.md#environment-file-operations).

:::note
Unlike `set_secret`, `set_env_value` does **not** validate the envelope — it is just a string to the `.env` writer, and there is no server-side check of its structure or `kid`. A malformed or wrongly-keyed envelope is only discovered when the file is loaded, as a decrypt error in the log. `set_secret` performs those checks on ingest, which is one more reason to prefer the [secrets store](../security/secrets.md) for credentials.
:::

## What stays hidden

`get_env_keys` and `get_component_file` report key **names** only and mask `.env` values, so an encrypted value is protected on the read surface twice over. See [Environment File Operations](../operations-api/operations.md#environment-file-operations).

**Protects against:** theft of the on-disk `.env` file, the editor and operations read surface, the value appearing in operation logs and replication payloads, and an operator observing traffic at the TLS-terminating layer.

**Does not protect against:** a fully compromised running node. A node that holds custody necessarily holds the private key, and the decrypted value is in `process.env` where any component in the process — and any child process it spawns — can read it. This is defense in depth for accidental and at-rest exposure, not protection from a compromised host.

## Related

- [Environment Variables](./overview.md) — the `loadEnv` plugin and `.env` loading
- [Secrets](../security/secrets.md) — the encrypted, replicated secrets store
- [Environment File Operations](../operations-api/operations.md#environment-file-operations) — `get_env_keys`, `set_env_value`, `delete_env_value`
