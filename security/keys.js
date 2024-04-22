'use strict';

const mkcert = require('mkcert');
const path = require('path');
const fs = require('fs-extra');
const forge = require('node-forge');

const hdb_logger = require('../utility/logging/harper_logger');
const env_manager = require('../utility/environment/environmentManager');
const hdb_terms = require('../utility/hdbTerms');
const certificates_terms = require('../utility/terms/certificates');
const assign_cmdenv_vars = require('../utility/assignCmdEnvVariables');
const config_utils = require('../config/configUtils');

module.exports = {
	generateKeys,
	updateConfigCert,
	createCsr,
	signCertificate,
};

const CERT_ATTRIBUTES = [
	{ name: 'countryName', value: 'USA' },
	{ name: 'stateOrProvinceName', value: 'Colorado' },
	{ name: 'localityName', value: 'Denver' },
	{ name: 'organizationName', value: 'HarperDB, Inc.' },
];

function getTlsCertsKeys() {
	// const foo = env_manager.get(hdb_terms.CONFIG_PARAMS.TLS_CERTIFICATE);
	// let public_certfoo = fs.readFileSync(foo);
	// let public_cert = fs.readFileSync(env_manager.get(hdb_terms.CONFIG_PARAMS.TLS_CERTIFICATE));
	// let public_certB = fs.readFileSync(env_manager.get(hdb_terms.CONFIG_PARAMS.TLS_CERTIFICATE));
	// let private_key = fs.readFileSync('/Users/davidcockerill/hdb/keys/privateKey.pem');
	// let private_keyb = fs.readFileSync(env_manager.get(hdb_terms.CONFIG_PARAMS.TLS_PRIVATEKEY));

	const pki = forge.pki;
	let public_pem = fs.readFileSync('/Users/davidcockerill/hdb/keys/certificate.pem', { encoding: 'utf8' });
	let private_pem = fs.readFileSync('/Users/davidcockerill/hdb/keys/privateKey.pem', { encoding: 'utf8' });
	//let private_pem = fs.readFileSync(env_manager.get(hdb_terms.CONFIG_PARAMS.TLS_PRIVATEKEY), { encoding: 'utf8' });
	const public_cert = pki.certificateFromPem(public_pem);
	const foo = public_cert.publicKey;
	const bah = pki.privateKeyFromPem(private_pem);
	console.log(1);
	return {
		public_cert: public_pem,
		public_key: public_cert.publicKey,
		private_key: pki.privateKeyFromPem(private_pem),
	};
}

//getTlsCertsKeys();
const pki = forge.pki;
function createCsr(req) {
	const { public_cert, private_key } = getTlsCertsKeys();

	const csr = pki.createCertificationRequest();
	// csr.publicKey = public_cert.publicKey;
	// csr.setSubject([
	// 	{
	// 		name: 'commonName',
	// 		//value: env_manager.get(hdb_terms.CONFIG_PARAMS.REPLICATION_NODENAME), // TODO: once this exist uncomment
	// 		value: 'node-name',
	// 	},
	// 	...CERT_ATTRIBUTES,
	// ]);
	//
	// csr.setAttributes([
	// 	{
	// 		name: 'unstructuredName',
	// 		value: 'HarperDB, Inc.',
	// 	},
	// 	{
	// 		name: 'extensionRequest',
	// 		extensions: [
	// 			{
	// 				name: 'subjectAltName',
	// 				altNames: [
	// 					{
	// 						// 2 is DNS type
	// 						type: 2,
	// 						value: req.host,
	// 					},
	// 				],
	// 			},
	// 		],
	// 	},
	// ]);
	//
	// csr.sign(private_key);
	//
	// const verified = csr.verify();
	// console.log(verified);
	// return forge.pki.certificationRequestToPem(csr);
}

// function generateReplicationCSR() {
// 	let public_cert = fs.readFileSync('/Users/davidcockerill/hdb/keys/certificate.pem', { encoding: 'utf8' });
// 	let private_key = fs.readFileSync('/Users/davidcockerill/hdb/keys/privateKey.pem', { encoding: 'utf8' });
//
// 	public_cert = pki.certificateFromPem(public_cert);
// 	private_key = pki.privateKeyFromPem(private_key);
//
// 	const csr = forge.pki.createCertificationRequest();
// 	csr.publicKey = public_cert.publicKey;
// 	csr.setSubject([
// 		{
// 			name: 'commonName',
// 			value: 'harperdb-replication-cert-request',
// 		},
// 	]);
// 	csr.setAttributes([
// 		{
// 			name: 'extensionRequest',
// 			extensions: [
// 				{
// 					name: 'subjectAltName',
// 					altNames: [
// 						{
// 							type: 2,
// 							value: 'test.domain.com',
// 						},
// 					],
// 				},
// 			],
// 		},
// 	]);
// 	csr.sign(private_key);
// 	return forge.pki.certificationRequestToPem(csr);
// }

function signCertificate() {}

function signCSR(csr_pem) {
	let public_cert_2 = fs.readFileSync('/Users/davidcockerill/hdb/keys/certificate-2.pem', { encoding: 'utf8' });
	let private_key_2 = fs.readFileSync('/Users/davidcockerill/hdb/keys/privateKey-2.pem', { encoding: 'utf8' });
	const pki = forge.pki;
	public_cert_2 = pki.certificateFromPem(public_cert_2);
	private_key_2 = pki.privateKeyFromPem(private_key_2);

	const csr = pki.certificationRequestFromPem(csr_pem);
	const verify = csr.verify();
	console.log(verify);

	const cert = forge.pki.createCertificate();
	cert.serialNumber = '02';

	cert.validity.notBefore = new Date();
	cert.validity.notAfter = new Date();
	cert.validity.notAfter.setFullYear(cert.validity.notBefore.getFullYear() + 1);

	// subject from CSR
	cert.setSubject(csr.subject.attributes);
	// issuer from CA
	cert.setIssuer(public_cert_2.subject.attributes);

	cert.setExtensions([
		{
			name: 'basicConstraints',
			cA: true,
		},
		{
			name: 'keyUsage',
			keyCertSign: true,
			digitalSignature: true,
			nonRepudiation: true,
			keyEncipherment: true,
			dataEncipherment: true,
		},
		{
			name: 'subjectAltName',
			altNames: [
				{
					type: 6, // URI
					value: 'http://example.org/webid#me',
				},
			],
		},
	]);

	cert.publicKey = csr.publicKey;
	cert.sign(private_key_2);

	return pki.certificateToPem(cert);
}

function verifyCert(cert_pem) {
	const pki = forge.pki;
	let public_cert_2 = fs.readFileSync('/Users/davidcockerill/hdb/keys/certificate-2.pem', { encoding: 'utf8' });
	public_cert_2 = pki.certificateFromPem(public_cert_2);
	const ca_store = pki.createCaStore([public_cert_2]);
	const cert_to_verify = pki.certificateFromPem(cert_pem);
	const verified = pki.verifyCertificateChain(ca_store, [cert_to_verify]);
	console.log(verified);

	const { X509Certificate, createPrivateKey } = require('crypto');
	const x509 = new X509Certificate(cert_pem);
	let private_key_1 = fs.readFileSync('/Users/davidcockerill/hdb/keys/privateKey-2.pem', { encoding: 'utf8' });
	const pk = createPrivateKey(private_key_1);
	const value = x509.checkPrivateKey(pk);
	console.log(value);
}

// const node_1_csr = generateReplicationCSR();
// const node_2_singed_cert = signCSR(node_1_csr);
// verifyCert(node_2_singed_cert);

// async function generateReplicationKeysCert(force = false) {
// 	const private_key_pem_path = path.join();
// 	if (true) {
// 		const pki = forge.pki;
// 		const keys = pki.rsa.generateKeyPair(2048);
// 		const cert = pki.createCertificate();
// 		cert.publicKey = keys.publicKey;
// 		cert.serialNumber = '01';
// 		cert.validity.notBefore = new Date();
// 		cert.validity.notAfter = new Date();
// 		cert.validity.notAfter.setFullYear(cert.validity.notBefore.getFullYear() + 1);
// 		const attrs = [
// 			{
// 				name: 'commonName',
// 				value: 'replication-cert',
// 			},
// 			{
// 				name: 'organizationName',
// 				value: 'HarperDB',
// 			},
// 		];
//
// 		// here we set subject and issuer as the same one
// 		cert.setSubject(attrs);
// 		cert.setIssuer(attrs);
//
// 		// the actual certificate signing
// 		cert.sign(keys.privateKey);
// 	}
//
// 	// var privateKey = pki.privateKeyFromPem(pem);
// 	// var pem = pki.privateKeyToPem(privateKey);
// 	// var publicKey = pki.publicKeyFromPem(pem);
// 	// var pem = pki.publicKeyToPem(publicKey);
//
// 	const csr = forge.pki.createCertificationRequest();
// 	csr.publicKey = keys.publicKey;
// 	csr.setSubject([
// 		{
// 			name: 'commonName',
// 			value: 'harperdb-replication-cert-request',
// 		},
// 	]);
// 	csr.setAttributes([
// 		{
// 			name: 'extensionRequest',
// 			extensions: [
// 				{
// 					name: 'subjectAltName',
// 					altNames: [
// 						{
// 							type: 2,
// 							value: 'test.domain.com',
// 						},
// 					],
// 				},
// 			],
// 		},
// 	]);
// 	csr.sign(keys.privateKey);
// 	const pem = forge.pki.certificationRequestToPem(csr);
// }

/**
 * Generates and writes to file certificate, private key and certificate authority.
 * @returns {Promise<void>}
 */
async function generateKeys() {
	const hdb_root = env_manager.getHdbBasePath();
	const keys_path = path.join(hdb_root, hdb_terms.LICENSE_KEY_DIR_NAME);

	let cert = await mkcert.createCert({
		domains: ['127.0.0.1', 'localhost', '::1'],
		validityDays: 3650,
		caKey: certificates_terms.CERTIFICATE_VALUES.key,
		caCert: certificates_terms.CERTIFICATE_VALUES.cert,
	});

	const cert_path = path.join(keys_path, certificates_terms.CERTIFICATE_PEM_NAME);
	const private_path = path.join(keys_path, certificates_terms.PRIVATEKEY_PEM_NAME);
	const ca_path = path.join(keys_path, certificates_terms.CA_PEM_NAME);
	//write certificate
	try {
		await fs.writeFile(cert_path, cert.cert);
	} catch (e) {
		hdb_logger.error(e);
		console.error('There was a problem creating the certificate file.  Please check the install log for details.');
		throw e;
	}

	//write private key
	try {
		await fs.writeFile(private_path, cert.key);
	} catch (e) {
		hdb_logger.error(e);
		console.error('There was a problem creating the private key file.  Please check the install log for details.');
		throw e;
	}

	//write certificate authority key
	try {
		await fs.writeFile(ca_path, certificates_terms.CERTIFICATE_VALUES.cert);
	} catch (e) {
		hdb_logger.error(e);
		console.error(
			'There was a problem creating the certificate authority file.  Please check the install log for details.'
		);
		throw e;
	}

	updateConfigCert(cert_path, private_path, ca_path);
	//await generateKeysB();
}

async function generateKeysB() {
	const hdb_root = env_manager.getHdbBasePath();
	const keys_path = path.join(hdb_root, hdb_terms.LICENSE_KEY_DIR_NAME);

	let cert = await mkcert.createCert({
		domains: ['127.0.0.1', 'localhost', '::1'],
		validityDays: 3650,
		caKey: certificates_terms.CERTIFICATE_VALUES.key,
		caCert: certificates_terms.CERTIFICATE_VALUES.cert,
	});

	const cert_path = path.join(keys_path, 'certificate-2.pem');
	const private_path = path.join(keys_path, 'privateKey-2.pem');
	const ca_path = path.join(keys_path, 'ca-2.pem');
	//write certificate
	try {
		await fs.writeFile(cert_path, cert.cert);
	} catch (e) {
		hdb_logger.error(e);
		console.error('There was a problem creating the certificate file.  Please check the install log for details.');
		throw e;
	}

	//write private key
	try {
		await fs.writeFile(private_path, cert.key);
	} catch (e) {
		hdb_logger.error(e);
		console.error('There was a problem creating the private key file.  Please check the install log for details.');
		throw e;
	}

	//write certificate authority key
	try {
		await fs.writeFile(ca_path, certificates_terms.CERTIFICATE_VALUES.cert);
	} catch (e) {
		hdb_logger.error(e);
		console.error(
			'There was a problem creating the certificate authority file.  Please check the install log for details.'
		);
		throw e;
	}
}

// Update the cert config in harperdb-config.yaml
// If CLI or Env values are present it will use those values, else it will default to passed params.
function updateConfigCert(public_cert, private_cert, ca_cert) {
	const cli_env_args = assign_cmdenv_vars(Object.keys(hdb_terms.CONFIG_PARAM_MAP), true);

	// This object is what will be added to the harperdb-config.yaml file.
	// We check for any CLI of Env args and if they are present we use them instead of default values.
	const conf = hdb_terms.CONFIG_PARAMS;
	const new_certs = {
		[conf.CLUSTERING_TLS_CERTIFICATE]: cli_env_args[conf.CLUSTERING_TLS_CERTIFICATE.toLowerCase()]
			? cli_env_args[conf.CLUSTERING_TLS_CERTIFICATE]
			: public_cert,
		[conf.CLUSTERING_TLS_PRIVATEKEY]: cli_env_args[conf.CLUSTERING_TLS_PRIVATEKEY.toLowerCase()]
			? cli_env_args[conf.CLUSTERING_TLS_PRIVATEKEY.toLowerCase()]
			: private_cert,
		[conf.CLUSTERING_TLS_CERT_AUTH]: cli_env_args[conf.CLUSTERING_TLS_CERT_AUTH.toLowerCase()]
			? cli_env_args[conf.CLUSTERING_TLS_CERT_AUTH.toLowerCase()]
			: ca_cert,
		[conf.TLS_CERTIFICATE]: cli_env_args[conf.TLS_CERTIFICATE.toLowerCase()]
			? cli_env_args[conf.TLS_CERTIFICATE.toLowerCase()]
			: public_cert,
		[conf.TLS_PRIVATEKEY]: cli_env_args[conf.TLS_PRIVATEKEY.toLowerCase()]
			? cli_env_args[conf.TLS_PRIVATEKEY.toLowerCase()]
			: private_cert,
		[conf.TLS_CERTIFICATEAUTHORITY]: cli_env_args[conf.TLS_CERTIFICATEAUTHORITY.toLowerCase()]
			? cli_env_args[conf.TLS_CERTIFICATEAUTHORITY.toLowerCase()]
			: ca_cert,
	};

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
