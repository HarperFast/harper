const hdb_license = require('./hdb_license');
const colors = require("colors/safe");
const log = require('../logging/harper_logger');
const check_permisison = require('../check_permissions');
const prompt = require('prompt');
const {promisify} = require('util');
const insert = require('../../data_layer/insert');
const env_mgr = require('../environment/environmentManager');
const terms = require('../hdbTerms');
const fs = require('fs-extra');

//Promisified function
let p_insert_insert = promisify(insert.insert);
let p_prompt_get = promisify(prompt.get);

module.exports = {
    getFingerprint: getFingerprintCB,
    setLicense: setLicenseCB,
    parseLicense: parseLicense,
    register: register
};

// For now, the function that is called via chooseOperation needs to be in the callback style.  Once we move away from
// callbacks, we can change the exports above from the cb function to the async function.
/**
 * Calls the getFingerprint async function to match the callback style of processLocalTransaction.  This will be
 * removed once those are migrated.
 * @param json_message - The JSON formatted inbound message.
 * @param callback
 * @returns {*}
 */
function getFingerprintCB(json_message, callback) {
    let fingerprint = {};
    getFingerprint().then((result) => {
        fingerprint['fingerprint'] = result;
        return callback(null, fingerprint);
    }).catch((err) => {
        log.error(`There was an error getting the fingerprint for this machine ${err}`);
        return callback(err, null);
    });
}

// For now, the function that is called via chooseOperation needs to be in the callback style.  Once we move away from
// callbacks, we can change the exports above from the cb function to the async function.
/**
 * Calls the setLicense async function to match the callback style of processLocalTransaction.  This will be removed
 * onces those are migrated to async/await.
 * @param json_message - The JSON formatted inbound message.
 * @param callback
 * @returns {*}
 */
function setLicenseCB(json_message, callback) {
    let call_result = undefined;
    setLicense(json_message).then((result) => {
        call_result = result;
        return callback(null, call_result);
    }).catch((err) => {
        log.error(`There was an error getting the fingerprint for this machine ${err}`);
        return callback(err, null);
    });
}

/**
 * Set the license on this node to the key specified in the json_message parameter.
 * @param json_message
 * @returns {Promise<string>}
 */
async function setLicense(json_message) {
    if (json_message && json_message.key && json_message.company) {
        try {
            log.info(`parsing license key: ${json_message.key} and `);
            let lic = await parseLicense(json_message.key.trim(), json_message.company.trim());
        } catch(err) {
            let err_msg = `There was an error parsing the license key.`;
            log.error(err_msg);
            log.error(err);
            throw new Error(err_msg);
        }
        return 'Wrote license key file.  Registration successful.';
    }
    throw new Error('Invalid key or company specified for license file.');
}

/**
 * Returns the fingerprint of this install which is used in the registration process.
 * @returns {Promise<*>}
 */
async function getFingerprint() {
    try {
        check_permisison.checkPermission();
    } catch(err) {
        log.error(err);
        throw new Error('You do not have permission to generate a fingerprint.');
    }
    let fingerprint = {};
    try {
        fingerprint = await hdb_license.generateFingerPrint();
    } catch(err) {
        let err_msg = 'Error generating fingerprint.';
        log.error(err_msg);
        log.error(err);
        throw new Error(err_msg);
    }
    return fingerprint;
}

/**
 * Takes the license string received either from the
 * @param license
 */
async function parseLicense(license, company) {
    if(!license || !company) {
        throw new Error(`Invalid entries for License Key and Customer Company`);
    }

    console.log('Validating license input...');
    let validation = await hdb_license.validateLicense(license, company).catch((err) => {
        log.error(err);
        throw err;
    });

    console.log(`checking for valid license...`);
    if (!validation.valid_license) {
        throw new Error('Invalid license found.');
    }
    console.log(`checking valid license date...`);
    if (!validation.valid_date) {
        throw new Error('This License has expired.');
    }
    console.log(`checking for valid machine license ${validation.valid_machine}`);
    if (!validation.valid_machine) {
        throw new Error('This license is in use on another machine.');
    }

    let insert_object = {
        operation: 'insert',
        schema: 'system',
        table: 'hdb_license',
        hash_attribute: 'license_key',
        records: [{"license_key": license, "company":company}]
    };

    await p_insert_insert(insert_object).catch((err) => {
        throw err;
    });

    return license;
}

async function register() {
    let data = await promptForRegistration().catch((err) => {
       throw err;
    });

    let result = parseLicense(data.HDB_LICENSE, data.CUSTOMER_COMPANY).catch((err) => {
       throw err;
    });

    return result;
}

/**
 * This handler is called when registration is run from the command line.
 * @returns {Promise<*>}
 */
async function promptForRegistration() {
    try {
        check_permisison.checkPermission();
    } catch(err) {
        return console.error(err.message);
    }

    let fingerprint = await hdb_license.generateFingerPrint();
    let register_schema = {
        properties: {
            CUSTOMER_COMPANY: {
                description: colors.magenta(`[COMPANY] Please enter your company name`),
                required: true
            },
            HDB_LICENSE: {
                description: colors.magenta(`[HDB_LICENSE] Your fingerprint is ${fingerprint} Please enter your license key`),
                required: true
            }
        }
    };

    try {
        prompt.start();
    } catch(err) {
        log.error(err);
    }

    let data = await p_prompt_get(register_schema).catch((err) => {
        console.error('There was a problem prompting for registration input.  Exiting.');
        throw err;
    });

    return data;
}