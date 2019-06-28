const fs = require('fs-extra');
const password = require('../password');
const crypto = require('crypto');
const cipher = crypto.createCipher('aes192', 'a password');
const validation = require('../../validation/registration/license_key_object.js');
const moment = require('moment');
const uuidV4 = require('uuid/v4');
const log = require('../logging/harper_logger');
const path = require('path');
const hdb_utils = require('../common_utils');
const terms = require('../hdbTerms');

const LICENSE_HASH_PREFIX = '061183';
const LICENSE_KEY_DELIMITER = 'mofi25';
const env = require('../../utility/environment/environmentManager');

let FINGER_PRINT_FILE = undefined;
try {
    FINGER_PRINT_FILE = `${env.get('PROJECT_DIR')}/utility/keys/${terms.REG_KEY_FILE_NAME}`;
    if(!fs.existsSync(FINGER_PRINT_FILE)) {
        // As of version 2.0, we store the reg keys in ~/.harperdb.
        FINGER_PRINT_FILE = path.join(hdb_utils.getHomeDir(), terms.HDB_HOME_DIR_NAME, terms.LICENSE_KEY_DIR_NAME, terms.REG_KEY_FILE_NAME);
    }
} catch(err) {
    // no-op, this should only fail during installation as the
}

module.exports = {
    generateLicense: generateLicense,
    validateLicense: validateLicense,
    generateFingerPrint: generateFingerPrint
};

async function generateFingerPrint() {
    let hash = uuidV4();
    let hashed_hash = password.hash(hash);
    await fs.writeFile(FINGER_PRINT_FILE, hashed_hash).catch((err) => {
        log.error(`Error writing fingerprint file to ${FINGER_PRINT_FILE}`);
        log.error(err);
        throw new Error('There was an error generating the fingerprint');
    });
    return hashed_hash;
}

function generateLicense(license_object) {
    let license = undefined;
    try {
        let validation_error = validation(license_object);
        if (validation_error) {
            throw validation_error;
        }

        let fingerprint = license_object.fingerprint;
        let company = license_object.company;
        let encrypted_exp = hashDate(moment(license_object.exp_date).unix());

        let hash_license = hashLicense(fingerprint, company);

        license = `${encrypted_exp}${LICENSE_KEY_DELIMITER}${hash_license}`;
    } catch(err) {
        log.error(`Error generating a license ${err}`);
        throw err;
    }
    return license;
}

async function validateLicense(license_key, company) {
    let license_validation_object = {};
    if(!license_key) {
        log.error(`empty license key passed to validate.`);
        license_validation_object.valid_license = false;
        return license_validation_object;
        return;
    }
    let decipher = crypto.createDecipher('aes192', 'a password');

    license_validation_object.valid_date = true;
    license_validation_object.valid_license = true;
    license_validation_object.valid_machine = true;
    let license_tokens = null;
    let decrypted = null;
    try {
        log.error(`tracing validateLicense.`);
        log.error(`license key is: ${license_key}`);
        license_tokens = license_key.split(LICENSE_KEY_DELIMITER);
        decrypted = decipher.update(license_tokens[0], 'hex', 'utf8');
        decrypted.trim();
        decrypted += decipher.final('utf8');
    } catch (e) {
        license_validation_object.valid_license = false;
        let err_msg = new Error(`invalid license key format`);
        console.error(`invalid license key format`);
        log.error(err_msg.message);
        throw err_msg;
    }

    if (decrypted < moment().unix()) {
        license_validation_object.valid_date = false;
    }

    let is_exist = await fs.stat(FINGER_PRINT_FILE).catch((err) => {
        log.error(err);
    });
    if (is_exist) {
        try {
            let data = await fs.readFile(FINGER_PRINT_FILE, 'utf8');
            if (!password.validate(license_tokens[1], `${LICENSE_HASH_PREFIX}${data}${company}`)) {
                license_validation_object.valid_license = false;
            }
        } catch (e) {
            log.error('error validating this machine in the license');
            license_validation_object.valid_machine = false;
        }
    } else {
        license_validation_object.valid_license = false;
        license_validation_object.valid_machine = false;
    }
    return license_validation_object;
}

function hashDate(expdate) {
    let encrypted_exp = cipher.update('' + expdate, 'utf8', 'hex');
    encrypted_exp += cipher.final('hex');
    return encrypted_exp;
}

function hashLicense(fingerprint, company) {
    return password.hash(`${LICENSE_HASH_PREFIX}${fingerprint}${company}`);
}
