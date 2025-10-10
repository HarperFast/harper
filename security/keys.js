'use strict';

const path = require('path');
const { watch } = require('chokidar');
const fs = require('fs-extra');
const forge = require('node-forge');
const net = require('net');
let { generateKeyPair, X509Certificate, createPrivateKey, randomBytes } = require('node:crypto');
const util = require('util');
generateKeyPair = util.promisify(generateKeyPair);
const pki = forge.pki;
const { v4: uuidv4 } = require('uuid');
const { forComponent } = require('../utility/logging/harper_logger.js');
const envManager = require('../utility/environment/environmentManager.js');
const hdbTerms = require('../utility/hdbTerms.ts');
const { CONFIG_PARAMS } = hdbTerms;
const certificatesTerms = require('../utility/terms/certificates.js');
const tls = require('node:tls');
const { relative, join } = require('node:path');
const { CERTIFICATE_VALUES } = certificatesTerms;
const assignCmdenvVars = require('../utility/assignCmdEnvVariables.js');
const configUtils = require('../config/configUtils.js');
const { table, getDatabases, databases } = require('../resources/databases.ts');
const logger = forComponent('tls').conditional;
const { getThisNodeName, getThisNodeUrl, urlToNodeName, clearThisNodeName } = require('../server/nodeName.ts');

exports.generateKeys = generateKeys;
exports.updateConfigCert = updateConfigCert;
exports.setCertTable = setCertTable;
exports.loadCertificates = loadCertificates;
exports.reviewSelfSignedCert = reviewSelfSignedCert;
exports.createTLSSelector = createTLSSelector;
exports.generateCertsKeys = generateCertsKeys;
exports.getReplicationCert = getReplicationCert;
exports.getReplicationCertAuth = getReplicationCertAuth;
exports.renewSelfSigned = renewSelfSigned;
exports.hostnamesFromCert = hostnamesFromCert;
exports.getHostnamesFromCertificate = getHostnamesFromCertificate;
exports.getPrimaryHostName = getPrimaryHostName;
exports.generateSerialNumber = generateSerialNumber;

const { readFileSync, statSync } = require('node:fs');
const { getTicketKeys, onMessageFromWorkers } = require('../server/threads/manageThreads.js');
const { isMainThread } = require('worker_threads');
const { TLSSocket } = require('node:tls');

const CERT_VALIDITY_DAYS = 3650;
const CERT_DOMAINS = ['127.0.0.1', 'localhost', '::1'];
const CERT_ATTRIBUTES = [
	{ name: 'countryName', value: 'USA' },
	{ name: 'stateOrProvinceName', value: 'Colorado' },
	{ name: 'localityName', value: 'Denver' },
	{ name: 'organizationName', value: 'HarperDB, Inc.' },
];

/**
 * Generates a cryptographically secure serial number for X.509 certificates.
 *
 * Returns a hex string as expected by node-forge. Ensures the high bit is cleared
 * to create a positive ASN.1 INTEGER per RFC 5280 requirements.
 *
 * @returns {string} 16-character hex string
 */
function generateSerialNumber() {
	const bytes = randomBytes(8);
	bytes[0] = (bytes[0] & 0x7f) | 0x01; // Clear high bit with bitmask 0x7F (01111111) and ensure that it is non-zero
	return bytes.toString('hex');
}

onMessageFromWorkers(async (message) => {
	if (message.type === hdbTerms.ITC_EVENT_TYPES.RESTART) {
		envManager.initSync(true);
		// This will also call loadCertificates
		await reviewSelfSignedCert();
	}
});

let certificateTable;
function getCertTable() {
	if (!certificateTable) {
		certificateTable = getDatabases()['system']['hdb_certificate'];
		if (!certificateTable) {
			certificateTable = table({
				table: 'hdb_certificate',
				database: 'system',
				attributes: [
					{
						name: 'name',
						isPrimaryKey: true,
					},
					{
						attribute: 'uses',
					},
					{
						attribute: 'certificate',
					},
					{
						attribute: 'is_authority',
					},
					{
						attribute: 'private_key_name',
					},
					{
						attribute: 'details',
					},
					{
						attribute: 'is_self_signed',
					},
					{
						attribute: '__updatedtime__',
					},
				],
			});
		}
	}

	return certificateTable;
}

async function getReplicationCert() {
	const SNICallback = createTLSSelector('operations-api');
	const secureTarget = {
		secureContexts: null,
		setSecureContext: (ctx) => {},
	};
	await SNICallback.initialize(secureTarget);
	const cert = secureTarget.secureContexts.get(getThisNodeName());
	if (!cert) return;
	const certParsed = new X509Certificate(cert.options.cert);
	cert.cert_parsed = certParsed;
	cert.issuer = certParsed.issuer;

	return cert;
}

async function getReplicationCertAuth() {
	getCertTable();
	const certPem = (await getReplicationCert()).options.cert;
	const repCert = new X509Certificate(certPem);
	const caName = repCert.issuer.match(/CN=(.*)/)?.[1];
	return certificateTable.get(caName);
}

let configuredCertsLoaded;
const privateKeys = new Map();

/**
 * This is responsible for loading any certificates that are in the harperdb-config.yaml file and putting them into the hdbCertificate table.
 * @return {*}
 */
function loadCertificates() {
	if (configuredCertsLoaded) return;
	configuredCertsLoaded = true;
	// these are the sections of the config to check
	const CERTIFICATE_CONFIGS = [{ configKey: CONFIG_PARAMS.TLS }, { configKey: CONFIG_PARAMS.OPERATIONSAPI_TLS }];

	getCertTable();

	const rootPath = path.dirname(configUtils.getConfigFilePath());
	let promise;
	for (let { configKey: configKey } of CERTIFICATE_CONFIGS) {
		let configs = configUtils.getConfigFromFile(configKey);
		if (configs) {
			// the configs can be an array, so normalize to an array
			if (!Array.isArray(configs)) {
				configs = [configs];
			}
			for (let config of configs) {
				const privateKeyPath = config.privateKey;
				// need to relativize the paths so they aren't exposed
				let private_key_name = privateKeyPath && relative(join(rootPath, 'keys'), privateKeyPath);
				if (private_key_name) {
					loadAndWatch(
						privateKeyPath,
						(private_key) => {
							privateKeys.set(private_key_name, private_key);
						},
						'private key'
					);
				}
				for (let ca of [false, true]) {
					let path = config[ca ? 'certificateAuthority' : 'certificate'];
					if (path && isMainThread) {
						loadAndWatch(
							path,
							(certificate) => {
								if (CERTIFICATE_VALUES.cert === certificate) {
									// this is the compromised HarperDB certificate authority, and we do not even want to bother to
									// load it or tempted to use it anywhere
									return;
								}
								let hostnames = config.hostname ?? config.hostnames ?? config.host ?? config.hosts;
								if (hostnames && !Array.isArray(hostnames)) hostnames = [hostnames];
								const certificatePem = readPEM(path);
								const x509Cert = new X509Certificate(certificatePem);
								let certCn;
								try {
									certCn = getPrimaryHostName(x509Cert);
								} catch (err) {
									logger.error?.('error extracting host name from certificate', err);
									return;
								}

								if (certCn == null) {
									logger.error?.('No host name found on certificate');
									return;
								}

								// Check if cert issued by compromised HarperDB certificate authority, if it is, do not load it
								if (x509Cert.checkIssued(new X509Certificate(CERTIFICATE_VALUES.cert))) return;

								// If a record already exists for cert check to see who is newer, cert record or cert file.
								// If cert file is newer, add it to table
								const certRecord = certificateTable.primaryStore.get(certCn);
								let fileTimestamp = statSync(path).mtimeMs;
								let recordTimestamp =
									!certRecord || certRecord.is_self_signed
										? 1
										: (certRecord.file_timestamp ?? certRecord.__updatedtime__);
								if (certRecord && fileTimestamp <= recordTimestamp) {
									if (fileTimestamp < recordTimestamp)
										logger.info?.(
											`Certificate ${certCn} at ${path} is older (${new Date(
												fileTimestamp
											)}) than the certificate in the database (${
												recordTimestamp > 1 ? new Date(recordTimestamp) : 'only self signed certificate available'
											})`
										);
									return;
								}

								promise = certificateTable.put({
									name: certCn,
									uses: ['https', ...(configKey.includes('operations') ? ['operations'] : [])],
									ciphers: config.ciphers,
									certificate: certificatePem,
									private_key_name,
									is_authority: ca,
									hostnames,
									fileTimestamp,
									details: {
										issuer: x509Cert.issuer.replace(/\n/g, ' '),
										subject: x509Cert.subject?.replace(/\n/g, ' '),
										subject_alt_name: x509Cert.subjectAltName,
										serial_number: x509Cert.serialNumber,
										valid_from: x509Cert.validFrom,
										valid_to: x509Cert.validTo,
									},
								});
							},
							ca ? 'certificate authority' : 'certificate'
						);
					}
				}
			}
		}
	}
	return promise;
}

/**
 * Load the certificate file and watch for changes and reload with any changes
 * @param path
 * @param loadCert
 * @param type
 */
function loadAndWatch(path, loadCert, type) {
	let lastModified;
	const loadFile = (path, stats) => {
		try {
			let modified = stats.mtimeMs;
			if (modified && modified !== lastModified) {
				if (lastModified && isMainThread) logger.warn?.(`Reloading ${type}:`, path);
				lastModified = modified;
				loadCert(readPEM(path));
			}
		} catch (error) {
			logger.error?.(`Error loading ${type}:`, path, error);
		}
	};
	if (fs.existsSync(path)) loadFile(path, statSync(path));
	else logger.error?.(`${type} file not found:`, path);
	watch(path, { persistent: false }).on('change', loadFile);
}

function getHost() {
	let url = getThisNodeUrl();
	if (url == null) {
		const host = CERT_DOMAINS[0];
		logger.info?.('node url is missing from harperdb-config.yaml, using default host' + host);
		return host;
	}
	return urlToNodeName(url);
}

function getCommonName() {
	let node_name = getThisNodeName();
	if (node_name == null) {
		const host = CERT_DOMAINS[0];
		logger.info?.('replication url is missing from harperdb-config.yaml, using default host' + host);
		return host;
	}
	return node_name;
}

function certExtensions() {
	const altName = CERT_DOMAINS.includes(getCommonName()) ? CERT_DOMAINS : [...CERT_DOMAINS, getCommonName()];
	if (!altName.includes(getHost())) altName.push(getHost());
	return [
		{
			name: 'basicConstraints',
			cA: false,
			critical: true,
		},
		{
			name: 'keyUsage',
			digitalSignature: true,
			keyEncipherment: true,
			critical: true,
		},
		{
			name: 'extKeyUsage',
			serverAuth: true,
			clientAuth: true,
		},
		{
			name: 'nsCertType',
			client: true,
			server: true,
		},
		{
			name: 'subjectAltName',
			altNames: altName.map((domain) => {
				// types https://git.io/fptng
				if (net.isIP(domain)) {
					return { type: 7, ip: domain };
				}
				return { type: 2, value: domain };
			}),
		},
	];
}

async function createCertificateTable(cert, caCert) {
	await setCertTable({
		name: getThisNodeName(),
		uses: ['https', 'wss'],
		certificate: cert,
		private_key_name: 'privateKey.pem',
		is_authority: false,
		is_self_signed: true,
	});

	await setCertTable({
		name: caCert.subject.getField('CN').value,
		uses: ['https', 'wss'],
		certificate: pki.certificateToPem(caCert),
		private_key_name: 'privateKey.pem',
		is_authority: true,
		is_self_signed: true,
	});
}

async function setCertTable(certRecord) {
	let cert;
	try {
		cert = new X509Certificate(certRecord.certificate);
	} catch (error) {
		// Log the specific error for debugging
		logger.error?.(`Failed to parse certificate for ${certRecord.name}:`, error.message);
		// Log the certRecord for context
		logger.debug?.(`Certificate record details:`, JSON.stringify(certRecord, null, 2));

		// Throw a more descriptive error
		const certError = new Error(
			`Invalid certificate format for ${certRecord.name}: ${error.message}. ` +
				`This may be due to corrupted certificate data during transfer or encoding issues.`
		);
		certError.code = 'INVALID_CERTIFICATE_FORMAT';
		certError.cause = error;
		throw certError;
	}

	certRecord.details = {
		issuer: cert.issuer.replace(/\n/g, ' '),
		subject: cert.subject?.replace(/\n/g, ' '),
		subject_alt_name: cert.subjectAltName,
		serial_number: cert.serialNumber,
		valid_from: cert.validFrom,
		valid_to: cert.validTo,
	};

	getCertTable();
	await certificateTable.patch(certRecord);
}

async function generateKeys() {
	const keys = await generateKeyPair('rsa', {
		modulusLength: 4096,
		publicKeyEncoding: {
			type: 'spki',
			format: 'pem',
		},
		privateKeyEncoding: {
			type: 'pkcs8',
			format: 'pem',
		},
	});

	return {
		publicKey: pki.publicKeyFromPem(keys.publicKey),
		privateKey: pki.privateKeyFromPem(keys.privateKey),
	};
}

//https://www.openssl.org/docs/manmaster/man5/x509v3Config.html

async function generateCertificates(caPrivateKey, publicKey, caCert) {
	const publicCert = pki.createCertificate();

	if (!publicKey) {
		const repCert = await getReplicationCert();
		const opsCert = pki.certificateFromPem(repCert.options.cert);
		publicKey = opsCert.publicKey;
	}

	publicCert.publicKey = publicKey;
	publicCert.serialNumber = generateSerialNumber();
	publicCert.validity.notBefore = new Date();
	const notAfter = new Date();
	publicCert.validity.notAfter = notAfter;
	publicCert.validity.notAfter.setDate(notAfter.getDate() + CERT_VALIDITY_DAYS);

	const subject = [
		{
			name: 'commonName',
			value: getCommonName(),
		},
		...CERT_ATTRIBUTES,
	];

	publicCert.setSubject(subject);
	publicCert.setIssuer(caCert.subject.attributes);
	publicCert.setExtensions(certExtensions());
	publicCert.sign(caPrivateKey, forge.md.sha256.create());

	return pki.certificateToPem(publicCert);
}

async function getCertAuthority() {
	const allCerts = await listCertificates();
	let match;
	for (let cert of allCerts) {
		if (!cert.is_authority) continue;
		const matchingPrivateKey = await getPrivateKeyByName(cert.private_key_name);
		if (cert.private_key_name && matchingPrivateKey) {
			const keyCheck = new X509Certificate(cert.certificate).checkPrivateKey(createPrivateKey(matchingPrivateKey));
			if (keyCheck) {
				logger.trace?.(`CA named: ${cert.name} found with matching private key`);
				match = { ca: cert, private_key: matchingPrivateKey };
				break;
			}
		}
	}

	if (match) return match;
	logger.trace?.('No CA found with matching private key');
}

async function generateCertAuthority(private_key, publicKey, writeKey = true) {
	const caCert = pki.createCertificate();

	caCert.publicKey = publicKey;
	caCert.serialNumber = generateSerialNumber();
	caCert.validity.notBefore = new Date();
	const notAfter = new Date();
	caCert.validity.notAfter = notAfter;
	caCert.validity.notAfter.setDate(notAfter.getDate() + CERT_VALIDITY_DAYS);

	const subject = [
		{
			name: 'commonName',
			value: `HarperDB-Certificate-Authority-${envManager.get(CONFIG_PARAMS.NODE_HOSTNAME) ?? uuidv4().split('-')[0]}`,
		},
		...CERT_ATTRIBUTES,
	];
	caCert.setSubject(subject);
	caCert.setIssuer(subject);
	caCert.setExtensions([
		{ name: 'basicConstraints', cA: true, critical: true },
		{ name: 'keyUsage', keyCertSign: true, critical: true },
		// Subject Key Identifier is required for OCSP validation - helps OCSP responders
		// efficiently identify certificates in the chain and match them to their issuing CAs
		{ name: 'subjectKeyIdentifier' },
	]);

	caCert.sign(private_key, forge.md.sha256.create());

	const keysPath = path.join(envManager.getHdbBasePath(), hdbTerms.LICENSE_KEY_DIR_NAME);
	const privatePath = path.join(keysPath, certificatesTerms.PRIVATEKEY_PEM_NAME);
	if (writeKey) {
		await fs.writeFile(privatePath, pki.privateKeyToPem(private_key));
	}

	return caCert;
}

async function generateCertsKeys() {
	const { privateKey, publicKey } = await generateKeys();
	const caCert = await generateCertAuthority(privateKey, publicKey);
	const publicCert = await generateCertificates(privateKey, publicKey, caCert);
	await createCertificateTable(publicCert, caCert);
	updateConfigCert();
}

/**
 * Delete any existing self-signed certs (including CA) and create new ones
 * @returns {Promise<void>}
 */
async function renewSelfSigned() {
	getCertTable();
	for await (const cert of certificateTable.search([{ attribute: 'is_self_signed', value: true }])) {
		await certificateTable.delete(cert.name);
	}

	await reviewSelfSignedCert();
}

async function reviewSelfSignedCert() {
	// Clear any cached node name var
	clearThisNodeName();
	await loadCertificates();
	getCertTable();

	let caAndKey = await getCertAuthority();
	if (!caAndKey) {
		logger.notify?.(
			"A matching Certificate Authority and key was not found. A new CA will be created in advance, so it's available if needed."
		);

		const tryToParseKey = (keyPath) => {
			try {
				const key = pki.privateKeyFromPem(fs.readFileSync(keyPath));
				return { key, keyPath };
			} catch (err) {
				logger.warn?.(`Failed to parse private key from ${keyPath}:`, err.message);
				return { key: null, keyPath };
			}
		};

		// TLS config can be an array of cert, so we need to check each one
		const tlsConfig = envManager.get(CONFIG_PARAMS.TLS);
		let privateKey;
		let tlsPrivateKeyPath;
		if (Array.isArray(tlsConfig)) {
			for (const config of tlsConfig) {
				if (config.privateKey) {
					const result = tryToParseKey(config.privateKey);
					privateKey = result.key;
					tlsPrivateKeyPath = result.keyPath;
					if (result.key) {
						break; // Found a working key
					}
				}
			}
		} else {
			const keyPath = envManager.get(CONFIG_PARAMS.TLS_PRIVATEKEY);
			const result = tryToParseKey(keyPath);
			privateKey = result.key;
			tlsPrivateKeyPath = result.keyPath;
		}

		const keysPath = path.join(envManager.getHdbBasePath(), hdbTerms.LICENSE_KEY_DIR_NAME);
		let keyName = relative(keysPath, tlsPrivateKeyPath);
		if (!privateKey) {
			logger.warn?.(
				'Unable to parse the TLS key',
				tlsPrivateKeyPath,
				'A new key will be generated and used to create Certificate Authority'
			);
			// Currently we can only parse RSA keys, so if it's not an RSA key, we need to generate a new one
			// There is a ticket to add support for other key types CORE-2457
			({ privateKey } = await generateKeys());

			// If there is an existing private key, we will save the new one with a unique name
			if (fs.existsSync(path.join(keysPath, certificatesTerms.PRIVATEKEY_PEM_NAME)))
				keyName = `privateKey${uuidv4().split('-')[0]}.pem`;

			await fs.writeFile(path.join(keysPath, keyName), pki.privateKeyToPem(privateKey));
		}

		const hdbCa = await generateCertAuthority(privateKey, pki.setRsaPublicKey(privateKey.n, privateKey.e), false);

		await setCertTable({
			name: hdbCa.subject.getField('CN').value,
			uses: ['https'],
			certificate: pki.certificateToPem(hdbCa),
			private_key_name: keyName,
			is_authority: true,
			is_self_signed: true,
		});
	}

	const existingCert = await getReplicationCert();
	if (!existingCert) {
		const certName = getThisNodeName();
		logger.notify?.(
			`A suitable replication certificate was not found, creating new self singed cert named: ${certName}`
		);

		caAndKey = caAndKey ?? (await getCertAuthority());
		const hdbCa = pki.certificateFromPem(caAndKey.ca.certificate);
		const publicKey = hdbCa.publicKey;
		const newPublicCert = await generateCertificates(pki.privateKeyFromPem(caAndKey.private_key), publicKey, hdbCa);
		await setCertTable({
			name: certName,
			uses: ['https', 'operations', 'wss'],
			certificate: newPublicCert,
			is_authority: false,
			private_key_name: caAndKey.ca.private_key_name,
			is_self_signed: true,
		});
	}
}

// Update the cert config in harperdb-config.yaml
// If CLI or Env values are present it will use those values, else it will use default private key.
function updateConfigCert() {
	const cliEnvArgs = assignCmdenvVars(Object.keys(hdbTerms.CONFIG_PARAM_MAP), true);
	const keysPath = path.join(envManager.getHdbBasePath(), hdbTerms.LICENSE_KEY_DIR_NAME);
	const private_key = path.join(keysPath, certificatesTerms.PRIVATEKEY_PEM_NAME);

	// This object is what will be added to the harperdb-config.yaml file.
	// We check for any CLI of Env args and if they are present we use them instead of default values.
	const conf = hdbTerms.CONFIG_PARAMS;
	const newCerts = {
		[conf.TLS_PRIVATEKEY]: cliEnvArgs[conf.TLS_PRIVATEKEY.toLowerCase()]
			? cliEnvArgs[conf.TLS_PRIVATEKEY.toLowerCase()]
			: private_key,
	};

	if (cliEnvArgs[conf.TLS_CERTIFICATE.toLowerCase()]) {
		newCerts[conf.TLS_CERTIFICATE] = cliEnvArgs[conf.TLS_CERTIFICATE.toLowerCase()];
	}

	if (cliEnvArgs[conf.TLS_CERTIFICATEAUTHORITY.toLowerCase()]) {
		newCerts[conf.TLS_CERTIFICATEAUTHORITY] = cliEnvArgs[conf.TLS_CERTIFICATEAUTHORITY.toLowerCase()];
	}

	if (cliEnvArgs[conf.OPERATIONSAPI_TLS_CERTIFICATE.toLowerCase()]) {
		newCerts[conf.OPERATIONSAPI_TLS_CERTIFICATE] = cliEnvArgs[conf.OPERATIONSAPI_TLS_CERTIFICATE.toLowerCase()];
	}
	if (cliEnvArgs[conf.OPERATIONSAPI_TLS_PRIVATEKEY.toLowerCase()]) {
		newCerts[conf.OPERATIONSAPI_TLS_PRIVATEKEY] = cliEnvArgs[conf.OPERATIONSAPI_TLS_PRIVATEKEY.toLowerCase()];
	}
	if (cliEnvArgs[conf.OPERATIONSAPI_TLS_CERTIFICATEAUTHORITY.toLowerCase()]) {
		newCerts[conf.OPERATIONSAPI_TLS_CERTIFICATEAUTHORITY] =
			cliEnvArgs[conf.OPERATIONSAPI_TLS_CERTIFICATEAUTHORITY.toLowerCase()];
	}

	configUtils.updateConfigValue(undefined, undefined, newCerts, false, true);
}

function readPEM(path) {
	if (path.startsWith('-----BEGIN')) return path;
	return readFileSync(path, 'utf8');
}
// this horrifying hack is brought to you by https://github.com/nodejs/node/issues/36655
const origCreateSecureContext = tls.createSecureContext;
tls.createSecureContext = function (options) {
	if (!options.cert || !options.key) {
		return origCreateSecureContext(options);
	}
	let lessOptions = { ...options };
	delete lessOptions.key;
	delete lessOptions.cert;
	let ctx = origCreateSecureContext(lessOptions);
	ctx.context.setCert(options.cert);
	ctx.context.setKey(options.key, undefined);
	return ctx;
};
// Node.js SNI callbacks _add_ the certificate and don't replace it, and so we can't have a default certificate,
// so we have to assign the default certificate during the cert callback, because the default SNI callback isn't
// consistently called for all TLS connections (isn't called if no SNI server name is provided).
// first we have interrupt the socket initialization to add our own cert callback
const originalInit = TLSSocket.prototype._init;
TLSSocket.prototype._init = function (socket, wrap) {
	originalInit.call(this, socket, wrap);
	let tlsSocket = this;
	this._handle.oncertcb = function (info) {
		const servername = info.servername;
		tlsSocket._SNICallback(servername, (err, context) => {
			this.sni_context = context?.context || context;
			// note that this skips the checks for multiple callbacks and entirely skips OCSP, so if we ever need that, we
			// need to call the original oncertcb
			this.certCbDone();
		});
	};
};

let caCerts = new Map();

/**
 * Create a TLS selector that will choose the best TLS configuration/context for a given hostname
 * @param type
 * @param mtlsOptions
 * @return {(function(*, *): (*|undefined))|*}
 */
function createTLSSelector(type, mtlsOptions) {
	let secureContexts = new Map();
	let defaultContext;
	let hasWildcards = false;
	SNICallback.initialize = (server) => {
		if (SNICallback.ready) return SNICallback.ready;
		if (server) {
			server.secureContexts = secureContexts;
			server.secureContextsListeners = [];
		}
		return (SNICallback.ready = new Promise((resolve, reject) => {
			async function updateTLS() {
				try {
					secureContexts.clear();
					caCerts.clear();
					let bestQuality = 0;
					if (databases === undefined) {
						resolve();
						return;
					}
					for await (const cert of databases.system.hdb_certificate.search([])) {
						const certificate = cert.certificate;
						const certParsed = new X509Certificate(certificate);
						if (cert.is_authority) {
							certParsed.asString = certificate;
							caCerts.set(certParsed.subject, certificate);
						}
					}

					for await (const cert of databases.system.hdb_certificate.search([])) {
						try {
							if (cert.is_authority) {
								continue;
							}
							let isOperations = type === 'operations-api';
							let quality = cert.is_self_signed ? 1 : 3;
							// prefer operations certificates for operations API
							if (isOperations && cert.uses?.includes?.('operations')) quality += 1;

							const private_key = await getPrivateKeyByName(cert.private_key_name);

							let certificate = cert.certificate;
							const certParsed = new X509Certificate(certificate);
							if (caCerts.has(certParsed.issuer)) {
								certificate += '\n' + caCerts.get(certParsed.issuer);
							}
							if (!private_key || !certificate) {
								throw new Error('Missing private key or certificate for secure server');
							}
							const secureOptions = {
								ciphers: cert.ciphers,
								ticketKeys: getTicketKeys(),
								availableCAs: caCerts, // preserve the record of caCerts even if not used for mTLS here
								ca: mtlsOptions && Array.from(caCerts.values()),
								cert: certificate,
								key: private_key,
								key_file: cert.private_key_name,
								is_self_signed: cert.is_self_signed,
							};
							if (server) secureOptions.sessionIdContext = server.sessionIdContext;
							let hostnames = cert.hostnames ?? hostnamesFromCert(certParsed);
							if (!Array.isArray(hostnames)) hostnames = [hostnames];
							for (let hostname of hostnames) {
								if (hostname === getHost()) quality += 1; // prefer a certificate that has our hostname in the SANs
							}
							let secureContext = tls.createSecureContext(secureOptions);
							secureContext.name = cert.name;
							secureContext.options = secureOptions;
							secureContext.quality = quality;
							secureContext.certificateAuthorities = Array.from(caCerts);
							// we store the first 100 bytes of the certificate just for debug logging
							secureContext.certStart = certificate.toString().slice(0, 100);
							// we want to configure SNI handling to pick the right certificate based on all the registered SANs
							// in the certificate
							for (let hostname of hostnames) {
								if (hostname) {
									if (hostname[0] === '*') {
										hasWildcards = true;
										hostname = hostname.slice(1);
									}
									// we use this certificate if it has a higher quality than the existing one for this hostname
									let existingCertQuality = secureContexts.get(hostname)?.quality ?? 0;
									logger.trace?.('Assigning TLS for hostname', hostname, 'if', quality, '>', existingCertQuality);
									if (quality > existingCertQuality) {
										secureContexts.set(hostname, secureContext);
									}
								} else {
									logger.error?.('No hostname found for certificate at', tls.certificate);
								}
							}
							logger.trace?.(
								'Adding TLS',
								secureContext.name,
								'for',
								server.ports || 'client',
								'cert named',
								cert.name,
								'hostnames',
								hostnames,
								'quality',
								quality,
								'best quality',
								bestQuality
							);
							if (quality > bestQuality /* && hasIpAddress*/) {
								// we use this certificate as the default if it has a higher quality than the existing one
								SNICallback.defaultContext = defaultContext = secureContext;
								bestQuality = quality;
								if (server) {
									server.defaultContext = secureContext;
									// note that we can not set the secure context on the server here, because this creates an
									// indeterminate situation of whether openssl will use this certificate or the one from the SNI
									// callback
									//server.setSecureContext?.(server, secureOptions);
								}
							}
						} catch (error) {
							logger.error?.('Error applying TLS for', cert.name, error);
						}
					}
					server?.secureContextsListeners.forEach((listener) => listener());
					resolve(defaultContext);
				} catch (error) {
					reject(error);
				}
			}
			databases?.system.hdb_certificate.subscribe({
				listener: () => setTimeout(() => updateTLS(), 1500).unref(),
				omitCurrent: true,
			});
			updateTLS();
		}));
	};
	return SNICallback;
	function SNICallback(servername, cb) {
		// find the matching server name, substituting wildcards for each part of the domain to find matches
		logger.info?.('TLS requested for', servername || '(no SNI)');
		let matchingName = servername;
		while (true) {
			let context = secureContexts.get(matchingName);
			if (context) {
				logger.debug?.('Found certificate for', servername, context.certStart);
				// check if there is a updated context, which is used by replication to replace the context with TLS with
				// full set of CAs
				if (context.updatedContext) context = context.updatedContext;
				return cb(null, context);
			}
			if (hasWildcards && matchingName) {
				let nextDot = matchingName.indexOf('.', 1);
				if (nextDot < 0) matchingName = '';
				else matchingName = matchingName.slice(nextDot);
			} else break;
		}
		if (servername) logger.debug?.('No certificate found to match', servername, 'using the default certificate');
		else logger.debug?.('No SNI, using the default certificate', defaultContext?.name);
		// no matches, return the first/default one
		let context = defaultContext;
		if (!context) logger.info?.('No default certificate found');
		else if (context.updatedContext) context = context.updatedContext;
		cb(null, context);
	}
}

async function getPrivateKeyByName(private_key_name) {
	const private_key = privateKeys.get(private_key_name);
	if (!private_key && private_key_name) {
		return await fs.readFile(
			path.join(envManager.get(CONFIG_PARAMS.ROOTPATH), hdbTerms.LICENSE_KEY_DIR_NAME, private_key_name),
			'utf8'
		);
	}

	return private_key;
}

/**
 * List all the records in hdbCertificate table
 * @returns {Promise<*[]>}
 */
async function listCertificates() {
	getCertTable();
	let response = [];
	for await (const cert of certificateTable.search([])) {
		response.push(cert);
	}
	return response;
}

function getPrimaryHostName(cert /*X509Certificate*/) {
	const commonName = cert.subject?.match(/CN=(.*)/)?.[1];
	if (commonName) return commonName;
	return hostnamesFromCert(cert)[0];
}

function hostnamesFromCert(cert /*X509Certificate*/) {
	if (cert.subjectAltName) {
		return cert.subjectAltName
			.split(',')
			.map((part) => {
				// the subject alt names looks like 'IP Address:127.0.0.1, DNS:localhost, IP
				// Address:0:0:0:0:0:0:0:1, DirName:"CN=localhost"'
				// so we split on commas and then use the part after the colon as the host name

				let colonIndex = part.indexOf(':'); // get the value part
				part = part.slice(colonIndex + 1);
				part = part.trim();
				if (part[0] === '"') {
					// quoted value
					try {
						part = JSON.parse(part);
					} catch {
						// ignore
					}
				}
				// can have name=value inside
				if (part.indexOf('=') > -1) return part.match(/CN=([^,]*)/)?.[1];
				return part;
			})
			.filter((part) => part); // filter out any empty names
	}
	// finally we fall back to the common name
	const commonName = cert.subject?.match(/CN=(.*)/)?.[1];
	return commonName ? [commonName] : [];
}

function getHostnamesFromCertificate(certificate) {
	return [
		certificate.subject?.CN, // use the subject if it exists
		...certificate.subjectaltname // otherwise use the subject alternative names
			.split(',')
			.filter((n) => n.trim().startsWith('DNS:')) // find the DNS names
			.map((n) => n.trim().substring(4)),
	];
}
