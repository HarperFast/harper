'use strict';

const testUtils = require('../../testUtils.js');
testUtils.preTestPrep();

const assert = require('assert');
const sinon = require('sinon');
const sandbox = sinon.createSandbox();
const { TEST_JSON_SUPER_USER, TEST_JSON_NON_SU } = require('../../test_data');
const serverUtilities = require('#src/server/serverHelpers/serverUtilities');
const operation_function_caller = require('#src/utility/OperationFunctionCaller');
const logger = require('#src/utility/logging/harper_logger');
const { contextStorage } = require('#src/resources/transaction');

const test_func_data = { data: 'this is data', more_data: 'this is more data' };
const test_error = 'This is bad!';

async function test_func(_test_values) {
	return test_func_data;
}

async function test_func_error(_test_values) {
	throw new Error(test_error);
}

describe('Test serverUtilities.js module ', () => {
	after(() => {
		sandbox.restore();
	});

	describe(`Test chooseOperation`, function () {
		it('Nominal path with insert operation.', function () {
			let test_result;
			try {
				serverUtilities.chooseOperation(TEST_JSON_SUPER_USER);
			} catch (err) {
				test_result = err;
			}

			assert.ok(test_result === undefined);
		});
		it('Invalid operation specified in json.', function () {
			let test_copy = testUtils.deepClone(TEST_JSON_NON_SU);
			test_copy.operation = 'blah';
			let test_result;
			try {
				serverUtilities.chooseOperation(test_copy);
			} catch (err) {
				test_result = err;
			}

			assert.ok(test_result.statusCode === 400);
			assert.ok(test_result.http_resp_msg === "Operation 'blah' not found");
		});
	});

	describe('test getOperationFunction', () => {
		it('test insert', () => {
			let result = serverUtilities.getOperationFunction({ operation: 'insert' });

			assert.deepStrictEqual(result.operation_function.name, 'insertData');
			assert.deepStrictEqual(result.job_operation_function, undefined);
		});

		it('test update', () => {
			let result = serverUtilities.getOperationFunction({ operation: 'update' });

			assert.deepStrictEqual(result.operation_function.name, 'updateData');
			assert.deepStrictEqual(result.job_operation_function, undefined);
		});

		it('test upsert', () => {
			let result = serverUtilities.getOperationFunction({ operation: 'upsert' });

			assert.deepStrictEqual(result.operation_function.name, 'upsertData');
			assert.deepStrictEqual(result.job_operation_function, undefined);
		});

		it('test SEARCH_BY_HASH', () => {
			let result = serverUtilities.getOperationFunction({ operation: 'search_by_hash' });

			assert.deepStrictEqual(result.operation_function.name, 'searchByHash');
			assert.deepStrictEqual(result.job_operation_function, undefined);
		});

		it('test SEARCH_BY_VALUE', () => {
			let result = serverUtilities.getOperationFunction({ operation: 'search_by_value' });

			assert.deepStrictEqual(result.operation_function.name, 'searchByValue');
			assert.deepStrictEqual(result.job_operation_function, undefined);
		});

		it('test SEARCH', () => {
			let result = serverUtilities.getOperationFunction({ operation: 'search' });

			assert.deepStrictEqual(result.operation_function.name, 'search');
			assert.deepStrictEqual(result.job_operation_function, undefined);
		});

		it('test SQL', () => {
			let result = serverUtilities.getOperationFunction({ operation: 'sql' });

			assert.deepStrictEqual(result.operation_function.name, 'evaluateSQL');
			assert.deepStrictEqual(result.job_operation_function, undefined);
		});

		it('test CSV_DATA_LOAD', () => {
			let result = serverUtilities.getOperationFunction({ operation: 'csv_data_load' });

			assert.deepStrictEqual(result.operation_function.name, 'executeJob');
			assert.deepStrictEqual(result.job_operation_function.name, 'csvDataLoad');
		});

		it('test CSV_FILE_LOAD', () => {
			let result = serverUtilities.getOperationFunction({ operation: 'csv_file_load' });

			assert.deepStrictEqual(result.operation_function.name, 'executeJob');
			assert.deepStrictEqual(result.job_operation_function.name, 'csvFileLoad');
		});

		it('test CSV_URL_LOAD', () => {
			let result = serverUtilities.getOperationFunction({ operation: 'csv_url_load' });

			assert.deepStrictEqual(result.operation_function.name, 'executeJob');
			assert.deepStrictEqual(result.job_operation_function.name, 'csvURLLoad');
		});

		it('test CREATE_SCHEMA', () => {
			let result = serverUtilities.getOperationFunction({ operation: 'create_schema' });

			assert.deepStrictEqual(result.operation_function.name, 'createSchema');
			assert.deepStrictEqual(result.job_operation_function, undefined);
		});

		it('test CREATE_TABLE', () => {
			let result = serverUtilities.getOperationFunction({ operation: 'create_table' });

			assert.deepStrictEqual(result.operation_function.name, 'createTable');
			assert.deepStrictEqual(result.job_operation_function, undefined);
		});

		it('test CREATE_ATTRIBUTE', () => {
			let result = serverUtilities.getOperationFunction({ operation: 'create_attribute' });

			assert.deepStrictEqual(result.operation_function.name, 'createAttribute');
			assert.deepStrictEqual(result.job_operation_function, undefined);
		});

		it('test DROP_SCHEMA', () => {
			let result = serverUtilities.getOperationFunction({ operation: 'drop_schema' });

			assert.deepStrictEqual(result.operation_function.name, 'dropSchema');
			assert.deepStrictEqual(result.job_operation_function, undefined);
		});

		it('test DROP_TABLE', () => {
			let result = serverUtilities.getOperationFunction({ operation: 'drop_table' });

			assert.deepStrictEqual(result.operation_function.name, 'dropTable');
			assert.deepStrictEqual(result.job_operation_function, undefined);
		});

		it('test DROP_ATTRIBUTE', () => {
			let result = serverUtilities.getOperationFunction({ operation: 'drop_attribute' });

			assert.deepStrictEqual(result.operation_function.name, 'dropAttribute');
			assert.deepStrictEqual(result.job_operation_function, undefined);
		});

		it('test DESCRIBE_SCHEMA', () => {
			let result = serverUtilities.getOperationFunction({ operation: 'describe_schema' });

			assert.deepStrictEqual(result.operation_function.name, 'describeSchema');
			assert.deepStrictEqual(result.job_operation_function, undefined);
		});

		it('test DESCRIBE_TABLE', () => {
			let result = serverUtilities.getOperationFunction({ operation: 'describe_table' });

			assert.deepStrictEqual(result.operation_function.name, 'descTable');
			assert.deepStrictEqual(result.job_operation_function, undefined);
		});

		it('test DESCRIBE_ALL', () => {
			let result = serverUtilities.getOperationFunction({ operation: 'describe_all' });

			assert.deepStrictEqual(result.operation_function.name, 'describeAll');
			assert.deepStrictEqual(result.job_operation_function, undefined);
		});

		it('test DELETE', () => {
			let result = serverUtilities.getOperationFunction({ operation: 'delete' });

			assert.deepStrictEqual(result.operation_function.name, 'deleteRecord');
			assert.deepStrictEqual(result.job_operation_function, undefined);
		});

		it('test ADD_USER', () => {
			let result = serverUtilities.getOperationFunction({ operation: 'add_user' });

			assert.deepStrictEqual(result.operation_function.name, 'addUser');
			assert.deepStrictEqual(result.job_operation_function, undefined);
		});

		it('test ALTER_USER', () => {
			let result = serverUtilities.getOperationFunction({ operation: 'alter_user' });

			assert.deepStrictEqual(result.operation_function.name, 'alterUser');
			assert.deepStrictEqual(result.job_operation_function, undefined);
		});

		it('test DROP_USER', () => {
			let result = serverUtilities.getOperationFunction({ operation: 'drop_user' });

			assert.deepStrictEqual(result.operation_function.name, 'dropUser');
			assert.deepStrictEqual(result.job_operation_function, undefined);
		});

		it('test LIST_USERS', () => {
			let result = serverUtilities.getOperationFunction({ operation: 'list_users' });

			assert.deepStrictEqual(result.operation_function.name, 'listUsersExternal');
			assert.deepStrictEqual(result.job_operation_function, undefined);
		});

		it('test LIST_ROLES', () => {
			let result = serverUtilities.getOperationFunction({ operation: 'list_roles' });

			assert.deepStrictEqual(result.operation_function.name, 'listRoles');
			assert.deepStrictEqual(result.job_operation_function, undefined);
		});

		it('test ADD_ROLE', () => {
			let result = serverUtilities.getOperationFunction({ operation: 'add_role' });

			assert.deepStrictEqual(result.operation_function.name, 'addRole');
			assert.deepStrictEqual(result.job_operation_function, undefined);
		});

		it('test ALTER_ROLE', () => {
			let result = serverUtilities.getOperationFunction({ operation: 'alter_role' });

			assert.deepStrictEqual(result.operation_function.name, 'alterRole');
			assert.deepStrictEqual(result.job_operation_function, undefined);
		});

		it('test DROP_ROLE', () => {
			let result = serverUtilities.getOperationFunction({ operation: 'drop_role' });

			assert.deepStrictEqual(result.operation_function.name, 'dropRole');
			assert.deepStrictEqual(result.job_operation_function, undefined);
		});

		it('test USER_INFO', () => {
			let result = serverUtilities.getOperationFunction({ operation: 'user_info' });

			assert.deepStrictEqual(result.operation_function.name, 'userInfo');
			assert.deepStrictEqual(result.job_operation_function, undefined);
		});

		it('test READ_LOG', () => {
			let result = serverUtilities.getOperationFunction({ operation: 'read_log' });

			assert.deepStrictEqual(result.operation_function.name, 'readLog');
			assert.deepStrictEqual(result.job_operation_function, undefined);
		});

		it('test SET_CONFIGURATION', () => {
			let result = serverUtilities.getOperationFunction({ operation: 'set_configuration' });

			assert.deepStrictEqual(result.operation_function.name, 'setConfiguration');
			assert.deepStrictEqual(result.job_operation_function, undefined);
		});

		it('test EXPORT_TO_S3', () => {
			let result = serverUtilities.getOperationFunction({ operation: 'export_to_s3' });

			assert.deepStrictEqual(result.operation_function.name, 'executeJob');
			assert.deepStrictEqual(result.job_operation_function.name, 'export_to_s3');
		});

		it('test DELETE_FILES_BEFORE', () => {
			let result = serverUtilities.getOperationFunction({ operation: 'delete_files_before' });

			assert.deepStrictEqual(result.operation_function.name, 'executeJob');
			assert.deepStrictEqual(result.job_operation_function.name, 'deleteFilesBefore');
		});

		it('test EXPORT_LOCAL', () => {
			let result = serverUtilities.getOperationFunction({ operation: 'export_local' });

			assert.deepStrictEqual(result.operation_function.name, 'executeJob');
			assert.deepStrictEqual(result.job_operation_function.name, 'export_local');
		});

		it('test SEARCH_JOBS_BY_START_DATE', () => {
			let result = serverUtilities.getOperationFunction({ operation: 'search_jobs_by_start_date' });

			assert.deepStrictEqual(result.operation_function.name, 'handleGetJobsByStartDate');
			assert.deepStrictEqual(result.job_operation_function, undefined);
		});

		it('test GET_JOB', () => {
			let result = serverUtilities.getOperationFunction({ operation: 'get_job' });

			assert.deepStrictEqual(result.operation_function.name, 'handleGetJob');
			assert.deepStrictEqual(result.job_operation_function, undefined);
		});

		it('test RESTART', () => {
			let result = serverUtilities.getOperationFunction({ operation: 'restart' });

			assert.deepStrictEqual(result.operation_function.name, 'restart');
			assert.deepStrictEqual(result.job_operation_function, undefined);
		});

		it('test CATCHUP', () => {
			let result = serverUtilities.getOperationFunction({ operation: 'catchup' });

			assert.deepStrictEqual(result.operation_function.name, 'catchup');
			assert.deepStrictEqual(result.job_operation_function, undefined);
		});

		it('test SYSTEM_INFORMATION', () => {
			let result = serverUtilities.getOperationFunction({ operation: 'system_information' });

			assert.deepStrictEqual(result.operation_function.name, 'systemInformation');
			assert.deepStrictEqual(result.job_operation_function, undefined);
		});

		it('test DELETE_AUDIT_LOGS_BEFORE', () => {
			let result = serverUtilities.getOperationFunction({ operation: 'delete_audit_logs_before' });

			assert.deepStrictEqual(result.operation_function.name, 'executeJob');
			assert.deepStrictEqual(result.job_operation_function.name, 'deleteAuditLogsBefore');
		});

		it('test READ_AUDIT_LOG', () => {
			let result = serverUtilities.getOperationFunction({ operation: 'read_audit_log' });

			assert.deepStrictEqual(result.operation_function.name, 'readAuditLog');
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
		let op_func_caller_stub;

		before(() => {
			info_log_stub = sandbox.stub(logger, 'info').callsFake(() => {});
			sandbox.stub(logger, 'error').callsFake(() => {});
			op_func_caller_stub = sandbox.stub(operation_function_caller, 'callOperationFunctionAsAwait').callThrough();
		});

		afterEach(() => {
			sandbox.resetHistory();
		});

		it('Should return results from callOperationFunctionAsAwait() method', async function () {
			//Use the test_func function above as an operation function stub
			let test_result = await serverUtilities.processLocalTransaction(MOCK_REQUEST, test_func);

			assert.equal(test_result, test_func_data);
		});

		it('Should handle error thrown from callOperationFunctionAsAwait() method', async function () {
			let test_result;

			try {
				//Use the test_func_error function above as an operation function stub
				await serverUtilities.processLocalTransaction(MOCK_REQUEST, test_func_error);
			} catch (err) {
				test_result = err;
			}
			assert.equal(test_result.message, test_error);
			assert.ok(test_result instanceof Error);
		});

		it('Should handle error returned from operation function caller', async function () {
			op_func_caller_stub.resolves(TEST_ERR);

			let test_result;

			try {
				await serverUtilities.processLocalTransaction(MOCK_REQUEST, test_func);
			} catch (err) {
				test_result = err;
			}
			assert.equal(test_result.message, test_error);
			assert.ok(test_result instanceof Error);

			op_func_caller_stub.resetBehavior();
		});

		it('Should wrap non-object results in message object', async function () {
			const stringResult = 'success message';
			const stringFunc = async () => stringResult;
			op_func_caller_stub.callThrough();

			let test_result = await serverUtilities.processLocalTransaction(MOCK_REQUEST, stringFunc);

			assert.deepStrictEqual(test_result, { message: stringResult });
		});

		it('Should not log request body for read_log operation', async function () {
			const readLogRequest = {
				body: {
					operation: 'read_log',
					hdb_user: 'user info',
				},
			};
			info_log_stub.resetHistory();
			op_func_caller_stub.callThrough();

			await serverUtilities.processLocalTransaction(readLogRequest, test_func);

			// info log should not be called for read_log operation
			assert.ok(!info_log_stub.called, 'info log should not be called for read_log operation');
		});

		it('Should strip sensitive fields from logged request body', async function () {
			const requestWithSensitiveData = {
				body: {
					operation: 'create_schema',
					schema: 'test',
					hdb_user: 'should_be_stripped',
					hdbAuthHeader: 'should_be_stripped',
					password: 'should_be_stripped',
					payload: 'should_be_stripped',
				},
			};
			info_log_stub.resetHistory();
			op_func_caller_stub.callThrough();

			await serverUtilities.processLocalTransaction(requestWithSensitiveData, test_func);

			// Check that info was called and sensitive fields were not included
			if (info_log_stub.called) {
				const loggedBody = info_log_stub.firstCall.args[0];
				assert.ok(!loggedBody.hdb_user, 'hdb_user should be stripped from logged body');
				assert.ok(!loggedBody.hdbAuthHeader, 'hdbAuthHeader should be stripped from logged body');
				assert.ok(!loggedBody.password, 'password should be stripped from logged body');
				assert.ok(!loggedBody.payload, 'payload should be stripped from logged body');
				assert.equal(loggedBody.operation, 'create_schema', 'operation should be preserved');
				assert.equal(loggedBody.schema, 'test', 'schema should be preserved');
			}
		});

		it('Should run the operation function with an ambient context carrying hdb_user', async function () {
			op_func_caller_stub.callThrough();
			const hdbUser = { username: 'ambient_user' };
			let observedStore;
			await serverUtilities.processLocalTransaction(
				{ body: { operation: 'create_schema', schema: 'test', hdb_user: hdbUser } },
				async () => {
					observedStore = contextStorage.getStore();
					return test_func_data;
				}
			);
			assert.equal(observedStore?.user, hdbUser);
		});

		it('Should not establish an ambient context when hdb_user is absent', async function () {
			op_func_caller_stub.callThrough();
			let observedStore;
			await serverUtilities.processLocalTransaction(
				{ body: { operation: 'create_schema', schema: 'test' } },
				async () => {
					observedStore = contextStorage.getStore();
					return test_func_data;
				}
			);
			assert.equal(observedStore, undefined);
		});

		it('Should preserve an existing ambient context for the same user', async function () {
			op_func_caller_stub.callThrough();
			const hdbUser = { username: 'ambient_user' };
			const outerContext = { user: hdbUser, someRequestState: true };
			let observedStore;
			await contextStorage.run(outerContext, () =>
				serverUtilities.processLocalTransaction(
					{ body: { operation: 'create_schema', schema: 'test', hdb_user: hdbUser } },
					async () => {
						observedStore = contextStorage.getStore();
						return test_func_data;
					}
				)
			);
			assert.equal(observedStore, outerContext);
		});

		it('Should merge ambient context, swapping only the user, when the request user differs', async function () {
			// An explicitly different hdb_user must never silently ride the outer user's
			// attribution, but the rest of the ambient context (open transaction, request
			// state) is preserved so atomicity is unaffected. The outer context object
			// itself must not be mutated.
			op_func_caller_stub.callThrough();
			const userX = { username: 'outer_user' };
			const userY = { username: 'request_user' };
			const outerTransaction = { open: true };
			const outerContext = { user: userX, transaction: outerTransaction, someRequestState: true };
			let observedStore;
			await contextStorage.run(outerContext, () =>
				serverUtilities.processLocalTransaction(
					{ body: { operation: 'create_schema', schema: 'test', hdb_user: userY } },
					async () => {
						observedStore = contextStorage.getStore();
						return test_func_data;
					}
				)
			);
			assert.notEqual(observedStore, outerContext);
			assert.equal(observedStore.user, userY);
			assert.equal(observedStore.transaction, outerTransaction, 'outer transaction must be preserved');
			assert.equal(observedStore.someRequestState, true, 'other request state must be preserved');
			assert.equal(outerContext.user, userX, 'outer context object must not be mutated');
		});

		it('Should merge the user into a userless ambient context, preserving its transaction', async function () {
			op_func_caller_stub.callThrough();
			const hdbUser = { username: 'request_user' };
			const outerTransaction = { open: true };
			const outerContext = { transaction: outerTransaction };
			let observedStore;
			await contextStorage.run(outerContext, () =>
				serverUtilities.processLocalTransaction(
					{ body: { operation: 'create_schema', schema: 'test', hdb_user: hdbUser } },
					async () => {
						observedStore = contextStorage.getStore();
						return test_func_data;
					}
				)
			);
			assert.notEqual(observedStore, outerContext);
			assert.equal(observedStore.user, hdbUser);
			assert.equal(observedStore.transaction, outerTransaction, 'outer transaction must be preserved');
			assert.equal(outerContext.user, undefined, 'outer context object must not be mutated');
		});

		it('Should not establish an ambient context when hdb_user is null', async function () {
			// serverHandlers.js sets req.body.hdb_user = null on the unauthenticated-allowed path
			op_func_caller_stub.callThrough();
			let observedStore;
			await serverUtilities.processLocalTransaction(
				{ body: { operation: 'create_schema', schema: 'test', hdb_user: null } },
				async () => {
					observedStore = contextStorage.getStore();
					return test_func_data;
				}
			);
			assert.equal(observedStore, undefined);
		});
	});

	describe('registerOperation permission seam', function () {
		const { server } = require('#src/server/Server');
		const op_auth = require('#src/utility/operation_authorization');
		const { validateOperations } = require('#src/utility/operationPermissions');
		const SU_OP = 'test_registered_su_op';
		const OPEN_OP = 'test_registered_open_op';

		// A non-super_user request JSON for a given op, optionally carrying an `operations` grant.
		const nonSuRequest = (op, operations) => ({
			operation: op,
			hdb_user: {
				active: true,
				role: { permission: { super_user: false, ...(operations ? { operations } : {}) }, role: 'scoped' },
				username: 'scoped_user',
			},
		});
		const suRequest = (op) => ({
			operation: op,
			hdb_user: { active: true, role: { permission: { super_user: true }, role: 'admin' }, username: 'su' },
		});

		before(function () {
			server.registerOperation({ name: SU_OP, execute: async () => ({ ok: true }), requiresSuperUser: true });
		});

		after(function () {
			// Keep the process-global registries clean — these test-only ops shouldn't leak into other
			// suites. registerOperation touches three globals (the op-function map plus verifyPerms'
			// requiredPermissions and the grantable-ops set), so undo all three, not just the map.
			for (const op of [SU_OP, OPEN_OP, 'test_name_pinning_op', 'shared_op_a', 'shared_op_b', 'dyn_grantable_op']) {
				serverUtilities.OPERATION_FUNCTION_MAP.delete(op);
				op_auth.unregisterOperationPermission(op);
			}
		});

		it('registers the handler under the op name for verifyPerms, without mutating the caller function', function () {
			const original = async () => ({});
			const def = { name: 'test_name_pinning_op', execute: original, requiresSuperUser: true };
			server.registerOperation(def);
			// The stored handler is a fresh wrapper named after the op (the key verifyPerms looks up)...
			assert.equal(
				serverUtilities.OPERATION_FUNCTION_MAP.get('test_name_pinning_op').operation_function.name,
				'test_name_pinning_op'
			);
			// ...and the caller's own function object is left untouched.
			assert.equal(def.execute, original);
			assert.notEqual(original.name, 'test_name_pinning_op');
		});

		it('does not corrupt authz when one handler function is shared across two op names', function () {
			const shared = async () => ({});
			server.registerOperation({ name: 'shared_op_a', execute: shared, requiresSuperUser: true });
			server.registerOperation({ name: 'shared_op_b', execute: shared, requiresSuperUser: true });
			// Each registration gets its own named wrapper — the second registration does not rename the first.
			assert.equal(serverUtilities.OPERATION_FUNCTION_MAP.get('shared_op_a').operation_function.name, 'shared_op_a');
			assert.equal(serverUtilities.OPERATION_FUNCTION_MAP.get('shared_op_b').operation_function.name, 'shared_op_b');
		});

		it('makes a declared op grantable in a role operations allowlist, even a non-enum name', function () {
			assert.notEqual(validateOperations(['dyn_grantable_op']), null); // unknown name before registration
			server.registerOperation({ name: 'dyn_grantable_op', execute: async () => ({}), requiresSuperUser: true });
			assert.equal(validateOperations(['dyn_grantable_op']), null); // grantable after registration
		});

		it('does not touch handler name or register perms when requiresSuperUser is omitted (opt-in)', function () {
			const def = { name: OPEN_OP, execute: async () => ({}) };
			server.registerOperation(def);
			// Name is left as the arrow's inferred name ("execute" from the property), not forced to OPEN_OP.
			assert.notEqual(def.execute.name, OPEN_OP);
			// Unchanged behavior: with no central entry, a non-SU request to this op fails closed the same
			// way any unregistered op does — verifyPerms throws OP_NOT_FOUND (400), it does not silently allow.
			let threw;
			try {
				op_auth.verifyPerms(nonSuRequest(OPEN_OP), OPEN_OP);
			} catch (err) {
				threw = err;
			}
			assert.ok(threw, 'expected verifyPerms to throw for an unregistered op');
			assert.equal(threw.statusCode, 400);
		});

		it('allows a super_user to call a declared SU op', function () {
			assert.equal(op_auth.verifyPerms(suRequest(SU_OP), SU_OP), null);
		});

		it('denies a non-super_user without an operations grant', function () {
			const result = op_auth.verifyPerms(nonSuRequest(SU_OP), SU_OP);
			assert.ok(result, 'expected a permissions failure for a non-super_user without a grant');
		});

		it('allows a non-super_user whose role grants the op via the operations allowlist (SU-bypass)', function () {
			assert.equal(op_auth.verifyPerms(nonSuRequest(SU_OP, [SU_OP]), SU_OP), null);
		});
	});
});
