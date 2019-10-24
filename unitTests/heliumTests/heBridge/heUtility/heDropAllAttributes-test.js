'use strict';

const test_utils = require('../../../test_utils');
test_utils.preTestPrep();
let hdb_helium = test_utils.buildHeliumTestVolume();

const heCreateAttribute = require('../../../../data_layer/harperBridge/heBridge/heMethods/heCreateAttribute');
const heDropAllAttribute = require('../../../../data_layer/harperBridge/heBridge/heUtility/heDropAllAttributes');
const assert = require('assert');

const DROP_OBJ_TEST= {
    operation: "drop_table",
    schema: "dropAllAttr",
    table: "dog"
};

const ATTRIBUTES = ['age', 'height', 'weight', 'address', 'id', 'owner'];

const ATTRIBUTES_SYS = [{attribute: 'age'}, {attribute: 'height'}, {attribute: 'weight'}, {attribute: 'address'}, {attribute: 'id'}, {attribute: 'owner'}];
const ATTRIBUTES_SYS_PLUS_NO_EXIST = [{attribute: 'age'}, {attribute: 'height'},{attribute: 'blerg'}, {attribute: 'weight'}, {attribute: 'address'}, {attribute: 'id'}, {attribute: 'owner'}];

function setupTest() {
    try {
        ATTRIBUTES.forEach((attr) => {
            let create_attr = {
                operation: "create_attribute",
                schema: "dropAllAttr",
                table: "dog",
                attribute: attr,
            };
            heCreateAttribute(create_attr);
        });

    } catch(err) {
        throw err;
    }
}

describe('Tests for Helium method heDropAllAttributes', () => {

    beforeEach(() => {

        global.hdb_schema = {
            [DROP_OBJ_TEST.schema]: {
                [DROP_OBJ_TEST.table]: {
                    hash_attribute:"id",
                    name: DROP_OBJ_TEST.table,
                    schema: DROP_OBJ_TEST.schema,
                    attributes: []
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
                }
            }
        };
        setupTest();
        global.hdb_schema[DROP_OBJ_TEST.schema][DROP_OBJ_TEST.table].attributes = ATTRIBUTES_SYS;

    });

    after(() => {
        test_utils.teardownHeliumTestVolume(global.hdb_helium);
        global.hdb_schema = {};
    });

    context('Test heDropAllAttribute function', () => {

        it('Test invalid schema', ()=>{
            let drop_obj = test_utils.deepClone(DROP_OBJ_TEST);
            drop_obj.schema = 'blerg';
            assert.throws(()=>{
                heDropAllAttribute(drop_obj);
            }, new Error(`unknown schema:${drop_obj.schema} and table ${drop_obj.table}`));
        });

        it('Test invalid table', ()=>{
            let drop_obj = test_utils.deepClone(DROP_OBJ_TEST);
            drop_obj.table = 'blerg';
            assert.throws(()=>{
                heDropAllAttribute(drop_obj);
            }, new Error(`unknown schema:${drop_obj.schema} and table ${drop_obj.table}`));
        });

        it('Test drop all with an attribute that does not exist', ()=>{
            let drop_obj = test_utils.deepClone(DROP_OBJ_TEST);
            global.hdb_schema[DROP_OBJ_TEST.schema][DROP_OBJ_TEST.table].attributes = ATTRIBUTES_SYS_PLUS_NO_EXIST;
            assert.doesNotThrow(()=>{
                heDropAllAttribute(drop_obj);
            }, new Error(`unknown schema:${drop_obj.schema} and table ${drop_obj.table}`));
        });

        it('Test that all the test attributes are dropped', () => {
            try {
                assert.doesNotThrow(()=>{
                    heDropAllAttribute(DROP_OBJ_TEST);
                });

                let data_stores = hdb_helium.listDataStores(`${DROP_OBJ_TEST.schema}/(.*)`);

                assert(data_stores.length === 0);
            } catch(err) {
                console.log(err);

            }
        });
    });
});