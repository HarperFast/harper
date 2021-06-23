'use strict';

const chai = require('chai');
const sinon = require('sinon');
const { expect } = chai;
const sinon_chai = require('sinon-chai');
chai.use(sinon_chai);
chai.use(require('chai-integer'));
const rewire = require('rewire');
const test_util = require('../../../unitTests/test_utils');
const hdb_logger = require('../../../utility/logging/harper_logger');
const hdb_terms = require('../../../utility/hdbTerms');
const { buildFile, getSettingsFilePath } = require('../../settingsTestFile');
const fs = require('fs-extra');
const os = require('os');
const path = require('path');

const SETTINGS_TO_IGNORE = ['settings_path', 'install_user', 'LOGGER', 'LOG_TO_FILE', 'LOG_TO_STDSTREAMS'];
const SETTINGS_PATH = getSettingsFilePath();
let directive3_1_0;
let updateSettingsFile_3_1_0;
let move_license_files;

const OLD_KEYS_PATH = path.join(test_util.getMockTestPath(), '.harperdb/keys/');
const OLD_REG_FILE_PATH = path.join(OLD_KEYS_PATH, '060493.ks');
const OLD_LIC_FILE_PATH = path.join(OLD_KEYS_PATH, '.license');
const NEW_KEYS_PATH = path.join(test_util.getMockTestPath(), 'keys/.license');
const NEW_REG_FILE_PATH = path.join(NEW_KEYS_PATH, '060493.ks');
const NEW_LIC_FILE_PATH = path.join(NEW_KEYS_PATH, '.license');

describe('Test 3.1.0 Upgrade Directive', () => {
    const sandbox = sinon.createSandbox();

    before(() => {
        buildFile();
        test_util.preTestPrep();
        directive3_1_0 = rewire('../../../upgrade/directives/3-1-0')[0];
        updateSettingsFile_3_1_0 = directive3_1_0.sync_functions[0];
        move_license_files = directive3_1_0.sync_functions[1];
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
        
        it('Test new setting file has LOG_TO_FILE & LOG_TO_STDSTREAMS and logger param is removed', () => {
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

    describe('Test moveLicenseDirectory function', () => {
        let consoleError_stub;
        let logError_stub;
        let consoleWarn_stub;
        let logWarn_stub;
        let fsAccessSync_spy;
        let fsMoveSync_spy;

        before(() => {
            sandbox.stub(os, 'homedir').callsFake(()=>test_util.getMockTestPath());
            sandbox.stub(console, 'log');
            sandbox.stub(fs, 'unlinkSync');
            sandbox.stub(hdb_logger, 'info');
            consoleError_stub = sandbox.stub(console, 'error');
            logError_stub = sandbox.stub(hdb_logger, 'error');
            consoleWarn_stub = sandbox.stub(console, 'warn');
            logWarn_stub = sandbox.stub(hdb_logger, 'warn');
            fsAccessSync_spy = sandbox.spy(fs, 'accessSync');
            fsMoveSync_spy = sandbox.spy(fs, 'moveSync');
        });

        beforeEach(()=>{
            fs.removeSync(test_util.getMockTestPath());
            fs.mkdirpSync(OLD_KEYS_PATH);
            fs.mkdirpSync(NEW_KEYS_PATH);
            fs.writeFileSync(OLD_REG_FILE_PATH, '');
            fs.writeFileSync(OLD_LIC_FILE_PATH, '');
        });

        afterEach(() => {
            fs.removeSync(test_util.getMockTestPath());

            fs.unlinkSync(OLD_REG_FILE_PATH);
            fs.unlinkSync(OLD_LIC_FILE_PATH);
            sandbox.resetHistory();
        });

        after(() => {
            sandbox.restore();
        });

        it('Test moving license files', () => {
            move_license_files();
            expect(fsAccessSync_spy.callCount).to.equal(2);
            expect(fsAccessSync_spy.firstCall.exception).to.equal(undefined);
            expect(fsAccessSync_spy.secondCall.exception).to.equal(undefined);
            expect(fsAccessSync_spy.firstCall.firstArg).to.equal(OLD_LIC_FILE_PATH);
            expect(fsAccessSync_spy.secondCall.firstArg).to.equal(OLD_REG_FILE_PATH);

            expect(fsMoveSync_spy.callCount).to.equal(2);
            expect(fsMoveSync_spy.firstCall.exception).to.equal(undefined);
            expect(fsMoveSync_spy.secondCall.exception).to.equal(undefined);
            expect(fsMoveSync_spy.firstCall.args[0]).to.equal(OLD_LIC_FILE_PATH);
            expect(fsMoveSync_spy.firstCall.args[1]).to.equal(NEW_LIC_FILE_PATH);
            expect(fsMoveSync_spy.secondCall.args[0]).to.equal(OLD_REG_FILE_PATH);
            expect(fsMoveSync_spy.secondCall.args[1]).to.equal(NEW_REG_FILE_PATH);

            //test the license moved to the right place
            let open_err;
            let fd;
            try {
                fd = fs.openSync(NEW_LIC_FILE_PATH, 'r');
            }catch(e){
                open_err = e;
            }
            expect(fd).to.be.an.integer();
            expect(open_err).to.equal(undefined);

            //test the registration moved to the right place
            open_err = undefined;
            fd = undefined;
            try {
                fd = fs.openSync(NEW_REG_FILE_PATH, 'r');
            }catch(e){
                open_err = e;
            }
            expect(fd).to.be.an.integer();
            expect(open_err).to.equal(undefined);

            //test the license is no longer in the old location
            open_err = undefined;
            fd = undefined;
            try {
                fd = fs.openSync(OLD_LIC_FILE_PATH, 'r');
            }catch(e){
                open_err = e;
            }

            expect(fd).to.equal(undefined);
            expect(open_err.code).to.equal('ENOENT');

            //test the registration is no longer in the old location
            open_err = undefined;
            fd = undefined;
            try {
                fd = fs.openSync(OLD_REG_FILE_PATH, 'r');
            }catch(e){
                open_err = e;
            }

            expect(fd).to.equal(undefined);
            expect(open_err.code).to.equal('ENOENT');
        });

        it('Test license file does not exist', () => {
            fs.removeSync(OLD_LIC_FILE_PATH);

            move_license_files();
            expect(consoleWarn_stub).to.have.been.calledWith(`license file '${OLD_LIC_FILE_PATH}' does not exist.`);
            expect(logWarn_stub).to.have.been.called;

            //test the registration moved to the right place
            let open_err = undefined;
            let fd = undefined;
            try {
                fd = fs.openSync(NEW_REG_FILE_PATH, 'r');
            }catch(e){
                open_err = e;
            }
            expect(fd).to.be.an.integer();
            expect(open_err).to.equal(undefined);

            //test the registration is no longer in the old location
            open_err = undefined;
            fd = undefined;
            try {
                fd = fs.openSync(OLD_REG_FILE_PATH, 'r');
            }catch(e){
                open_err = e;
            }

            expect(fd).to.equal(undefined);
            expect(open_err.code).to.equal('ENOENT');
        });

        it('Test registration file does not exist', () => {
            fs.removeSync(OLD_REG_FILE_PATH);

            move_license_files();
            expect(consoleWarn_stub).to.have.been.calledWith(`registration file '${OLD_REG_FILE_PATH}' does not exist.`);
            expect(logWarn_stub).to.have.been.called;

            //test the registration moved to the right place
            let open_err = undefined;
            let fd = undefined;
            try {
                fd = fs.openSync(NEW_LIC_FILE_PATH, 'r');
            }catch(e){
                open_err = e;
            }
            expect(fd).to.be.an.integer();
            expect(open_err).to.equal(undefined);

            //test the registration is no longer in the old location
            open_err = undefined;
            fd = undefined;
            try {
                fd = fs.openSync(OLD_LIC_FILE_PATH, 'r');
            }catch(e){
                open_err = e;
            }

            expect(fd).to.equal(undefined);
            expect(open_err.code).to.equal('ENOENT');
        });

        it('Test error on license file move', () => {
            fsMoveSync_spy.restore();
            let moveFileStub = sandbox.stub(fs, 'moveSync').onCall(0).throws('bad move!');

            move_license_files();
            expect(consoleError_stub).to.have.been.calledWith('moving license file failed');
            expect(logError_stub).to.have.been.called;
            expect(moveFileStub.callCount).to.equal(2);
            expect(moveFileStub.firstCall.exception.name).to.equal("bad move!");
            expect(moveFileStub.secondCall.exception).to.equal(undefined);
        });

        it('Test error on registration file move', () => {
            fsMoveSync_spy.restore();
            let moveFileStub = sandbox.stub(fs, 'moveSync').onCall(1).throws('bad move!');

            move_license_files();
            expect(consoleError_stub).to.have.been.calledWith('moving registration file failed');
            expect(logError_stub).to.have.been.called;
            expect(moveFileStub.callCount).to.equal(2);
            expect(moveFileStub.firstCall.exception).to.equal(undefined);
            expect(moveFileStub.secondCall.exception.name).to.equal("bad move!");
        });

    });
});