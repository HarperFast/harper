const hdb_license = require('./hdb_license');
const colors = require("colors/safe");
const log = require('../logging/harper_logger');
const check_permisison = require('../check_permissions');
const prompt = require('prompt');
const {promisify} = require('util');
const {inspect} = require('util');
let insert = require('../../data_layer/insert');

//Promisified function
let p_insert_insert = promisify(insert.insert);
let p_prompt_get = promisify(prompt.get);

module.exports = {
    get_fingerprint: get_fingerprint_cb,
    register: register
};

// For now, the function that is called via chooseOperation needs to be in the callback style.  Once we move away from
// callbacks, we can change the exports above from the cb function to the async function.
function get_fingerprint_cb(message, callback) {
    let fingerprint = {};
    try {
        get_fingerprint().then((result) => {
            fingerprint['fingerprint'] = result;
            return callback(null, fingerprint);
        });
    } catch(err) {
        log.error(`There was an error getting the fingerprint for this machine ${err}`);
        return callback(err, null);
    }
}

async function get_fingerprint() {
    try {
        check_permisison.checkPermission();
    } catch(err) {
        log.error(err);
        return 'You do not have permission to generate a fingerprint.';
    }

    let fingerprint = await hdb_license.generateFingerPrint();
    return fingerprint;
}

/**
 * This handler is called when registration is run from the command line.
 * @returns {Promise<*>}
 */
async function register() {
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
        return log.error(err);
    });

    if(!data.HDB_LICENSE || !data.CUSTOMER_COMPANY) {
        return console.error(`Invalid entries for License Key and Customer Company`);
    }
    console.log('Validating license input...');
    let validation = hdb_license.validateLicense(data.HDB_LICENSE, data.CUSTOMER_COMPANY).catch((err) => {
        log.error(err);
        return console.error(err);
    });
    console.log(`checking for valid license...`);
    if (!validation.valid_license) {
        return console.error('Invalid license found.');
    }
    console.log(`checking valid license date...`);
    if (!validation.valid_date) {
        return console.error('This License has expired.');

    }
    console.log(`checking for valid machine license ${validation.valid_machine}`);
    if (!validation.valid_machine) {
        return console.error('This license is in use on another machine.');
    }


    let insert_object = {
        operation: 'insert',
        schema: 'system',
        table: 'hdb_license',
        hash_attribute: 'license_key',
        records: [{"license_key": data.HDB_LICENSE, "company":data.CUSTOMER_COMPANY }]
    };

    p_insert_insert(insert_object).catch((err) => {
        return log.error(err);
    });

    return 'Successfully registered';
}