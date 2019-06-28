'use strict';
const path = require('path');
const test_util = require('../../test_utils');

test_util.preTestPrep();

const assert = require('assert');
const sinon = require('sinon');
const fs = require('fs');
const PropertiesReader = require('properties-reader');

const rewire = require('rewire');
const process_directive_rw = rewire('../../../upgrade/processDirectives');
const upgrade_directive = require('../../../upgrade/UpgradeDirective');
const env_variable = require('../../../upgrade/EnvironmentVariable');

const directive_manager_stub = require('./testDirectives/directiveManagerStub');

const BASE = process.cwd();
let DIR_PATH_BASE = BASE + '/processDirectivesTest/';

//Use the manager stub in order to control the tests.
process_directive_rw.__set__('directive_manager', directive_manager_stub.directive_manager_rw);

describe('test processDirectives', function() {
    let processDirectives = process_directive_rw.__get__('processDirectives');
    process_directive_rw.__set__('settings_file_path', BASE + '/testsettings.js');

    beforeEach( function() {
        try {
            process_directive_rw.__set__('hdb_base', BASE + '/processDirectivesTest/');
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
    it('test with middle version number, expect 1 returned.', function() {
        try {
            processDirectives('1.1.0', '2.1.0');
        } catch(e) {
            console.error(e);
        }
    });
});

describe('test createRelativeDirectories', function() {
    let createRelativeDirectories = process_directive_rw.__get__('createRelativeDirectories');
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
    it('test creating 3 directories', () => {

        let dirs_to_create = [
            'test0',
            'test1',
            'test2'
        ];
        createRelativeDirectories(dirs_to_create);
        assert.equal(fs.existsSync(DIR_PATH_BASE), true);
        assert.equal(fs.existsSync(DIR_PATH_BASE + 'test1'), true);
        assert.equal(fs.existsSync(DIR_PATH_BASE + 'test2'), true);
    });
    it('test empty directory array', () => {
        let dirs_to_create = [];
        createRelativeDirectories(dirs_to_create);
        assert.equal(fs.existsSync(DIR_PATH_BASE), false);
    });
    it('test null directory array', () => {
        let dirs_to_create = null;
        createRelativeDirectories(dirs_to_create);
        assert.equal(fs.existsSync(DIR_PATH_BASE), false);
    });
});

describe('test createExplicitDirectories', function() {
    let createExplicitDirectories = process_directive_rw.__get__('createExplicitDirectories');
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
    it('test creating 3 directories', () => {

        let dirs_to_create = [
            BASE + '/processDirectivesTest/test0',
            BASE + '/processDirectivesTest/test1',
            BASE + '/processDirectivesTest/test2'
        ];
        createExplicitDirectories(dirs_to_create);
        assert.equal(fs.existsSync(DIR_PATH_BASE), true);
        assert.equal(fs.existsSync(DIR_PATH_BASE + 'test1'), true);
        assert.equal(fs.existsSync(DIR_PATH_BASE + 'test2'), true);
    });
    it('test empty directory array', () => {
        let dirs_to_create = [];
        createExplicitDirectories(dirs_to_create);
        assert.equal(fs.existsSync(DIR_PATH_BASE), false);
    });
    it('test null directory array', () => {
        let dirs_to_create = null;
        createExplicitDirectories(dirs_to_create);
        assert.equal(fs.existsSync(DIR_PATH_BASE), false);
    });
});

describe('test updateEnvironmentVariable', function() {
    let updateEnvironmentVariable = process_directive_rw.__get__('updateEnvironmentVariable');
    it('test adding new variable', () => {
        let new_var = new env_variable('TEST_VAR', 'big_test', null);
        new_var.force_value_update = true;
        updateEnvironmentVariable([new_var]);
        let new_props = process_directive_rw.__get__('hdb_properties');
        assert.equal(new_props.get('TEST_VAR') === 'big_test', true);
    });
    it('test updating variable without forve_value_update set, expect no change', () => {
        let new_var = new env_variable('TEST_VAR', 'blah blah', null);
        new_var.force_value_update = false;
        updateEnvironmentVariable([new_var]);
        let new_props = process_directive_rw.__get__('hdb_properties');
        assert.equal(new_props.get('TEST_VAR') === 'blah blah', false);
    });
    it('test updating existing with new value', () => {
        let update_var = new env_variable('HTTP_PORT', '12345', null);
        update_var.force_value_update = true;
        updateEnvironmentVariable([update_var]);
        let new_props = process_directive_rw.__get__('hdb_properties');
        assert.equal(new_props.get('HTTP_PORT'),'12345', true);
    });
    it('test updating comments', () => {
        let update_var = new env_variable('HTTP_PORT', '12345', null);
        update_var.comments = ['test'];
        let comments = updateEnvironmentVariable([update_var]);
        assert.equal(comments['HTTP_PORT'].length,1, true);
    });
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
        throw new Error('test error');
    };
   it('Test nominal case with valid functions', () => {
        runFunctions([func1,func2]);
        assert.equal(results.length, 2, 'Did not get expected function results');
   });
    it('Test exception handling, expect func2 to not run', () => {
        let result = undefined;
        try {
            runFunctions([bad_func,func2]);
        } catch(e) {
            result = e;
        }
        assert.equal((result instanceof Error), true, 'Did not get expected exception');
        assert.equal(results.length, 0, 'Did not get expected function results');
    });
    it('Test runFunctions with null parameter', () => {
        let result = undefined;
        try {
            runFunctions(null);
        } catch(e) {
            result = e;
        }
        assert.equal(results.length, 0, 'Expected empty results array');
    });
    it('Test runFunctions with null parameter', () => {
        let result = undefined;
        try {
            runFunctions(null);
        } catch(e) {
            result = e;
        }
        assert.equal(results.length, 0, 'Expected empty results array');
    });
    it('Test runFunctions with non array parameter', () => {
        let result = undefined;
        try {
            runFunctions('test');
        } catch(e) {
            result = e;
        }
        assert.equal(results.length, 0, 'Expected empty results array');
    });
    it('Test runFunctions with non function values', () => {
        let result = undefined;
        try {
            runFunctions(['test']);
        } catch(e) {
            result = e;
        }
        assert.equal(results.length, 0, 'Expected empty results array');
    });
});

describe('Test writeEnvVariables', function() {
    let writeEnvVariables = process_directive_rw.__get__('writeEnvVariables');
    let write_stub = undefined;
    let orig_settings_file_path = process_directive_rw.__get__('settings_file_path');

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
        sinon.restore();
    });
    it('test write environment variables, nominal case, ', function() {
        writeEnvVariables();
        let file_exists = fs.existsSync(BASE + '/testsettings.js');
        assert.equal(file_exists, true, 'expected settings file to have been written');
    });
    it('test write environment variables with bad settings path ', function() {
        process_directive_rw.__set__('settings_file_path', null);
        let result = undefined;
        try {
            writeEnvVariables();
        } catch(e) {
            result = e;
        }
        let file_exists = fs.existsSync(BASE + '/testsettings.js');
        assert.equal(file_exists, false, 'expected settings file to have been written');
        assert.equal((result instanceof Error), true, 'expected exception back');
    });
    it('test write environment variables with exception thrown from write', function() {
        write_stub = sinon.stub(fs, 'writeFileSync').throws(new Error('This is a test.'));

        let result = undefined;
        try {
            writeEnvVariables();
        } catch(e) {
            result = e;
        }
        let file_exists = fs.existsSync(BASE + '/testsettings.js');
        assert.equal(file_exists, false, 'expected settings file to not exist');
        assert.equal((result instanceof Error), true, 'expected exception back');
    });
});

describe('Test stringifyProps', function() {
    let stringifyProps = process_directive_rw.__get__('stringifyProps');
    let orig_props = new process_directive_rw.__get__('hdb_properties');
    let orig_boot_props = new process_directive_rw.__get__('hdb_boot_properties');
    let props_clone = new PropertiesReader(orig_boot_props.get('settings_path'));
    it('test stringifyProps nominal case', function() {
        let props = stringifyProps(props_clone, null);
        assert.ok(props.length > 0, 'expected props lines length to be greater than 0');
    });
    it('test stringifyProps nominal case with comments', function() {
        let test_comments = [];
        let test_comment_1 = 'Test comment 1';
        let test_comment_2 = 'Test comment 2';
        test_comments['SERVER_TIMEOUT_MS'] = [test_comment_1];
        test_comments['HTTPS_ON'] = [test_comment_2];
        let props = stringifyProps(props_clone, test_comments);
        assert.ok(props.length > 0, 'expected props lines length to be greater than 0');
        assert.ok((props.indexOf(test_comment_1)) > -1, 'expected test comment to be in the message');
        assert.ok((props.indexOf(test_comment_2)) > -1, 'expected test comment to be in the message');
    });
    it('test stringifyProps with comments that don\'t have matching variable key', function() {
        let test_comments = [];
        let bad_comment_1 = 'Bad comment';
        let test_comment_2 = 'Test comment 2';
        test_comments['NO_MATCH'] = [bad_comment_1];
        test_comments['HTTPS_ON'] = [test_comment_2];
        let props = stringifyProps(props_clone, test_comments);
        assert.ok(props.length > 0, 'expected props lines length to be greater than 0');
        assert.ok((props.indexOf(bad_comment_1)) === -1, 'expected test comment to be missing in the message');
        assert.ok((props.indexOf(test_comment_2)) > -1, 'expected test comment to be in the message');
    });
    it('test stringifyProps with missing props parameter', function() {
        let props = stringifyProps(null, null);
        assert.ok(props.length === 0, 'expected empty string returned');
    });
    it('test stringifyProps nominal case with an empty property name', function() {
        let silly_value = 'somethingabcd';
        props_clone.set('',silly_value);

        let props = stringifyProps(props_clone, null);
        assert.ok(props.length > 0, 'expected empty string returned');
        assert.ok((props.indexOf(silly_value)) === -1, 'expected test comment to be missing in the message');
    });
});

describe('Test getVersionsToInstall', function() {
    let getVersionsToInstall = process_directive_rw.__get__('getVersionsToInstall');
    let loaded_directives = null;
    let filterInvalidVersions = directive_manager_stub.directive_manager_rw.__get__('filterInvalidVersions');

    beforeEach( function() {
        process_directive_rw.__set__('hdb_base', BASE + '/../');
        loaded_directives = filterInvalidVersions('1.1.0');
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
    it('Test getVersionsToInstall  with invalid number version', function() {
        let curr_version = '1.1.0';
        let loaded_copy = [...loaded_directives];
        loaded_copy.push(new upgrade_directive('1.1.1.22'));
        let versions_to_run = getVersionsToInstall(curr_version, loaded_copy);
        assert.equal(versions_to_run.length, 2, 'Expected 2 upgrade numbers back');
        assert.equal(versions_to_run[0].version, '1.1.1', 'Expected 2 upgrade numbers back');
        assert.equal(versions_to_run[1].version, '2.1.0', 'Expected 2 upgrade numbers back');
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


