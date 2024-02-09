'use strict';

const search = require('../../dataLayer/search');
const sql = require('../../sqlTranslator/index');
const bulkLoad = require('../../dataLayer/bulkLoad');
const schema = require('../../dataLayer/schema');
const schema_describe = require('../../dataLayer/schemaDescribe');
const delete_ = require('../../dataLayer/delete');
const read_audit_log = require('../../dataLayer/readAuditLog');
const user = require('../../security/user');
const role = require('../../security/role');
const custom_function_operations = require('../../components/operations');
const harper_logger = require('../../utility/logging/harper_logger');
const read_log = require('../../utility/logging/readLog');
const add_node = require('../../utility/clustering/addNode');
const update_node = require('../../utility/clustering/updateNode');
const remove_node = require('../../utility/clustering/removeNode');
const configure_cluster = require('../../utility/clustering/configureCluster');
const purge_stream = require('../../utility/clustering/purgeStream');
const cluster_status = require('../../utility/clustering/clusterStatus');
const cluster_network = require('../../utility/clustering/clusterNetwork');
const routes = require('../../utility/clustering/routes');
const export_ = require('../../dataLayer/export');
const op_auth = require('../../utility/operation_authorization');
const jobs = require('../jobs/jobs');
const terms = require('../../utility/hdbTerms');
const { hdb_errors, handleHDBError } = require('../../utility/errors/hdbError');
const { HTTP_STATUS_CODES } = hdb_errors;
const reg = require('../../utility/registration/registrationHandler');
const restart = require('../../bin/restart');
const util = require('util');
const insert = require('../../dataLayer/insert');
const global_schema = require('../../utility/globalSchema');
const system_information = require('../../utility/environment/systemInformation');
const job_runner = require('../jobs/jobRunner');
const token_authentication = require('../../security/tokenAuthentication');
const auth = require('../../security/auth');
const config_utils = require('../../config/configUtils');
const transaction_log = require('../../utility/logging/transactionLog');
const npm_utilities = require('../../utility/npmUtilities');
const { setServerUtilities } = require('../../resources/Table');
const { CONTEXT } = require('../../resources/Resource');
const { _assignPackageExport } = require('../../index');
const { transformReq } = require('../../utility/common_utils');
const { server } = require('../../server/Server');
const operation_log = harper_logger.loggerWithTag('operation');

const operation_function_caller = require(`../../utility/OperationFunctionCaller`);

const p_search_search_by_hash = search.searchByHash;
const p_search_search_by_value = search.searchByValue;
const p_search_search = util.promisify(search.search);
const p_sql_evaluate_sql = util.promisify(sql.evaluateSQL);

const GLOBAL_SCHEMA_UPDATE_OPERATIONS_ENUM = {
	[terms.OPERATIONS_ENUM.CREATE_ATTRIBUTE]: true,
	[terms.OPERATIONS_ENUM.CREATE_TABLE]: true,
	[terms.OPERATIONS_ENUM.CREATE_SCHEMA]: true,
	[terms.OPERATIONS_ENUM.DROP_ATTRIBUTE]: true,
	[terms.OPERATIONS_ENUM.DROP_TABLE]: true,
	[terms.OPERATIONS_ENUM.DROP_SCHEMA]: true,
};

const OperationFunctionObject = require('./OperationFunctionObject');

/**
 * This will process a command message on this receiving node rather than sending it to a remote node.  NOTE: this function
 * handles the response to the sender.
 * @param req
 * @param res
 * @param operation_function
 * @param callback
 * @returns {*}
 */
async function processLocalTransaction(req, operation_function) {
	try {
		if (
			req.body.operation !== 'read_log' &&
			(harper_logger.log_level === terms.LOG_LEVELS.INFO ||
				harper_logger.log_level === terms.LOG_LEVELS.DEBUG ||
				harper_logger.log_level === terms.LOG_LEVELS.TRACE)
		) {
			// Need to remove auth variables, but we don't want to create an object unless
			// the logging is actually going to happen.
			// eslint-disable-next-line no-unused-vars
			const { hdb_user, hdb_auth_header, password, ...clean_body } = req.body;
			operation_log.info(clean_body);
		}
	} catch (e) {
		operation_log.error(e);
	}

	let data = await operation_function_caller.callOperationFunctionAsAwait(operation_function, req.body, null);

	if (typeof data !== 'object') {
		data = { message: data };
	}
	if (data instanceof Error) {
		throw data;
	}
	if (GLOBAL_SCHEMA_UPDATE_OPERATIONS_ENUM[req.body.operation]) {
		global_schema.setSchemaDataToGlobal((err) => {
			if (err) {
				operation_log.error(err);
			}
		});
	}

	return data;
}

const OPERATION_FUNCTION_MAP = initializeOperationFunctionMap();

module.exports = {
	chooseOperation,
	getOperationFunction,
	operation,
	processLocalTransaction,
};
setServerUtilities(module.exports);
server.operation = operation;

function chooseOperation(json) {
	let getOpResult;
	try {
		getOpResult = getOperationFunction(json);
	} catch (err) {
		operation_log.error(`Error when selecting operation function - ${err}`);
		throw err;
	}

	const { operation_function, job_operation_function } = getOpResult;

	// Here there is a SQL statement in either the operation or the search_operation (from jobs like export_local).  Need to check the perms
	// on all affected tables/attributes.
	try {
		if (json.operation === 'sql' || (json.search_operation && json.search_operation.operation === 'sql')) {
			let sql_statement = json.operation === 'sql' ? json.sql : json.search_operation.sql;
			let parsed_sql_object = sql.convertSQLToAST(sql_statement);
			json.parsed_sql_object = parsed_sql_object;
			if (!json.bypass_auth) {
				let ast_perm_check = sql.checkASTPermissions(json, parsed_sql_object);
				if (ast_perm_check) {
					operation_log.error(`${HTTP_STATUS_CODES.FORBIDDEN} from operation ${json.operation}`);
					operation_log.warn(`User '${json.hdb_user.username}' is not permitted to ${json.operation}`);
					throw handleHDBError(
						new Error(),
						ast_perm_check,
						hdb_errors.HTTP_STATUS_CODES.FORBIDDEN,
						undefined,
						undefined,
						true
					);
				}
			}
			//we need to bypass permission checks to allow the create_authorization_tokens
		} else if (
			!json.bypass_auth &&
			json.operation !== terms.OPERATIONS_ENUM.CREATE_AUTHENTICATION_TOKENS &&
			json.operation !== terms.OPERATIONS_ENUM.LOGIN &&
			json.operation !== terms.OPERATIONS_ENUM.LOGOUT
		) {
			let function_to_check = job_operation_function === undefined ? operation_function : job_operation_function;
			let operation_json = json.search_operation ? json.search_operation : json;
			if (!operation_json.hdb_user) {
				operation_json.hdb_user = json.hdb_user;
			}

			let verify_perms_result = op_auth.verifyPerms(operation_json, function_to_check);

			if (verify_perms_result) {
				operation_log.error(`${HTTP_STATUS_CODES.FORBIDDEN} from operation ${json.operation}`);
				operation_log.warn(
					`User '${operation_json.hdb_user.username}' is not permitted to ${operation_json.operation}`
				);
				throw handleHDBError(
					new Error(),
					verify_perms_result,
					hdb_errors.HTTP_STATUS_CODES.FORBIDDEN,
					undefined,
					false,
					true
				);
			}
		}
	} catch (err) {
		throw handleHDBError(err, `There was an error when trying to choose an operation path`);
	}
	return operation_function;
}

function getOperationFunction(json) {
	operation_log.trace(`getOperationFunction with operation: ${json.operation}`);

	if (OPERATION_FUNCTION_MAP.has(json.operation)) {
		return OPERATION_FUNCTION_MAP.get(json.operation);
	}

	throw handleHDBError(
		new Error(),
		hdb_errors.HDB_ERROR_MSGS.OP_NOT_FOUND(json.operation),
		hdb_errors.HTTP_STATUS_CODES.BAD_REQUEST,
		undefined,
		undefined,
		true
	);
}

_assignPackageExport('operation', operation);
/**
 * Standalone function to execute an operation
 * @param {*} operation
 * @param {*} authorize?: boolean
 * @returns
 */
function operation(operation, authorize) {
	operation.hdb_user = this[CONTEXT]?.user;
	operation.bypass_auth = !authorize;
	const operation_function = chooseOperation(operation);
	return processLocalTransaction({ body: operation }, operation_function);
}
async function catchup(req) {
	operation_log.trace('In serverUtils.catchup');
	let catchup_object = req.transaction;
	let split_channel = catchup_object.channel.split(':');

	let _schema = split_channel[0];
	let table = split_channel[1];
	for (let transaction of catchup_object.transactions) {
		try {
			transaction.schema = _schema;
			transaction.table = table;
			transaction[terms.CLUSTERING_FLAG] = true;
			let result;
			switch (transaction.operation) {
				case terms.OPERATIONS_ENUM.INSERT:
					result = await insert.insert(transaction);
					break;
				case terms.OPERATIONS_ENUM.UPDATE:
					result = await insert.update(transaction);
					break;
				case terms.OPERATIONS_ENUM.UPSERT:
					result = await insert.upsert(transaction);
					break;
				case terms.OPERATIONS_ENUM.DELETE:
					result = await delete_.deleteRecord(transaction);
					break;
				default:
					operation_log.warn('invalid operation in catchup');
					break;
			}

			await transact_to_clustering_utils.postOperationHandler(transaction, result, req);
		} catch (e) {
			operation_log.info('Invalid operation in transaction');
			operation_log.error(e);
		}
	}
}

async function executeJob(json) {
	transformReq(json);

	let new_job_object = undefined;
	let result = undefined;
	try {
		result = await jobs.addJob(json);
		new_job_object = result.createdJob;
		operation_log.info('addJob result', result);
		let job_runner_message = new job_runner.RunnerMessage(new_job_object, json);
		await job_runner.parseMessage(job_runner_message);

		return {
			message: `Starting job with id ${new_job_object.id}`,
			job_id: new_job_object.id,
		};
	} catch (err) {
		let message = `There was an error executing job: ${err.http_resp_msg ? err.http_resp_msg : err}`;
		operation_log.error(message);
		throw handleHDBError(err, message);
	}
}

function initializeOperationFunctionMap() {
	let op_func_map = new Map();

	op_func_map.set(terms.OPERATIONS_ENUM.INSERT, new OperationFunctionObject(insert.insert));
	op_func_map.set(terms.OPERATIONS_ENUM.UPDATE, new OperationFunctionObject(insert.update));
	op_func_map.set(terms.OPERATIONS_ENUM.UPSERT, new OperationFunctionObject(insert.upsert));
	op_func_map.set(terms.OPERATIONS_ENUM.SEARCH_BY_CONDITIONS, new OperationFunctionObject(search.searchByConditions));
	op_func_map.set(terms.OPERATIONS_ENUM.SEARCH_BY_HASH, new OperationFunctionObject(p_search_search_by_hash));
	op_func_map.set(terms.OPERATIONS_ENUM.SEARCH_BY_ID, new OperationFunctionObject(p_search_search_by_hash));
	op_func_map.set(terms.OPERATIONS_ENUM.SEARCH_BY_VALUE, new OperationFunctionObject(p_search_search_by_value));
	op_func_map.set(terms.OPERATIONS_ENUM.SEARCH, new OperationFunctionObject(p_search_search));
	op_func_map.set(terms.OPERATIONS_ENUM.SQL, new OperationFunctionObject(p_sql_evaluate_sql));
	op_func_map.set(terms.OPERATIONS_ENUM.CSV_DATA_LOAD, new OperationFunctionObject(executeJob, bulkLoad.csvDataLoad));
	op_func_map.set(terms.OPERATIONS_ENUM.CSV_FILE_LOAD, new OperationFunctionObject(executeJob, bulkLoad.csvFileLoad));
	op_func_map.set(terms.OPERATIONS_ENUM.CSV_URL_LOAD, new OperationFunctionObject(executeJob, bulkLoad.csvURLLoad));
	op_func_map.set(terms.OPERATIONS_ENUM.IMPORT_FROM_S3, new OperationFunctionObject(executeJob, bulkLoad.importFromS3));
	op_func_map.set(terms.OPERATIONS_ENUM.CREATE_SCHEMA, new OperationFunctionObject(schema.createSchema));
	op_func_map.set(terms.OPERATIONS_ENUM.CREATE_DATABASE, new OperationFunctionObject(schema.createSchema));
	op_func_map.set(terms.OPERATIONS_ENUM.CREATE_TABLE, new OperationFunctionObject(schema.createTable));
	op_func_map.set(terms.OPERATIONS_ENUM.CREATE_ATTRIBUTE, new OperationFunctionObject(schema.createAttribute));
	op_func_map.set(terms.OPERATIONS_ENUM.DROP_SCHEMA, new OperationFunctionObject(schema.dropSchema));
	op_func_map.set(terms.OPERATIONS_ENUM.DROP_DATABASE, new OperationFunctionObject(schema.dropSchema));
	op_func_map.set(terms.OPERATIONS_ENUM.DROP_TABLE, new OperationFunctionObject(schema.dropTable));
	op_func_map.set(terms.OPERATIONS_ENUM.DROP_ATTRIBUTE, new OperationFunctionObject(schema.dropAttribute));
	op_func_map.set(terms.OPERATIONS_ENUM.DESCRIBE_SCHEMA, new OperationFunctionObject(schema_describe.describeSchema));
	op_func_map.set(terms.OPERATIONS_ENUM.DESCRIBE_DATABASE, new OperationFunctionObject(schema_describe.describeSchema));
	op_func_map.set(terms.OPERATIONS_ENUM.DESCRIBE_TABLE, new OperationFunctionObject(schema_describe.describeTable));
	op_func_map.set(terms.OPERATIONS_ENUM.DESCRIBE_ALL, new OperationFunctionObject(schema_describe.describeAll));
	op_func_map.set(terms.OPERATIONS_ENUM.DELETE, new OperationFunctionObject(delete_.deleteRecord));
	op_func_map.set(terms.OPERATIONS_ENUM.ADD_USER, new OperationFunctionObject(user.addUser));
	op_func_map.set(terms.OPERATIONS_ENUM.ALTER_USER, new OperationFunctionObject(user.alterUser));
	op_func_map.set(terms.OPERATIONS_ENUM.DROP_USER, new OperationFunctionObject(user.dropUser));
	op_func_map.set(terms.OPERATIONS_ENUM.LIST_USERS, new OperationFunctionObject(user.listUsersExternal));
	op_func_map.set(terms.OPERATIONS_ENUM.LIST_ROLES, new OperationFunctionObject(role.listRoles));
	op_func_map.set(terms.OPERATIONS_ENUM.ADD_ROLE, new OperationFunctionObject(role.addRole));
	op_func_map.set(terms.OPERATIONS_ENUM.ALTER_ROLE, new OperationFunctionObject(role.alterRole));
	op_func_map.set(terms.OPERATIONS_ENUM.DROP_ROLE, new OperationFunctionObject(role.dropRole));
	op_func_map.set(terms.OPERATIONS_ENUM.USER_INFO, new OperationFunctionObject(user.userInfo));
	op_func_map.set(terms.OPERATIONS_ENUM.READ_LOG, new OperationFunctionObject(read_log));
	op_func_map.set(terms.OPERATIONS_ENUM.ADD_NODE, new OperationFunctionObject(add_node));
	op_func_map.set(terms.OPERATIONS_ENUM.UPDATE_NODE, new OperationFunctionObject(update_node));
	op_func_map.set(terms.OPERATIONS_ENUM.SET_NODE_REPLICATION, new OperationFunctionObject(update_node));
	op_func_map.set(terms.OPERATIONS_ENUM.REMOVE_NODE, new OperationFunctionObject(remove_node));
	op_func_map.set(terms.OPERATIONS_ENUM.CONFIGURE_CLUSTER, new OperationFunctionObject(configure_cluster));
	op_func_map.set(terms.OPERATIONS_ENUM.PURGE_STREAM, new OperationFunctionObject(purge_stream));
	op_func_map.set(terms.OPERATIONS_ENUM.SET_CONFIGURATION, new OperationFunctionObject(config_utils.setConfiguration));
	op_func_map.set(terms.OPERATIONS_ENUM.CLUSTER_STATUS, new OperationFunctionObject(cluster_status.clusterStatus));
	op_func_map.set(terms.OPERATIONS_ENUM.CLUSTER_NETWORK, new OperationFunctionObject(cluster_network));
	op_func_map.set(terms.OPERATIONS_ENUM.CLUSTER_SET_ROUTES, new OperationFunctionObject(routes.setRoutes));
	op_func_map.set(terms.OPERATIONS_ENUM.CLUSTER_GET_ROUTES, new OperationFunctionObject(routes.getRoutes));
	op_func_map.set(terms.OPERATIONS_ENUM.CLUSTER_DELETE_ROUTES, new OperationFunctionObject(routes.deleteRoutes));
	op_func_map.set(terms.OPERATIONS_ENUM.EXPORT_TO_S3, new OperationFunctionObject(executeJob, export_.export_to_s3));
	op_func_map.set(
		terms.OPERATIONS_ENUM.DELETE_FILES_BEFORE,
		new OperationFunctionObject(executeJob, delete_.deleteFilesBefore)
	);
	op_func_map.set(
		terms.OPERATIONS_ENUM.DELETE_RECORDS_BEFORE,
		new OperationFunctionObject(executeJob, delete_.deleteFilesBefore)
	);
	op_func_map.set(terms.OPERATIONS_ENUM.EXPORT_LOCAL, new OperationFunctionObject(executeJob, export_.export_local));
	op_func_map.set(
		terms.OPERATIONS_ENUM.SEARCH_JOBS_BY_START_DATE,
		new OperationFunctionObject(jobs.handleGetJobsByStartDate)
	);
	op_func_map.set(terms.OPERATIONS_ENUM.GET_JOB, new OperationFunctionObject(jobs.handleGetJob));
	op_func_map.set(terms.OPERATIONS_ENUM.GET_FINGERPRINT, new OperationFunctionObject(reg.getFingerprint));
	op_func_map.set(terms.OPERATIONS_ENUM.SET_LICENSE, new OperationFunctionObject(reg.setLicense));
	op_func_map.set(terms.OPERATIONS_ENUM.GET_REGISTRATION_INFO, new OperationFunctionObject(reg.getRegistrationInfo));
	op_func_map.set(terms.OPERATIONS_ENUM.RESTART, new OperationFunctionObject(restart.restart));
	op_func_map.set(terms.OPERATIONS_ENUM.RESTART_SERVICE, new OperationFunctionObject(restart.restartService));
	op_func_map.set(terms.OPERATIONS_ENUM.CATCHUP, new OperationFunctionObject(catchup));
	op_func_map.set(
		terms.OPERATIONS_ENUM.SYSTEM_INFORMATION,
		new OperationFunctionObject(system_information.systemInformation)
	);
	op_func_map.set(
		terms.OPERATIONS_ENUM.DELETE_AUDIT_LOGS_BEFORE,
		new OperationFunctionObject(executeJob, delete_.deleteAuditLogsBefore)
	);
	op_func_map.set(terms.OPERATIONS_ENUM.READ_AUDIT_LOG, new OperationFunctionObject(read_audit_log));
	op_func_map.set(
		terms.OPERATIONS_ENUM.CREATE_AUTHENTICATION_TOKENS,
		new OperationFunctionObject(token_authentication.createTokens)
	);
	op_func_map.set(
		terms.OPERATIONS_ENUM.REFRESH_OPERATION_TOKEN,
		new OperationFunctionObject(token_authentication.refreshOperationToken)
	);
	op_func_map.set(terms.OPERATIONS_ENUM.LOGIN, new OperationFunctionObject(auth.login));
	op_func_map.set(terms.OPERATIONS_ENUM.LOGOUT, new OperationFunctionObject(auth.logout));

	op_func_map.set(terms.OPERATIONS_ENUM.GET_CONFIGURATION, new OperationFunctionObject(config_utils.getConfiguration));
	op_func_map.set(
		terms.OPERATIONS_ENUM.CUSTOM_FUNCTIONS_STATUS,
		new OperationFunctionObject(custom_function_operations.customFunctionsStatus)
	);
	op_func_map.set(
		terms.OPERATIONS_ENUM.GET_CUSTOM_FUNCTIONS,
		new OperationFunctionObject(custom_function_operations.getCustomFunctions)
	);
	op_func_map.set(
		terms.OPERATIONS_ENUM.GET_COMPONENT_FILE,
		new OperationFunctionObject(custom_function_operations.getComponentFile)
	);
	op_func_map.set(
		terms.OPERATIONS_ENUM.GET_COMPONENTS,
		new OperationFunctionObject(custom_function_operations.getComponents)
	);
	op_func_map.set(
		terms.OPERATIONS_ENUM.SET_COMPONENT_FILE,
		new OperationFunctionObject(custom_function_operations.setComponentFile)
	);
	op_func_map.set(
		terms.OPERATIONS_ENUM.DROP_COMPONENT,
		new OperationFunctionObject(custom_function_operations.dropComponent)
	);
	op_func_map.set(
		terms.OPERATIONS_ENUM.GET_CUSTOM_FUNCTION,
		new OperationFunctionObject(custom_function_operations.getCustomFunction)
	);
	op_func_map.set(
		terms.OPERATIONS_ENUM.SET_CUSTOM_FUNCTION,
		new OperationFunctionObject(custom_function_operations.setCustomFunction)
	);
	op_func_map.set(
		terms.OPERATIONS_ENUM.DROP_CUSTOM_FUNCTION,
		new OperationFunctionObject(custom_function_operations.dropCustomFunction)
	);
	op_func_map.set(
		terms.OPERATIONS_ENUM.ADD_CUSTOM_FUNCTION_PROJECT,
		new OperationFunctionObject(custom_function_operations.addComponent)
	);
	op_func_map.set(
		terms.OPERATIONS_ENUM.ADD_COMPONENT,
		new OperationFunctionObject(custom_function_operations.addComponent)
	);
	op_func_map.set(
		terms.OPERATIONS_ENUM.DROP_CUSTOM_FUNCTION_PROJECT,
		new OperationFunctionObject(custom_function_operations.dropCustomFunctionProject)
	);
	op_func_map.set(
		terms.OPERATIONS_ENUM.PACKAGE_CUSTOM_FUNCTION_PROJECT,
		new OperationFunctionObject(custom_function_operations.packageComponent)
	);
	op_func_map.set(
		terms.OPERATIONS_ENUM.PACKAGE_COMPONENT,
		new OperationFunctionObject(custom_function_operations.packageComponent)
	);
	op_func_map.set(
		terms.OPERATIONS_ENUM.DEPLOY_CUSTOM_FUNCTION_PROJECT,
		new OperationFunctionObject(custom_function_operations.deployComponent)
	);
	op_func_map.set(
		terms.OPERATIONS_ENUM.DEPLOY_COMPONENT,
		new OperationFunctionObject(custom_function_operations.deployComponent)
	);
	op_func_map.set(
		terms.OPERATIONS_ENUM.READ_TRANSACTION_LOG,
		new OperationFunctionObject(transaction_log.readTransactionLog)
	);
	op_func_map.set(
		terms.OPERATIONS_ENUM.DELETE_TRANSACTION_LOGS_BEFORE,
		new OperationFunctionObject(executeJob, transaction_log.deleteTransactionLogsBefore)
	);
	op_func_map.set(
		terms.OPERATIONS_ENUM.INSTALL_NODE_MODULES,
		new OperationFunctionObject(npm_utilities.installModules)
	);
	op_func_map.set(terms.OPERATIONS_ENUM.AUDIT_NODE_MODULES, new OperationFunctionObject(npm_utilities.auditModules));
	op_func_map.set(terms.OPERATIONS_ENUM.GET_BACKUP, new OperationFunctionObject(schema.getBackup));

	return op_func_map;
}
