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
 *
 * Registration order is NOT load-bearing for `.env` values: entries that load before a decryptor
 * exists are queued (see `deferEncryptedEnvValue`) and replayed into `process.env` the moment one
 * registers, so a custody provider that comes up after component `.env` loading heals the skipped
 * values instead of leaving them missing.
 */
import logger from '../utility/logging/harper_logger.ts';

export type SecretDecryptor = (value: string) => string;

/** An encrypted `.env` entry that was loaded before any decryptor was registered. */
export interface DeferredEncryptedEnvValue {
	key: string;
	rawValue: string;
	sourcePath: string;
	override: boolean;
}

// Defensive cap: the queue only ever holds encrypted `.env` entries loaded before registration,
// so growth beyond this indicates a bug or abuse — drop (with an error) rather than grow.
const MAX_DEFERRED_SECRETS = 1000;
let deferredSecrets: DeferredEncryptedEnvValue[] = [];

let decryptor: SecretDecryptor | undefined;

/**
 * Queue an encrypted `.env` entry that could not be decrypted because no decryptor is registered
 * yet. When one registers, the queue is replayed into `process.env` with the same
 * override/conflict semantics `loadEnv` applied to the original load.
 */
export function deferEncryptedEnvValue(entry: DeferredEncryptedEnvValue): void {
	// A re-evaluated env file (reload, watcher re-add) defers the same key again: replace the
	// earlier entry in place so the queue holds one entry per {key, sourcePath} with the newest
	// ciphertext, instead of wasting the cap and replaying stale values.
	const existingIndex = deferredSecrets.findIndex(
		(queued) => queued.key === entry.key && queued.sourcePath === entry.sourcePath
	);
	if (existingIndex >= 0) {
		deferredSecrets[existingIndex] = entry;
		return;
	}
	if (deferredSecrets.length >= MAX_DEFERRED_SECRETS) {
		logger.error(
			`Deferred encrypted env queue is full (${MAX_DEFERRED_SECRETS}); dropping ${entry.key} from ${entry.sourcePath}`
		);
		return;
	}
	deferredSecrets.push(entry);
}

/**
 * A redacted snapshot of the queued entries awaiting a decryptor, for tests/diagnostics: a copy,
 * without the ciphertext (`rawValue`), so holders can neither mutate pending entries nor retain
 * the queued values past the flush.
 */
export function getDeferredEncryptedEnvValues(): Omit<DeferredEncryptedEnvValue, 'rawValue'>[] {
	return deferredSecrets.map(({ key, sourcePath, override }) => ({ key, sourcePath, override }));
}

// Replay queued encrypted env entries through a newly registered decryptor, mirroring loadEnv's
// conflict semantics: a failed decrypt logs and skips that entry; an already-set key is only
// overwritten when the entry's env file was loaded with `override`.
function replayDeferredSecrets(newDecryptor: SecretDecryptor): void {
	const entries = deferredSecrets;
	deferredSecrets = [];
	for (const { key, rawValue, sourcePath, override } of entries) {
		let value: string;
		try {
			value = newDecryptor(rawValue);
		} catch (error) {
			logger.error(
				`Failed to decrypt deferred environment variable ${key} from ${sourcePath}: ${(error as Error).message}; skipping`
			);
			continue;
		}
		if (process.env[key] !== undefined) {
			if (process.env[key] === value) continue; // already holds the decrypted value — nothing to report
			logger.warn(`Environment variable conflict: ${key} from ${sourcePath} is already set on process.env`);
			if (!override) continue;
		}
		process.env[key] = value;
	}
}

/**
 * Install the env-secret decryptor (called by the Pro env-secrets component at startup). Any
 * encrypted `.env` entries that loaded before this point are immediately decrypted into
 * `process.env`.
 */
export function registerSecretDecryptor(fn: SecretDecryptor): void {
	decryptor = fn;
	replayDeferredSecrets(fn);
}

/** The registered decryptor, or undefined when no Pro env-secrets component is active. */
export function getSecretDecryptor(): SecretDecryptor | undefined {
	return decryptor;
}

/** Remove the registered decryptor and drop any deferred entries. Intended for tests. */
export function clearSecretDecryptor(): void {
	decryptor = undefined;
	deferredSecrets = [];
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
