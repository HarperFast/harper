"use strict";
/**
 * this is simply meant to allow a developer to create their own license file & gets stripped out on release
 * @type {{validateLicense, generateFingerPrint, generateLicense}|*}
 */

const license = require('../registration/hdb_license');
const reg_handler = require('../registration/registrationHandler');
const global_schema = require('../globalSchema');
const env = require('../environment/environmentManager');
const moment = require('moment');
if(!env.isInitialized()) {
    env.initSync();
}
const terms = require('../hdbTerms');
const promisify = require('util').promisify;
const p_schema_to_global = promisify(global_schema.setSchemaDataToGlobal);


async function register(){
    console.log('setting global schema');
    await p_schema_to_global();
    console.log('creating fingerprint');
    let fingerprint = await license.generateFingerPrint();
    let license_object = {
        company: 'harperdb.io',
        fingerprint: fingerprint,
        storage_type: terms.STORAGE_TYPES_ENUM.HELIUM,
        api_call: terms.LICENSE_VALUES.API_CALL_DEFAULT,
        version: terms.LICENSE_VALUES.VERSION_DEFAULT,
        exp_date: moment().add(1, 'year').format('YYYY-MM-DD')
    };
    console.log('generating license');
    let generated_license = license.generateLicense(license_object);
    console.log('validating & writing license to hdb');
    await reg_handler.parseLicense(generated_license, 'harperdb.io');
    console.log('success!');
}

register().then().catch(e=>{
    console.error(e);
});
