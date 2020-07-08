'use strict';

const test_utils = require('../../../../test_utils');
test_utils.preTestPrep();
const path = require('path');
const TRANSACTIONS_NAME = 'transactions';
const BASE_PATH = test_utils.getMockFSPath();
const BASE_TRANSACTIONS_PATH = path.join(BASE_PATH, TRANSACTIONS_NAME);

const rewire = require('rewire');
const environment_utility = rewire('../../../../../utility/lmdb/environmentUtility');
const lmdb_create_txn_envs = require('../../../../../data_layer/harperBridge/lmdbBridge/lmdbUtility/lmdbCreateTransactionsEnvironment');
const lmdb_write_txn = require('../../../../../data_layer/harperBridge/lmdbBridge/lmdbUtility/lmdbWriteTransaction');
const rw_lmdb_write_txn = rewire('../../../../../data_layer/harperBridge/lmdbBridge/lmdbUtility/lmdbWriteTransaction');
const search_util = require('../../../../../utility/lmdb/searchUtility');

const env_mngr = require('../../../../../utility/environment/environmentManager');

const create_transaction_object_func = rw_lmdb_write_txn.__get__('createTransactionObject');

const InternalTxnHashesObject = rw_lmdb_write_txn.__get__('InternalTxnHashesObject');
const CreateTableObject = require('../../../../../data_layer/CreateTableObject');

const assert = require('assert');
const fs = require('fs-extra');
const common = require('../../../../../utility/lmdb/commonUtility');

const InsertObject = require('../../../../../data_layer/InsertObject');
const UpdateObject = require('../../../../../data_layer/UpdateObject');
const DeleteObject = require('../../../../../data_layer/DeleteObject');

const InsertRecordsResponseObject = require('../../../../../utility/lmdb/InsertRecordsResponseObject');
const UpdateRecordsResponseObject = require('../../../../../utility/lmdb/UpdateRecordsResponseObject');
const DeleteRecordsResponseObject = require('../../../../../utility/lmdb/DeleteRecordsResponseObject');

const LMDBInsertTransactionObject = require('../../../../../data_layer/harperBridge/lmdbBridge/lmdbUtility/LMDBInsertTransactionObject');
const LMDBUpdateTransactionObject = require('../../../../../data_layer/harperBridge/lmdbBridge/lmdbUtility/LMDBUpdateTransactionObject');
const LMDBDeleteTransactionObject = require('../../../../../data_layer/harperBridge/lmdbBridge/lmdbUtility/LMDBDeleteTransactionObject');

const orig_clustering_setting = env_mngr.get('CLUSTERING');
const orig_disable_txn_setting = env_mngr.get('DISABLE_TRANSACTION_LOG');

const CREATE_TABLE_OBJ = new CreateTableObject('dev', 'test', 'id');

const INSERT_RECORDS = [{id: 1, name: 'Penny'}, {id: 2, name: 'Kato', age: '6'}, {id: 3, name: 'Riley', age: '7'}, {id: 'blerrrrr', name: 'Rosco'}];

const UPDATE_RECORDS = [{id: 1, name: 'Penny B'}, {id: 2, name: 'Kato B', age: '6'}, {id: 3, name: 'Riley S', age: '7'}, {id: 'blerrrrr', name: 'Rosco ?'}];

let INSERT_HASHES = [1,2,3, 'blerrrrr'];
const HDB_USER = {
    username: 'kyle'
};

describe('test lmdbWriteTransaction module', ()=>{
    let rw_env_util;

    before(async ()=>{
        await fs.remove(BASE_PATH);
        rw_env_util = environment_utility.__set__('MAP_SIZE', 5*1024*1024*1024);
    });

    after(()=>{
        rw_env_util();
    });

    describe('test getDisableTxnLogSetting function', ()=>{
        let rw_func = undefined;
        before(() => {
            rw_func = rw_lmdb_write_txn.__get__('getDisableTxnLogSetting');
            global.lmdb_map = undefined;
        });

        afterEach(()=>{
            env_mngr.setProperty('CLUSTERING', orig_clustering_setting);
            env_mngr.setProperty('DISABLE_TRANSACTION_LOG', orig_disable_txn_setting);
        });

        after(async () => {
            env_mngr.setProperty('CLUSTERING', orig_clustering_setting);
            env_mngr.setProperty('DISABLE_TRANSACTION_LOG', orig_disable_txn_setting);
            await fs.remove(BASE_PATH);
            global.lmdb_map = undefined;
        });

        it('test if DISABLE_TRANSACTION_LOG undefined & CLUSTERING undefined', ()=>{
            env_mngr.setProperty('CLUSTERING', undefined);
            env_mngr.setProperty('DISABLE_TRANSACTION_LOG', undefined);
            let result = rw_func();
            assert.deepStrictEqual(result, false);
        });

        it('test if DISABLE_TRANSACTION_LOG null & CLUSTERING undefined', ()=>{
            env_mngr.setProperty('CLUSTERING', undefined);
            env_mngr.setProperty('DISABLE_TRANSACTION_LOG', null);
            let result = rw_func();
            assert.deepStrictEqual(result, false);
        });

        it('test if DISABLE_TRANSACTION_LOG "" & CLUSTERING undefined', ()=>{
            env_mngr.setProperty('CLUSTERING', undefined);
            env_mngr.setProperty('DISABLE_TRANSACTION_LOG', "");
            let result = rw_func();
            assert.deepStrictEqual(result, false);
        });

        it('test if DISABLE_TRANSACTION_LOG true & CLUSTERING undefined', ()=>{
            env_mngr.setProperty('CLUSTERING', undefined);
            env_mngr.setProperty('DISABLE_TRANSACTION_LOG', true);
            let result = rw_func();
            assert.deepStrictEqual(result, true);
        });

        it('test if DISABLE_TRANSACTION_LOG false & CLUSTERING undefined', ()=>{
            env_mngr.setProperty('CLUSTERING', undefined);
            env_mngr.setProperty('DISABLE_TRANSACTION_LOG', false);
            let result = rw_func();
            assert.deepStrictEqual(result, false);
        });

        it('test if DISABLE_TRANSACTION_LOG "true" & CLUSTERING undefined', ()=>{
            env_mngr.setProperty('CLUSTERING', undefined);
            env_mngr.setProperty('DISABLE_TRANSACTION_LOG', "true");
            let result = rw_func();
            assert.deepStrictEqual(result, true);
        });

        it('test if DISABLE_TRANSACTION_LOG "TRUE" & CLUSTERING undefined', ()=>{
            env_mngr.setProperty('CLUSTERING', undefined);
            env_mngr.setProperty('DISABLE_TRANSACTION_LOG', "TRUE");
            let result = rw_func();
            assert.deepStrictEqual(result, true);
        });

        it('test if DISABLE_TRANSACTION_LOG "false" & CLUSTERING not exist', ()=>{
            env_mngr.setProperty('CLUSTERING', undefined);
            env_mngr.setProperty('DISABLE_TRANSACTION_LOG', "false");
            let result = rw_func();
            assert.deepStrictEqual(result, false);
        });

        it('test if DISABLE_TRANSACTION_LOG "FALSE" & CLUSTERING not exist', ()=>{
            env_mngr.setProperty('CLUSTERING', undefined);
            env_mngr.setProperty('DISABLE_TRANSACTION_LOG', "FALSE");
            let result = rw_func();
            assert.deepStrictEqual(result, false);
        });

        it('test if DISABLE_TRANSACTION_LOG "true" & CLUSTERING true', ()=>{
            env_mngr.setProperty('CLUSTERING', true);
            env_mngr.setProperty('DISABLE_TRANSACTION_LOG', "true");
            let result = rw_func();
            assert.deepStrictEqual(result, false);
        });

        it('test if DISABLE_TRANSACTION_LOG "TRUE" & CLUSTERING true', ()=>{
            env_mngr.setProperty('CLUSTERING', true);
            env_mngr.setProperty('DISABLE_TRANSACTION_LOG', "TRUE");
            let result = rw_func();
            assert.deepStrictEqual(result, false);
        });

        it('test if DISABLE_TRANSACTION_LOG true & CLUSTERING true', ()=>{
            env_mngr.setProperty('CLUSTERING', true);
            env_mngr.setProperty('DISABLE_TRANSACTION_LOG', true);
            let result = rw_func();
            assert.deepStrictEqual(result, false);
        });

        it('test if DISABLE_TRANSACTION_LOG "true" & CLUSTERING false', ()=>{
            env_mngr.setProperty('CLUSTERING', false);
            env_mngr.setProperty('DISABLE_TRANSACTION_LOG', "true");
            let result = rw_func();
            assert.deepStrictEqual(result, true);
        });

        it('test if DISABLE_TRANSACTION_LOG "TRUE" & CLUSTERING false', ()=>{
            env_mngr.setProperty('CLUSTERING', false);
            env_mngr.setProperty('DISABLE_TRANSACTION_LOG', "TRUE");
            let result = rw_func();
            assert.deepStrictEqual(result, true);
        });

        it('test if DISABLE_TRANSACTION_LOG true & CLUSTERING false', ()=>{
            env_mngr.setProperty('CLUSTERING', false);
            env_mngr.setProperty('DISABLE_TRANSACTION_LOG', true);
            let result = rw_func();
            assert.deepStrictEqual(result, true);
        });
    });

    describe('test createTransactionObject function', ()=>{
        before(() => {
            global.lmdb_map = undefined;
        });

        after(async () => {
            await fs.remove(BASE_PATH);
            global.lmdb_map = undefined;
        });

        it('test for insert operation no user on operation', async()=>{
            let insert_obj = new InsertObject('dev', 'test', 'id', INSERT_RECORDS);
            let insert_response = new InsertRecordsResponseObject(INSERT_HASHES, [], common.getMicroTime());

            let insert_txn_obj = new LMDBInsertTransactionObject(INSERT_RECORDS, undefined, insert_response.txn_time);
            let expected_response = new InternalTxnHashesObject(insert_txn_obj, INSERT_HASHES);

            let error = undefined;
            let response = undefined;
            try {
                response = create_transaction_object_func(insert_obj, insert_response);
            }catch(e){
                error = e;
            }
            assert.deepStrictEqual(error, undefined);

            assert.deepStrictEqual(response, expected_response);
        });
        it('test for insert operation with user on operation', async()=>{
            let insert_obj = new InsertObject('dev', 'test', 'id', INSERT_RECORDS);
            insert_obj.hdb_user = HDB_USER;
            let insert_response = new InsertRecordsResponseObject(INSERT_HASHES, [], common.getMicroTime());

            let insert_txn_obj = new LMDBInsertTransactionObject(INSERT_RECORDS, HDB_USER.username, insert_response.txn_time);
            let expected_response = new InternalTxnHashesObject(insert_txn_obj, INSERT_HASHES);

            let error = undefined;
            let response = undefined;
            try {
                response = create_transaction_object_func(insert_obj, insert_response);
            }catch(e){
                error = e;
            }
            assert.deepStrictEqual(error, undefined);

            assert.deepStrictEqual(response, expected_response);
        });

        it('test for update operation', async()=>{
            let update_obj = new UpdateObject('dev', 'test', UPDATE_RECORDS);
            update_obj.hdb_user = HDB_USER;
            let update_response = new UpdateRecordsResponseObject(INSERT_HASHES, [], common.getMicroTime(), INSERT_RECORDS);

            let update_txn_obj = new LMDBUpdateTransactionObject(UPDATE_RECORDS, INSERT_RECORDS, HDB_USER.username, update_response.txn_time);
            let expected_response = new InternalTxnHashesObject(update_txn_obj, INSERT_HASHES);

            let error = undefined;
            let response = undefined;
            try {
                response = create_transaction_object_func(update_obj, update_response);
            }catch(e){
                error = e;
            }
            assert.deepStrictEqual(error, undefined);

            assert.deepStrictEqual(response, expected_response);
        });

        it('test for delete operation', async()=>{
            let delete_obj = new DeleteObject('dev', 'test', INSERT_HASHES);
            delete_obj.hdb_user = HDB_USER;
            let delete_response = new DeleteRecordsResponseObject(INSERT_HASHES, [], common.getMicroTime(), UPDATE_RECORDS);

            let delete_txn_obj = new LMDBDeleteTransactionObject(INSERT_HASHES, UPDATE_RECORDS, HDB_USER.username, delete_response.txn_time);
            let expected_response = new InternalTxnHashesObject(delete_txn_obj, INSERT_HASHES);

            let error = undefined;
            let response = undefined;
            try {
                response = create_transaction_object_func(delete_obj, delete_response);
            }catch(e){
                error = e;
            }
            assert.deepStrictEqual(error, undefined);

            assert.deepStrictEqual(response, expected_response);
        });

        it('test for unknown operation', async()=>{
            let delete_obj = {operation:'other'};
            delete_obj.hdb_user = HDB_USER;
            let delete_response = new DeleteRecordsResponseObject(INSERT_HASHES, [], common.getMicroTime(), UPDATE_RECORDS);

            let expected_response = new InternalTxnHashesObject();

            let error = undefined;
            let response = undefined;
            try {
                response = create_transaction_object_func(delete_obj, delete_response);
            }catch(e){
                error = e;
            }
            assert.deepStrictEqual(error, undefined);

            assert.deepStrictEqual(response, expected_response);
        });
    });

    describe('test writeTransaction function', ()=> {
        beforeEach(async ()=>{
            await fs.mkdirp(BASE_PATH);
            global.lmdb_map = undefined;
            await lmdb_create_txn_envs(CREATE_TABLE_OBJ);
        });

        afterEach(async ()=>{
            await fs.remove(BASE_PATH);
            global.lmdb_map = undefined;
        });

        it('test writing insert no user on operation', async()=>{
            let insert_obj = new InsertObject('dev', 'test', 'id', INSERT_RECORDS);
            let insert_response = new InsertRecordsResponseObject(INSERT_HASHES, [], common.getMicroTime());

            //call the write txn function
            let error = undefined;
            try {
                await lmdb_write_txn(insert_obj, insert_response);
            }catch(e){
                error = e;
            }
            assert.deepStrictEqual(error, undefined);

            //test expected entries exist
            let transaction_path = path.join(BASE_TRANSACTIONS_PATH, CREATE_TABLE_OBJ.schema);
            let txn_env = undefined;
            try {
                txn_env = await environment_utility.openEnvironment(transaction_path, CREATE_TABLE_OBJ.table, true);
            }catch(e){
                error = e;
            }
            assert.deepStrictEqual(error, undefined);
            assert.notStrictEqual(txn_env, undefined);

            let insert_txn_obj = new LMDBInsertTransactionObject(INSERT_RECORDS, undefined, insert_response.txn_time);
            let expected_timestamp_results = test_utils.assignObjecttoNullObject({[insert_response.txn_time]: [JSON.stringify(insert_txn_obj)]});

            let results = search_util.iterateDBI(txn_env, 'timestamp');
            assert.deepStrictEqual(results, expected_timestamp_results);

            let expected_hash_value_results = Object.create(null);
            INSERT_HASHES.forEach(hash=>{
                expected_hash_value_results[hash] = [insert_response.txn_time.toString()];
            });
            results = search_util.iterateDBI(txn_env, 'hash_value');
            assert.deepStrictEqual(results, expected_hash_value_results);

            results = search_util.iterateDBI(txn_env, 'user_name');
            assert.deepStrictEqual(results, Object.create(null));
        });

        it('test writing insert with DISABLE_TRANSACTION_LOG true', async()=>{
            let disable_txn = rw_lmdb_write_txn.__set__('DISABLE_TRANSACTION_LOG', true);

            let insert_obj = new InsertObject('dev', 'test', 'id', INSERT_RECORDS);
            let insert_response = new InsertRecordsResponseObject(INSERT_HASHES, [], common.getMicroTime());

            //call the write txn function
            let error = undefined;
            try {
                await rw_lmdb_write_txn(insert_obj, insert_response);
            }catch(e){
                error = e;
            }
            assert.deepStrictEqual(error, undefined);

            //test expected entries exist
            let transaction_path = path.join(BASE_TRANSACTIONS_PATH, CREATE_TABLE_OBJ.schema);
            let txn_env = undefined;
            try {
                txn_env = await environment_utility.openEnvironment(transaction_path, CREATE_TABLE_OBJ.table, true);
            }catch(e){
                error = e;
            }
            assert.deepStrictEqual(error, undefined);
            assert.notStrictEqual(txn_env, undefined);

            let results = search_util.iterateDBI(txn_env, 'timestamp');
            assert.deepStrictEqual(results, Object.create(null));

            results = search_util.iterateDBI(txn_env, 'hash_value');
            assert.deepStrictEqual(results, Object.create(null));

            results = search_util.iterateDBI(txn_env, 'user_name');
            assert.deepStrictEqual(results, Object.create(null));

            disable_txn();
        });

        it('test writing insert with user on operation', async()=>{
            let insert_obj = new InsertObject('dev', 'test', 'id', INSERT_RECORDS);
            insert_obj.hdb_user = HDB_USER;
            let insert_response = new InsertRecordsResponseObject(INSERT_HASHES, [], common.getMicroTime());

            //call the write txn function
            let error = undefined;
            try {
                await lmdb_write_txn(insert_obj, insert_response);
            }catch(e){
                error = e;
            }
            assert.deepStrictEqual(error, undefined);

            //test expected entries exist
            let transaction_path = path.join(BASE_TRANSACTIONS_PATH, CREATE_TABLE_OBJ.schema);
            let txn_env = undefined;
            try {
                txn_env = await environment_utility.openEnvironment(transaction_path, CREATE_TABLE_OBJ.table, true);
            }catch(e){
                error = e;
            }
            assert.deepStrictEqual(error, undefined);
            assert.notStrictEqual(txn_env, undefined);

            let insert_txn_obj = new LMDBInsertTransactionObject(INSERT_RECORDS, HDB_USER.username, insert_response.txn_time);
            let expected_timestamp_results = test_utils.assignObjecttoNullObject({[insert_response.txn_time]: [JSON.stringify(insert_txn_obj)]});

            let results = search_util.iterateDBI(txn_env, 'timestamp');
            assert.deepStrictEqual(results, expected_timestamp_results);

            let expected_hash_value_results = Object.create(null);
            INSERT_HASHES.forEach(hash=>{
                expected_hash_value_results[hash] = [insert_response.txn_time.toString()];
            });
            results = search_util.iterateDBI(txn_env, 'hash_value');
            assert.deepStrictEqual(results, expected_hash_value_results);

            let expected_username_results = Object.create(null);
            expected_username_results[HDB_USER.username] = [insert_response.txn_time.toString()];

            results = search_util.iterateDBI(txn_env, 'user_name');
            assert.deepStrictEqual(results, expected_username_results);
        });

        it('test writing update with user on operation', async()=>{
            let update_obj = new UpdateObject('dev', 'test', UPDATE_RECORDS);
            update_obj.hdb_user = HDB_USER;
            let update_response = new UpdateRecordsResponseObject(INSERT_HASHES, [], common.getMicroTime(), INSERT_RECORDS);

            //call the write txn function
            let error = undefined;
            try {
                await lmdb_write_txn(update_obj, update_response);
            }catch(e){
                error = e;
            }
            assert.deepStrictEqual(error, undefined);

            //test expected entries exist
            let transaction_path = path.join(BASE_TRANSACTIONS_PATH, CREATE_TABLE_OBJ.schema);
            let txn_env = undefined;
            try {
                txn_env = await environment_utility.openEnvironment(transaction_path, CREATE_TABLE_OBJ.table, true);
            }catch(e){
                error = e;
            }
            assert.deepStrictEqual(error, undefined);
            assert.notStrictEqual(txn_env, undefined);

            let update_txn_obj = new LMDBUpdateTransactionObject(UPDATE_RECORDS, INSERT_RECORDS, HDB_USER.username, update_response.txn_time);
            let expected_timestamp_results = test_utils.assignObjecttoNullObject({[update_response.txn_time]: [JSON.stringify(update_txn_obj)]});

            let results = search_util.iterateDBI(txn_env, 'timestamp');
            assert.deepStrictEqual(results, expected_timestamp_results);

            let expected_hash_value_results = Object.create(null);
            INSERT_HASHES.forEach(hash=>{
                expected_hash_value_results[hash] = [update_response.txn_time.toString()];
            });
            results = search_util.iterateDBI(txn_env, 'hash_value');
            assert.deepStrictEqual(results, expected_hash_value_results);

            let expected_username_results = Object.create(null);
            expected_username_results[HDB_USER.username] = [update_response.txn_time.toString()];

            results = search_util.iterateDBI(txn_env, 'user_name');
            assert.deepStrictEqual(results, expected_username_results);
        });

        it('test writing delete with user on operation', async()=>{
            let delete_obj = new DeleteObject('dev', 'test', UPDATE_RECORDS);
            delete_obj.hdb_user = HDB_USER;
            let delete_response = new DeleteRecordsResponseObject(INSERT_HASHES, [], common.getMicroTime(), UPDATE_RECORDS);

            //call the write txn function
            let error = undefined;
            try {
                await lmdb_write_txn(delete_obj, delete_response);
            }catch(e){
                error = e;
            }
            assert.deepStrictEqual(error, undefined);

            //test expected entries exist
            let transaction_path = path.join(BASE_TRANSACTIONS_PATH, CREATE_TABLE_OBJ.schema);
            let txn_env = undefined;
            try {
                txn_env = await environment_utility.openEnvironment(transaction_path, CREATE_TABLE_OBJ.table, true);
            }catch(e){
                error = e;
            }
            assert.deepStrictEqual(error, undefined);
            assert.notStrictEqual(txn_env, undefined);

            let delete_txn_obj = new LMDBDeleteTransactionObject(INSERT_HASHES, UPDATE_RECORDS, HDB_USER.username, delete_response.txn_time);
            let expected_timestamp_results = test_utils.assignObjecttoNullObject({[delete_response.txn_time]: [JSON.stringify(delete_txn_obj)]});

            let results = search_util.iterateDBI(txn_env, 'timestamp');
            assert.deepStrictEqual(results, expected_timestamp_results);

            let expected_hash_value_results = Object.create(null);
            INSERT_HASHES.forEach(hash=>{
                expected_hash_value_results[hash] = [delete_response.txn_time.toString()];
            });
            results = search_util.iterateDBI(txn_env, 'hash_value');
            assert.deepStrictEqual(results, expected_hash_value_results);

            let expected_username_results = Object.create(null);
            expected_username_results[HDB_USER.username] = [delete_response.txn_time.toString()];

            results = search_util.iterateDBI(txn_env, 'user_name');
            assert.deepStrictEqual(results, expected_username_results);
        });
    });

});