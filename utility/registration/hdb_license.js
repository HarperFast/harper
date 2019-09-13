const fs = require('fs-extra');
const password = require('../password');
const crypto = require('crypto');
const moment = require('moment');
const uuidV4 = require('uuid/v4');
const log = require('../logging/harper_logger');
const path = require('path');
const hdb_utils = require('../common_utils');
const terms = require('../hdbTerms');

const INVALID_LICENSE_FORMAT_MSG = 'invalid license key format';
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
    validateLicense: validateLicense,
    generateFingerPrint: generateFingerPrint
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

async function validateLicense(license_key, company) {
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
    let is_exist = await fs.stat(FINGER_PRINT_FILE).catch((err) => {
        log.error(err);
    });
    if (is_exist) {
        let fingerprint;
        try {
            fingerprint = await fs.readFile(FINGER_PRINT_FILE, 'utf8');
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
