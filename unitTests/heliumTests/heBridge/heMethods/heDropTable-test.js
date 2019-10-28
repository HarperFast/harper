'use strict';

const test_utils = require('../../../test_utils');
test_utils.preTestPrep();
let hdb_helium = test_utils.buildHeliumTestVolume();

const heCreateSchema = require('../../../../data_layer/harperBridge/heBridge/heMethods/heCreateSchema');
const heCreateTable = require('../../../../data_layer/harperBridge/heBridge/heMethods/heCreateTable');
const heSearchByValue = require('../../../../data_layer/harperBridge/heBridge/heMethods/heSearchByValue');
const heCreateRecords = require('../../../../data_layer/harperBridge/heBridge/heMethods/heCreateRecords');
const heDropTable = require('../../../../data_layer/harperBridge/heBridge/heMethods/heDropTable');

const hdb_terms = require('../../../../utility/hdbTerms');
const assert = require('assert');

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
    id: 'thedroptabletest',
    hash_attribute: CREATE_TABLE_OBJ_TEST.hash_attribute,
    residence: '*'
};

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
        try {
            heCreateSchema(CREATE_SCHEMA_OBJ_TEST);
            heCreateTable(TABLE_SYSTEM_DATA_TEST, CREATE_TABLE_OBJ_TEST);
            heCreateRecords(INSERT_OBJECT_TEST);
            global.hdb_schema[CREATE_TABLE_OBJ_TEST.schema][CREATE_TABLE_OBJ_TEST.table].attributes = ATTRIBUTES_TEST;
        } catch(err) {
            console.log(err);
        }
    });

    after(() => {
        test_utils.teardownHeliumTestVolume(global.hdb_helium);
        delete global.hdb_schema[DROP_TABLE_OBJ_TEST.schema];
    });

        it('test happy path', () => {
            assert.doesNotThrow(()=>{
                heDropTable(DROP_TABLE_OBJ_TEST);
            });

            let data_stores = hdb_helium.listDataStores(`${DROP_TABLE_OBJ_TEST.schema}/${DROP_TABLE_OBJ_TEST.table}/(.*)`);
            assert(Array.isArray(data_stores) && data_stores.length === 0);

            let search_obj = {
                schema: hdb_terms.SYSTEM_SCHEMA_NAME,
                table: hdb_terms.SYSTEM_TABLE_NAMES.TABLE_TABLE_NAME,
                search_attribute: hdb_terms.SYSTEM_DEFAULT_ATTRIBUTE_NAMES.ATTR_NAME_KEY,
                search_value: DROP_TABLE_OBJ_TEST.table,
                get_attributes: [hdb_terms.SYSTEM_DEFAULT_ATTRIBUTE_NAMES.ATTR_NAME_KEY, hdb_terms.SYSTEM_DEFAULT_ATTRIBUTE_NAMES.ATTR_SCHEMA_KEY, hdb_terms.SYSTEM_DEFAULT_ATTRIBUTE_NAMES.ATTR_ID_KEY]
            };
            let results = heSearchByValue(search_obj);

            assert(Array.isArray(results) && results.length === 0);
        });

});
