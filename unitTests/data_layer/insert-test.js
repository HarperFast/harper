'use strict';

const test_utils = require('../test_utils');

const rewire = require('rewire');
const insert_rw = rewire('../../data_layer/insert');
const assert = require('assert');
const sinon = require('sinon');

const { TEST_INSERT_OPS_ERROR_MSGS } = require('../commonTestErrors');

const HASH_ATTRIBUTE_NAME = 'id';

const UPSERT_OBJECT_TEST = {
    operation: "upsert",
    schema: 'dev',
    table: 'dog',
    records: [
        {
            name: "Harper",
            breed: "Mutt",
            id: "1",
            age: 5
        },
        {
            name: "Penny",
            breed: "Mutt",
            id: "2",
            age: 5,
            height: 145
        }
    ]
};

const TEST_BRIDGE_UPSERT_RESP = {
    written_hashes: [1, 2],
    txn_time: 12345,
    new_attributes: []
}

const EXPECTED_UPSERT_RESP = {
    message: "upserted 2 of 2 records",
    upserted_hashes: [1, 2],
    txn_time: 12345,
    new_attributes: []
}

const sandbox = sinon.createSandbox();

describe('Test insert module',() => {

    describe('Test upsert method', () => {
        let bridge_upsert_stub;
        let check_schema_stub;

        before(()=>{
            bridge_upsert_stub = sandbox.stub().returns(TEST_BRIDGE_UPSERT_RESP);
            check_schema_stub = sandbox.stub().returns(null);
        });

        beforeEach(() => {
            insert_rw.__set__('harperBridge', { upsertRecords: bridge_upsert_stub});
            insert_rw.__set__('hdb_utils', { checkSchemaTableExist: check_schema_stub});
        })

        afterEach(async ()=>{
            sandbox.restore();
        });

        after(() => {
            rewire('../../data_layer/insert');
        });

        it('NOMINAL - should return upsert response with upserted_hashes value',async () => {
            let results = await test_utils.assertErrorAsync(insert_rw.upsert, [UPSERT_OBJECT_TEST], undefined);
            assert.deepStrictEqual(results, EXPECTED_UPSERT_RESP);
        });

        it('Should return HdbError if operation is not upsert',async () => {
            const upsert_obj = test_utils.deepClone(UPSERT_OBJECT_TEST);
            upsert_obj.operation = 'insert';
            const expected_err = test_utils.generateHDBError('invalid operation, must be upsert', 500);
            await test_utils.assertErrorAsync(insert_rw.upsert, [upsert_obj], expected_err);
        });

        it('Should return HdbError if there is a schema validation error',async ()=>{
            const test_err_msg = 'Schema error!';
            check_schema_stub.returns(test_err_msg);
            insert_rw.__set__('hdb_utils', { checkSchemaTableExist: check_schema_stub});

            const expected_err = test_utils.generateHDBError(test_err_msg, 400);
            await test_utils.assertErrorAsync(insert_rw.upsert, [UPSERT_OBJECT_TEST], expected_err);
        });
    });

    describe('Test returnObject method', () => {
        let returnObject_rw;
        let ACTION_ENUM = {
            INSERT: 'inserted',
            UPDATE: 'updated',
            UPSERT: 'upserted'
        }
        let test_args = {
            written_hashes: [1,2],
            skipped_hashes: [3,4],
            new_attributes: ['name', 'breed'],
            txn_time: 123456789
        }
        let EXPECTED_MESSAGE = (action, written, total) => `${action} ${written} of ${total} records`;

        before(() => {
            returnObject_rw = insert_rw.__get__('returnObject');
        });

        it('Test for INSERT', async ()=>{
            let result = returnObject_rw(ACTION_ENUM.INSERT, test_args.written_hashes, test_args, test_args.skipped_hashes,
                test_args.new_attributes, test_args.txn_time);
            assert.equal(result.message, EXPECTED_MESSAGE(ACTION_ENUM.INSERT, 2,4));
        });

        it('Test for UPDATE', async ()=>{
            let result = returnObject_rw(ACTION_ENUM.UPDATE, test_args.written_hashes, test_args, test_args.skipped_hashes,
                test_args.new_attributes, test_args.txn_time);
            assert.equal(result.message, EXPECTED_MESSAGE(ACTION_ENUM.UPDATE, 2,4));
        });

        it('Test for UPSERT', async ()=>{
            let result = returnObject_rw(ACTION_ENUM.UPSERT, test_args.written_hashes, test_args, [],
                test_args.new_attributes, test_args.txn_time);
            assert.equal(result.message, EXPECTED_MESSAGE(ACTION_ENUM.UPSERT, 2,2));

        });

    });
});
