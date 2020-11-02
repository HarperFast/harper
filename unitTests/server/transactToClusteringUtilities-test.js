'use strict';

const test_utils = require('../test_utils');
test_utils.preTestPrep();

const rewire = require('rewire');
const assert = require('assert');
const rw_server_utilities = rewire('../../server/transactToClusteringUtilities');
const rw_convert_crud_op = rw_server_utilities.__get__('convertCRUDOperationToTransaction');
const InsertObject = require('../../data_layer/InsertObject');
const UpdateObject = require('../../data_layer/UpdateObject');
const UpsertObject = require('../../data_layer/UpsertObject');
const DeleteObject = require('../../data_layer/DeleteObject');
const cluster_messages = require('../../server/socketcluster/room/RoomMessageObjects');
const ClusteringOriginObject = require('../../server/ClusteringOriginObject');
const lmdb_utils = require('../../utility/lmdb/commonUtility');
const uuid = require('uuid');
const sinon = require('sinon');
const sandbox = sinon.createSandbox();
const logger = require('../../utility/logging/harper_logger');


const UUID_VALUE = '1234-abcd';
const DATE_NOW = Date.now();

const USER = {
    "username": "HDB_ADMIN"
};

let INSERT_OP = new InsertObject('dev', 'dog', 'id', [{id: 1, name: 'Penny'}]);
INSERT_OP.hdb_user = USER;

let UPDATE_OP = new UpdateObject('dev', 'dog', [{id: 1, name: 'Penny B', age: 8}]);
UPDATE_OP.hdb_user = USER;

let UPSERT_OP = new UpsertObject('dev', 'dog', [{id: 1, name: 'Penny', age: 8}]);
UPSERT_OP.hdb_user = USER;

let DELETE_OP = new DeleteObject('dev', 'dog', [1]);
DELETE_OP.hdb_user = USER;

describe('test convertCRUDOperationToTransaction function', ()=>{

    before(()=>{
        sandbox.stub(uuid, 'v4').returns(UUID_VALUE);
        sandbox.stub(Date, 'now').returns(DATE_NOW);
    });

    after(()=>{
        sandbox.restore();
    });

    beforeEach(()=>{
        global.hdb_socket_client = {};
    });

    afterEach(()=>{
        global.hdb_socket_client = undefined;
    });

    it('test with no global.hdb_socket_client', ()=>{
        global.hdb_socket_client = undefined;
        let result = rw_convert_crud_op();
        assert.deepStrictEqual(result, null);
    });

    it('test with no affected_hashes', ()=>{
        let result = rw_convert_crud_op({});
        assert.deepStrictEqual(result, null);
    });

    it('test with an insert operation', ()=>{
        let op = test_utils.deepClone(INSERT_OP);
        const hashes = [1];
        let txn_time = lmdb_utils.getMicroTime();
        let result = rw_convert_crud_op(op, hashes, txn_time);

        let expected = new cluster_messages.HdbCoreTransactionMessage();
        expected.type = 'HDB_TRANSACTION';
        expected.transaction = {
            operation: 'insert',
            schema: 'dev',
            table: 'dog',
            records: op.records,
            __origin: new ClusteringOriginObject(txn_time, USER.username, '1231412de213')
        };

        assert.deepStrictEqual(result, expected);
    });

    it('test with an update operation', ()=>{
        let op = test_utils.deepClone(UPDATE_OP);
        const hashes = [1];
        let txn_time = lmdb_utils.getMicroTime();
        let result = rw_convert_crud_op(op, hashes, txn_time);

        let expected = new cluster_messages.HdbCoreTransactionMessage();
        expected.type = 'HDB_TRANSACTION';
        expected.transaction = {
            operation: 'update',
            schema: 'dev',
            table: 'dog',
            records: op.records,
            __origin: new ClusteringOriginObject(txn_time, USER.username, '1231412de213')
        };

        assert.deepStrictEqual(result, expected);
    });

    it('test with an upsert operation', ()=>{
        let op = test_utils.deepClone(UPSERT_OP);
        const hashes = [1];
        let txn_time = lmdb_utils.getMicroTime();
        let result = rw_convert_crud_op(op, hashes, txn_time);

        let expected = new cluster_messages.HdbCoreTransactionMessage();
        expected.type = 'HDB_TRANSACTION';
        expected.transaction = {
            operation: 'upsert',
            schema: 'dev',
            table: 'dog',
            records: op.records,
            __origin: new ClusteringOriginObject(txn_time, USER.username, '1231412de213')
        };

        assert.deepStrictEqual(result, expected);
    });

    it('test with a delete operation', ()=>{
        let op = test_utils.deepClone(DELETE_OP);
        const hashes = [1];
        let txn_time = lmdb_utils.getMicroTime();
        let result = rw_convert_crud_op(op, hashes, txn_time);

        let expected = new cluster_messages.HdbCoreTransactionMessage();
        expected.type = 'HDB_TRANSACTION';
        expected.transaction = {
            operation: 'delete',
            schema: 'dev',
            table: 'dog',
            hash_values: op.hash_values,
            __origin: new ClusteringOriginObject(txn_time, USER.username, '1231412de213')
        };

        assert.deepStrictEqual(result, expected);
    });
});

//TODO in the future test these functions more extensively
//This only very nominally tests this function
describe('test postOperationHandler', ()=>{

    let send_op_txn_stub = sandbox.stub().returns();
    let send_attr_txn_stub = sandbox.stub().returns();
    let send_schema_txn_stub = sandbox.spy();
    let concat_src_msg_header_stub = sandbox.spy();
    let send_txn_to_sc_spy = sandbox.spy();
    let get_cluster_msg_spy = sandbox.spy(sandbox.stub().returns({}));
    let rw_send_op_txn;

    let rw_common_utils;
    let rw_sendAttributeTransaction;
    let rw_sendSchemaTransaction;
    let rw_concatSourceMessageHeader;
    let rw_logger;

    const test_err_msg = 'There was an error!';
    let logger_spy = sandbox.spy();

    before(()=>{
        rw_send_op_txn = rw_server_utilities.__set__('sendOperationTransaction', send_op_txn_stub);

        rw_sendAttributeTransaction = rw_server_utilities.__set__('sendAttributeTransaction', send_attr_txn_stub);
        rw_sendSchemaTransaction = rw_server_utilities.__set__('sendSchemaTransaction', send_schema_txn_stub);
        rw_concatSourceMessageHeader = rw_server_utilities.__set__('concatSourceMessageHeader', concat_src_msg_header_stub);

        rw_common_utils = rw_server_utilities.__set__('common_utils', {
            sendTransactionToSocketCluster: send_txn_to_sc_spy,
            getClusterMessage:get_cluster_msg_spy
        });

        rw_logger = rw_server_utilities.__set__('harper_logger', {error: logger_spy});
    });

    afterEach(()=>{
        send_op_txn_stub.reset();
        send_attr_txn_stub.reset();
        send_schema_txn_stub.resetHistory();
        concat_src_msg_header_stub.resetHistory();
        send_txn_to_sc_spy.resetHistory();
        get_cluster_msg_spy.resetHistory();
        logger_spy.resetHistory();
    });

    after(()=>{
        sandbox.restore();
        rw_send_op_txn();
        rw_common_utils();
        rw_sendAttributeTransaction();
        rw_sendSchemaTransaction();
        rw_concatSourceMessageHeader();
        rw_logger();
    });

    it('test insert', ()=>{
        rw_server_utilities.postOperationHandler({operation:'insert'}, {inserted_hashes:[]});
        assert(get_cluster_msg_spy.calledOnce === true);
        assert(send_op_txn_stub.calledOnce === true);
        assert(send_op_txn_stub.threw() === false);
        assert(send_attr_txn_stub.calledOnce === true);
        assert(send_attr_txn_stub.threw() === false);
    });

    it('test insert sendOperationTransaction error is logged', ()=>{
        send_op_txn_stub.throws(new Error(test_err_msg));

        rw_server_utilities.postOperationHandler({operation:'insert'}, {update_hashes:[]});
        assert(get_cluster_msg_spy.calledOnce === true);
        assert(send_op_txn_stub.calledOnce === true);
        assert(send_op_txn_stub.threw() === true);
        assert(send_attr_txn_stub.called === false);

        assert(logger_spy.calledTwice === true);
        assert(logger_spy.firstCall.args[0] === "There was an error calling insert followup function.");
        assert(logger_spy.secondCall.args[0].message === test_err_msg);
    });

    it('test update', ()=>{
        rw_server_utilities.postOperationHandler({operation:'update'}, {update_hashes:[]});
        assert(get_cluster_msg_spy.calledOnce === true);
        assert(send_op_txn_stub.calledOnce === true);
        assert(send_op_txn_stub.threw() === false);
        assert(send_attr_txn_stub.calledOnce === true);
        assert(send_attr_txn_stub.threw() === false);
    });

    it('test update sendOperationTransaction error is logged', ()=>{
        send_op_txn_stub.throws(new Error(test_err_msg));

        rw_server_utilities.postOperationHandler({operation:'update'}, {update_hashes:[]});
        assert(get_cluster_msg_spy.calledOnce === true);
        assert(send_op_txn_stub.calledOnce === true);
        assert(send_op_txn_stub.threw() === true);
        assert(send_attr_txn_stub.called === false);

        assert(logger_spy.calledTwice === true);
        assert(logger_spy.firstCall.args[0] === "There was an error calling update followup function.");
        assert(logger_spy.secondCall.args[0].message === test_err_msg);
    });

    it('test upsert', ()=>{
        rw_server_utilities.postOperationHandler({operation:'upsert'}, {update_hashes:[]});
        assert(get_cluster_msg_spy.calledOnce === true);
        assert(send_op_txn_stub.calledOnce === true);
        assert(send_op_txn_stub.threw() === false);
        assert(send_attr_txn_stub.calledOnce === true);
        assert(send_attr_txn_stub.threw() === false);
    });

    it('test upsert sendOperationTransaction error is logged', ()=>{
        send_op_txn_stub.throws(new Error(test_err_msg));

        rw_server_utilities.postOperationHandler({operation:'upsert'}, {update_hashes:[]});
        assert(get_cluster_msg_spy.calledOnce === true);
        assert(send_op_txn_stub.calledOnce === true);
        assert(send_op_txn_stub.threw() === true);
        assert(send_attr_txn_stub.called === false);

        assert(logger_spy.calledTwice === true);
        assert(logger_spy.firstCall.args[0] === "There was an error calling upsert followup function.");
        assert(logger_spy.secondCall.args[0].message === test_err_msg);
    });

    it('test delete', ()=>{
        rw_server_utilities.postOperationHandler({operation:'delete'}, {deleted_hashes:[]});
        assert(get_cluster_msg_spy.calledOnce === true);
        assert(send_op_txn_stub.calledOnce === true);
        assert(send_op_txn_stub.threw() === false);
        assert(send_attr_txn_stub.called === false);
    });

    it('test update sendOperationTransaction error is logged', ()=>{
        send_op_txn_stub.throws(new Error(test_err_msg));

        rw_server_utilities.postOperationHandler({operation:'delete'}, {update_hashes:[]});
        assert(get_cluster_msg_spy.calledOnce === true);
        assert(send_op_txn_stub.calledOnce === true);
        assert(send_op_txn_stub.threw() === true);

        assert(logger_spy.calledTwice === true);
        assert(logger_spy.firstCall.args[0] === "There was an error calling delete followup function.");
        assert(logger_spy.secondCall.args[0].message === test_err_msg);
    });

    it('test create_schema', ()=>{
        rw_server_utilities.postOperationHandler({operation:'create_schema', schema: 'dev'}, {});
        assert(get_cluster_msg_spy.calledOnce === true);
        assert(send_op_txn_stub.called === false);
        assert(send_op_txn_stub.threw() === false);
        assert(send_attr_txn_stub.called === false);
        assert(send_schema_txn_stub.calledOnce === true);
    });

    it('test create_table', ()=>{
        rw_server_utilities.postOperationHandler({operation:'create_table', schema: 'dev', table:'dog', hash_attribute:'id'}, {});
        assert(get_cluster_msg_spy.calledOnce === true);
        assert(send_op_txn_stub.called === false);
        assert(send_op_txn_stub.threw() === false);
        assert(send_attr_txn_stub.called === false);
        assert(send_schema_txn_stub.calledOnce === true);
    });

    it('test create_attribute', ()=>{
        rw_server_utilities.postOperationHandler({operation:'create_attribute', schema: 'dev', table:'dog', attribute:'age'}, {}, {});
        assert(get_cluster_msg_spy.calledOnce === true);
        assert(send_op_txn_stub.called === false);
        assert(send_op_txn_stub.threw() === false);
        assert(send_attr_txn_stub.called === false);
        assert(send_schema_txn_stub.called === false);
        assert(concat_src_msg_header_stub.calledOnce === true);
    });

    it('test csv_data_load', ()=>{
        rw_server_utilities.postOperationHandler({operation:'csv_data_load', schema: 'dev', table:'dog', attribute:'age'}, {}, {});
        assert(get_cluster_msg_spy.calledOnce === true);
        assert(send_op_txn_stub.called === false);
        assert(send_op_txn_stub.threw() === false);
        assert(send_attr_txn_stub.called === false);
        assert(send_txn_to_sc_spy.called === false);
        assert(send_schema_txn_stub.calledOnce === true);
    });
});
