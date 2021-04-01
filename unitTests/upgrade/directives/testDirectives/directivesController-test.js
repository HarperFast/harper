// 'use strict';
// const path = require('path');
// const test_util = require('../../../test_utils');
//
// test_util.preTestPrep();
//
// const assert = require('assert');
// const sinon = require('sinon');
// const fs = require('fs');
// const hdb_utils = require('../../../../utility/common_utils');
//
// const test_vers1_1_0 = require('./1-1-0');
// const test_vers1_1_1 = require('./1-1-1');
// const test_vers2_1_0 = require('./2-1-0');
//
// const rewire = require('rewire');
// const directivesController_rw = rewire('../../../../upgrade/directives/directivesController');
//
// describe('test getSortedVersions', function() {
//     let orig_versions = directivesController_rw.__get__('versions');
//     let getSortedVersions = directivesController_rw.__get__('getSortedVersions');
//     let test_map = new Map();
//     test_map.set(test_vers1_1_0.version, test_vers1_1_0);
//     test_map.set(test_vers1_1_1.version, test_vers1_1_1);
//     test_map.set(test_vers2_1_0.version, test_vers2_1_0);
//     beforeEach(function () {
//         directivesController_rw.__set__('versions', test_map);
//
//     });
//
//     afterEach(function () {
//         directivesController_rw.__set__('versions', orig_versions);
//     });
//     it('Test nominal case getSortedVersions', () => {
//         let sorted_versions = getSortedVersions();
//         assert.ok(sorted_versions.length > 0, 'Did not get any versions back');
//         assert.equal(sorted_versions[0], test_vers1_1_0.version, 'sorted versions not in correct order');
//         assert.equal(sorted_versions[1], test_vers1_1_1.version, 'sorted versions not in correct order');
//         assert.equal(sorted_versions[2], test_vers2_1_0.version, 'sorted versions not in correct order');
//     });
// });
//
// describe('test getModuleByVersion', function() {
//     let orig_versions = directivesController_rw.__get__('versions');
//     let getModuleByVersion = directivesController_rw.__get__('getModuleByVersion');
//     let test_map = new Map();
//     test_map.set(test_vers1_1_0.version, test_vers1_1_0);
//     test_map.set(test_vers1_1_1.version, test_vers1_1_1);
//     test_map.set(test_vers2_1_0.version, test_vers2_1_0);
//     beforeEach(function () {
//         directivesController_rw.__set__('versions', test_map);
//
//     });
//
//     afterEach(function () {
//         directivesController_rw.__set__('versions', orig_versions);
//     });
//     it('Test nominal case getModuleByVersion', () => {
//         let curr_version = getModuleByVersion(test_vers1_1_0.version);
//         assert.ok(curr_version.functions.length > 0, 'Expected populated functions in returned directive');
//         assert.ok(curr_version.functions[0].name === test_vers1_1_0.functions[0].name, 'Expected populated function in returned directive');
//         assert.equal(curr_version.functions[0](), 1, 'Expected module function execution to return 1');
//     });
//     it('Test getModuleByVersion with invalid version, expect null', () => {
//         let curr_version = getModuleByVersion('1-1-0-1');
//         assert.equal(curr_version, null, 'Expected null directive returned');
//     });
//     it('Test getModuleByVersion with null version, expect null', () => {
//         let curr_version = getModuleByVersion(null);
//         assert.equal(curr_version, null, 'Expected null directive returned');
//     });
// });
//
// describe('test filterInvalidVersion', function() {
//     let orig_versions = directivesController_rw.__get__('versions');
//     let filterInvalidVersions = directivesController_rw.__get__('filterInvalidVersions');
//     let test_map = new Map();
//     test_map.set(test_vers1_1_0.version, test_vers1_1_0);
//     test_map.set(test_vers1_1_1.version, test_vers1_1_1);
//     test_map.set(test_vers2_1_0.version, test_vers2_1_0);
//     beforeEach(function () {
//         directivesController_rw.__set__('versions', test_map);
//     });
//
//     afterEach(function () {
//         directivesController_rw.__set__('versions', orig_versions);
//     });
//     it('Test nominal case filterInvalidVersions', () => {
//         let valid_versions = filterInvalidVersions(test_vers1_1_0.version, test_vers2_1_0.version);
//         assert.equal(valid_versions.length, 2, 'Expected 2 directives returned');
//     });
//     it('Test filterInvalidVersions with non-existent new_version, expect 2 directives returned', () => {
//         let curr_version = filterInvalidVersions(test_vers1_1_0.version, '1.0.1.1.1');
//         assert.equal(curr_version.length, 2, 'Expected 2 directives returned');
//     });
//     it('Test filterInvalidVersions with invalid version, expect empty array', () => {
//         let valid_versions = filterInvalidVersions('1-1-0-1', test_vers2_1_0.version);
//         assert.equal(valid_versions.length, 0, 'Expected empty version array returned');
//     });
//     it('Test filterInvalidVersions with latest version, expect empty array', () => {
//         let curr_version = filterInvalidVersions(test_vers2_1_0.version.version, test_vers2_1_0.version);
//         assert.equal(curr_version.length, 0, 'Expected empty version array returned');
//     });
//     it('Test filterInvalidVersions with null version, expect empty array', () => {
//         let curr_version = filterInvalidVersions(null, null);
//         assert.equal(curr_version.length, 0, 'Expected empty version array returned');
//     });
// });
