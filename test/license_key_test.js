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
licenseKeyObject.fingerprint = 'i3LwoA8D1240be6c1e23dce18d8eb4ef84a35cd53';
licenseKeyObject.exp_date = '2017-07-11';
licenseKeyObject.company = 'hdb';
hdb_license.generateLicense(licenseKeyObject, function(err, license){
    console.log(JSON.stringify(license))
    console.error(err);
    hdb_license.validateLicense(license, 'HarperDB', function(data){
        console.log(JSON.stringify(data));

    });

});





