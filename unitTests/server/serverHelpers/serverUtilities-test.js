'use strict';

const test_utils = require('../../test_utils');
test_utils.preTestPrep();

const assert = require('assert');
const sinon = require('sinon');
const sandbox = sinon.createSandbox();
const { TEST_JSON_SUPER_USER, TEST_JSON_NON_SU } = require('../../test_data');

const rewire = require('rewire');
const serverUtilities_rw = rewire('../../../server/serverHelpers/serverUtilities');
const operation_function_caller = require('../../../utility/OperationFunctionCaller');
const logger = require('../../../utility/logging/harper_logger');
const terms = require('../../../utility/hdbTerms');

const test_func_data = { data: 'this is data', more_data: 'this is more data' };
const test_error = 'This is bad!';

async function test_func(test_values) {
	return test_func_data;
}

async function test_func_error(test_values) {
	throw new Error(test_error);
}

describe('Test serverUtilities_rw.js module ', () => {
	after(() => {
		sandbox.restore();
		rewire('../../../server/serverHelpers/serverUtilities');
	});

	describe(`Test chooseOperation`, function () {
		it('Nominal path with insert operation.', function () {
			let test_result;
			try {
				serverUtilities_rw.chooseOperation(TEST_JSON_SUPER_USER);
			} catch (err) {
				test_result = err;
			}

			assert.ok(test_result === undefined);
		});
		it('Invalid operation specified in json.', function () {
			let test_copy = test_utils.deepClone(TEST_JSON_NON_SU);
			test_copy.operation = 'blah';
			let test_result;
			try {
				serverUtilities_rw.chooseOperation(test_copy);
			} catch (err) {
				test_result = err;
			}

			assert.ok(test_result.http_resp_code === 400);
			assert.ok(test_result.http_resp_msg === "Operation 'blah' not found");
		});
	});

	describe('test getOperationFunction', () => {
		it('test insert', () => {
			let result = serverUtilities_rw.getOperationFunction({ operation: 'insert' });

			assert.deepStrictEqual(result.operation_function.name, 'insertData');
			assert.deepStrictEqual(result.job_operation_function, undefined);
		});

		it('test update', () => {
			let result = serverUtilities_rw.getOperationFunction({ operation: 'update' });

			assert.deepStrictEqual(result.operation_function.name, 'updateData');
			assert.deepStrictEqual(result.job_operation_function, undefined);
		});

		it('test upsert', () => {
			let result = serverUtilities_rw.getOperationFunction({ operation: 'upsert' });

			assert.deepStrictEqual(result.operation_function.name, 'upsertData');
			assert.deepStrictEqual(result.job_operation_function, undefined);
		});

		it('test SEARCH_BY_HASH', () => {
			let result = serverUtilities_rw.getOperationFunction({ operation: 'search_by_hash' });

			assert.deepStrictEqual(result.operation_function.name, 'searchByHash');
			assert.deepStrictEqual(result.job_operation_function, undefined);
		});

		it('test SEARCH_BY_VALUE', () => {
			let result = serverUtilities_rw.getOperationFunction({ operation: 'search_by_value' });

			assert.deepStrictEqual(result.operation_function.name, 'searchByValue');
			assert.deepStrictEqual(result.job_operation_function, undefined);
		});

		it('test SEARCH', () => {
			let result = serverUtilities_rw.getOperationFunction({ operation: 'search' });

			assert.deepStrictEqual(result.operation_function.name, 'search');
			assert.deepStrictEqual(result.job_operation_function, undefined);
		});

		it('test SQL', () => {
			let result = serverUtilities_rw.getOperationFunction({ operation: 'sql' });

			assert.deepStrictEqual(result.operation_function.name, 'evaluateSQL');
			assert.deepStrictEqual(result.job_operation_function, undefined);
		});

		it('test CSV_DATA_LOAD', () => {
			let result = serverUtilities_rw.getOperationFunction({ operation: 'csv_data_load' });

			assert.deepStrictEqual(result.operation_function.name, 'executeJob');
			assert.deepStrictEqual(result.job_operation_function.name, 'csvDataLoad');
		});

		it('test CSV_FILE_LOAD', () => {
			let result = serverUtilities_rw.getOperationFunction({ operation: 'csv_file_load' });

			assert.deepStrictEqual(result.operation_function.name, 'executeJob');
			assert.deepStrictEqual(result.job_operation_function.name, 'csvFileLoad');
		});

		it('test CSV_URL_LOAD', () => {
			let result = serverUtilities_rw.getOperationFunction({ operation: 'csv_url_load' });

			assert.deepStrictEqual(result.operation_function.name, 'executeJob');
			assert.deepStrictEqual(result.job_operation_function.name, 'csvURLLoad');
		});

		it('test CREATE_SCHEMA', () => {
			let result = serverUtilities_rw.getOperationFunction({ operation: 'create_schema' });

			assert.deepStrictEqual(result.operation_function.name, 'createSchema');
			assert.deepStrictEqual(result.job_operation_function, undefined);
		});

		it('test CREATE_TABLE', () => {
			let result = serverUtilities_rw.getOperationFunction({ operation: 'create_table' });

			assert.deepStrictEqual(result.operation_function.name, 'createTable');
			assert.deepStrictEqual(result.job_operation_function, undefined);
		});

		it('test CREATE_ATTRIBUTE', () => {
			let result = serverUtilities_rw.getOperationFunction({ operation: 'create_attribute' });

			assert.deepStrictEqual(result.operation_function.name, 'createAttribute');
			assert.deepStrictEqual(result.job_operation_function, undefined);
		});

		it('test DROP_SCHEMA', () => {
			let result = serverUtilities_rw.getOperationFunction({ operation: 'drop_schema' });

			assert.deepStrictEqual(result.operation_function.name, 'dropSchema');
			assert.deepStrictEqual(result.job_operation_function, undefined);
		});

		it('test DROP_TABLE', () => {
			let result = serverUtilities_rw.getOperationFunction({ operation: 'drop_table' });

			assert.deepStrictEqual(result.operation_function.name, 'dropTable');
			assert.deepStrictEqual(result.job_operation_function, undefined);
		});

		it('test DROP_ATTRIBUTE', () => {
			let result = serverUtilities_rw.getOperationFunction({ operation: 'drop_attribute' });

			assert.deepStrictEqual(result.operation_function.name, 'dropAttribute');
			assert.deepStrictEqual(result.job_operation_function, undefined);
		});

		it('test DESCRIBE_SCHEMA', () => {
			let result = serverUtilities_rw.getOperationFunction({ operation: 'describe_schema' });

			assert.deepStrictEqual(result.operation_function.name, 'describeSchema');
			assert.deepStrictEqual(result.job_operation_function, undefined);
		});

		it('test DESCRIBE_TABLE', () => {
			let result = serverUtilities_rw.getOperationFunction({ operation: 'describe_table' });

			assert.deepStrictEqual(result.operation_function.name, 'descTable');
			assert.deepStrictEqual(result.job_operation_function, undefined);
		});

		it('test DESCRIBE_ALL', () => {
			let result = serverUtilities_rw.getOperationFunction({ operation: 'describe_all' });

			assert.deepStrictEqual(result.operation_function.name, 'describeAll');
			assert.deepStrictEqual(result.job_operation_function, undefined);
		});

		it('test DELETE', () => {
			let result = serverUtilities_rw.getOperationFunction({ operation: 'delete' });

			assert.deepStrictEqual(result.operation_function.name, 'deleteRecordCallbackified');
			assert.deepStrictEqual(result.job_operation_function, undefined);
		});

		it('test ADD_USER', () => {
			let result = serverUtilities_rw.getOperationFunction({ operation: 'add_user' });

			assert.deepStrictEqual(result.operation_function.name, 'addUser');
			assert.deepStrictEqual(result.job_operation_function, undefined);
		});

		it('test ALTER_USER', () => {
			let result = serverUtilities_rw.getOperationFunction({ operation: 'alter_user' });

			assert.deepStrictEqual(result.operation_function.name, 'alterUser');
			assert.deepStrictEqual(result.job_operation_function, undefined);
		});

		it('test DROP_USER', () => {
			let result = serverUtilities_rw.getOperationFunction({ operation: 'drop_user' });

			assert.deepStrictEqual(result.operation_function.name, 'dropUser');
			assert.deepStrictEqual(result.job_operation_function, undefined);
		});

		it('test LIST_USERS', () => {
			let result = serverUtilities_rw.getOperationFunction({ operation: 'list_users' });

			assert.deepStrictEqual(result.operation_function.name, 'listUsersExternal');
			assert.deepStrictEqual(result.job_operation_function, undefined);
		});

		it('test LIST_ROLES', () => {
			let result = serverUtilities_rw.getOperationFunction({ operation: 'list_roles' });

			assert.deepStrictEqual(result.operation_function.name, 'listRoles');
			assert.deepStrictEqual(result.job_operation_function, undefined);
		});

		it('test ADD_ROLE', () => {
			let result = serverUtilities_rw.getOperationFunction({ operation: 'add_role' });

			assert.deepStrictEqual(result.operation_function.name, 'addRole');
			assert.deepStrictEqual(result.job_operation_function, undefined);
		});

		it('test ALTER_ROLE', () => {
			let result = serverUtilities_rw.getOperationFunction({ operation: 'alter_role' });

			assert.deepStrictEqual(result.operation_function.name, 'alterRole');
			assert.deepStrictEqual(result.job_operation_function, undefined);
		});

		it('test DROP_ROLE', () => {
			let result = serverUtilities_rw.getOperationFunction({ operation: 'drop_role' });

			assert.deepStrictEqual(result.operation_function.name, 'dropRole');
			assert.deepStrictEqual(result.job_operation_function, undefined);
		});

		it('test USER_INFO', () => {
			let result = serverUtilities_rw.getOperationFunction({ operation: 'user_info' });

			assert.deepStrictEqual(result.operation_function.name, 'userInfo');
			assert.deepStrictEqual(result.job_operation_function, undefined);
		});

		it('test READ_LOG', () => {
			let result = serverUtilities_rw.getOperationFunction({ operation: 'read_log' });

			assert.deepStrictEqual(result.operation_function.name, 'readLog');
			assert.deepStrictEqual(result.job_operation_function, undefined);
		});

		it('test ADD_NODE', () => {
			let result = serverUtilities_rw.getOperationFunction({ operation: 'add_node' });

			assert.deepStrictEqual(result.operation_function.name, 'addNode');
			assert.deepStrictEqual(result.job_operation_function, undefined);
		});

		it('test UPDATE_NODE', () => {
			let result = serverUtilities_rw.getOperationFunction({ operation: 'update_node' });

			assert.deepStrictEqual(result.operation_function.name, 'updateNode');
			assert.deepStrictEqual(result.job_operation_function, undefined);
		});

		it('test REMOVE_NODE', () => {
			let result = serverUtilities_rw.getOperationFunction({ operation: 'remove_node' });

			assert.deepStrictEqual(result.operation_function.name, 'removeNode');
			assert.deepStrictEqual(result.job_operation_function, undefined);
		});

		it('test CONFIGURE_CLUSTER', () => {
			let result = serverUtilities_rw.getOperationFunction({ operation: 'configure_cluster' });

			assert.deepStrictEqual(result.operation_function.name, 'configureCluster');
			assert.deepStrictEqual(result.job_operation_function, undefined);
		});

		it('test SET_CONGIGURATION', () => {
			let result = serverUtilities_rw.getOperationFunction({ operation: 'set_configuration' });

			assert.deepStrictEqual(result.operation_function.name, 'setConfiguration');
			assert.deepStrictEqual(result.job_operation_function, undefined);
		});

		it('test CLUSTER_STATUS', () => {
			let result = serverUtilities_rw.getOperationFunction({ operation: 'cluster_status' });

			assert.deepStrictEqual(result.operation_function.name, 'clusterStatus');
			assert.deepStrictEqual(result.job_operation_function, undefined);
		});

		it('test EXPORT_TO_S3', () => {
			let result = serverUtilities_rw.getOperationFunction({ operation: 'export_to_s3' });

			assert.deepStrictEqual(result.operation_function.name, 'executeJob');
			assert.deepStrictEqual(result.job_operation_function.name, 'export_to_s3');
		});

		it('test DELETE_FILES_BEFORE', () => {
			let result = serverUtilities_rw.getOperationFunction({ operation: 'delete_files_before' });

			assert.deepStrictEqual(result.operation_function.name, 'executeJob');
			assert.deepStrictEqual(result.job_operation_function.name, 'deleteFilesBefore');
		});

		it('test EXPORT_LOCAL', () => {
			let result = serverUtilities_rw.getOperationFunction({ operation: 'export_local' });

			assert.deepStrictEqual(result.operation_function.name, 'executeJob');
			assert.deepStrictEqual(result.job_operation_function.name, 'export_local');
		});

		it('test SEARCH_JOBS_BY_START_DATE', () => {
			let result = serverUtilities_rw.getOperationFunction({ operation: 'search_jobs_by_start_date' });

			assert.deepStrictEqual(result.operation_function.name, 'handleGetJobsByStartDate');
			assert.deepStrictEqual(result.job_operation_function, undefined);
		});

		it('test GET_JOB', () => {
			let result = serverUtilities_rw.getOperationFunction({ operation: 'get_job' });

			assert.deepStrictEqual(result.operation_function.name, 'handleGetJob');
			assert.deepStrictEqual(result.job_operation_function, undefined);
		});

		it('test GET_FINGERPRINT', () => {
			let result = serverUtilities_rw.getOperationFunction({ operation: 'get_fingerprint' });

			assert.deepStrictEqual(result.operation_function.name, 'getFingerprint');
			assert.deepStrictEqual(result.job_operation_function, undefined);
		});

		it('test SET_LICENSE', () => {
			let result = serverUtilities_rw.getOperationFunction({ operation: 'set_license' });

			assert.deepStrictEqual(result.operation_function.name, 'setLicense');
			assert.deepStrictEqual(result.job_operation_function, undefined);
		});

		it('test GET_REGISTRATION_INFO', () => {
			let result = serverUtilities_rw.getOperationFunction({ operation: 'registration_info' });

			assert.deepStrictEqual(result.operation_function.name, 'getRegistrationInfo');
			assert.deepStrictEqual(result.job_operation_function, undefined);
		});

		it('test RESTART', () => {
			let result = serverUtilities_rw.getOperationFunction({ operation: 'restart' });

			assert.deepStrictEqual(result.operation_function.name, 'restartProcesses');
			assert.deepStrictEqual(result.job_operation_function, undefined);
		});

		it('test CATCHUP', () => {
			let result = serverUtilities_rw.getOperationFunction({ operation: 'catchup' });

			assert.deepStrictEqual(result.operation_function.name, 'catchup');
			assert.deepStrictEqual(result.job_operation_function, undefined);
		});

		it('test SYSTEM_INFORMATION', () => {
			let result = serverUtilities_rw.getOperationFunction({ operation: 'system_information' });

			assert.deepStrictEqual(result.operation_function.name, 'systemInformation');
			assert.deepStrictEqual(result.job_operation_function, undefined);
		});

		it('test DELETE_TRANSACTION_LOGS_BEFORE', () => {
			let result = serverUtilities_rw.getOperationFunction({ operation: 'delete_transaction_logs_before' });

			assert.deepStrictEqual(result.operation_function.name, 'executeJob');
			assert.deepStrictEqual(result.job_operation_function.name, 'deleteTransactionLogsBefore');
		});

		it('test READ_TRANSACTION_LOG', () => {
			let result = serverUtilities_rw.getOperationFunction({ operation: 'read_transaction_log' });

			assert.deepStrictEqual(result.operation_function.name, 'readTransactionLog');
			assert.deepStrictEqual(result.job_operation_function, undefined);
		});
	});

	describe(`Test processLocalTransaction`, function () {
		const TEST_ERR = new Error(test_error);
		let MOCK_REQUEST = {
			body: {
				operation: 'create_schema',
				schema: 'test',
				hdb_user: 'user info',
				hdb_auth_header: 'auth info',
				password: 'password',
			},
		};

		let info_log_stub;
		let error_log_stub;
		let op_func_caller_stub;

		before(() => {
			info_log_stub = sandbox.stub(logger, 'info').callsFake(() => {});
			error_log_stub = sandbox.stub(logger, 'error').callsFake(() => {});
			op_func_caller_stub = sandbox.stub(operation_function_caller, 'callOperationFunctionAsAwait').callThrough();
		});

		afterEach(() => {
			sandbox.resetHistory();
		});

		it('Should return results from callOperationFunctionAsAwait() method', async function () {
			//Use the test_func function above as an operation function stub
			let test_result = await serverUtilities_rw.processLocalTransaction(MOCK_REQUEST, test_func);

			assert.equal(test_result, test_func_data);
		});

		it('Should handle error thrown from callOperationFunctionAsAwait() method', async function () {
			let test_result;

			try {
				//Use the test_func_error function above as an operation function stub
				await serverUtilities_rw.processLocalTransaction(MOCK_REQUEST, test_func_error);
			} catch (err) {
				test_result = err;
			}
			assert.equal(test_result.message, test_error);
			assert.ok(test_result instanceof Error);
		});

		it('Test `clean body` log scenario for INFO log level', async function () {
			const logger_stub = serverUtilities_rw.__get__('harper_logger');
			logger_stub.log_level = 'info';
			serverUtilities_rw.__set__('harper_logger', logger_stub);

			const { hdb_user, hdb_auth_header, password, ...test_clean_body } = MOCK_REQUEST.body;

			await serverUtilities_rw.processLocalTransaction(MOCK_REQUEST, test_func);

			assert.ok(info_log_stub.calledOnce, 'The cleaned body should be logged');
			assert.equal(info_log_stub.args[0][0], JSON.stringify(test_clean_body));
		});

		it('Test `clean body` log scenario for DEBUG log level', async function () {
			const logger_stub = serverUtilities_rw.__get__('harper_logger');
			logger_stub.log_level = 'debug';
			serverUtilities_rw.__set__('harper_logger', logger_stub);

			const { hdb_user, hdb_auth_header, password, ...test_clean_body } = MOCK_REQUEST.body;

			await serverUtilities_rw.processLocalTransaction(MOCK_REQUEST, test_func);

			assert.ok(info_log_stub.calledOnce, 'The cleaned body should be logged');
			assert.equal(info_log_stub.args[0][0], JSON.stringify(test_clean_body));
		});

		it('Test `clean body` log scenario for TRACE log level', async function () {
			const logger_stub = serverUtilities_rw.__get__('harper_logger');
			logger_stub.log_level = 'trace';
			serverUtilities_rw.__set__('harper_logger', logger_stub);

			const { hdb_user, hdb_auth_header, password, ...test_clean_body } = MOCK_REQUEST.body;

			await serverUtilities_rw.processLocalTransaction(MOCK_REQUEST, test_func);

			assert.ok(info_log_stub.calledOnce, 'The cleaned body should be logged');
			assert.equal(info_log_stub.args[0][0], JSON.stringify(test_clean_body));
		});

		it('Test `clean body` log scenario not run for `read_log` operation', async function () {
			const logger_stub = serverUtilities_rw.__get__('harper_logger');
			logger_stub.log_level = logger.TRACE;
			serverUtilities_rw.__set__('harper_logger', logger_stub);

			const read_log_req = test_utils.deepClone(MOCK_REQUEST);
			read_log_req.body.operation = 'read_log';

			await serverUtilities_rw.processLocalTransaction(read_log_req, test_func);

			assert.ok(!info_log_stub.called, 'The cleaned body should not be logged');
		});

		it('Should log error thrown within `clean body` log step', async function () {
			const logger_stub = serverUtilities_rw.__get__('harper_logger');
			logger_stub.log_level = terms.LOG_LEVELS.TRACE;
			serverUtilities_rw.__set__('harper_logger', logger_stub);

			info_log_stub.throws(TEST_ERR);
			const test_result = await serverUtilities_rw.processLocalTransaction(MOCK_REQUEST, test_func);

			assert.ok(info_log_stub.calledOnce, 'The error should be logged');
			assert.equal(
				info_log_stub.args[0][0],
				'{"operation":"create_schema","schema":"test"}',
				'The correct error should be logged'
			);

			assert.equal(
				test_result,
				test_func_data,
				'The function should continue and return the results from the operation'
			);

			info_log_stub.resetBehavior();
			// rewire('../../../server/serverHelpers/serverUtilities');
		});

		it('Should handle error returned from operation function caller', async function () {
			op_func_caller_stub.resolves(TEST_ERR);

			let test_result;

			try {
				await serverUtilities_rw.processLocalTransaction(MOCK_REQUEST, test_func);
			} catch (err) {
				test_result = err;
			}
			assert.equal(test_result.message, test_error);
			assert.ok(test_result instanceof Error);

			op_func_caller_stub.resetBehavior();
		});
	});
});
