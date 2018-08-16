"use strict";
const path = require('path');
const test_util = require('../test_utils');

test_util.preTestPrep();

const assert = require('assert');
let sinon = require('sinon');
let fs = require('fs');

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