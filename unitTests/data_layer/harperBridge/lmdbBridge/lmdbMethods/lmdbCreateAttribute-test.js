'use strict';

const path = require('path');
const env_mgr = require('../../../../../utility/environment/environmentManager');
if(!env_mgr.isInitialized()){
    env_mgr.initSync();
}
const test_utils = require('../../../../test_utils');
const LMDB_TEST_FOLDER_NAME = 'system';
const SCHEMA_NAME = 'schema';
const BASE_PATH = test_utils.getMockFSPath();
const BASE_SCHEMA_PATH = path.join(BASE_PATH, SCHEMA_NAME);
const BASE_TEST_PATH = path.join(BASE_SCHEMA_PATH, LMDB_TEST_FOLDER_NAME);
const root_original = env_mgr.get('HDB_ROOT');
env_mgr.setProperty('HDB_ROOT', BASE_PATH);


const rewire = require('rewire');
const lmdb_create_schema = require('../../../../../data_layer/harperBridge/lmdbBridge/lmdbMethods/lmdbCreateSchema');
const lmdb_create_table = rewire('../../../../../data_layer/harperBridge/lmdbBridge/lmdbMethods/lmdbCreateTable');
const lmdb_create_attribute = rewire('../../../../../data_layer/harperBridge/lmdbBridge/lmdbMethods/lmdbCreateAttribute');
const environment_utility = rewire('../../../../../utility/lmdb/environmentUtility');
const search_utility = require('../../../../../utility/lmdb/searchUtility');
const systemSchema = require('../../../../../json/systemSchema');

const assert = require('assert');
const fs = require('fs-extra');

const MOCK_UUID_VALUE = 'cool-uuid-value';

const CREATE_SCHEMA_DEV = {
    operation: 'create_schema',
    schema: 'dev'
};

const CREATE_SCHEMA_PROD = {
    operation: 'create_schema',
    schema: 'prod'
};

const CREATE_TABLE_OBJ_TEST_A = {
    operation: 'create_table',
    schema: 'dev',
    table: 'catsdrool',
    hash_attribute: 'id'
};

const TABLE_SYSTEM_DATA_TEST_A = {
    name: CREATE_TABLE_OBJ_TEST_A.table,
    schema: CREATE_TABLE_OBJ_TEST_A.schema,
    id: '82j3r4',
    hash_attribute: CREATE_TABLE_OBJ_TEST_A.hash_attribute,
    residence: '*'
};

const CREATE_TABLE_OBJ_TEST_B = {
    operation: 'create_table',
    schema: 'prod',
    table: 'coolDogNames',
    hash_attribute: 'name',
};

const TABLE_SYSTEM_DATA_TEST_B = {
    name: CREATE_TABLE_OBJ_TEST_B.table,
    schema: CREATE_TABLE_OBJ_TEST_B.schema,
    id: 'fd23fds',
    hash_attribute: CREATE_TABLE_OBJ_TEST_B.hash_attribute,
    residence: '*'
};

const CREATE_ATTR_OBJ_TEST = {
    operation: "create_attribute",
    schema: "dev",
    table: "catsdrool",
    attribute: "another_attribute",
    id: MOCK_UUID_VALUE
};

const HDB_ATTRIBUTE_ATTRIBUTES = ['id', 'schema', 'table', 'attribute', 'schema_table'];

describe("test lmdbCreateAttribute module", ()=>{

    let hdb_schema_env;
    let hdb_table_env;
    let hdb_attribute_env;
    let rw_env_util;
    before(async ()=>{
        rw_env_util = environment_utility.__set__('MAP_SIZE', 10*1024*1024*1024);
        //uuid_stub = sandbox.stub(uuid, 'v4').returns(MOCK_UUID_VALUE);
        global.hdb_schema = {system: systemSchema};
        env_mgr.setProperty('HDB_ROOT', BASE_PATH);
        await fs.mkdirp(BASE_TEST_PATH);
        global.lmdb_map = undefined;

        hdb_schema_env = await environment_utility.createEnvironment(BASE_TEST_PATH, systemSchema.hdb_schema.name);
        environment_utility.createDBI(hdb_schema_env, systemSchema.hdb_schema.hash_attribute, false);

        hdb_table_env = await environment_utility.createEnvironment(BASE_TEST_PATH, systemSchema.hdb_table.name);
        environment_utility.createDBI(hdb_table_env, systemSchema.hdb_table.hash_attribute, false);

        hdb_attribute_env = await environment_utility.createEnvironment(BASE_TEST_PATH, systemSchema.hdb_attribute.name);
        environment_utility.createDBI(hdb_attribute_env, systemSchema.hdb_attribute.hash_attribute, false);

        await lmdb_create_schema(CREATE_SCHEMA_DEV);
        await lmdb_create_schema(CREATE_SCHEMA_PROD);
        await lmdb_create_table(TABLE_SYSTEM_DATA_TEST_A, CREATE_TABLE_OBJ_TEST_A);
        await lmdb_create_table(TABLE_SYSTEM_DATA_TEST_B, CREATE_TABLE_OBJ_TEST_B);

    });

    after(async ()=>{
        rw_env_util();
        env_mgr.setProperty('HDB_ROOT', root_original);
        delete global.hdb_schema;
        await fs.remove(BASE_PATH);
        global.lmdb_map = undefined;
    });

    it('Test that a datastore is created and system schema updated with new attribute', async () => {
        let expected_result = {
            message: 'inserted 1 of 1 records',
            skipped_hashes: [],
            inserted_hashes: [ MOCK_UUID_VALUE ]
        };

        let expected_search_result = {id: MOCK_UUID_VALUE, schema: CREATE_ATTR_OBJ_TEST.schema, table: CREATE_ATTR_OBJ_TEST.table, attribute: CREATE_ATTR_OBJ_TEST.attribute, schema_table: `${CREATE_ATTR_OBJ_TEST.schema}.${CREATE_ATTR_OBJ_TEST.table}`};

        let results = await test_utils.assertErrorAsync(lmdb_create_attribute, [CREATE_ATTR_OBJ_TEST],undefined);
        assert.deepStrictEqual(results, expected_result);

        let test_env = await test_utils.assertErrorAsync(environment_utility.openEnvironment, [path.join(BASE_SCHEMA_PATH, CREATE_ATTR_OBJ_TEST.schema), CREATE_ATTR_OBJ_TEST.table], undefined);
        let all_dbis = test_utils.assertErrorSync(environment_utility.listDBIs, [test_env], undefined);
        assert(all_dbis.includes(CREATE_ATTR_OBJ_TEST.attribute) === true);


        let attribute_record = test_utils.assertErrorSync(search_utility.searchByHash,
            [hdb_attribute_env, systemSchema.hdb_attribute.hash_attribute, HDB_ATTRIBUTE_ATTRIBUTES, MOCK_UUID_VALUE], undefined);
        assert.deepStrictEqual(attribute_record, expected_search_result);
    });
    it('Test that datastore is not created because it already exists', async () => {
        let expected_result = {
            message: 'inserted 0 of 1 records',
            skipped_hashes: [MOCK_UUID_VALUE],
            inserted_hashes: []
        };

        let results = await test_utils.assertErrorAsync(lmdb_create_attribute, [CREATE_ATTR_OBJ_TEST],undefined);
        assert.deepStrictEqual(results, expected_result);
    });

    it('Test that validation error is thrown', async () => {
        let attr_required = new Error('Attribute  is required');
        let create_attr_obj = test_utils.deepClone(CREATE_ATTR_OBJ_TEST);
        delete create_attr_obj.attribute;
        await test_utils.assertErrorAsync(lmdb_create_attribute, [create_attr_obj],attr_required);

        create_attr_obj = test_utils.deepClone(CREATE_ATTR_OBJ_TEST);
        create_attr_obj.attribute = null;
        await test_utils.assertErrorAsync(lmdb_create_attribute, [create_attr_obj],attr_required);

        create_attr_obj = test_utils.deepClone(CREATE_ATTR_OBJ_TEST);
        create_attr_obj.attribute = undefined;
        await test_utils.assertErrorAsync(lmdb_create_attribute, [create_attr_obj],attr_required);

        create_attr_obj = test_utils.deepClone(CREATE_ATTR_OBJ_TEST);
        create_attr_obj.attribute = '';
        await test_utils.assertErrorAsync(lmdb_create_attribute, [create_attr_obj],attr_required);

        create_attr_obj = test_utils.deepClone(CREATE_ATTR_OBJ_TEST);
        create_attr_obj.attribute = 'slash/er';
        await test_utils.assertErrorAsync(lmdb_create_attribute, [create_attr_obj],new Error('Attribute name can only contain alpha numeric characters or underscores'));
    });

});