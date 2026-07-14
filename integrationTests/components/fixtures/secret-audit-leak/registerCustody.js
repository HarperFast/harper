// QA-517 test-only builtin component.
//
// components/secretOperations.ts requires `getSecretCustody()` to be non-null for `set_secret`
// with a plaintext `value` to work at all ("secrets custody is not initialized on this node").
// Core ships no custody (that's the Harper Pro secrets component's job); this registers a real,
// in-process RSA keypair as custody so set_secret's real encrypt-then-put path runs end-to-end
// (no mocks), exactly like the shipped unit test's `installCustody()` helper.
//
// secretOperations.ts's handlers dispatch on the ops-API MAIN THREAD ONLY (see its own comment),
// so registration must happen on the main thread too — the `handleApplication` Plugin API (used
// by qa487's registerDecryptor.js) only runs per-WORKER (componentLoader.ts's `resources.isWorker`
// gate), which would be invisible to the main-thread dispatch. `startOnMainThread` (old Extension
// API, still supported — componentLoader.ts only warns, doesn't block) runs exactly once on the
// main thread, which is what's needed here.
import { generateKeyPairSync } from 'node:crypto';
import { join, dirname } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

export async function startOnMainThread() {
	// Reach the running install's own dist build directly, so this external fixture file shares
	// the exact module instance (and registry state) that components/secretOperations.ts's dist
	// counterpart imports.
	const distSecretDecryptorPath = join(__dirname, '..', '..', '..', '..', 'dist', 'resources', 'secretDecryptor.js');
	const { registerSecretCustody } = await import(pathToFileURL(distSecretDecryptorPath).toString());

	const { publicKey, privateKey } = generateKeyPairSync('rsa', {
		modulusLength: 2048,
		publicKeyEncoding: { type: 'spki', format: 'pem' },
		privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
	});

	const distSecretEnvelopePath = join(__dirname, '..', '..', '..', '..', 'dist', 'utility', 'secretEnvelope.js');
	const { fingerprintOf, decryptEnvelope } = await import(pathToFileURL(distSecretEnvelopePath).toString());
	const fingerprint = fingerprintOf(publicKey);
	const PREFIX = 'enc:v1:';

	registerSecretCustody({
		decrypt: (value) => decryptEnvelope(value.slice(PREFIX.length), privateKey, fingerprint),
		getPublicKey: () => ({ publicKey, fingerprint }),
	});

	// eslint-disable-next-line no-console
	console.log(`QA517 fake secret custody registered on main thread, fingerprint=${fingerprint}`);
}
