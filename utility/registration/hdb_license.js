const fs = require('fs-extra');
const password = require('../password');
const crypto = require('crypto');
const cipher = crypto.createCipher('aes192', 'a password');
const validation = require('../../validation/registration/license_key_object.js');
const moment = require('moment');
const uuidV4 = require('uuid/v4');
const log = require('../logging/harper_logger');

const LICENSE_HASH_PREFIX = '061183';
const LICENSE_KEY_DELIMITER = 'mofi25';
const PropertiesReader = require('properties-reader');

let hdb_properties = PropertiesReader(`${process.cwd()}/../hdb_boot_properties.file`);
hdb_properties.append(hdb_properties.get('settings_path'));

const FINGER_PRINT_FILE = `${hdb_properties.get('PROJECT_DIR')}/utility/keys/060493.ks`;

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
    });
    return hashed_hash;
}

function generateLicense(license_object) {
    let license = undefined;
    try {
        let validation_error = validation(license_object);
        if (validation_error) {
            return validation_error;
        }

        let fingerprint = license_object.fingerprint;
        let company = license_object.company;
        let encrypted_exp = hashDate(moment(license_object.exp_date).unix());

        let hash_license = hashLicense(fingerprint, company);

        license = `${encrypted_exp}${LICENSE_KEY_DELIMITER}${hash_license}`;
    } catch(err) {
        log.error(`Error generating a license ${err}`);
    }
    return license;
}

async function validateLicense(license_key, company) {
    let decipher = crypto.createDecipher('aes192', 'a password');
    let license_validation_object = {};
    license_validation_object.valid_date = true;
    license_validation_object.valid_license = true;
    license_validation_object.valid_machine = true;
    let license_tokens = null;
    let decrypted = null;
    try {
        license_tokens = license_key.split(LICENSE_KEY_DELIMITER);
        decrypted = decipher.update(license_tokens[0], 'hex', 'utf8');
        decrypted.trim();
        decrypted += decipher.final('utf8');
    } catch (e) {
        license_validation_object.valid_license = false;
        let err_msg = `invalid license key format`;
        log.error(err_msg);
        return err_msg;
    }

    if (decrypted < moment().unix()) {
        license_validation_object.valid_date = false;
    }

    let is_exist = await fs.exists(FINGER_PRINT_FILE);
    if (is_exist) {
        try {
            let data = await fs.access(FINGER_PRINT_FILE, fs.constants.F_OK);
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
