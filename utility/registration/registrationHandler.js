const hdbLicense = require('./hdb_license.js');
const chalk = require('chalk');
const log = require('../logging/harper_logger.js');
const prompt = require('prompt');
const { promisify } = require('util');
const terms = require('../hdbTerms.ts');
const fs = require('fs-extra');
const path = require('path');
const hdbUtils = require('../common_utils.js');
const { packageJson } = require('../packageUtils.js');
const envUtility = require('../environment/environmentManager.js');
envUtility.initSync();

const moment = require('moment');

//Promisified function
let pPromptGet = promisify(prompt.get);

const LICENSE_FILE = path.join(
	envUtility.getHdbBasePath(),
	terms.LICENSE_KEY_DIR_NAME,
	terms.LICENSE_FILE_NAME,
	terms.LICENSE_FILE_NAME
);

module.exports = {
	getFingerprint,
	setLicense,
	parseLicense,
	register,
	getRegistrationInfo,
};

/**
 * Set the license on this node to the key specified in the jsonMessage parameter.
 * @param jsonMessage
 * @returns {Promise<string>}
 */
async function setLicense(jsonMessage) {
	if (jsonMessage && jsonMessage.key && jsonMessage.company) {
		try {
			log.info(`parsing license key: ${jsonMessage.key} and `);
			let company = jsonMessage.company.toString();
			await parseLicense(jsonMessage.key.trim(), company.trim());
		} catch (err) {
			let errMsg = `There was an error parsing the license key.`;
			log.error(errMsg);
			log.error(err);
			throw new Error(errMsg);
		}
		return 'Wrote license key file.  Registration successful.';
	}
	throw new Error('Invalid key or company specified for license file.');
}

/**
 * Returns the fingerprint of this install which is used in the registration process.
 * @returns {Promise<*>}
 */
async function getFingerprint() {
	let fingerprint = {};
	try {
		fingerprint = await hdbLicense.generateFingerPrint();
	} catch (err) {
		let errMsg = 'Error generating fingerprint.';
		log.error(errMsg);
		log.error(err);
		throw new Error(errMsg);
	}
	return fingerprint;
}

/**
 * Takes the license string received either from the
 * @param license
 * @param company
 */
async function parseLicense(license, company) {
	if (!license || !company) {
		throw new Error(`Invalid entries for License Key and Customer Company`);
	}

	log.info('Validating license input...');
	let validation = hdbLicense.validateLicense(license, company);

	log.info(`checking for valid license...`);
	if (!validation.valid_license) {
		throw new Error('Invalid license found.');
	}
	log.info(`checking valid license date...`);
	if (!validation.valid_date) {
		throw new Error('This License has expired.');
	}
	log.info(`checking for valid machine license ${validation.valid_machine}`);
	if (!validation.valid_machine) {
		throw new Error('This license is in use on another machine.');
	}

	try {
		log.info('writing license to disk');
		await fs.writeFile(LICENSE_FILE, JSON.stringify({ license_key: license, company: company }));
	} catch (e) {
		log.error('Failed to write License');
		throw e;
	}

	return 'Registration successful.';
}

async function register() {
	let data = await promptForRegistration();
	return parseLicense(data.HDB_LICENSE, data.CUSTOMER_COMPANY);
}

/**
 * This handler is called when registration is run from the command line.
 * @returns {Promise<*>}
 */
async function promptForRegistration() {
	let fingerprint = await hdbLicense.generateFingerPrint();
	let registerSchema = {
		properties: {
			CUSTOMER_COMPANY: {
				description: chalk.magenta(`[COMPANY] Please enter your company name`),
				required: true,
			},
			HDB_LICENSE: {
				description: chalk.magenta(`[HDB_LICENSE] Your fingerprint is ${fingerprint} Please enter your license key`),
				required: true,
			},
		},
	};

	try {
		prompt.start();
	} catch (err) {
		log.error(err);
	}

	let data;
	try {
		data = await pPromptGet(registerSchema);
	} catch (err) {
		console.error('There was a problem prompting for registration input.  Exiting.');
		throw err;
	}

	return data;
}

async function getRegistrationInfo() {
	const regInfoObj = {
		registered: false,
		version: null,
		ram_allocation: null,
		license_expiration_date: null,
	};

	let license;

	try {
		license = await hdbLicense.getLicense();
	} catch (e) {
		log.error(`There was an error when searching licenses due to: ${e.message}`);
		throw e;
	}

	if (hdbUtils.isEmptyOrZeroLength(license)) {
		throw new Error('There were no licenses found.');
	}

	regInfoObj.registered = license.enterprise;
	regInfoObj.version = packageJson.version;
	regInfoObj.ram_allocation = license.ram_allocation;
	if (isNaN(license.exp_date)) {
		regInfoObj.license_expiration_date = license.enterprise ? license.exp_date : null;
	} else {
		let expDate = moment.utc(license.exp_date).format('YYYY-MM-DD');
		regInfoObj.license_expiration_date = license.enterprise ? expDate : null;
	}
	return regInfoObj;
}
