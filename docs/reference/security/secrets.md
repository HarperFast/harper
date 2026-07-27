---
id: secrets
title: Secrets
---

Harper provides an encrypted, replicated **secrets store** for supplying credentials and other sensitive configuration to your components without hardcoding them or leaving them in plaintext on disk. Secrets are held in the `system.hdb_secret` system table as ciphertext, replicate across the cluster like any other system table, and are delivered to components in one of two tiers: as `process.env` variables, or through a per-component `secrets` accessor.

This is the production-grade alternative to committing a `.env` file. For the simpler file-based approach (including encrypted `.env` values that share this store's wire format), see [Environment Variables](../environment-variables/overview.md).

## Concepts

### The store

Every secret is a named row in `system.hdb_secret`. Only ciphertext is ever stored — a plaintext value submitted to `set_secret` is encrypted immediately and the plaintext is discarded. Values are never returned by any read operation, never written to the operations log, and never travel in the replication payload as plaintext; rows reach peers as encrypted envelopes through normal system-table replication.

Secret names may contain word characters, dots, and dashes (e.g. `STRIPE_KEY`, `deploy.my-app.git.github_com`).

### Custody (Harper Pro)

The private key that decrypts secrets — the **custody** — is held by a Harper Pro component. Open-source core ships no custody:

- **With custody** (Pro): the node can encrypt on ingest (`set_secret` with a plaintext `value`), serve `get_secrets_public_key`, and decrypt secrets for delivery to components.
- **Without custody** (OSS core, or a node that does not hold the key): the node can still **store and replicate** client-encrypted envelopes, but it cannot decrypt them. A plaintext `set_secret` fails; a scoped secret a component requests is reported as `custody-unavailable`.

A single cluster-shared keypair is distributed to every node the same way the JWT keypair is (node clone/join), so a secret encrypted once by a client can be decrypted on any node that holds custody.

### Delivery tiers

Each secret is delivered exactly one of two ways, decided by the row itself. The two tiers are mutually exclusive — a `process.env` secret is already global, so scoping it would be meaningless, and `set_secret` rejects a row that is both.

| Tier       | Row flag           | Reaches components as                    | In `process.env`? | Inherited by child processes? |
| ---------- | ------------------ | ---------------------------------------- | ----------------- | ----------------------------- |
| **Global** | `processEnv: true` | `process.env.NAME`                       | Yes               | Yes                           |
| **Scoped** | `grants: [...]`    | `secrets.NAME` (granted components only) | No                | No                            |

**Global tier** secrets are materialized into the real `process.env` at startup, before components load — exactly like `.env` values, with the same semantics (a pre-existing real environment variable always wins over the store). There is no isolation between components on this tier.

**Scoped tier** secrets never land in `process.env`. They are exposed only through the per-component accessor, so they are not inherited by child processes and are invisible to environment dumps. The `grants` list on the row is the authority for which components can see the secret; a row with neither `processEnv` nor any grant is **inert** — visible to no one — until it is granted.

:::note
JS-level scoping is a slowdown layer, not a hard security boundary — components share a process, so OS-level isolation (containers/uids) remains the real boundary between untrusted code. Scoping keeps a secret out of `process.env` and out of ungranted components' reach; it does not sandbox a component that is determined to reach into the process.
:::

## Managing secrets (Operations API)

Secrets can be managed graphically in [Harper Studio](../studio/overview.md), which provides a friendly interface for creating, granting, and rotating secrets without hand-crafting operation requests. The operations below are the underlying API that Studio (and your own tooling) drives.

All secret operations are **`super_user` only** and are documented in the [Operations Reference](../operations-api/operations.md#secrets). The core operations:

| Operation                        | Purpose                                                 |
| -------------------------------- | ------------------------------------------------------- |
| `set_secret`                     | Create or update a secret (and choose its tier)         |
| `grant_secret` / `revoke_secret` | Add or remove a component from a scoped secret's grants |
| `list_secrets`                   | List secret metadata (never values)                     |
| `delete_secret`                  | Remove a secret row                                     |
| `get_secrets_public_key`         | Fetch the cluster public key for client-side encryption |

### Create a global (process.env) secret

With custody on the node, submit the plaintext `value` and Harper encrypts it on ingest:

```json
{
	"operation": "set_secret",
	"name": "DATABASE_URL",
	"value": "postgres://user:pass@host/db",
	"processEnv": true
}
```

Every component now sees `process.env.DATABASE_URL`.

### Create a scoped secret and grant it

```json
{
	"operation": "set_secret",
	"name": "STRIPE_KEY",
	"value": "sk_live_...",
	"grants": ["payments-service"]
}
```

`grants` may be set at creation (above) or managed separately:

```json
{ "operation": "grant_secret", "name": "STRIPE_KEY", "component": "payments-service" }
```

```json
{ "operation": "revoke_secret", "name": "STRIPE_KEY", "component": "payments-service" }
```

Granting a not-yet-deployed component is legal — grants may precede the deploy.

## Consuming secrets in a component

### Declare what you expect

A component declares the environment it needs in an `env:` block in its `config.yaml`. A declaration is a **request, not a grant** — it cannot widen access to a scoped secret; the `grants` list on the row is the only authority for that.

```yaml
# config.yaml
env:
  NODE_ENV: production # string value = an inline literal written to process.env
  DATABASE_URL: { required: true, description: Primary database } # satisfied from the store or env
  SENTRY_DSN: { required: false } # optional
```

- A **string** value is an inline literal, written directly into `process.env` (a convenience for non-secret config; do not put real secrets here — they are stored in plaintext in `config.yaml`, which is typically committed to version control).
- An **object** value is a declaration satisfied from `process.env` (a global-tier secret, a literal, or a real environment variable) — it does not by itself expose a scoped secret.

A `required: true` declaration that cannot be satisfied stops **that component** from loading (the instance keeps running). The failure reason is one of:

- `missing` — no matching row and no environment variable.
- `ungranted` — a scoped row exists but this component is not in its grants.
- `custody-unavailable` — a row exists but cannot be decrypted on this node (no custody).

### Read scoped secrets with the `secrets` accessor

Scoped secrets are read through the process-wide `secrets` export — a read-only, name→value map of the secrets granted to the current component (plus any `process.env`-resolved values it declared):

```js
import { secrets } from 'harper';

const stripe = new Stripe(secrets.STRIPE_KEY);
```

**The accessor is live.** On the scoped tier a property read (`secrets.STRIPE_KEY`) always returns the latest stored value — a rotation is reflected on the next read, no reload required. So most components need nothing more than the accessor: read the secret **where you use it**, and every request sees the current value. Reading inside a resource handler is the common case:

```js
import { Resource, secrets } from 'harper';

export class Report extends Resource {
	async get() {
		// Read at call time, so each request uses the current token — even after a rotation.
		const response = await fetch('https://api.example.com/report', {
			headers: { authorization: `Bearer ${secrets.API_TOKEN}` },
		});
		return response.json();
	}
}
```

The one thing that is **not** live is a **destructure**: `const { STRIPE_KEY } = secrets` — or any assignment that copies the value into your own variable — takes a **point-in-time snapshot** and won't observe a later rotation. That's fine for a value read once and used as-is, and it's the idiom to use when the read must happen at module load (see the loader note below):

```js
import { secrets } from 'harper';

const { STRIPE_KEY, WEBHOOK_SECRET } = secrets;
```

The `secrets` object is a read-only, live view of the secrets granted to the component; its secret names are enumerable (`Object.keys(secrets)`, spread), while the `subscribe` method below is a non-enumerable member so it never leaks into a spread of values. Global-tier secrets are read from `process.env` as usual and do not need the accessor.

:::note
Under the VM/compartment component loaders (the default) the `harper` module is per-scope, so `import { secrets } from 'harper'` is a view bound to your component — you can read `secrets.NAME` live from anywhere in it, including inside request handlers. Under the native loader the `harper` package is a process-wide singleton that resolves the calling component from the component-load context, so a read **outside** component load fails loudly rather than guessing which component is asking; there, read at module top level during load (the destructure above — a snapshot) or use `secrets.subscribe()` to track changes. The module-top-level destructure is exact in all modes.
:::

### React to rotations with `secrets.subscribe()`

Reading `secrets.NAME` per use (above) already picks up rotations, so reach for a subscription only when you build something **from** a secret and keep it around — an API client, a connection pool, a cached signer — and need to rebuild that object when the secret changes.

`secrets.subscribe(name)` returns an async iterable that yields the secret's **current value immediately**, then a new value on **every change** — a grant, a rotation (`set_secret`), a revoke, or a delete. It lets a component hot-swap a rotated secret without a restart.

The iterator stays open for the life of the component, so a top-level `for await` would block module load forever. Instead, use the current value right away, then subscribe in a **background task** so module load is never blocked and the rest of the component keeps initializing:

```js
import { secrets } from 'harper';

// Ready to serve immediately with the current value...
let currentKey = secrets.STRIPE_KEY;
let stripe = new Stripe(currentKey);

// ...then hot-swap on every rotation, without blocking module load.
(async () => {
	try {
		for await (const key of secrets.subscribe('STRIPE_KEY')) {
			if (key === currentKey) continue; // the first yield is the value we already have
			currentKey = key;
			stripe = new Stripe(currentKey);
		}
	} catch (error) {
		// Log and keep serving the last client; it stays valid until the next reload.
		console.error('secret subscription ended for STRIPE_KEY:', error);
	}
})();
```

The first value `subscribe` yields is the secret's **current** value — the same one read synchronously above — so the guard skips a redundant rebuild on startup and only rebuilds the client when the key actually rotates.

Authority is re-evaluated on **every** event through the same rules as the read accessor:

- A **revoke** or **delete** yields `undefined` (no plaintext is retained), while the stream stays **open**.
- A later **re-grant** or **re-add** resumes delivery on the same iterator — no restart, no re-subscribe.

`subscribe` is a reserved name: it can never be a secret's name, and never resolves to a secret value.

### How each tier sees a change

The two tiers observe changes differently:

| Read path                   | Scoped tier (`grants`)                               | Global tier (`processEnv`)                        |
| --------------------------- | ---------------------------------------------------- | ------------------------------------------------- |
| `secrets.NAME` accessor     | **Live** — reflects the latest value on a fresh read | Current value at load; reload-only                |
| `secrets.subscribe('NAME')` | **Live** — streams every change                      | Current value only; reload-only                   |
| `process.env.NAME`          | n/a                                                  | Reload-only — never re-mutated under running code |

**Scoped-tier** consumers see grants, rotations, revokes, and late-arriving custody take effect live, through the accessor or a subscription.

**Global-tier** secrets are materialized into `process.env` once at startup, before components load, and are deliberately **not** re-materialized under running code: child processes inherit `process.env`, and the "a pre-existing real environment variable always wins" precedence must hold. A change to a global secret — or custody that only came up after boot — heals on the next **restart or component reload**, when the store is re-read.

## Client-side encryption (encrypt before it leaves the client)

For the strongest posture, a client can encrypt a secret value **before** sending it, so plaintext never reaches the operations API at all — not even on the node that stores it. This is also how a node **without custody** can accept a secret: it stores the opaque envelope verbatim.

The flow:

1. **Fetch the public key** with `get_secrets_public_key` (requires custody somewhere to answer). Cache it by `fingerprint`:

   ```json
   { "operation": "get_secrets_public_key" }
   ```

   ```json
   { "public_key": "-----BEGIN PUBLIC KEY-----\n...", "fingerprint": "<hex sha256>" }
   ```

2. **Encrypt the value** into an `enc:v1:` envelope (see below), using the `fingerprint` as the `kid`.

3. **Submit the envelope** instead of a plaintext `value`:

   ```json
   {
   	"operation": "set_secret",
   	"name": "STRIPE_KEY",
   	"envelope": "enc:v1:<base64url-envelope>",
   	"grants": ["payments-service"]
   }
   ```

The server derives `kid` from the sealed envelope (a separate client-supplied `kid` field is never trusted) and, if it holds custody, verifies the `kid` matches this cluster's key; a mismatch is rejected with the current fingerprint. Without custody the row is accepted but flagged `unverified: true` in `list_secrets` so a bad envelope is visible rather than silently failing at consumption time.

### Envelope format

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

`kid` lets multiple keypairs coexist during rotation: the decryptor selects the matching private key, or rejects the value if it holds no key for that `kid`.

The same `enc:v1:` envelope format is used for encrypted `.env` values, so a value encrypted once can be used with either the secrets store or `loadEnv`.

### Reference client (Node.js)

```js
import { randomBytes, publicEncrypt, createCipheriv, constants } from 'node:crypto';

function encryptSecret(plaintext, publicKeyPem, kid) {
	const aesKey = randomBytes(32);
	const iv = randomBytes(12);
	const cipher = createCipheriv('aes-256-gcm', aesKey, iv);
	const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
	const tag = cipher.getAuthTag();
	const k = publicEncrypt({ key: publicKeyPem, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' }, aesKey);
	const envelope = {
		kid, // the `fingerprint` from get_secrets_public_key
		k: k.toString('base64'),
		iv: iv.toString('base64'),
		ct: ct.toString('base64'),
		tag: tag.toString('base64'),
	};
	return 'enc:v1:' + Buffer.from(JSON.stringify(envelope)).toString('base64url');
}
```

## Private-source deploy credentials

`deploy_component` accepts a `credentials` array so a component installed from a private **npm registry** or private **git repository** can authenticate. A provided token is ingested into the secrets store (as a reference, encrypted) rather than travelling in the operation body, persisting as a plaintext `.npmrc`, or being written to disk for git — so package-reference deploys survive rollback, reboot, and new peers joining. Ingested tokens are stored under a derived name (`deploy.<component>.<registry>` or `deploy.<component>.git.<host>`) granted to the component. See [`deploy_component`](../operations-api/operations.md#deploy_component).

## Threat model

**Protects against:** theft of on-disk config/`.env` files, the editor/operations read surface, secrets appearing in operations logs and replication payloads, and an operator observing traffic at the TLS-terminating layer. Client-side encryption additionally keeps plaintext off the operations API entirely.

**Does not protect against:** a fully compromised running node — a node that holds custody necessarily holds the private key and the decrypted values in memory. This is defense-in-depth for accidental and at-rest exposure, not protection from a compromised host. OS-level isolation remains the boundary between untrusted components.

:::note
`delete_secret` removes the row but is **not** cryptographic erasure — audit logs, transaction logs, and backups retain the encrypted envelope.
:::
