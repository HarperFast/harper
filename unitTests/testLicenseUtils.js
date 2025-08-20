const { createPrivateKey, sign, randomUUID } = require('node:crypto');

const LICENSE_PRIVATE_KEY = `-----BEGIN PRIVATE KEY-----
MC4CAQAwBQYDK2VwBCIEIAAe+bdBWCbmzgPgfzf5L7L1npsgi+Wkz+uNb9lgcA/w
-----END PRIVATE KEY-----
`;

function generateValidLicensePayload() {
	const now = new Date();
	const expiration = new Date(now.getFullYear() + 1, now.getMonth(), now.getDate());
	const uuid = randomUUID();
	return {
		id: 'test-id-' + uuid,
		level: 0,
		region: 'test',
		expiration,
		reads: 10000,
		writes: 10000,
		readBytes: 1000000000,
		writeBytes: 1000000000,
		realTimeMessages: 10000,
		realTimeBytes: 1000000000,
		cpuTime: 10000,
		storage: 10000000,
	};
}

function signTestLicense(payload) {
	const header = { typ: 'Harper-License', alg: 'EdDSA' };
	const license = [JSON.stringify(header), JSON.stringify(payload)]
		.map((e) => Buffer.from(e).toString('base64url'))
		.join('.');
	const privateKey = createPrivateKey(LICENSE_PRIVATE_KEY);
	return license + '.' + sign(null, Buffer.from(license, 'utf8'), privateKey).toString('base64url');
}

function generateTestLicense(overrides) {
	const licensePayload = { ...generateValidLicensePayload(), ...overrides };
	return signTestLicense(licensePayload);
}

// for testing errors that get past signature verification
function signAnything(anything) {
	const privateKey = createPrivateKey(LICENSE_PRIVATE_KEY);
	return anything + '.' + sign(null, Buffer.from(anything, 'utf8'), privateKey).toString('base64url');
}

module.exports = {
	generateValidLicensePayload,
	generateTestLicense,
	signTestLicense,
	signAnything,
};
