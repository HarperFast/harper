import search from '../../dataLayer/search';
import sql from '../../sqlTranslator/index';
import bulkLoad from '../../dataLayer/bulkLoad';
import schema from '../../dataLayer/schema';
import schema_describe from '../../dataLayer/schemaDescribe';
import delete_ from '../../dataLayer/delete';
import read_audit_log from '../../dataLayer/readAuditLog';
import user from '../../security/user';
import role from '../../security/role';
import custom_function_operations from '../../components/operations';
import harper_logger from '../../utility/logging/harper_logger';
import read_log from '../../utility/logging/readLog';
import add_node from '../../utility/clustering/addNode';
import update_node from '../../utility/clustering/updateNode';
import remove_node from '../../utility/clustering/removeNode';
import configure_cluster from '../../utility/clustering/configureCluster';
import purge_stream from '../../utility/clustering/purgeStream';
import cluster_status from '../../utility/clustering/clusterStatus';
import cluster_network from '../../utility/clustering/clusterNetwork';
import routes from '../../utility/clustering/routes';
import export_ from '../../dataLayer/export';
import op_auth from '../../utility/operation_authorization';
import jobs from '../jobs/jobs';
import * as terms from '../../utility/hdbTerms';
import { hdb_errors, handleHDBError } from '../../utility/errors/hdbError';
const { HTTP_STATUS_CODES } = hdb_errors;
import reg from '../../utility/registration/registrationHandler';
import restart from '../../bin/restart';
import * as util from 'util';
import insert from '../../dataLayer/insert';
import global_schema from '../../utility/globalSchema';
import system_information from '../../utility/environment/systemInformation';
import job_runner from '../jobs/jobRunner';
import * as token_authentication from '../../security/tokenAuthentication';
import * as auth from '../../security/auth';
import config_utils from '../../config/configUtils';
import transaction_log from '../../utility/logging/transactionLog';
import npm_utilities from '../../utility/npmUtilities';
import { setServerUtilities } from '../../resources/Table';
import { _assignPackageExport } from '../../globals';
import { transformReq } from '../../utility/common_utils';
import { server } from '../Server';
const operation_log = harper_logger.loggerWithTag('operation');
import keys from '../../security/keys';
import * as set_node from '../../server/replication/setNode';
import * as analytics from '../../resources/analytics/read';
import operation_function_caller from '../../utility/OperationFunctionCaller';
import type { OperationRequest, OperationRequestBody, OperationResult } from '../operationsServer';
import { transact_to_clustering_utils } from '../../utility/clustering/transactToClusteringUtilities';
import type { Context } from '../../resources/ResourceInterface';
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

import { OperationFunctionObject } from './OperationFunctionObject';

type ValueOf<T> = T[keyof T];
export type OperationFunctionName = ValueOf<typeof terms.OPERATIONS_ENUM>;

/**
 * This will process a command message on this receiving node rather than sending it to a remote node.  NOTE: this function
 * handles the response to the sender.
 */
// TODO: Replace Function type with an actual function type (e.g. (): Thingy)
export async function processLocalTransaction(req: OperationRequest, operationFunction: Function) {
	try {
		if (
			req.body.operation !== 'read_log' &&
			(harper_logger.log_level === terms.LOG_LEVELS.INFO ||
				harper_logger.log_level === terms.LOG_LEVELS.DEBUG ||
				harper_logger.log_level === terms.LOG_LEVELS.TRACE)
		) {
			// Need to remove auth variables, but we don't want to create an object unless
			// the logging is actually going to happen.
			// eslint-disable-next-line no-unused-vars,@typescript-eslint/no-unused-vars
			const { hdb_user, hdb_auth_header, password, payload, ...clean_body } = req.body;
			operation_log.info(clean_body);
		}
	} catch (e) {
		operation_log.error(e);
	}

	let data = await operation_function_caller.callOperationFunctionAsAwait(operationFunction, req.body, null);

	if (typeof data !== 'object') {
		data = { message: data };
	}
	if (data instanceof Error) {
		throw data;
	}
	if (GLOBAL_SCHEMA_UPDATE_OPERATIONS_ENUM[req.body.operation]) {
		global_schema.setSchemaDataToGlobal((err: Error) => {
			if (err) {
				operation_log.error(err);
			}
		});
	}

	return data;
}

const OPERATION_FUNCTION_MAP = initializeOperationFunctionMap();

setServerUtilities(exports);
server.operation = operation;

export function chooseOperation(json: OperationRequestBody) {
	let getOpResult: OperationFunctionObject;
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
			const sql_statement = json.operation === 'sql' ? json.sql : json.search_operation.sql;
			const parsed_sql_object = sql.convertSQLToAST(sql_statement);
			json.parsed_sql_object = parsed_sql_object;
			if (!json.bypass_auth) {
				const ast_perm_check = sql.checkASTPermissions(json, parsed_sql_object);
				if (ast_perm_check) {
					operation_log.error(`${HTTP_STATUS_CODES.FORBIDDEN} from operation ${json.operation}`);
					operation_log.warn(`User '${json.hdb_user?.username}' is not permitted to ${json.operation}`);
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
			const function_to_check = job_operation_function === undefined ? operation_function : job_operation_function;
			const operation_json = json.search_operation ? json.search_operation : json;
			if (!operation_json.hdb_user) {
				operation_json.hdb_user = json.hdb_user;
			}

			const verify_perms_result = op_auth.verifyPerms(operation_json, function_to_check);

			if (verify_perms_result) {
				operation_log.error(`${HTTP_STATUS_CODES.FORBIDDEN} from operation ${json.operation}`);
				operation_log.warn(
					`User '${operation_json.hdb_user?.username}' is not permitted to ${operation_json.operation}`
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

export function getOperationFunction(json: OperationRequestBody): OperationFunctionObject {
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
 */
export function operation(operation: OperationRequestBody, context: Context, authorize: boolean) {
	operation.hdb_user = context?.user;
	operation.bypass_auth = !authorize;
	const operation_function = chooseOperation(operation);
	return processLocalTransaction({ body: operation }, operation_function);
}

interface Transaction {
	schema: string;
	table: string;
	operation: OperationFunctionName;
}

interface TransactionWrapper {
	channel: string;
	transactions: Transaction[];
}

interface CatchupOperationRequest extends OperationRequestBody {
	transaction: TransactionWrapper;
}

async function catchup(req: CatchupOperationRequest) {
	operation_log.trace('In serverUtils.catchup');
	const catchup_object = req.transaction;
	const split_channel = catchup_object.channel.split(':');

	const _schema = split_channel[0];
	const table = split_channel[1];
	for (const transaction of catchup_object.transactions) {
		try {
			transaction.schema = _schema;
			transaction.table = table;
			transaction[terms.CLUSTERING_FLAG] = true;
			let result: OperationResult;
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

interface JobResult {
	message: string;
	job_id: string;
}

export async function executeJob(json: OperationRequestBody): Promise<JobResult> {
	transformReq(json);

	let new_job_object = undefined;
	let result = undefined;
	try {
		result = await jobs.addJob(json);
		new_job_object = result.createdJob;
		operation_log.info('addJob result', result);
		const job_runner_message = new job_runner.RunnerMessage(new_job_object, json);
		const return_message = await job_runner.parseMessage(job_runner_message);

		return {
			message: return_message ?? `Starting job with id ${new_job_object.id}`,
			job_id: new_job_object.id,
		};
	} catch (err) {
		const message = `There was an error executing job: ${err.http_resp_msg ? err.http_resp_msg : err}`;
		operation_log.error(message);
		throw handleHDBError(err, message);
	}
}

function initializeOperationFunctionMap(): Map<OperationFunctionName, OperationFunctionObject> {
	const opFuncMap = new Map<OperationFunctionName, OperationFunctionObject>();

	opFuncMap.set(terms.OPERATIONS_ENUM.INSERT, new OperationFunctionObject(insert.insert));
	opFuncMap.set(terms.OPERATIONS_ENUM.UPDATE, new OperationFunctionObject(insert.update));
	opFuncMap.set(terms.OPERATIONS_ENUM.UPSERT, new OperationFunctionObject(insert.upsert));
	opFuncMap.set(terms.OPERATIONS_ENUM.SEARCH_BY_CONDITIONS, new OperationFunctionObject(search.searchByConditions));
	opFuncMap.set(terms.OPERATIONS_ENUM.SEARCH_BY_HASH, new OperationFunctionObject(search.searchByHash));
	opFuncMap.set(terms.OPERATIONS_ENUM.SEARCH_BY_ID, new OperationFunctionObject(search.searchByHash));
	opFuncMap.set(terms.OPERATIONS_ENUM.SEARCH_BY_VALUE, new OperationFunctionObject(search.searchByValue));
	opFuncMap.set(terms.OPERATIONS_ENUM.SEARCH, new OperationFunctionObject(p_search_search));
	opFuncMap.set(terms.OPERATIONS_ENUM.SQL, new OperationFunctionObject(p_sql_evaluate_sql));
	opFuncMap.set(terms.OPERATIONS_ENUM.CSV_DATA_LOAD, new OperationFunctionObject(executeJob, bulkLoad.csvDataLoad));
	opFuncMap.set(terms.OPERATIONS_ENUM.CSV_FILE_LOAD, new OperationFunctionObject(executeJob, bulkLoad.csvFileLoad));
	opFuncMap.set(terms.OPERATIONS_ENUM.CSV_URL_LOAD, new OperationFunctionObject(executeJob, bulkLoad.csvURLLoad));
	opFuncMap.set(terms.OPERATIONS_ENUM.IMPORT_FROM_S3, new OperationFunctionObject(executeJob, bulkLoad.importFromS3));
	opFuncMap.set(terms.OPERATIONS_ENUM.CREATE_SCHEMA, new OperationFunctionObject(schema.createSchema));
	opFuncMap.set(terms.OPERATIONS_ENUM.CREATE_DATABASE, new OperationFunctionObject(schema.createSchema));
	opFuncMap.set(terms.OPERATIONS_ENUM.CREATE_TABLE, new OperationFunctionObject(schema.createTable));
	opFuncMap.set(terms.OPERATIONS_ENUM.CREATE_ATTRIBUTE, new OperationFunctionObject(schema.createAttribute));
	opFuncMap.set(terms.OPERATIONS_ENUM.DROP_SCHEMA, new OperationFunctionObject(schema.dropSchema));
	opFuncMap.set(terms.OPERATIONS_ENUM.DROP_DATABASE, new OperationFunctionObject(schema.dropSchema));
	opFuncMap.set(terms.OPERATIONS_ENUM.DROP_TABLE, new OperationFunctionObject(schema.dropTable));
	opFuncMap.set(terms.OPERATIONS_ENUM.DROP_ATTRIBUTE, new OperationFunctionObject(schema.dropAttribute));
	opFuncMap.set(terms.OPERATIONS_ENUM.DESCRIBE_SCHEMA, new OperationFunctionObject(schema_describe.describeSchema));
	opFuncMap.set(terms.OPERATIONS_ENUM.DESCRIBE_DATABASE, new OperationFunctionObject(schema_describe.describeSchema));
	opFuncMap.set(terms.OPERATIONS_ENUM.DESCRIBE_TABLE, new OperationFunctionObject(schema_describe.describeTable));
	opFuncMap.set(terms.OPERATIONS_ENUM.DESCRIBE_ALL, new OperationFunctionObject(schema_describe.describeAll));
	opFuncMap.set(terms.OPERATIONS_ENUM.DELETE, new OperationFunctionObject(delete_.deleteRecord));
	opFuncMap.set(terms.OPERATIONS_ENUM.ADD_USER, new OperationFunctionObject(user.addUser));
	opFuncMap.set(terms.OPERATIONS_ENUM.ALTER_USER, new OperationFunctionObject(user.alterUser));
	opFuncMap.set(terms.OPERATIONS_ENUM.DROP_USER, new OperationFunctionObject(user.dropUser));
	opFuncMap.set(terms.OPERATIONS_ENUM.LIST_USERS, new OperationFunctionObject(user.listUsersExternal));
	opFuncMap.set(terms.OPERATIONS_ENUM.LIST_ROLES, new OperationFunctionObject(role.listRoles));
	opFuncMap.set(terms.OPERATIONS_ENUM.ADD_ROLE, new OperationFunctionObject(role.addRole));
	opFuncMap.set(terms.OPERATIONS_ENUM.ALTER_ROLE, new OperationFunctionObject(role.alterRole));
	opFuncMap.set(terms.OPERATIONS_ENUM.DROP_ROLE, new OperationFunctionObject(role.dropRole));
	opFuncMap.set(terms.OPERATIONS_ENUM.USER_INFO, new OperationFunctionObject(user.userInfo));
	opFuncMap.set(terms.OPERATIONS_ENUM.READ_LOG, new OperationFunctionObject(read_log));
	opFuncMap.set(terms.OPERATIONS_ENUM.ADD_NODE, new OperationFunctionObject(add_node));
	opFuncMap.set(terms.OPERATIONS_ENUM.UPDATE_NODE, new OperationFunctionObject(update_node));
	opFuncMap.set(terms.OPERATIONS_ENUM.SET_NODE_REPLICATION, new OperationFunctionObject(update_node));
	opFuncMap.set(terms.OPERATIONS_ENUM.REMOVE_NODE, new OperationFunctionObject(remove_node));
	opFuncMap.set(terms.OPERATIONS_ENUM.CONFIGURE_CLUSTER, new OperationFunctionObject(configure_cluster));
	opFuncMap.set(terms.OPERATIONS_ENUM.PURGE_STREAM, new OperationFunctionObject(purge_stream));
	opFuncMap.set(terms.OPERATIONS_ENUM.SET_CONFIGURATION, new OperationFunctionObject(config_utils.setConfiguration));
	opFuncMap.set(terms.OPERATIONS_ENUM.CLUSTER_STATUS, new OperationFunctionObject(cluster_status.clusterStatus));
	opFuncMap.set(terms.OPERATIONS_ENUM.CLUSTER_NETWORK, new OperationFunctionObject(cluster_network));
	opFuncMap.set(terms.OPERATIONS_ENUM.CLUSTER_SET_ROUTES, new OperationFunctionObject(routes.setRoutes));
	opFuncMap.set(terms.OPERATIONS_ENUM.CLUSTER_GET_ROUTES, new OperationFunctionObject(routes.getRoutes));
	opFuncMap.set(terms.OPERATIONS_ENUM.CLUSTER_DELETE_ROUTES, new OperationFunctionObject(routes.deleteRoutes));
	opFuncMap.set(terms.OPERATIONS_ENUM.EXPORT_TO_S3, new OperationFunctionObject(executeJob, export_.export_to_s3));
	opFuncMap.set(terms.OPERATIONS_ENUM.CREATE_CSR, new OperationFunctionObject(keys.createCsr));
	opFuncMap.set(terms.OPERATIONS_ENUM.SIGN_CERTIFICATE, new OperationFunctionObject(keys.signCertificate));
	opFuncMap.set(terms.OPERATIONS_ENUM.LIST_CERTIFICATES, new OperationFunctionObject(keys.listCertificates));
	opFuncMap.set(terms.OPERATIONS_ENUM.ADD_CERTIFICATES, new OperationFunctionObject(keys.addCertificate));
	opFuncMap.set(terms.OPERATIONS_ENUM.REMOVE_CERTIFICATE, new OperationFunctionObject(keys.removeCertificate));
	opFuncMap.set(terms.OPERATIONS_ENUM.GET_KEY, new OperationFunctionObject(keys.getKey));
	opFuncMap.set(terms.OPERATIONS_ENUM.ADD_NODE_BACK, new OperationFunctionObject(set_node.addNodeBack));
	opFuncMap.set(terms.OPERATIONS_ENUM.REMOVE_NODE_BACK, new OperationFunctionObject(set_node.removeNodeBack));

	opFuncMap.set(
		terms.OPERATIONS_ENUM.DELETE_FILES_BEFORE,
		new OperationFunctionObject(executeJob, delete_.deleteFilesBefore)
	);
	opFuncMap.set(
		terms.OPERATIONS_ENUM.DELETE_RECORDS_BEFORE,
		new OperationFunctionObject(executeJob, delete_.deleteFilesBefore)
	);
	opFuncMap.set(terms.OPERATIONS_ENUM.EXPORT_LOCAL, new OperationFunctionObject(executeJob, export_.export_local));
	opFuncMap.set(
		terms.OPERATIONS_ENUM.SEARCH_JOBS_BY_START_DATE,
		new OperationFunctionObject(jobs.handleGetJobsByStartDate)
	);
	opFuncMap.set(terms.OPERATIONS_ENUM.GET_JOB, new OperationFunctionObject(jobs.handleGetJob));
	opFuncMap.set(terms.OPERATIONS_ENUM.GET_FINGERPRINT, new OperationFunctionObject(reg.getFingerprint));
	opFuncMap.set(terms.OPERATIONS_ENUM.SET_LICENSE, new OperationFunctionObject(reg.setLicense));
	opFuncMap.set(terms.OPERATIONS_ENUM.GET_REGISTRATION_INFO, new OperationFunctionObject(reg.getRegistrationInfo));
	opFuncMap.set(terms.OPERATIONS_ENUM.RESTART, new OperationFunctionObject(restart.restart));
	opFuncMap.set(terms.OPERATIONS_ENUM.RESTART_SERVICE, new OperationFunctionObject(executeJob, restart.restartService));
	opFuncMap.set(terms.OPERATIONS_ENUM.CATCHUP, new OperationFunctionObject(catchup));
	opFuncMap.set(
		terms.OPERATIONS_ENUM.SYSTEM_INFORMATION,
		new OperationFunctionObject(system_information.systemInformation)
	);
	opFuncMap.set(
		terms.OPERATIONS_ENUM.DELETE_AUDIT_LOGS_BEFORE,
		new OperationFunctionObject(executeJob, delete_.deleteAuditLogsBefore)
	);
	opFuncMap.set(terms.OPERATIONS_ENUM.READ_AUDIT_LOG, new OperationFunctionObject(read_audit_log));
	opFuncMap.set(
		terms.OPERATIONS_ENUM.CREATE_AUTHENTICATION_TOKENS,
		new OperationFunctionObject(token_authentication.createTokens)
	);
	opFuncMap.set(
		terms.OPERATIONS_ENUM.REFRESH_OPERATION_TOKEN,
		new OperationFunctionObject(token_authentication.refreshOperationToken)
	);
	opFuncMap.set(terms.OPERATIONS_ENUM.LOGIN, new OperationFunctionObject(auth.login));
	opFuncMap.set(terms.OPERATIONS_ENUM.LOGOUT, new OperationFunctionObject(auth.logout));

	opFuncMap.set(terms.OPERATIONS_ENUM.GET_CONFIGURATION, new OperationFunctionObject(config_utils.getConfiguration));
	opFuncMap.set(
		terms.OPERATIONS_ENUM.CUSTOM_FUNCTIONS_STATUS,
		new OperationFunctionObject(custom_function_operations.customFunctionsStatus)
	);
	opFuncMap.set(
		terms.OPERATIONS_ENUM.GET_CUSTOM_FUNCTIONS,
		new OperationFunctionObject(custom_function_operations.getCustomFunctions)
	);
	opFuncMap.set(
		terms.OPERATIONS_ENUM.GET_COMPONENT_FILE,
		new OperationFunctionObject(custom_function_operations.getComponentFile)
	);
	opFuncMap.set(
		terms.OPERATIONS_ENUM.GET_COMPONENTS,
		new OperationFunctionObject(custom_function_operations.getComponents)
	);
	opFuncMap.set(
		terms.OPERATIONS_ENUM.SET_COMPONENT_FILE,
		new OperationFunctionObject(custom_function_operations.setComponentFile)
	);
	opFuncMap.set(
		terms.OPERATIONS_ENUM.DROP_COMPONENT,
		new OperationFunctionObject(custom_function_operations.dropComponent)
	);
	opFuncMap.set(
		terms.OPERATIONS_ENUM.GET_CUSTOM_FUNCTION,
		new OperationFunctionObject(custom_function_operations.getCustomFunction)
	);
	opFuncMap.set(
		terms.OPERATIONS_ENUM.SET_CUSTOM_FUNCTION,
		new OperationFunctionObject(custom_function_operations.setCustomFunction)
	);
	opFuncMap.set(
		terms.OPERATIONS_ENUM.DROP_CUSTOM_FUNCTION,
		new OperationFunctionObject(custom_function_operations.dropCustomFunction)
	);
	opFuncMap.set(
		terms.OPERATIONS_ENUM.ADD_CUSTOM_FUNCTION_PROJECT,
		new OperationFunctionObject(custom_function_operations.addComponent)
	);
	opFuncMap.set(
		terms.OPERATIONS_ENUM.ADD_COMPONENT,
		new OperationFunctionObject(custom_function_operations.addComponent)
	);
	opFuncMap.set(
		terms.OPERATIONS_ENUM.DROP_CUSTOM_FUNCTION_PROJECT,
		new OperationFunctionObject(custom_function_operations.dropCustomFunctionProject)
	);
	opFuncMap.set(
		terms.OPERATIONS_ENUM.PACKAGE_CUSTOM_FUNCTION_PROJECT,
		new OperationFunctionObject(custom_function_operations.packageComponent)
	);
	opFuncMap.set(
		terms.OPERATIONS_ENUM.PACKAGE_COMPONENT,
		new OperationFunctionObject(custom_function_operations.packageComponent)
	);
	opFuncMap.set(
		terms.OPERATIONS_ENUM.DEPLOY_CUSTOM_FUNCTION_PROJECT,
		new OperationFunctionObject(custom_function_operations.deployComponent)
	);
	opFuncMap.set(
		terms.OPERATIONS_ENUM.DEPLOY_COMPONENT,
		new OperationFunctionObject(custom_function_operations.deployComponent)
	);
	opFuncMap.set(
		terms.OPERATIONS_ENUM.READ_TRANSACTION_LOG,
		new OperationFunctionObject(transaction_log.readTransactionLog)
	);
	opFuncMap.set(
		terms.OPERATIONS_ENUM.DELETE_TRANSACTION_LOGS_BEFORE,
		new OperationFunctionObject(executeJob, transaction_log.deleteTransactionLogsBefore)
	);
	opFuncMap.set(terms.OPERATIONS_ENUM.INSTALL_NODE_MODULES, new OperationFunctionObject(npm_utilities.installModules));
	opFuncMap.set(terms.OPERATIONS_ENUM.AUDIT_NODE_MODULES, new OperationFunctionObject(npm_utilities.auditModules));
	opFuncMap.set(terms.OPERATIONS_ENUM.GET_BACKUP, new OperationFunctionObject(schema.getBackup));
	opFuncMap.set(terms.OPERATIONS_ENUM.ADD_SSH_KEY, new OperationFunctionObject(custom_function_operations.addSSHKey));
	opFuncMap.set(
		terms.OPERATIONS_ENUM.UPDATE_SSH_KEY,
		new OperationFunctionObject(custom_function_operations.updateSSHKey)
	);
	opFuncMap.set(
		terms.OPERATIONS_ENUM.DELETE_SSH_KEY,
		new OperationFunctionObject(custom_function_operations.deleteSSHKey)
	);
	opFuncMap.set(
		terms.OPERATIONS_ENUM.LIST_SSH_KEYS,
		new OperationFunctionObject(custom_function_operations.listSSHKeys)
	);
	opFuncMap.set(
		terms.OPERATIONS_ENUM.SET_SSH_KNOWN_HOSTS,
		new OperationFunctionObject(custom_function_operations.setSSHKnownHosts)
	);
	opFuncMap.set(
		terms.OPERATIONS_ENUM.GET_SSH_KNOWN_HOSTS,
		new OperationFunctionObject(custom_function_operations.getSSHKnownHosts)
	);
	opFuncMap.set(terms.OPERATIONS_ENUM.GET_ANALYTICS, new OperationFunctionObject(analytics.get));
	return opFuncMap;
}
