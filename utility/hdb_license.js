const fs = require('fs'),
    password = require('./password'),
    crypto = require('crypto'),
    cipher = crypto.createCipher('aes192', 'a password'),

    validation = require('../validation/license_key_object.js'),
    moment = require('moment'),
    PropertiesReader = require('properties-reader'),
    hdb_properties = PropertiesReader(`${process.cwd()}/../hdb_boot_properties.file`);
    hdb_properties.append(hdb_properties.get('settings_path'));

const FINGER_PRINT_FILE = `${hdb_properties.get('PROJECT_DIR')}/utility/keys/060493.ks`;
const LICENSE_HASH_PREFIX = '061183';
const LICENSE_KEY_DELIMITER = 'mofi25';

module.exports = {
    generateLicense: generateLicense,
    validateLicense: validateLicense,
    generateFingerPrint: generateFingerPrint
}

function generateFingerPrint(callback) {
    const uuidV4 = require('uuid/v4');
    let hash = uuidV4(); // -> '110ec58a-a0f2-4ac4-8393-c866d813b8d1'
    let hashed_hash = password.hash(hash);
    fs.writeFile(FINGER_PRINT_FILE, hashed_hash, function (err, result) {
        if (err) {
            callback(err);
            return;
        }
        callback(null, hashed_hash);
    })
}

function generateLicense(license_object, callback) {
    let validation_error = validation(license_object);
    if(validation_error){
        callback(validation_error);
        return;
    }

    let fingerprint = license_object.fingerprint,
        company = license_object.company
    let encrypted_exp = hashDate(moment(license_object.exp_date).unix());

    let hash_license = hashLicense(fingerprint, company);

    let license = `${encrypted_exp}${LICENSE_KEY_DELIMITER}${hash_license}`
    callback(null, license);
}

function validateLicense(license_key, company, callback) {
    let  decipher = crypto.createDecipher('aes192', 'a password');
    let license_validation_object = {};
    license_validation_object.valid_date = true;
    license_validation_object.valid_license = true;
    license_validation_object.valid_machine = true;
    let license_tokens = null;
    let decrypted = null;
    try {
        license_tokens = license_key.split(LICENSE_KEY_DELIMITER);    
        decrypted = decipher.update(license_tokens[0], 'hex', 'utf8');
        decrypted += decipher.final('utf8');        
    } catch (e) {
        license_validation_object.valid_license = false;
        callback('invalid license key format', license_validation_object);
        return;
    }

    if (decrypted < moment().unix()) {
        license_validation_object.valid_date = false;
    }
    
    fs.exists(FINGER_PRINT_FILE, function(is_exist){ 
        if (is_exist) {
            try {
                fs.readFile(FINGER_PRINT_FILE, function (err, data) {
                    if (!password.validate(license_tokens[1], `${LICENSE_HASH_PREFIX}${data}${company}`)) {
                        license_validation_object.valid_license = false;
                    }

                    callback(null, license_validation_object);
                    return;
                });
            } catch (e) {
                license_validation_object.valid_machine = false;
                callback(null, license_validation_object);
                return;
            }
        } else {
            license_validation_object.valid_license = false;
            license_validation_object.valid_machine = false;
            callback(null, license_validation_object);
            return;
        }
    });    
}

function hashDate(expdate) {
    let encrypted_exp = cipher.update('' + expdate, 'utf8', 'hex');
    encrypted_exp += cipher.final('hex');
    return encrypted_exp;
}

function hashLicense(fingerprint, company) {
  //  let hmac = crypto.createHmac('sha256', 'a secret')
   // hmac.update(`061183${fingerprint}${company}`);
   // return hmac.digest('hex');
    return password.hash(`${LICENSE_HASH_PREFIX}${fingerprint}${company}`);
}
