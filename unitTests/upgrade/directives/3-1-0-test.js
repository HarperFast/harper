'use strict';

const chai = require('chai');
const sinon = require('sinon');
const { expect } = chai;
const sinon_chai = require('sinon-chai');
chai.use(sinon_chai);
const rewire = require('rewire');
const test_util = require('../../../unitTests/test_utils');
const hdb_logger = require('../../../utility/logging/harper_logger');
const hdb_terms = require('../../../utility/hdbTerms');
const { buildFile, getSettingsFilePath } = require('../../settingsTestFile');
const fs = require('fs-extra');

const SETTINGS_TO_IGNORE = ['settings_path', 'install_user', 'LOGGER', 'CUSTOM_FUNCTIONS', 'CUSTOM_FUNCTIONS_PORT',
    'CUSTOM_FUNCTIONS_DIRECTORY', 'MAX_CUSTOM_FUNCTION_PROCESSES'];
const SETTINGS_PATH = getSettingsFilePath();
let directive3_1_0;
let updateSettingsFile_3_1_0;

describe('Test 3.1.0 Upgrade Directive', () => {
    const sandbox = sinon.createSandbox();

    before(() => {
        test_util.preTestPrep();
        directive3_1_0 = rewire('../../../upgrade/directives/3-1-0')[0];
        updateSettingsFile_3_1_0 = directive3_1_0.sync_functions[0];
    });

    after(() => {
        sandbox.restore();
        fs.unlinkSync(SETTINGS_PATH);
    });

    describe('Test updateSettingsFile_3_1_0 function', () => {
        let consoleError_stub;
        let logError_stub;
        let fsWriteFileSync_stub;
        let fsCopySync_stub;

        before(() => {
            buildFile();
            sandbox.stub(console, 'log');
            sandbox.stub(fs, 'unlinkSync');
            sandbox.stub(hdb_logger, 'info');
            consoleError_stub = sandbox.stub(console, 'error');
            logError_stub = sandbox.stub(hdb_logger, 'error');
            fsWriteFileSync_stub = sandbox.stub(fs, 'writeFileSync');
            fsCopySync_stub = sandbox.stub(fs, 'copySync');
        });

        afterEach(() => {
            sandbox.resetHistory();
        });

        after(() => {
            sandbox.restore();
        });
        
        it('Test new setting file has IPC port param and logger param is removed', () => {
            const result = updateSettingsFile_3_1_0();
            const new_settings_val = fsWriteFileSync_stub.args[0][1];
            for (const name in hdb_terms.HDB_SETTINGS_NAMES) {
                const setting_name = hdb_terms.HDB_SETTINGS_NAMES[name];
                if (SETTINGS_TO_IGNORE.includes(setting_name)) continue;
                expect(new_settings_val).to.include(setting_name, `Expected new setting to contain ${setting_name} but it did not`);
            }

            expect(new_settings_val).to.not.include('LOGGER');
            expect(result).to.equal('New settings file for 3.1.0 upgrade successfully created.');
            expect(fsCopySync_stub).to.have.been.called;
            expect(fsWriteFileSync_stub).to.have.been.called;
        });

        it('Test error from backup is logged and thrown', () => {
            fsCopySync_stub.throws(new Error('Error with backup'));
            test_util.assertErrorSync(updateSettingsFile_3_1_0, [], new Error('Error with backup'));
            expect(logError_stub.args[0][0].message).to.equal('Error with backup');
            expect(consoleError_stub).to.have.been.calledWith('There was a problem writing the backup for the old settings file.  Please check the log for details.');
            fsCopySync_stub.returns();
        });

        it('Test error from writing new setting file is logged and thrown', () => {
            fsWriteFileSync_stub.throws(new Error('Error writing new file'));
            test_util.assertErrorSync(updateSettingsFile_3_1_0, [], new Error('Error writing new file'));
            expect(consoleError_stub).to.have.been.calledWith('There was a problem writing the new settings file. Please check the log for details.');
            expect(logError_stub).to.have.been.called;
            expect(fsCopySync_stub).to.have.been.called;
        });
    });
});