'use strict';

const test_utils = require('../../../../test_utils');
test_utils.preTestPrep();const path = require('path');
const TRANSACTIONS_NAME = 'transactions';
const BASE_PATH = test_utils.getMockFSPath();
const BASE_TRANSACTIONS_PATH = path.join(BASE_PATH, TRANSACTIONS_NAME);


const rewire = require('rewire');
const environment_utility = rewire('../../../../../utility/lmdb/environmentUtility');
const lmdb_create_txn_envs = require('../../../../../data_layer/harperBridge/lmdbBridge/lmdbUtility/lmdbCreateTransactionsEnvironment');
const LMDB_ERRORS = require('../../../../commonTestErrors').LMDB_ERRORS_ENUM;
const assert = require('assert');
const fs = require('fs-extra');

const CREATE_TABLE_OBJ = {
    schema: "dev",
    table: "test",
    hash_attribute: "id"
};

describe('test lmdbCreateTransactionsEnvironment module', ()=>{
    let rw_env_util;
    before(async ()=>{
        await fs.remove(BASE_PATH);
        rw_env_util = environment_utility.__set__('MAP_SIZE', 5*1024*1024*1024);
    });

    after(()=>{
        rw_env_util();
    });

    describe('test lmdbCreateTransactionsEnvironment function', ()=>{
        before(() => {
            global.lmdb_map = undefined;
        });

        after(async () => {
            await fs.remove(BASE_PATH);
            global.lmdb_map = undefined;
        });

        it('test adding a transaction environment', async()=>{
            let transaction_path = path.join(BASE_TRANSACTIONS_PATH, CREATE_TABLE_OBJ.schema);
            let expected_txn_dbis = ['__blob__' , 'hash_value', 'timestamp', 'user_name'];

            await test_utils.assertErrorAsync(environment_utility.openEnvironment, [transaction_path, CREATE_TABLE_OBJ.table, true], LMDB_ERRORS.INVALID_BASE_PATH);

            assert.deepStrictEqual(global.lmdb_map, undefined);

            await test_utils.assertErrorAsync(lmdb_create_txn_envs, [CREATE_TABLE_OBJ], undefined);

            let txn_env = await test_utils.assertErrorAsync(environment_utility.openEnvironment, [transaction_path, CREATE_TABLE_OBJ.table, true], undefined);

            assert.notDeepStrictEqual(txn_env, undefined);

            let txn_dbis = test_utils.assertErrorSync(environment_utility.listDBIs, [txn_env], undefined);
            assert.deepStrictEqual(txn_dbis, expected_txn_dbis);

            assert.deepStrictEqual(global.lmdb_map[`txn.${CREATE_TABLE_OBJ.schema}.${CREATE_TABLE_OBJ.table}`], txn_env);

            txn_env.close();
        });
    });

});