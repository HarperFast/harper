"use strict";

const license = require('../registration/hdb_license');
const reg_handler = require('../registration/registrationHandler');
const global_schema = require('../globalSchema');
const env = require('../environment/environmentManager');
env.initSync();
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
        storage_type: 'helium',
        api_call: 90000,
        version: '2.0.0',
        exp_date: '2020-12-31'
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
