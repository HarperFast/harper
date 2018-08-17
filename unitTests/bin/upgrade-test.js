"use strict";
const path = require('path');
const test_util = require('../test_utils');

test_util.preTestPrep();

const assert = require('assert');
const sinon = require('sinon');
const child_process = require('child_process');
const events = require('events');
const version = require('../../bin/version');
const hdb_utils = require('../../utility/common_utils');

const rewire = require('rewire');
const upgrade_rw = rewire(`../../bin/upgrade`);
const upgrade_directive = require('../../upgrade/UpgradeDirective');
const process_directives_rw = rewire('../../upgrade/processDirectives');
const BASE = process.cwd();

const directive_manager_stub = require('../upgrade/directives/testDirectives/directiveManagerStub');

describe('Upgrade Test - Test processDirectives', function() {
    upgrade_rw.__set__('hdb_base', BASE + '/../');
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
        assert.equal(except, undefined, 'Expected no exception');
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
});

describe('Upgrade Test - Test upgrade', async function() {
    async function mkdirpstub(path) {
        return;
    }

    async function mkdirpstub(path) {
        throw new Error('mkdirp exception');
    }

    let check_if_running_stub_orig = upgrade_rw.__get__('checkIfRunning');
    let get_latest_stub_orig = upgrade_rw.__get__('getLatestVersion');
    let p_read_dir_stub_orig = upgrade_rw.__get__('p_fs_readdir');
    let mkdirp_stub_orig = upgrade_rw.__get__('mkdirp');
    let get_build_stub_orig = upgrade_rw.__get__('checkIfRunning');

    let check_if_running_stub = undefined;
    let get_latest_stub = undefined;
    let version_stub = undefined;
    let p_read_dir_stub = undefined;
    let mkdirp_stub = undefined;
    let get_build_stub = undefined;
    let remove_dir_stub = undefined;
    let spinner = upgrade_rw.__get__('countdown');
    upgrade_rw.__set__('hdb_base', BASE + '/../');
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
        mkdirp_stub = sandbox.stub().resolves('');
        get_build_stub = sandbox.stub().resolves('');
        remove_dir_stub = sandbox.stub(hdb_utils, hdb_utils.removeDir.name).resolves('');

        upgrade_rw.__set__('checkIfRunning', check_if_running_stub);
        upgrade_rw.__set__('getLatestVersion', get_latest_stub);
        upgrade_rw.__set__('p_fs_readdir', p_read_dir_stub);
        upgrade_rw.__set__('mkdirp', mkdirp_stub);
        upgrade_rw.__set__('getBuild', get_build_stub);
    });

    afterEach(function () {
        sandbox.restore();
        upgrade_rw.__set__('checkIfRunning', check_if_running_stub_orig);
        upgrade_rw.__set__('getLatestVersion', get_latest_stub_orig);
        upgrade_rw.__set__('p_fs_readdir', p_read_dir_stub_orig);
        upgrade_rw.__set__('mkdirp', mkdirp_stub_orig);
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
        assert.equal(mkdirp_stub.called, false, 'mkdirp should not have been called');
        assert.equal(get_build_stub.called, false, 'getBuild should not have been called');
    });
    it('test with mkdirp throwing exception', async function() {
        let exep = undefined;
        mkdirp_stub = sandbox.stub().throws(new Error('mkdirp exception'));
        upgrade_rw.__set__('mkdirp', mkdirp_stub);
        let result = await upgrade('1.1.0', '2.1.0').catch((e) => {
            exep = e;
        });
        assert.equal((exep instanceof Error), true, 'expected exception');
        assert.equal(get_build_stub.called, false, 'getbuild should not have been called');
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

describe('Upgrade Test - Test upgradeExternal', function() {
    upgrade_rw.__set__('hdb_base', BASE + '/../');
    let startUpgradeDirectives = upgrade_rw.__get__('upgradeExternal');
    // We don't want to use real directives for testing as they could change over time and invalidate tests, so we use
    // the directive manager stub.  In order to assign it to the process_directive instance we need to bring in a rewired
    // version.
    process_directives_rw.__set__('directive_manager', directive_manager_stub.directive_manager_rw);
    upgrade_rw.__set__('process_directives', process_directives_rw);
    it('test startUpgradeDirectives', function() {
        startUpgradeDirectives('1.1.0', '2.1.0');
    });
});

describe('Upgrade Test - Test postInstallCleanUp', function() {
    upgrade_rw.__set__('hdb_base', BASE + '/../');
    let startUpgradeDirectives = upgrade_rw.__get__('postInstallCleanUp');
    // We don't want to use real directives for testing as they could change over time and invalidate tests, so we use
    // the directive manager stub.  In order to assign it to the process_directive instance we need to bring in a rewired
    // version.
    process_directives_rw.__set__('directive_manager', directive_manager_stub.directive_manager_rw);
    upgrade_rw.__set__('process_directives', process_directives_rw);
    it('test startUpgradeDirectives', function() {
        startUpgradeDirectives('1.1.0', '2.1.0');
    });
});

describe('Upgrade Test - Test getLatestVersion', function() {
    upgrade_rw.__set__('hdb_base', BASE + '/../');
    let getLatestVersion = upgrade_rw.__get__('getLatestVersion');
    // We don't want to use real directives for testing as they could change over time and invalidate tests, so we use
    // the directive manager stub.  In order to assign it to the process_directive instance we need to bring in a rewired
    // version.
    process_directives_rw.__set__('directive_manager', directive_manager_stub.directive_manager_rw);
    upgrade_rw.__set__('process_directives', process_directives_rw);
    it('test startUpgradeDirectives', function() {
        getLatestVersion('1.1.0', '2.1.0');
    });
});

describe('Upgrade Test - Test getBuild', function() {
    upgrade_rw.__set__('hdb_base', BASE + '/../');
    let getBuild = upgrade_rw.__get__('getBuild');
    // We don't want to use real directives for testing as they could change over time and invalidate tests, so we use
    // the directive manager stub.  In order to assign it to the process_directive instance we need to bring in a rewired
    // version.
    process_directives_rw.__set__('directive_manager', directive_manager_stub.directive_manager_rw);
    upgrade_rw.__set__('process_directives', process_directives_rw);
    it('test startUpgradeDirectives', function() {
        getBuild('1.1.0', '2.1.0');
    });
});

describe('Upgrade Test - Test findOs', function() {
    upgrade_rw.__set__('hdb_base', BASE + '/../');
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

describe('Upgrade Test - Test copyUpgradeExecutable', function() {
    upgrade_rw.__set__('hdb_base', BASE + '/../');
    let copyUpgradeExecutable = upgrade_rw.__get__('copyUpgradeExecutable');
    // We don't want to use real directives for testing as they could change over time and invalidate tests, so we use
    // the directive manager stub.  In order to assign it to the process_directive instance we need to bring in a rewired
    // version.
    process_directives_rw.__set__('directive_manager', directive_manager_stub.directive_manager_rw);
    upgrade_rw.__set__('process_directives', process_directives_rw);
    it('test copyUpgradeExecutable', function() {
        copyUpgradeExecutable('1.1.0', '2.1.0');
    });
});

describe('Upgrade Test - Test startUpgradeDirectives', function() {
    upgrade_rw.__set__('hdb_base', BASE + '/../');
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

describe('Upgrade Test - Test backupCurrInstall', function() {
    upgrade_rw.__set__('hdb_base', BASE + '/../');
    let backupCurrInstall = upgrade_rw.__get__('backupCurrInstall');
    // We don't want to use real directives for testing as they could change over time and invalidate tests, so we use
    // the directive manager stub.  In order to assign it to the process_directive instance we need to bring in a rewired
    // version.
    process_directives_rw.__set__('directive_manager', directive_manager_stub.directive_manager_rw);
    upgrade_rw.__set__('process_directives', process_directives_rw);
    it('test backupCurrInstall', function() {
        backupCurrInstall('1.1.0', '2.1.0');
    });
});

describe('Upgrade Test - Test copyNewFilesIntoInstall', function() {
    upgrade_rw.__set__('hdb_base', BASE + '/../');
    let copyNewFilesIntoInstall = upgrade_rw.__get__('copyNewFilesIntoInstall');
    // We don't want to use real directives for testing as they could change over time and invalidate tests, so we use
    // the directive manager stub.  In order to assign it to the process_directive instance we need to bring in a rewired
    // version.
    process_directives_rw.__set__('directive_manager', directive_manager_stub.directive_manager_rw);
    upgrade_rw.__set__('process_directives', process_directives_rw);
    it('test copyNewFilesIntoInstall', function() {
        copyNewFilesIntoInstall('1.1.0', '2.1.0');
    });
});