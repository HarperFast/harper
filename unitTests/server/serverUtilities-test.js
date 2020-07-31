'use strict';

const test_utils = require('../test_utils');
test_utils.preTestPrep();

const rewire = require('rewire');
const assert = require('assert');
const server_utilities = require('../../server/serverUtilities');
const rw_server_utilities = rewire('../../server/serverUtilities');
const rw_convert_crud_op = rw_server_utilities.__get__('convertCRUDOperationToTransaction');
const InsertObject = require('../../data_layer/InsertObject');
const UpdateObject = require('../../data_layer/UpdateObject');
const DeleteObject = require('../../data_layer/DeleteObject');
const cluster_messages = require('../../server/socketcluster/room/RoomMessageObjects');
const ClusteringOriginObject = require('../../server/ClusteringOriginObject');
const lmdb_utils = require('../../utility/lmdb/commonUtility');
const uuid = require('uuid');
const sinon = require('sinon');
const sandbox = sinon.createSandbox();


const UUID_VALUE = '1234-abcd';
const DATE_NOW = Date.now();

const USER = {
    "username": "HDB_ADMIN"
};

let INSERT_OP = new InsertObject('dev', 'dog', 'id', [{id: 1, name: 'Penny'}]);
INSERT_OP.hdb_user = USER;

let UPDATE_OP = new UpdateObject('dev', 'dog', [{id: 1, name: 'Penny B', age: 8}]);
UPDATE_OP.hdb_user = USER;

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

describe('test getOperationFunction', ()=>{
    it('test insert', ()=>{
        let result = server_utilities.getOperationFunction({operation: 'insert'});

        assert.deepStrictEqual(result.operation_function.name, 'insertData');
        assert.deepStrictEqual(result.job_operation_function, undefined);
    });

    it('test update', ()=>{
        let result = server_utilities.getOperationFunction({operation: 'update'});

        assert.deepStrictEqual(result.operation_function.name, 'updateData');
        assert.deepStrictEqual(result.job_operation_function, undefined);
    });

    it('test SEARCH_BY_HASH', ()=>{
        let result = server_utilities.getOperationFunction({operation: 'search_by_hash'});

        assert.deepStrictEqual(result.operation_function.name, 'searchByHash');
        assert.deepStrictEqual(result.job_operation_function, undefined);
    });

    it('test SEARCH_BY_VALUE', ()=>{
        let result = server_utilities.getOperationFunction({operation: 'search_by_value'});

        assert.deepStrictEqual(result.operation_function.name, 'searchByValue');
        assert.deepStrictEqual(result.job_operation_function, undefined);
    });

    it('test SEARCH', ()=>{
        let result = server_utilities.getOperationFunction({operation: 'search'});

        assert.deepStrictEqual(result.operation_function.name, 'search');
        assert.deepStrictEqual(result.job_operation_function, undefined);
    });

    it('test SQL', ()=>{
        let result = server_utilities.getOperationFunction({operation: 'sql'});

        assert.deepStrictEqual(result.operation_function.name, 'evaluateSQL');
        assert.deepStrictEqual(result.job_operation_function, undefined);
    });

    it('test CSV_DATA_LOAD', ()=>{
        let result = server_utilities.getOperationFunction({operation: 'csv_data_load'});

        assert.deepStrictEqual(result.operation_function.name, 'signalJob');
        assert.deepStrictEqual(result.job_operation_function.name, 'csvDataLoad');
    });

    it('test CSV_FILE_LOAD', ()=>{
        let result = server_utilities.getOperationFunction({operation: 'csv_file_load'});

        assert.deepStrictEqual(result.operation_function.name, 'signalJob');
        assert.deepStrictEqual(result.job_operation_function.name, 'csvFileLoad');
    });

    it('test CSV_URL_LOAD', ()=>{
        let result = server_utilities.getOperationFunction({operation: 'csv_url_load'});

        assert.deepStrictEqual(result.operation_function.name, 'signalJob');
        assert.deepStrictEqual(result.job_operation_function.name, 'csvURLLoad');
    });

    it('test CREATE_SCHEMA', ()=>{
        let result = server_utilities.getOperationFunction({operation: 'create_schema'});

        assert.deepStrictEqual(result.operation_function.name, 'createSchema');
        assert.deepStrictEqual(result.job_operation_function, undefined);
    });

    it('test CREATE_TABLE', ()=>{
        let result = server_utilities.getOperationFunction({operation: 'create_table'});

        assert.deepStrictEqual(result.operation_function.name, 'createTable');
        assert.deepStrictEqual(result.job_operation_function, undefined);
    });

    it('test CREATE_ATTRIBUTE', ()=>{
        let result = server_utilities.getOperationFunction({operation: 'create_attribute'});

        assert.deepStrictEqual(result.operation_function.name, 'createAttribute');
        assert.deepStrictEqual(result.job_operation_function, undefined);
    });

    it('test DROP_SCHEMA', ()=>{
        let result = server_utilities.getOperationFunction({operation: 'drop_schema'});

        assert.deepStrictEqual(result.operation_function.name, 'dropSchema');
        assert.deepStrictEqual(result.job_operation_function, undefined);
    });

    it('test DROP_TABLE', ()=>{
        let result = server_utilities.getOperationFunction({operation: 'drop_table'});

        assert.deepStrictEqual(result.operation_function.name, 'dropTable');
        assert.deepStrictEqual(result.job_operation_function, undefined);
    });

    it('test DROP_ATTRIBUTE', ()=>{
        let result = server_utilities.getOperationFunction({operation: 'drop_attribute'});

        assert.deepStrictEqual(result.operation_function.name, 'dropAttribute');
        assert.deepStrictEqual(result.job_operation_function, undefined);
    });

    it('test DESCRIBE_SCHEMA', ()=>{
        let result = server_utilities.getOperationFunction({operation: 'describe_schema'});

        assert.deepStrictEqual(result.operation_function.name, 'describeSchema');
        assert.deepStrictEqual(result.job_operation_function, undefined);
    });

    it('test DESCRIBE_TABLE', ()=>{
        let result = server_utilities.getOperationFunction({operation: 'describe_table'});

        assert.deepStrictEqual(result.operation_function.name, 'descTable');
        assert.deepStrictEqual(result.job_operation_function, undefined);
    });

    it('test DESCRIBE_ALL', ()=>{
        let result = server_utilities.getOperationFunction({operation: 'describe_all'});

        assert.deepStrictEqual(result.operation_function.name, 'describeAll');
        assert.deepStrictEqual(result.job_operation_function, undefined);
    });

    it('test DELETE', ()=>{
        let result = server_utilities.getOperationFunction({operation: 'delete'});

        assert.deepStrictEqual(result.operation_function.name, 'deleteRecordCallbackified');
        assert.deepStrictEqual(result.job_operation_function, undefined);
    });

    it('test ADD_USER', ()=>{
        let result = server_utilities.getOperationFunction({operation: 'add_user'});

        assert.deepStrictEqual(result.operation_function.name, 'addUser');
        assert.deepStrictEqual(result.job_operation_function, undefined);
    });

    it('test ALTER_USER', ()=>{
        let result = server_utilities.getOperationFunction({operation: 'alter_user'});

        assert.deepStrictEqual(result.operation_function.name, 'alterUser');
        assert.deepStrictEqual(result.job_operation_function, undefined);
    });

    it('test DROP_USER', ()=>{
        let result = server_utilities.getOperationFunction({operation: 'drop_user'});

        assert.deepStrictEqual(result.operation_function.name, 'dropUser');
        assert.deepStrictEqual(result.job_operation_function, undefined);
    });

    it('test LIST_USERS', ()=>{
        let result = server_utilities.getOperationFunction({operation: 'list_users'});

        assert.deepStrictEqual(result.operation_function.name, 'listUsersExternal');
        assert.deepStrictEqual(result.job_operation_function, undefined);
    });

    it('test LIST_ROLES', ()=>{
        let result = server_utilities.getOperationFunction({operation: 'list_roles'});

        assert.deepStrictEqual(result.operation_function.name, 'listRoles');
        assert.deepStrictEqual(result.job_operation_function, undefined);
    });

    it('test ADD_ROLE', ()=>{
        let result = server_utilities.getOperationFunction({operation: 'add_role'});

        assert.deepStrictEqual(result.operation_function.name, 'addRole');
        assert.deepStrictEqual(result.job_operation_function, undefined);
    });

    it('test ALTER_ROLE', ()=>{
        let result = server_utilities.getOperationFunction({operation: 'alter_role'});

        assert.deepStrictEqual(result.operation_function.name, 'alterRole');
        assert.deepStrictEqual(result.job_operation_function, undefined);
    });

    it('test DROP_ROLE', ()=>{
        let result = server_utilities.getOperationFunction({operation: 'drop_role'});

        assert.deepStrictEqual(result.operation_function.name, 'dropRole');
        assert.deepStrictEqual(result.job_operation_function, undefined);
    });

    it('test USER_INFO', ()=>{
        let result = server_utilities.getOperationFunction({operation: 'user_info'});

        assert.deepStrictEqual(result.operation_function.name, 'userInfo');
        assert.deepStrictEqual(result.job_operation_function, undefined);
    });

    it('test READ_LOG', ()=>{
        let result = server_utilities.getOperationFunction({operation: 'read_log'});

        assert.deepStrictEqual(result.operation_function.name, 'readLog');
        assert.deepStrictEqual(result.job_operation_function, undefined);
    });

    it('test ADD_NODE', ()=>{
        let result = server_utilities.getOperationFunction({operation: 'add_node'});

        assert.deepStrictEqual(result.operation_function.name, 'addNode');
        assert.deepStrictEqual(result.job_operation_function, undefined);
    });

    it('test UPDATE_NODE', ()=>{
        let result = server_utilities.getOperationFunction({operation: 'update_node'});

        assert.deepStrictEqual(result.operation_function.name, 'updateNode');
        assert.deepStrictEqual(result.job_operation_function, undefined);
    });

    it('test REMOVE_NODE', ()=>{
        let result = server_utilities.getOperationFunction({operation: 'remove_node'});

        assert.deepStrictEqual(result.operation_function.name, 'removeNode');
        assert.deepStrictEqual(result.job_operation_function, undefined);
    });

    it('test CONFIGURE_CLUSTER', ()=>{
        let result = server_utilities.getOperationFunction({operation: 'configure_cluster'});

        assert.deepStrictEqual(result.operation_function.name, 'configureCluster');
        assert.deepStrictEqual(result.job_operation_function, undefined);
    });

    it('test CLUSTER_STATUS', ()=>{
        let result = server_utilities.getOperationFunction({operation: 'cluster_status'});

        assert.deepStrictEqual(result.operation_function.name, 'clusterStatus');
        assert.deepStrictEqual(result.job_operation_function, undefined);
    });

    it('test EXPORT_TO_S3', ()=>{
        let result = server_utilities.getOperationFunction({operation: 'export_to_s3'});

        assert.deepStrictEqual(result.operation_function.name, 'signalJob');
        assert.deepStrictEqual(result.job_operation_function.name, 'export_to_s3');
    });

    it('test DELETE_FILES_BEFORE', ()=>{
        let result = server_utilities.getOperationFunction({operation: 'delete_files_before'});

        assert.deepStrictEqual(result.operation_function.name, 'signalJob');
        assert.deepStrictEqual(result.job_operation_function.name, 'deleteFilesBefore');
    });

    it('test EXPORT_LOCAL', ()=>{
        let result = server_utilities.getOperationFunction({operation: 'export_local'});

        assert.deepStrictEqual(result.operation_function.name, 'signalJob');
        assert.deepStrictEqual(result.job_operation_function.name, 'export_local');
    });

    it('test SEARCH_JOBS_BY_START_DATE', ()=>{
        let result = server_utilities.getOperationFunction({operation: 'search_jobs_by_start_date'});

        assert.deepStrictEqual(result.operation_function.name, 'handleGetJobsByStartDate');
        assert.deepStrictEqual(result.job_operation_function, undefined);
    });

    it('test GET_JOB', ()=>{
        let result = server_utilities.getOperationFunction({operation: 'get_job'});

        assert.deepStrictEqual(result.operation_function.name, 'handleGetJob');
        assert.deepStrictEqual(result.job_operation_function, undefined);
    });

    it('test GET_FINGERPRINT', ()=>{
        let result = server_utilities.getOperationFunction({operation: 'get_fingerprint'});

        assert.deepStrictEqual(result.operation_function.name, 'getFingerprint');
        assert.deepStrictEqual(result.job_operation_function, undefined);
    });

    it('test SET_LICENSE', ()=>{
        let result = server_utilities.getOperationFunction({operation: 'set_license'});

        assert.deepStrictEqual(result.operation_function.name, 'setLicense');
        assert.deepStrictEqual(result.job_operation_function, undefined);
    });

    it('test GET_REGISTRATION_INFO', ()=>{
        let result = server_utilities.getOperationFunction({operation: 'registration_info'});

        assert.deepStrictEqual(result.operation_function.name, 'getRegistrationInfo');
        assert.deepStrictEqual(result.job_operation_function, undefined);
    });

    it('test RESTART', ()=>{
        let result = server_utilities.getOperationFunction({operation: 'restart'});

        assert.deepStrictEqual(result.operation_function.name, 'restartProcesses');
        assert.deepStrictEqual(result.job_operation_function, undefined);
    });

    it('test CATCHUP', ()=>{
        let result = server_utilities.getOperationFunction({operation: 'catchup'});

        assert.deepStrictEqual(result.operation_function.name, 'catchup');
        assert.deepStrictEqual(result.job_operation_function, undefined);
    });

    it('test SYSTEM_INFORMATION', ()=>{
        let result = server_utilities.getOperationFunction({operation: 'system_information'});

        assert.deepStrictEqual(result.operation_function.name, 'systemInformation');
        assert.deepStrictEqual(result.job_operation_function, undefined);
    });

    it('test DELETE_TRANSACTION_LOGS_BEFORE', ()=>{
        let result = server_utilities.getOperationFunction({operation: 'delete_transaction_logs_before'});

        assert.deepStrictEqual(result.operation_function.name, 'signalJob');
        assert.deepStrictEqual(result.job_operation_function.name, 'deleteTransactionLogsBefore');
    });

    it('test READ_TRANSACTION_LOG', ()=>{
        let result = server_utilities.getOperationFunction({operation: 'read_transaction_log'});

        assert.deepStrictEqual(result.operation_function.name, 'readTransactionLog');
        assert.deepStrictEqual(result.job_operation_function, undefined);
    });
});

//TODO in the future test thes functions more extensively
//This only very nominally tests this function
describe('test postOperationHandler', ()=>{

    let send_op_txn_spy = sandbox.spy();
    let send_attr_txn_stub = sandbox.spy();
    let send_schema_txn_stub = sandbox.spy();
    let concat_src_msg_header_stub = sandbox.spy();
    let send_txn_to_sc_spy = sandbox.spy();
    let get_cluster_msg_spy = sandbox.spy(sandbox.stub().returns({}));
    let rw_send_op_txn;
    let rw_transact_to_clustering_utils;
    let rw_common_utils;
    before(()=>{
        rw_send_op_txn = rw_server_utilities.__set__('sendOperationTransaction', send_op_txn_spy);
        rw_transact_to_clustering_utils = rw_server_utilities.__set__('transact_to_clustering_utils', {
            sendAttributeTransaction: send_attr_txn_stub,
            sendSchemaTransaction: send_schema_txn_stub,
            concatSourceMessageHeader: concat_src_msg_header_stub
        });

        rw_common_utils = rw_server_utilities.__set__('common_utils', {
            sendTransactionToSocketCluster: send_txn_to_sc_spy,
            getClusterMessage:get_cluster_msg_spy
        });
    });

    afterEach(()=>{
        send_op_txn_spy.resetHistory();
        send_attr_txn_stub.resetHistory();
        send_schema_txn_stub.resetHistory();
        concat_src_msg_header_stub.resetHistory();
        send_txn_to_sc_spy.resetHistory();
        get_cluster_msg_spy.resetHistory();
    });

    after(()=>{
        sandbox.restore();
        rw_send_op_txn();
        rw_transact_to_clustering_utils();
        rw_common_utils();
    });

    it('test insert', ()=>{
        rw_server_utilities.postOperationHandler({operation:'insert'}, {inserted_hashes:[]});
        assert(get_cluster_msg_spy.calledOnce === true);
        assert(send_op_txn_spy.calledOnce === true);
        assert(send_op_txn_spy.threw() === false);
        assert(send_attr_txn_stub.calledOnce === true);
        assert(send_attr_txn_stub.threw() === false);
    });

    it('test update', ()=>{
        rw_server_utilities.postOperationHandler({operation:'update'}, {update_hashes:[]});
        assert(get_cluster_msg_spy.calledOnce === true);
        assert(send_op_txn_spy.calledOnce === true);
        assert(send_op_txn_spy.threw() === false);
        assert(send_attr_txn_stub.calledOnce === true);
        assert(send_attr_txn_stub.threw() === false);
    });

    it('test delete', ()=>{
        rw_server_utilities.postOperationHandler({operation:'delete'}, {deleted_hashes:[]});
        assert(get_cluster_msg_spy.calledOnce === true);
        assert(send_op_txn_spy.calledOnce === true);
        assert(send_op_txn_spy.threw() === false);
        assert(send_attr_txn_stub.called === false);
    });

    it('test create_schema', ()=>{
        rw_server_utilities.postOperationHandler({operation:'create_schema', schema: 'dev'}, {});
        assert(get_cluster_msg_spy.calledOnce === true);
        assert(send_op_txn_spy.called === false);
        assert(send_op_txn_spy.threw() === false);
        assert(send_attr_txn_stub.called === false);
        assert(send_schema_txn_stub.calledOnce === true);
    });

    it('test create_table', ()=>{
        rw_server_utilities.postOperationHandler({operation:'create_table', schema: 'dev', table:'dog', hash_attribute:'id'}, {});
        assert(get_cluster_msg_spy.calledOnce === true);
        assert(send_op_txn_spy.called === false);
        assert(send_op_txn_spy.threw() === false);
        assert(send_attr_txn_stub.called === false);
        assert(send_schema_txn_stub.calledOnce === true);
    });

    it('test create_attribute', ()=>{
        rw_server_utilities.postOperationHandler({operation:'create_attribute', schema: 'dev', table:'dog', attribute:'age'}, {}, {});
        assert(get_cluster_msg_spy.calledOnce === true);
        assert(send_op_txn_spy.called === false);
        assert(send_op_txn_spy.threw() === false);
        assert(send_attr_txn_stub.called === false);
        assert(send_schema_txn_stub.called === false);
        assert(concat_src_msg_header_stub.calledOnce === true);
    });

    it('test csv_data_load', ()=>{
        rw_server_utilities.postOperationHandler({operation:'csv_data_load', schema: 'dev', table:'dog', attribute:'age'}, {}, {});
        assert(get_cluster_msg_spy.calledOnce === true);
        assert(send_op_txn_spy.called === false);
        assert(send_op_txn_spy.threw() === false);
        assert(send_attr_txn_stub.called === false);
        assert(send_txn_to_sc_spy.called === false);
        assert(send_schema_txn_stub.calledOnce === true);
    });
});