'use strict';

const test_util = require('../../../test_utils');
test_util.preTestPrep();
const BASE_PATH = test_util.getMockFSPath();

const rewire = require('rewire');
const LMDBBridge = require('../../../../data_layer/harperBridge/lmdbBridge/LMDBBridge');
const rw_read_txn_log = rewire('../../../../data_layer/readTransactionLog');
const rw_bridge = rw_read_txn_log.__set__('harperBridge', new LMDBBridge());
const assert = require('assert');
const fs = require('fs-extra');
const sc_utils = rewire('../../../../server/socketcluster/util/socketClusterUtils');
const rw_sc = sc_utils.__set__('read_transaction_log', rw_read_txn_log);


const CreateTableObject = require('../../../../data_layer/CreateTableObject');
const InsertObject = require("../../../../data_layer/InsertObject");
const InsertRecordsResponseObject = require("../../../../utility/lmdb/InsertRecordsResponseObject");
const LMDBInsertTransactionObject = require("../../../../data_layer/harperBridge/lmdbBridge/lmdbUtility/LMDBInsertTransactionObject");
const lmdb_write_txn = require('../../../../data_layer/harperBridge/lmdbBridge/lmdbUtility/lmdbWriteTransaction');
const lmdb_create_txn_envs = require('../../../../data_layer/harperBridge/lmdbBridge/lmdbUtility/lmdbCreateTransactionsEnvironment');

const CHANNEL_NAME_DEV_DOG = 'dev:dog';
const CHANNEL_NAME_DEV_BREED = 'dev:breed';
const CHANNEL_NAME_DEV_BAD = 'dev:bad';

const CREATE_TABLE_OBJ = new CreateTableObject('dev', 'dog', 'id');
const INSERT_RECORDS_1 = [{id: 1, name: 'Penny'}, {id: 2, name: 'Kato', age: '6'}];
let INSERT_HASHES_1 = [1,2];
const INSERT_TIMESTAMP_1 = 1566493358734.539;

const INSERT_RECORDS_2 = [{id: 3, name: 'Riley', age: '7'}];
let INSERT_HASHES_2 = [3];
const INSERT_TIMESTAMP_2 = 1566493702103.245;

const INSERT_RECORDS_3 = [{id: 'blerrrrr', name: 'Rosco'}];
let INSERT_HASHES_3 = ['blerrrrr'];
const INSERT_TIMESTAMP_3 = 1566497336655.821;

const HDB_USER_1 = {
    username: 'kyle'
};

const TIMESTAMP_8_20_2019 = 1566259200000;
const TIMESTAMP_8_25_2019 = 1566691200000;

const TIMESTAMP_1566493702000 = 1566493702000;
const TIMESTAMP_1566497336650 = 1566497336650;

describe('Test socketClusterUtils', ()=> {

    describe('Test catchupHandler', ()=>{
        before(async ()=>{
            await fs.remove(BASE_PATH);
            await fs.mkdirp(BASE_PATH);
            global.lmdb_map = undefined;
            global.hdb_schema = {
                dev: {
                    dog: {
                        hash_attribute: 'id'
                    }
                }
            };
            await lmdb_create_txn_envs(CREATE_TABLE_OBJ);
            let insert_obj_1 = new InsertObject('dev', 'dog', 'id', INSERT_RECORDS_1);
            insert_obj_1.hdb_user = HDB_USER_1;
            let insert_response_1 = new InsertRecordsResponseObject(INSERT_HASHES_1, [], INSERT_TIMESTAMP_1);
            new LMDBInsertTransactionObject(insert_obj_1.records, insert_obj_1.hdb_user.username, insert_response_1.txn_time, insert_response_1.written_hashes);
            await lmdb_write_txn(insert_obj_1, insert_response_1);

            let insert_obj_2 = new InsertObject('dev', 'dog', 'id', INSERT_RECORDS_2);
            insert_obj_2.hdb_user = HDB_USER_1;
            let insert_response_2 = new InsertRecordsResponseObject(INSERT_HASHES_2, [], INSERT_TIMESTAMP_2);
            new LMDBInsertTransactionObject(insert_obj_2.records, insert_obj_2.hdb_user.username, insert_response_2.txn_time, insert_response_2.written_hashes);
            await lmdb_write_txn(insert_obj_2, insert_response_2);

            let insert_obj_3 = new InsertObject('dev', 'dog', 'id', INSERT_RECORDS_3);
            insert_obj_3.hdb_user = HDB_USER_1;
            let insert_response_3 = new InsertRecordsResponseObject(INSERT_HASHES_3, [], INSERT_TIMESTAMP_3);
            new LMDBInsertTransactionObject(insert_obj_3.records, insert_obj_3.hdb_user.username, insert_response_3.txn_time, insert_response_3.written_hashes);
            await lmdb_write_txn(insert_obj_3, insert_response_3);
        });

        after(async ()=>{
            global.lmdb_map = undefined;
            global.hdb_schema = undefined;
            await fs.remove(BASE_PATH);
            rw_bridge();
            rw_sc();
        });

        it('pass no attributes', ()=>{
            assert.rejects(async ()=>{
                await sc_utils.catchupHandler();
            });
        });

        it('pass channel dev:dog & no start', ()=>{
            assert.rejects(async ()=>{
                await sc_utils.catchupHandler(CHANNEL_NAME_DEV_DOG);
            });
        });

        it('pass channel dev:dog & start_timestamp as string', ()=>{
            assert.rejects(async ()=>{
                await sc_utils.catchupHandler(CHANNEL_NAME_DEV_DOG, 'blerg');
            });
        });

        it('pass channel dev:dog & start_timestamp greater than end_timestamp', ()=>{
            assert.rejects(async ()=>{
                await sc_utils.catchupHandler(CHANNEL_NAME_DEV_DOG, TIMESTAMP_8_25_2019, TIMESTAMP_8_20_2019);
            });
        });

        it('pass channel dev:dog & start_timestamp as now, expect no results', async ()=>{
            let rez = await sc_utils.catchupHandler(CHANNEL_NAME_DEV_DOG, Date.now());
            assert.deepEqual(rez, undefined);
        });

        it('pass channel dev:dog & start_timestamp as the epoch for 8/20/2019, expect 3 results', async ()=>{
            let rez = await sc_utils.catchupHandler(CHANNEL_NAME_DEV_DOG, TIMESTAMP_8_20_2019);
            assert.equal(rez.transaction.transactions.length, 3);
        });

        it('pass channel dev:dog & start_timestamp as the epoch for 8/20/2019, expect 3 results', async ()=>{
            let rez = await sc_utils.catchupHandler(CHANNEL_NAME_DEV_DOG, TIMESTAMP_8_20_2019);
            assert.equal(rez.transaction.transactions.length, 3);
        });

        it('pass channel dev:dog & start_timestamp as 1566493702000, expect 2 results', async ()=>{
            let rez = await sc_utils.catchupHandler(CHANNEL_NAME_DEV_DOG, TIMESTAMP_1566493702000);
            assert.equal(rez.transaction.transactions.length, 2);
        });

        it('pass channel dev:dog & start_timestamp as 1566493702000 & end_timestamp as 1566497336650, expect 1 results', async ()=>{
            let rez = await sc_utils.catchupHandler(CHANNEL_NAME_DEV_DOG, TIMESTAMP_1566493702000, TIMESTAMP_1566497336650);
            assert.equal(rez.transaction.transactions.length, 1);
        });

        it('pass channel dev:breed & start_timestamp as 1566493702000 & end_timestamp as 1566497336650, expect no results', async ()=>{
            let rez = await sc_utils.catchupHandler(CHANNEL_NAME_DEV_BREED, TIMESTAMP_1566493702000, TIMESTAMP_1566497336650);
            assert.equal(rez, undefined);
        });

        it('pass channel dev:bad & start_timestamp as 1566493702000 & end_timestamp as 1566497336650, expect no results', async ()=>{
            let rez = await sc_utils.catchupHandler(CHANNEL_NAME_DEV_BAD, TIMESTAMP_1566493702000, TIMESTAMP_1566497336650);
            assert.equal(rez, undefined);
        });
    });

});