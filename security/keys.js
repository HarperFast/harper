'use strict';

const path = require('path');
const { watch } = require('chokidar');
const fs = require('fs-extra');
const forge = require('node-forge');
const net = require('net');
let { generateKeyPair, X509Certificate, createPrivateKey } = require('crypto');
const util = require('util');
generateKeyPair = util.promisify(generateKeyPair);
const pki = forge.pki;
const Joi = require('joi');
const { v4: uuidv4 } = require('uuid');
const { validateBySchema } = require('../validation/validationWrapper.js');
const { forComponent } = require('../utility/logging/harper_logger.js');
const envManager = require('../utility/environment/environmentManager.js');
const hdbTerms = require('../utility/hdbTerms.ts');
const { CONFIG_PARAMS } = hdbTerms;
const certificatesTerms = require('../utility/terms/certificates.js');
const { ClientError } = require('../utility/errors/hdbError.js');
const tls = require('node:tls');
const { relative, join } = require('node:path');
const { CERT_PREFERENCE_APP, CERTIFICATE_VALUES } = certificatesTerms;
const assignCmdenvVars = require('../utility/assignCmdEnvVariables.js');
const configUtils = require('../config/configUtils.js');
const { table, getDatabases, databases } = require('../resources/databases.ts');
const { getJWTRSAKeys } = require('./tokenAuthentication.ts');
const logger = forComponent('tls');

exports.generateKeys = generateKeys;
exports.updateConfigCert = updateConfigCert;
exports.createCsr = createCsr;
exports.signCertificate = signCertificate;
exports.setCertTable = setCertTable;
exports.loadCertificates = loadCertificates;
exports.reviewSelfSignedCert = reviewSelfSignedCert;
exports.createTLSSelector = createTLSSelector;
exports.listCertificates = listCertificates;
exports.addCertificate = addCertificate;
exports.removeCertificate = removeCertificate;
exports.createNatsCerts = createNatsCerts;
exports.generateCertsKeys = generateCertsKeys;
exports.getReplicationCert = getReplicationCert;
exports.getReplicationCertAuth = getReplicationCertAuth;
exports.renewSelfSigned = renewSelfSigned;
exports.hostnamesFromCert = hostnamesFromCert;
exports.getKey = getKey;
exports.getHostnamesFromCertificate = getHostnamesFromCertificate;

const {
	urlToNodeName,
	getThisNodeUrl,
	getThisNodeName,
	clearThisNodeName,
} = require('../server/replication/replicator.ts');
const { readFileSync, statSync } = require('node:fs');
const env = require('../utility/environment/environmentManager.js');
const { getTicketKeys, onMessageFromWorkers } = require('../server/threads/manageThreads.js');
const harperLogger = require('../utility/logging/harper_logger.js');
const { isMainThread } = require('worker_threads');
const { TLSSocket, createSecureContext } = require('node:tls');

const CERT_VALIDITY_DAYS = 3650;
const CERT_DOMAINS = ['127.0.0.1', 'localhost', '::1'];
const CERT_ATTRIBUTES = [
	{ name: 'countryName', value: 'USA' },
	{ name: 'stateOrProvinceName', value: 'Colorado' },
	{ name: 'localityName', value: 'Denver' },
	{ name: 'organizationName', value: 'HarperDB, Inc.' },
];
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
						let lastModified;
						loadAndWatch(
							path,
							(certificate) => {
								if (CERTIFICATE_VALUES.cert === certificate) {
									// this is the compromised HarperDB certificate authority, and we do not even want to bother to
									// load it or tempted to use it anywhere (except NATS can directly load it)
									return;
								}
								let hostnames = config.hostname ?? config.hostnames ?? config.host ?? config.hosts;
								if (hostnames && !Array.isArray(hostnames)) hostnames = [hostnames];
								const certificatePem = readPEM(path);
								const x509Cert = new X509Certificate(certificatePem);
								let certCn;
								try {
									certCn = extractCommonName(x509Cert);
								} catch (err) {
									logger.error('error extracting common name from certificate', err);
									return;
								}

								if (certCn == null) {
									logger.error('error extracting common name from certificate');
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
										logger.info(
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
										subject: x509Cert.subject.replace(/\n/g, ' '),
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
				if (lastModified && isMainThread) logger.warn(`Reloading ${type}:`, path);
				lastModified = modified;
				loadCert(readPEM(path));
			}
		} catch (error) {
			logger.error(`Error loading ${type}:`, path, error);
		}
	};
	if (fs.existsSync(path)) loadFile(path, statSync(path));
	else logger.error(`${type} file not found:`, path);
	watch(path, { persistent: false }).on('change', loadFile);
}

function getHost() {
	let url = getThisNodeUrl();
	if (url == null) {
		const host = CERT_DOMAINS[0];
		logger.info('replication url is missing from harperdb-config.yaml, using default host' + host);
		return host;
	}
	return urlToNodeName(url);
}

function getCommonName() {
	let node_name = getThisNodeName();
	if (node_name == null) {
		const host = CERT_DOMAINS[0];
		logger.info('replication url is missing from harperdb-config.yaml, using default host' + host);
		return host;
	}
	return node_name;
}

async function createCsr() {
	const rep = await getReplicationCert();
	const opsCert = pki.certificateFromPem(rep.options.cert);
	const opsPrivateKey = pki.privateKeyFromPem(rep.options.key);

	logger.info('Creating CSR with cert named:', rep.name);

	const csr = pki.createCertificationRequest();
	csr.publicKey = opsCert.publicKey;
	const subject = [
		{
			name: 'commonName',
			value: getCommonName(),
		},
		...CERT_ATTRIBUTES,
	];
	logger.info('Creating CSR with subject', subject);
	csr.setSubject(subject);

	const attributes = [
		{
			name: 'unstructuredName',
			value: 'HarperDB, Inc.',
		},
		{
			name: 'extensionRequest',
			extensions: certExtensions(),
		},
	];
	logger.info('Creating CSR with attributes', attributes);
	csr.setAttributes(attributes);

	csr.sign(opsPrivateKey);

	return forge.pki.certificationRequestToPem(csr);
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

async function signCertificate(req) {
	const response = {};
	const hdbKeysDir = path.join(envManager.getHdbBasePath(), hdbTerms.LICENSE_KEY_DIR_NAME);

	if (req.csr) {
		let private_key;
		let cert_auth;
		getCertTable();

		// Search hdbCertificate for a non-HDB CA that also has a local private key
		for await (const cert of certificateTable.search([])) {
			if (cert.is_authority && !cert.details.issuer.includes('HarperDB-Certificate-Authority')) {
				if (privateKeys.has(cert.private_key_name)) {
					private_key = privateKeys.get(cert.private_key_name);
					cert_auth = cert;
					break;
				} else if (cert.private_key_name && (await fs.exists(path.join(hdbKeysDir, cert.private_key_name)))) {
					private_key = fs.readFile(path.join(hdbKeysDir, cert.private_key_name));
					cert_auth = cert;
					break;
				}
			}
		}

		// If the search above did not find a CA look for a CA with a matching private key
		if (!private_key) {
			const certAndKey = await getCertAuthority();
			cert_auth = certAndKey.ca;
			private_key = certAndKey.private_key;
		}

		private_key = pki.privateKeyFromPem(private_key);
		response.signingCA = cert_auth.certificate;
		const caAppCert = pki.certificateFromPem(cert_auth.certificate);
		logger.info('Signing CSR with cert named', cert_auth.name);
		const csr = pki.certificationRequestFromPem(req.csr);
		try {
			csr.verify();
		} catch (err) {
			logger.error(err);
			return new Error(`Error verifying CSR: ` + err.message);
		}

		const cert = forge.pki.createCertificate();
		cert.serialNumber = Math.random().toString().slice(2, 10);
		cert.validity.notBefore = new Date();
		const notAfter = new Date();
		cert.validity.notAfter = notAfter;
		cert.validity.notAfter.setDate(notAfter.getDate() + CERT_VALIDITY_DAYS);
		logger.info('sign cert setting validity:', cert.validity);

		// subject from CSR
		logger.info('sign cert setting subject from CSR:', csr.subject.attributes);
		cert.setSubject(csr.subject.attributes);

		// issuer from CA
		logger.info('sign cert setting issuer:', caAppCert.subject.attributes);
		cert.setIssuer(caAppCert.subject.attributes);

		const extensions = csr.getAttribute({ name: 'extensionRequest' }).extensions;
		logger.info('sign cert adding extensions from CSR:', extensions);
		cert.setExtensions(extensions);

		cert.publicKey = csr.publicKey;
		cert.sign(private_key, forge.md.sha256.create());

		response.certificate = pki.certificateToPem(cert);
	} else {
		logger.info('Sign cert did not receive a CSR from:', req.url, 'only the CA will be returned');
	}

	return response;
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
	const cert = new X509Certificate(certRecord.certificate);
	certRecord.details = {
		issuer: cert.issuer.replace(/\n/g, ' '),
		subject: cert.subject.replace(/\n/g, ' '),
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
	publicCert.serialNumber = Math.random().toString().slice(2, 10);
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
				logger.trace(`CA named: ${cert.name} found with matching private key`);
				match = { ca: cert, private_key: matchingPrivateKey };
				break;
			}
		}
	}

	if (match) return match;
	logger.trace('No CA found with matching private key');
}

async function generateCertAuthority(private_key, publicKey, writeKey = true) {
	const caCert = pki.createCertificate();

	caCert.publicKey = publicKey;
	caCert.serialNumber = Math.random().toString().slice(2, 10);
	caCert.validity.notBefore = new Date();
	const notAfter = new Date();
	caCert.validity.notAfter = notAfter;
	caCert.validity.notAfter.setDate(notAfter.getDate() + CERT_VALIDITY_DAYS);

	const subject = [
		{
			name: 'commonName',
			value: `HarperDB-Certificate-Authority-${
				envManager.get(CONFIG_PARAMS.REPLICATION_HOSTNAME) ??
				urlToNodeName(envManager.get(CONFIG_PARAMS.REPLICATION_URL)) ??
				uuidv4().split('-')[0]
			}`,
		},
		...CERT_ATTRIBUTES,
	];
	caCert.setSubject(subject);
	caCert.setIssuer(subject);
	caCert.setExtensions([
		{ name: 'basicConstraints', cA: true, critical: true },
		{ name: 'keyUsage', keyCertSign: true, critical: true },
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

async function createNatsCerts() {
	const publicCert = await generateCertificates(
		pki.privateKeyFromPem(certificatesTerms.CERTIFICATE_VALUES.key),
		undefined,
		pki.certificateFromPem(certificatesTerms.CERTIFICATE_VALUES.cert)
	);

	const keysPath = path.join(envManager.getHdbBasePath(), hdbTerms.LICENSE_KEY_DIR_NAME);

	const pubCertPath = path.join(keysPath, certificatesTerms.NATS_CERTIFICATE_PEM_NAME);
	if (!(await fs.exists(pubCertPath))) await fs.writeFile(pubCertPath, publicCert);

	const caCertPath = path.join(keysPath, certificatesTerms.NATS_CA_PEM_NAME);
	if (!(await fs.exists(caCertPath))) await fs.writeFile(caCertPath, certificatesTerms.CERTIFICATE_VALUES.cert);
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
		logger.notify(
			"A matching Certificate Authority and key was not found. A new CA will be created in advance, so it's available if needed."
		);

		const tlsPrivateKey = envManager.get(CONFIG_PARAMS.TLS_PRIVATEKEY);
		const keysPath = path.join(envManager.getHdbBasePath(), hdbTerms.LICENSE_KEY_DIR_NAME);
		let privateKey;
		let keyName = relative(keysPath, tlsPrivateKey);
		try {
			privateKey = pki.privateKeyFromPem(await fs.readFile(tlsPrivateKey));
		} catch (err) {
			logger.warn(
				'Unable to parse the TLS key',
				tlsPrivateKey,
				'A new key will be generated and used to create Certificate Authority',
				err
			);
			// Currently we can only parse RSA keys, so if it's not an RSA key, we need to generate a new one
			// There is a ticket to add support for other key types CORE-2457
			({ privateKey } = await generateKeys());

			// If there is an existing private key, we will save the new one with a unique name
			if (await fs.exists(path.join(keysPath, certificatesTerms.PRIVATEKEY_PEM_NAME)))
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
		logger.notify(`A suitable replication certificate was not found, creating new self singed cert named: ${certName}`);

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
	const natsPubCert = path.join(keysPath, certificatesTerms.NATS_CERTIFICATE_PEM_NAME);
	const natsCa = path.join(keysPath, certificatesTerms.NATS_CA_PEM_NAME);

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

	// Add paths for Nats TLS certs if clustering enabled
	if (cliEnvArgs[conf.CLUSTERING_ENABLED.toLowerCase()] || cliEnvArgs['clustering']) {
		newCerts[conf.CLUSTERING_TLS_CERTIFICATE] =
			cliEnvArgs[conf.CLUSTERING_TLS_CERTIFICATE.toLowerCase()] ?? natsPubCert;
		newCerts[conf.CLUSTERING_TLS_CERT_AUTH] = cliEnvArgs[conf.CLUSTERING_TLS_CERT_AUTH.toLowerCase()] ?? natsCa;
		newCerts[conf.CLUSTERING_TLS_PRIVATEKEY] = cliEnvArgs[conf.CLUSTERING_TLS_PRIVATEKEY.toLowerCase()] ?? private_key;
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
							let quality = cert.is_self_signed ? 1 : 2;
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
							let secureContext = tls.createSecureContext(secureOptions);
							secureContext.name = cert.name;
							secureContext.options = secureOptions;
							secureContext.quality = quality;
							secureContext.certificateAuthorities = Array.from(caCerts);
							// we store the first 100 bytes of the certificate just for debug logging
							secureContext.certStart = certificate.toString().slice(0, 100);
							// we want to configure SNI handling to pick the right certificate based on all the registered SANs
							// in the certificate
							let hostnames = cert.hostnames ?? hostnamesFromCert(certParsed);
							if (!Array.isArray(hostnames)) hostnames = [hostnames];
							let hasIpAddress;
							for (let hostname of hostnames) {
								if (hostname) {
									if (hostname[0] === '*') {
										hasWildcards = true;
										hostname = hostname.slice(1);
									}
									if (hostname === getHost()) quality += 2; // prefer a certificate with our hostname as the default
									if (net.isIP(hostname)) hasIpAddress = true;
									// we use this certificate if it has a higher quality than the existing one for this hostname
									let existingCertQuality = secureContexts.get(hostname)?.quality ?? 0;
									if (quality > existingCertQuality) {
										secureContexts.set(hostname, secureContext);
									}
								} else {
									harperLogger.error('No hostname found for certificate at', tls.certificate);
								}
							}
							harperLogger.trace(
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
							harperLogger.error('Error applying TLS for', cert.name, error);
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
		harperLogger.info('TLS requested for', servername || '(no SNI)');
		let matchingName = servername;
		while (true) {
			let context = secureContexts.get(matchingName);
			if (context) {
				harperLogger.debug('Found certificate for', servername, context.certStart);
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
		if (servername) harperLogger.debug('No certificate found to match', servername, 'using the default certificate');
		else harperLogger.debug('No SNI, using the default certificate', defaultContext?.name);
		// no matches, return the first/default one
		let context = defaultContext;
		if (!context) harperLogger.info('No default certificate found');
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

function reverseSubscription(subscription) {
	const { subscribe, publish } = subscription;
	return { ...subscription, subscribe: publish, publish: subscribe };
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

/**
 * Adds a certificate to hdbCertificate table. If a private key is provided it will write it to file
 * Can be used to add a new one or update existing
 * @param req.name - primary key of hdbCertificate
 * @param req.certificate - cert that will be added, as a string
 * @param req.private_key - optional, private key as a string. Will be written to file and not to hdbCertificate
 * @param req.is_authority - is the certificate a CA
 * @param req.hosts - array of allowable hosts
 * @returns {Promise<string>}
 */
async function addCertificate(req) {
	const validation = validateBySchema(
		req,
		Joi.object({
			name: Joi.string().required(),
			certificate: Joi.string().required(),
			is_authority: Joi.boolean().required(),
			private_key: Joi.string(),
			hosts: Joi.array(),
			uses: Joi.array(),
		})
	);
	if (validation) throw new ClientError(validation.message);

	const { name, certificate, private_key, is_authority } = req;
	const x509Cert = new X509Certificate(certificate);
	let privateKeyExists = false;
	let privateKeyMatch = false;
	let existingPrivateKeyName;
	for (const [keyName, key] of privateKeys) {
		// If a private key is not provided we search all existing private keys to see if there is one that was used to sign the cert.
		if (!private_key && !privateKeyExists) {
			const check = x509Cert.checkPrivateKey(createPrivateKey(key));
			if (check) {
				privateKeyExists = true;
				existingPrivateKeyName = keyName;
			}
		}

		// If a private key was provided we check to see if it already exists, so that we don't store the same key twice.
		if (private_key && private_key === key) {
			privateKeyMatch = true;
			existingPrivateKeyName = keyName;
		}
	}

	if (!is_authority && !private_key && !privateKeyExists)
		throw new ClientError('A suitable private key was not found for this certificate');

	let certCn;
	if (!name) {
		try {
			certCn = extractCommonName(x509Cert);
		} catch (err) {
			logger.error(err);
		}

		if (certCn == null) {
			throw new ClientError('Error extracting certificate common name, please provide a name parameter');
		}
	}

	const saniName = sanitizeName(name ?? certCn);
	if (private_key && !privateKeyExists && !privateKeyMatch) {
		await fs.writeFile(
			path.join(envManager.getHdbBasePath(), hdbTerms.LICENSE_KEY_DIR_NAME, saniName + '.pem'),
			private_key
		);
		privateKeys.set(saniName, private_key);
	}

	const record = {
		name: name ?? certCn,
		certificate,
		is_authority,
		hosts: req.hosts,
		uses: req.uses,
	};

	if (!is_authority || (is_authority && existingPrivateKeyName) || (is_authority && private_key)) {
		record.private_key_name = existingPrivateKeyName ?? saniName + '.pem';
	}

	await setCertTable(record);

	return 'Successfully added certificate: ' + saniName;
}

/**
 * Used to sanitize a cert common name or the 'name' param used in cert ops
 * @param cn
 * @returns {*}
 */
function sanitizeName(cn) {
	return cn.replace(/[^a-z0-9\.]/gi, '-');
}

/**
 * Removes certificate from hdbCertificate and corresponding private key file
 * @param req.name - Name of the cert as it is in hdbCertificate
 * @returns {Promise<string>}
 */
async function removeCertificate(req) {
	const validation = validateBySchema(
		req,
		Joi.object({
			name: Joi.string().required(),
		})
	);
	if (validation) throw new ClientError(validation.message);

	const { name } = req;
	getCertTable();
	const certRecord = await certificateTable.get(name);
	if (!certRecord) throw new ClientError(name + ' not found');
	const { private_key_name } = certRecord;
	if (private_key_name) {
		const matchingKeys = Array.from(
			await certificateTable.search([{ attribute: 'private_key_name', value: private_key_name }])
		);

		if (matchingKeys.length === 1 && matchingKeys[0].name === name) {
			logger.info('Removing private key named', private_key_name);
			await fs.remove(path.join(envManager.getHdbBasePath(), hdbTerms.LICENSE_KEY_DIR_NAME, private_key_name));
		}
	}

	await certificateTable.delete(name);
	return 'Successfully removed ' + name;
}

function extractCommonName(certObj) {
	return certObj.subject.match(/CN=(.*)/)?.[1];
}
function hostnamesFromCert(cert /*X509Certificate*/) {
	return cert.subjectAltName
		? cert.subjectAltName
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
						} catch (e) {
							// ignore
						}
					}
					// can have name=value inside
					if (part.indexOf('=') > -1) return part.match(/CN=([^,]*)/)?.[1];
					return part;
				})
				.filter((part) => part) // filter out any empty names
		: // finally we fall back to the common name
			[extractCommonName(cert)];
}

async function getKey(req) {
	// This is here to block this function from being called by operations API. It can be called by replication or a resource
	if (req.bypass_auth !== true) throw new ClientError('Unauthorized', '401');
	const validation = validateBySchema(
		req,
		Joi.object({
			name: Joi.string().required(),
		})
	);
	if (validation) throw new ClientError(validation.message);

	const { name } = req;

	if (name === '.jwtPrivate') {
		const jwt = await getJWTRSAKeys();
		return jwt.privateKey;
	} else if (name === '.jwtPublic') {
		const jwt = await getJWTRSAKeys();
		return jwt.publicKey;
	} else if (privateKeys.get(name)) {
		return privateKeys.get(req.name);
	} else {
		throw new ClientError('Key not found');
	}
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
