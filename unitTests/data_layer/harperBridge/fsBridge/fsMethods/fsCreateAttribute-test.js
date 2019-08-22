'use strict';
const test_utils = require('../../../../test_utils');
test_utils.preTestPrep();

const rewire = require('rewire');
let fsCreateAttribute = rewire('../../../../../data_layer/harperBridge/fsBridge/fsMethods/fsCreateAttribute');
const log = require('../../../../../utility/logging/harper_logger');
const hdb_terms = require('../../../../../utility/hdbTerms');
const chai = require('chai');
const sinon = require('sinon');
const sinon_chai = require('sinon-chai');
const { expect } = chai;
chai.use(sinon_chai);

const CREATE_ATTR_OBJ_TEST = {
    "operation": "create_attribute",
    "schema": "attrUnitTest",
    "table": "dog",
    "attribute": "another_attribute",
};

