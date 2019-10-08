"use strict";

const fs = require('fs-extra');
const password = require('../password');
const crypto = require('crypto');
const moment = require('moment');
const uuidV4 = require('uuid/v4');
const log = require('../logging/harper_logger');
const path = require('path');
const hdb_utils = require('../common_utils');
const terms = require('../hdbTerms');
const License = require('../../utility/registration/licenseObjects').ExtendedLicense;
const INVALID_LICENSE_FORMAT_MSG = 'invalid license key format';
const LICENSE_HASH_PREFIX = '061183';
const LICENSE_KEY_DELIMITER = 'mofi25';
const env = require('../../utility/environment/environmentManager');

const promisify = require('util').promisify;
const search = require('../../data_layer/search');
const p_search_by_value = promisify(search.searchByValue);
const LICENSE_FILE = path.join(hdb_utils.getHomeDir(), terms.HDB_HOME_DIR_NAME, terms.LICENSE_KEY_DIR_NAME, terms.LICENSE_FILE_NAME);

let FINGER_PRINT_FILE = undefined;

let current_license = undefined;

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
    validateLicense: validateLicense,
    generateFingerPrint: generateFingerPrint,
    licenseSearch,
    getLicense
};

async function generateFingerPrint() {
    try {
        return await fs.readFile(FINGER_PRINT_FILE, 'utf8');
    } catch(e){
        if(e.code === 'ENOENT'){
            return await writeFingerprint();
        }

        log.error(`Error writing fingerprint file to ${FINGER_PRINT_FILE}`);
        log.error(e);
        throw new Error('There was an error generating the fingerprint');
    }
}

async function writeFingerprint(){
    let hash = uuidV4();
    let hashed_hash = password.hash(hash);
    await fs.writeFile(FINGER_PRINT_FILE, hashed_hash).catch((err) => {
        if(err.code === 'EEXIST'){
            return hashed_hash;
        }
        log.error(`Error writing fingerprint file to ${FINGER_PRINT_FILE}`);
        log.error(err);
        throw new Error('There was an error generating the fingerprint');
    });
    return hashed_hash;
}

function validateLicense(license_key, company) {
    let license_validation_object = {
        valid_license: false,
        valid_date: false,
        valid_machine: false,
        exp_date: null,
        storage_type: terms.STORAGE_TYPES_ENUM.FILE_SYSTEM,
        api_call: terms.LICENSE_VALUES.API_CALL_DEFAULT,
        version: terms.LICENSE_VALUES.VERSION_DEFAULT
    };
    if(!license_key) {
        log.error(`empty license key passed to validate.`);
        return license_validation_object;
    }

    let is_exist = false;

    try {
        is_exist = fs.statSync(FINGER_PRINT_FILE);
    } catch(err) {
        log.error(err);
    }

    if (is_exist) {
        let fingerprint;
        try {
            fingerprint = fs.readFileSync(FINGER_PRINT_FILE, 'utf8');
        } catch (e) {
            log.error('error validating this machine in the license');
            license_validation_object.valid_machine = false;
            return;
        }
        let decipher = crypto.createDecipher('aes192', fingerprint);

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
            license_validation_object.valid_machine = false;

            console.error(INVALID_LICENSE_FORMAT_MSG);
            log.error(INVALID_LICENSE_FORMAT_MSG);
            throw new Error(INVALID_LICENSE_FORMAT_MSG);
        }

        let license_obj;

        if (isNaN(decrypted)) {
            try {
                license_obj = JSON.parse(decrypted);
                license_validation_object.api_call = license_obj.api_call;
                license_validation_object.version = license_obj.version;
                license_validation_object.storage_type = license_obj.storage_type;
                license_validation_object.exp_date = license_obj.exp_date;
            } catch (e) {
                console.error(INVALID_LICENSE_FORMAT_MSG);
                log.error(INVALID_LICENSE_FORMAT_MSG);
                throw new Error(INVALID_LICENSE_FORMAT_MSG);
            }
        } else {
            license_validation_object.exp_date = decrypted;
        }

        if (license_validation_object.exp_date < moment().unix()) {
            license_validation_object.valid_date = false;
        }

        if (!password.validate(license_tokens[1], `${LICENSE_HASH_PREFIX}${fingerprint}${company}`)) {
            license_validation_object.valid_license = false;
        }
    } else {
        license_validation_object.valid_license = false;
        license_validation_object.valid_machine = false;
    }
    return license_validation_object;
}

/**
 * search for the hdb license, validate & return
 */
function licenseSearch(){
    let license_values = new License();
    license_values.api_call = 0;
    let licenses = [];

    try {
        let file_licenses = fs.readFileSync(LICENSE_FILE, 'utf-8');
        licenses = file_licenses.split(terms.NEW_LINE);
    } catch(e){
        if(e.code === 'ENOENT'){
            log.info('no license file found');
        } else {
            log.error(`could not search for licenses due to: '${e.message}`);
        }
    }

    for(let i=0; i<licenses.length; ++i) {
        let license_string = licenses[i];
        try {
            if(hdb_utils.isEmptyOrZeroLength(license_string)) {
                continue;
            }
            let license = JSON.parse(license_string);
            let license_validation = validateLicense(license.license_key, license.company);
            if (license_validation.valid_machine === true && license_validation.valid_date === true && license_validation.valid_license === true) {
                license_values.exp_date = license_validation.exp_date > license_values.exp_date ? license_validation.exp_date : license_values.exp_date;
                license_values.api_call += license_validation.api_call;
                license_values.storage_type = license_validation.storage_type;
                license_values.enterprise = true;
            }
        } catch(e) {
            log.error('There was an error parsing the license string.');
            log.error(e);
            license_values.api_call = terms.LICENSE_VALUES.API_CALL_DEFAULT;
            license_values.storage_type = terms.STORAGE_TYPES_ENUM.FILE_SYSTEM;
            license_values.enterprise = false;
        }
    };

    if(license_values.api_call === 0){
        license_values.api_call = terms.LICENSE_VALUES.API_CALL_DEFAULT;
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
    if(!current_license) {
        await licenseSearch();
    }
    return current_license;
}