'use strict';

// const test_util = require('../../../test_utils');
// test_util.preTestPrep();
const test_vers3_0_0 = require('./testDirectives/3-0-0_stub');
const test_vers3_0_1 = require('./testDirectives/3-0-1_stub');
const test_vers4_1_1 = require('./testDirectives/4-1-1_stub');

const rewire = require('rewire');
const directivesController_rw = rewire('../../../upgrade/directives/directivesController');

let test_map = new Map();
test_map.set(test_vers3_0_0.version, test_vers3_0_0);
test_map.set(test_vers4_1_1.version, test_vers4_1_1);
test_map.set(test_vers3_0_1.version, test_vers3_0_1);

directivesController_rw.__set__('versions', test_map);

module.exports = directivesController_rw;
