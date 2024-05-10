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
const {
	CA_CERT_PREFERENCE_APP,
	CA_CERT_PREFERENCE_OPS,
	CERT_PREFERENCE_APP,
	CERT_PREFERENCE_OPS,
	CERT_PREFERENCE_REP,
	CERT_CONFIG_NAME_MAP,
	CERT_NAME,
} = certificates_terms;
const assign_cmdenv_vars = require('../utility/assignCmdEnvVariables');
const config_utils = require('../config/configUtils');

const { table, getDatabases, databases } = require('../resources/databases');

let certificate_table;

module.exports = {
	generateKeys,
	updateConfigCert,
	createCsr,
	signCertificate,
	generateCertsKeys,
	getCertsKeys,
	setCertTable,
	loadCertificates,
};

const { urlToNodeName } = require('../server/replication/replicator');
const { ensureNode } = require('../server/replication/subscriptionManager');

const CERT_VALIDITY_DAYS = 3650;
const CERT_DOMAINS = ['127.0.0.*'];
const CERT_ATTRIBUTES = [
	{ name: 'countryName', value: 'USA' },
	{ name: 'stateOrProvinceName', value: 'Colorado' },
	{ name: 'localityName', value: 'Denver' },
	{ name: 'organizationName', value: 'HarperDB, Inc.' },
];

function getTlsCertsKeys() {
	const public_pem = fs.readFileSync(env_manager.get(hdb_terms.CONFIG_PARAMS.TLS_CERTIFICATE), 'utf8');
	const private_pem = fs.readFileSync(env_manager.get(hdb_terms.CONFIG_PARAMS.TLS_PRIVATEKEY), 'utf8');
	const ca_pem = fs.readFileSync(env_manager.get(hdb_terms.CONFIG_PARAMS.TLS_CERTIFICATEAUTHORITY), 'utf8');

	const public_cert = pki.certificateFromPem(public_pem);
	return {
		public_cert: public_cert,
		public_key: public_cert.publicKey,
		private_key: pki.privateKeyFromPem(private_pem),
		ca_cert: pki.certificateFromPem(ca_pem),
	};
}

/*
* I don't know we need explicit priority attribute, just an order of preference. Maybe we can do this for the name:
"default" - default certificate that we generate
"default-ca" - default CA that we generate
"server" - certificate from tls.certificate
"ca" - certificate from tls.certificateAuthority
"operations-api" - certificate from operationsApi.tls.certificate
"operations-ca" - certificate from operationsApi.tls.certificateAuthority
When we receive a signed certificate, name it after the server ("some-server.com")
And the preference for the default/app HTTPS server would be "server", then any other certificate, then "default"
Preference for the operations API server would be "operations-api", "server",  then any other certificate, then "default"
Preference for client replication certificate would be certificate for that matches server, then any other certificate, then "operations-api", "server", then "default", I guess.
*
* */

/**
 * This function will use preference enums to pick which cert has the highest preference and return that cert.
 * @param rep_host
 * @returns {Promise<{app: {name: undefined, cert: undefined}, app_private_key, ca_certs: *[], ops_ca: {name: undefined, cert: undefined}, ops: {name: undefined, cert: undefined}, app_ca: {name: undefined, cert: undefined}, ops_private_key, rep: {name: undefined, cert: undefined}}>}
 */
async function getCertsKeys(rep_host = undefined) {
	await loadCertificates();
	const app_private_pem = await fs.readFile(env_manager.get(hdb_terms.CONFIG_PARAMS.TLS_PRIVATEKEY), 'utf8');
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

	for await (const cert of databases.system.hdb_certificate.search([])) {
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
		if (inverted_cert_name[name] === undefined) {
			response[name] = certificate;
			if (!name.includes('ca')) {
				response.rep.cert = certificate;
				response.rep.name = name;
				rep_cert_quality = 50;
			}
		}
	}

	return response;
}

function loadCertificates() {
	const CERTIFICATE_CONFIGS = [
		CONFIG_PARAMS.TLS_CERTIFICATE,
		CONFIG_PARAMS.TLS_CERTIFICATEAUTHORITY,
		CONFIG_PARAMS.OPERATIONSAPI_TLS_CERTIFICATE,
		CONFIG_PARAMS.OPERATIONSAPI_TLS_CERTIFICATEAUTHORITY,
	];

	if (!certificate_table) certificate_table = getDatabases()['system']['hdb_certificate'];

	let promise;
	for (let config_key of CERTIFICATE_CONFIGS) {
		const path = env_manager.get(config_key);
		if (path && fs.existsSync(path)) {
			promise = certificate_table.put({
				name: CERT_CONFIG_NAME_MAP[config_key],
				uses: ['https', ...(config_key.includes('operations') ? ['operations'] : [])],
				certificate: fs.readFileSync(path, 'utf8'),
				is_authority: config_key.includes('uthority'),
			});
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
	hdb_logger.info('Signing CSR with cert named', app_ca.name, 'with cert', app_ca.cert);

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

	await adding_node();

	return {
		certificate: pki.certificateToPem(cert),
		ca_certificate: pki.certificateToPem(ca_app_cert),
	};
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

	if (!certificate_table) certificate_table = getDatabases()['system']['hdb_certificate'];
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

	/*	// TODO: This is temp, the goal is that anything that needs these certs will get it from table
	const keys_path = path.join(env_manager.getHdbBasePath(), hdb_terms.LICENSE_KEY_DIR_NAME);
	const cert_path = path.join(keys_path, certificates_terms.CERTIFICATE_PEM_NAME);
	const ca_path = path.join(keys_path, certificates_terms.CA_PEM_NAME);
	await fs.writeFile(cert_path, public_cert);
	await fs.writeFile(ca_path, pki.certificateToPem(ca_cert));*/
}

// Update the cert config in harperdb-config.yaml
// If CLI or Env values are present it will use those values, else it will use default private key.
function updateConfigCert() {
	const cli_env_args = assign_cmdenv_vars(Object.keys(hdb_terms.CONFIG_PARAM_MAP), true);
	const keys_path = path.join(env_manager.getHdbBasePath(), hdb_terms.LICENSE_KEY_DIR_NAME);
	const private_key = path.join(keys_path, certificates_terms.PRIVATEKEY_PEM_NAME);

	// // TODO: remove this
	// const cert_path = path.join(keys_path, certificates_terms.CERTIFICATE_PEM_NAME);
	// const ca_path = path.join(keys_path, certificates_terms.CA_PEM_NAME);

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
