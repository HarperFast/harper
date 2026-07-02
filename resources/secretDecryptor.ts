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
