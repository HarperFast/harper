const hdb_license = require('./hdb_license');
const colors = require("colors/safe");
const log = require('../logging/harper_logger');
const check_permission = require('../check_permissions');
const prompt = require('prompt');
const {promisify} = require('util');
const terms = require('../hdbTerms');
const fs = require('fs-extra');
const path = require('path');
const hdb_utils = require('../common_utils');
const version = require('../../bin/version');
const env_utility = require('../environment/environmentManager');
const moment = require('moment');

//Promisified function
let p_prompt_get = promisify(prompt.get);

const LICENSE_FILE = path.join(hdb_utils.getHomeDir(), terms.HDB_HOME_DIR_NAME, terms.LICENSE_KEY_DIR_NAME, terms.LICENSE_FILE_NAME);

module.exports = {
    getFingerprint: getFingerprint,
    setLicense: setLicense,
    parseLicense: parseLicense,
    register: register,
    getRegistrationInfo
};

/**
 * Set the license on this node to the key specified in the json_message parameter.
 * @param json_message
 * @returns {Promise<string>}
 */
async function setLicense(json_message) {
    if (json_message && json_message.key && json_message.company) {
        try {
            log.info(`parsing license key: ${json_message.key} and `);
            let company = json_message.company.toString();
            await parseLicense(json_message.key.trim(), company.trim());
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
        check_permission.checkPermission();
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
 * @param company
 */
async function parseLicense(license, company) {
    if(!license || !company) {
        throw new Error(`Invalid entries for License Key and Customer Company`);
    }

    console.log('Validating license input...');
    let validation = hdb_license.validateLicense(license, company);

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

    try {
        log.info('writing license to disk');
        await fs.writeFile(LICENSE_FILE, JSON.stringify({"license_key": license, "company": company}));
    }catch(e){
        log.error('Failed to write License');
        throw e;
    }

    return 'Registration successful.';
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
        check_permission.checkPermission();
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

async function getRegistrationInfo() {
    const reg_info_obj = {
        registered: false,
        version: null,
        storage_type: null,
        ram_allocation: null,
        license_expiration_date: null
    };

    let license;

    try {
        license = await hdb_license.getLicense();
    } catch(e) {
        log.error(`There was an error when searching licenses due to: ${e.message}`);
        throw e;
    }

    if (hdb_utils.isEmptyOrZeroLength(license)) {
        throw new Error('There were no licenses found.');
    }

    reg_info_obj.registered = license.enterprise;
    reg_info_obj.version = version.version();
    reg_info_obj.storage_type = env_utility.getDataStoreType();
    reg_info_obj.ram_allocation = license.ram_allocation;
    if(isNaN(license.exp_date )){
        reg_info_obj.license_expiration_date = license.enterprise ? license.exp_date : null;
    } else {
        let exp_date = moment.utc(license.exp_date).format('YYYY-MM-DD');
        reg_info_obj.license_expiration_date = license.enterprise ? exp_date : null;
    }
    return reg_info_obj;
}
