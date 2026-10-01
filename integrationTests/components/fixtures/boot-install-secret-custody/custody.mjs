// Test-only stand-in for Harper Pro's `secretCustody` root built-in: registered under that name via
// HARPER_BUILTIN_COMPONENTS and started through `startOnMainThread`, as the real one is. Its key comes
// from the test so envelopes the test seals while Harper is stopped stay decryptable across boots.
import { appendFileSync } from 'node:fs';
import { createPublicKey } from 'node:crypto';
import { join, dirname } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

// The running install's own dist modules, so registration lands in the registry core reads.
const distDirectory = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..', 'dist');
const importDist = (path) => import(pathToFileURL(join(distDirectory, path)).toString());

export async function startOnMainThread() {
	appendFileSync(process.env.BOOT_CUSTODY_START_LOG, 'start\n');
	const { registerSecretCustody } = await importDist('resources/secretDecryptor.js');
	const { fingerprintOf, decryptEnvelope } = await importDist('utility/secretEnvelope.js');
	const privateKey = Buffer.from(process.env.BOOT_CUSTODY_PRIVATE_KEY_B64, 'base64').toString('utf8');
	const publicKey = createPublicKey(privateKey).export({ type: 'spki', format: 'pem' });
	const fingerprint = fingerprintOf(publicKey);
	registerSecretCustody({
		decrypt: (value) => decryptEnvelope(value.slice('enc:v1:'.length), privateKey, fingerprint),
		getPublicKey: () => ({ publicKey, fingerprint }),
	});
}
