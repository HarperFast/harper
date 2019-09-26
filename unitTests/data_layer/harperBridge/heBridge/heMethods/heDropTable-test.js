'use strict';

const test_utils = require('../../../../test_utils');
test_utils.preTestPrep();
test_utils.buildHeliumTestVolume();

const heliumUtils = require('../../../../../utility/helium/heliumUtils');
const rewire = require('rewire');
const heDropTable = rewire('../../../../../data_layer/harperBridge/heBridge/heMethods/heDropTable');
const chai = require('chai');
const { expect } = chai;

let hdb_helium;
try {
    heliumUtils.createSystemDataStores();
    hdb_helium = heliumUtils.initializeHelium();
} catch(err) {
    console.log(err);
}

const DROP_TABLE_OBJ_TEST = {
    operation: "drop_table",
    schema: "dropTableTest",
    table: "donkey"
};
const ATTRIBUTES_TEST = [
    {
        attribute: "id"
    },
    {
        attribute: "name"
    },
    {
        attribute: "age"
    },
    {
        attribute: "favorite_food"
    },
    {
        attribute: "__createdtime__"
    },
    {
        attribute: "__updatedtime__"
    }
];
const HASH_ATTRIBUTE = 'id';
const DATASTORES_TEST = [ "dropTableTest/donkey/id", "dropTableTest/donkey/name", "dropTableTest/donkey/age", "dropTableTest/donkey/favorite_food", "dropTableTest/donkey/__createdtime__", "deleteTest/donkey/__updatedtime__"];
const TABLE_DATA_TEST = [
    [ '1', [ '1', 'Jeff', '8', 'beans', '1943201', '1943201'] ],
    [ '2', [ '2', 'Brian', '9', 'cabbage', '1943201', '1943201' ] ],
    [ '4', [ '4', 'Peter', '12', null, '1943201', '1943201' ] ],
    [ '8', [ '8', 'Meg', '10', 'pizza', '1943201', '1943201' ] ]
];

function setupTest() {
    try {
        hdb_helium.createDataStores(DATASTORES_TEST);
        hdb_helium.insertRows(DATASTORES_TEST, TABLE_DATA_TEST);
    } catch(err) {
        console.log(err);
    }
}

describe('Test Helium function heDropTable', () => {
    before(() => {
        setupTest();
        global.hdb_schema = {
            [DROP_TABLE_OBJ_TEST.schema]: {
                [DROP_TABLE_OBJ_TEST.table]: {
                    attributes: ATTRIBUTES_TEST,
                    hash_attribute: HASH_ATTRIBUTE
                }
            }
        };
    });

    after(() => {
        test_utils.teardownHeliumTestVolume(global.hdb_helium);
        delete global.hdb_schema[DROP_TABLE_OBJ_TEST.schema];
    });

});