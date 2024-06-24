'use strict';

const path = require('path');
const fs = require('fs-extra');
const forge = require('node-forge');
const net = require('net');
let { generateKeyPair, X509Certificate } = require('crypto');
const util = require('util');
generateKeyPair = util.promisify(generateKeyPair);
const pki = forge.pki;
const hdb_logger = require('../utility/logging/harper_logger');
const env_manager = require('../utility/environment/environmentManager');
const hdb_terms = require('../utility/hdbTerms');
const { CONFIG_PARAMS } = hdb_terms;
const certificates_terms = require('../utility/terms/certificates');
const tls = require('node:tls');
const { basename } = require('node:path');
const {
	CA_CERT_PREFERENCE_APP,
	CA_CERT_PREFERENCE_OPS,
	CERT_PREFERENCE_APP,
	CERT_PREFERENCE_OPS,
	CERT_PREFERENCE_REP,
	CERT_CONFIG_NAME_MAP,
	CERT_NAME,
	CERTIFICATE_VALUES,
	CA_CERT_PREFERENCE_REP,
} = certificates_terms;
const assign_cmdenv_vars = require('../utility/assignCmdEnvVariables');
const config_utils = require('../config/configUtils');
const broken_alpn_callback = parseInt(process.version.slice(1)) < 20;
const { table, getDatabases, databases } = require('../resources/databases');

Object.assign(exports, {
	generateKeys,
	updateConfigCert,
	createCsr,
	signCertificate,
	getCertsKeys,
	setCertTable,
	loadCertificates,
	setDefaultCertsKeys,
	createTLSSelector,
	verifyCert,
	listCertificates,
	addCertificate,
	removeCertificate,
	writeDefaultCertsToFile,
});

const { urlToNodeName, getThisNodeUrl, getThisNodeName } = require('../server/replication/replicator');
const { ensureNode } = require('../server/replication/subscriptionManager');
const { readFileSync, watchFile, statSync } = require('node:fs');
const env = require('../utility/environment/environmentManager');
const { getTicketKeys } = require('../server/threads/manageThreads');
const harper_logger = require('../utility/logging/harper_logger');
const terms = require('../utility/hdbTerms');
const { isMainThread } = require('worker_threads');

const CERT_VALIDITY_DAYS = 3650;
const CERT_DOMAINS = ['127.0.0.1', 'localhost', '::1'];
const CERT_ATTRIBUTES = [
	{ name: 'countryName', value: 'USA' },
	{ name: 'stateOrProvinceName', value: 'Colorado' },
	{ name: 'localityName', value: 'Denver' },
	{ name: 'organizationName', value: 'HarperDB, Inc.' },
];

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
						attribute: 'details',
					},
				],
			});
		}
	}

	return certificate_table;
}

async function getCertsKeys(rep_host = undefined) {
	await loadCertificates();
	const app_private_pem = (await fs.exists(env_manager.get(hdb_terms.CONFIG_PARAMS.TLS_PRIVATEKEY)))
		? await fs.readFile(env_manager.get(hdb_terms.CONFIG_PARAMS.TLS_PRIVATEKEY), 'utf8')
		: undefined;
	const ops_private_pem = (await fs.exists(env_manager.get(hdb_terms.CONFIG_PARAMS.OPERATIONSAPI_TLS_PRIVATEKEY)))
		? await fs.readFile(env_manager.get(hdb_terms.CONFIG_PARAMS.OPERATIONSAPI_TLS_PRIVATEKEY), 'utf8')
		: app_private_pem;

	let app_cert_quality = 0,
		ops_cert_quality = 0,
		rep_cert_quality = 0,
		ca_rep_cert_quality = 0,
		ca_app_cert_quality = 0,
		ca_ops_cert_quality = 0,
		response = {
			app_private_key: app_private_pem,
			ops_private_key: ops_private_pem,
			app: {
				name: undefined,
				cert: undefined,
			},
			app_ca: {
				name: undefined,
				cert: undefined,
			},
			ops: {
				name: undefined,
				cert: undefined,
			},
			ops_ca: {
				name: undefined,
				cert: undefined,
			},
			rep: {
				name: undefined,
				cert: undefined,
			},
			rep_ca: {
				name: undefined,
				cert: undefined,
			},
		};

	getCertTable();
	for await (const cert of certificate_table.search([])) {
		const { name, certificate } = cert;
		if (CERT_PREFERENCE_APP[name] && app_cert_quality < CERT_PREFERENCE_APP[name]) {
			response.app.cert = certificate;
			response.app.name = name;
			app_cert_quality = CERT_PREFERENCE_APP[name];
		}

		if (CA_CERT_PREFERENCE_APP[name] && ca_app_cert_quality < CA_CERT_PREFERENCE_APP[name]) {
			response.app_ca.cert = certificate;
			response.app_ca.name = name;
			ca_app_cert_quality = CA_CERT_PREFERENCE_APP[name];
		}

		if (CERT_PREFERENCE_OPS[name] && ops_cert_quality < CERT_PREFERENCE_OPS[name]) {
			response.ops.cert = certificate;
			response.ops.name = name;
			ops_cert_quality = CERT_PREFERENCE_OPS[name];
		}

		if (CA_CERT_PREFERENCE_OPS[name] && ca_ops_cert_quality < CA_CERT_PREFERENCE_OPS[name]) {
			response.ops_ca.cert = certificate;
			response.ops_ca.name = name;
			ca_ops_cert_quality = CA_CERT_PREFERENCE_OPS[name];
		}

		if (name === rep_host) {
			response.rep.cert = certificate;
			response.rep.name = name;
			rep_cert_quality = 100;
		}

		if (CERT_PREFERENCE_REP[name] && rep_cert_quality < CERT_PREFERENCE_REP[name]) {
			response.rep.cert = certificate;
			response.rep.name = name;
			rep_cert_quality = CERT_PREFERENCE_REP[name];
		}

		if (CA_CERT_PREFERENCE_REP[name] && ca_rep_cert_quality < CA_CERT_PREFERENCE_REP[name]) {
			response.rep_ca.cert = certificate;
			response.rep_ca.name = name;
			ca_rep_cert_quality = CA_CERT_PREFERENCE_REP[name];
		}

		if (name?.includes?.('issued by')) {
			response[name] = certificate;
			if (name.includes('ca')) {
				response.rep_ca.cert = certificate;
				response.rep_ca.name = name;
				ca_rep_cert_quality = 50;
			} else {
				response.rep.cert = certificate;
				response.rep.name = name;
				rep_cert_quality = 50;
			}
		}
	}

	return response;
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

	const root_path = env.get(terms.CONFIG_PARAMS.ROOTPATH); // need to relativize the paths so they aren't exposed
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
				let private_key_name = private_key_path && basename(private_key_path);
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
								promise = certificate_table.put({
									name: CERT_CONFIG_NAME_MAP[config_key + (ca ? '_certificateAuthority' : '_certificate')],
									uses: ['https', ...(config_key.includes('operations') ? ['operations'] : [])],
									ciphers: config.ciphers,
									certificate: certificate_pem,
									private_key_name,
									is_authority: ca,
									hostnames,
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
			hdb_logger.error(`Error loading ${type}:`, path);
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
	let { ops_private_key, ops } = await getCertsKeys();
	const ops_cert = pki.certificateFromPem(ops.cert);
	ops_private_key = pki.privateKeyFromPem(ops_private_key);

	hdb_logger.info('Creating CSR with cert named:', ops.name);

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
	let { app_private_key, app_ca } = await getCertsKeys();
	let response = {
		ca_certificate: app_ca.cert,
	};

	if (req.csr) {
		app_private_key = pki.privateKeyFromPem(app_private_key);
		const ca_app_cert = pki.certificateFromPem(app_ca.cert);

		hdb_logger.info('Signing CSR with cert named', app_ca.name, 'with cert', app_ca.cert);
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
		cert.sign(app_private_key, forge.md.sha256.create());

		response.certificate = pki.certificateToPem(cert);
	} else {
		hdb_logger.info('Sign cert did not receive a CSR from:', req.url, 'only the CA will be returned');
	}

	return response;
}

async function createCertificateTable(cert, ca_cert) {
	await setCertTable({
		name: certificates_terms.CERT_NAME.DEFAULT,
		uses: ['https', 'operations', 'wss'],
		certificate: cert,
		private_key_name: 'privateKey.pem',
		is_authority: false,
	});

	await setCertTable({
		name: certificates_terms.CERT_NAME['DEFAULT-CA'],
		uses: ['https', 'operations', 'wss'],
		certificate: ca_cert,
		private_key_name: 'privateKey.pem',
		is_authority: true,
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

function verifyCert(cert, ca) {
	try {
		const ca_store = pki.createCaStore([ca]);
		return pki.verifyCertificateChain(ca_store, [cert]);
	} catch (err) {
		hdb_logger.info('verifying cert:', err);
		return false;
	}
}

// let crt = fs.readFileSync('/Users/davidcockerill/hdb/keys/certificate.pem');
// let crt_ca = fs.readFileSync('/Users/davidcockerill/hdb/keys/caCertificate.pem');
// let p_key = fs.readFileSync('/Users/davidcockerill/hdb2/keys/privateKey.pem');
// // crt = pki.certificateFromPem(crt);
// // crt_ca = pki.certificateFromPem(crt_ca);
//
// const x509 = new X509Certificate(crt);
// const pk = createPrivateKey(p_key);
// const value = x509.checkPrivateKey(pk);
// console.log(value);
//
// const v = crt.check;
// console.log(verifyCert(crt, crt_ca));
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

async function generateCertificates(private_key, public_key, ca_cert) {
	const public_cert = pki.createCertificate();

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
	public_cert.sign(private_key, forge.md.sha256.create());

	return pki.certificateToPem(public_cert);
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
			value: 'HarperDB Certificate Authority for ' + getCommonName(),
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
	await createCertificateTable(public_cert, pki.certificateToPem(ca_cert));
	updateConfigCert();
}

async function writeDefaultCertsToFile() {
	getCertTable();
	const keys_path = path.join(env_manager.getHdbBasePath(), hdb_terms.LICENSE_KEY_DIR_NAME);

	const pub_cert = await certificate_table.get(certificates_terms.CERT_NAME.DEFAULT);
	const pub_cert_path = path.join(keys_path, certificates_terms.CERTIFICATE_PEM_NAME);
	if (!(await fs.exists(pub_cert_path))) await fs.writeFile(pub_cert_path, pub_cert.certificate);

	const ca_cert = await certificate_table.get(certificates_terms.CERT_NAME['DEFAULT-CA']);
	const ca_cert_path = path.join(keys_path, certificates_terms.CA_PEM_NAME);
	if (!(await fs.exists(ca_cert_path))) await fs.writeFile(ca_cert_path, ca_cert.certificate);
}

/**
 * Function does two things:
 * If there is no app cert, it will create all the default HarperDB certs and private key (which become default certs).
 * If the default cert common name and altnames array doesn't contain the hostname from replication.url config it
 * will create a new cert with this hostname value.
 * @returns {Promise<void>}
 */
async function setDefaultCertsKeys() {
	getCertTable();
	const { app, app_private_key, app_ca } = await getCertsKeys();
	if (!app.name) {
		await generateCertsKeys();
	}

	// This block of code is here to check the common name and altnames on the default app cert.
	// If the cert does not have this nodes hostname it will create a new public cert with the hostname.
	if (app.name === CERT_NAME.DEFAULT && env_manager.get(CONFIG_PARAMS.REPLICATION_URL)) {
		const host = getCommonName();
		const cert_obj = new X509Certificate(app.cert);
		if (!cert_obj.subjectAltName.includes(host) || !cert_obj.subject.includes(host)) {
			hdb_logger.info('Creating a new HarperDB generated public with host:', host);
			const pc = pki.certificateFromPem(app.cert);
			const public_cert = await generateCertificates(
				pki.privateKeyFromPem(app_private_key),
				pc.publicKey,
				pki.certificateFromPem(app_ca.cert)
			);

			await setCertTable({
				name: certificates_terms.CERT_NAME.DEFAULT,
				uses: ['https', 'operations', 'wss'],
				certificate: public_cert,
				is_authority: false,
			});
		}
	}
}

// Update the cert config in harperdb-config.yaml
// If CLI or Env values are present it will use those values, else it will use default private key.
function updateConfigCert() {
	const cli_env_args = assign_cmdenv_vars(Object.keys(hdb_terms.CONFIG_PARAM_MAP), true);
	const keys_path = path.join(env_manager.getHdbBasePath(), hdb_terms.LICENSE_KEY_DIR_NAME);
	const private_key = path.join(keys_path, certificates_terms.PRIVATEKEY_PEM_NAME);
	const pub_cert = path.join(keys_path, certificates_terms.CERTIFICATE_PEM_NAME);
	const ca = path.join(keys_path, certificates_terms.CA_PEM_NAME);

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
			cli_env_args[conf.CLUSTERING_TLS_CERTIFICATE.toLowerCase()] ?? pub_cert;
		new_certs[conf.CLUSTERING_TLS_CERT_AUTH] = cli_env_args[conf.CLUSTERING_TLS_CERT_AUTH.toLowerCase()] ?? ca;
		new_certs[conf.CLUSTERING_TLS_PRIVATEKEY] =
			cli_env_args[conf.CLUSTERING_TLS_PRIVATEKEY.toLowerCase()] ?? private_key;
	}

	config_utils.updateConfigValue(undefined, undefined, new_certs, false, true);
}

function readPEM(path) {
	if (path.startsWith('-----BEGIN')) return path;
	return readFileSync(path, 'utf8');
}
// this horifying hack is brought to you by https://github.com/nodejs/node/issues/36655
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

let ca_certs = new Map();
function createTLSSelector(type, options) {
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
						if (type !== 'operations-api' && cert.name.includes('operations')) continue;
						const certificate = cert.certificate;
						const cert_parsed = new X509Certificate(certificate);
						if (cert.is_authority) {
							cert_parsed.asString = certificate;
							ca_certs.set(cert.type, cert_parsed);
						}
					}
					for await (const cert of databases.system.hdb_certificate.search([])) {
						try {
							if (cert.is_authority) {
								continue;
							}
							let is_operations = type === 'operations-api';
							if (!is_operations && cert.name.includes('operations')) continue;
							let quality;
							if (type === cert.name) quality = 5;
							else quality = CERT_PREFERENCE_APP[cert.name] ?? (is_operations ? 4 : 0);
							const private_key = private_keys.get(cert.private_key_name);
							const certificate = cert.certificate;
							if (!private_key || !certificate) {
								throw new Error('Missing private key or certificate for secure server');
							}
							let cert_authorities = ca_certs.get(type);
							const secure_options = {
								ciphers: cert.ciphers,
								ticketKeys: getTicketKeys(),
								ca: cert_authorities,
								cert: certificate,
								key: private_key,
							};
							if (server) secure_options.sessionIdContext = server.sessionIdContext;
							let secure_context = tls.createSecureContext(secure_options);
							secure_context.name = cert.name;
							secure_context.options = secure_options;
							secure_context.quality = quality;
							secure_context.certificateAuthorities = cert_authorities;
							harper_logger.warn('Create secure context', secure_context.rid);
							// we store the first 100 bytes of the certificate just for debug logging
							secure_context.certStart = certificate.toString().slice(0, 100);
							if (quality > best_quality) {
								// we use this certificate as the default if it has a higher quality than the existing one
								SNICallback.defaultContext = default_context = secure_context;
								best_quality = quality;
								if (server) {
									server.defaultContext = secure_context;
									server.setSecureContext(server, secure_options);
									harper_logger.info('Applying default TLS', secure_context.name, 'for', server.ports);
								}
							}
							const cert_parsed = new X509Certificate(certificate);
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
									  [cert_parsed.subject.match(/CN=(.*)/)?.[1]]);
							if (!Array.isArray(hostnames)) hostnames = [hostnames];
							for (let hostname of hostnames) {
								if (hostname) {
									if (hostname[0] === '*') {
										has_wildcards = true;
										hostname = hostname.slice(1);
									}
									// we use this certificate if it has a higher quality than the existing one for this hostname
									let existing_cert_quality = secure_contexts.get(hostname)?.quality ?? 0;
									if (quality > existing_cert_quality) {
										secure_contexts.set(hostname, secure_context);
									}
								} else {
									harper_logger.error('No hostname found for certificate at', tls.certificate);
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
			});
		}));
	};
	return SNICallback;
	function SNICallback(servername, cb) {
		// find the matching server name, substituting wildcards for each part of the domain to find matches
		harper_logger.warn('TLS requested for', servername, this.isReplicationConnection);
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
		// no matches, return the first one
		cb(null, default_context);
	}
}
function reverseSubscription(subscription) {
	const { subscribe, publish } = subscription;
	return { ...subscription, subscribe: publish, publish: subscribe };
}

async function listCertificates() {
	getCertTable();
	let response = [];
	for await (const cert of certificate_table.search([])) {
		response.push(cert);
	}
	return response;
}

async function addCertificate() {}

async function removeCertificate() {
	getCertTable();
}
