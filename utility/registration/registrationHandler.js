const hdb_license = require('./hdb_license');
const colors = require("colors/safe");
const logger = require('../logging/harper_logger');
const check_permisison = require('../check_permissions');
const prompt = require('prompt');
const {promisify} = require('util');
let insert = require('../../data_layer/insert');

//Promisified function
let p_insert_insert = promisify(insert.insert);

module.exports = {
    register: register
};

async function register(prompt) {
    try {
        check_permisison.checkPermission();
    } catch(err) {
        return console.error(err.message);
    }

    let fingerprint = await hdb_license.generateFingerPrint();
    let register_schema = {
        properties: {
            CUSTOMER_COMPANY: {
                description: colors.magenta(`[COMPANY] Please enter your company name:`),
                required: true

            },
            HDB_LICENSE: {
                description: colors.magenta(`[HDB_LICENSE] Your fingerprint is ${fingerprint} Please enter your license key:`),
                required: true

            }
        }
    };

    if(!prompt) {
        prompt.start();
    }
    prompt.get(register_schema, async function (err, data) {
        if(!data.HDB_LICENSE || !data.CUSTOMER_COMPANY) {
            logger.error(err);
            return console.error(err);
        }
        let validation = await hdb_license.validateLicense(data.HDB_LICENSE, data.CUSTOMER_COMPANY).catch((err) => {
            logger.error(err);
            throw err;
        });

        if (!validation.valid_license) {
            return 'Invalid license!';
        }

        if (!validation.valid_date) {
            return 'License expired!';

        }

        if (!validation.valid_machine) {
            return 'This license is in use on another machine!';
        }


        let insert_object = {
            operation: 'insert',
            schema: 'system',
            table: 'hdb_license',
            hash_attribute: 'license_key',
            records: [{"license_key": data.HDB_LICENSE, "company":data.CUSTOMER_COMPANY }]
        };

        p_insert_insert(insert_object).catch((err) => {
            return logger.error(err);
        });

        return 'Successfully registered';
    });
}