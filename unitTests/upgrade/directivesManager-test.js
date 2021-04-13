'use strict';

const test_util = require('../test_utils');
const { generateUpgradeObj } = test_util;
test_util.preTestPrep();

const assert = require('assert');
const chai = require('chai');
const sinon = require('sinon');
const { expect } = chai;

const rewire = require('rewire');
let directivesManager_rw = rewire('../../upgrade/directivesManager');
const upgrade_directive = require('../../upgrade/UpgradeDirective');
const directivesController_stub = require('./directives/directivesControllerStub');

//Use the manager stub in order to control the tests.
directivesManager_rw.__set__('directivesController', directivesController_stub);

describe('processDirectives Module', function() {
    after(() => {
        rewire('../../upgrade/directivesManager');
    });

    describe('Test processDirectives()', () => {
        let processDirectives_rw = directivesManager_rw.__get__('processDirectives');
        const directive_msgs = [ 'processing settings func for 3.0.0 upgrade', 'processing other func for 3.0.0 upgrade',
            'processing a second func for 3.0.0 upgrade', 'processing settings func for 3.1.0 upgrade', 'processing other func for 3.1.0 upgrade',
            'processing settings func for 4.1.1 upgrade', 'processing other func for 4.1.1 upgrade'];
        let sandbox;
        let directive_stub;
        let sync_func_stub;
        let async_func_stub;
        let getUpgradeDirsToInstall_stub;

        before(() => {
            sandbox = sinon.createSandbox();
            directive_stub = new upgrade_directive('1.2.3');
            sync_func_stub = sandbox.stub().returns('sync func return');
            async_func_stub = sandbox.stub().resolves('async func return');
            directive_stub.sync_functions = [sync_func_stub];
            directive_stub.async_functions = [async_func_stub];
            getUpgradeDirsToInstall_stub = sandbox.stub().returns([directive_stub])
        })

        after(() => {
            sandbox.restore();
            directivesManager_rw = rewire('../../upgrade/directivesManager');
            directivesManager_rw.__set__('directivesController', directivesController_stub);
        })

        it('test upgrade from 3.0 to 3.1', async function() {
            const test_upgrade_ver = '3.1.0'
            const test_upgrade_obj = generateUpgradeObj('3.0.0', test_upgrade_ver);

            const test_result = await processDirectives_rw(test_upgrade_obj);

            expect(test_result.length).to.eql(2);
            test_result.forEach(str => {
                expect(str.includes(test_upgrade_ver)).to.be.true;
            })

        });

        it('test upgrade to 3.0.0', async function() {
            const test_upgrade_ver = '3.0.0'
            const test_upgrade_obj = generateUpgradeObj('2.9', test_upgrade_ver);

            const test_result = await processDirectives_rw(test_upgrade_obj);

            expect(test_result.length).to.eql(3);
            test_result.forEach(str => {
                expect(str.includes(test_upgrade_ver)).to.be.true;
            })
        });

        it('test upgrade to 5.1.1', async function() {
            const test_upgrade_ver = '5.1.1'
            const test_upgrade_obj = generateUpgradeObj('2.9', test_upgrade_ver);

            const test_result = await processDirectives_rw(test_upgrade_obj);

            expect(test_result.length).to.equal(directive_msgs.length);
            expect(test_result).to.deep.equal(directive_msgs);
        });

        it('test upgrade to 3.0.0 from older version', async function() {
            const test_upgrade_ver = '3.0.0'
            const test_upgrade_obj = generateUpgradeObj('1.9', test_upgrade_ver);

            const test_result = await processDirectives_rw(test_upgrade_obj);

            expect(test_result.length).to.equal(3);
            expect(test_result).to.deep.equal([directive_msgs[0], directive_msgs[1], directive_msgs[2]]);
        });

        it('test processDirectives with settings function error', async function() {
            const test_upgrade_ver = '3.0.0'
            const test_upgrade_obj = generateUpgradeObj('1.9', test_upgrade_ver);
            const test_err = 'settings func error!'
            sync_func_stub.throws(new  Error(test_err));
            directivesManager_rw.__set__('getUpgradeDirectivesToInstall', getUpgradeDirsToInstall_stub)

            let test_result;

            try {
                await processDirectives_rw(test_upgrade_obj);
            } catch(e) {
                test_result = e;
            }

            expect(test_result instanceof Error).to.be.true;
            expect(test_result.message).to.equal(test_err);
        });

        it('test processDirectives with upgrade function error', async function() {
            const test_upgrade_ver = '3.0.0'
            const test_upgrade_obj = generateUpgradeObj('1.9', test_upgrade_ver);
            const test_err = 'upgrade func error!'
            sync_func_stub.returns('settings func return');
            async_func_stub.throws(new  Error(test_err));
            directivesManager_rw.__set__('getUpgradeDirectivesToInstall', getUpgradeDirsToInstall_stub)

            let test_result;

            try {
                await processDirectives_rw(test_upgrade_obj);
            } catch(e) {
                test_result = e;
            }

            expect(test_result instanceof Error).to.be.true;
            expect(test_result.message).to.equal(test_err);
        });
    })

    describe('Test runSyncFunctions()', function() {
        let runSyncFunctions_rw = directivesManager_rw.__get__('runSyncFunctions');
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
            runSyncFunctions_rw([func1,func2]);
            assert.equal(results.length, 2, 'Did not get expected function results');
        });

        it('Test exception handling, expect func2 to not run', () => {
            let result = undefined;
            try {
                runSyncFunctions_rw([bad_func,func2]);
            } catch(e) {
                result = e;
            }
            assert.equal((result instanceof Error), true, 'Did not get expected exception');
            assert.equal(results.length, 0, 'Did not get expected function results');
        });

        it('Test runSyncFunctions with null parameter', () => {
            let result = undefined;
            try {
                runSyncFunctions_rw(null);
            } catch(e) {
                result = e;
            }
            assert.equal(results.length, 0, 'Expected empty results array');
        });

        it('Test runSyncFunctions with null parameter', () => {
            let result = undefined;
            try {
                runSyncFunctions_rw(null);
            } catch(e) {
                result = e;
            }
            assert.equal(results.length, 0, 'Expected empty results array');
        });

        it('Test runSyncFunctions with non array parameter', () => {
            let result = undefined;
            try {
                runSyncFunctions_rw('test');
            } catch(e) {
                result = e;
            }
            assert.equal(results.length, 0, 'Expected empty results array');
        });

        it('Test runSyncFunctions with non function values', () => {
            let result = undefined;
            try {
                runSyncFunctions_rw(['test']);
            } catch(e) {
                result = e;
            }
            assert.equal(results.length, 0, 'Expected empty results array');
        });
    });

    describe('Test runAsyncFunctions()', function() {
        let runAsyncFunctions_rw = directivesManager_rw.__get__('runAsyncFunctions');
        let results = [];

        afterEach(function() {
           results = [];
        });

        async function func1() {
          return new Promise((resolve) => {
              results.push('Function 1 running');
              resolve();
          });
        }

        async function func2() {
            return new Promise((resolve) => {
                results.push('Function 2 running');
                resolve();
            });
        }

        async function bad_func() {
            return new Promise((resolve, reject) => {
               reject(new Error('test error'));
            });
        };

        it('Test nominal case with valid functions', async () => {
            await runAsyncFunctions_rw([func1,func2]);
            assert.equal(results.length, 2, 'Did not get expected function results');
        });

        it('Test exception handling, expect func2 to not run', async () => {
            let result = undefined;
            try {
                await runAsyncFunctions_rw([bad_func,func2]);
            } catch(e) {
                result = e;
            }
            assert.equal((result instanceof Error), true, 'Did not get expected exception');
            assert.equal(results.length, 0, 'Did not get expected function results');
        });

        it('Test runAsyncFunctions with null parameter', async () => {
            let result = undefined;
            try {
                await runAsyncFunctions_rw(null);
            } catch(e) {
                result = e;
            }
            assert.equal(results.length, 0, 'Expected empty results array');
        });

        it('Test runAsyncFunctions with null parameter', async () => {
            let result = undefined;
            try {
                await runAsyncFunctions_rw(null);
            } catch(e) {
                result = e;
            }
            assert.equal(results.length, 0, 'Expected empty results array');
        });

        it('Test runAsyncFunctions with non array parameter', async () => {
            let result = undefined;
            try {
                await runAsyncFunctions_rw('test');
            } catch(e) {
                result = e;
            }
            assert.equal(results.length, 0, 'Expected empty results array');
        });

        it('Test runAsyncFunctions with non function values', async () => {
            let result = undefined;
            try {
                await runAsyncFunctions_rw(['test']);
            } catch(e) {
                result = e;
            }
            assert.equal(results.length, 0, 'Expected empty results array');
        });
    });

    describe('Test getUpgradeDirectivesToInstall()', function() {
        let getUpgradeDirectivesToInstall_rw = directivesManager_rw.__get__('getUpgradeDirectivesToInstall');
        let getVersionsForUpgrade_rw = directivesController_stub.__get__('getVersionsForUpgrade');

        it('Test getUpgradeDirectivesToInstall nominal case', function() {
            const test_upgrade_obj = generateUpgradeObj('3.0.0', '4.1.1');
            const loaded_directives = getVersionsForUpgrade_rw(test_upgrade_obj);

            let directives_to_run = getUpgradeDirectivesToInstall_rw(loaded_directives);
            assert.equal(directives_to_run.length, 2, 'Expected 2 version values back');
            assert.equal(directives_to_run[0].version, '3.1.0', 'Expected 3.1.0 version returned');
            assert.equal(directives_to_run[1].version, '4.1.1', 'Expected 4.1.1 version returned');
        });

        it('Test getUpgradeDirectivesToInstall  with invalid number version', function() {
            const test_upgrade_obj = generateUpgradeObj('3.0.0', '4.1.1');
            const loaded_directives = getVersionsForUpgrade_rw(test_upgrade_obj);
            loaded_directives.push(new upgrade_directive('3.1.1.22'));
            let directives_to_run = getUpgradeDirectivesToInstall_rw(loaded_directives);
            assert.equal(directives_to_run.length, 2, 'Expected 2 upgrade numbers back');
            assert.equal(directives_to_run[0].version, '3.1.0', 'Expected 3.1.0 version returned');
            assert.equal(directives_to_run[1].version, '4.1.1', 'Expected 4.1.1 version returned');
        });

        it('Test getUpgradeDirectivesToInstall  with null directive parameter', function() {
            let versions_to_run = getUpgradeDirectivesToInstall_rw(null);
            assert.equal(versions_to_run.length, 0, 'Expected 0 upgrade numbers back');
        });
    });

    // describe('Test getDirectiveChangeDescriptions()', function() {
    //
    //     it('Test getDirectiveChangeDescriptions - nominal case', function() {
    //         const test_upgrade_obj = generateUpgradeObj('3.0.0', '4.1.1');
    //         const change_descriptions = directivesManager_rw.getDirectiveChangeDescriptions(test_upgrade_obj);
    //
    //         assert.equal(change_descriptions.length, 2, 'Expected 2 change descriptions returned');
    //         assert.equal(change_descriptions[0].change_description, 'Change descriptions for 3.1.0', 'Expected 3.1.0 change description returned');
    //         assert.equal(change_descriptions[1].change_description, 'Change descriptions for 4.1.1', 'Expected 4.1.1 change description returned');
    //     });
    //
    //     it('Test getDirectiveChangeDescriptions - no valid versions', function() {
    //         const test_upgrade_obj = generateUpgradeObj('1.0.0', '2.1.1');
    //         const change_descriptions = directivesManager_rw.getDirectiveChangeDescriptions(test_upgrade_obj);
    //
    //         assert.equal(change_descriptions.length, 0, 'Expected 0 change descriptions returned');
    //     });
    //
    //     it('Test getDirectiveChangeDescriptions - versions w/o a change description', function() {
    //         const test_upgrade_obj = [ new upgrade_directive('1.2.3') ];
    //         const change_descriptions = directivesManager_rw.getDirectiveChangeDescriptions(test_upgrade_obj);
    //
    //         assert.equal(change_descriptions.length, 0, 'Expected 0 change descriptions returned');
    //     });
    // });
});



