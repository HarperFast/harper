'use strict';

const test_util = require('../../../test_utils');
test_util.preTestPrep();

const rewire = require('rewire');
const path = require('path');
const assert = require('assert');
const fs = require('fs-extra');
const sc_utils = rewire('../../../../server/socketcluster/util/socketClusterUtils');
const MOCKFS_PATH = test_util.getMockFSPath();

const TRANSACTION_LOG_PATH = path.join(MOCKFS_PATH, 'clustering', 'transaction_log', );
const CHANNEL_NAME_DEV_DOG = 'dev:dog';
const CHANNEL_NAME_DEV_BREED = 'dev:breed';
const CHANNEL_NAME_DEV_BAD = 'dev:bad';

const CHANNEL_LOG_PATH_DEV_DOG = path.join(TRANSACTION_LOG_PATH, CHANNEL_NAME_DEV_DOG);
const CHANNEL_LOG_PATH_DEV_BREED = path.join(TRANSACTION_LOG_PATH, CHANNEL_NAME_DEV_BREED);
const CHANNEL_AUDIT_FILE_PATH = path.join(CHANNEL_LOG_PATH_DEV_DOG, 'audit.json');
const CHANNEL_AUDIT_FILE_DATA = {
    "keep": {
        "days": false,
        "amount": 10
    },
    "auditLog": "/home/kyle/hdb/clustering/transaction_log/dev:dog/audit.json",
    "files": [
        {
            "date": 1566493358738,
            "name": "/home/kyle/hdb/clustering/transaction_log/dev:dog/dev:dog.201908221102",
            "hash": "94902fe17b9e8a33a7f89b894d64ce13"
        },
        {
            "date": 1566493702105,
            "name": "/home/kyle/hdb/clustering/transaction_log/dev:dog/dev:dog.201908221108",
            "hash": "30c2eb3e6defd43aee9bf338c46423a1"
        },
        {
            "date": 1566497336658,
            "name": "/home/kyle/hdb/clustering/transaction_log/dev:dog/dev:dog.201908221208",
            "hash": "5583258643e03e8fc70e079e657ffd27"
        }
    ]
};
const CHANNEL_LOG_FILE1_PATH = path.join(CHANNEL_LOG_PATH_DEV_DOG, 'dev:dog.201908221102');
const CHANNEL_LOG_FILE1_DATA = '1566493358734,insert,%5B%7B%22name%22%3A%22Harper%22%2C%22breed%22%3A%22Mutt%22%2C%22id%22%3A%22887888%22%2C%22age%22%3A5%7D%2C%7B%22name%22%3A%22Penny%22%2C%22breed%22%3A%22Mutt%22%2C%22id%22%3A%22998%22%2C%22age%22%3A5%7D%5D';
const CHANNEL_LOG_FILE2_PATH = path.join(CHANNEL_LOG_PATH_DEV_DOG, 'dev:dog.201908221108');
const CHANNEL_LOG_FILE2_DATA = '1566493702103,insert,%5B%7B%22name%22%3A%22%5CtHarper%5C%22%22%2C%22breed%22%3A%22Mutt%5Cn%22%2C%22id%22%3A%228871888%22%2C%22age%22%3A5%7D%2C%7B%22name%22%3A%22Penny%22%2C%22breed%22%3A%22Mutt%22%2C%22id%22%3A%229198%22%2C%22age%22%3A5%7D%5D';
const CHANNEL_LOG_FILE3_PATH = path.join(CHANNEL_LOG_PATH_DEV_DOG, 'dev:dog.201908221208');
const CHANNEL_LOG_FILE3_DATA = '1566497336655,insert,%5B%7B%22name%22%3A%22%5CtHarper%5C%22%22%2C%22breed%22%3A%22Mutt%5Cn%22%2C%22id%22%3A%2288715888%22%2C%22age%22%3A5%7D%2C%7B%22name%22%3A%22Penny%22%2C%22breed%22%3A%22Mutt%22%2C%22id%22%3A%2291598%22%2C%22age%22%3A5%7D%5D';

const TIMESTAMP_8_20_2019 = 1566259200000;
const TIMESTAMP_8_25_2019 = 1566691200000;

const TIMESTAMP_1566493702000 = 1566493702000;
const TIMESTAMP_1566497336650 = 1566497336650;

describe('Test socketClusterUtils', ()=> {

    describe('Test catchupHandler', ()=>{
        let HDB_QUEUE_PATH_revert;
        before(async ()=>{
            HDB_QUEUE_PATH_revert = sc_utils.__set__('HDB_QUEUE_PATH', TRANSACTION_LOG_PATH);

            await fs.mkdirp(CHANNEL_LOG_PATH_DEV_DOG);
            await fs.mkdirp(CHANNEL_LOG_PATH_DEV_BREED);
            await fs.writeFile(CHANNEL_AUDIT_FILE_PATH, JSON.stringify(CHANNEL_AUDIT_FILE_DATA));
            await fs.writeFile(CHANNEL_LOG_FILE1_PATH, CHANNEL_LOG_FILE1_DATA);
            await fs.writeFile(CHANNEL_LOG_FILE2_PATH, CHANNEL_LOG_FILE2_DATA);
            await fs.writeFile(CHANNEL_LOG_FILE3_PATH, CHANNEL_LOG_FILE3_DATA);
        });

        after(()=>{
            HDB_QUEUE_PATH_revert();
            test_util.tearDownMockFS();
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