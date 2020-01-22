'use strict';

const rewire = require('rewire');
const lmdb_create_records = rewire('../../../../../data_layer/harperBridge/lmdbBridge/lmdbMethods/lmdbCreateRecords');
const environment_utility = require('../../../../../utility/lmdb/environmentUtility');
const search_utility = require('../../../../../utility/lmdb/searchUtility');
const assert = require('assert');
const fs = require('fs-extra');
const test_utils = require('../../../../test_utils');
const path = require('path');
const sinon = require('sinon');

const TIMESTAMP = Date.now();
const LMDB_TEST_FOLDER_NAME = 'lmdbTest';
const BASE_TEST_PATH = path.join(test_utils.getMockFSPath(), LMDB_TEST_FOLDER_NAME);
const TEST_ENVIRONMENT_NAME = 'dog';
const HASH_ATTRIBUTE_NAME = 'id';

const INSERT_OBJECT_TEST = {
    operation: "insert",
    schema: LMDB_TEST_FOLDER_NAME,
    table: TEST_ENVIRONMENT_NAME,
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

const EXPECTED_SEARCH_RECORDS = [
    {
        __createdtime__:TIMESTAMP,
        __updatedtime__: TIMESTAMP,
        name: "Harper",
        breed: "Mutt",
        height: undefined,
        id: "8",
        age: 5
    },
    {
        __createdtime__:TIMESTAMP,
        __updatedtime__: TIMESTAMP,
        name: "Penny",
        breed: "Mutt",
        id: "9",
        age: 5,
        height: 145
    },
    {
        __createdtime__:TIMESTAMP,
        __updatedtime__: TIMESTAMP,
        age: undefined,
        name: "David",
        breed: "Mutt",
        height:undefined,
        id: "12"
    },
    {
        __createdtime__:TIMESTAMP,
        __updatedtime__: TIMESTAMP,
        name: "Rob",
        breed: "Mutt",
        id: "10",
        age: 5,
        height: 145
    }
];

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
    },
    {
        attribute: "__createdtime__"
    },
    {
        attribute: "__updatedtime__"
    }
];

const ALL_FETCH_ATTRIBUTES = ['__createdtime__', '__updatedtime__', 'age', 'breed', 'height', 'id', 'name'];

const SCHEMA_TABLE_TEST = {
    id: "c43762be-4943-4d10-81fb-1b857ed6cf3a",
    name: TEST_ENVIRONMENT_NAME,
    hash_attribute: HASH_ATTRIBUTE_NAME,
    schema: LMDB_TEST_FOLDER_NAME,
    attributes: []
};

const sandbox = sinon.createSandbox();
const date_stub = sandbox.stub(Date, 'now').returns(TIMESTAMP);
describe('Test lmdbCreateRecords module', ()=>{
    let rw_base_schema_path = lmdb_create_records.__set__('BASE_SCHEMA_PATH', test_utils.getMockFSPath());
    before(()=>{


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

    after(()=>{
        date_stub.restore();
        rw_base_schema_path();
    });

    describe('Test lmdbCreateRecords function', ()=>{
        let env;
        beforeEach(async ()=>{
            await fs.mkdirp(BASE_TEST_PATH);
            global.lmdb_map = undefined;
            env = await environment_utility.createEnvironment(BASE_TEST_PATH, TEST_ENVIRONMENT_NAME);
            environment_utility.createDBI(env, HASH_ATTRIBUTE_NAME, false);
        });

        afterEach(async ()=>{
            await fs.remove(BASE_TEST_PATH);
            global.lmdb_map = undefined;
        });

        it('Test that rows are inserted correctly and return msg is correct ', async ()=>{
            let expected_return_result = {
                written_hashes: [ 8, 9, 12, 10 ],
                skipped_hashes: [],
                schema_table: {
                    attributes: [],
                    hash_attribute: HASH_ATTRIBUTE_NAME,
                    residence: undefined,
                    schema: LMDB_TEST_FOLDER_NAME,
                    name: TEST_ENVIRONMENT_NAME
                }
            };

            let insert_obj = test_utils.deepClone(INSERT_OBJECT_TEST);

            let results = await test_utils.assertErrorAsync(lmdb_create_records, [insert_obj], undefined);
            assert.deepStrictEqual(results, expected_return_result);

            let records = test_utils.assertErrorSync(search_utility.batchSearchByHash, [env, HASH_ATTRIBUTE_NAME, ALL_FETCH_ATTRIBUTES, [ '8', '9', '12', '10' ] ], undefined);
            assert.deepStrictEqual(records, EXPECTED_SEARCH_RECORDS);
        });

        it('Test inserting existing and non-existing rows', async () => {
            let expected_result = {
                written_hashes: [ 8, 9, 12, 10 ],
                skipped_hashes: [],
                schema_table: {
                    attributes: [],
                    hash_attribute: HASH_ATTRIBUTE_NAME,
                    residence: undefined,
                    schema: LMDB_TEST_FOLDER_NAME,
                    name: TEST_ENVIRONMENT_NAME
                }
            };

            let results = await test_utils.assertErrorAsync(lmdb_create_records, [INSERT_OBJECT_TEST], undefined);
            assert.deepStrictEqual(results, expected_result);

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

            let new_records_excpected = [
                {
                    "__createdtime__": TIMESTAMP,
                    "__updatedtime__": TIMESTAMP,
                    name: "Harper",
                    breed: "Mutt",
                    id: "8",
                    height:undefined,
                    age: 5
                },
                {
                    "__createdtime__": TIMESTAMP,
                    "__updatedtime__": TIMESTAMP,
                    name: "Penny",
                    breed: "Mutt",
                    id: "9",
                    age: 5,
                    height: 145
                },
                {
                    "__createdtime__": TIMESTAMP,
                    "__updatedtime__": TIMESTAMP,
                    age: undefined,
                    name: "David",
                    breed: "Mutt",
                    height:undefined,
                    id: "123"
                },
                {
                    "__createdtime__": TIMESTAMP,
                    "__updatedtime__": TIMESTAMP,
                    name: "Rob",
                    breed: "Mutt",
                    id: "1232",
                    age: 5,
                    height: 145
                }
            ];

            insert_obj.records = new_records;
            let expected_return_result = {
                written_hashes: [ 123, 1232 ],
                skipped_hashes: [ 8, 9 ],
                schema_table: {
                    attributes: NO_NEW_ATTR_TEST,
                    hash_attribute: 'id',
                    residence: undefined,
                    schema: LMDB_TEST_FOLDER_NAME,
                    name: TEST_ENVIRONMENT_NAME
                }
            };

            let result = await test_utils.assertErrorAsync(lmdb_create_records, [insert_obj], undefined);
            assert.deepStrictEqual(result, expected_return_result);
            let records = test_utils.assertErrorSync(search_utility.batchSearchByHash, [env, HASH_ATTRIBUTE_NAME, ALL_FETCH_ATTRIBUTES, ['8', '9', '123', '1232'] ], undefined);
            assert.deepStrictEqual(records, new_records_excpected);
        });

        it('Test inserting rows that already exist', async () => {
            let insert_obj = test_utils.deepClone(INSERT_OBJECT_TEST);
            await test_utils.assertErrorAsync(lmdb_create_records, [insert_obj], undefined);

            let expected_result = {
                written_hashes: [],
                skipped_hashes: [ 8, 9, 12, 10 ],
                schema_table:
                    { attributes: NO_NEW_ATTR_TEST,
                        hash_attribute: 'id',
                        residence: undefined,
                        schema: LMDB_TEST_FOLDER_NAME,
                        name: TEST_ENVIRONMENT_NAME }
            };

            let insert_obj2 = test_utils.deepClone(INSERT_OBJECT_TEST);
            let results = await test_utils.assertErrorAsync(lmdb_create_records, [insert_obj2], undefined);
            assert.deepStrictEqual(results.written_hashes, expected_result.written_hashes);
            assert.deepStrictEqual(results.skipped_hashes, expected_result.skipped_hashes);
        });

        it('Test that no hash error from processRows is thrown', async () => {
            let insert_obj = test_utils.deepClone(INSERT_OBJECT_TEST);

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
            insert_obj.operation = 'update';

            await test_utils.assertErrorAsync(lmdb_create_records, [insert_obj], new Error('a valid hash attribute must be provided with update record, check log for more info'));
        });
    });


});