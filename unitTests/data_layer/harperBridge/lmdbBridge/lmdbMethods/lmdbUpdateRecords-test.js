'use strict';

const test_utils = require('../../../../test_utils');
test_utils.preTestPrep();
const path = require('path');
const SYSTEM_FOLDER_NAME = 'system';
const SCHEMA_NAME = 'schema';
const BASE_PATH = test_utils.getMockFSPath();
const BASE_SCHEMA_PATH = path.join(BASE_PATH, SCHEMA_NAME);
const SYSTEM_SCHEMA_PATH = path.join(BASE_SCHEMA_PATH, SYSTEM_FOLDER_NAME);


const rewire = require('rewire');
const lmdb_create_records = rewire('../../../../../data_layer/harperBridge/lmdbBridge/lmdbMethods/lmdbCreateRecords');
const lmdb_update_records = rewire('../../../../../data_layer/harperBridge/lmdbBridge/lmdbMethods/lmdbUpdateRecords');
const lmdb_create_schema = require('../../../../../data_layer/harperBridge/lmdbBridge/lmdbMethods/lmdbCreateSchema');
const lmdb_create_table = require('../../../../../data_layer/harperBridge/lmdbBridge/lmdbMethods/lmdbCreateTable');
const environment_utility = rewire('../../../../../utility/lmdb/environmentUtility');
const search_utility = require('../../../../../utility/lmdb/searchUtility');
const assert = require('assert');
const fs = require('fs-extra');
const sinon = require('sinon');
const systemSchema = require('../../../../../json/systemSchema');

let insert_date = new Date();
insert_date.setMinutes(insert_date.getMinutes() - 10);
const INSERT_TIMESTAMP = insert_date.getTime();

const TIMESTAMP = Date.now();
const HASH_ATTRIBUTE_NAME = 'id';

const INSERT_OBJECT_TEST = {
    operation: "insert",
    schema: 'dev',
    table: 'dog',
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
    name: 'dog',
    hash_attribute: HASH_ATTRIBUTE_NAME,
    schema: 'dev',
    attributes: []
};

const CREATE_SCHEMA_DEV = {
    operation: 'create_schema',
    schema: 'dev'
};

const CREATE_TABLE_OBJ_TEST_A = {
    operation: 'create_table',
    schema: 'dev',
    table: 'dog',
    hash_attribute: 'id'
};

const TABLE_SYSTEM_DATA_TEST_A = {
    name: CREATE_TABLE_OBJ_TEST_A.table,
    schema: CREATE_TABLE_OBJ_TEST_A.schema,
    id: '82j3r4',
    hash_attribute: CREATE_TABLE_OBJ_TEST_A.hash_attribute,
    residence: '*'
};

const sandbox = sinon.createSandbox();

describe('Test lmdbUpdateRecords module', ()=>{
    let date_stub;
    let hdb_schema_env;
    let hdb_table_env;
    let hdb_attribute_env;
    let rw_env_util;
    before(()=>{
        rw_env_util = environment_utility.__set__('MAP_SIZE', 10*1024*1024*1024);
        date_stub = sandbox.stub(Date, 'now').returns(TIMESTAMP);
    });

    after(()=>{
        rw_env_util();
        date_stub.restore();
    });

    describe('Test lmdbUpdateRecords function', ()=>{

        beforeEach(async ()=>{
            date_stub.restore();
            date_stub = sandbox.stub(Date, 'now').returns(INSERT_TIMESTAMP);
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
                system: systemSchema};

            await fs.mkdirp(SYSTEM_SCHEMA_PATH);

            global.lmdb_map = undefined;

            hdb_schema_env = await environment_utility.createEnvironment(SYSTEM_SCHEMA_PATH, systemSchema.hdb_schema.name);
            environment_utility.createDBI(hdb_schema_env, systemSchema.hdb_schema.hash_attribute, false);

            hdb_table_env = await environment_utility.createEnvironment(SYSTEM_SCHEMA_PATH, systemSchema.hdb_table.name);
            environment_utility.createDBI(hdb_table_env, systemSchema.hdb_table.hash_attribute, false);

            hdb_attribute_env = await environment_utility.createEnvironment(SYSTEM_SCHEMA_PATH, systemSchema.hdb_attribute.name);
            environment_utility.createDBI(hdb_attribute_env, systemSchema.hdb_attribute.hash_attribute, false);

            await lmdb_create_schema(CREATE_SCHEMA_DEV);

            await lmdb_create_table(TABLE_SYSTEM_DATA_TEST_A, CREATE_TABLE_OBJ_TEST_A);

            let insert_obj = test_utils.deepClone(INSERT_OBJECT_TEST);
            await lmdb_create_records(insert_obj);
            date_stub.restore();
            date_stub = sandbox.stub(Date, 'now').returns(TIMESTAMP);
        });

        afterEach(async ()=>{
            await fs.remove(BASE_PATH);
            global.lmdb_map = undefined;
            delete global.hdb_schema;
        });

        it('Test updating 1 row', async ()=>{
            const update_obj = {
                operation: "update",
                schema: "dev",
                table: "dog",
                records: [
                    {
                        name: "Beethoven",
                        breed: "St. Bernard",
                        id: 10,
                        height:undefined,
                        age: 10
                    }
                ]
            };

            let expected_return_result = {
                written_hashes: [ 10],
                skipped_hashes: [],
                schema_table: {
                    attributes: [],
                    hash_attribute: HASH_ATTRIBUTE_NAME,
                    residence: undefined,
                    schema: INSERT_OBJECT_TEST.schema,
                    name: INSERT_OBJECT_TEST.table
                }
            };

            let expected_search = test_utils.assignObjecttoNullObject(update_obj.records[0]);
            expected_search.__createdtime__=INSERT_TIMESTAMP;
            expected_search.__updatedtime__=TIMESTAMP;
            expected_search.height = undefined;


            let results = await test_utils.assertErrorAsync(lmdb_update_records, [update_obj], undefined);
            assert.deepStrictEqual(results, expected_return_result);

            let dog_env = await test_utils.assertErrorAsync(environment_utility.openEnvironment,[path.join(BASE_SCHEMA_PATH, INSERT_OBJECT_TEST.schema), INSERT_OBJECT_TEST.table], undefined);
            let record = test_utils.assertErrorSync(search_utility.searchByHash, [dog_env, HASH_ATTRIBUTE_NAME, ALL_FETCH_ATTRIBUTES, '10'], undefined);
            assert.deepStrictEqual(record, expected_search);

            //make sure the height index does not have an entry for id 10
            let height_results = test_utils.assertErrorSync(search_utility.iterateDBI, [dog_env, "height"], undefined);
            height_results.forEach(result=>{
                assert(result.indexOf(10) < 0);
            });

        });

        it('Test update record with no hash attribute', async () => {
            const update_obj = {
                operation: "update",
                schema: "dev",
                table: "dog",
                records: [
                    {
                        name: "Beethoven",
                        breed: "St. Bernard",
                        height:undefined,
                        age: 10
                    }
                ]
            };

            let no_hash_error = new Error('a valid hash attribute must be provided with update record, check log for more info');

            let update1 = test_utils.deepClone(update_obj);
            await test_utils.assertErrorAsync(lmdb_update_records, [update1], no_hash_error);

            let update2 = test_utils.deepClone(update_obj);
            update2.id = null;
            await test_utils.assertErrorAsync(lmdb_update_records, [update2], no_hash_error);

            let update3 = test_utils.deepClone(update_obj);
            update3.id = undefined;
            await test_utils.assertErrorAsync(lmdb_update_records, [update3], no_hash_error);

            let update4 = test_utils.deepClone(update_obj);
            update4.id = '';
            await test_utils.assertErrorAsync(lmdb_update_records, [update4], no_hash_error);
        });

        it('Test updating a row that does not exist', async () => {
            const update_obj = {
                operation: "update",
                schema: "dev",
                table: "dog",
                records: [
                    {
                        name: "Beethoven",
                        breed: "St. Bernard",
                        height:undefined,
                        id:"faker",
                        age: 10
                    }
                ]
            };

            let expected_result = {
                written_hashes: [],
                skipped_hashes: [ 'faker'],
                schema_table:
                    { attributes: NO_NEW_ATTR_TEST,
                        hash_attribute: 'id',
                        residence: undefined,
                        schema: update_obj.schema,
                        name: update_obj.table }
            };

            let results = await test_utils.assertErrorAsync(lmdb_update_records, [update_obj], undefined);
            assert.deepStrictEqual(results.written_hashes, expected_result.written_hashes);
            assert.deepStrictEqual(results.skipped_hashes, expected_result.skipped_hashes);
        });

    });


});