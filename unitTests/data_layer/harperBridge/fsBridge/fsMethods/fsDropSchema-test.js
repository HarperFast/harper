'use strict';

const test_utils = require('../../../../test_utils');
test_utils.preTestPrep();

const rewire = require('rewire');
let fsDropSchema = require('../../../../../data_layer/harperBridge/fsBridge/fsMethods/fsDropSchema');
let fsDeleteRecords = rewire('../../../../../data_layer/harperBridge/fsBridge/fsMethods/fsDeleteRecords');
let search = rewire('../../../../../data_layer/search');
const log = require('../../../../../utility/logging/harper_logger');
const fs = require('graceful-fs');
const chai = require('chai');
const sinon = require('sinon');
const sinon_chai = require('sinon-chai');
const { expect } = chai;
chai.use(sinon_chai);

const HASH_ATTRIBUTE_TEST = 'id';
const TABLE_TEST = 'animal';
const SCHEMA_TEST = 'dropTest';
const FS_DIR_TEST = test_utils.getMockFSPath();
const TABLE_DATA_TEST = [
    {
        age: 17,
        species: "Panda",
        id: 1,
        name: "Gary"
    },
    {
        age: 5,
        species: "Wolf",
        id: 2,
        name: "Sid"
    }
];
const DROP_SCHEMA_OBJ_TEST = {
    operation: "drop_schema",
    schema: "dropTest",
};


describe('Tests for file system module fsDropSchema', () => {


    context('Tests for dropSchema function', () => {

    });

    context('Tests for moveSchemaToTrash function', () => {

    });

});