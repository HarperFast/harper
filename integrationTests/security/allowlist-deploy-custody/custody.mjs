// SQA-89 (from SQA-88) test-only stand-in for Harper Pro's `secretCustody` root built-in. Same shape as
// integrationTests/components/fixtures/boot-install-secret-custody/custody.mjs, but it registers the
// decryptor on EVERY thread (`start`), not only on main: componentSecrets.ts decrypts rows on the
// thread that serves the component, so a main-only registration leaves every worker's `secrets` view empty.
import { appendFileSync } from 'node:fs';
import { createPublicKey } from 'node:crypto';
import { join, dirname } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { threadId } from 'node:worker_threads';

const distDirectory = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'dist');
const importDist = (path) => import(pathToFileURL(join(distDirectory, path)).toString());

async function register(where) {
	appendFileSync(process.env.BOOT_CUSTODY_START_LOG, `${where}:${threadId}\n`);
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
export async function startOnMainThread() {
	await register('main');
}
export async function start() {
	await register('worker');
}
