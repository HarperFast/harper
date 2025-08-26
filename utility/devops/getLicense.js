const licenseGenerator = require('./licenseGenerator.js');
const hdbTerms = require('../hdbTerms.ts');
const moment = require('moment');

const DURATION_UNIT = 'year';
const DURATION = 1;
const LICENSE_PARAMS = {
	company: undefined,
	fingerprint: undefined,
	ram_allocation: undefined, // in MB
	version: hdbTerms.LICENSE_VALUES.VERSION_DEFAULT,
	exp_date: moment().add(DURATION, DURATION_UNIT).format('YYYY-MM-DD'),
};

/**
 * Will generate a new license and log it to the console.
 * Update params above and run file with node.
 */
(function getLicense() {
	console.log('License:\n' + licenseGenerator.generateLicense(LICENSE_PARAMS));
})();
