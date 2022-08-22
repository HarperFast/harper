'use strict';

const mkcert = require('mkcert');
const path = require('path');
const fs = require('fs-extra');

const hdb_logger = require('../utility/logging/harper_logger');
const env_manager = require('../utility/environment/environmentManager');
const hdb_terms = require('../utility/hdbTerms');
const certificates_terms = require('../utility/terms/certificates');

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
	//write certificate
	try {
		await fs.writeFile(path.join(keys_path, certificates_terms.CERTIFICATE_PEM_NAME), cert.cert);
	} catch (e) {
		hdb_logger.error(e);
		console.error('There was a problem creating the certificate file.  Please check the install log for details.');
		throw e;
	}

	//write private key
	try {
		await fs.writeFile(path.join(keys_path, certificates_terms.PRIVATEKEY_PEM_NAME), cert.key);
	} catch (e) {
		hdb_logger.error(e);
		console.error('There was a problem creating the private key file.  Please check the install log for details.');
		throw e;
	}

	//write certificate authority key
	try {
		await fs.writeFile(
			path.join(keys_path, certificates_terms.CA_PEM_NAME),
			certificates_terms.CERTIFICATE_VALUES.cert
		);
	} catch (e) {
		hdb_logger.error(e);
		console.error(
			'There was a problem creating the certificate authority file.  Please check the install log for details.'
		);
		throw e;
	}
}
