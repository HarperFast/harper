'use strict';

const chai = require('chai');
const sinon = require('sinon');
const { expect } = chai;
const rewire = require('rewire');
const test_util = require('../../../unitTests/test_utils');
const hdb_logger = require('../../../utility/logging/harper_logger');
const hdb_terms = require('../../../utility/hdbTerms');
const fs = require('fs-extra');

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
    });

/*    describe('Test getOldPropsValue function', () => {
        const directive3_1_0_file = rewire('../../../upgrade/directives/3-1-0');
        const getOldPropsValue = directive3_1_0_file.__get__('getOldPropsValue');

        it('Test when value is not empty', () => {
            const result = getOldPropsValue('IPC_SERVER_PORT');
            expect(result).to.equal('')
        });
        
    });*/
    
    describe('Test updateSettingsFile_3_1_0 function', () => {
        let consoleLog_stub;
        let consoleError_stub;
        let logInfo_stub;
        let fsWriteFileSync_stub;
        let fsCopySync_stub;
        let fsUnlinkSync_stub;

        before(() => {
            consoleLog_stub = sandbox.stub(console, 'log');
            consoleError_stub = sandbox.stub(console, 'error');
            logInfo_stub = sandbox.stub(hdb_logger, 'info');
            fsWriteFileSync_stub = sandbox.stub(fs, 'writeFileSync');
            fsCopySync_stub = sandbox.stub(fs, 'copySync');
            fsUnlinkSync_stub = sandbox.stub(fs, 'unlinkSync');
        });

        afterEach(() => {
            sandbox.resetHistory();
        });

        after(() => {
            sandbox.restore();
        });
        
        it('Test new setting file has IPC port and logger removed', () => {
            const result = updateSettingsFile_3_1_0();

            const new_settings_val = fsWriteFileSync_stub.args[0][1];
            for (const name in hdb_terms.HDB_SETTINGS_NAMES) {
                const setting_name = hdb_terms.HDB_SETTINGS_NAMES[name];
                if (setting_name === 'settings_path' || setting_name === 'install_user') continue;
                expect(new_settings_val).to.include(setting_name, `Expected new setting to contain ${setting_name} but it did not`);
            }


            console.log(result);
            
        });

    });

});