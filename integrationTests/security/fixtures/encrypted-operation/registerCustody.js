// Test-only builtin component: core ships no secret custody (Harper Pro does), so this registers an
// in-process RSA keypair as custody. Operations dispatch on the main thread, so it registers there
// (`startOnMainThread`); `handleApplication` runs per worker and would be invisible to dispatch.
import { generateKeyPairSync } from 'node:crypto';
import { join, dirname } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

const distRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..', 'dist');

export async function startOnMainThread() {
	// The running install's own dist modules, so this shares their registry state.
	const { registerSecretCustody } = await import(pathToFileURL(join(distRoot, 'resources', 'secretDecryptor.js')).href);
	const { fingerprintOf, decryptEnvelope } = await import(
		pathToFileURL(join(distRoot, 'utility', 'secretEnvelope.js')).href
	);
	const { publicKey, privateKey } = generateKeyPairSync('rsa', {
		modulusLength: 2048,
		publicKeyEncoding: { type: 'spki', format: 'pem' },
		privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
	});
	const fingerprint = fingerprintOf(publicKey);
	registerSecretCustody({
		decrypt: (value) => decryptEnvelope(value.slice('enc:v1:'.length), privateKey, fingerprint),
		getPublicKey: () => ({ publicKey, fingerprint }),
	});
}
