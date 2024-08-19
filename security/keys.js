'use strict';

const path = require('path');
const fs = require('fs-extra');
const forge = require('node-forge');
const net = require('net');
let { generateKeyPair, X509Certificate, createPrivateKey } = require('crypto');
const util = require('util');
generateKeyPair = util.promisify(generateKeyPair);
const pki = forge.pki;
const Joi = require('joi');
const { v4: uuidv4 } = require('uuid');
const { validateBySchema } = require('../validation/validationWrapper');
const hdb_logger = require('../utility/logging/harper_logger');
const env_manager = require('../utility/environment/environmentManager');
const hdb_terms = require('../utility/hdbTerms');
const { CONFIG_PARAMS } = hdb_terms;
const certificates_terms = require('../utility/terms/certificates');
const { ClientError } = require('../utility/errors/hdbError');
const tls = require('node:tls');
const { relative, join } = require('node:path');
const { CERT_PREFERENCE_APP, CERTIFICATE_VALUES } = certificates_terms;
const assign_cmdenv_vars = require('../utility/assignCmdEnvVariables');
const config_utils = require('../config/configUtils');
const broken_alpn_callback = parseInt(process.version.slice(1)) < 20;
const { table, getDatabases, databases } = require('../resources/databases');

Object.assign(exports, {
	generateKeys,
	updateConfigCert,
	createCsr,
	signCertificate,
	setCertTable,
	loadCertificates,
	reviewSelfSignedCert,
	createTLSSelector,
	listCertificates,
	addCertificate,
	removeCertificate,
	createNatsCerts,
	generateCertsKeys,
	getReplicationCert,
	getReplicationCertAuth,
});

const {
	urlToNodeName,
	getThisNodeUrl,
	getThisNodeName,
	clearThisNodeName,
} = require('../server/replication/replicator');
const { readFileSync, watchFile, statSync } = require('node:fs');
const env = require('../utility/environment/environmentManager');
const { getTicketKeys, onMessageFromWorkers } = require('../server/threads/manageThreads');
const harper_logger = require('../utility/logging/harper_logger');
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
	if (message.type === hdb_terms.ITC_EVENT_TYPES.RESTART) {
		env_manager.initSync(true);
		// This will also call loadCertificates
		await reviewSelfSignedCert();
	}
});

let certificate_table;
function getCertTable() {
	if (!certificate_table) {
		certificate_table = getDatabases()['system']['hdb_certificate'];
		if (!certificate_table) {
			certificate_table = table({
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

	return certificate_table;
}

async function getReplicationCert() {
	const SNICallback = createTLSSelector('operations-api');
	const secure_target = {
		secureContexts: null,
		setSecureContext: (ctx) => {},
	};
	await SNICallback.initialize(secure_target);
	const cert = secure_target.secureContexts.get(getThisNodeName());
	if (!cert) return;
	const cert_parsed = new X509Certificate(cert.options.cert);
	cert.cert_parsed = cert_parsed;
	cert.issuer = cert_parsed.issuer;

	return cert;
}

async function getReplicationCertAuth() {
	getCertTable();
	const cert_pem = (await getReplicationCert()).options.cert;
	const rep_cert = new X509Certificate(cert_pem);
	const ca_name = rep_cert.issuer.match(/CN=(.*)/)?.[1];
	return certificate_table.get(ca_name);
}

let configured_certs_loaded;
const private_keys = new Map();

/**
 * This is responsible for loading any certificates that are in the harperdb-config.yaml file and putting them into the hdb_certificate table.
 * @return {*}
 */
function loadCertificates() {
	if (configured_certs_loaded) return;
	configured_certs_loaded = true;
	// these are the sections of the config to check
	const CERTIFICATE_CONFIGS = [{ configKey: CONFIG_PARAMS.TLS }, { configKey: CONFIG_PARAMS.OPERATIONSAPI_TLS }];

	getCertTable();

	const root_path = path.dirname(config_utils.getConfigFilePath());
	let promise;
	for (let { configKey: config_key } of CERTIFICATE_CONFIGS) {
		let configs = config_utils.getConfigFromFile(config_key);
		if (configs) {
			// the configs can be an array, so normalize to an array
			if (!Array.isArray(configs)) {
				configs = [configs];
			}
			for (let config of configs) {
				const private_key_path = config.privateKey;
				// need to relativize the paths so they aren't exposed
				let private_key_name = private_key_path && relative(join(root_path, 'keys'), private_key_path);
				if (private_key_name) {
					loadAndWatch(
						private_key_path,
						(private_key) => {
							private_keys.set(private_key_name, private_key);
						},
						'private key'
					);
				}
				for (let ca of [false, true]) {
					let path = config[ca ? 'certificateAuthority' : 'certificate'];
					if (path && isMainThread) {
						let last_modified;
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
								const certificate_pem = readPEM(path);
								const x509_cert = new X509Certificate(certificate_pem);
								let cert_cn;
								try {
									cert_cn = extractCommonName(x509_cert);
								} catch (err) {
									hdb_logger.error('error extracting common name from certificate', err);
									return;
								}

								if (cert_cn == null) {
									hdb_logger.error('error extracting common name from certificate');
									return;
								}

								// If a record already exists for cert check to see who is newer, cert record or cert file.
								// If cert file is newer, add it to table
								const cert_record = certificate_table.primaryStore.get(cert_cn);
								let file_timestamp = statSync(path).mtimeMs;
								let record_timestamp =
									!cert_record || cert_record.is_self_signed
										? 1
										: cert_record.file_timestamp ?? cert_record.__updatedtime__;
								if (cert_record && file_timestamp <= record_timestamp) {
									if (file_timestamp < record_timestamp)
										hdb_logger.info(
											`Certificate ${cert_cn} at ${path} is older (${new Date(
												file_timestamp
											)}) than the certificate in the database (${
												record_timestamp > 1 ? new Date(record_timestamp) : 'only self signed certificate available'
											})`
										);
									return;
								}

								promise = certificate_table.put({
									name: cert_cn,
									uses: ['https', ...(config_key.includes('operations') ? ['operations'] : [])],
									ciphers: config.ciphers,
									certificate: certificate_pem,
									private_key_name,
									is_authority: ca,
									hostnames,
									file_timestamp,
									details: {
										issuer: x509_cert.issuer.replace(/\n/g, ' '),
										subject: x509_cert.subject.replace(/\n/g, ' '),
										subject_alt_name: x509_cert.subjectAltName,
										serial_number: x509_cert.serialNumber,
										valid_from: x509_cert.validFrom,
										valid_to: x509_cert.validTo,
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
	let last_modified;
	const loadFile = (stats, reload) => {
		try {
			let modified = stats.mtimeMs;
			if (modified && modified !== last_modified) {
				if (reload && isMainThread) hdb_logger.warn(`Reloading ${type}:`, path);
				last_modified = modified;
				loadCert(readPEM(path));
			}
		} catch (error) {
			hdb_logger.error(`Error loading ${type}:`, path, error);
		}
	};
	if (fs.existsSync(path)) loadFile(statSync(path));
	else hdb_logger.error(`${type} file not found:`, path);
	watchFile(path, { persistent: false }, loadFile);
}

function getHost() {
	let url = getThisNodeUrl();
	if (url == null) {
		const host = CERT_DOMAINS[0];
		hdb_logger.info('replication url is missing from harperdb-config.yaml, using default host' + host);
		return host;
	}
	return urlToNodeName(url);
}

function getCommonName() {
	let node_name = getThisNodeName();
	if (node_name == null) {
		const host = CERT_DOMAINS[0];
		hdb_logger.info('replication url is missing from harperdb-config.yaml, using default host' + host);
		return host;
	}
	return node_name;
}

async function createCsr() {
	const rep = await getReplicationCert();
	const ops_cert = pki.certificateFromPem(rep.options.cert);
	const ops_private_key = pki.privateKeyFromPem(rep.options.key);

	hdb_logger.info('Creating CSR with cert named:', rep.name);

	const csr = pki.createCertificationRequest();
	csr.publicKey = ops_cert.publicKey;
	const subject = [
		{
			name: 'commonName',
			value: getCommonName(),
		},
		...CERT_ATTRIBUTES,
	];
	hdb_logger.info('Creating CSR with subject', subject);
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
	hdb_logger.info('Creating CSR with attributes', attributes);
	csr.setAttributes(attributes);

	csr.sign(ops_private_key);

	return forge.pki.certificationRequestToPem(csr);
}

function certExtensions() {
	const alt_name = CERT_DOMAINS.includes(getCommonName()) ? CERT_DOMAINS : [...CERT_DOMAINS, getCommonName()];
	if (!alt_name.includes(getHost())) alt_name.push(getHost());
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
			altNames: alt_name.map((domain) => {
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
	const hdb_keys_dir = path.join(env_manager.getHdbBasePath(), hdb_terms.LICENSE_KEY_DIR_NAME);

	if (req.csr) {
		let private_key;
		let cert_auth;
		getCertTable();

		// Search hdb_certificate for a non-HDB CA that also has a local private key
		for await (const cert of certificate_table.search([])) {
			if (cert.is_authority && !cert.details.issuer.includes('HarperDB-Certificate-Authority')) {
				if (private_keys.has(cert.private_key_name)) {
					private_key = private_keys.get(cert.private_key_name);
					cert_auth = cert;
					break;
				} else if (cert.private_key_name && (await fs.exists(path.join(hdb_keys_dir, cert.private_key_name)))) {
					private_key = fs.readFile(path.join(hdb_keys_dir, cert.private_key_name));
					cert_auth = cert;
					break;
				}
			}
		}

		// If the search above did not find a CA use the HDB self singed one that was created by this instance
		if (!private_key) {
			cert_auth = await getHDBCertAuthority();
			private_key = await fs.readFile(path.join(hdb_keys_dir, certificates_terms.PRIVATEKEY_PEM_NAME));
		}

		private_key = pki.privateKeyFromPem(private_key);
		response.signingCA = cert_auth.certificate;
		const ca_app_cert = pki.certificateFromPem(cert_auth.certificate);
		hdb_logger.info('Signing CSR with cert named', cert_auth.name);
		const csr = pki.certificationRequestFromPem(req.csr);
		try {
			csr.verify();
		} catch (err) {
			hdb_logger.error(err);
			return new Error(`Error verifying CSR: ` + err.message);
		}

		const cert = forge.pki.createCertificate();
		cert.serialNumber = Math.random().toString().slice(2, 10);
		cert.validity.notBefore = new Date();
		const not_after = new Date();
		cert.validity.notAfter = not_after;
		cert.validity.notAfter.setDate(not_after.getDate() + CERT_VALIDITY_DAYS);
		hdb_logger.info('sign cert setting validity:', cert.validity);

		// subject from CSR
		hdb_logger.info('sign cert setting subject from CSR:', csr.subject.attributes);
		cert.setSubject(csr.subject.attributes);

		// issuer from CA
		hdb_logger.info('sign cert setting issuer:', ca_app_cert.subject.attributes);
		cert.setIssuer(ca_app_cert.subject.attributes);

		const extensions = csr.getAttribute({ name: 'extensionRequest' }).extensions;
		hdb_logger.info('sign cert adding extensions from CSR:', extensions);
		cert.setExtensions(extensions);

		cert.publicKey = csr.publicKey;
		cert.sign(private_key, forge.md.sha256.create());

		response.certificate = pki.certificateToPem(cert);
	} else {
		hdb_logger.info('Sign cert did not receive a CSR from:', req.url, 'only the CA will be returned');
	}

	return response;
}

async function createCertificateTable(cert, ca_cert) {
	await setCertTable({
		name: getThisNodeName(),
		uses: ['https', 'wss'],
		certificate: cert,
		private_key_name: 'privateKey.pem',
		is_authority: false,
		is_self_signed: true,
	});

	await setCertTable({
		name: ca_cert.subject.getField('CN').value,
		uses: ['https', 'wss'],
		certificate: pki.certificateToPem(ca_cert),
		private_key_name: 'privateKey.pem',
		is_authority: true,
		is_self_signed: true,
	});
}

async function setCertTable(cert_record) {
	const cert = new X509Certificate(cert_record.certificate);
	cert_record.details = {
		issuer: cert.issuer.replace(/\n/g, ' '),
		subject: cert.subject.replace(/\n/g, ' '),
		subject_alt_name: cert.subjectAltName,
		serial_number: cert.serialNumber,
		valid_from: cert.validFrom,
		valid_to: cert.validTo,
	};

	getCertTable();
	await certificate_table.patch(cert_record);
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
		public_key: pki.publicKeyFromPem(keys.publicKey),
		private_key: pki.privateKeyFromPem(keys.privateKey),
	};
}

//https://www.openssl.org/docs/manmaster/man5/x509v3_config.html

async function generateCertificates(ca_private_key, public_key, ca_cert) {
	const public_cert = pki.createCertificate();

	if (!public_key) {
		const rep_cert = await getReplicationCert();
		const ops_cert = pki.certificateFromPem(rep_cert.options.cert);
		public_key = ops_cert.publicKey;
	}

	public_cert.publicKey = public_key;
	public_cert.serialNumber = Math.random().toString().slice(2, 10);
	public_cert.validity.notBefore = new Date();
	const not_after = new Date();
	public_cert.validity.notAfter = not_after;
	public_cert.validity.notAfter.setDate(not_after.getDate() + CERT_VALIDITY_DAYS);

	const subject = [
		{
			name: 'commonName',
			value: getCommonName(),
		},
		...CERT_ATTRIBUTES,
	];

	public_cert.setSubject(subject);
	public_cert.setIssuer(ca_cert.subject.attributes);
	public_cert.setExtensions(certExtensions());
	public_cert.sign(ca_private_key, forge.md.sha256.create());

	return pki.certificateToPem(public_cert);
}

async function getHDBCertAuthority() {
	const records = certificate_table.search({
		conditions: [
			{ attribute: 'is_self_signed', comparator: 'equals', value: true },
			{ attribute: 'is_authority', comparator: 'equals', value: true },
		],
	});

	let result = [];
	for await (let record of records) {
		result.push(record);
	}

	// There should only ever be one HDB CA created by this node
	return result[0];
}

async function generateCertAuthority() {
	const { private_key, public_key } = await generateKeys();
	const ca_cert = pki.createCertificate();

	ca_cert.publicKey = public_key;
	ca_cert.serialNumber = Math.random().toString().slice(2, 10);
	ca_cert.validity.notBefore = new Date();
	const not_after = new Date();
	ca_cert.validity.notAfter = not_after;
	ca_cert.validity.notAfter.setDate(not_after.getDate() + CERT_VALIDITY_DAYS);

	const subject = [
		{
			name: 'commonName',
			value: `HarperDB-Certificate-Authority-${
				env_manager.get(CONFIG_PARAMS.REPLICATION_HOSTNAME) ??
				urlToNodeName(env_manager.get(CONFIG_PARAMS.REPLICATION_URL)) ??
				uuidv4().split('-')[0]
			}`,
		},
		...CERT_ATTRIBUTES,
	];
	ca_cert.setSubject(subject);
	ca_cert.setIssuer(subject);
	ca_cert.setExtensions([
		{ name: 'basicConstraints', cA: true, critical: true },
		{ name: 'keyUsage', keyCertSign: true, critical: true },
	]);

	ca_cert.sign(private_key, forge.md.sha256.create());

	const keys_path = path.join(env_manager.getHdbBasePath(), hdb_terms.LICENSE_KEY_DIR_NAME);
	const private_path = path.join(keys_path, certificates_terms.PRIVATEKEY_PEM_NAME);
	await fs.writeFile(private_path, pki.privateKeyToPem(private_key));

	return { private_key, public_key, ca_cert };
}

async function generateCertsKeys() {
	const { private_key, public_key, ca_cert } = await generateCertAuthority();
	const public_cert = await generateCertificates(private_key, public_key, ca_cert);
	await createCertificateTable(public_cert, ca_cert);
	updateConfigCert();
}

async function createNatsCerts() {
	const public_cert = await generateCertificates(
		pki.privateKeyFromPem(certificates_terms.CERTIFICATE_VALUES.key),
		undefined,
		pki.certificateFromPem(certificates_terms.CERTIFICATE_VALUES.cert)
	);

	const keys_path = path.join(env_manager.getHdbBasePath(), hdb_terms.LICENSE_KEY_DIR_NAME);

	const pub_cert_path = path.join(keys_path, certificates_terms.NATS_CERTIFICATE_PEM_NAME);
	if (!(await fs.exists(pub_cert_path))) await fs.writeFile(pub_cert_path, public_cert);

	const ca_cert_path = path.join(keys_path, certificates_terms.NATS_CA_PEM_NAME);
	if (!(await fs.exists(ca_cert_path))) await fs.writeFile(ca_cert_path, certificates_terms.CERTIFICATE_VALUES.cert);
}

async function reviewSelfSignedCert() {
	// Clear any cached node name var
	clearThisNodeName();
	loadCertificates();
	getCertTable();
	const existing_cert = await getReplicationCert();
	if (!existing_cert) {
		const cert_name = getThisNodeName();
		hdb_logger.info(
			`A suitable replication certificate was not found, creating new HarperDB self singed cert named: ${cert_name}`
		);
		const hdb_ca = pki.certificateFromPem((await getHDBCertAuthority()).certificate);
		const public_key = hdb_ca.publicKey;
		const private_key = await fs.readFile(
			path.join(env_manager.getHdbBasePath(), hdb_terms.LICENSE_KEY_DIR_NAME, certificates_terms.PRIVATEKEY_PEM_NAME)
		);
		const new_public_cert = await generateCertificates(pki.privateKeyFromPem(private_key), public_key, hdb_ca);
		await setCertTable({
			name: cert_name,
			uses: ['https', 'operations', 'wss'],
			certificate: new_public_cert,
			is_authority: false,
			private_key_name: certificates_terms.PRIVATEKEY_PEM_NAME,
		});
	}
}

// Update the cert config in harperdb-config.yaml
// If CLI or Env values are present it will use those values, else it will use default private key.
function updateConfigCert() {
	const cli_env_args = assign_cmdenv_vars(Object.keys(hdb_terms.CONFIG_PARAM_MAP), true);
	const keys_path = path.join(env_manager.getHdbBasePath(), hdb_terms.LICENSE_KEY_DIR_NAME);
	const private_key = path.join(keys_path, certificates_terms.PRIVATEKEY_PEM_NAME);
	const nats_pub_cert = path.join(keys_path, certificates_terms.NATS_CERTIFICATE_PEM_NAME);
	const nats_ca = path.join(keys_path, certificates_terms.NATS_CA_PEM_NAME);

	// This object is what will be added to the harperdb-config.yaml file.
	// We check for any CLI of Env args and if they are present we use them instead of default values.
	const conf = hdb_terms.CONFIG_PARAMS;
	const new_certs = {
		[conf.TLS_PRIVATEKEY]: cli_env_args[conf.TLS_PRIVATEKEY.toLowerCase()]
			? cli_env_args[conf.TLS_PRIVATEKEY.toLowerCase()]
			: private_key,
	};

	if (cli_env_args[conf.TLS_CERTIFICATE.toLowerCase()]) {
		new_certs[conf.TLS_CERTIFICATE] = cli_env_args[conf.TLS_CERTIFICATE.toLowerCase()];
	}

	if (cli_env_args[conf.TLS_CERTIFICATEAUTHORITY.toLowerCase()]) {
		new_certs[conf.TLS_CERTIFICATEAUTHORITY] = cli_env_args[conf.TLS_CERTIFICATEAUTHORITY.toLowerCase()];
	}

	if (cli_env_args[conf.OPERATIONSAPI_TLS_CERTIFICATE.toLowerCase()]) {
		new_certs[conf.OPERATIONSAPI_TLS_CERTIFICATE] = cli_env_args[conf.OPERATIONSAPI_TLS_CERTIFICATE.toLowerCase()];
	}
	if (cli_env_args[conf.OPERATIONSAPI_TLS_PRIVATEKEY.toLowerCase()]) {
		new_certs[conf.OPERATIONSAPI_TLS_PRIVATEKEY] = cli_env_args[conf.OPERATIONSAPI_TLS_PRIVATEKEY.toLowerCase()];
	}
	if (cli_env_args[conf.OPERATIONSAPI_TLS_CERTIFICATEAUTHORITY.toLowerCase()]) {
		new_certs[conf.OPERATIONSAPI_TLS_CERTIFICATEAUTHORITY] =
			cli_env_args[conf.OPERATIONSAPI_TLS_CERTIFICATEAUTHORITY.toLowerCase()];
	}

	// Add paths for Nats TLS certs if clustering enabled
	if (cli_env_args[conf.CLUSTERING_ENABLED.toLowerCase()] || cli_env_args['clustering']) {
		new_certs[conf.CLUSTERING_TLS_CERTIFICATE] =
			cli_env_args[conf.CLUSTERING_TLS_CERTIFICATE.toLowerCase()] ?? nats_pub_cert;
		new_certs[conf.CLUSTERING_TLS_CERT_AUTH] = cli_env_args[conf.CLUSTERING_TLS_CERT_AUTH.toLowerCase()] ?? nats_ca;
		new_certs[conf.CLUSTERING_TLS_PRIVATEKEY] =
			cli_env_args[conf.CLUSTERING_TLS_PRIVATEKEY.toLowerCase()] ?? private_key;
	}

	config_utils.updateConfigValue(undefined, undefined, new_certs, false, true);
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
const origTLSServer = tls.Server;
// In node v18 (only in 18.20 and up) the node https module will set the ALPN protocols leading to an error, so we
// have to null out of the protocols if there is a callback
tls.Server = function (options, secureConnectionListener) {
	if (options.ALPNCallback) {
		options.ALPNProtocols = null;
	}
	return origTLSServer.call(this, options, secureConnectionListener);
};
// restore the original prototype, as it is used internally by Node.js
tls.Server.prototype = origTLSServer.prototype;
// Node.js SNI callbacks _add_ the certificate and don't replace it, and so we can't have a default certificate,
// so we have to assign the default certificate during the cert callback, because the default SNI callback isn't
// consistently called for all TLS connections (isn't called if no SNI server name is provided).
// first we have interrupt the socket initialization to add our own cert callback
const originalInit = TLSSocket.prototype._init;
TLSSocket.prototype._init = function (socket, wrap) {
	originalInit.call(this, socket, wrap);
	let tls_socket = this;
	this._handle.oncertcb = function (info) {
		const servername = info.servername;
		tls_socket._SNICallback(servername, (err, context) => {
			this.sni_context = context.context || context;
			// note that this skips the checks for multiple callbacks and entirely skips OCSP, so if we ever need that, we
			// need to call the original oncertcb
			this.certCbDone();
		});
	};
};

let ca_certs = new Map();

/**
 * Create a TLS selector that will choose the best TLS configuration/context for a given hostname
 * @param type
 * @param mtls_options
 * @return {(function(*, *): (*|undefined))|*}
 */
function createTLSSelector(type, mtls_options) {
	let secure_contexts = new Map();
	let default_context;
	let has_wildcards = false;
	SNICallback.initialize = (server) => {
		if (SNICallback.ready) return SNICallback.ready;
		if (server) {
			server.secureContexts = secure_contexts;
			server.secureContextsListeners = [];
		}
		return (SNICallback.ready = new Promise((resolve, reject) => {
			async function updateTLS() {
				try {
					secure_contexts.clear();
					ca_certs.clear();
					let best_quality = 0;
					for await (const cert of databases.system.hdb_certificate.search([])) {
						if (type !== 'operations-api' && cert.uses?.includes?.('operations')) continue;
						const certificate = cert.certificate;
						const cert_parsed = new X509Certificate(certificate);
						if (cert.is_authority) {
							cert_parsed.asString = certificate;
							ca_certs.set(cert_parsed.subject, certificate);
						}
					}

					for await (const cert of databases.system.hdb_certificate.search([])) {
						try {
							if (cert.is_authority) {
								continue;
							}
							let is_operations = type === 'operations-api';
							if (!is_operations && cert.uses?.includes?.('operations')) continue;

							let quality = cert.is_self_signed ? 1 : 2;

							let private_key = private_keys.get(cert.private_key_name);
							if (!private_key && cert.private_key_name) {
								private_key = await fs.readFile(
									path.join(
										env_manager.get(CONFIG_PARAMS.ROOTPATH),
										hdb_terms.LICENSE_KEY_DIR_NAME,
										cert.private_key_name
									)
								);
							}

							let certificate = cert.certificate;
							const cert_parsed = new X509Certificate(certificate);
							if (ca_certs.has(cert_parsed.issuer)) {
								certificate += '\n' + ca_certs.get(cert_parsed.issuer);
							}
							if (!private_key || !certificate) {
								throw new Error('Missing private key or certificate for secure server');
							}
							const secure_options = {
								ciphers: cert.ciphers,
								ticketKeys: getTicketKeys(),
								ca: mtls_options && Array.from(ca_certs.values()),
								cert: certificate,
								key: private_key,
								key_file: cert.private_key_name,
								is_self_signed: cert.is_self_signed,
							};
							if (server) secure_options.sessionIdContext = server.sessionIdContext;
							let secure_context = tls.createSecureContext(secure_options);
							secure_context.name = cert.name;
							secure_context.options = secure_options;
							secure_context.quality = quality;
							secure_context.certificateAuthorities = Array.from(ca_certs);
							// we store the first 100 bytes of the certificate just for debug logging
							secure_context.certStart = certificate.toString().slice(0, 100);
							// we want to configure SNI handling to pick the right certificate based on all the registered SANs
							// in the certificate
							let hostnames =
								cert.hostnames ??
								(cert_parsed.subjectAltName
									? cert_parsed.subjectAltName.split(',').map((part) => {
											// the subject alt names looks like 'IP Address:127.0.0.1, DNS:localhost, IP Address:0:0:0:0:0:0:0:1'
											// so we split on commas and then use the part after the colon as the host name
											let colon_index = part.indexOf(':');
											return part.slice(colon_index + 1);
									  })
									: // finally we fall back to the common name
									  [extractCommonName(cert_parsed)]);
							if (!Array.isArray(hostnames)) hostnames = [hostnames];
							let has_ip_address;
							for (let hostname of hostnames) {
								if (hostname) {
									if (hostname[0] === '*') {
										has_wildcards = true;
										hostname = hostname.slice(1);
									}
									if (net.isIP(hostname)) has_ip_address = true;
									// we use this certificate if it has a higher quality than the existing one for this hostname
									let existing_cert_quality = secure_contexts.get(hostname)?.quality ?? 0;
									if (quality > existing_cert_quality) {
										secure_contexts.set(hostname, secure_context);
									}
								} else {
									harper_logger.error('No hostname found for certificate at', tls.certificate);
								}
							}
							if (quality > best_quality /* && has_ip_address*/) {
								// we use this certificate as the default if it has a higher quality than the existing one
								SNICallback.defaultContext = default_context = secure_context;
								best_quality = quality;
								if (server) {
									server.defaultContext = secure_context;
									// note that we can not set the secure context on the server here, because this creates an
									// indeterminate situation of whether openssl will use this certificate or the one from the SNI
									// callback
									//server.setSecureContext?.(server, secure_options);
									harper_logger.trace(
										'Applying default TLS',
										secure_context.name,
										'for',
										server.ports,
										'cert named',
										cert.name
									);
								}
							}
						} catch (error) {
							harper_logger.error('Error applying TLS for', cert.name, error);
						}
					}
					server?.secureContextsListeners.forEach((listener) => listener());
					resolve(default_context);
				} catch (error) {
					reject(error);
				}
			}
			databases.system.hdb_certificate.subscribe({
				listener: updateTLS,
				omitCurrent: true,
			});
			updateTLS();
		}));
	};
	return SNICallback;
	function SNICallback(servername, cb) {
		// find the matching server name, substituting wildcards for each part of the domain to find matches
		harper_logger.info('TLS requested for', servername, this.isReplicationConnection);
		let matching_name = servername;
		while (true) {
			let context = secure_contexts.get(matching_name);
			if (context) {
				harper_logger.debug('Found certificate for', servername, context.certStart);
				// check if this is a replication connection, based on ALPN, and if so, use the replication context
				// if ALPN callbacks are broken (node 18), we need to always use the replication context if it exists
				if (context.replicationContext && (this.isReplicationConnection || broken_alpn_callback))
					context = context.replicationContext;
				return cb(null, context);
			}
			if (has_wildcards && matching_name) {
				let next_dot = matching_name.indexOf('.', 1);
				if (next_dot < 0) matching_name = '';
				else matching_name = matching_name.slice(next_dot);
			} else break;
		}
		harper_logger.debug('No certificate found to match', servername, 'using the first certificate');
		// no matches, return the first/default one
		cb(null, default_context);
	}
}
function reverseSubscription(subscription) {
	const { subscribe, publish } = subscription;
	return { ...subscription, subscribe: publish, publish: subscribe };
}

/**
 * List all the records in hdb_certificate table
 * @returns {Promise<*[]>}
 */
async function listCertificates() {
	getCertTable();
	let response = [];
	for await (const cert of certificate_table.search([])) {
		response.push(cert);
	}
	return response;
}

/**
 * Adds a certificate to hdb_certificate table. If a private key is provided it will write it to file
 * Can be used to add a new one or update existing
 * @param req.name - primary key of hdb_certificate
 * @param req.certificate - cert that will be added, as a string
 * @param req.private_key - optional, private key as a string. Will be written to file and not to hdb_certificate
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
	const x509_cert = new X509Certificate(certificate);
	let private_key_exists = false;
	let private_key_match = false;
	let existing_private_key_name;
	for (const [key_name, key] of private_keys) {
		// If a private key is not provided we search all existing private keys to see if there is one that was used to sign the cert.
		if (!private_key && !private_key_exists) {
			const check = x509_cert.checkPrivateKey(createPrivateKey(key));
			if (check) {
				private_key_exists = true;
				existing_private_key_name = key_name;
			}
		}

		// If a private key was provided we check to see if it already exists, so that we don't store the same key twice.
		if (private_key && private_key === key) {
			private_key_match = true;
			existing_private_key_name = key_name;
		}
	}

	if (!is_authority && !private_key && !private_key_exists)
		throw new ClientError('A suitable private key was not found for this certificate');

	let cert_cn;
	if (!name) {
		try {
			cert_cn = extractCommonName(x509_cert);
		} catch (err) {
			hdb_logger.error(err);
		}

		if (cert_cn == null) {
			throw new ClientError('Error extracting certificate common name, please provide a name parameter');
		}
	}

	const sani_name = sanitizeName(name ?? cert_cn);
	if (private_key && !private_key_exists && !private_key_match) {
		await fs.writeFile(
			path.join(env_manager.getHdbBasePath(), hdb_terms.LICENSE_KEY_DIR_NAME, sani_name + '.pem'),
			private_key
		);
		private_keys.set(sani_name, private_key);
	}

	const record = {
		name: name ?? cert_cn,
		certificate,
		is_authority,
		hosts: req.hosts,
		uses: req.uses,
	};

	if (!is_authority || (is_authority && existing_private_key_name) || (is_authority && private_key)) {
		record.private_key_name = existing_private_key_name ?? sani_name + '.pem';
	}

	await setCertTable(record);

	return 'Successfully added certificate: ' + sani_name;
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
 * Removes certificate from hdb_certificate and corresponding private key file
 * @param req.name - Name of the cert as it is in hdb_certificate
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
	const cert_record = await certificate_table.get(name);
	if (!cert_record) throw new ClientError(name + ' not found');
	const { private_key_name } = cert_record;
	if (private_key_name) {
		const matching_keys = Array.from(
			await certificate_table.search([{ attribute: 'private_key_name', value: private_key_name }])
		);

		if (matching_keys.length === 1 && matching_keys[0].name === name) {
			hdb_logger.info('Removing private key named', private_key_name);
			await fs.remove(path.join(env_manager.getHdbBasePath(), hdb_terms.LICENSE_KEY_DIR_NAME, private_key_name));
		}
	}

	await certificate_table.delete(name);
	return 'Successfully removed ' + name;
}

function extractCommonName(cert_obj) {
	return cert_obj.subject.match(/CN=(.*)/)?.[1];
}
