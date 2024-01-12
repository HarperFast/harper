'use strict';

const mkcert = require('mkcert');
const path = require('path');
const fs = require('fs-extra');

const hdb_logger = require('../utility/logging/harper_logger');
const env_manager = require('../utility/environment/environmentManager');
const hdb_terms = require('../utility/hdbTerms');
const certificates_terms = require('../utility/terms/certificates');
const assign_cmdenv_vars = require('../utility/assignCmdEnvVariables');
const config_utils = require('../config/configUtils');

module.exports = {
	generateKeys,
	updateConfigCert,
};

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
