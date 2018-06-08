"use strict"
/**
 * Test the hdb_license module.
 */

const assert = require('assert');
const rewire = require('rewire');
const fs = require('fs');
const moment = require('moment');
const password = require('../../utility/password');

describe(`Test generateFingerPrint`, function () {
    it('Nominal, generate finger print with hash and write finger print file', function (done) {
        // rewire hdb_license instance locally to keep internal cipher const fresh from another test
        const hdb_license = rewire('../../utility/hdb_license');

        // delete finger print file if exist
        let finger_print_file = hdb_license.__get__('FINGER_PRINT_FILE');
        if (fs.existsSync(finger_print_file)) {            
            fs.unlinkSync(finger_print_file);
        }

        hdb_license.generateFingerPrint(function(error, hash) {   
            assert.equal(error, null, 'generate finger print without error');   
            assert.notEqual(hash, null, 'finger print should not be null');
            fs.readFile(finger_print_file, function (err, finger_print) {
                assert.equal(hash, finger_print, 'generated hash should equal to hash in finger print file');
                done();
            });
        });
    });
});

describe(`Test generateLicense`, function () {
    it('Nominal, generate license with valid license key and finger print file', function (done) {
        // rewire hdb_license instance locally to keep internal cipher const fresh from another test
        const hdb_license = rewire('../../utility/hdb_license');
        // prepare license key obj which expire tomorrow with dummy fingerprint (no fingerprint validation in generate license process)
        let licenseKeyObject = { exp_date: moment().add(1, 'day').format('YYYY-MM-DD'), company: 'hdb', fingerprint: 'whatever'};

        hdb_license.generateLicense(licenseKeyObject, function(error, license) {   
            assert.equal(error, null, 'generate license without error');   
            assert.notEqual(license, null, 'license should not be null');
            assert.ok(license.length > 0, 'license should have value');
            assert.ok(license.indexOf(hdb_license.__get__('LICENSE_KEY_DELIMITER')) > -1, 'license should contain license key delimiter');
            done();
        }); 
    });
    it('Pass expired license key, expect failed to generate license with proper error message', function (done) {
        // rewire hdb_license instance locally to keep internal cipher const fresh from another test
        const hdb_license = rewire('../../utility/hdb_license');
        // prepare license key obj which *expire today* with dummy fingerprint (no fingerprint validation in generate license process)
        let licenseKeyObject = { exp_date: moment().format('YYYY-MM-DD'), company: 'hdb', fingerprint: 'whatever'};

        hdb_license.generateLicense(licenseKeyObject, function(error, license) {   
            assert.notEqual(error, null, 'generate license should get error');
            assert.equal(error, "Error: Exp date must be no earlier than " + moment().format('YYYY-MM-DD'), 'error message should mention that license key is expired');                
            assert.equal(license, null, 'license value should be null');
            done();
        });
    });
    it('Pass null company, expect failed to generate license with proper error message', function (done) {     
        // rewire hdb_license instance locally to keep internal cipher const fresh from another test   
        let hdb_license = rewire('../../utility/hdb_license');
        // prepare license key obj which expire tomorrow with *blank company* and dummy fingerprint (no fingerprint validation in generate license process)
        let licenseKeyObject = { exp_date: moment().add(1, 'day').format('YYYY-MM-DD'), company: null, fingerprint: 'whatever'};

        hdb_license.generateLicense(licenseKeyObject, function(error, license) {  
            assert.notEqual(error, null, 'generate license should get error');            
            assert.equal(error, "Error: Company can't be blank", "error message should mention that company can't be blank");
            assert.equal(license, null, 'license value should be null');
            done();
        });
    });
    it('Pass null expire date, expect failed to generate license with proper error message', function (done) {
        // rewire hdb_license instance locally to keep internal cipher const fresh from another test
        let hdb_license = rewire('../../utility/hdb_license');
        // prepare license key obj which *expire date is blank* with dummy fingerprint (no fingerprint validation in generate license process)
        let licenseKeyObject = { exp_date: null, company: 'hdb', fingerprint: 'whatever'};

        hdb_license.generateLicense(licenseKeyObject, function(error, license) { 
            assert.notEqual(error, null, 'generate license should get error');            
            assert.equal(error, "Error: Exp date can't be blank", "error message should mention that expire date can't be blank");
            assert.equal(license, null, 'license value should be null');
            done();
        });
    });    
});
describe(`Test validateLicense`, function () {
    it('Nominal, validate valid license with pass', function (done) {
        // rewire hdb_license instance locally to keep internal cipher const fresh from another test
        const hdb_license = rewire('../../utility/hdb_license');

        let licenseKeyObject = { exp_date: moment().add(1, 'day').format('YYYY-MM-DD'), company: 'hdb'};

        hdb_license.generateFingerPrint(function(error, fingerprint) {             
            licenseKeyObject.fingerprint = fingerprint;
            hdb_license.generateLicense(licenseKeyObject, function(error, license) {   
                hdb_license.validateLicense(license, 'hdb', function(err, validation){
                    assert.equal(validation.valid_date, true, 'date validation should valid');
                    assert.equal(validation.valid_license, true, 'license validation should valid');
                    assert.equal(validation.valid_machine, true, 'machine validation should valid');
                    done();
                });                
            });
        });
    });
    it('Pass expired license, expect invalid date from validation', function (done) {
        // rewire hdb_license instance locally to keep internal cipher const fresh from another test
        const hdb_license = rewire('../../utility/hdb_license');

        let licenseKeyObject = { exp_date: moment().add(1, 'day').format('YYYY-MM-DD'), company: 'hdb'};

        hdb_license.generateFingerPrint(function(error, fingerprint) {             
            licenseKeyObject.fingerprint = fingerprint;
            hdb_license.generateLicense(licenseKeyObject, function(error, license) {
                // Mock moment to assume present time is tomorrow which generated license is expired
                let moment_tomorrow_mock = function () {
                    return moment().add(1, 'day');
                };
                hdb_license.__set__("moment", moment_tomorrow_mock);
                hdb_license.validateLicense(license, 'hdb', function(err, validation){
                    assert.equal(validation.valid_date, false, 'date validation should not valid');
                    assert.equal(validation.valid_license, true, 'license validation should valid');
                    assert.equal(validation.valid_machine, true, 'machine validation should valid');
                    done();
                });                
            });
        });
    });
    it('Pass invalid company, expect invalid license from validation', function (done) {
        // rewire hdb_license instance locally to keep internal cipher const fresh from another test
        const hdb_license = rewire('../../utility/hdb_license');

        let licenseKeyObject = { exp_date: moment().add(1, 'day').format('YYYY-MM-DD'), company: 'hdb'};

        hdb_license.generateFingerPrint(function(error, fingerprint) {             
            licenseKeyObject.fingerprint = fingerprint;
            hdb_license.generateLicense(licenseKeyObject, function(error, license) {                
                hdb_license.validateLicense(license, 'different_company', function(err, validation){
                    assert.equal(validation.valid_date, true, 'date validation should valid');
                    assert.equal(validation.valid_license, false, 'license validation should not valid');
                    assert.equal(validation.valid_machine, true, 'machine validation should valid');
                    done();
                });                
            });
        });
    });
    it('Pass invalid license, expect invalid license from validation', function (done) {
        // rewire hdb_license instance locally to keep internal cipher const fresh from another test
        const hdb_license = rewire('../../utility/hdb_license');

        let licenseKeyObject = { exp_date: moment().add(1, 'day').format('YYYY-MM-DD'), company: 'hdb'};

        hdb_license.generateFingerPrint(function(error, fingerprint) {             
            licenseKeyObject.fingerprint = fingerprint;
            hdb_license.generateLicense(licenseKeyObject, function(error, license) {
                // pass invalid license key to validate license
                hdb_license.validateLicense('wrong_license', 'hdb', function(err, validation){
                    assert.equal(validation.valid_date, true, 'date validation should valid');
                    assert.equal(validation.valid_license, false, 'license validation should not valid');
                    assert.equal(validation.valid_machine, true, 'machine validation should valid');
                    done();
                });
            });
        });
    });
    it('Finger print does not exist, expect invalid machine from validation', function (done) {
        // rewire hdb_license instance locally to keep internal cipher const fresh from another test
        const hdb_license = rewire('../../utility/hdb_license');

        let licenseKeyObject = { exp_date: moment().add(1, 'day').format('YYYY-MM-DD'), company: 'hdb'};

        hdb_license.generateFingerPrint(function(error, fingerprint) {             
            licenseKeyObject.fingerprint = fingerprint;
            hdb_license.generateLicense(licenseKeyObject, function(error, license) {   

                // delete finger print file from machine to assume wrong machine
                let finger_print_file = hdb_license.__get__('FINGER_PRINT_FILE');
                if (fs.existsSync(finger_print_file)) {
                    // delete finger print file if exist
                    fs.unlinkSync(finger_print_file);
                }

                hdb_license.validateLicense(license, 'hdb', function(err, validation){
                    assert.equal(validation.valid_date, true, 'date validation should valid');
                    assert.equal(validation.valid_license, false, 'license validation should not valid');
                    assert.equal(validation.valid_machine, false, 'machine validation should not valid');
                    done();
                });                
            });
        });
    });
});