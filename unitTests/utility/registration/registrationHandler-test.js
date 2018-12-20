"use strict"
/**
 * Test the registrationHandler module.
 */

const assert = require('assert');
const rewire = require('rewire');
const fs = require('fs-extra');
const moment = require('moment');
const sinon = require('sinon');
const test_utils = require('../../test_utils');
test_utils.preTestPrep();
const reg = rewire('../../../utility/registration/registrationHandler');
const hdb_license = require('../../../utility/registration/hdb_license');

const parse_orig = reg.__get__('parseLicense');

const VALIDATE_SUCCESS = {
    "valid_date": true,
    "valid_license": true,
    "valid_machine": true
};

describe(`Test setLicense`, function () {
    let write_stub = undefined;
    let validate_stub = undefined;
    let sandbox = null;
    let err = undefined;
    let setLicense = reg.__get__('setLicense');

    beforeEach(() => {
        sandbox = sinon.createSandbox();
    });
    afterEach(() => {
        sandbox.restore();
        reg.__set__('parseLicense', parse_orig);
    });
    it('Nominal, set license key stub write file', async function () {
        write_stub = sandbox.stub(fs, 'writeFile').resolves('');
        validate_stub = sandbox.stub().resolves(VALIDATE_SUCCESS);
        reg.__set__('parseLicense', validate_stub);
        let result = undefined;
        try {
            result = await setLicense({'key': 'e35130571358cd0c79090a782ab44618mofi25nutnRafDD78a36126f0cb549d8fb72e880ef2459d', 'company': 'harperdb.io'});
        } catch (e) {
            err = e;
        }
        assert.equal(err, undefined, `expected no exceptions ${err}`);
        assert.equal(result, 'Wrote license key file.  Registration successful.', 'expected success message');
    });
    it('Set license key, invalid license', async function () {
        write_stub = sandbox.stub(fs, 'writeFile').throws(new Error('BAD WRITE'));
        let copy = test_utils.deepClone(VALIDATE_SUCCESS);
        copy.valid_license = false;
        validate_stub = sandbox.stub(hdb_license, 'validateLicense').resolves(copy);
        let result = undefined;
        try {
            result = await setLicense({'key': 'blahblah', 'company': 'harperdb.io'});
        } catch (e) {
            err = e;
        }
        assert.notEqual(err, undefined, 'expected exception');
        assert.equal(err.message.indexOf('There was an error parsing the license key.') > -1, true, 'expected error message');
    });
    it('Set license key invalid json message', async function () {
        write_stub = sandbox.stub(fs, 'writeFile').throws(new Error('BAD WRITE'));
        let result = undefined;
        try {
            result = await setLicense(null);
        } catch (e) {
            err = e;
        }
        assert.notEqual(err, undefined, 'expected exceptions');
        assert.equal(err.message, 'Invalid key specified for license file.', 'expected error message');
    });
    it('Set license key invalid key in json message', async function () {
        write_stub = sandbox.stub(fs, 'writeFile').throws(new Error('BAD WRITE'));
        let result = undefined;
        try {
            result = await setLicense({'key':null, 'company': 'harperdb.io'});
        } catch (e) {
            err = e;
        }
        assert.notEqual(err, undefined, 'expected exceptions');
        assert.equal(err.message, 'Invalid key specified for license file.', 'expected error message');
    });
});

describe(`Test getFingerprint`, function () {
    let generate_stub = undefined;
    let sandbox = null;
    let err = undefined;
    let getFingerprint = reg.__get__('getFingerprint');

    beforeEach(() => {
        sandbox = sinon.createSandbox();
    });
    afterEach(() => {
        sandbox.restore();
    });
    it('Nominal, set license key stub write file', async function () {
        generate_stub = sandbox.stub(hdb_license, 'generateFingerPrint').resolves('blahhash');
        let result = undefined;
        try {
            result = await getFingerprint();
        } catch (e) {
            err = e;
        }
        assert.equal(err, undefined, 'expected no exceptions');
        assert.equal(result, 'blahhash', 'expected success message');
    });
    it('Set license key stub write file, write throws exception', async function () {
        generate_stub = sandbox.stub(hdb_license, 'generateFingerPrint').throws(new Error('There was an error generating the fingerprint'));
        let result = undefined;
        try {
            result = await getFingerprint();
        } catch (e) {
            err = e;
        }
        assert.equal(err.message,'Error generating fingerprint.', 'expected error message');
    });

});