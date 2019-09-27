'use strict';

const test_utils = require('../../../../test_utils');
test_utils.preTestPrep();
test_utils.buildHeliumTestVolume();

const heliumUtils = require('../../../../../utility/helium/heliumUtils');
const heCreateSchema = require('../../../../../data_layer/harperBridge/heBridge/heMethods/heCreateSchema');
const heCreateTable = require('../../../../../data_layer/harperBridge/heBridge/heMethods/heCreateTable');
const heSearchByValue = require('../../../../../data_layer/harperBridge/heBridge/heMethods/heSearchByValue');
const heCreateRecords = require('../../../../../data_layer/harperBridge/heBridge/heMethods/heCreateRecords');
const heDropTable = require('../../../../../data_layer/harperBridge/heBridge/heMethods/heDropTable');
const rewire = require('rewire');
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

const INSERT_OBJECT_TEST = {
    operation: "insert",
    schema: "dropTableTest",
    table: "donkey",
    records: [
        {
            id: "1",
            name: "Jeff",
            age: "8",
            favorite_food: 'beans'
        },
        {
            id: "2",
            name: "Brian",
            age: "8",
            favorite_food: 'cabbage'
        },
        {
            id: "4",
            name: "Peter",
            age: "8"
        },
        {
            id: "8",
            name: "Meg",
            age: "8",
            favorite_food: 'pizza'
        },
    ]
};

const CREATE_SCHEMA_OBJ_TEST= {
    operation: 'create_schema',
    schema: 'dropTableTest'
};

const CREATE_TABLE_OBJ_TEST = {
    operation: 'create_table',
    schema: 'dropTableTest',
    table: 'donkey',
    hash_attribute: 'id'
};

const TABLE_SYSTEM_DATA_TEST = {
    name: CREATE_TABLE_OBJ_TEST.table,
    schema: CREATE_TABLE_OBJ_TEST.schema,
    id: 'fd23fds',
    hash_attribute: CREATE_TABLE_OBJ_TEST.hash_attribute,
    residence: '*'
};

function setupTest() {
    try {
        heCreateSchema(CREATE_SCHEMA_OBJ_TEST);
        heCreateTable(TABLE_SYSTEM_DATA_TEST, CREATE_TABLE_OBJ_TEST);
        heCreateRecords(INSERT_OBJECT_TEST);
    } catch(err) {
        console.log(err);
    }
}

// TODO: These tests are setting up due to bug #33 (same as other branches)
// Helium throws error. It happens on heCreateRecords halfway through an insertData call in heCreateAttribute
describe('Test Helium function heDropTable', () => {
    before(() => {
        global.hdb_schema = {
            [DROP_TABLE_OBJ_TEST.schema]: {
                [DROP_TABLE_OBJ_TEST.table]: {
                    attributes: [],
                    hash_attribute: HASH_ATTRIBUTE,
                    residence: '*',
                    schema: DROP_TABLE_OBJ_TEST.schema,
                    name: DROP_TABLE_OBJ_TEST.table
                }
            },
            system: {
                hdb_attribute: {
                    hash_attribute:"id",
                    name:"hdb_attribute",
                    schema:"system",
                    residence:["*"],
                    attributes: [
                        {
                            attribute: "id"
                        },
                        {
                            attribute: "schema"
                        },
                        {
                            attribute: "table"
                        },
                        {
                            attribute: "attribute"
                        },
                        {
                            attribute: "schema_table"
                        }
                    ]
                },
                hdb_schema: {
                    hash_attribute:"name",
                    name:"hdb_schema",
                    schema:"system",
                    residence:["*"],
                    attributes:[
                        {
                            "attribute":"name"
                        },
                        {
                            "attribute":"createddate"
                        }
                    ]
                },
                hdb_table: {
                    hash_attribute: "id",
                    name: "hdb_table",
                    schema: "system",
                    residence: ["*"],
                    attributes: [
                        {
                            attribute: "id"
                        },
                        {
                            attribute: "name"
                        },
                        {
                            attribute: "hash_attribute"
                        },
                        {
                            attribute: "schema"
                        },
                        {
                            attribute: "residence"
                        }
                    ]
                }
            }
        };
        setupTest();
    });

    after(() => {
        test_utils.teardownHeliumTestVolume(global.hdb_helium);
        delete global.hdb_schema[DROP_TABLE_OBJ_TEST.schema];
    });
    
    context('Test heDropTable function', () => {
        it('Temp...', () => {
            try {
                console.log(heDropTable(DROP_TABLE_OBJ_TEST));
            } catch(err) {
                console.log(err);
            }
        });
    
    });

});
