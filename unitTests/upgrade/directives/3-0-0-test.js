// "use strict";
//
// const test_util = require('../../../unitTests/test_utils');
// test_util.preTestPrep();
//
// const chai = require('chai');
// const sinon = require('sinon');
// const { expect } = chai;
// const rewire = require('rewire');
// // const hdb_utils = require('../../../../utility/common_utils');
//
// const directive3_0_0_rw = rewire('../../../upgrade/directives/3-0-0');
//
// describe('directivesController Module', () => {
//     let sandbox;
//
//     before(() => {
//         sandbox = sinon.createSandbox();
//     })
//
//     beforeEach(function () {
//         directivesController_rw.__set__('versions', test_map);
//     });
//
//     after(function () {
//         rewire('../../../../upgrade/directives/directivesController');
//     });
//
//     describe('test getVersionsForUpgrade()', function() {
//         it('Nominal case - upgrade to next version', () => {
//             const test_upgrade_obj = generateUpgradeObj(test_vers3_0_0.version, test_vers3_1_0.version)
//             const valid_versions = directivesController_rw.getVersionsForUpgrade(test_upgrade_obj);
//             expect(valid_versions.length).to.equal(1);
//             expect(valid_versions[0]).to.equal(test_vers3_1_0.version);
//         });
//
//         it('Nominal case - initial upgrade to most recent version', () => {
//             const test_upgrade_obj = generateUpgradeObj('2.9.9', test_vers4_1_1.version)
//             const valid_versions = directivesController_rw.getVersionsForUpgrade(test_upgrade_obj);
//             expect(valid_versions.length).to.equal(3);
//             expect(valid_versions[0]).to.equal(test_vers3_0_0.version);
//             expect(valid_versions[1]).to.equal(test_vers3_1_0.version);
//             expect(valid_versions[2]).to.equal(test_vers4_1_1.version);
//         });
//
//         it('Test with non-existent new_version, expect 0 directives returned', () => {
//             const test_upgrade_obj = generateUpgradeObj(test_vers3_0_0.version, '3.0.1111')
//             const valid_versions = directivesController_rw.getVersionsForUpgrade(test_upgrade_obj);
//             expect(valid_versions.length).to.equal(0);
//         });
//
//         it('Test with non-existent new_version greater than an existing upgrade version, expect 1 directives returned', () => {
//             const test_upgrade_obj = generateUpgradeObj(test_vers3_0_0.version, '3.1.1111')
//             const valid_versions = directivesController_rw.getVersionsForUpgrade(test_upgrade_obj);
//             expect(valid_versions.length).to.equal(1);
//         });
//
//         it('Test with new version but with most up-to-date data version, expect 0 directives returned', () => {
//             const test_upgrade_obj = generateUpgradeObj(test_vers4_1_1.version, '5.1.1')
//             const valid_versions = directivesController_rw.getVersionsForUpgrade(test_upgrade_obj);
//             expect(valid_versions.length).to.equal(0);
//         });
//
//         it('Test with no data version - expect empty array returned', () => {
//             const test_upgrade_obj = generateUpgradeObj(null, test_vers4_1_1.version);
//             const valid_versions = directivesController_rw.getVersionsForUpgrade(test_upgrade_obj);
//             expect(valid_versions.length).to.equal(0);
//         });
//
//         it('Test with no new version - expect empty array returned', () => {
//             const test_upgrade_obj = generateUpgradeObj(test_vers3_0_0.version, null)
//             const valid_versions = directivesController_rw.getVersionsForUpgrade(test_upgrade_obj);
//             expect(valid_versions.length).to.equal(0);
//         });
//     });
// })
//
//
