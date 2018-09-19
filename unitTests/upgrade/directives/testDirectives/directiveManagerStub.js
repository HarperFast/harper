'use strict';
const path = require('path');
const test_util = require('../../../test_utils');

test_util.preTestPrep();

const assert = require('assert');
const sinon = require('sinon');
const fs = require('fs');
const hdb_utils = require('../../../../utility/common_utils');

const test_vers1_1_0 = require('./1-1-0');
const test_vers1_1_1 = require('./1-1-1');
const test_vers2_1_0 = require('./2-1-0');

const rewire = require('rewire');
const directive_manager_rw = rewire('../../../../upgrade/directives/directiveManager');

let test_map = new Map();
test_map.set(test_vers1_1_0.version, test_vers1_1_0);
test_map.set(test_vers1_1_1.version, test_vers1_1_1);
test_map.set(test_vers2_1_0.version, test_vers2_1_0);

directive_manager_rw.__set__('versions', test_map);

module.exports = {
    directive_manager_rw: directive_manager_rw
};