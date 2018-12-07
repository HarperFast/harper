"use strict";
const path = require('path');
const test_util = require('../test_utils');

test_util.preTestPrep();

const assert = require('assert');
const sinon = require('sinon');
const version = require('../../bin/version');
const hdb_utils = require('../../utility/common_utils');
const fs = require('fs');
const request_promise = require("request-promise-native");

const rewire = require('rewire');
const upgrade_rw = rewire(`../../bin/upgrade`);
const upgrade_directive = require('../../upgrade/UpgradeDirective');
const process_directives_rw = rewire('../../upgrade/processDirectives');
const BASE = process.cwd();

const directive_manager_stub = require('../upgrade/directives/testDirectives/directiveManagerStub');

const PACKAGE_JSON_VAL = {
    "name": "harperdb",
    "version": "1.2.0"
};

describe('Upgrade Test - Test processDirectives', function() {
    let startUpgradeDirectives = upgrade_rw.__get__('startUpgradeDirectives');
    // We don't want to use real directives for testing as they could change over time and invalidate tests, so we use
    // the directive manager stub.  In order to assign it to the process_directive instance we need to bring in a rewired
    // version.
    process_directives_rw.__set__('directive_manager', directive_manager_stub.directive_manager_rw);
    upgrade_rw.__set__('process_directives', process_directives_rw);
    it('test startUpgradeDirectives', function() {
        startUpgradeDirectives('1.1.0', '2.1.0');
    });
});

// Commented out for https://harperdb.atlassian.net/browse/HDB-646
// Put bback in when tests are running on their own build server
/*
describe('Upgrade Test - Test checkIfRunning', function() {
    // the find-module function does an annoying way of bringing in it's modules that makes stubbing
    // them difficult, so we need to force the stub this way.
    async function find(name, another_name) {
        return ['found'];
    }
    let checkIfRunning = upgrade_rw.__get__('checkIfRunning');

    it('test checkIfRunning, hdb not running so expect no exception', async function() {
        let except = undefined;
        await checkIfRunning('1.1.0', '2.1.0').catch((e) => {
            except = e;
        });
        assert.equal(except, undefined, 'Expected no exception.  Is HDB running while you run these tests?');
    });
    it('test checkIfRunning, stub reports hdb running so expect exception', async function() {
        let except = undefined;
        // See comment under describe for why this is happening
        let orig_ps = upgrade_rw.__get__('ps');
        upgrade_rw.__set__('ps', find);
        await checkIfRunning('1.1.0', '2.1.0').catch((e) => {
            except = e;
        });
        upgrade_rw.__set__('ps', orig_ps);
        assert.ok((except instanceof Error) === true, 'Expected exception');
    });
}); */

describe('Upgrade Test - Test upgrade', async function() {
    let check_if_running_stub_orig = upgrade_rw.__get__('checkIfRunning');
    let get_latest_stub_orig = upgrade_rw.__get__('getLatestVersion');
    let p_read_dir_stub_orig = upgrade_rw.__get__('p_fs_readdir');
    let get_build_stub_orig = upgrade_rw.__get__('checkIfRunning');

    let check_if_running_stub = undefined;
    let get_latest_stub = undefined;
    let version_stub = undefined;
    let p_read_dir_stub = undefined;
    let get_build_stub = undefined;
    let remove_dir_stub = undefined;
    let spinner = upgrade_rw.__get__('countdown');
    let upgrade = upgrade_rw.__get__('upgrade');
    // We don't want to use real directives for testing as they could change over time and invalidate tests, so we use
    // the directive manager stub.  In order to assign it to the process_directive instance we need to bring in a rewired
    // version.
    process_directives_rw.__set__('directive_manager', directive_manager_stub.directive_manager_rw);
    upgrade_rw.__set__('process_directives', process_directives_rw);
    let sandbox = sinon.createSandbox();

    beforeEach(function () {
        check_if_running_stub = sandbox.stub().returns('');
        get_latest_stub = sandbox.stub().resolves('2.1.0');
        version_stub = sandbox.stub(version, version.version.name).returns('1.1.0');
        p_read_dir_stub = sandbox.stub().resolves(null);
        get_build_stub = sandbox.stub().resolves('');
        remove_dir_stub = sandbox.stub(hdb_utils, hdb_utils.removeDir.name).resolves('');

        upgrade_rw.__set__('checkIfRunning', check_if_running_stub);
        upgrade_rw.__set__('getLatestVersion', get_latest_stub);
        upgrade_rw.__set__('p_fs_readdir', p_read_dir_stub);
        upgrade_rw.__set__('getBuild', get_build_stub);
    });

    afterEach(function () {
        sandbox.restore();
        upgrade_rw.__set__('checkIfRunning', check_if_running_stub_orig);
        upgrade_rw.__set__('getLatestVersion', get_latest_stub_orig);
        upgrade_rw.__set__('p_fs_readdir', p_read_dir_stub_orig);
        upgrade_rw.__set__('getBuild', get_build_stub_orig);
        spinner.stop();
    });

    it('test upgrade nominal path', async function() {
        let exep = undefined;
        await upgrade('1.1.0', '2.1.0').catch((e) => {
            exep = e;
        });
        assert.equal(exep, undefined, 'expected no exceptions');
    });
    it('test upgrade with missing properties', async function() {
        let exep = undefined;
        let props_orig = upgrade_rw.__get__('hdb_properties');
        upgrade_rw.__set__('hdb_properties', undefined);
        await upgrade('1.1.0', '2.1.0').catch((e) => {
            exep = e;
        });
        upgrade_rw.__set__('hdb_properties', props_orig);
        assert.equal((exep instanceof Error), true, 'expected exception');
    });
    it('test upgrade hdb running', async function() {
        let exep = undefined;
        check_if_running_stub = sandbox.stub().throws(new Error('HarperDB is running, please stop HarperDB with /bin/harperdb stop and run the upgrade command again.'));
        upgrade_rw.__set__('checkIfRunning', check_if_running_stub);
        await upgrade('1.1.0', '2.1.0').catch((e) => {
            exep = e;
        });
        assert.equal((exep instanceof Error), true, 'expected exception');
    });
    it('test with bad OS found', async function() {
        let exep = undefined;
        let find_os_orig = upgrade_rw.__get__('findOs');
        let find_os_stub = sandbox.stub().returns(null);
        upgrade_rw.__set__('findOs', find_os_stub);
        await upgrade('1.1.0', '2.1.0').catch((e) => {
            exep = e;
        });
        upgrade_rw.__set__('findOs', find_os_orig);
        assert.equal((exep instanceof Error), true, 'expected exception');
    });
    it('test with get latest failure', async function() {
        let exep = undefined;
        get_latest_stub = sandbox.stub().throws(new Error('Test failure'));
        upgrade_rw.__set__('getLatestVersion', get_latest_stub);
        await upgrade('1.1.0', '2.1.0').catch((e) => {
            exep = e;
        });
        assert.equal((exep instanceof Error), true, 'expected exception');
    });
    it('test with equal versions', async function() {
        let exep = undefined;
        get_latest_stub = sandbox.stub().resolves('1.1.0');
        upgrade_rw.__set__('getLatestVersion', get_latest_stub);
        let result = await upgrade('1.1.0', '1.1.0').catch((e) => {
            exep = e;
        });
        assert.equal(result, "HarperDB version is current", 'expected current response');
    });
    it('test with files found in upgrade dir, ensure removeDir called', async function() {
        let exep = undefined;
        p_read_dir_stub = sandbox.stub().resolves(['a files']);
        upgrade_rw.__set__('p_fs_readdir', p_read_dir_stub);
        let result = await upgrade('1.1.0', '2.1.0').catch((e) => {
            exep = e;
        });
        assert.equal(remove_dir_stub.called, true, 'expected current response');
    });
    it('test with files found in upgrade dir, rmdir throws exception', async function() {
        let exep = undefined;
        p_read_dir_stub = sandbox.stub().resolves(['a files']);
        remove_dir_stub.restore();
        remove_dir_stub = sandbox.stub(hdb_utils, hdb_utils.removeDir.name).throws(new Error('rmdir exception'));
        upgrade_rw.__set__('p_fs_readdir', p_read_dir_stub);
        let result = await upgrade('1.1.0', '2.1.0').catch((e) => {
            exep = e;
        });
        assert.equal(remove_dir_stub.called, true, 'expected rmdir to have been called');
        // make sure we terminate after this call
        assert.equal(get_build_stub.called, false, 'getBuild should not have been called');
    });
    it('test with getBuild throwing exception', async function() {
        let exep = undefined;
        get_build_stub = sandbox.stub().throws(new Error('getBuild exception'));
        upgrade_rw.__set__('getBuild', get_build_stub);
        let result = await upgrade('1.1.0', '2.1.0').catch((e) => {
            exep = e;
        });
        assert.equal((exep instanceof Error), true, 'expected exception');
    });
});

describe('Upgrade Test - Test startUpgrade', function() {

    let readFileSync_stub = undefined;
    let backupCurrInstall_stub = undefined;
    let startUpgradeDirectives_stub = undefined;
    let copyNewFilesIntoInstall_stub = undefined;
    let chmodSync_stub = undefined;
    let postInstallCleanUp_stub = undefined;

    let backupCurrInstall_orig = upgrade_rw.__get__('backupCurrInstall');
    let startUpgradeDirectives_orig = upgrade_rw.__get__('startUpgradeDirectives');
    let copyNewFilesIntoInstall_orig = upgrade_rw.__get__('copyNewFilesIntoInstall');
    let postInstallCleanUp_orig = upgrade_rw.__get__('postInstallCleanUp');

    let spinner = upgrade_rw.__get__('countdown');
    let startUpgrade = upgrade_rw.__get__('startUpgrade');
    // We don't want to use real directives for testing as they could change over time and invalidate tests, so we use
    // the directive manager stub.  In order to assign it to the process_directive instance we need to bring in a rewired
    // version.
    process_directives_rw.__set__('directive_manager', directive_manager_stub.directive_manager_rw);
    upgrade_rw.__set__('process_directives', process_directives_rw);
    let sandbox = sinon.createSandbox();

    beforeEach(function () {
        readFileSync_stub = sandbox.stub(fs, 'readFileSync').returns(JSON.stringify(PACKAGE_JSON_VAL));
        backupCurrInstall_stub = sandbox.stub().returns('');
        startUpgradeDirectives_stub = sandbox.stub().returns(['result 1', 'result 2']);
        copyNewFilesIntoInstall_stub = sandbox.stub().returns('');
        chmodSync_stub = sandbox.stub(fs, 'chmodSync').returns('');
        postInstallCleanUp_stub = sandbox.stub().returns('');

        upgrade_rw.__set__('backupCurrInstall', backupCurrInstall_stub);
        upgrade_rw.__set__('startUpgradeDirectives', startUpgradeDirectives_stub);
        upgrade_rw.__set__('copyNewFilesIntoInstall', copyNewFilesIntoInstall_stub);
        upgrade_rw.__set__('postInstallCleanUp', postInstallCleanUp_stub);
    });

    afterEach(function () {
        sandbox.restore();
        upgrade_rw.__set__('backupCurrInstall', backupCurrInstall_orig);
        upgrade_rw.__set__('startUpgradeDirectives', startUpgradeDirectives_orig);
        upgrade_rw.__set__('copyNewFilesIntoInstall', copyNewFilesIntoInstall_orig);
        upgrade_rw.__set__('postInstallCleanUp', postInstallCleanUp_orig);
        spinner.stop();
    });

    it('test startUpgrade nominal path', function() {
        let exep = undefined;
        try {
            startUpgrade('1.1.0');
        } catch(e) {
            exep = e;
        }
        assert.equal(exep, undefined, 'expected an exception');
    });
    it('test startUpgrade with readFileSyncException', function() {
        let exep = undefined;
        let exception_msg = "ReadFileSync Test Error";
        try {
            readFileSync_stub.restore();
            readFileSync_stub = sandbox.stub(fs, 'readFileSync').throws(new Error(exception_msg));
            startUpgrade('1.1.0');
        } catch(e) {
            exep = e;
        }
        assert.equal((exep instanceof Error), true, 'expected no exceptions');
        // Make sure we are getting the expected exception
        assert.equal(exep.message === exception_msg, true, 'expected specific  exception message');
    });
    it('test startUpgrade with backupCurrInstall Exception', function() {
        let exep = undefined;
        let exception_msg = "backupCurrInstall Test Error";
        try {
            backupCurrInstall_stub = sandbox.stub().throws(new Error("backupCurrInstall Test Error"));
            upgrade_rw.__set__('backupCurrInstall', backupCurrInstall_stub);
            startUpgrade('1.1.0');
        } catch(e) {
            exep = e;
        }
        assert.equal((exep instanceof Error), true, 'expected no exceptions');
        assert.equal(exep.message === exception_msg, true, 'expected specific  exception message');
    });
    it('test startUpgrade with startUpgradeDirectives_stub Exception', function() {
        let exep = undefined;
        try {
            startUpgradeDirectives_stub = sandbox.stub().throws(new Error("startUpgradeDirectives_stub Test Error"));
            upgrade_rw.__set__('startUpgradeDirectives', startUpgradeDirectives_stub);
            startUpgrade('1.1.0');
        } catch(e) {
            exep = e;
        }
        assert.equal(copyNewFilesIntoInstall_stub.called, true, 'Process keep going despite upgrade directive exception');
    });
    it('test startUpgrade with chmodSync Exception', function() {
        let exep = undefined;
        try {
            chmodSync_stub.restore();
            chmodSync_stub = sandbox.stub(fs, 'chmodSync').throws(new Error("chmod exception"));
            startUpgrade('1.1.0');
        } catch(e) {
            exep = e;
        }
        // We should still be running if chmod throws an exception
        assert.equal(postInstallCleanUp_stub.called, true, 'Process should keep running after chmod exception');
    });
});

describe('Upgrade Test - Test getLatestVersion', function() {
    let getLatestVersion = upgrade_rw.__get__('getLatestVersion');
    let sandbox = sinon.createSandbox();

    let request_promise_stub = undefined;
    let request_promise_orig = upgrade_rw.__get__('request_promise');

    let request_response = '[{"product_version":"1.2.005"},{"product_version":"1.2.004"},{"product_version":"1.2.0.1"}]';

    beforeEach(function () {
        request_promise_stub = sandbox.stub().resolves(request_response);
    });

    afterEach(function () {
        sandbox.restore();
        upgrade_rw.__set__('request_promise', request_promise_orig);
    });

    it('test getLatestVersion', async function() {
        upgrade_rw.__set__('request_promise', request_promise_stub);
        let exep = undefined;
        await getLatestVersion('1.1.0').catch((e) => {
            exep = e;
        });
        assert.ok(exep === undefined, 'Got an unexpected exception');
    });
    it('test getLatestVersion throwing exception', async function() {
        upgrade_rw.__set__('request_promise', request_promise_stub);
        let exep_msg = 'Request exception';
        request_promise_stub = sandbox.stub().throws(new Error(exep_msg));
        upgrade_rw.__set__('request_promise', request_promise_stub);
        let exep = undefined;
        await getLatestVersion('1.1.0').catch((e) => {
            exep = e;
        });
        assert.ok((exep instanceof Error) === true, 'Got an unexpected exception');
    });
});

describe('Upgrade Test - Test findOs', function() {
    let findOs = upgrade_rw.__get__('findOs');
    // We don't want to use real directives for testing as they could change over time and invalidate tests, so we use
    // the directive manager stub.  In order to assign it to the process_directive instance we need to bring in a rewired
    // version.
    process_directives_rw.__set__('directive_manager', directive_manager_stub.directive_manager_rw);
    upgrade_rw.__set__('process_directives', process_directives_rw);
    it('test startUpgradeDirectives', function() {
        findOs('1.1.0', '2.1.0');
    });
});
