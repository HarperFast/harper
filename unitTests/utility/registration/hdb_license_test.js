"use strict"
/**
 * Test the hdb_license module.
 */

const assert = require('assert');
const rewire = require('rewire');
const fs = require('fs-extra');
const moment = require('moment');
const test_utils = require('../../test_utils');
test_utils.preTestPrep();

describe(`Test generateFingerPrint`, function () {
    it('Nominal, generate finger print with hash and write finger print file', async function () {
        // rewire hdb_license instance locally to keep internal cipher const fresh from another test
        const hdb_license = rewire('../../../utility/registration/hdb_license');

        // delete finger print file if exist
        let finger_print_file = hdb_license.__get__('FINGER_PRINT_FILE');
        if (fs.existsSync(finger_print_file)) {            
            fs.unlinkSync(finger_print_file);
        }

        let err = null;
        let hash = await hdb_license.generateFingerPrint().catch((e) => {
            err = e;
        });
        assert.equal(err, null, 'generate finger print without error');
        assert.notEqual(hash, null, 'finger print should not be null');
        let finger_print = await fs.readFile(finger_print_file, 'utf8').catch((err) => {
            throw err;
        });
        assert.equal(hash, finger_print, 'generated hash should equal to hash in finger print file');
    });
});

describe(`Test generateLicense`, function () {
    it('Nominal, generate license with valid license key and finger print file', function () {
        // rewire hdb_license instance locally to keep internal cipher const fresh from another test
        const hdb_license = rewire('../../../utility/registration/hdb_license');
        // prepare license key obj which expire tomorrow with dummy fingerprint (no fingerprint validation in generate license process)
        let licenseKeyObject = {
            exp_date: moment().add(1, 'day').format('YYYY-MM-DD'),
            company: 'hdb',
            fingerprint: 'whatever',
            storage_type: 'helium',
            api_call: 90000,
            version: '2.0.0'};

        let err = null;
        let license = undefined;
        try {
            license = hdb_license.generateLicense(licenseKeyObject);
        } catch(e) {
            err = e;
        }
        assert.equal(err, null, 'generate license without error');
        assert.notEqual(license, null, 'license should not be null');
        assert.ok(license.length > 0, 'license should have value');
        assert.ok(license.indexOf(hdb_license.__get__('LICENSE_KEY_DELIMITER')) > -1, 'license should contain license key delimiter');
    });
    it('Pass expired license key, expect failed to generate license with proper error message', function () {
        // rewire hdb_license instance locally to keep internal cipher const fresh from another test
        const hdb_license = rewire('../../../utility/registration/hdb_license');
        // prepare license key obj which *expire today* with dummy fingerprint (no fingerprint validation in generate license process)
        let licenseKeyObject = { exp_date: moment().format('YYYY-MM-DD'), company: 'hdb', fingerprint: 'whatever',
            storage_type: 'helium',
            api_call: 90000,
            version: '2.0.0'};

        let err = null;
        let license = undefined;
        try {
            license = hdb_license.generateLicense(licenseKeyObject);
        } catch(e) {
            err = e;
        }

        assert.notEqual(err, null, 'generate license should get error');
        assert.equal(err, "Error: Exp date must be no earlier than " + moment().format('YYYY-MM-DD'), 'error message should mention that license key is expired');
        assert.equal(license, null, 'license value should be null');
    });
    it('Pass null company, expect failed to generate license with proper error message', function () {
        // rewire hdb_license instance locally to keep internal cipher const fresh from another test   
        let hdb_license = rewire('../../../utility/registration/hdb_license');
        // prepare license key obj which expire tomorrow with *blank company* and dummy fingerprint (no fingerprint validation in generate license process)
        let licenseKeyObject = { exp_date: moment().add(1, 'day').format('YYYY-MM-DD'), company: null, fingerprint: 'whatever',
            storage_type: 'helium',
            api_call: 90000,
            version: '2.0.0'};

        let err = null;
        let license = undefined;
        try {
            license = hdb_license.generateLicense(licenseKeyObject);
        } catch(e) {
            err = e;
        }

        assert.notEqual(err, null, 'generate license should get error');
        assert.equal(err, "Error: Company can't be blank", "error message should mention that company can't be blank");
        assert.equal(license, null, 'license value should be null');
    });
    it('Pass null expire date, expect failed to generate license with proper error message', function () {
        // rewire hdb_license instance locally to keep internal cipher const fresh from another test
        let hdb_license = rewire('../../../utility/registration/hdb_license');
        // prepare license key obj which *expire date is blank* with dummy fingerprint (no fingerprint validation in generate license process)
        let licenseKeyObject = { exp_date: null, company: 'hdb', fingerprint: 'whatever',
            storage_type: 'helium',
            api_call: 90000,
            version: '2.0.0'};

        let err = null;
        let license = undefined;
        try {
            license = hdb_license.generateLicense(licenseKeyObject);
        } catch(e) {
            err = e;
        }

        assert.notEqual(err, null, 'generate license should get error');
        assert.equal(err, "Error: Exp date can't be blank", "error message should mention that expire date can't be blank");
        assert.equal(license, null, 'license value should be null');
    });    
});

describe(`Test validateLicense`, function () {
    it('Nominal, validate valid license with pass', async function ( ) {
        // rewire hdb_license instance locally to keep internal cipher const fresh from another test
        const hdb_license = rewire('../../../utility/registration/hdb_license');

        let licenseKeyObject = { exp_date: moment().add(1, 'day').format('YYYY-MM-DD'), company: 'hdb',
            storage_type: 'helium',
            api_call: 90000,
            version: '2.0.0'};

        let err = null;
        let fingerprint = await hdb_license.generateFingerPrint().catch((e) => {
            err = e;
        }) ;
        licenseKeyObject.fingerprint = fingerprint;
        let license = hdb_license.generateLicense(licenseKeyObject);
        let validation = await hdb_license.validateLicense(license, 'hdb').catch((e) => {
            throw e;
        });
        assert.equal(validation.valid_date, true, 'date validation should be valid');
        assert.equal(validation.valid_license, true, 'license validation should be valid');
        assert.equal(validation.valid_machine, true, 'machine validation should be valid');
    });
    it('Pass expired license, expect invalid date from validation', async function () {
        // rewire hdb_license instance locally to keep internal cipher const fresh from another test
        const hdb_license = rewire('../../../utility/registration/hdb_license');

        let licenseKeyObject = { exp_date: moment().add(1, 'day').format('YYYY-MM-DD'), company: 'hdb',
            storage_type: 'helium',
            api_call: 90000,
            version: '2.0.0'};

        let err = null;
        let fingerprint = await hdb_license.generateFingerPrint().catch((e) => {
            err = e;
        }) ;
        licenseKeyObject.fingerprint = fingerprint;
        let license = hdb_license.generateLicense(licenseKeyObject);
        let moment_tomorrow_mock = function () {
            return moment().add(1, 'day');
        };
        hdb_license.__set__("moment", moment_tomorrow_mock);
        let validation = await hdb_license.validateLicense(license, 'hdb').catch((e) => {
            throw e;
        });
        assert.equal(validation.valid_date, false, 'date validation should not be valid');
        assert.equal(validation.valid_license, true, 'license validation should be valid');
        assert.equal(validation.valid_machine, true, 'machine validation should be valid');
    });
    it('Pass invalid company, expect invalid license from validation', async function () {
        // rewire hdb_license instance locally to keep internal cipher const fresh from another test
        const hdb_license = rewire('../../../utility/registration/hdb_license');

        let licenseKeyObject = { exp_date: moment().add(1, 'day').format('YYYY-MM-DD'), company: 'hdb',
            storage_type: 'helium',
            api_call: 90000,
            version: '2.0.0'};

        let err = null;
        let fingerprint = await hdb_license.generateFingerPrint().catch((e) => {
            err = e;
        }) ;
        licenseKeyObject.fingerprint = fingerprint;
        let license = hdb_license.generateLicense(licenseKeyObject);
        let validation = await hdb_license.validateLicense(license, 'some_co').catch((e) => {
            throw e;
        });
        assert.equal(validation.valid_date, true, 'date validation should be valid');
        assert.equal(validation.valid_license, false, 'license validation should not be valid');
        assert.equal(validation.valid_machine, true, 'machine validation should be valid');
    });
    it('Pass invalid license, expect invalid license from validation', async function () {
        // rewire hdb_license instance locally to keep internal cipher const fresh from another test
        const hdb_license = rewire('../../../utility/registration/hdb_license');

        let licenseKeyObject = { exp_date: moment().add(1, 'day').format('YYYY-MM-DD'), company: 'hdb',
            storage_type: 'helium',
            api_call: 90000,
            version: '2.0.0'};

        let err = null;
        let fingerprint = await hdb_license.generateFingerPrint().catch((e) => {
            err = e;
        }) ;
        licenseKeyObject.fingerprint = fingerprint;
        let license = hdb_license.generateLicense(licenseKeyObject);
        let validation = await hdb_license.validateLicense('wrong_license', 'hdb').catch((e) => {
            err = e;
        });

        assert.equal(err.message, 'invalid license key format');
    });

    it('Finger print does not exist, expect invalid machine from validation', async function () {
        // rewire hdb_license instance locally to keep internal cipher const fresh from another test
        const hdb_license = rewire('../../../utility/registration/hdb_license');

        let licenseKeyObject = { exp_date: moment().add(1, 'day').format('YYYY-MM-DD'), company: 'hdb',
            storage_type: 'helium',
            api_call: 90000,
            version: '2.0.0'};

        let err = null;
        let fingerprint = await hdb_license.generateFingerPrint().catch((e) => {
            err = e;
        }) ;
        licenseKeyObject.fingerprint = fingerprint;
        let license = hdb_license.generateLicense(licenseKeyObject);
        let finger_print_file = hdb_license.__get__('FINGER_PRINT_FILE');
        if (fs.existsSync(finger_print_file)) {
            // delete finger print file if exist
            fs.unlinkSync(finger_print_file);
        }
        let validation = await hdb_license.validateLicense(license, 'hdb').catch((e) => {
            throw e;
        });
        assert.equal(validation.valid_date, true, 'date validation should valid');
        assert.equal(validation.valid_license, false, 'license validation should not valid');
        assert.equal(validation.valid_machine, false, 'machine validation should not valid');
    });
});