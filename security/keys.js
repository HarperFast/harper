'use strict';

const path = require('path');
const fs = require('fs-extra');
const forge = require('node-forge');
const net = require('net');
let { generateKeyPair, X509Certificate, createPrivateKey } = require('crypto');
const util = require('util');
generateKeyPair = util.promisify(generateKeyPair);
const pki = forge.pki;
const hdb_logger = require('../utility/logging/harper_logger');
const env_manager = require('../utility/environment/environmentManager');
const hdb_terms = require('../utility/hdbTerms');
const certificates_terms = require('../utility/terms/certificates');
const assign_cmdenv_vars = require('../utility/assignCmdEnvVariables');
const config_utils = require('../config/configUtils');
const { ensureNode } = require('../server/replication/subscriptionManager');
const { table, getDatabases, databases } = require('../resources/databases');
const { urlToNodeName } = require('../server/replication/replicator');

let certificate_table;

module.exports = {
	generateKeys,
	updateConfigCert,
	createCsr,
	signCertificate,
	generateCertsKeys,
	getCertsKeys,
	setCertTable,
};

const CERT_VALIDITY_DAYS = 3650;
const CERT_DOMAINS = ['127.0.0.1', '127.0.0.2', '127.0.0.3', '127.0.0.4', '127.0.0.5', 'localhost', '::1'];
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

async function getCertsKeys(rep_host = undefined) {
	const app_private_pem = await fs.readFile(env_manager.get(hdb_terms.CONFIG_PARAMS.TLS_PRIVATEKEY), 'utf8');
	const app_private_key = pki.privateKeyFromPem(app_private_pem);
	const ops_private_pem = (await fs.exists(env_manager.get(hdb_terms.CONFIG_PARAMS.OPERATIONSAPI_TLS_PRIVATEKEY)))
		? await fs.readFile(env_manager.get(hdb_terms.CONFIG_PARAMS.OPERATIONSAPI_TLS_PRIVATEKEY))
		: app_private_key;

	for await (const cert of databases.system.hdb_certificate.search([])) {
	}

	return {
		app_private_key: pki.privateKeyFromPem(app_private_pem),
		ops_private_key: pki.privateKeyFromPem(ops_private_pem),
	};
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

//TODO add validation to this two op-api calls
function createCsr() {
	const { public_cert, private_key } = getTlsCertsKeys();

	const csr = pki.createCertificationRequest();
	csr.publicKey = public_cert.publicKey;
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

	csr.sign(private_key);

	return forge.pki.certificationRequestToPem(csr);
}

function certExtensions() {
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
			altNames: CERT_DOMAINS.map((domain) => {
				// types https://git.io/fptng
				if (net.isIP(domain)) {
					return { type: 7, ip: domain };
				}
				return { type: 2, value: domain };
			}),
		},
	];
}

function signCertificate(req) {
	const { private_key, ca_cert } = getTlsCertsKeys();
	const adding_node = () => {
		// If the sign req is coming from add node, add the requesting node to hdb_nodes
		if (req.add_node) {
			const node_record = { url: req.add_node.url, ca: pki.certificateToPem(ca_cert) };
			if (req.add_node.subscriptions) node_record.subscriptions = req.add_node.subscriptions;
			if (req.add_node.hasOwnProperty('subscribe') && req.add_node.hasOwnProperty('publish')) {
				node_record.subscribe = req.add_node.subscribe;
				node_record.publish = req.add_node.publish;
			}

			ensureNode(undefined, node_record);
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
	cert.serialNumber = '02';
	cert.validity.notBefore = new Date();
	const not_after = new Date();
	cert.validity.notAfter = not_after;
	cert.validity.notAfter.setDate(not_after.getDate() + CERT_VALIDITY_DAYS);
	hdb_logger.info('sign cert setting validity:', cert.validity);

	// subject from CSR
	hdb_logger.info('sign cert setting subject from CSR:', csr.subject.attributes);
	cert.setSubject(csr.subject.attributes);

	// issuer from CA
	hdb_logger.info('sign cert setting issuer:', ca_cert.subject.attributes);
	cert.setIssuer(ca_cert.subject.attributes);

	const extensions = csr.getAttribute({ name: 'extensionRequest' }).extensions;
	hdb_logger.info('sign cert adding extensions from CSR:', extensions);
	cert.setExtensions(extensions);

	cert.publicKey = csr.publicKey;
	cert.sign(private_key, forge.md.sha256.create());

	adding_node();

	return {
		certificate: pki.certificateToPem(cert),
		ca_certificate: pki.certificateToPem(ca_cert),
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
	public_cert.serialNumber = '01';
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
	ca_cert.serialNumber = '03'; //TODO: check if we should expand serial numbers
	ca_cert.validity.notBefore = new Date();
	const not_after = new Date();
	ca_cert.validity.notAfter = not_after;
	ca_cert.validity.notAfter.setDate(not_after.getDate() + CERT_VALIDITY_DAYS);

	const subject = [
		{
			name: 'commonName',
			value: 'HarperDB Certificate Authority',
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

	// TODO: This is temp, the goal is that anything that needs these certs will get it from table
	const keys_path = path.join(env_manager.getHdbBasePath(), hdb_terms.LICENSE_KEY_DIR_NAME);
	const cert_path = path.join(keys_path, certificates_terms.CERTIFICATE_PEM_NAME);
	const ca_path = path.join(keys_path, certificates_terms.CA_PEM_NAME);
	await fs.writeFile(cert_path, public_cert);
	await fs.writeFile(ca_path, pki.certificateToPem(ca_cert));
}

// Update the cert config in harperdb-config.yaml
// If CLI or Env values are present it will use those values, else it will use default private key.
function updateConfigCert() {
	const cli_env_args = assign_cmdenv_vars(Object.keys(hdb_terms.CONFIG_PARAM_MAP), true);
	const keys_path = path.join(env_manager.getHdbBasePath(), hdb_terms.LICENSE_KEY_DIR_NAME);
	const private_key = path.join(keys_path, certificates_terms.PRIVATEKEY_PEM_NAME);

	// TODO: remove this
	const cert_path = path.join(keys_path, certificates_terms.CERTIFICATE_PEM_NAME);
	const ca_path = path.join(keys_path, certificates_terms.CA_PEM_NAME);

	// This object is what will be added to the harperdb-config.yaml file.
	// We check for any CLI of Env args and if they are present we use them instead of default values.
	const conf = hdb_terms.CONFIG_PARAMS;
	const new_certs = {
		[conf.TLS_PRIVATEKEY]: cli_env_args[conf.TLS_PRIVATEKEY.toLowerCase()]
			? cli_env_args[conf.TLS_PRIVATEKEY.toLowerCase()]
			: private_key,
		[conf.TLS_CERTIFICATE]: cli_env_args[conf.TLS_CERTIFICATE.toLowerCase()] // TODO: remove
			? cli_env_args[conf.TLS_CERTIFICATE.toLowerCase()]
			: cert_path,
		[conf.TLS_CERTIFICATEAUTHORITY]: cli_env_args[conf.TLS_CERTIFICATEAUTHORITY.toLowerCase()] // TODO: remove
			? cli_env_args[conf.TLS_CERTIFICATEAUTHORITY.toLowerCase()]
			: ca_path,
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
