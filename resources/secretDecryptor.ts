/**
 * Extension point for decrypting `enc:v1:` secret values at runtime. `.env` loading is the first
 * consumer; the same hook serves any store of `enc:v1:` ciphertext (secret tables, deploy
 * credentials) so key custody stays in one place.
 *
 * Core (Apache) ships NO decryptor: encrypted values stay opaque and are skipped at load time.
 * The Harper Pro secrets component registers a real decryptor here at startup (it holds the
 * cluster's secrets private key), at which point consumers like `loadEnv` transparently decrypt
 * encrypted values. Without Pro the hook is empty and the feature is dormant.
 *
 * The decryptor is synchronous on purpose — `loadEnv` runs synchronously and Node's RSA/AES
 * primitives are synchronous, so this avoids reworking the load path. It receives the full value
 * (including the `enc:v1:` prefix) and returns the plaintext, or throws if it cannot decrypt.
 *
 * Registration is per-process: the Pro component registers in each worker where secrets are
 * consumed, so registration and use share the same module instance.
 */
export type SecretDecryptor = (value: string) => string;

let decryptor: SecretDecryptor | undefined;

/** Install the env-secret decryptor (called by the Pro env-secrets component at startup). */
export function registerSecretDecryptor(fn: SecretDecryptor): void {
	decryptor = fn;
}

/** The registered decryptor, or undefined when no Pro env-secrets component is active. */
export function getSecretDecryptor(): SecretDecryptor | undefined {
	return decryptor;
}

/** Remove the registered decryptor. Intended for tests. */
export function clearSecretDecryptor(): void {
	decryptor = undefined;
}

/** The public half of the cluster secrets keypair, with its stable SHA-256 fingerprint (`kid`). */
export interface SecretCustodyPublicKey {
	publicKey: string;
	fingerprint: string;
}

/**
 * Full key custody: decrypt plus access to the public key, so the node can encrypt on ingest
 * (`set_secret` with a plaintext value) and serve `get_secrets_public_key`. Core ships no custody;
 * the Pro secrets component registers one per process where secrets are used — including the MAIN
 * thread, where the operations API dispatches the secret operations.
 */
export interface SecretCustody {
	decrypt: SecretDecryptor;
	getPublicKey(): SecretCustodyPublicKey;
}

let custody: SecretCustody | undefined;

/**
 * Install key custody. Also installs `custody.decrypt` via the decryptor slot above, so consumers
 * like `loadEnv` that only need decryption keep working through the existing hook.
 */
export function registerSecretCustody(newCustody: SecretCustody): void {
	custody = newCustody;
	registerSecretDecryptor(newCustody.decrypt);
}

/** The registered custody, or undefined when no secrets key is held by this process. */
export function getSecretCustody(): SecretCustody | undefined {
	return custody;
}

/** Remove the registered custody (and the decryptor it installed). Intended for tests. */
export function clearSecretCustody(): void {
	custody = undefined;
	decryptor = undefined;
}
