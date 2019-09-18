"use strict";

const rewire = require('rewire');

const ExtendedLicense = require('../../../utility/registration/licenseObjects').ExtendedLicense;
const BaseLicense = require('../../../utility/registration/licenseObjects').BaseLicense;
const moment = require('moment');
const terms = require('../../../utility/hdbTerms');
const assert = require('assert');


describe('Test LicenseManager', ()=>{
    it('test with good object set in process.env', ()=>{
        let time = moment().add(1, 'year').utc().unix();
        let license = new ExtendedLicense(time, terms.STORAGE_TYPES_ENUM.HELIUM, 30000, terms.LICENSE_VALUES.VERSION_DEFAULT, true);
        process.env[terms.HDB_LICENSE_NAME] = JSON.stringify(license);
        const LicenseManager = rewire('../../../utility/environment/LicenseManager');
        assert.deepEqual(LicenseManager.license, license);
    });

    it('test with non-json set in process.env', ()=>{
        process.env[terms.HDB_LICENSE_NAME] = 'blerg';
        const LicenseManager = rewire('../../../utility/environment/LicenseManager');
        assert.deepEqual(LicenseManager.license, new ExtendedLicense());
    });

    it('test with nothing in process.env', ()=>{
        delete process.env[terms.HDB_LICENSE_NAME];
        const LicenseManager = rewire('../../../utility/environment/LicenseManager');
        assert.deepEqual(LicenseManager.license, new ExtendedLicense());
    });
});