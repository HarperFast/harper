'use strict';

const path = require('path');
const fs = require('fs-extra');
const forge = require('node-forge');
const net = require('net');
let { generateKeyPair, X509Certificate, createPrivateKey } = require('crypto');
const util = require('util');
const _ = require('lodash');
generateKeyPair = util.promisify(generateKeyPair);
const pki = forge.pki;
const hdb_logger = require('../utility/logging/harper_logger');
const env_manager = require('../utility/environment/environmentManager');
const hdb_terms = require('../utility/hdbTerms');
const { CONFIG_PARAMS } = hdb_terms;
const certificates_terms = require('../utility/terms/certificates');
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
} = certificates_terms;
const assign_cmdenv_vars = require('../utility/assignCmdEnvVariables');
const config_utils = require('../config/configUtils');

const { table, getDatabases, databases } = require('../resources/databases');

module.exports = {
	generateKeys,
	updateConfigCert,
	createCsr,
	signCertificate,
	generateCertsKeys,
	getCertsKeys,
	setCertTable,
	loadCertificates,
	setDefaultCertsKeys,
};

const { urlToNodeName } = require('../server/replication/replicator');
const { ensureNode } = require('../server/replication/subscriptionManager');
const { readFileSync } = require('fs');
const { createSecureContext } = require('node:tls');
const env = require('../utility/environment/environmentManager');
const { getTicketKeys } = require('../server/threads/manageThreads');
const harper_logger = require('../utility/logging/harper_logger');
const terms = require('../utility/hdbTerms');

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
	}

	return certificate_table;
}

/**
 * This function will use preference enums to pick which cert has the highest preference and return that cert.
 * @param rep_host
 * @returns {Promise<{app: {name: undefined, cert: undefined}, app_private_key, ca_certs: *[], ops_ca: {name: undefined, cert: undefined}, ops: {name: undefined, cert: undefined}, app_ca: {name: undefined, cert: undefined}, ops_private_key, rep: {name: undefined, cert: undefined}}>}
 */

async function getAllCertsKeys(preferred_name) {
	getCertTable();
	let preference = ca ? CA_CERT_PREFERENCE_APP : CERT_PREFERENCE_APP;
	let best_cert, best_quality;
	let ca_certs = new Set();
	for await (const cert of certificate_table.search([])) {
		if (cert.is_authority) ca_certs.add(cert.certificate);
		else {
			const { name, certificate } = cert;
			let quality;
			if (preferred_name === name) quality = 5;
			else quality = preference[name] ?? 0;
			if (quality > best_quality) {
				best_cert = cert;
				best_quality = quality;
			}
		}
	}

	// Add any CAs that might exist in hdb_nodes but not hdb_certificate
	const nodes_table = getDatabases()['system']['hdb_nodes'];
	for await (const node of nodes_table.search([])) {
		if (node.ca) {
			ca_certs.add(node.ca);
		}
	}

	return (
		best_cert && {
			cas: Array.from(ca_certs),
			...best_cert,
		}
	);
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
			ca_certs: [],
			ca_cert_names: [],
		};

	getCertTable();
	for await (const cert of certificate_table.search([])) {
		const { name, certificate } = cert;
		// A connection can take multiple CAs in an array, so we include them all here
		if (name?.includes?.('ca')) {
			response.ca_certs.push(certificate);
			response.ca_cert_names.push(name);
		}

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

		const inverted_cert_name = _.invert(CERT_NAME);
		// TODO: I think this will fail when we start adding more certs to the certs table that arent in CERT_NAME
		if (inverted_cert_name[name] === undefined) {
			response[name] = certificate;
			if (!name.includes('ca')) {
				response.rep.cert = certificate;
				response.rep.name = name;
				rep_cert_quality = 50;
			}
		}
	}

	// Add any CAs that might exist in hdb_nodes but not hdb_certificate
	const nodes_table = getDatabases()['system']['hdb_nodes'];
	for await (const node of nodes_table.search([])) {
		if (node.ca && !response.ca_certs.includes(node.ca)) {
			response.ca_certs.push(node.ca);
			response.ca_cert_names.push(node.name);
		}
	}

	return response;
}
const private_key_paths = new Map();
/**
 * This is responsible for loading any certificates that are in the harperdb-config.yaml file and putting them into the hdb_certificate table.
 * @return {*}
 */
function loadCertificates() {
	// these are the sections of the config to check
	const CERTIFICATE_CONFIGS = [
		{ configKey: CONFIG_PARAMS.TLS, ca: false },
		{ configKey: CONFIG_PARAMS.TLS, ca: true },
		{ configKey: CONFIG_PARAMS.OPERATIONSAPI_TLS, ca: false },
		{ configKey: CONFIG_PARAMS.OPERATIONSAPI_TLS, ca: true },
	];

	getCertTable();

	const root_path = env.get(terms.CONFIG_PARAMS.ROOTPATH); // need to relativize the paths so they aren't exposed
	let promise;
	for (let { configKey: config_key, ca } of CERTIFICATE_CONFIGS) {
		let configs = env_manager.get(config_key);
		if (configs) {
			// the configs can be an array, so normalize to an array
			if (!Array.isArray(configs)) {
				configs = [configs];
			}
			for (let config of configs) {
				let path = config[ca ? 'certificateAuthority' : 'certificate'];
				if (path) {
					if (fs.existsSync(path)) {
						let certificate = readPEM(path);
						if (CERTIFICATE_VALUES.cert === certificate) {
							// this is the compromised HarperDB certificate authority, and we do not even want to bother to
							// load it or tempted to use it anywhere (except NATS can directly load it)
							continue;
						}
						let private_key_name = config.privateKey && basename(config.privateKey);
						private_key_paths.set(private_key_name, readPEM(config.privateKey)); // don't expose the path, just the name

						promise = certificate_table.put({
							name: CERT_CONFIG_NAME_MAP[config_key + (ca ? '_certificateAuthority' : '_certificate')],
							uses: ['https', ...(config_key.includes('operations') ? ['operations'] : [])],
							ciphers: config.ciphers,
							certificate: readPEM(path),
							private_key_name,
							is_authority: ca,
						});
					} else {
						hdb_logger.error('Certificate file not found:', path);
					}
				}
			}
		}
	}
	return promise;
}

function getHost() {
	let rep_url = env_manager.get(hdb_terms.CONFIG_PARAMS.REPLICATION_URL);
	if (rep_url == null) {
		const host = CERT_DOMAINS[0];
		hdb_logger.info('replication url is missing from harperdb-config.yaml, using default host' + host);
		return host;
	}

	return urlToNodeName(rep_url);
}

//TODO add validation to these two op-api calls
async function createCsr() {
	let { app_private_key, app } = await getCertsKeys();
	const app_cert = pki.certificateFromPem(app.cert);
	app_private_key = pki.privateKeyFromPem(app_private_key);

	hdb_logger.info('Creating CSR with cert named:', app.name);

	const csr = pki.createCertificationRequest();
	csr.publicKey = app_cert.publicKey;
	const subject = [
		{
			name: 'commonName',
			value: getHost(),
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

	csr.sign(app_private_key);

	return forge.pki.certificationRequestToPem(csr);
}

function certExtensions() {
	const alt_name = CERT_DOMAINS.includes(getHost()) ? CERT_DOMAINS : [...CERT_DOMAINS, getHost()];

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
	app_private_key = pki.privateKeyFromPem(app_private_key);
	const ca_app_cert = pki.certificateFromPem(app_ca.cert);
	const adding_node = async () => {
		// If the sign req is coming from add node, add the requesting node to hdb_nodes
		if (req.add_node) {
			const node_record = { url: req.add_node.url, ca: pki.certificateToPem(ca_app_cert) };
			if (req.add_node.subscriptions) node_record.subscriptions = req.add_node.subscriptions;
			if (req.add_node.hasOwnProperty('subscribe') && req.add_node.hasOwnProperty('publish')) {
				node_record.subscribe = req.add_node.subscribe;
				node_record.publish = req.add_node.publish;
			}

			await ensureNode(undefined, node_record);
		}
	};

	let response = {
		ca_certificate: pki.certificateToPem(ca_app_cert),
	};
	if (req.csr) {
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
		hdb_logger.info('Sign cert did not receive a CSR from:', req.add_node.url, 'only the CA will be returned');
	}

	if (req.certificate) {
		//TODO: uncomment
		/*		const req_cert = pki.certificateFromPem(req.certificate);
		const verify = verifyCert(req_cert, ca_cert);
		if (verify) {
			hdb_logger.info('certificate provided to sign_certificate verified successfully');
			adding_node();
			return {
				certificate: req.certificate,
				ca_certificate: pki.certificateToPem(ca_cert),
			};
		} else {
			hdb_logger.warn(
				'certificate provided to sign_certificate was not verified. A new certificate will be created using the provided CSR.'
			);
		}*/
	}

	await adding_node();

	return response;
}

async function createCertificateTable(cert, ca_cert) {
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

	await setCertTable({
		name: certificates_terms.CERT_NAME.DEFAULT,
		uses: ['https', 'operations', 'wss'],
		certificate: cert,
		is_authority: false,
	});

	await setCertTable({
		name: certificates_terms.CERT_NAME.CA,
		uses: ['https', 'operations', 'wss'],
		certificate: ca_cert,
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

//TODO: add more logging
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
			value: getHost(),
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
			value: 'HarperDB Certificate Authority for ' + getHost(),
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
		const host = getHost();
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

	config_utils.updateConfigValue(undefined, undefined, new_certs, false, true);
}

async function getReplicationCAs() {
	// Add any CAs that might exist in hdb_nodes
	let ca_certs = new Set();
	const nodes_table = getDatabases()['system']['hdb_nodes'];
	for await (const node of nodes_table.search([])) {
		if (node.ca) {
			ca_certs.add(node.ca);
		}
	}
	return ca_certs;
}
function readPEM(path) {
	if (path.startsWith('-----BEGIN')) return path;
	return readFileSync(path, 'utf8');
}
function createSNICallback(type) {
	let secure_contexts = new Map();
	let cert_quality = new Map();
	async function updateTLS() {
		secure_contexts.clear();
		cert_quality.clear();
		let ca_certs = new Set();
		if (type === 'operations-api') {
			ca_certs = await getReplicationCAs();
		}
		let default_context,
			best_quality = 0;
		for await (const cert of certificate_table.search([])) {
			if (type !== 'operations-api' && cert.name.includes('operations')) continue;
			if (cert.is_authority) {
				ca_certs.add(cert.certificate);
				continue;
			}
			let quality;
			if (type === name) quality = 5;
			else quality = preference[name] ?? 0;
			const private_key = private_key_paths.get(cert.private_key_name);
			const certificate = cert.certificate;
			const certificate_authority = tls.certificateAuthority && readPEM(tls.certificateAuthority);
			if (!private_key || !certificate) {
				throw new Error('Missing private key or certificate for secure server');
			}
			let secure_context = createSecureContext({
				ciphers: env.get('tls_ciphers'),
				ca: certificate_authority,
				ticketKeys: getTicketKeys(),
			});
			// Due to https://github.com/nodejs/node/issues/36655, we need to ensure that we apply the key and cert
			// *after* the context is created, so that the ciphers are set and allow for lower security ciphers if needed
			secure_context.context.setCert(certificate);
			secure_context.context.setKey(private_key, undefined);

			// we store the first 100 bytes of the certificate just for debug logging
			secure_context.certStart = certificate.subarray(0, 100).toString();
			if (quality > best_quality) {
				default_context = secure_context;
				best_quality = quality;
			}
			let cert_parsed = new X509Certificate(certificate);
			let hostnames =
				tls.hostname ??
				tls.host ??
				tls.hostnames ??
				tls.hosts ??
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
					// we use this certificate if it has a higher quality than the existing one for this hostname
					let existing_cert_quality = cert_quality.get(hostname) ?? 0;
					if (quality > existing_cert_quality) {
						cert_quality.set(hostname, quality);
						secure_contexts.set(hostname, secure_context);
					}
				} else {
					harper_logger.error('No hostname found for certificate at', tls.certificate);
				}
			}
		}
	}
	return (servername, cb) => {
		// find the matching server name
		let context = secure_contexts.get(servername);
		if (context) {
			harper_logger.debug('Found certificate for', servername, context.certStart);
			cb(null, context);
		} else {
			harper_logger.debug('No certificate found to match', servername, 'using the first certificate');
			// no matches, return the first one
			cb(null, default_context);
		}
	};
}
