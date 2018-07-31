'use strict';
const path = require('path');
const test_util = require('../../test_utils');

test_util.preTestPrep();

const assert = require('assert');
const sinon = require('sinon');
const fs = require('fs');

const rewire = require('rewire');
const process_directive_rw = rewire('../../../utility/install/installRequirements/processDirectives');
const upgrade_directive = require('../../../utility/install/installRequirements/UpgradeDirective');
const env_variable = require('../../../utility/install/installRequirements/EnvironmentVariable');

const BASE = process.cwd();
let DIR_PATH_BASE = BASE + '/processDirectivesTest/';

describe('test processDirectives', function() {
    let ver1_1_module = undefined;
    let processDirectives = process_directive_rw.__get__('processDirectives');
    process_directive_rw.__set__('settings_file_path', BASE + '/testsettings.js');
    beforeEach( function() {
        try {
            let mod_path = path.join(process.cwd(), '../unitTests/install/installRequirements/testDirectives/1-1-0');
            ver1_1_module = require(mod_path);
            process_directive_rw.__set__('hdb_base', BASE + '/processDirectivesTest/');
        } catch(e) {
            console.error(e);
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
            let mod_path = path.join(process.cwd(), '../unitTests/install/installRequirements/testDirectives/1-1-0');
            process_directive_rw.__set__('hdb_base', BASE + '/processDirectivesTest/');
            ver1_1_module = require(mod_path);
        } catch(e) {
            console.error(e);
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
    let props_value = process_directive_rw.__get__('hdb_properties');
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
        await updateEnvironmentVariable([update_var]);
        let comments = process_directive_rw.__get__('comments');
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
    beforeEach(function () {

    });
    afterEach(function () {

    });
    it('test write environment variables, nominal case, ', function() {
        write_stub = sinon.stub(process_directive_rw, "p_fs_writeFile").yields("");
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
});

describe('test readDirectiveFiles', function() {
    beforeEach( function() {
        process_directive_rw.__set__('hdb_base', BASE + '/../');
    });
    let readDirectiveFiles = process_directive_rw.__get__('readDirectiveFiles');

    it('test reading with 1 file', async function() {
      try {
          let base = process_directive_rw.__get__('hdb_base');
          let found_files = await readDirectiveFiles(process_directive_rw.__get__('hdb_base'));
          assert.equal(found_files.length, 1);
      } catch(e) {
          throw e;
      }
    });
});
