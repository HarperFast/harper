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
licenseKeyObject.fingerprint = 'y2h76kHqNc1222acdbcb40e827c07483c434924ff';
licenseKeyObject.exp_date = '2017-07-11';
licenseKeyObject.company = 'hdb';
hdb_license.generateLicense(licenseKeyObject, function(err, license){
    console.log(JSON.stringify(license))
    winston.error(err);
    hdb_license.validateLicense(license, 'HarperDB', function(data){
        console.log(JSON.stringify(data));

    });

});





