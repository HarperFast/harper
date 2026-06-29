/**
 * Extension point for decrypting `enc:v1:` env-secret values at runtime.
 *
 * Core (Apache) ships NO decryptor: encrypted `.env` values stay opaque and are skipped at load
 * time. The Harper Pro env-secrets component registers a real decryptor here at startup (it holds
 * the cluster-shared env-secrets private key), at which point `loadEnv` transparently decrypts
 * encrypted values into `process.env`. Without Pro the hook is empty and the feature is dormant.
 *
 * The decryptor is synchronous on purpose — `loadEnv` runs synchronously and Node's RSA/AES
 * primitives are synchronous, so this avoids reworking the load path. It receives the full value
 * (including the `enc:v1:` prefix) and returns the plaintext, or throws if it cannot decrypt.
 *
 * Registration is per-process: the Pro component registers in each worker where `.env` files load,
 * so registration and use share the same module instance.
 */
export type EnvSecretDecryptor = (value: string) => string;

let decryptor: EnvSecretDecryptor | undefined;

/** Install the env-secret decryptor (called by the Pro env-secrets component at startup). */
export function registerEnvSecretDecryptor(fn: EnvSecretDecryptor): void {
	decryptor = fn;
}

/** The registered decryptor, or undefined when no Pro env-secrets component is active. */
export function getEnvSecretDecryptor(): EnvSecretDecryptor | undefined {
	return decryptor;
}

/** Remove the registered decryptor. Intended for tests. */
export function clearEnvSecretDecryptor(): void {
	decryptor = undefined;
}
