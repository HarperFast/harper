'use strict';

const rewire = require('rewire');
const read_txn_log = require('../../data_layer/readTransactionLog');
const rw_read_txn_log = rewire('../../data_layer/readTransactionLog');
const ReadTransactionLogObject = require('../../data_layer/ReadTransactionLogObject');

const sinon = require('sinon');
const sandbox = sinon.createSandbox();
const assert = require('assert');
const TEST_ERROR_MSGS = require('../commonTestErrors');

describe('test readTransactionLog module', ()=>{
    before(()=>{
        global.hdb_schema = {
            dev: {
                test:{
                    hash_attribute: "id"
                }
            }
        }
    });

    after(()=>{
        delete global.hdb_schema;
    });

    it('test no schema', async()=>{
        let obj = new ReadTransactionLogObject();

        let error = undefined;
        try {
            await read_txn_log(obj)
        } catch(e){
            error = e;
        }

        assert.deepStrictEqual(error, new Error(TEST_ERROR_MSGS.TEST_SCHEMA_OP_ERROR.SCHEMA_REQUIRED_ERR));
    });

    it('test no table', async()=>{
        let obj = new ReadTransactionLogObject('schema');

        let error = undefined;
        try {
            await read_txn_log(obj)
        } catch(e){
            error = e;
        }

        assert.deepStrictEqual(error, new Error(TEST_ERROR_MSGS.TEST_SCHEMA_OP_ERROR.TABLE_REQUIRED_ERR));
    });

    it('test invalid search type', async()=>{
        let obj = new ReadTransactionLogObject('dev', 'test', 'wrong');

        let error = undefined;
        try {
            await read_txn_log(obj)
        } catch(e){
            error = e;
        }

        assert.deepStrictEqual(error, new Error(`Invalid search_type '${obj.search_type}'`));
    });

    it('test happy path', async()=>{
        let stub = sandbox.stub().resolves([]);
        let rw_stub = rw_read_txn_log.__set__('harperBridge', {
            readTransactionLog: stub
        });

        let obj = new ReadTransactionLogObject('dev', 'test', 'timestamp');

        let error = undefined;
        try {
            await rw_read_txn_log(obj);
        } catch(e){
            error = e;
        }

        assert.deepStrictEqual(error, undefined);

        rw_stub();
    });


});
