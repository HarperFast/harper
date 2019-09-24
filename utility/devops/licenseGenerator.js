"use strict";

const moment = require('moment');
const crypto = require('crypto');
const terms = require('../hdbTerms');
const log = require('../logging/harper_logger');
const password = require('../password');
const LICENSE_HASH_PREFIX = '061183';
const LICENSE_KEY_DELIMITER = 'mofi25';
const validation = require('../../validation/registration/license_key_object.js');
const License = require('../registration/licenseObjects').BaseLicense;

module.exports={
    generateLicense: generateLicense
};

function hashDate(obj, fingerprint) {
    let cipher = crypto.createCipher('aes192', fingerprint);
    let encrypted_exp = cipher.update(JSON.stringify(obj), 'utf8', 'hex');
    encrypted_exp += cipher.final('hex');
    return encrypted_exp;
}

function hashLicense(fingerprint, company) {
    return password.hash(`${LICENSE_HASH_PREFIX}${fingerprint}${company}`);
}

function generateLicense(license_object) {
    let license = undefined;
    try {
        let validation_error = validation(license_object);
        if (validation_error) {
            throw validation_error;
        }
        let fingerprint = license_object.fingerprint,
            company = license_object.company;

        let obj = new License(moment(license_object.exp_date).unix(), license_object.storage_type, license_object.api_call, license_object.version);

        let encrypted_exp = hashDate(obj, fingerprint);

        let hash_license = hashLicense(fingerprint, company);

        license = `${encrypted_exp}${LICENSE_KEY_DELIMITER}${hash_license}`;
    } catch(err) {
        log.error(`Error generating a license ${err}`);
        throw err;
    }
    return license;
}