const hdb_license = require('../utility/hdb_license');

/**
hdb_license.generateFingerPrint(function(err, fingerprint){
    if(err)
        console.error(err);
    var licenseKeyObject = {};
    licenseKeyObject.fingerprint = fingerprint;
    licenseKeyObject.exp_date = '2017-07-11';
    licenseKeyObject.company = 'HarperDB, Inc';

    hdb_license.generateLicense(licenseKeyObject, function(err, license){

        hdb_license.validateLicense(license, 'HarperDB, Inc.', function(data){
            console.log(JSON.stringify(data));

        });

    });





});**/



var licenseKeyObject = {};
licenseKeyObject.fingerprint = 'SkP74dSz99ff95e7e4ac72f4580fbda6339f2d8b3';
licenseKeyObject.exp_date = '2017-07-11';
licenseKeyObject.company = 'HarperDB';
hdb_license.generateLicense(licenseKeyObject, function(err, license){
    console.log(JSON.stringify(license))
    console.error(err);
    hdb_license.validateLicense(license, 'HarperDB', function(data){
        console.log(JSON.stringify(data));

    });

});





