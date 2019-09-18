'use strict';

const test_utils = require('../../../../test_utils');
test_utils.preTestPrep();

const rewire = require('rewire');
const heCreateAttribute = rewire('../../../../../data_layer/harperBridge/heBridge/heMethods/heCreateAttribute');
const heliumUtils = require('../../../../../utility/helium/heliumUtils');
const log = require('../../../../../utility/logging/harper_logger');
const chai = require('chai');
const sinon = require('sinon');
const sinon_chai = require('sinon-chai');
const { expect } = chai;
chai.use(sinon_chai);

try {
    heliumUtils.createSystemDataStores();
} catch(err) {
    console.log(err);
}

const hdb_helium = heliumUtils.initializeHelium();

const CREATE_ATTR_OBJ_TEST = {
    operation: "create_attribute",
    schema: "attrUnitTest",
    table: "dog",
    attribute: "another_attribute",
};

const SYSTEM_ATTR_SCHEMA = ['system/hdb_attribute/id', 'system/hdb_attribute/schema', 'system/hdb_attribute/table', 'system/hdb_attribute/attribute', 'system/hdb_attribute/schema_table'];

describe('Test for Helium method heCreateAttribute', () => {
    let sandbox = sinon.createSandbox();

    after(() => {
        sandbox.restore();
        rewire('../../../../../data_layer/harperBridge/heBridge/heMethods/heCreateAttribute');
    });

    context('Tests for heCreateAttribute function', () => {
        let uuidV4_stub_func = () => '83j243dz';

        before(() => {
            heCreateAttribute.__set__('uuidV4', uuidV4_stub_func);

            global.hdb_schema = {
                [CREATE_ATTR_OBJ_TEST.schema]: {
                    [CREATE_ATTR_OBJ_TEST.table]: {
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
        });

        it('', () => {
            try {
                let result = heCreateAttribute(CREATE_ATTR_OBJ_TEST);
                let search_result = hdb_helium.searchByKeys(['83j243dz'], SYSTEM_ATTR_SCHEMA);
                console.log(result);
                console.log(search_result);
            } catch(err) {
                console.log(err);
            }
        });

    });

});