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

const FS_DIR_TEST = test_utils.getMockFSPath();
const HASH_ATTR_TEST = 'id';
const CREATE_ATTR_OBJ_TEST = {
    operation: "create_attribute",
    schema: "attrUnitTest",
    table: "dog",
    attribute: "another_attribute",
};
const TEST_DATA_DOG = [
    {
        age: 5,
        breed: "Mutt",
        id: 8,
        name: "Harper"
    },
    {
        age: 5,
        breed: "Mutt",
        id: 9,
        name: "Penny"
    }
];


describe('Tests for file system module fsCreateAttribute', () => {

    context('Tests for createAttribute function', () => {
        let mock_fs;

        before(() => {
            mock_fs = test_utils.createMockFS(HASH_ATTR_TEST, CREATE_ATTR_OBJ_TEST.schema, CREATE_ATTR_OBJ_TEST.table, TEST_DATA_DOG);
            fsCreateAttribute.__set__('HDB_PATH', FS_DIR_TEST);
        });

        it('testtt', async () => {
            await fsCreateAttribute(CREATE_ATTR_OBJ_TEST);
        });

    });

});
