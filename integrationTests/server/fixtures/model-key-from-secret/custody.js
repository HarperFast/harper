// Core ships no secrets custody, so this registers one from a key file the test writes: the same
// key on every thread and across restarts, which a stored secret needs to stay decryptable.
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

const dist = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..', 'dist');

async function registerCustody() {
	const { registerSecretCustody } = await import(pathToFileURL(join(dist, 'resources', 'secretDecryptor.js')).href);
	const { fingerprintOf, decryptEnvelope } = await import(
		pathToFileURL(join(dist, 'utility', 'secretEnvelope.js')).href
	);
	const { publicKey, privateKey } = JSON.parse(readFileSync(process.env.MODEL_KEY_TEST_CUSTODY_FILE, 'utf8'));
	const fingerprint = fingerprintOf(publicKey);
	registerSecretCustody({
		decrypt: (value) => decryptEnvelope(value.slice('enc:v1:'.length), privateKey, fingerprint),
		getPublicKey: () => ({ publicKey, fingerprint }),
	});
}

export const startOnMainThread = registerCustody;
export const start = registerCustody;
