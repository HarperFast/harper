'use strict';

const test_utils = require('../../../../test_utils');
test_utils.preTestPrep();
test_utils.buildHeliumTestVolume();

const heCreateAttribute = require('../../../../../data_layer/harperBridge/heBridge/heMethods/heCreateAttribute');
const heDropAttribute = require('../../../../../data_layer/harperBridge/heBridge/heMethods/heDropAttribute');
const heGenerateDataStoreName = require('../../../../../data_layer/harperBridge/heBridge/heUtility/heGenerateDataStoreName');
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

const DROP_ATTR_OBJ_TEST = {
    operation: "drop_attribute",
    schema: "dropAttr",
    table: "dog",
    attribute: "another_attribute"
};

// const CREATE_ATTR_OBJ_TEST = {
//     operation: "create_attribute",
//     schema: "attrUnitTest",
//     table: "dog",
//     attribute: "",
// };

const ATTRIBUTES = ['age', 'height', 'weight'];
const DATASTORES = ['dropAttr/dog/age', 'dropAttr/dog/height', 'dropAttr/dog/weight'];

function setupTest() {
    try {
        ATTRIBUTES.forEach((attr) => {
            let create_attr = {
                operation: "create_attribute",
                schema: "dropAttr",
                table: "dog",
                attribute: attr,
            };
            heCreateAttribute(create_attr);
        });

        // setTimeout(() => {hdb_helium.createDataStores(DATASTORES);}, 1000);
        hdb_helium.createDataStores(DATASTORES);
    } catch(err) {
        throw err;
    }
}

describe('Tests for Helium method heDropAttribute', () => {

    before(() => {
        global.hdb_schema = {
            [DROP_ATTR_OBJ_TEST.schema]: {
                [DROP_ATTR_OBJ_TEST.table]: {
                    attributes: [{attribute: 'test'}]
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
    });


    context('Test heDropAttribute function', () => {
        it('ds', () => {
            console.log('Test');
            // try {
            //     console.log(heDropAttribute(DROP_ATTR_OBJ_TEST));
            // } catch(err) {
            //     console.log(err);
            // }
        });

    });

});