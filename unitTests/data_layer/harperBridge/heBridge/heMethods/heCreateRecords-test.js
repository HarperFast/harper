'use strict';

const test_utils = require('../../../../test_utils');
test_utils.preTestPrep();

const rewire = require('rewire');
const heCreateRecords = rewire('../../../../../data_layer/harperBridge/heBridge/heMethods/heCreateRecords');
const heliumUtils = require('../../../../../utility/helium/heliumUtils');
const hdb_helium = heliumUtils.initializeHelium();
const chai = require('chai');
const sinon = require('sinon');
const sinon_chai = require('sinon-chai');
const { expect } = chai;
chai.use(sinon_chai);

const INSERT_OBJECT_TEST = {
    operation: "insert",
    schema: "dev",
    table: "dog",
    records: [
        {
            name: "Harper",
            breed: "Mutt",
            id: "8",
            age: 5
        },
        {
            name: "Penny",
            breed: "Mutt",
            id: "9",
            age: 5,
            height: 145
        },
        {
            name: "David",
            breed: "Mutt",
            id: "12"
        },
        {
            name: "Rob",
            breed: "Mutt",
            id: "10",
            age: 5,
            height: 145
        }
    ]
};

const NO_NEW_ATTR_TEST = [
    {
        attribute: "name"
    },
    {
        attribute: "breed"
    },
    {
        attribute: "age"
    },
    {
        attribute: "id"
    },
    {
        attribute: "height"
    }
];

const SCHEMA_TABLE_TEST = {
    id: "c43762be-4943-4d10-81fb-1b857ed6cf3a",
    name: "dog",
    hash_attribute: "id",
    schema: "dev",
    attributes: []
};

const DATASTORES_TEST = [ "dev/dog/name", "dev/dog/breed", "dev/dog/id", "dev/dog/age", "dev/dog/height" ];

function dropTestDatastores() {
    try {
        hdb_helium.deleteDataStores(DATASTORES_TEST);
    } catch(err) {
        console.log(err);
    }
}

describe('Tests for Helium method heCreateRecords', () => {
    let sandbox = sinon.createSandbox();

    after(() => {
        sandbox.restore();
        rewire('../../../../../data_layer/harperBridge/heBridge/heMethods/heCreateAttribute');
    });

    context('Test createRecords function', () => {
        let row_keys = ['8', '9', '12', '10'];

        before(() => {
            global.hdb_schema = {
                [SCHEMA_TABLE_TEST.schema]: {
                    [SCHEMA_TABLE_TEST.name]: {
                        attributes: SCHEMA_TABLE_TEST.attributes,
                        hash_attribute: SCHEMA_TABLE_TEST.hash_attribute,
                        residence: SCHEMA_TABLE_TEST.residence,
                        schema: SCHEMA_TABLE_TEST.schema,
                        name: SCHEMA_TABLE_TEST.name
                    }
                }
            };
        });
        
        it('Test that rows are inserted correctly and return msg is correct ', async () => {
            let expected_search_result = [
                [ '8', [ 'Harper', 'Mutt', '8', '5', null ] ],
                [ '9', [ 'Penny', 'Mutt', '9', '5', '145' ] ],
                [ '12', [ 'David', 'Mutt', '12', null, null ] ],
                [ '10', [ 'Rob', 'Mutt', '10', '5', '145' ] ]
            ];
            let expected_return_result = {
                written_hashes: [ '8', '9', '12', '10' ],
                skipped_hashes: [],
                schema_table: {
                    attributes: [],
                    hash_attribute: 'id',
                    residence: undefined,
                    schema: 'dev',
                    name: 'dog'
                }
            };
            let result;
            let search_result;
            
            try {
                result = await heCreateRecords(INSERT_OBJECT_TEST);
                search_result = hdb_helium.searchByKeys(row_keys, DATASTORES_TEST);

            } catch(err) {
                console.log(err);
            }

            expect(result).to.eql(expected_return_result);
            expect(search_result).eql(expected_search_result);
            //dropTestDatastores();
        });

        it('Test inserting existing and non-existing rows', async () => {
            global.hdb_schema[SCHEMA_TABLE_TEST.schema][SCHEMA_TABLE_TEST.name]['attributes'] = NO_NEW_ATTR_TEST;
            let insert_obj = test_utils.deepClone(INSERT_OBJECT_TEST);
            let new_records = [
                {
                    name: "Harper",
                    breed: "Mutt",
                    id: "8",
                    age: 5
                },
                {
                    name: "Penny",
                    breed: "Mutt",
                    id: "9",
                    age: 5,
                    height: 145
                },
                {
                    name: "David",
                    breed: "Mutt",
                    id: "123"
                },
                {
                    name: "Rob",
                    breed: "Mutt",
                    id: "1232",
                    age: 5,
                    height: 145
                }
            ];
            insert_obj.records = new_records;
            let expected_return_result = {
                written_hashes: [ '123', '1232' ],
                skipped_hashes: [ '8', '9' ],
                schema_table: {
                    attributes: NO_NEW_ATTR_TEST,
                    hash_attribute: 'id',
                    residence: undefined,
                    schema: 'dev',
                    name: 'dog'
                    }
            };
            let expected_search_result = [
                [ '8', [ 'Harper', 'Mutt', '8', '5', null ] ],
                [ '9', [ 'Penny', 'Mutt', '9', '5', '145' ] ],
                [ '123', [ 'David', 'Mutt', '123', null, null ] ],
                [ '1232', [ 'Rob', 'Mutt', '1232', '5', '145' ] ]
            ];
            let result;
            let search_result;

            try {
                result = await heCreateRecords(insert_obj);
                search_result = hdb_helium.searchByKeys(['8', '9', '123', '1232'], DATASTORES_TEST);
                dropTestDatastores();
            } catch(err) {
                console.log(err);
            }

            expect(result).to.eql(expected_return_result);
            expect(search_result).to.eql(expected_search_result);
        });
    });
});