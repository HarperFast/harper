// Stands in for Harper Pro's secrets component: registers an `enc:v1:` decryptor whose payload is
// base64 plaintext. `materializeGitSSH` only needs a function that turns the envelope into the key
// or throws, so a fake exercises the same path a real RSA/AES-GCM decryptor would.
//
// `deploy_component`'s git spawn runs on the main thread, and `handleApplication` never runs there
// (componentLoader gates it on `isWorker`), so the decryptor has to be registered from
// `startOnMainThread` to land in the module instance `materializeGitSSH` reads.
export async function startOnMainThread() {
	const { pathToFileURL } = await import('node:url');
	const path = await import('node:path');

	const distPath = (...segments) =>
		pathToFileURL(path.join(import.meta.dirname, '..', '..', '..', 'dist', ...segments)).toString();

	const { registerSecretDecryptor } = await import(distPath('resources', 'secretDecryptor.js'));
	const { default: logger } = await import(distPath('utility', 'logging', 'harper_logger.js'));

	registerSecretDecryptor((rawValue) => Buffer.from(rawValue.slice('enc:v1:'.length), 'base64').toString('utf8'));

	logger.info?.('QA581 fake ssh-key decryptor registered (main thread)');
}
