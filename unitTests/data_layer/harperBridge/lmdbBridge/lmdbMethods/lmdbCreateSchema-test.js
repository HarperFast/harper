'use strict';

const rewire = require('rewire');
const lmdb_create_schema = rewire('../../../../../data_layer/harperBridge/lmdbBridge/lmdbMethods/lmdbCreateSchema');
const environment_utility = require('../../../../../utility/lmdb/environmentUtility');
const search_utility = require('../../../../../utility/lmdb/searchUtility');
const systemSchema = require('../../../../../json/systemSchema');
const test_utils = require('../../../../test_utils');
const assert = require('assert');
const fs = require('fs-extra');
const path = require('path');
const sinon = require('sinon');
const sandbox = sinon.createSandbox();
const TIMESTAMP = Date.now();


const LMDB_TEST_FOLDER_NAME = 'system';
const BASE_TEST_PATH = path.join(test_utils.getMockFSPath(), LMDB_TEST_FOLDER_NAME);
const TEST_ENVIRONMENT_NAME = 'hdb_schema';
const HASH_ATTRIBUTE_NAME = 'name';

const CREATE_SCHEMA_OBJ_TEST_A = {
    operation: 'create_schema',
    schema: 'horses'
};


describe('test lmdbCreateSchema module', ()=>{
    let env;
    let date_stub;
    let rw_base_schema_path;
    before(()=>{
        global.hdb_schema = {system: systemSchema};

        rw_base_schema_path = lmdb_create_schema.__set__('BASE_SCHEMA_PATH', test_utils.getMockFSPath());
        date_stub = sandbox.stub(Date, 'now').returns(TIMESTAMP);
    });

    after(()=>{
        date_stub.restore();
        delete global.hdb_schema;
        rw_base_schema_path();
        sandbox.restore();
    });

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

    it('Test that a new schema is added to the system datastore', async()=>{
        let expected_search_result = {name: 'horses', createddate: ''+TIMESTAMP};

        await test_utils.assertErrorAsync(lmdb_create_schema, [CREATE_SCHEMA_OBJ_TEST_A], undefined);

        let result = test_utils.assertErrorSync(search_utility.searchByHash, [env, HASH_ATTRIBUTE_NAME, ['name', 'createddate'], CREATE_SCHEMA_OBJ_TEST_A.schema], undefined);
        assert.deepStrictEqual(result, expected_search_result);

        await test_utils.assertErrorAsync(fs.access, [path.join(test_utils.getMockFSPath(), CREATE_SCHEMA_OBJ_TEST_A.schema)], undefined);
    });

    it('Test that error from lmdbCreateRecords caught and thrown',async () => {
        let error_msg = new Error('Error creating the record');
        let lmdb_stub = sandbox.stub().throws(error_msg);
        lmdb_create_schema.__set__('lmdb_create_records', lmdb_stub);
        await test_utils.assertErrorAsync(lmdb_create_schema, [CREATE_SCHEMA_OBJ_TEST_A], error_msg);
    });
});