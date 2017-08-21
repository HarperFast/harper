



module.exports ={
    register: register

}




function register(prompt, callback) {
    const hdb_license = require('./hdb_license'),
        colors = require("colors/safe"),
        winston = require('../utility/logging/winston_logger');
    let PropertiesReader = require('properties-reader'),
    hdb_boot_properties =  PropertiesReader(`${process.cwd()}/../hdb_boot_properties.file`),
   hdb_properties = PropertiesReader(hdb_boot_properties.get('settings_path'));

    if (require("os").userInfo().username != hdb_boot_properties.get('install_user')) {
        if(callback)
            callback(`Must run as ${hdb_boot_properties.get('install_user')}`)
        return console.error(`Must register as ${hdb_boot_properties.get('install_user')}`);

    }


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



        if(!prompt){
            prompt = require('prompt');
            prompt.start();
        }

        prompt.get(register_schema, function (err, data) {


            if(data.HDB_LICENSE && data.CUSTOMER_COMPANY) {
                hdb_license.validateLicense(data.HDB_LICENSE, data.CUSTOMER_COMPANY, function (err, validation) {
                    if (err) {
                        winston.error(err);
                        callback(err);
                        return;
                    }

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

                    let insert = require('../data_layer/insert');
                    var insert_object = {
                        operation: 'insert',
                        schema: 'system',
                        table: 'hdb_license',
                        hash_attribute: 'license_key',
                        records: [{"license_key": data.HDB_LICENSE}]
                    };

                    insert.insert(insert_object, function (err, data) {
                        if (err) {
                            winston.error(err);
                            return;
                        }

                        callback(null, 'Successfully registered');
                    });


                });
            }
        });

    });
}