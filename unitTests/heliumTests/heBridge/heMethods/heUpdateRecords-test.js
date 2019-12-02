'use strict';

const test_utils = require('../../../test_utils');
test_utils.preTestPrep();
let hdb_helium = test_utils.buildHeliumTestVolume();

const heUpdateRecords = require('../../../../data_layer/harperBridge/heBridge/heMethods/heUpdateRecords');
const chai = require('chai');
const sinon = require('sinon');
const sinon_chai = require('sinon-chai');
const { expect } = chai;
chai.use(sinon_chai);

const UPDATE_OBJECT_TEST = {
    operation: "update",
    schema: "dev",
    table: "dog",
    records: [
        {
            name: "Beethoven",
            breed: "St. Bernard",
            id: "34",
            age: 5
        },
        {
            name: "Elvis",
            breed: "Mutt",
            id: "35",
            age: 5,
            height: 145
        },
        {
            name: "David",
            breed: "Husky",
            id: "36"
        },
        {
            name: "Brian",
            breed: "Cartoon",
            id: "37",
            age: 5,
            height: 145
        }
    ]
};

const ATTRIBUTES_TEST = [
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
    },
    {
        attribute: "__createdtime__"
    },
    {
        attribute: "__updatedtime__"
    }
];

const SCHEMA_TABLE_TEST = {
    id: "c43762be-4943-4d10-81fb-1b857ed6cf3a",
    name: "dog",
    hash_attribute: "id",
    schema: "dev",
    attributes: []
};

const DATASTORES_TEST = [ "dev/dog/name", "dev/dog/breed", "dev/dog/id", "dev/dog/age", "dev/dog/height", "dev/dog/__createdtime__", "dev/dog/__updatedtime__"];

describe('Tests for Helium method heUpdateRecords', () => {
    let sandbox = sinon.createSandbox();
    let row_keys = ['34', '35', '36', '37'];

    before(() => {
        sandbox.stub(Date, 'now').returns('1943201');
        global.hdb_schema = {
            [SCHEMA_TABLE_TEST.schema]: {
                [SCHEMA_TABLE_TEST.name]: {
                    attributes: SCHEMA_TABLE_TEST.attributes,
                    hash_attribute: SCHEMA_TABLE_TEST.hash_attribute,
                    residence: SCHEMA_TABLE_TEST.residence,
                    schema: SCHEMA_TABLE_TEST.schema,
                    name: SCHEMA_TABLE_TEST.name
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
        test_utils.teardownHeliumTestVolume(global.hdb_helium);
        sandbox.restore();
    });

    it('Test that all new rows are inserted correctly and have both created and updated timestamps',() => {
        let expected_search_result = [
            [ '34', [ 'Beethoven', 'St. Bernard', '34', '5', null, '1943201', '1943201' ] ],
            [ '35', [ 'Elvis', 'Mutt', '35', '5', '145', '1943201', '1943201' ] ],
            [ '36', [ 'David', 'Husky', '36', null, null, '1943201', '1943201' ] ],
            [ '37', [ 'Brian', 'Cartoon', '37', '5', '145', '1943201', '1943201' ] ]
        ];
        let expected_return_result = {
            written_hashes: [ 34, 35, 36, 37 ],
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

        let error = undefined;
        try {
            result = heUpdateRecords(UPDATE_OBJECT_TEST);
            search_result = hdb_helium.searchByKeys(row_keys, DATASTORES_TEST);
        } catch(err) {
            error = err;
        }

        expect(result).to.eql(expected_return_result);
        expect(search_result).eql(expected_search_result);
        expect(error).to.eql(undefined);
    });

     it('Test that inserting same data as test above...', () => {
         let expected_search_result = [
             [ '34', [ 'Beethoven', 'St. Bernard', '34', '5', null, '1943201', '1943201' ] ],
             [ '35', [ 'Elvis', 'Mutt', '35', '5', '145', '1943201', '1943201' ] ],
             [ '36', [ 'David', 'Husky', '36', null, null, '1943201', '1943201' ] ],
             [ '37', [ 'Brian', 'Cartoon', '37', '5', '145', '1943201', '1943201' ] ]
         ];
         let expected_return_result = {
             written_hashes: [ 34, 35, 36, 37 ],
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
         let error = undefined;
         try {
             result = heUpdateRecords(UPDATE_OBJECT_TEST);
             search_result = hdb_helium.searchByKeys(row_keys, DATASTORES_TEST);
         } catch(err) {
             error = err;
         }

         expect(error).to.eql(undefined);
         expect(result).to.eql(expected_return_result);
         expect(search_result).to.eql(expected_search_result);
     });

    it('Test updating one record', () => {
        const update_obj = {
            operation: "update",
            schema: "dev",
            table: "dog",
            records: [
                {
                    name: "Beethoven",
                    breed: "St. Bernard",
                    id: "34",
                    age: 10
                }
            ]
        };

        let expected_result = {
            "written_hashes": [
                34
            ],
            "skipped_hashes": [],
            "schema_table": {
                "attributes": [],
                "hash_attribute": "id",
                "residence": undefined,
                "schema": "dev",
                "name": "dog"
            }
        };

        let expected_search_result = [
            [
                "34",
                [
                    "Beethoven",
                    "St. Bernard",
                    "34",
                    "10",
                    null,
                    "1943201",
                    "1943201"
                ]
            ]
        ];

        let result;
        let search_result;
        let error = undefined;
        try {
            result = heUpdateRecords(update_obj);
            search_result = hdb_helium.searchByKeys([update_obj.records[0].id], DATASTORES_TEST);

            expect(result).to.eql(expected_result);
            expect(search_result).to.eql(expected_search_result);
        } catch(err) {
            error = err;
        }

        expect(error).to.eql(undefined);
    });

    it('Test updating existing and non-existing rows', () => {
        global.hdb_schema[SCHEMA_TABLE_TEST.schema][SCHEMA_TABLE_TEST.name]['attributes'] = ATTRIBUTES_TEST;
        let update_obj = test_utils.deepClone(UPDATE_OBJECT_TEST);
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
                id: "34"
            },
            {
                name: "Rob",
                breed: "Mutt",
                id: "35",
                age: 5,
                height: 145
            }
        ];
        update_obj.records = new_records;
        let expected_return_result = {
            written_hashes: [ 8, 9, 34, 35 ],
            skipped_hashes: [],
            schema_table: {
                attributes: ATTRIBUTES_TEST,
                hash_attribute: 'id',
                residence: undefined,
                schema: 'dev',
                name: 'dog'
            }
        };
        let expected_search_result = [
            [ '8', [ 'Harper', 'Mutt', '8', '5', null, '1943201', '1943201' ] ],
            [ '9', [ 'Penny', 'Mutt', '9', '5', '145', '1943201', '1943201' ] ],
            [ '34', [ 'David', 'Mutt', '34', '10', null, '1943201', '1943201' ] ],
            [ '35', [ 'Rob', 'Mutt', '35', '5', '145', '1943201', '1943201' ] ]
        ];
        let result;
        let search_result;

        try {
            result = heUpdateRecords(update_obj);
            search_result = hdb_helium.searchByKeys(['8', '9', '34', '35'], DATASTORES_TEST);

        } catch(err) {
            console.log(err);
        }

        expect(result).to.eql(expected_return_result);
        expect(search_result).to.eql(expected_search_result);
    });

    it('Test that no hash error from processRows is thrown', () => {
        let insert_obj = test_utils.deepClone(UPDATE_OBJECT_TEST);
        let error;
        let records_no_hash = [
            {
                name: "Harper",
                breed: "Mutt",
                id: "89",
                age: 5
            },
            {
                name: "Penny",
                breed: "Mutt",
                age: 5,
                height: 145
            }
        ];
        insert_obj.records = records_no_hash;

        try {
            heUpdateRecords(insert_obj);
        } catch(err) {
            error = err;
        }

        expect(error.message).to.equal('a valid hash attribute must be provided with update record, check log for more info');
        expect(error).to.be.an.instanceOf(Error);
    });

});
