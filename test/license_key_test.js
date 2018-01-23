const hdb_license = require('../utility/hdb_license'),
    winston = require('../utility/logging/winston_logger');

/**
hdb_license.generateFingerPrint(function(err, fingerprint){
    if(err)
        winston.error(err);
    var licenseKeyObject = {};
    licenseKeyObject.fingerprint = fingerprint;
    licenseKeyObject.exp_date = '2017-07-11';
    licenseKeyObject.company = 'HarperDB, Inc';

    hdb_license.generateLicense(licenseKeyObject, function(err, license){

        hdb_license.validateLicense(license, 'HarperDB, Inc.', function(data){
            winston.info(JSON.stringify(data));

        });

    });





});**/



var licenseKeyObject = {};
licenseKeyObject.exp_date = '2018-07-30';
licenseKeyObject.company = 'hdb';
hdb_license.generateFingerPrint(function(err, fingerprint){
   if(err){return console.error(err)}
    licenseKeyObject.fingerprint = fingerprint;
    hdb_license.generateLicense(licenseKeyObject, function(err, license){
        console.log(JSON.stringify(license))
        winston.error(err);
        hdb_license.validateLicense(license, 'hdb', function(err, validation){
            console.log(JSON.stringify(validation));

        });

    });


});






