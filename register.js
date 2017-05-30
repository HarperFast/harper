const hdb_license = require('./utility/hdb_license'),
    colors = require("colors/safe"),
    prompt = require('prompt');

module.exports ={
    register: register

}

function register(company, callback) {


    hdb_license.generateFingerPrint(function (err, fingerprint) {
        var register_schema = {
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
        }




        console.log(fingerprint);
        prompt.start();
        prompt.get(register_schema, function (err, data) {



            hdb_license.validateLicense(data.HDB_LICENSE, data.CUSTOMER_COMPANY, function (err, validation) {
                if (!validation.valid_license) {
                    callback('Invalid license!');
                    return;
                }

                if (!validation.valid_date) {
                    callback('License expired!');
                    return;
                }


                if (!validation.valid_machine) {
                    callback('This license is in use on another machine!');
                    return;
                }

                let insert = require('./data_layer/insert');
                var insert_object = {
                    operation: 'insert',
                    schema: 'system',
                    table: 'hdb_license',
                    hash_attribute: 'license',
                    records: [{"license_key": lk}]
                };
                insert(insert_object, function (err, data) {
                    console.log(err);
                    console.log(data);
                    callback(null, 'Successfully registered');
                });


            });
        });

    });
}