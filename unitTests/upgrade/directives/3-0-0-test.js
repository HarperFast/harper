"use strict";

const chai = require('chai');
const sinon = require('sinon');
const { expect } = chai;

const PropertiesReader = require('properties-reader');
const env = require('../../../utility/environment/environmentManager');
const test_util = require('../../../unitTests/test_utils');
const { buildFile, deleteFile } = require('../../settingsTestFile');

const SETTINGS_BAK_FILE_NAME = '3_0_0_upgrade_settings.bak';
const { HDB_SETTINGS_NAMES } = require('../../../utility/hdbTerms');
const { SERVER_PORT_KEY, HTTP_SECURE_ENABLED_KEY } = HDB_SETTINGS_NAMES;
const PREV_PORT_VALS = {
    HTTP_PORT: 12345,
    HTTPS_PORT: 31283
}

let directive3_0_0;

function generateSettingsVals(HTTP_ON = true, HTTPS_ON = false) {
    return {
        HTTP_ON,
        HTTPS_ON
    }
}

let updateSettingsFile_3_0_0;
function setupTest(HTTP_ON, HTTPS_ON) {
    buildFile(generateSettingsVals(HTTP_ON, HTTPS_ON))
}

function getNewEnvVals() {
    const hdb_properties = PropertiesReader(env.getProperty(HDB_SETTINGS_NAMES.SETTINGS_PATH_KEY));
    return {
        [SERVER_PORT_KEY]: hdb_properties.get(SERVER_PORT_KEY),
        [HTTP_SECURE_ENABLED_KEY]: hdb_properties.get(HTTP_SECURE_ENABLED_KEY)
    }
}

describe('3.0.0 Upgrade Directive', () => {
    let sandbox;

    before(() => {
        test_util.preTestPrep();
        directive3_0_0 = require('../../../upgrade/directives/3-0-0')[0];
        sandbox = sinon.createSandbox();
    });

    after(function () {
        sandbox.restore();
    });

    it('Test directive class object values are present', () => {
        expect(directive3_0_0.change_description).to.eql("Placeholder for change descriptions for 3.0.0");
    });

    describe('updateSettingsFile_3_0_0()', function() {
        before(() => {
            updateSettingsFile_3_0_0 = directive3_0_0.settings_file_function[0];
        })

        afterEach(() => {
            try {
                deleteFile(SETTINGS_BAK_FILE_NAME);
            } catch(e) {
                console.log(e)
            }
        })

        it('Test settings update w/ only HTTP enabled', () => {
            setupTest(true, false)
            const result = updateSettingsFile_3_0_0()

            const {SERVER_PORT, HTTPS_ON} = getNewEnvVals();
            expect(SERVER_PORT).to.equal(PREV_PORT_VALS.HTTP_PORT);
            expect(HTTPS_ON).to.be.false;
            expect(result).to.equal('New settings file for 3.0.0 upgrade successfully created.')
        });

        it('Test settings update w/ only HTTP and HTTPS enabled', () => {
            setupTest(true, true)
            const result = updateSettingsFile_3_0_0()

            const {SERVER_PORT, HTTPS_ON} = getNewEnvVals();
            expect(SERVER_PORT).to.equal(PREV_PORT_VALS.HTTPS_PORT);
            expect(HTTPS_ON).to.be.true;
            expect(result).to.equal('New settings file for 3.0.0 upgrade successfully created.')
        });

        it('Test settings update w/ only HTTPS enabled', () => {
            setupTest(false, true)
            const result = updateSettingsFile_3_0_0()

            const {SERVER_PORT, HTTPS_ON} = getNewEnvVals();
            expect(SERVER_PORT).to.equal(PREV_PORT_VALS.HTTPS_PORT);
            expect(HTTPS_ON).to.be.true;
            expect(result).to.equal('New settings file for 3.0.0 upgrade successfully created.')
        });
    });
})


