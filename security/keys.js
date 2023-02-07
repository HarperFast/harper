'use strict';

const mkcert = require('mkcert');
const path = require('path');
const fs = require('fs-extra');

const hdb_logger = require('../utility/logging/harper_logger');
const env_manager = require('../utility/environment/environmentManager');
const hdb_terms = require('../utility/hdbTerms');
const certificates_terms = require('../utility/terms/certificates');
const { updateConfigValue } = require('../config/configUtils');

module.exports = generateKeys;

/**
 * Generates and writes to file certificate, private key and certificate authority.
 * @returns {Promise<void>}
 */
async function generateKeys() {
	const hdb_root = env_manager.getHdbBasePath();
	const keys_path = path.join(hdb_root, hdb_terms.LICENSE_KEY_DIR_NAME);

	let cert = await mkcert.createCert({
		domains: ['127.0.0.1', 'localhost', '::1'],
		validityDays: 365,
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

	const new_certs = {
		[hdb_terms.CONFIG_PARAMS.CLUSTERING_TLS_CERTIFICATE]: cert_path,
		[hdb_terms.CONFIG_PARAMS.CLUSTERING_TLS_PRIVATEKEY]: private_path,
		[hdb_terms.CONFIG_PARAMS.CLUSTERING_TLS_CERT_AUTH]: ca_path,
		[hdb_terms.CONFIG_PARAMS.CUSTOMFUNCTIONS_TLS_CERTIFICATE]: cert_path,
		[hdb_terms.CONFIG_PARAMS.CUSTOMFUNCTIONS_TLS_PRIVATEKEY]: private_path,
		[hdb_terms.CONFIG_PARAMS.CUSTOMFUNCTIONS_TLS_CERT_AUTH]: ca_path,
		[hdb_terms.CONFIG_PARAMS.OPERATIONSAPI_TLS_CERTIFICATE]: cert_path,
		[hdb_terms.CONFIG_PARAMS.OPERATIONSAPI_TLS_PRIVATEKEY]: private_path,
		[hdb_terms.CONFIG_PARAMS.OPERATIONSAPI_TLS_CERT_AUTH]: ca_path,
	};

	updateConfigValue(undefined, undefined, new_certs, false, true);
}
