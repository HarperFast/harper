'use strict';

const test_utils = require('../../../../test_utils');
test_utils.preTestPrep();const path = require('path');
const SYSTEM_FOLDER_NAME = 'system';
const SCHEMA_NAME = 'schema';
const BASE_PATH = test_utils.getMockFSPath();
const BASE_SCHEMA_PATH = path.join(BASE_PATH, SCHEMA_NAME);
const SYSTEM_SCHEMA_PATH = path.join(BASE_SCHEMA_PATH, SYSTEM_FOLDER_NAME);
const DEV_SCHEMA_PATH = path.join(BASE_SCHEMA_PATH, 'dev');
const TRANSACTIONS_NAME = 'transactions';
const BASE_TXN_PATH = path.join(BASE_PATH, TRANSACTIONS_NAME);

let test_data = require('../../../../testData');

const rewire = require('rewire');
const environment_utility = rewire('../../../../../utility/lmdb/environmentUtility');
const SearchObject = require('../../../../../data_layer/SearchObject');
const lmdb_drop_attribute = require('../../../../../data_layer/harperBridge/lmdbBridge/lmdbUtility/lmdbDropAllAttributes');
const search_by_value = require('../../../../../data_layer/harperBridge/lmdbBridge/lmdbMethods/lmdbSearchByValue');
const lmdb_create_schema = require('../../../../../data_layer/harperBridge/lmdbBridge/lmdbMethods/lmdbCreateSchema');
const lmdb_create_table = require('../../../../../data_layer/harperBridge/lmdbBridge/lmdbMethods/lmdbCreateTable');
const lmdb_create_records = require('../../../../../data_layer/harperBridge/lmdbBridge/lmdbMethods/lmdbCreateRecords');
const LMDB_ERRORS = require('../../../../commonTestErrors').LMDB_ERRORS_ENUM;
const assert = require('assert');
const fs = require('fs-extra');
const sinon = require('sinon');
const systemSchema = require('../../../../../json/systemSchema');

const TIMESTAMP = Date.now();

const sandbox = sinon.createSandbox();

const CREATE_SCHEMA_DEV = {
    operation: 'create_schema',
    schema: 'dev'
};

const CREATE_TABLE_OBJ_TEST_A = {
    operation: 'create_table',
    schema: 'dev',
    table: 'test',
    hash_attribute: 'id'
};

const TABLE_SYSTEM_DATA_TEST_A = {
    name: CREATE_TABLE_OBJ_TEST_A.table,
    schema: CREATE_TABLE_OBJ_TEST_A.schema,
    id: '82j3r4',
    hash_attribute: CREATE_TABLE_OBJ_TEST_A.hash_attribute,
    residence: '*'
};

const INSERT_OBJECT_TEST = {
    operation: "insert",
    schema: 'dev',
    table: 'test',
    records: test_data
};

describe('test lmdbDropAllAttributes module', ()=>{
    let date_stub;
    before(async ()=>{
        await fs.remove(test_utils.getMockFSPath());
        date_stub = sandbox.stub(Date, 'now').returns(TIMESTAMP);
    });

    after(async ()=>{
        date_stub.restore();
        await fs.remove(test_utils.getMockFSPath());
    });

    describe('test lmdbDropAllAttributes function', ()=>{
        let hdb_schema_env;
        let hdb_table_env;
        let hdb_attribute_env;
        before(async () => {
            global.lmdb_map = undefined;
            await fs.remove(test_utils.getMockFSPath());
            await fs.mkdirp(SYSTEM_SCHEMA_PATH);
            await fs.mkdirp(DEV_SCHEMA_PATH);

            global.hdb_schema = {
                dev: {
                    test: {
                        attributes: [],
                        hash_attribute: 'id',
                        schema: 'dev',
                        name: 'test'
                    }
                },
                system: systemSchema};

            hdb_schema_env = await environment_utility.createEnvironment(SYSTEM_SCHEMA_PATH, systemSchema.hdb_schema.name);
            environment_utility.createDBI(hdb_schema_env, systemSchema.hdb_schema.hash_attribute, false);

            hdb_table_env = await environment_utility.createEnvironment(SYSTEM_SCHEMA_PATH, systemSchema.hdb_table.name);
            environment_utility.createDBI(hdb_table_env, systemSchema.hdb_table.hash_attribute, false);

            hdb_attribute_env = await environment_utility.createEnvironment(SYSTEM_SCHEMA_PATH, systemSchema.hdb_attribute.name);
            environment_utility.createDBI(hdb_attribute_env, systemSchema.hdb_attribute.hash_attribute, false);

            await lmdb_create_schema(CREATE_SCHEMA_DEV);

            await lmdb_create_table(TABLE_SYSTEM_DATA_TEST_A, CREATE_TABLE_OBJ_TEST_A);
            global.hdb_schema.dev.test.attributes = [
                {attribute:'id'},
                {attribute:'__updatedtime__'},
                {attribute:'__createdtime__'},
                {attribute:'__blob__'},
            ];

            await lmdb_create_records(INSERT_OBJECT_TEST);

            global.hdb_schema.dev.test.attributes = [
                {attribute:'id'},
                {attribute:'temperature'},
                {attribute:'temperature_double'},
                {attribute:'temperature_pos'},
                {attribute:'temperature_neg'},
                {attribute:'temperature_str'},
                {attribute:'city'},
                {attribute:'state'},
                {attribute:'__updatedtime__'},
                {attribute:'__createdtime__'},
                {attribute:'__blob__'},
            ];
        });

        after(async () => {
            let env = await environment_utility.openEnvironment(path.join(BASE_SCHEMA_PATH, CREATE_TABLE_OBJ_TEST_A.schema), CREATE_TABLE_OBJ_TEST_A.table);
            env.close();

            let txn_env1 = await environment_utility.openEnvironment(path.join(BASE_TXN_PATH, CREATE_TABLE_OBJ_TEST_A.schema), CREATE_TABLE_OBJ_TEST_A.table, true);
            txn_env1.close();

            hdb_schema_env.close();
            hdb_table_env.close();
            hdb_attribute_env.close();

            global.lmdb_map = undefined;
            await fs.remove(test_utils.getMockFSPath());
        });

        it('Test invalid schema', async ()=>{
            let drop_obj = {
                schema: "blerg",
                table: "test"
            };
            await test_utils.assertErrorAsync(lmdb_drop_attribute, [drop_obj],
                new Error(`unknown schema:${drop_obj.schema} and table ${drop_obj.table}`));
        });

        it('Test invalid table', async ()=>{
            let drop_obj = {
                schema: "dev",
                table: "fake"
            };
            await test_utils.assertErrorAsync(lmdb_drop_attribute, [drop_obj],
                new Error(`unknown schema:${drop_obj.schema} and table ${drop_obj.table}`));
        });

        it('test removing all attributes', async()=>{
            let search_obj = new SearchObject('system', 'hdb_attribute', 'schema_table', 'dev.test', undefined, ['*']);
            let results = await test_utils.assertErrorAsync(search_by_value, [search_obj], undefined);
            assert.notDeepStrictEqual(results.length, 0);

            let drop_obj = {
                schema: "dev",
                table: "test"
            };
            await test_utils.assertErrorAsync(lmdb_drop_attribute, [drop_obj], undefined);
            let new_results = await test_utils.assertErrorAsync(search_by_value, [search_obj], undefined);
            assert.deepStrictEqual(new_results.length, 0);

            let env = await test_utils.assertErrorAsync(environment_utility.openEnvironment, [DEV_SCHEMA_PATH, 'test'], undefined);
            let dbis = await test_utils.assertErrorAsync(environment_utility.listDBIs, [env], undefined);
            assert.deepStrictEqual(dbis.length, 1);

            for(let x = 0; x < results.length; x++){
                await test_utils.assertErrorAsync(environment_utility.openDBI, [env, results[x].attribute], LMDB_ERRORS.DBI_DOES_NOT_EXIST);
            }
        });
    });

});