'use strict';

const fs = require('fs-extra');
const password = require('../password');
const crypto = require('crypto');
const moment = require('moment');
const uuidV4 = require('uuid').v4;
const log = require('../logging/harper_logger');
const path = require('path');
const hdb_utils = require('../common_utils');
const terms = require('../hdbTerms');
const { totalmem } = require('os');
const License = require('../../utility/registration/licenseObjects').ExtendedLicense;
const INVALID_LICENSE_FORMAT_MSG = 'invalid license key format';
const LICENSE_HASH_PREFIX = '061183';
const LICENSE_KEY_DELIMITER = 'mofi25';
const ALGORITHM = 'aes-256-cbc';
const IV_LENGTH = 16;
const KEY_LENGTH = 32;
const env = require('../../utility/environment/environmentManager');
env.initSync();

let current_license = undefined;

module.exports = {
	validateLicense: validateLicense,
	generateFingerPrint: generateFingerPrint,
	licenseSearch,
	getLicense,
	checkMemoryLimit,
};

function getLicenseDirPath() {
	return path.join(env.getHdbBasePath(), terms.LICENSE_KEY_DIR_NAME, terms.LICENSE_FILE_NAME);
}

function getLicenseFilePath() {
	const license_path = getLicenseDirPath();
	return path.join(license_path, terms.LICENSE_FILE_NAME);
}

function getFingerPrintFilePath() {
	const license_path = getLicenseDirPath();
	return path.join(license_path, terms.REG_KEY_FILE_NAME);
}

async function generateFingerPrint() {
	const finger_print_file = getFingerPrintFilePath();
	try {
		return await fs.readFile(finger_print_file, 'utf8');
	} catch (e) {
		if (e.code === 'ENOENT') {
			return await writeFingerprint();
		}

		log.error(`Error writing fingerprint file to ${finger_print_file}`);
		log.error(e);
		throw new Error('There was an error generating the fingerprint');
	}
}

async function writeFingerprint() {
	let hash = uuidV4();
	let hashed_hash = password.hash(hash);
	const finger_print_file = getFingerPrintFilePath();

	try {
		await fs.mkdirp(getLicenseDirPath());
		await fs.writeFile(finger_print_file, hashed_hash);
	} catch (err) {
		if (err.code === 'EEXIST') {
			return hashed_hash;
		}
		log.error(`Error writing fingerprint file to ${finger_print_file}`);
		log.error(err);
		throw new Error('There was an error generating the fingerprint');
	}

	return hashed_hash;
}

function validateLicense(license_key, company) {
	let license_validation_object = {
		valid_license: false,
		valid_date: false,
		valid_machine: false,
		exp_date: null,
		ram_allocation: terms.RAM_ALLOCATION_ENUM.DEFAULT,
		version: terms.LICENSE_VALUES.VERSION_DEFAULT,
	};
	if (!license_key) {
		log.error(`empty license key passed to validate.`);
		return license_validation_object;
	}

	const finger_print_file = getFingerPrintFilePath();
	let is_exist = false;

	try {
		is_exist = fs.statSync(finger_print_file);
	} catch (err) {
		log.error(err);
	}

	if (is_exist) {
		let fingerprint;
		try {
			fingerprint = fs.readFileSync(finger_print_file, 'utf8');
		} catch (e) {
			log.error('error validating this machine in the license');
			license_validation_object.valid_machine = false;
			return;
		}

		let license_tokens = license_key.split(LICENSE_KEY_DELIMITER);
		let iv = license_tokens[1];
		iv = Buffer.concat([Buffer.from(iv)], IV_LENGTH);
		let key = Buffer.concat([Buffer.from(fingerprint)], KEY_LENGTH);
		let decipher = crypto.createDecipheriv(ALGORITHM, key, iv);

		license_validation_object.valid_date = true;
		license_validation_object.valid_license = true;
		license_validation_object.valid_machine = true;
		let decrypted = null;
		try {
			decrypted = decipher.update(license_tokens[0], 'hex', 'utf8');
			decrypted.trim();
			decrypted += decipher.final('utf8');
		} catch (e) {
			let old_license = checkOldLicense(license_tokens[0], fingerprint);
			if (old_license) {
				decrypted = old_license;
			} else {
				license_validation_object.valid_license = false;
				license_validation_object.valid_machine = false;

				console.error(INVALID_LICENSE_FORMAT_MSG);
				log.error(INVALID_LICENSE_FORMAT_MSG);
				throw new Error(INVALID_LICENSE_FORMAT_MSG);
			}
		}

		let license_obj;

		if (isNaN(decrypted)) {
			try {
				license_obj = JSON.parse(decrypted);
				license_validation_object.version = license_obj.version;
				license_validation_object.exp_date = license_obj.exp_date;

				if (isNaN(license_validation_object.exp_date)) {
					license_validation_object.exp_date = new Date(license_validation_object.exp_date).getTime();
				}

				if (license_obj.ram_allocation) {
					license_validation_object.ram_allocation = license_obj.ram_allocation;
				}
			} catch (e) {
				console.error(INVALID_LICENSE_FORMAT_MSG);
				log.error(INVALID_LICENSE_FORMAT_MSG);
				throw new Error(INVALID_LICENSE_FORMAT_MSG);
			}
		} else {
			license_validation_object.exp_date = decrypted;
		}

		if (license_validation_object.exp_date < moment().valueOf()) {
			license_validation_object.valid_date = false;
		}

		if (!password.validate(license_tokens[1], `${LICENSE_HASH_PREFIX}${fingerprint}${company}`)) {
			license_validation_object.valid_license = false;
		}
	} else {
		license_validation_object.valid_license = false;
		license_validation_object.valid_machine = false;
	}

	if (
		!(
			license_validation_object.valid_license &&
			license_validation_object.valid_machine &&
			license_validation_object.valid_date
		)
	) {
		log.error('Invalid licence');
	}

	return license_validation_object;
}

/**
 * Licenses created pre 01-27-2020 were encrypted using an older deprecated cipher.
 * Here we check them against that older cipher.
 * @param license
 * @param fingerprint
 */
function checkOldLicense(license, fingerprint) {
	try {
		let decipher = crypto.createDecipher('aes192', fingerprint);
		let decrypted = decipher.update(license, 'hex', 'utf8');
		decrypted.trim();
		decrypted += decipher.final('utf8');
		return decrypted;
	} catch (err) {
		log.warn('Check old license failed');
	}
}

/**
 * search for the hdb license, validate & return
 */
function licenseSearch() {
	let license_values = new License();
	let licenses = [];

	try {
		let file_licenses = fs.readFileSync(getLicenseFilePath(), 'utf-8');
		licenses = file_licenses.split(terms.NEW_LINE);
	} catch (e) {
		if (e.code === 'ENOENT') {
			log.info('no license file found');
		} else {
			log.error(`could not search for licenses due to: '${e.message}`);
		}
	}

	for (let i = 0; i < licenses.length; ++i) {
		let license_string = licenses[i];
		try {
			if (hdb_utils.isEmptyOrZeroLength(license_string)) {
				continue;
			}
			let license = JSON.parse(license_string);
			let license_validation = validateLicense(license.license_key, license.company);
			if (
				license_validation.valid_machine === true &&
				license_validation.valid_date === true &&
				license_validation.valid_machine === true
			) {
				license_values.exp_date =
					license_validation.exp_date > license_values.exp_date ? license_validation.exp_date : license_values.exp_date;
				license_values.ram_allocation = license_validation.ram_allocation;
				license_values.enterprise = true;
			}
		} catch (e) {
			log.error('There was an error parsing the license string.');
			log.error(e);
			license_values.ram_allocation = terms.RAM_ALLOCATION_ENUM.DEFAULT;
			license_values.enterprise = false;
		}
	}

	current_license = license_values;
	return license_values;
}

/**
 * Returns the value of the most recently parsed license (likely during start up).  If the license has not yet been parsed,
 * the function will call licenseSearch to determine the current license.
 * @returns {Promise<undefined>}
 */
async function getLicense() {
	if (!current_license) {
		await licenseSearch();
	}
	return current_license;
}
function checkMemoryLimit() {
	const licensed_memory = licenseSearch().ram_allocation;
	let total_memory = process.constrainedMemory?.() || totalmem();
	total_memory = Math.round(Math.min(total_memory, totalmem()) / 2 ** 20);
	if (total_memory > licensed_memory) {
		return `This server has more memory (${total_memory}MB) than HarperDB is licensed for (${licensed_memory}MB), this should only be used for educational and development purposes.`;
	}
}
