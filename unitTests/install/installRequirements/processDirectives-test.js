"use strict";
const path = require('path');
const test_util = require('../../test_utils');

test_util.preTestPrep();

const assert = require('assert');
let sinon = require('sinon');
let fs = require('fs');

const rewire = require('rewire');
const process_directive_rw = rewire('../../../utility/install/installRequirements/processDirectives');
const upgrade_directive = require('../../../utility/install/installRequirements/UpgradeDirective');
const BASE = process.cwd();

describe('Test compareVersions', function() {
    let compareVersions = process_directive_rw.__get__('compareVersions');

    //let version_numbers = ['1.1.1', '1.1.0', '1.2.1', '2.1.5'];
    let versions = [
        new upgrade_directive('1.1.1'),
        new upgrade_directive('1.1.0'),
        new upgrade_directive('1.2.1'),
        new upgrade_directive('2.1.5')
    ]
    it('test matching lowest version number, should include 3 later versions', function() {
        let oldVersion = '1.1.0';
        let filtered_versions = versions.sort(compareVersions).filter( function(curr_version) {
            return curr_version.version > oldVersion;
        });
        assert.equal(filtered_versions.length, 3, `expected 3 version numbers, found ${filtered_versions.length}`);
        assert.equal(filtered_versions.indexOf(oldVersion), -1, "old version was not filtered out.")
    });

    it('test with greater version number, expect 0 returned.', function() {
        let oldVersion = '3.1.0';
        let filtered_versions = versions.sort(compareVersions).filter( function(curr_version) {
            return curr_version.version > oldVersion;
        });
        assert.equal(filtered_versions.length, 0, `expected 0 version numbers, found ${filtered_versions.length}`);
        assert.equal(filtered_versions.indexOf(oldVersion), -1, "old version was not filtered out.")
    });
    it('test with smaller version number, expect 4 returned.', function() {
        let oldVersion = '0.0.1';
        let filtered_versions = versions.sort(compareVersions).filter( function(curr_version) {
            return curr_version.version > oldVersion;
        });
        assert.equal(filtered_versions.length, 4, `expected 4 version numbers, found ${filtered_versions.length}`);
        assert.equal(filtered_versions.indexOf(oldVersion), -1, "old version was not found.")
    });
    it('test with middle version number, expect 1 returned.', function() {
        let oldVersion = '1.2.1';
        let filtered_versions = versions.sort(compareVersions).filter( function(curr_version) {
            return curr_version.version > oldVersion;
        });
        assert.equal(filtered_versions.length, 1, `expected 1 version numbers, found ${filtered_versions.length}`);
        assert.equal(filtered_versions.indexOf(oldVersion), -1, "old version was not found.")
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
        process_directive_rw.__set__('loaded_directives', [ver1_1_module]);
    });

    it('test with middle version number, expect 1 returned.', async function() {
        try {
            await processDirectives('0.0.1', '1.0.0');
        } catch(e) {
            console.error(e);
        }
    });
});