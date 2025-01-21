'use strict';

const moment = require('moment');
const crypto = require('crypto');
const log = require('../logging/harper_logger');
const password = require('../password');
const ALGORITHM = 'aes-256-cbc';
const IV_LENGTH = 16;
const KEY_LENGTH = 32;
const LICENSE_HASH_PREFIX = '061183';
const LICENSE_KEY_DELIMITER = 'mofi25';
const validation = require('../../validation/registration/license_key_object');
const License = require('../registration/licenseObjects').BaseLicense;

module.exports = {
	generateLicense: generateLicense,
};

function generateLicense(license_object) {
	try {
		let validation_error = validation(license_object);
		if (validation_error) {
			throw validation_error;
		}

		let hash_license = password.hash(
			`${LICENSE_HASH_PREFIX}${license_object.fingerprint}${license_object.company}`,
			password.HASH_FUNCTION.MD5
		);
		let obj = new License(
			moment.utc(license_object.exp_date).valueOf(),
			license_object.ram_allocation,
			license_object.version,
			license_object.fingerprint
		);
		let encrypted = encrypt(obj, hash_license);

		return `${encrypted}${LICENSE_KEY_DELIMITER}${hash_license}`;
	} catch (err) {
		log.error(`Error generating a license ${err}`);
		throw err;
	}
}

function encrypt(license_object, hash_license) {
	let key = Buffer.concat([Buffer.from(license_object.fingerprint)], KEY_LENGTH);
	let iv = Buffer.concat([Buffer.from(hash_license)], IV_LENGTH);
	let cipher = crypto.createCipheriv(ALGORITHM, key, iv);
	let encrypted = cipher.update(JSON.stringify(license_object), 'utf8', 'hex');
	encrypted += cipher.final('hex');

	return encrypted;
}
