'use strict';

const test_utils = require('../../../../test_utils');
test_utils.preTestPrep();
const BASE_PATH = test_utils.getMockFSPath();

const rewire = require('rewire');
const environment_utility = rewire('../../../../../utility/lmdb/environmentUtility');
const lmdb_create_txn_envs = require('../../../../../data_layer/harperBridge/lmdbBridge/lmdbUtility/lmdbCreateTransactionsEnvironment');

const lmdb_write_txn = require('../../../../../data_layer/harperBridge/lmdbBridge/lmdbUtility/lmdbWriteTransaction');
const common = require('../../../../../utility/lmdb/commonUtility');
const hdb_terms = require('../../../../../utility/hdbTerms');
const fs = require('fs-extra');

const CreateTableObject = require('../../../../../data_layer/CreateTableObject');
const InsertObject = require('../../../../../data_layer/InsertObject');
const UpdateObject = require('../../../../../data_layer/UpdateObject');
const DeleteObject = require('../../../../../data_layer/DeleteObject');
const ReadTransactionLogObject = require('../../../../../data_layer/ReadTransactionLogObject');


const ClusteringOriginObject = require('../../../../../server/ClusteringOriginObject');
const InsertRecordsResponseObject = require('../../../../../utility/lmdb/InsertRecordsResponseObject');
const UpdateRecordsResponseObject = require('../../../../../utility/lmdb/UpdateRecordsResponseObject');
const DeleteRecordsResponseObject = require('../../../../../utility/lmdb/DeleteRecordsResponseObject');

const LMDBInsertTransactionObject = require('../../../../../data_layer/harperBridge/lmdbBridge/lmdbUtility/LMDBInsertTransactionObject');
const LMDBUpdateTransactionObject = require('../../../../../data_layer/harperBridge/lmdbBridge/lmdbUtility/LMDBUpdateTransactionObject');
const LMDBDeleteTransactionObject = require('../../../../../data_layer/harperBridge/lmdbBridge/lmdbUtility/LMDBDeleteTransactionObject');

const read_txn_log = require('../../../../../data_layer/harperBridge/lmdbBridge/lmdbMethods/lmdbReadTransactionLog');
const rw_read_txn_log = rewire('../../../../../data_layer/harperBridge/lmdbBridge/lmdbMethods/lmdbReadTransactionLog');
const assert = require('assert');

const CREATE_TABLE_OBJ = new CreateTableObject('dev', 'test', 'id');
const INSERT_RECORDS_1 = [{id: 1, name: 'Penny'}, {id: 2, name: 'Kato', age: '6'}];
let INSERT_HASHES_1 = [1,2];

const INSERT_RECORDS_2 = [{id: 3, name: 'Riley', age: '7'}];
let INSERT_HASHES_2 = [3];

const INSERT_RECORDS_3 = [{id: 'blerrrrr', name: 'Rosco'}];
let INSERT_HASHES_3 = ['blerrrrr'];

const INSERT_RECORDS_4 = [{id: 4, name: 'Griff'}];
let INSERT_HASHES_4 = [4];

const UPDATE_RECORDS_1 = [{id: 1, name: 'Penny B', age: 8}, {id: 2, name: 'Kato B'}];
let UPDATE_HASHES_1 = [1,2];

const UPDATE_RECORDS_2 = [{id: 'blerrrrr', breed: 'Mutt'}];
let UPDATE_HASHES_2 = ['blerrrrr'];

let DELETE_HASHES_1 = [3, 1];

const HDB_USER_1 = {
    username: 'kyle'
};

const HDB_USER_2 = {
    username: 'kato'
};

const HDB_USER_3 = {
    username: 'joy'
};

describe('Test lmdbReadTransactionLog module', ()=>{
    let rw_env_util;

    before(async ()=>{
        await fs.remove(BASE_PATH);
        rw_env_util = environment_utility.__set__('MAP_SIZE', 5*1024*1024*1024);
    });

    after(()=>{
        rw_env_util();
    });

    describe('test searchTransactionsByUsername function', ()=>{
        let search_txn_by_user_func = rw_read_txn_log.__get__('searchTransactionsByUsername');
        let txn_env;
        beforeEach(async ()=>{
            await fs.mkdirp(BASE_PATH);
            global.lmdb_map = undefined;
            txn_env = await lmdb_create_txn_envs(CREATE_TABLE_OBJ);
        });

        afterEach(async ()=>{
            txn_env.close();
            await fs.remove(BASE_PATH);
            global.lmdb_map = undefined;
        });

        it('test with no records', ()=>{
            let results = search_txn_by_user_func(txn_env, ['kyle']);
            assert.deepStrictEqual(results, {'kyle': []});
        });

        it('test fetching no users defined', async ()=>{
            await createTransactions();

            let results = search_txn_by_user_func(txn_env);
            assert.deepEqual(results, {});
        });

        it('test fetching multiple users', async ()=>{
            let txns = await createTransactions();

            let expected = new Map();
            expected.set('kyle', [txns[0],txns[3],txns[6]]);
            expected.set('joy', [txns[2],txns[5]]);

            let results = search_txn_by_user_func(txn_env, ['kyle', 'joy']);
            assert.deepEqual(results, Object.fromEntries(expected));
        });

        it('test fetching multiple users, one does not exist', async ()=>{
            let txns = await createTransactions();

            let expected = new Map();
            expected.set('kyle', [txns[0],txns[3],txns[6]]);
            expected.set('greg', []);
            expected.set('joy', [txns[2],txns[5]]);

            let results = search_txn_by_user_func(txn_env, ['kyle', 'greg', 'joy']);
            assert.deepEqual(results, Object.fromEntries(expected));
        });
    });

    describe('test searchTransactionsByHashvalues function', ()=>{
        let search_txn_by_hash_func = rw_read_txn_log.__get__('searchTransactionsByHashValues');
        let txn_env;
        beforeEach(async ()=>{
            await fs.mkdirp(BASE_PATH);
            global.lmdb_map = undefined;
            txn_env = await lmdb_create_txn_envs(CREATE_TABLE_OBJ);
        });

        afterEach(async ()=>{
            txn_env.close();
            await fs.remove(BASE_PATH);
            global.lmdb_map = undefined;
        });

        it('test reading by hash value', async ()=>{
            let txns = await createTransactions();

            let expected = new Map();
            let txn1_1 = new LMDBInsertTransactionObject([INSERT_RECORDS_1[0]], txns[0].user_name, txns[0].timestamp, undefined);
            let txn1_2 = new LMDBUpdateTransactionObject([UPDATE_RECORDS_1[0]], [INSERT_RECORDS_1[0]], txns[2].user_name, txns[2].timestamp, undefined);
            let txn1_3 = new LMDBDeleteTransactionObject(undefined, [UPDATE_RECORDS_1[0]], txns[5].user_name, txns[5].timestamp);

            let txn2_1 = new LMDBInsertTransactionObject([INSERT_RECORDS_1[1]], txns[0].user_name, txns[0].timestamp, undefined);
            let txn2_2 = new LMDBUpdateTransactionObject([UPDATE_RECORDS_1[1]], [INSERT_RECORDS_1[1]], txns[2].user_name, txns[2].timestamp, undefined);

            expected.set(1, [txn1_1, txn1_2, txn1_3]);
            expected.set(2, [txn2_1, txn2_2]);

            let results = search_txn_by_hash_func(txn_env, [1, 2], 'id');

            assert.deepEqual(results, Object.fromEntries(expected));
        });

        it('test reading by hash value when no txns', async ()=>{
            let results = search_txn_by_hash_func(txn_env, [1, 2], 'id');

            assert.deepEqual(results, {});
        });

        it('test reading by hash value with a hsh that does not exist', async ()=>{
            let txns = await createTransactions();

            let expected = new Map();
            let txn1_1 = new LMDBInsertTransactionObject([INSERT_RECORDS_1[0]], txns[0].user_name, txns[0].timestamp, undefined);
            let txn1_2 = new LMDBUpdateTransactionObject([UPDATE_RECORDS_1[0]], [INSERT_RECORDS_1[0]], txns[2].user_name, txns[2].timestamp, undefined);
            let txn1_3 = new LMDBDeleteTransactionObject(undefined, [UPDATE_RECORDS_1[0]], txns[5].user_name, txns[5].timestamp);

            let txn2_1 = new LMDBInsertTransactionObject([INSERT_RECORDS_1[1]], txns[0].user_name, txns[0].timestamp, undefined);
            let txn2_2 = new LMDBUpdateTransactionObject([UPDATE_RECORDS_1[1]], [INSERT_RECORDS_1[1]], txns[2].user_name, txns[2].timestamp, undefined);

            expected.set(1, [txn1_1, txn1_2, txn1_3]);
            expected.set(2, [txn2_1, txn2_2]);

            let results = search_txn_by_hash_func(txn_env, [1, 2, 'nope'], 'id');

            assert.deepEqual(results, Object.fromEntries(expected));
        });
    });

    describe('test searchTransactionsByTimestamp function', ()=>{
        let search_txn_by_timestamp_func = rw_read_txn_log.__get__('searchTransactionsByTimestamp');
        let txn_env;
        beforeEach(async ()=>{
            await fs.mkdirp(BASE_PATH);
            global.lmdb_map = undefined;
            txn_env = await lmdb_create_txn_envs(CREATE_TABLE_OBJ);
        });

        afterEach(async ()=>{
            txn_env.close();
            await fs.remove(BASE_PATH);
            global.lmdb_map = undefined;
        });

        it('test reading with no timestamps, should return all', async ()=>{
            let txns = await createTransactions();
            let results = search_txn_by_timestamp_func(txn_env);

            assert.deepEqual(results, txns);
        });

        it('test reading by timestamp when no txns', async ()=>{
            let results = search_txn_by_timestamp_func(txn_env);

            assert.deepEqual(results, []);
        });

        it('test reading by timestamp with timestamp newer than newest entry', async ()=>{
            await createTransactions();
            let results = search_txn_by_timestamp_func(txn_env, [common.getMicroTime(), common.getMicroTime() + 1]);

            assert.deepEqual(results, []);
        });

        it('test reading by timestamp with timestamp older than oldest entry', async ()=>{
            let txns = await createTransactions();
            let results = search_txn_by_timestamp_func(txn_env, [txns[0].timestamp - 1, txns[4].timestamp]);

            assert.deepEqual(results, [txns[0], txns[1], txns[2], txns[3], txns[4]]);
        });

        it('test reading by timestamp get some txns', async ()=>{
            let txns = await createTransactions();
            let results = search_txn_by_timestamp_func(txn_env, [txns[5].timestamp]);

            assert.deepEqual(results, [txns[5], txns[6]]);
        });

        it('test reading by timestamp get some other txns', async ()=>{
            let txns = await createTransactions();
            let results = search_txn_by_timestamp_func(txn_env, [txns[3].timestamp, txns[5].timestamp]);

            assert.deepEqual(results, [txns[3], txns[4], txns[5]]);
        });
    });

    describe('test readTransactionLog function', ()=>{
        let txn_env;
        beforeEach(async ()=>{
            await fs.mkdirp(BASE_PATH);
            global.lmdb_map = undefined;
            global.hdb_schema = {
                dev:{
                    test: {
                        hash_attribute: 'id'
                    }
                }
            };
            txn_env = await lmdb_create_txn_envs(CREATE_TABLE_OBJ);
        });

        afterEach(async ()=>{
            txn_env.close();
            await fs.remove(BASE_PATH);
            global.lmdb_map = undefined;
            delete global.hdb_schema;
        });

        it('test reading timestamps, should return all', async ()=>{
            let read_txn_obj = new ReadTransactionLogObject('dev', 'test', hdb_terms.READ_TRANSACTION_LOG_SEARCH_TYPES_ENUM.TIMESTAMP);

            let txns = await createTransactions();
            let results = await read_txn_log(read_txn_obj);

            assert.deepEqual(results, txns);
        });

        it('test reading timestamps with no type specified, should return all', async ()=>{
            let read_txn_obj = new ReadTransactionLogObject('dev', 'test');

            let txns = await createTransactions();
            let results = await read_txn_log(read_txn_obj);

            assert.deepEqual(results, txns);
        });

        it('test reading by username', async ()=>{
            let read_txn_obj = new ReadTransactionLogObject('dev', 'test', hdb_terms.READ_TRANSACTION_LOG_SEARCH_TYPES_ENUM.USERNAME,
                ['kyle', 'joy']);

            let txns = await createTransactions();
            let expected = new Map();
            expected.set('kyle', [txns[0],txns[3],txns[6]]);
            expected.set('joy', [txns[2],txns[5]]);

            let results = await read_txn_log(read_txn_obj);

            assert.deepEqual(results, Object.fromEntries(expected));
        });

        it('test reading by hash value', async ()=>{
            let read_txn_obj = new ReadTransactionLogObject('dev', 'test', hdb_terms.READ_TRANSACTION_LOG_SEARCH_TYPES_ENUM.HASH_VALUE,
                [1,2]);

            let txns = await createTransactions();

            let expected = new Map();
            let txn1_1 = new LMDBInsertTransactionObject([INSERT_RECORDS_1[0]], txns[0].user_name, txns[0].timestamp, undefined);
            let txn1_2 = new LMDBUpdateTransactionObject([UPDATE_RECORDS_1[0]], [INSERT_RECORDS_1[0]], txns[2].user_name, txns[2].timestamp, undefined);
            let txn1_3 = new LMDBDeleteTransactionObject(undefined, [UPDATE_RECORDS_1[0]], txns[5].user_name, txns[5].timestamp);

            let txn2_1 = new LMDBInsertTransactionObject([INSERT_RECORDS_1[1]], txns[0].user_name, txns[0].timestamp, undefined);
            let txn2_2 = new LMDBUpdateTransactionObject([UPDATE_RECORDS_1[1]], [INSERT_RECORDS_1[1]], txns[2].user_name, txns[2].timestamp, undefined);

            expected.set(1, [txn1_1, txn1_2, txn1_3]);
            expected.set(2, [txn2_1, txn2_2]);

            let results = await read_txn_log(read_txn_obj);

            assert.deepEqual(results, Object.fromEntries(expected));
        });
    });

});

async function createTransactions(){
    let insert_obj_1 = new InsertObject('dev', 'test', 'id', INSERT_RECORDS_1);
    insert_obj_1.hdb_user = HDB_USER_1;
    let insert_response_1 = new InsertRecordsResponseObject(INSERT_HASHES_1, [], common.getMicroTime());
    let txn_obj_1 = new LMDBInsertTransactionObject(insert_obj_1.records, insert_obj_1.hdb_user.username, insert_response_1.txn_time, insert_response_1.written_hashes);
    await lmdb_write_txn(insert_obj_1, insert_response_1);

    let insert_obj_2 = new InsertObject('dev', 'test', 'id', INSERT_RECORDS_2);
    insert_obj_2.hdb_user = HDB_USER_2;
    let insert_response_2 = new InsertRecordsResponseObject(INSERT_HASHES_2, [], common.getMicroTime());
    let txn_obj_2 = new LMDBInsertTransactionObject(insert_obj_2.records, insert_obj_2.hdb_user.username, insert_response_2.txn_time, insert_response_2.written_hashes);
    await lmdb_write_txn(insert_obj_2, insert_response_2);

    let update_obj_1 = new UpdateObject('dev', 'test', UPDATE_RECORDS_1);
    update_obj_1.hdb_user = HDB_USER_3;
    let update_response_1 = new UpdateRecordsResponseObject(UPDATE_HASHES_1, [], common.getMicroTime(), INSERT_RECORDS_1);
    let txn_obj_3 = new LMDBUpdateTransactionObject(update_obj_1.records, update_response_1.original_records, update_obj_1.hdb_user.username, update_response_1.txn_time, update_response_1.written_hashes);
    await lmdb_write_txn(update_obj_1, update_response_1);

    let m_time = common.getMicroTime();
    let origin = new ClusteringOriginObject(m_time, 'phil', 'node1');
    let insert_obj_3 = new InsertObject('dev', 'test', 'id', INSERT_RECORDS_3, origin);
    insert_obj_3.hdb_user = HDB_USER_1;
    let insert_response_3 = new InsertRecordsResponseObject(INSERT_HASHES_3, [], m_time);
    let txn_obj_4 = new LMDBInsertTransactionObject(insert_obj_3.records, insert_obj_3.hdb_user.username, insert_response_3.txn_time, insert_response_3.written_hashes, origin);
    await lmdb_write_txn(insert_obj_3, insert_response_3);

    let update_obj_2 = new UpdateObject('dev', 'test', UPDATE_RECORDS_2);
    update_obj_2.hdb_user = HDB_USER_2;
    let update_response_2 = new UpdateRecordsResponseObject(UPDATE_HASHES_2, [], common.getMicroTime(), INSERT_RECORDS_3);
    let txn_obj_5 = new LMDBUpdateTransactionObject(update_obj_2.records, update_response_2.original_records, update_obj_2.hdb_user.username, update_response_2.txn_time, update_response_2.written_hashes);
    await lmdb_write_txn(update_obj_2, update_response_2);

    let delete_obj_1 = new DeleteObject('dev', 'test', DELETE_HASHES_1);
    delete_obj_1.hdb_user = HDB_USER_3;
    let delete_response_1 = new DeleteRecordsResponseObject(DELETE_HASHES_1, [], common.getMicroTime(), [INSERT_RECORDS_2[0], UPDATE_RECORDS_1[0]]);
    let txn_obj_6 = new LMDBDeleteTransactionObject(delete_obj_1.hash_values, delete_response_1.original_records, delete_obj_1.hdb_user.username, delete_response_1.txn_time);
    await lmdb_write_txn(delete_obj_1, delete_response_1);

    let insert_obj_4 = new InsertObject('dev', 'test', 'id', INSERT_RECORDS_4);
    insert_obj_4.hdb_user = HDB_USER_1;
    let insert_response_4 = new InsertRecordsResponseObject(INSERT_HASHES_4, [], common.getMicroTime());
    let txn_obj_7 = new LMDBInsertTransactionObject(insert_obj_4.records, insert_obj_4.hdb_user.username, insert_response_4.txn_time, insert_response_4.written_hashes);
    await lmdb_write_txn(insert_obj_4, insert_response_4);

    return [txn_obj_1, txn_obj_2, txn_obj_3, txn_obj_4, txn_obj_5, txn_obj_6, txn_obj_7];
}