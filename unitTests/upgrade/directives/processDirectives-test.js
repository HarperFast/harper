'use strict';
const path = require('path');
const test_util = require('../../test_utils');

test_util.preTestPrep();

const assert = require('assert');
const sinon = require('sinon');
const fs = require('fs');
const PropertiesReader = require('properties-reader');

const rewire = require('rewire');
const process_directive_rw = rewire('../../../../upgrade/processDirectives');
const upgrade_directive = require('../../../upgrade/UpgradeDirective');
const env_variable = require('../../../upgrade/EnvironmentVariable');

const BASE = process.cwd();
let DIR_PATH_BASE = BASE + '/processDirectivesTest/';
const TEST_DIRECTIVES_PATH = '../unitTests/upgrade/directives/testDirectives/1-1-0.js';

describe('test processDirectives', function() {
    let ver1_1_module = undefined;
    let processDirectives = process_directive_rw.__get__('processDirectives');
    process_directive_rw.__set__('settings_file_path', BASE + '/testsettings.js');
    beforeEach( function() {
        try {
            let mod_path = path.join(process.cwd(), TEST_DIRECTIVES_PATH);
            ver1_1_module = require(mod_path);
            process_directive_rw.__set__('hdb_base', BASE + '/processDirectivesTest/');
        } catch(e) {
            console.error(e);
            throw e;
        }
        //process_directive_rw.__set__('loaded_directives', [ver1_1_module]);
    });

    afterEach( function () {
        try {
            test_util.cleanUpDirectories(BASE + '/processDirectivesTest/');
        } catch(e) {
            console.error(e);
        }
    });
    after( function() {
        try {
            fs.unlinkSync(BASE + '/testsettings.js');
        } catch(e) {
            //no-op
        }
    });
    it('test with middle version number, expect 1 returned.', async function() {
        try {
            await processDirectives('0.0.1', '1.0.0', [ver1_1_module]);
        } catch(e) {
            console.error(e);
        }
    });
});

describe('test createDirectories', function() {
    let createDirectories = process_directive_rw.__get__('createDirectories');
    let ver1_1_module = undefined;
    process_directive_rw.__set__('settings_file_path', BASE + '/testsettings.js');
    beforeEach( function() {
        try {
            let mod_path = path.join(process.cwd(), '../unitTests/upgrade/directives/testDirectives/1-1-0');
            process_directive_rw.__set__('hdb_base', BASE + '/processDirectivesTest/');
            ver1_1_module = require(mod_path);
        } catch(e) {
            console.error(e);
            throw e;
        }
    });

    afterEach( function () {
        try {
            test_util.cleanUpDirectories(BASE + '/processDirectivesTest/');
        } catch(e) {
            console.error(e);
        }
    });
    after( function() {
        try {
            fs.unlinkSync(BASE + '/testsettings.js');
        } catch(e) {
            //no-op
        }
    });
    it('test creating 3 directories', test_util.mochaAsyncWrapper(async () => {

        let dirs_to_create = [
            'test0',
            'test1',
            'test2'
        ];
        await createDirectories(dirs_to_create);
        assert.equal(fs.existsSync(DIR_PATH_BASE), true);
        assert.equal(fs.existsSync(DIR_PATH_BASE + 'test1'), true);
        assert.equal(fs.existsSync(DIR_PATH_BASE + 'test2'), true);
    }));
    it('test empty directory array', test_util.mochaAsyncWrapper(async () => {
        let dirs_to_create = [];
        await createDirectories(dirs_to_create);
        assert.equal(fs.existsSync(DIR_PATH_BASE), false);
    }));
    it('test null directory array', test_util.mochaAsyncWrapper(async () => {
        let dirs_to_create = null;
        await createDirectories(dirs_to_create);
        assert.equal(fs.existsSync(DIR_PATH_BASE), false);
    }));
});

describe('test updateEnvironmentVariable', function() {
    let updateEnvironmentVariable = process_directive_rw.__get__('updateEnvironmentVariable');
    it('test adding new variable', test_util.mochaAsyncWrapper(async () => {
        let new_var = new env_variable('TEST_VAR', 'big_test', null);
        await updateEnvironmentVariable([new_var]);
        let new_props = process_directive_rw.__get__('hdb_properties');
        assert.equal(new_props.get('TEST_VAR') === 'big_test', true);
    }));
    it('test updating existing with new value', test_util.mochaAsyncWrapper(async () => {
        let update_var = new env_variable('HTTP_PORT', '12345', null);
        update_var.force_value_update = true;
        await updateEnvironmentVariable([update_var]);
        let new_props = process_directive_rw.__get__('hdb_properties');
        assert.equal(new_props.get('HTTP_PORT'),'12345', true);
    }));
    it('test updating comments', test_util.mochaAsyncWrapper(async () => {
        let update_var = new env_variable('HTTP_PORT', '12345', null);
        update_var.comments = ['test'];
        let comments = await updateEnvironmentVariable([update_var]);
        assert.equal(comments['HTTP_PORT'].length,1, true);
    }));
});

describe('Test runFunctions', function() {
    let runFunctions = process_directive_rw.__get__('runFunctions');
    let results = [];
    afterEach(function() {
       results = [];
    });
    function func1() {
      results.push('Function 1 running');
    }
    function func2() {
        results.push('Function 2 running');
    }
    function bad_func() {
        throw new Error('ERROR!!');
    };
   it('Test nominal case with valid functions', test_util.mochaAsyncWrapper(async () => {
        await runFunctions([func1,func2]);
        assert.equal(results.length, 2, 'Did not get expected function results');
   }));
    it('Test exception handling, expect func2 to not run', async () => {
        let result = undefined;
        try {
            await runFunctions([bad_func,func2]);
        } catch(e) {
            result = e;
        }
        assert.equal((result instanceof Error), true, 'Did not get expected exception');
        assert.equal(results.length, 0, 'Did not get expected function results');
    });
    it('Test runFunctions with null parameter', async () => {
        let result = undefined;
        try {
            await runFunctions(null);
        } catch(e) {
            result = e;
        }
        assert.equal(results.length, 0, 'Expected empty results array');
    });
    it('Test runFunctions with null parameter', async () => {
        let result = undefined;
        try {
            await runFunctions(null);
        } catch(e) {
            result = e;
        }
        assert.equal(results.length, 0, 'Expected empty results array');
    });
    it('Test runFunctions with non array parameter', async () => {
        let result = undefined;
        try {
            await runFunctions('test');
        } catch(e) {
            result = e;
        }
        assert.equal(results.length, 0, 'Expected empty results array');
    });
    it('Test runFunctions with non function values', async () => {
        let result = undefined;
        try {
            await runFunctions(['test']);
        } catch(e) {
            result = e;
        }
        assert.equal(results.length, 0, 'Expected empty results array');
    });
});

describe('Test writeEnvVariables', function() {
    let writeEnvVariables = process_directive_rw.__get__('writeEnvVariables');
    let write_stub = undefined;
    let orig_write_func = process_directive_rw.__get__('p_fs_writeFile');
    let orig_settings_file_path = process_directive_rw.__get__('p_fs_writeFile');

    beforeEach(function () {
        try {
            fs.unlinkSync(BASE + '/testsettings.js');
        } catch(e) {
            //no-op
        }
    });
    afterEach(function () {
        try {
            fs.unlinkSync(BASE + '/testsettings.js');
        } catch(e) {
            //no-op
        }
        process_directive_rw.__set__('settings_file_path', orig_settings_file_path);
    });
    it('test write environment variables, nominal case, ', async function() {
        //
        await writeEnvVariables();
        let file_exists = fs.existsSync(BASE + '/testsettings.js');
        assert.equal(file_exists, true, 'expected settings file to have been written');
    });
    it('test write environment variables with bad settings path ', async function() {
        process_directive_rw.__set__('settings_file_path', null);
        let result = undefined;
        try {
            await writeEnvVariables();
        } catch(e) {
            result = e;
        }
        let file_exists = fs.existsSync(BASE + '/testsettings.js');
        assert.equal(file_exists, false, 'expected settings file to have been written');
        assert.equal((result instanceof Error), true, 'expected exception back');
    });
    it('test write environment variables with exception thrown from write', async function() {
        write_stub = sinon.stub().throws(new Error('This is bad.'));
        process_directive_rw.__set__('p_fs_writeFile', write_stub);

        let result = undefined;
        try {
            await writeEnvVariables();
        } catch(e) {
            result = e;
        }
        let file_exists = fs.existsSync(BASE + '/testsettings.js');
        assert.equal(file_exists, false, 'expected settings file to have been written');
        assert.equal((result instanceof Error), true, 'expected exception back');
        process_directive_rw.__set__('p_fs_writeFile', orig_write_func);
    });
});

describe('Test stringifyProps', function() {
    let stringifyProps = process_directive_rw.__get__('stringifyProps');
    let orig_props = new process_directive_rw.__get__('hdb_properties');
    let orig_boot_props = new process_directive_rw.__get__('hdb_boot_properties');
    let props_clone = new PropertiesReader(orig_boot_props.get('settings_path'));
    it('test stringifyProps nominal case', async function() {
        let props = await stringifyProps(props_clone, null);
        assert.ok(props.length > 0, 'expected props lines length to be greater than 0');
    });
    it('test stringifyProps nominal case with comments', async function() {
        let test_comments = [];
        let test_comment_1 = 'Test comment 1';
        let test_comment_2 = 'Test comment 2';
        test_comments['SERVER_TIMEOUT_MS'] = [test_comment_1];
        test_comments['HTTPS_ON'] = [test_comment_2];
        let props = await stringifyProps(props_clone, test_comments);
        assert.ok(props.length > 0, 'expected props lines length to be greater than 0');
        assert.ok((props.indexOf(test_comment_1)) > -1, 'expected test comment to be in the message');
        assert.ok((props.indexOf(test_comment_2)) > -1, 'expected test comment to be in the message');
    });
    it('test stringifyProps with comments that don\'t have matching variable key', async function() {
        let test_comments = [];
        let bad_comment_1 = 'Bad comment';
        let test_comment_2 = 'Test comment 2';
        test_comments['NO_MATCH'] = [bad_comment_1];
        test_comments['HTTPS_ON'] = [test_comment_2];
        let props = await stringifyProps(props_clone, test_comments);
        assert.ok(props.length > 0, 'expected props lines length to be greater than 0');
        assert.ok((props.indexOf(bad_comment_1)) === -1, 'expected test comment to be missing in the message');
        assert.ok((props.indexOf(test_comment_2)) > -1, 'expected test comment to be in the message');
    });
    it('test stringifyProps with missing props parameter', async function() {
        let props = await stringifyProps(null, null);
        assert.ok(props.length === 0, 'expected empty string returned');
    });
    it('test stringifyProps nominal case with an empty property name', async function() {
        let silly_value = 'somethingabcd';
        props_clone.set('',silly_value);

        let props = await stringifyProps(props_clone, null);
        assert.ok(props.length > 0, 'expected empty string returned');
        assert.ok((props.indexOf(silly_value)) === -1, 'expected test comment to be missing in the message');
    });
});

describe('test readDirectiveFiles', function() {
    beforeEach( function() {
        process_directive_rw.__set__('hdb_base', BASE + '/../');
    });
    let readDirectiveFiles = process_directive_rw.__get__('readDirectiveFiles');

    it('test reading with 1 file', async function() {
        try {
            let found_files = await readDirectiveFiles(path.join(process.cwd(),TEST_DIRECTIVES_PATH));
            assert.equal(found_files.length, 3);
        } catch(e) {
            throw e;
        }
    });
    it('test reading with bad path', async function() {
        let excep = undefined;
        try {
            let found_files = await readDirectiveFiles('../omgfail/');
        } catch(e) {
            excep = e;
        }
        assert.equal((excep instanceof Error), true, 'Expected exception');
    });
    it('test reading with path resulting in no files found', async function() {
        let excep = undefined;
        try {
            let found_files = await readDirectiveFiles('../');
            assert.equal(found_files.length, 0);
        } catch(e) {
            excep = e;
        }
    });
    it('test reading with null parh, expect exception', async function() {
        let excep = undefined;
        try {
            let found_files = await readDirectiveFiles(null);
        } catch(e) {
            excep = e;
        }
        assert.equal((excep instanceof Error), true, 0);
    });
});

describe('Test getVersionsToInstall', async function() {
    let getVersionsToInstall = process_directive_rw.__get__('getVersionsToInstall');
    let loaded_directives = null;
    let readDirectiveFiles = process_directive_rw.__get__('readDirectiveFiles');

    beforeEach( async function() {
        process_directive_rw.__set__('hdb_base', BASE + '/../');
        loaded_directives = await readDirectiveFiles(path.join(process.cwd(), TEST_DIRECTIVES_PATH));
    });
    afterEach(function() {
       loaded_directives = null;
    });
    it('Test getVersionsToInstall nominal case', function() {
        let curr_version = '1.1.0';
        let versions_to_run = getVersionsToInstall(curr_version, loaded_directives);
        assert.equal(versions_to_run.length, 2, 'Expected 2 upgrade numbers back');
        assert.equal(versions_to_run[0].version, '1.1.1', 'Expected 2 upgrade numbers back');
        assert.equal(versions_to_run[1].version, '2.1.0', 'Expected 2 upgrade numbers back');
    });
    it('Test getVersionsToInstall  with 4 number version', function() {
        let curr_version = '1.1.0';
        let loaded_copy = [...loaded_directives];
        loaded_copy.push(new upgrade_directive('1.1.1.22'));
        let versions_to_run = getVersionsToInstall(curr_version, loaded_copy);
        assert.equal(versions_to_run.length, 3, 'Expected 2 upgrade numbers back');
        assert.equal(versions_to_run[0].version, '1.1.1', 'Expected 2 upgrade numbers back');
        assert.equal(versions_to_run[1].version, '1.1.1.22', 'Expected 2 upgrade numbers back');
        assert.equal(versions_to_run[2].version, '2.1.0', 'Expected 2 upgrade numbers back');
    });
    it('Test getVersionsToInstall  with 4 number version lower than curr', function() {
        let curr_version = '1.1.0';
        let loaded_copy = [...loaded_directives];
        loaded_copy.push(new upgrade_directive('1.0.1.22'));
        let versions_to_run = getVersionsToInstall(curr_version, loaded_copy);
        assert.equal(versions_to_run.length, 2, 'Expected 2 upgrade numbers back');
        assert.equal(versions_to_run[0].version, '1.1.1', 'Expected 2 upgrade numbers back');
    });
    it('Test getVersionsToInstall  with null directive parameter', function() {
        let curr_version = '1.1.0';
        let versions_to_run = getVersionsToInstall(curr_version, null);
        assert.equal(versions_to_run.length, 0, 'Expected 2 upgrade numbers back');
    });
    it('Test getVersionsToInstall  with null version parameter', function() {
        let versions_to_run = getVersionsToInstall(null, loaded_directives);
        assert.equal(versions_to_run.length, 0, 'Expected 2 upgrade numbers back');
    });
});

describe('Test compareVersions', function() {
    let compareVersions = process_directive_rw.__get__('compareVersions');

    //let version_numbers = ['1.1.1', '1.1.0', '1.2.1', '2.1.5'];
    let versions = [
        new upgrade_directive('1.1.1'),
        new upgrade_directive('1.1.0'),
        new upgrade_directive('1.2.1'),
        new upgrade_directive('2.1.5')
    ];
    it('test matching lowest version number, should include 3 later versions', function() {
        let oldVersion = '1.1.0';
        let filtered_versions = versions.sort(compareVersions).filter( function(curr_version) {
            return curr_version.version > oldVersion;
        });
        assert.equal(filtered_versions.length, 3, `expected 3 version numbers, found ${filtered_versions.length}`);
        assert.equal(filtered_versions.indexOf(oldVersion), -1, 'old version was not filtered out.');
    });

    it('test with greater version number, expect 0 returned.', function() {
        let oldVersion = '3.1.0';
        let filtered_versions = versions.sort(compareVersions).filter( function(curr_version) {
            return curr_version.version > oldVersion;
        });
        assert.equal(filtered_versions.length, 0, `expected 0 version numbers, found ${filtered_versions.length}`);
        assert.equal(filtered_versions.indexOf(oldVersion), -1, 'old version was not filtered out.');
    });
    it('test with smaller version number, expect 4 returned.', function() {
        let oldVersion = '0.0.1';
        let filtered_versions = versions.sort(compareVersions).filter( function(curr_version) {
            return curr_version.version > oldVersion;
        });
        assert.equal(filtered_versions.length, 4, `expected 4 version numbers, found ${filtered_versions.length}`);
        assert.equal(filtered_versions.indexOf(oldVersion), -1, 'old version was not found.');
    });
    it('test with middle version number, expect 1 returned.', function() {
        let oldVersion = '1.2.1';
        let filtered_versions = versions.sort(compareVersions).filter( function(curr_version) {
            return curr_version.version > oldVersion;
        });
        assert.equal(filtered_versions.length, 1, `expected 1 version numbers, found ${filtered_versions.length}`);
        assert.equal(filtered_versions.indexOf(oldVersion), -1, 'old version was not found.');
    });
    it('test 4 number version sorting', function() {
        let oldVersion = '1.1.0';
        let copy = [...versions];
        copy.push(new upgrade_directive('1.1.1.22'));
        let filtered_versions = copy.sort(compareVersions).filter( function(curr_version) {
            return curr_version.version > oldVersion;
        });
        assert.equal(filtered_versions.length, 4, `expected 4 version numbers, found ${filtered_versions.length}`);
        assert.equal(filtered_versions.indexOf(oldVersion), -1, 'old version was not filtered out.');
        assert.equal(filtered_versions[0].version, '1.1.1', `expected version number 1.1.1, found ${filtered_versions.length}`);
        assert.equal(filtered_versions[1].version, '1.1.1.22', `expected version number 1.1.1.22, found ${filtered_versions.length}`);
        assert.equal(filtered_versions[2].version, '1.2.1', `expected version number 1.2.1, found ${filtered_versions.length}`);
        assert.equal(filtered_versions[3].version, '2.1.5', `expected version number 2.1.5, found ${filtered_versions.length}`);
    });
    it('test comparing 2 versions resulting in an upgrade', function() {
        let oldVersion = '1.1.0';
        let new_version = '2.0.0';
        let should_upgrade = compareVersions(oldVersion, new_version);
        assert.ok(should_upgrade < 0, `expected returned value less than than 0`);
    });
    it('test comparing 2 equal versions resulting in versions being up to date', function() {
        let oldVersion = '1.1.0';
        let new_version = '1.1.0';
        let should_upgrade = compareVersions(oldVersion, new_version);
        assert.ok(should_upgrade === 0, `expected returned value should be 0`);
    });
    it('test comparing 2 versions with old version being greater than new version', function() {
        let oldVersion = '2.1.0';
        let new_version = '1.1.0';
        let should_upgrade = compareVersions(oldVersion, new_version);
        assert.ok(should_upgrade > 0, `expected returned value greater than than 0`);
    });
    it('test comparing 2 versions with new version having 4 version', function() {
        let oldVersion = '1.1.0';
        let new_version = '1.1.0.1';
        let should_upgrade = compareVersions(oldVersion, new_version);
        assert.ok(should_upgrade < 0, `expected returned value less than than 0`);
    });
    it('test comparing 2 versions with new and old version having 4 version', function() {
        let oldVersion = '1.1.0.1';
        let new_version = '1.1.0.122';
        let should_upgrade = compareVersions(oldVersion, new_version);
        assert.ok(should_upgrade < 0, `expected returned value less than than 0`);
    });
});


