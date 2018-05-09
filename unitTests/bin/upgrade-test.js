"use strict";
const path = require('path');
const test_util = require('../test_utils');

test_util.preTestPrep();

const assert = require('assert');
let sinon = require('sinon');
let fs = require('fs');

const rewire = require('rewire');
const upgrade_rw = rewire(`../../bin/upgrade`);
const upgrade_directive = require('../../utility/install/installRequirements/UpgradeDirective');
const BASE = process.cwd();

describe('Test processDirectives', function() {
    upgrade_rw.__set__('hdb_base', BASE + '/../');
    let startUpgradeDirectives = upgrade_rw.__get__('startUpgradeDirectives');
    it('test startUpgradeDirectives', function() {
        startUpgradeDirectives('0.0.1', '1.1.0');

    });
});