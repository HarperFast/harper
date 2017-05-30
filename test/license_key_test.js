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
licenseKeyObject.fingerprint = 'FuwY2GEC0929ea1bf366794b95955a0f913196b19';
licenseKeyObject.exp_date = '2017-07-11';
licenseKeyObject.company = 'HarperDB';
hdb_license.generateLicense(licenseKeyObject, function(err, license){
    console.log(JSON.stringify(license))
    console.error(err);
    hdb_license.validateLicense(license, 'HarperDB, Inc.', function(data){
        console.log(JSON.stringify(data));

    });

});





