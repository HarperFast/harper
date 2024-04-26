'use strict';

const path = require('path');
const fs = require('fs-extra');
const forge = require('node-forge');
const net = require('net');
let { X509Certificate, createPrivateKey, generateKeyPair } = require('crypto');
const util = require('util');
generateKeyPair = util.promisify(generateKeyPair);
const pki = forge.pki;
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
	generateCertsKeys,
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
	const public_pem = fs.readFileSync(env_manager.get(hdb_terms.CONFIG_PARAMS.TLS_CERTIFICATE), { encoding: 'utf8' });
	const private_pem = fs.readFileSync(env_manager.get(hdb_terms.CONFIG_PARAMS.TLS_PRIVATEKEY), { encoding: 'utf8' });
	const ca_pem = fs.readFileSync(env_manager.get(hdb_terms.CONFIG_PARAMS.TLS_CERTIFICATEAUTHORITY), {
		encoding: 'utf8',
	});

	const ca_private_pem = fs.readFileSync(
		path.join(env_manager.getHdbBasePath(), hdb_terms.LICENSE_KEY_DIR_NAME, certificates_terms.CA_PRIVATEKEY_PEM_NAME),
		{
			encoding: 'utf8',
		}
	);
	const public_cert = pki.certificateFromPem(public_pem);
	return {
		public_cert: public_cert,
		public_key: public_cert.publicKey,
		private_key: pki.privateKeyFromPem(private_pem),
		ca_cert: pki.certificateFromPem(ca_pem),
		ca_private_key: pki.privateKeyFromPem(ca_private_pem),
	};
}

//TODO add validation to this two op-api calls
function createCsr(req) {
	const { public_cert, private_key } = getTlsCertsKeys();

	const csr = pki.createCertificationRequest();
	csr.publicKey = public_cert.publicKey;
	const subject = [
		{
			name: 'commonName',
			// value: env_manager.get(hdb_terms.CONFIG_PARAMS.REPLICATION_NODENAME), //TODO: uncomment
			value: 'test',
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
			extensions: [
				{
					name: 'subjectAltName',
					altNames: [
						{
							// 2 is DNS type
							type: 2,
							value: req.host,
						},
					],
				},
			],
		},
	];
	hdb_logger.info('Creating CSR with attributes', attributes);
	csr.setAttributes(attributes);

	csr.sign(private_key);

	return forge.pki.certificationRequestToPem(csr);
}

function signCertificate(req) {
	const { ca_private_key, ca_cert } = getTlsCertsKeys();
	const csr = pki.certificationRequestFromPem(req.csr);
	try {
		csr.verify(); // TODO: what else should we do to verify the CSR?
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
	cert.sign(ca_private_key, forge.md.sha256.create());

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

	const x509 = new X509Certificate(cert_pem);
	let private_key_1 = fs.readFileSync('/Users/davidcockerill/hdb/keys/privateKey-2.pem', { encoding: 'utf8' });
	const pk = createPrivateKey(private_key_1);
	const value = x509.checkPrivateKey(pk);
	console.log(value);
}

function writeNewCert() {
	const pem =
		'-----BEGIN CERTIFICATE-----\r\nMIIFYTCCA0mgAwIBAgIBAjANBgkqhkiG9w0BAQsFADB0MScwJQYDVQQDEx5IYXJw\r\nZXJEQiBDZXJ0aWZpY2F0ZSBBdXRob3JpdHkxDDAKBgNVBAYTA1VTQTERMA8GA1UE\r\nCBMIQ29sb3JhZG8xDzANBgNVBAcTBkRlbnZlcjEXMBUGA1UEChMOSGFycGVyREIs\r\nIEluYy4wHhcNMjQwNDI0MjA0NTQyWhcNMzQwNDIyMjA0NTQyWjBaMQ0wCwYDVQQD\r\nEwR0ZXN0MQwwCgYDVQQGEwNVU0ExETAPBgNVBAgTCENvbG9yYWRvMQ8wDQYDVQQH\r\nEwZEZW52ZXIxFzAVBgNVBAoTDkhhcnBlckRCLCBJbmMuMIICIjANBgkqhkiG9w0B\r\nAQEFAAOCAg8AMIICCgKCAgEAoa0gdmlB+AvTVR45DYoZV681XxfrfD4rsW13jJyf\r\nkJmtdVh+qvfUcofBvVIwMHtMW7y6W8mg7km4miRWP8p0eHhjdTtI903Lm7HNUkAA\r\nETSWuUXEPbPZYdguj5pMjLuFuR4AF+CwxO8Bm6/S/d0US5qjPPQJQrZ3+dfsPlF+\r\n/CiDZpbJ4Ch7knLSINfQmh23zJbU0toPa3tyW1Tyw+/+d4i/z//Ugl24TBOwpSJ4\r\n7blGwOBdoRQWHZUX47VJqgqljTL3RJNV06oZ5dA6dTNWVmYnOdyaounQJ05+PGtq\r\nJCzFJrchhs9gVJyyC0GNE1cl5YeU+roP6/UhmHXqncjmEK3Z2/H72qVzdq/5eMbJ\r\npyZAoKxZ7udw0a54U/lkvTNuxbQT1oMVhi5oI7SF0Xrp3Sv2gVSi3WY6W3QUvxOf\r\neOvOHsU0bnXjk3wZAGOiigVh4AdMDaihs2M7rSECdcinslY+DhR8VXEtIMwMR71v\r\nERqlStaXbKZF1rcbFmWiDsn09d/FbnSdN7M50MVDS8rLNOu3ZSs79rMoA2mvfjXx\r\nSUK+aKP9BMqv4PAod7fzLNgTfjf7SyomdYMwIMxMag11VUoeM+pe4lhz3WFyJCMd\r\npCjimjYj6e6yTGdTnveZnZhCfbOPLiksunJqUhcXk2v4MD6toFTpuT9g8rtVkejf\r\nzs0CAwEAAaMYMBYwFAYDVR0RBA0wC4IJMTI3LjAuMC4yMA0GCSqGSIb3DQEBCwUA\r\nA4ICAQCbBjabqTZGFuOHwfjdtCVoqgPSCMU0q23Ydt+U/WCW4vLkvsJEvfuFovYU\r\nhgZqBLQykqfmTjiPZTKeFOE0swf4GgXf/DWMd5kjXVC3DVnXak9HHBM03T2EqxBy\r\n0Y+NBlQxdFr/hEnodgX5yFMXhEt2vMK2Wi3WiR/Hf14YAU0M4qW2pw+XF1ldspX2\r\nXo1SGMU6wfoNhRRBeuhHV48AjwHYsefJJEF2XwQ7lMHExvd2zg4j7jIeUwSrcsEh\r\n+lKLmCldc98A4u7IqAIzK5DKCb+kcD6thZ5hJfqZ4+QXlG8aX8kkaibN9/fuDCWo\r\nI1C8YLDV8F8FhVBzqguGEJznyEZp3Zp7r9tIzhI4wwvEF0gRRjjmpvlKQ73Zf5tz\r\noKyfedXE9n08CCIJy0DeoEI58a1zeB0y7qWdsV88MdlmiwIY6Sj9bVjtUHBih8bu\r\nQaQyxUyRF6xBsWpULnSRyUV1kj9hp6aBWP/yHexfxeQDlU6OGPvxYi9WFAlBumsN\r\n8eT9/b3hS0vf51fPTW9rz/egkNou4wPO0YcGwM0jYwEZC1uEFehyGbaThE+R7/g6\r\nE1czyUN1rkwxw5AJkAbUafXlP0Ve2VH4hEAAxTcJDTYSD4H9EGSz4ipZWIadlwDs\r\nmCZl560eisD46uauxtsG2PmGA5qvU9XQY5m2FoNfuoLzow/jbw==\r\n-----END CERTIFICATE-----\r\n';
	fs.writeFileSync('/Users/davidcockerill/hdb2/keys/certificate.pem', pem);
}

//writeNewCert();

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
async function generateCertificates(ca_private_key, ca_cert) {
	const { private_key, public_key } = await generateKeys();
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
			value: 'HarperDB', // TODO: what should this be?
		},
		...CERT_ATTRIBUTES,
	];

	public_cert.setSubject(subject);
	public_cert.setIssuer(ca_cert.subject.attributes);
	public_cert.setExtensions([
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
	]);

	public_cert.sign(ca_private_key, forge.md.sha256.create()); // TODO: Should we sign our cert with our CA?

	const keys_path = path.join(env_manager.getHdbBasePath(), hdb_terms.LICENSE_KEY_DIR_NAME);
	const cert_path = path.join(keys_path, certificates_terms.CERTIFICATE_PEM_NAME);
	const private_path = path.join(keys_path, certificates_terms.PRIVATEKEY_PEM_NAME);
	const ca_path = path.join(keys_path, certificates_terms.CA_PEM_NAME);
	updateConfigCert(cert_path, private_path, ca_path);

	await fs.writeFile(cert_path, pki.certificateToPem(public_cert));
	await fs.writeFile(private_path, pki.privateKeyToPem(private_key));
}

async function generateCertAuthority() {
	const { private_key: ca_private_key, public_key: ca_public_key } = await generateKeys();
	const ca_cert = pki.createCertificate();

	ca_cert.publicKey = ca_public_key;
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
	ca_cert.setSubject(subject); // TODO: confirm these values
	ca_cert.setIssuer(CERT_ATTRIBUTES);
	ca_cert.setExtensions([
		{ name: 'basicConstraints', cA: true, critical: true },
		{ name: 'keyUsage', keyCertSign: true, critical: true },
	]);

	ca_cert.sign(ca_private_key, forge.md.sha256.create());

	const keys_path = path.join(env_manager.getHdbBasePath(), hdb_terms.LICENSE_KEY_DIR_NAME);
	const ca_cert_path = path.join(keys_path, certificates_terms.CA_PEM_NAME);
	const ca_private_path = path.join(keys_path, certificates_terms.CA_PRIVATEKEY_PEM_NAME);

	await fs.writeFile(ca_cert_path, pki.certificateToPem(ca_cert));
	await fs.writeFile(ca_private_path, pki.privateKeyToPem(ca_private_key));

	return { ca_private_key, ca_cert };
}

async function generateCertsKeys() {
	const { ca_private_key, ca_cert } = await generateCertAuthority();
	await generateCertificates(ca_private_key, ca_cert);
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
