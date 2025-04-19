'use strict';

const moment = require('moment');
const crypto = require('crypto');
const log = require('../logging/harper_logger.js');
const password = require('../password.ts');
const ALGORITHM = 'aes-256-cbc';
const IV_LENGTH = 16;
const KEY_LENGTH = 32;
const LICENSE_HASH_PREFIX = '061183';
const LICENSE_KEY_DELIMITER = 'mofi25';
const validation = require('../../validation/registration/license_key_object.js');
const License = require('../registration/licenseObjects.js').BaseLicense;

module.exports = {
	generateLicense,
};

function generateLicense(licenseObject) {
	try {
		let validationError = validation(licenseObject);
		if (validationError) {
			throw validationError;
		}

		let hashLicense = password.hash(
			`${LICENSE_HASH_PREFIX}${licenseObject.fingerprint}${licenseObject.company}`,
			password.HASH_FUNCTION.MD5
		);
		let obj = new License(
			moment.utc(licenseObject.exp_date).valueOf(),
			licenseObject.ram_allocation,
			licenseObject.version,
			licenseObject.fingerprint
		);
		let encrypted = encrypt(obj, hashLicense);

		return `${encrypted}${LICENSE_KEY_DELIMITER}${hashLicense}`;
	} catch (err) {
		log.error(`Error generating a license ${err}`);
		throw err;
	}
}

function encrypt(licenseObject, hashLicense) {
	let key = Buffer.concat([Buffer.from(licenseObject.fingerprint)], KEY_LENGTH);
	let iv = Buffer.concat([Buffer.from(hashLicense)], IV_LENGTH);
	let cipher = crypto.createCipheriv(ALGORITHM, key, iv);
	let encrypted = cipher.update(JSON.stringify(licenseObject), 'utf8', 'hex');
	encrypted += cipher.final('hex');

	return encrypted;
}
