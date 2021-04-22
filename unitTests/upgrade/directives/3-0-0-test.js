"use strict";

const chai = require('chai');
const sinon = require('sinon');
const { expect } = chai;
const test_util = require('../../../unitTests/test_utils');
const { buildFile, deleteFile, getSettingsFilePath } = require('../../settingsTestFile');

const fs = require('fs-extra');
const path = require('path');
const hdb_logger = require('../../../utility/logging/harper_logger');
const colors = require('colors/safe');
const PropertiesReader = require('properties-reader');
const env = require('../../../utility/environment/environmentManager');

const SETTINGS_PATH = getSettingsFilePath();
const SETTINGS_DIR_PATH = path.dirname(SETTINGS_PATH);
const SETTINGS_BAK_FILE_NAME = '3_0_0_upgrade_settings.bak';
const SETTINGS_BAK_PATH = `${SETTINGS_DIR_PATH}/${SETTINGS_BAK_FILE_NAME}`;

const { HDB_SETTINGS_NAMES } = require('../../../utility/hdbTerms');
const { SERVER_PORT_KEY, HTTP_SECURE_ENABLED_KEY } = HDB_SETTINGS_NAMES;
const PREV_PORT_VALS = {
    HTTP_PORT: 12345,
    HTTPS_PORT: 31283
}

let directive3_0_0;

function generateSettingsVals(HTTP_ON = true, HTTPS_ON = false, SERVER_PORT = null) {
    return {
        HTTP_ON,
        HTTPS_ON,
        SERVER_PORT
    }
}

let sandbox;
let updateSettingsFile_3_0_0;
function setupTest(HTTP_ON, HTTPS_ON, SERVER_PORT, SERVER_HEADERS_TIMEOUT) {
    buildFile(generateSettingsVals(HTTP_ON, HTTPS_ON, SERVER_PORT, SERVER_HEADERS_TIMEOUT))
    sandbox.resetHistory();
}

function getNewEnvVals() {
    const hdb_properties = PropertiesReader(env.getProperty(HDB_SETTINGS_NAMES.SETTINGS_PATH_KEY));
    return {
        [SERVER_PORT_KEY]: hdb_properties.get(SERVER_PORT_KEY),
        [HTTP_SECURE_ENABLED_KEY]: hdb_properties.get(HTTP_SECURE_ENABLED_KEY)
    }
}

describe('3.0.0 Upgrade Directive', () => {
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
        let consoleLog_spy;
        let consoleError_spy;
        let logInfo_stub;
        let fsWriteFileSync_spy;
        let fsCopySync_spy;
        let fsUnlinkSync_spy;
        const TEST_ERROR = new Error("This. Is. An. Error");

        before(() => {
            updateSettingsFile_3_0_0 = directive3_0_0.sync_functions[0];
            consoleLog_spy = sandbox.spy(console, 'log');
            consoleError_spy = sandbox.spy(console, 'error');
            logInfo_stub = sandbox.stub(hdb_logger, 'info').returns();
            fsWriteFileSync_spy = sandbox.spy(fs, 'writeFileSync');
            fsCopySync_spy = sandbox.spy(fs, 'copySync');
            fsUnlinkSync_spy = sandbox.spy(fs, 'unlinkSync');
        })

        afterEach(() => {
            deleteFile(SETTINGS_BAK_FILE_NAME);
            sandbox.resetHistory();
        })

        it('Test settings update w/ only HTTP enabled',() => {
            setupTest(true, false);
            const result = updateSettingsFile_3_0_0();

            const {SERVER_PORT, HTTPS_ON} = getNewEnvVals();
            expect(SERVER_PORT).to.equal(PREV_PORT_VALS.HTTP_PORT);
            expect(HTTPS_ON).to.be.false;
            expect(result).to.equal('New settings file for 3.0.0 upgrade successfully created.')
        });

        it('Test settings update console/log info',() => {
            setupTest(true, false);
            updateSettingsFile_3_0_0();

            const expected_start_msg = 'Updating settings file for version 3.0.0';
            expect(consoleLog_spy.args[0][0]).to.equal(expected_start_msg);
            expect(logInfo_stub.args[0][0]).to.equal(expected_start_msg);
            const expected_end_msg = 'New settings file for 3.0.0 upgrade successfully created.';
            expect(consoleLog_spy.args[2][0]).to.equal(expected_end_msg);
            expect(logInfo_stub.args[5][0]).to.equal(expected_end_msg);
        });

        it('Test settings update w/ only HTTP and HTTPS enabled',() => {
            setupTest(true, true);
            const result = updateSettingsFile_3_0_0();

            const {SERVER_PORT, HTTPS_ON} = getNewEnvVals();
            expect(SERVER_PORT).to.equal(PREV_PORT_VALS.HTTPS_PORT);
            expect(HTTPS_ON).to.be.true;
            expect(result).to.equal('New settings file for 3.0.0 upgrade successfully created.')
        });

        it('Test settings update w/ only HTTPS enabled',() => {
            setupTest(false, true);
            const result = updateSettingsFile_3_0_0();

            const {SERVER_PORT, HTTPS_ON} = getNewEnvVals();
            expect(SERVER_PORT).to.equal(PREV_PORT_VALS.HTTPS_PORT);
            expect(HTTPS_ON).to.be.true;
            expect(result).to.equal('New settings file for 3.0.0 upgrade successfully created.')
        });

        it('Test settings update w/ mixed upper/lower case settings values - only HTTPS enabled',() => {
            setupTest('FALSe', 'TRue');
            const result = updateSettingsFile_3_0_0();

            const {SERVER_PORT, HTTPS_ON} = getNewEnvVals();
            expect(SERVER_PORT).to.equal(PREV_PORT_VALS.HTTPS_PORT);
            expect(HTTPS_ON).to.be.true;
            expect(result).to.equal('New settings file for 3.0.0 upgrade successfully created.')
        });

        it('Test settings w/ both HTTP/S enabled - console message should be logged for user',() => {
            setupTest(true, true)
            updateSettingsFile_3_0_0();

            expect(consoleLog_spy.args[1][0]).to.equal(colors.magenta("HarperDB 3.0.0 does not allow HTTP and HTTPS to be enabled at the same time. This upgrade has enabled " +
                "HTTPS and disabled HTTP. You can modify this in config/settings.js."))
        });

        it('Test backup settings file is written',() => {
            setupTest()
            updateSettingsFile_3_0_0();

            expect(logInfo_stub.args[1][0]).to.equal(`Backing up old settings file to: ${SETTINGS_BAK_PATH}`)
            expect(fsCopySync_spy.args[0][0]).to.equal(SETTINGS_PATH);
            expect(fsCopySync_spy.args[0][1]).to.equal(SETTINGS_BAK_PATH);
        });

        it('Test new settings file is written',() => {
            setupTest()
            updateSettingsFile_3_0_0();

            expect(logInfo_stub.args[2][0].includes('New settings file values for 3.0.0 upgrade:')).to.be.true;
            expect(logInfo_stub.args[3][0]).to.equal(`Creating new/upgraded settings file at '${SETTINGS_PATH}'`);
            expect(fsWriteFileSync_spy.args[0][0]).to.equal(SETTINGS_PATH);
            //Not checking the exact string value but confirming that a new settings val is present and old one is NOT
            expect(fsWriteFileSync_spy.args[0][1].includes('SERVER_PORT')).to.be.true;
            expect(fsWriteFileSync_spy.args[0][1].includes('HTTP_PORT')).to.be.false;
        });

        it('Test exception thrown from fs.copySync is handled',() => {
            setupTest();
            fsCopySync_spy.restore()
            fsCopySync_spy = sandbox.stub(fs, 'copySync').throws(TEST_ERROR);

            let test_result;
            try {
                updateSettingsFile_3_0_0();
            } catch(e) {
                test_result = e;
            }

            expect(consoleError_spy.args[0][0]).to.equal('There was a problem writing the backup for the old settings file.  Please check the log for details.');
            expect(fsWriteFileSync_spy.called).to.be.false;
            expect(test_result).to.equal(TEST_ERROR);
            fsCopySync_spy.restore();
        });

        it('Test exception thrown from fs.writeFileSync is handled',() => {
            setupTest();
            fsWriteFileSync_spy.restore()
            fsWriteFileSync_spy = sandbox.stub(fs, 'writeFileSync').throws(TEST_ERROR);

            let test_result;
            try {
                updateSettingsFile_3_0_0();
            } catch(e) {
                test_result = e;
            }

            expect(logInfo_stub.args[2][0].includes('New settings file values for 3.0.0 upgrade:')).to.be.true;
            expect(logInfo_stub.args[3][0]).to.equal(`Creating new/upgraded settings file at '${SETTINGS_PATH}'`);
            expect(consoleError_spy.args[0][0]).to.equal('There was a problem writing the new settings file. Please check the log for details.');
            expect(test_result).to.equal(TEST_ERROR);

            fsWriteFileSync_spy.restore()
        });

        it('Test settings update skips if 3.0 SERVER_PORT key found',() => {
            setupTest(true, true, 1234);
            const test_result = updateSettingsFile_3_0_0();

            const expected_msg = 'New settings file for 3.0.0 upgrade has already been successfully created.';
            expect(consoleLog_spy.args[0][0]).to.equal(expected_msg);
            expect(logInfo_stub.args[0][0]).to.equals(expected_msg);
            expect(test_result).to.equal(expected_msg);
        });
    });
})


