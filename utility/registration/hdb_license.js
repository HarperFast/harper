'use strict';

const fs = require('fs-extra');
const password = require('../password.ts');
const crypto = require('crypto');
const moment = require('moment');
const uuidV4 = require('uuid').v4;
const log = require('../logging/harper_logger.js');
const path = require('path');
const hdbUtils = require('../common_utils.js');
const terms = require('../hdbTerms.ts');
const { totalmem } = require('os');
const License = require('../../utility/registration/licenseObjects.js').ExtendedLicense;
const INVALID_LICENSE_FORMAT_MSG = 'invalid license key format';
const LICENSE_HASH_PREFIX = '061183';
const LICENSE_KEY_DELIMITER = 'mofi25';
const ALGORITHM = 'aes-256-cbc';
const IV_LENGTH = 16;
const KEY_LENGTH = 32;
const env = require('../../utility/environment/environmentManager.js');
const { resolvePath } = require('../../config/configUtils.js');
env.initSync();

let currentLicense = undefined;

module.exports = {
	validateLicense,
	generateFingerPrint,
	licenseSearch,
	getLicense,
	checkMemoryLimit,
};

function getLicenseDirPath() {
	return path.join(env.getHdbBasePath(), terms.LICENSE_KEY_DIR_NAME, terms.LICENSE_FILE_NAME);
}

function getLicenseFilePath() {
	const licensePath = getLicenseDirPath();
	return resolvePath(path.join(licensePath, terms.LICENSE_FILE_NAME));
}

function getFingerPrintFilePath() {
	const licensePath = getLicenseDirPath();
	return resolvePath(path.join(licensePath, terms.REG_KEY_FILE_NAME));
}

async function generateFingerPrint() {
	const fingerPrintFile = getFingerPrintFilePath();
	try {
		return await fs.readFile(fingerPrintFile, 'utf8');
	} catch (e) {
		if (e.code === 'ENOENT') {
			return await writeFingerprint();
		}

		log.error(`Error writing fingerprint file to ${fingerPrintFile}`);
		log.error(e);
		throw new Error('There was an error generating the fingerprint');
	}
}

async function writeFingerprint() {
	let hash = uuidV4();
	let hashedHash = password.hash(hash, password.HASH_FUNCTION.MD5);
	const fingerPrintFile = getFingerPrintFilePath();

	try {
		await fs.mkdirp(getLicenseDirPath());
		await fs.writeFile(fingerPrintFile, hashedHash);
	} catch (err) {
		if (err.code === 'EEXIST') {
			return hashedHash;
		}
		log.error(`Error writing fingerprint file to ${fingerPrintFile}`);
		log.error(err);
		throw new Error('There was an error generating the fingerprint');
	}

	return hashedHash;
}

function validateLicense(licenseKey, company) {
	let licenseValidationObject = {
		valid_license: false,
		valid_date: false,
		valid_machine: false,
		exp_date: null,
		ram_allocation: terms.RAM_ALLOCATION_ENUM.DEFAULT,
		version: terms.LICENSE_VALUES.VERSION_DEFAULT,
	};
	if (!licenseKey) {
		log.error(`empty license key passed to validate.`);
		return licenseValidationObject;
	}

	const fingerPrintFile = getFingerPrintFilePath();
	let isExist = false;

	try {
		isExist = fs.statSync(fingerPrintFile);
	} catch (err) {
		log.error(err);
	}

	if (isExist) {
		let fingerprint;
		try {
			fingerprint = fs.readFileSync(fingerPrintFile, 'utf8');
		} catch (e) {
			log.error('error validating this machine in the license');
			licenseValidationObject.valid_machine = false;
			return;
		}

		let licenseTokens = licenseKey.split(LICENSE_KEY_DELIMITER);
		let iv = licenseTokens[1];
		iv = Buffer.concat([Buffer.from(iv)], IV_LENGTH);
		let key = Buffer.concat([Buffer.from(fingerprint)], KEY_LENGTH);
		let decipher = crypto.createDecipheriv(ALGORITHM, key, iv);

		licenseValidationObject.valid_date = true;
		licenseValidationObject.valid_license = true;
		licenseValidationObject.valid_machine = true;
		let decrypted = null;
		try {
			decrypted = decipher.update(licenseTokens[0], 'hex', 'utf8');
			decrypted.trim();
			decrypted += decipher.final('utf8');
		} catch (e) {
			let oldLicense = checkOldLicense(licenseTokens[0], fingerprint);
			if (oldLicense) {
				decrypted = oldLicense;
			} else {
				licenseValidationObject.valid_license = false;
				licenseValidationObject.valid_machine = false;

				console.error(INVALID_LICENSE_FORMAT_MSG);
				log.error(INVALID_LICENSE_FORMAT_MSG);
				throw new Error(INVALID_LICENSE_FORMAT_MSG);
			}
		}

		let licenseObj;

		if (isNaN(decrypted)) {
			try {
				licenseObj = JSON.parse(decrypted);
				licenseValidationObject.version = licenseObj.version;
				licenseValidationObject.exp_date = licenseObj.exp_date;

				if (isNaN(licenseValidationObject.exp_date)) {
					licenseValidationObject.exp_date = new Date(licenseValidationObject.exp_date).getTime();
				}

				if (licenseObj.ram_allocation) {
					licenseValidationObject.ram_allocation = licenseObj.ram_allocation;
				}
			} catch (e) {
				console.error(INVALID_LICENSE_FORMAT_MSG);
				log.error(INVALID_LICENSE_FORMAT_MSG);
				throw new Error(INVALID_LICENSE_FORMAT_MSG);
			}
		} else {
			licenseValidationObject.exp_date = decrypted;
		}

		if (licenseValidationObject.exp_date < moment().valueOf()) {
			licenseValidationObject.valid_date = false;
		}

		if (
			!password.validate(
				licenseTokens[1],
				`${LICENSE_HASH_PREFIX}${fingerprint}${company}`,
				password.HASH_FUNCTION.MD5
			)
		) {
			licenseValidationObject.valid_license = false;
		}
	} else {
		licenseValidationObject.valid_license = false;
		licenseValidationObject.valid_machine = false;
	}

	if (
		!(
			licenseValidationObject.valid_license &&
			licenseValidationObject.valid_machine &&
			licenseValidationObject.valid_date
		)
	) {
		log.error('Invalid licence');
	}

	return licenseValidationObject;
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
	let licenseValues = new License();
	let licenses = [];

	try {
		let fileLicenses = fs.readFileSync(getLicenseFilePath(), 'utf-8');
		licenses = fileLicenses.split('\r\n');
	} catch (e) {
		if (e.code === 'ENOENT') {
			log.debug('no license file found');
		} else {
			log.error(`could not search for licenses due to: '${e.message}`);
		}
	}

	for (let i = 0; i < licenses.length; ++i) {
		let licenseString = licenses[i];
		try {
			if (hdbUtils.isEmptyOrZeroLength(licenseString)) {
				continue;
			}
			let license = JSON.parse(licenseString);
			let licenseValidation = validateLicense(license.license_key, license.company);
			if (
				licenseValidation.valid_machine === true &&
				licenseValidation.valid_date === true &&
				licenseValidation.valid_machine === true
			) {
				licenseValues.exp_date =
					licenseValidation.exp_date > licenseValues.exp_date ? licenseValidation.exp_date : licenseValues.exp_date;
				licenseValues.ram_allocation = licenseValidation.ram_allocation;
				licenseValues.enterprise = true;
			}
		} catch (e) {
			log.error('There was an error parsing the license string.');
			log.error(e);
			licenseValues.ram_allocation = terms.RAM_ALLOCATION_ENUM.DEFAULT;
			licenseValues.enterprise = false;
		}
	}

	currentLicense = licenseValues;
	return licenseValues;
}

/**
 * Returns the value of the most recently parsed license (likely during start up).  If the license has not yet been parsed,
 * the function will call licenseSearch to determine the current license.
 * @returns {Promise<undefined>}
 */
async function getLicense() {
	if (!currentLicense) {
		await licenseSearch();
	}
	return currentLicense;
}
function checkMemoryLimit() {
	const licensedMemory = licenseSearch().ram_allocation;
	let totalMemory = process.constrainedMemory?.() || totalmem();
	totalMemory = Math.round(Math.min(totalMemory, totalmem()) / 2 ** 20);
	if (totalMemory > licensedMemory) {
		return `This server has more memory (${totalMemory}MB) than HarperDB is licensed for (${licensedMemory}MB), this should only be used for educational and development purposes.`;
	}
}
