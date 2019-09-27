'use strict';

const test_utils = require('../../../../test_utils');
test_utils.preTestPrep();
test_utils.buildHeliumTestVolume();

const rewire = require('rewire');
const heCreateAttribute = require('../../../../../data_layer/harperBridge/heBridge/heMethods/heCreateAttribute');
const heDropAllAttribute = require('../../../../../data_layer/harperBridge/heBridge/heUtility/heDropAllAttributes');
const heliumUtils = require('../../../../../utility/helium/heliumUtils');
const chai = require('chai');
const { expect } = chai;

let hdb_helium;
try {
    heliumUtils.createSystemDataStores();
    hdb_helium = heliumUtils.initializeHelium();
} catch(err) {
    console.log(err);
}


const DROP_OBJ_TEST= {
    operation: "drop_table",
    schema: "dropAllAttr",
    table: "dog"
};

const ATTRIBUTES = ['age', 'height', 'weight', 'address', 'id', 'owner'];

const ATTRIBUTES_SYS = [{attribute: 'age'}, {attribute: 'height'}, {attribute: 'weight'}, {attribute: 'address'}, {attribute: 'id'}, {attribute: 'owner'}];
const DATASTORES = ['dropAllAttr/dog/age', 'dropAllAttr/dog/height', 'dropAllAttr/dog/weight', 'dropAllAttr/dog/address', 'dropAllAttr/dog/id', 'dropAllAttr/dog/owner'];

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

        // TODO: this timeout is a temporary fix. GitHub issue - harperdb_helium #33 THIS IS CAUSING OTHER UNIT TESTS TO FAIL
        //setTimeout(() => {hdb_helium.createDataStores(DATASTORES);}, 500);
    } catch(err) {
        throw err;
    }
}

describe('Tests for Helium method heDropAttribute', () => {

    before(() => {
        global.hdb_schema = {
            [DROP_OBJ_TEST.schema]: {
                [DROP_OBJ_TEST.table]: {
                    attributes: ATTRIBUTES_SYS
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
    });

    after(() => {
        test_utils.teardownHeliumTestVolume(global.hdb_helium);
        global.hdb_schema = {};
    });

    context('Test heDropAllAttribute function', () => {

        it('Test that all the test attributes are dropped', () => {
            try {
                console.log(heDropAllAttribute(DROP_OBJ_TEST));
                console.log(hdb_helium.listDataStores());
                console.log('hello');
            } catch(err) {
                console.log(err);

            }
        });
    });
});