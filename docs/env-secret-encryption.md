# Env-secret encryption (`enc:v1:`)

Harper can store `.env` values **encrypted at rest** and let clients **encrypt secret values before
they leave the client**, so a secret value is never visible in plaintext to the operations API, the
operation logs, the replication payload, or the on-disk `.env` file. The value is only decrypted
transiently into `process.env` at runtime.

This is an **opt-in, Pro-gated** feature. The cryptography and the private key live entirely in the
Harper Pro **env-secrets** component. Core only:

- recognises the `enc:v1:` value prefix ([`utility/envFile.ts`](../utility/envFile.ts) →
  `isEncryptedEnvValue`),
- exposes a decryptor registration hook
  ([`resources/envSecretDecryptor.ts`](../resources/envSecretDecryptor.ts)), and
- decrypts via the registered decryptor when loading `.env` files at runtime
  ([`resources/loadEnv.ts`](../resources/loadEnv.ts)).

Without the Pro component no decryptor is registered, the hook is dormant, and an encrypted value is
**skipped with an error logged** at load — non-fatal, so the node still boots (and the value can be
fixed via `set_env_value`) and a non-Pro node isn't crashed by a replicated encrypted value. The app
sees a missing var (and should fail on it) rather than receiving ciphertext.

## Key model

A single **cluster-shared RSA-4096 "env-secrets" keypair** is generated once by the Pro component
and distributed to every node the same way the JWT keypair is (node clone/join). Because every node
holds the same private key, an `enc:v1:` value encrypted once by a client can be stored and
replicated verbatim and decrypted on any node. The public key is fetched by clients via the
`get_secrets_public_key` operation (Pro).

Plaintext and `enc:v1:` values may coexist in the same file — encryption is per-value and opt-in.
`get_env_keys` and `get_component_file` are unchanged: they still expose key **names** only and mask
values, so an encrypted value is doubly protected.

## Envelope format

An encrypted value is the literal prefix `enc:v1:` followed by base64url of a JSON envelope:

```
enc:v1:<base64url( JSON )>
```

```jsonc
{
	"kid": "<hex SHA-256 fingerprint of the DER SPKI public key>", // which key encrypted this (rotation)
	"k": "<base64: RSA-OAEP(SHA-256) wrap of the 32-byte AES key>",
	"iv": "<base64: 12-byte AES-GCM nonce>",
	"ct": "<base64: AES-256-GCM ciphertext of the UTF-8 value>",
	"tag": "<base64: 16-byte AES-GCM authentication tag>",
}
```

Hybrid encryption (AES-256-GCM for the data, RSA-OAEP to wrap the AES key) is used because RSA-4096
can only directly encrypt ~446 bytes — too small for multi-line secrets such as PEM keys.

`kid` lets multiple keypairs coexist during rotation: the decryptor selects the matching private
key, or rejects the value if it has no key for that `kid`.

## Client flow

1. `GET`/operation `get_secrets_public_key` → `{ publicKey: <PEM SPKI>, fingerprint, scheme: "enc:v1", algorithm }`. Cache it by `fingerprint`.
2. Encrypt each secret value into an envelope (see below).
3. Send it through the existing operation: `set_env_value { project, key, value: "enc:v1:..." }`. The server stores the envelope verbatim.

### Reference (Node.js)

```js
import { randomBytes, publicEncrypt, createCipheriv, constants } from 'node:crypto';

function encryptEnvValue(plaintext, publicKeyPem, kid) {
	const aesKey = randomBytes(32);
	const iv = randomBytes(12);
	const cipher = createCipheriv('aes-256-gcm', aesKey, iv);
	const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
	const tag = cipher.getAuthTag();
	const k = publicEncrypt({ key: publicKeyPem, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' }, aesKey);
	const envelope = {
		kid,
		k: k.toString('base64'),
		iv: iv.toString('base64'),
		ct: ct.toString('base64'),
		tag: tag.toString('base64'),
	};
	return 'enc:v1:' + Buffer.from(JSON.stringify(envelope)).toString('base64url');
}
```

## Threat model

**Protects against:** disk theft of `.env` files, the editor/operations read surface, secrets in
operation logs and replication payloads, and an operator observing traffic at the HTTP/TLS-terminating
layer.

**Does not protect against:** a compromised running node — it necessarily holds the private key and
the decrypted value in `process.env`. The env-secrets private key itself is stored at rest on disk;
hardening that further (OS keystore / HSM / KMS) is a possible follow-up. This is defense-in-depth for
_accidental_ and _at-rest_ exposure, not protection from a fully compromised host.
