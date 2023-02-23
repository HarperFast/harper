const license_generator = require('./licenseGenerator');
const hdb_terms = require('../hdbTerms');
const moment = require('moment');

const DURATION_UNIT = 'year';
const DURATION = 1;
const LICENSE_PARAMS = {
	company: undefined,
	fingerprint: undefined,
	ram_allocation: undefined, // in MB
	storage_type: 'lmdb',
	api_call: 1000000000 * 1000000000,
	version: hdb_terms.LICENSE_VALUES.VERSION_DEFAULT,
	exp_date: moment().add(DURATION, DURATION_UNIT).format('YYYY-MM-DD'),
};

/**
 * Will generate a new license and log it to the console.
 * Update params above and run file with node.
 */
(function getLicense() {
	console.log('License:\n' + license_generator.generateLicense(LICENSE_PARAMS));
})();
