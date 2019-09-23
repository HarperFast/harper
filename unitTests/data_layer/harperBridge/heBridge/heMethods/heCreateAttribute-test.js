'use strict';

const test_utils = require('../../../../test_utils');
test_utils.preTestPrep();

const heliumUtils = require('../../../../../utility/helium/heliumUtils');
const rewire = require('rewire');
const heCreateAttribute = rewire('../../../../../data_layer/harperBridge/heBridge/heMethods/heCreateAttribute');
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

const INSERT_OBJ_TEST = {
    operation: "insert",
    schema: "system",
    table: "hdb_attribute",
    hash_attribute: "id",
    records: [
    {
        "schema": "I am a test",
        "table": "Not really a table",
        "id": 45
    }
]
};

function dropTestDataStores() {
    try {
        test_utils.deleteSystemDataStores(hdb_helium);
        hdb_helium.deleteDataStores([`${CREATE_ATTR_OBJ_TEST.schema}/${CREATE_ATTR_OBJ_TEST.table}/${CREATE_ATTR_OBJ_TEST.attribute}`]);
    } catch(err) {
        console.log(err);
    }
}

const SYSTEM_ATTR_SCHEMA = ['system/hdb_attribute/id', 'system/hdb_attribute/schema', 'system/hdb_attribute/table', 'system/hdb_attribute/attribute', 'system/hdb_attribute/schema_table'];

describe('Test for Helium method heCreateAttribute', () => {
    let sandbox = sinon.createSandbox();

    before(() => {
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

    after(() => {
        sandbox.restore();
        rewire('../../../../../data_layer/harperBridge/heBridge/heMethods/heCreateAttribute');
        dropTestDataStores();
    });

    context('Tests for heCreateAttribute function', () => {
        let uuidV4_stub_func = () => '83j243dz';

        before(() => {
            heCreateAttribute.__set__('uuidV4', uuidV4_stub_func);
        });

        it('Test that a datastore is created and system schema updated with new attribute', () => {
            let expected_result = {
                message: 'inserted 1 of 1 records',
                skipped_hashes: [],
                inserted_hashes: [ '83j243dz' ]
            };
            let expected_search_result =
                [ [ '83j243dz',
                [ '83j243dz',
                    'attrUnitTest',
                    'dog',
                    'another_attribute',
                    'attrUnitTest.dog' ] ] ];
            let result;
            let search_result;
            let list_ds_result;

            try {
                result = heCreateAttribute(CREATE_ATTR_OBJ_TEST);
                search_result = hdb_helium.searchByKeys(['83j243dz'], SYSTEM_ATTR_SCHEMA);
                list_ds_result = hdb_helium.listDataStores();
            } catch(err) {
                console.log(err);
            }

            expect(result).to.eql(expected_result);
            expect(search_result).to.eql(expected_search_result);
            expect(list_ds_result.includes('attrUnitTest/dog/another_attribute')).to.be.true;
        });

        // TODO: right now this is throwing a bad error if datastore already exists. It shouldn't do that. Waiting on update from levyx
       /* it('Test that datastore is not created because it already exists', () => {
            let expected_result = {
                message: 'inserted 0 of 1 records',
                skipped_hashes: ['83j243dz'],
                inserted_hashes: []
            };
            let result;

            try {
                result = heCreateAttribute(CREATE_ATTR_OBJ_TEST);
            } catch(err) {
                console.log(err);
            }

            expect(result).to.eql(expected_result);
        });*/

       it('Test that validation error is thrown', () => {
           let create_attr_obj = test_utils.deepClone(CREATE_ATTR_OBJ_TEST);
           create_attr_obj.attribute = '';
           let error;
           try {
               heCreateAttribute(create_attr_obj);
           } catch(err) {
               error = err;
           }

           expect(error.message).to.equal('Attribute  is required');
       });

       it('Test that attribute already exists error thrown from check on global schema', () => {
           global.hdb_schema[CREATE_ATTR_OBJ_TEST.schema][CREATE_ATTR_OBJ_TEST.table]['attributes'] = [{attribute: CREATE_ATTR_OBJ_TEST.attribute}];
           let error;
           try {
               heCreateAttribute(CREATE_ATTR_OBJ_TEST);
           } catch(err) {
               error = err;
           }

           expect(error.message).to.equal(`attribute '${CREATE_ATTR_OBJ_TEST.attribute}' already exists in ${CREATE_ATTR_OBJ_TEST.schema}.${CREATE_ATTR_OBJ_TEST.table}`);
           expect(error).to.be.an.instanceOf(Error);
       });
    });

    context('Test insertData function', () => {
        let insert_data = heCreateAttribute.__get__('insertData');

        it('Test that a record is inserted ', () => {
            let inserted_ds = ['system/hdb_attribute/schema', 'system/hdb_attribute/table', 'system/hdb_attribute/id'];
            let expected_result = {
                message: 'inserted 1 of 1 records',
                skipped_hashes: [],
                inserted_hashes: [ '45' ]
            };
            let expected_search_result = [ [ '45', [ 'I am a test', 'Not really a table', '45' ] ] ];
            let result;
            let search_result;

            try {
                result = insert_data(INSERT_OBJ_TEST);
                search_result = hdb_helium.searchByKeys([45], inserted_ds);
            } catch(err) {
                console.log(err);
            }

            expect(result).to.eql(expected_result);
            expect(search_result).to.eql(expected_search_result)
        });
    });
});
