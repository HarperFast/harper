'use strict';

const test_utils = require('../../../../test_utils');
const rewire = require('rewire');
let fsDropTable = rewire('../../../../../data_layer/harperBridge/fsBridge/fsMethods/fsDropTable');
const log = require('../../../../../utility/logging/harper_logger');
const terms = require('../../../../../utility/hdbTerms');
const chai = require('chai');
const sinon = require('sinon');
const sinon_chai = require('sinon-chai');
const { expect } = chai;
chai.use(sinon_chai);

const DROP_TABLE_OBJ_TEST = {
    operation: "drop_table",
    schema: "dev",
    table: "dog"
};

const SEARCH_RESULT_TEST = [
    {
        "name": "dog",
        "schema": "dev",
        "id": "12345"
    }
];

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

const HASH_ATTRIBUTE = 'id';

describe('Tests for file system module fsDropTable', () => {
    let sandbox = sinon.createSandbox();
    let mock_fs;
    
    before(() => {
        mock_fs = test_utils.createMockFS(HASH_ATTRIBUTE, DROP_TABLE_OBJ_TEST.schema, DROP_TABLE_OBJ_TEST.table, TEST_DATA_DOG);
    });
    
    after(() => {
        sandbox.restore();
        rewire('../../../../../data_layer/harperBridge/fsBridge/fsMethods/fsDropTable');
        test_utils.tearDownMockFS();
    });
    
    it('Test that mock filesystem has table dropped as expected ', () => {
        
    });

});