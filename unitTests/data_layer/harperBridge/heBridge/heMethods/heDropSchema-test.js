'use strict';

const rewire = require('rewire');

let heDropSchema = rewire('../../../../../data_layer/harperBridge/heBridge/heMethods/heDropSchema');
const hdb_terms = require('../../../../../utility/hdbTerms');
const test_utils = require('../../../../test_utils');
const chai = require('chai');
const sinon = require('sinon');
const { expect } = chai;

let sandbox;
let heDeleteRecords_stub;
let heDropTable_stub;


const DROP_SCHEMA_OBJ_TEST = {
    operation: "drop_schema",
    schema: "dropTest",
};
const TABLES_TEST = [{id: '123d24'}];
