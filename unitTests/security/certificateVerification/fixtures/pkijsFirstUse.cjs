'use strict';

// Runs in a fresh process: reports whether PKI.js loads with the verification modules, and whether it is
// patched by the time the first consumer (named in argv) has used it.
const { webcrypto } = require('node:crypto');

const isPkijsLoaded = () => Object.keys(require.cache).some((path) => path.includes('/node_modules/pkijs/'));

async function main() {
	const ocsp = require('#src/security/certificateVerification/ocspVerification');
	const utils = require('#src/security/certificateVerification/verificationUtils');
	const loadedWithModules = isPkijsLoaded();
	if (process.argv[2] === 'ocsp')
		await ocsp.performOCSPCheck('not a certificate', 'not a certificate', { timeout: 100 });
	else utils.extractRevocationUrls('not a certificate');
	const pkijs = require('pkijs');
	const engine = new pkijs.CryptoEngine({ crypto: webcrypto });
	process.stdout.write(
		JSON.stringify({
			loadedWithModules,
			loadedAfterFirstUse: isPkijsLoaded(),
			ed25519Hash: engine.getHashAlgorithm({ algorithmId: '1.3.101.112' }),
		})
	);
}

main().then(
	() => process.exit(0),
	(error) => {
		process.stderr.write(String(error?.stack ?? error));
		process.exit(1);
	}
);
