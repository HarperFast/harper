/**
 * Pure secret-envelope cryptography — intentionally free of Harper imports so it is unit-testable
 * on its own and safe to publish. Hybrid scheme (see docs/env-secret-encryption.md): AES-256-GCM
 * encrypts the value, RSA-OAEP(SHA-256) wraps the AES key. Functions operate on the base64url
 * envelope BODY (the bytes after the `enc:v1:` marker); marker handling lives with the callers
 * (utility/envFile.ts exports the `ENV_ENCRYPTED_PREFIX` marker).
 *
 * Ported from harper-pro security/envSecretCrypto.ts (Dawson Toth) so core and pro share one wire
 * format for `.env` secrets and the hdb_secret store.
 */
import {
	publicEncrypt,
	privateDecrypt,
	createCipheriv,
	createDecipheriv,
	createPublicKey,
	createHash,
	randomBytes,
	constants,
} from 'node:crypto';

export interface EnvelopeFields {
	kid?: string;
	k: string;
	iv: string;
	ct: string;
	tag: string;
}

/** SHA-256 (hex) of the DER SPKI public key — a stable key id used as the envelope `kid`. */
export function fingerprintOf(publicKeyPem: string): string {
	const der = createPublicKey(publicKeyPem).export({ type: 'spki', format: 'der' });
	return createHash('sha256').update(der).digest('hex');
}

// Base64 with OPTIONAL padding (the field encoding inside the envelope JSON). Buffer.from(s,
// 'base64') silently ignores invalid characters, so decodability has to be checked by pattern —
// but it decodes unpadded input fine, and browser/WebCrypto clients commonly emit unpadded
// base64, so padding is accepted rather than required. Charset stays strict; a trailing group of
// one character (never valid base64) is still rejected.
const BASE64_REGEX = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}(?:==)?|[A-Za-z0-9+/]{3}=?)?$/;

/**
 * Parse and shape-validate a base64url envelope body without decrypting it. Throws on a
 * malformed/incomplete envelope: non-JSON, wrong type, missing/non-base64 `k`/`iv`/`ct`/`tag`
 * (`ct` may be empty — the empty plaintext), or a non-string `kid`. This is how the server derives
 * `kid` from a submitted envelope (the `kid` inside the sealed body is the only one trusted —
 * never a separate client field) and structurally vets envelopes on ingest without ever
 * decrypting them server-side.
 */
export function parseEnvelopeFields(body: string): EnvelopeFields {
	let env: EnvelopeFields;
	try {
		env = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
	} catch {
		throw new Error('malformed secret envelope');
	}
	if (!env || typeof env !== 'object' || Array.isArray(env) || (env.kid !== undefined && typeof env.kid !== 'string')) {
		throw new Error('malformed secret envelope');
	}
	for (const field of ['k', 'iv', 'ct', 'tag'] as const) {
		const fieldValue = env[field];
		if (
			typeof fieldValue !== 'string' ||
			(fieldValue.length === 0 && field !== 'ct') ||
			!BASE64_REGEX.test(fieldValue)
		) {
			throw new Error('malformed secret envelope');
		}
	}
	return env;
}

/**
 * Reference client-side encryption: returns the base64url envelope body for `enc:v1:<body>`. The
 * server only encrypts on ingest (set_secret with a plaintext `value`); this is the single source
 * of truth for the wire format and what the tests and the documented client example exercise.
 */
export function encryptEnvelope(plaintext: string, publicKeyPem: string, kid: string): string {
	const aesKey = randomBytes(32);
	const iv = randomBytes(12);
	const cipher = createCipheriv('aes-256-gcm', aesKey, iv);
	const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
	const tag = cipher.getAuthTag();
	const k = publicEncrypt({ key: publicKeyPem, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' }, aesKey);
	const envelope: EnvelopeFields = {
		kid,
		k: k.toString('base64'),
		iv: iv.toString('base64'),
		ct: ct.toString('base64'),
		tag: tag.toString('base64'),
	};
	return Buffer.from(JSON.stringify(envelope)).toString('base64url');
}

/**
 * Decrypt a base64url envelope body. These are the security guarantees of the feature and throw on:
 * a malformed/incomplete envelope, a `kid` that doesn't match this node's key, or a failed GCM
 * authentication tag (any tampering with `ct`/`tag` makes `decipher.final()` throw).
 */
export function decryptEnvelope(body: string, privateKeyPem: string, keyFingerprint: string): string {
	const env = parseEnvelopeFields(body);
	if (env.kid && env.kid !== keyFingerprint) {
		throw new Error(`no secrets key for kid ${env.kid}`);
	}
	const aesKey = privateDecrypt(
		{ key: privateKeyPem, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' },
		Buffer.from(env.k, 'base64')
	);
	const decipher = createDecipheriv('aes-256-gcm', aesKey, Buffer.from(env.iv, 'base64'));
	decipher.setAuthTag(Buffer.from(env.tag, 'base64'));
	return Buffer.concat([decipher.update(Buffer.from(env.ct, 'base64')), decipher.final()]).toString('utf8');
}
