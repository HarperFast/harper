import search from '../../dataLayer/search.js';
import bulkLoad from '../../dataLayer/bulkLoad.js';
import schema from '../../dataLayer/schema.js';
import schemaDescribe from '../../dataLayer/schemaDescribe.js';
import delete_ from '../../dataLayer/delete.js';
import readAuditLog from '../../dataLayer/readAuditLog.js';
import user from '../../security/user.js';
import role from '../../security/role.js';
import customFunctionOperations from '../../components/operations.js';
import harperLogger from '../../utility/logging/harper_logger.js';
import readLog from '../../utility/logging/readLog.js';
import export_ from '../../dataLayer/export.js';
import opAuth from '../../utility/operation_authorization.js';
import jobs from '../jobs/jobs.js';
import * as terms from '../../utility/hdbTerms.ts';
import { hdbErrors, handleHDBError } from '../../utility/errors/hdbError.js';
const { HTTP_STATUS_CODES } = hdbErrors;
import restart from '../../bin/restart.js';
import * as util from 'util';
import insert from '../../dataLayer/insert.js';
import globalSchema from '../../utility/globalSchema.js';
import systemInformation from '../../utility/environment/systemInformation.js';
import jobRunner from '../jobs/jobRunner.js';
import * as tokenAuthentication from '../../security/tokenAuthentication.ts';
import * as auth from '../../security/auth.ts';
import configUtils from '../../config/configUtils.js';
import transactionLog from '../../utility/logging/transactionLog.js';
import npmUtilities from '../../utility/npmUtilities.js';
import { _assignPackageExport } from '../../globals.js';
import { transformReq } from '../../utility/common_utils.js';
import { server } from '../Server.ts';
const operationLog = harperLogger.loggerWithTag('operation');
import * as analytics from '../../resources/analytics/read.ts';
import operationFunctionCaller from '../../utility/OperationFunctionCaller.js';
import type { OperationRequest, OperationRequestBody, OperationResult } from '../operationsServer.ts';
import type { Context } from '../../resources/ResourceInterface.ts';
import * as status from '../status/index.ts';

const pSearchSearch = util.promisify(search.search);
let pEvaluateSql: (sql: string) => Promise<any>;
function evaluateSQL(command) {
	if (!pEvaluateSql) {
		const sql = require('../../sqlTranslator/index.js');
		pEvaluateSql = util.promisify(sql.evaluateSQL);
	}
	return pEvaluateSql(command);
}

const GLOBAL_SCHEMA_UPDATE_OPERATIONS_ENUM = {
	[terms.OPERATIONS_ENUM.CREATE_ATTRIBUTE]: true,
	[terms.OPERATIONS_ENUM.CREATE_TABLE]: true,
	[terms.OPERATIONS_ENUM.CREATE_SCHEMA]: true,
	[terms.OPERATIONS_ENUM.DROP_ATTRIBUTE]: true,
	[terms.OPERATIONS_ENUM.DROP_TABLE]: true,
	[terms.OPERATIONS_ENUM.DROP_SCHEMA]: true,
};

import { OperationFunctionObject } from './OperationFunctionObject.ts';

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
			(harperLogger.log_level === terms.LOG_LEVELS.INFO ||
				harperLogger.log_level === terms.LOG_LEVELS.DEBUG ||
				harperLogger.log_level === terms.LOG_LEVELS.TRACE)
		) {
			// Need to remove auth variables, but we don't want to create an object unless
			// the logging is actually going to happen.
			// eslint-disable-next-line @typescript-eslint/no-unused-vars
			const { hdb_user, hdbAuthHeader, password, payload, ...cleanBody } = req.body;
			operationLog.info(cleanBody);
		}
	} catch (e) {
		operationLog.error(e);
	}

	let data = await operationFunctionCaller.callOperationFunctionAsAwait(operationFunction, req.body, null);

	if (typeof data !== 'object') {
		data = { message: data };
	}
	if (data instanceof Error) {
		throw data;
	}
	if (GLOBAL_SCHEMA_UPDATE_OPERATIONS_ENUM[req.body.operation]) {
		globalSchema.setSchemaDataToGlobal((err: Error) => {
			if (err) {
				operationLog.error(err);
			}
		});
	}

	return data;
}

const OPERATION_FUNCTION_MAP = initializeOperationFunctionMap();

server.operation = operation;

export type OperationDefinition = {
	name: string;
	httpMethod: string;
	execute: (operation: any) => Promise<any>;
	inputSchema?: any;
	responseSchema?: any;
	isJob?: boolean;
};

/**
 * Register an operation function with the server.
 * @param operationName
 * @param operationFunction
 */
server.registerOperation = (operationDefinition: OperationDefinition) => {
	OPERATION_FUNCTION_MAP.set(operationDefinition.name, new OperationFunctionObject(operationDefinition.execute));
};

export function chooseOperation(json: OperationRequestBody) {
	let getOpResult: OperationFunctionObject;
	try {
		getOpResult = getOperationFunction(json);
	} catch (err) {
		operationLog.error(`Error when selecting operation function - ${err}`);
		throw err;
	}

	const { operation_function, job_operation_function } = getOpResult;

	// Here there is a SQL statement in either the operation or the searchOperation (from jobs like export_local).  Need to check the perms
	// on all affected tables/attributes.
	try {
		if (json.operation === 'sql' || (json.search_operation && json.search_operation.operation === 'sql')) {
			const sql = require('../../sqlTranslator/index.js');
			const sqlStatement = json.operation === 'sql' ? json.sql : json.search_operation.sql;
			const parsedSqlObject = sql.convertSQLToAST(sqlStatement);
			json.parsed_sql_object = parsedSqlObject;
			if (!json.bypass_auth) {
				const astPermCheck = sql.checkASTPermissions(json, parsedSqlObject);
				if (astPermCheck) {
					operationLog.error(`${HTTP_STATUS_CODES.FORBIDDEN} from operation ${json.operation}`);
					operationLog.warn(`User '${json.hdb_user?.username}' is not permitted to ${json.operation}`);
					throw handleHDBError(
						new Error(),
						astPermCheck,
						hdbErrors.HTTP_STATUS_CODES.FORBIDDEN,
						undefined,
						undefined,
						true
					);
				}
			}
			//we need to bypass permission checks to allow the createAuthorizationTokens
		} else if (
			!json.bypass_auth &&
			json.operation !== terms.OPERATIONS_ENUM.CREATE_AUTHENTICATION_TOKENS &&
			json.operation !== terms.OPERATIONS_ENUM.LOGIN &&
			json.operation !== terms.OPERATIONS_ENUM.LOGOUT
		) {
			const functionToCheck = job_operation_function === undefined ? operation_function : job_operation_function;
			const operation_json = json.search_operation ? json.search_operation : json;
			if (!operation_json.hdb_user) {
				operation_json.hdb_user = json.hdb_user;
			}

			const verifyPermsResult = opAuth.verifyPerms(operation_json, functionToCheck);

			if (verifyPermsResult) {
				operationLog.error(`${HTTP_STATUS_CODES.FORBIDDEN} from operation ${json.operation}`);
				operationLog.warn(
					`User '${operation_json.hdb_user?.username}' is not permitted to ${operation_json.operation}`
				);
				throw handleHDBError(
					new Error(),
					verifyPermsResult,
					hdbErrors.HTTP_STATUS_CODES.FORBIDDEN,
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
	operationLog.trace(`getOperationFunction with operation: ${json.operation}`);

	if (OPERATION_FUNCTION_MAP.has(json.operation)) {
		return OPERATION_FUNCTION_MAP.get(json.operation);
	}

	throw handleHDBError(
		new Error(),
		hdbErrors.HDB_ERROR_MSGS.OP_NOT_FOUND(json.operation),
		hdbErrors.HTTP_STATUS_CODES.BAD_REQUEST,
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
	operationLog.trace('In serverUtils.catchup');
	const catchupObject = req.transaction;
	const splitChannel = catchupObject.channel.split(':');

	const _schema = splitChannel[0];
	const table = splitChannel[1];
	for (const transaction of catchupObject.transactions) {
		try {
			transaction.schema = _schema;
			transaction.table = table;
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
					operationLog.warn('invalid operation in catchup');
					break;
			}
		} catch (e) {
			operationLog.info('Invalid operation in transaction');
			operationLog.error(e);
		}
	}
}

interface JobResult {
	message: string;
	job_id: string;
}

export async function executeJob(json: OperationRequestBody): Promise<JobResult> {
	transformReq(json);

	let newJobObject;
	let result;
	try {
		result = await jobs.addJob(json);
		if (result) {
			newJobObject = result.createdJob;
			operationLog.info('addJob result', result);
			const jobRunnerMessage = new jobRunner.RunnerMessage(newJobObject, json);
			const returnMessage = await jobRunner.parseMessage(jobRunnerMessage);

			return {
				message: returnMessage ?? `Starting job with id ${newJobObject.id}`,
				job_id: newJobObject.id,
			};
		}
	} catch (err) {
		const error = err instanceof Error ? err : null;
		const message = `There was an error executing job: ${error && 'http_resp_msg' in error ? error.http_resp_msg : err}`;
		operationLog.error(message);
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
	opFuncMap.set(terms.OPERATIONS_ENUM.SEARCH, new OperationFunctionObject(pSearchSearch));
	opFuncMap.set(terms.OPERATIONS_ENUM.SQL, new OperationFunctionObject(evaluateSQL));
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
	opFuncMap.set(terms.OPERATIONS_ENUM.DESCRIBE_SCHEMA, new OperationFunctionObject(schemaDescribe.describeSchema));
	opFuncMap.set(terms.OPERATIONS_ENUM.DESCRIBE_DATABASE, new OperationFunctionObject(schemaDescribe.describeSchema));
	opFuncMap.set(terms.OPERATIONS_ENUM.DESCRIBE_TABLE, new OperationFunctionObject(schemaDescribe.describeTable));
	opFuncMap.set(terms.OPERATIONS_ENUM.DESCRIBE_ALL, new OperationFunctionObject(schemaDescribe.describeAll));
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
	opFuncMap.set(terms.OPERATIONS_ENUM.READ_LOG, new OperationFunctionObject(readLog));
	opFuncMap.set(terms.OPERATIONS_ENUM.SET_CONFIGURATION, new OperationFunctionObject(configUtils.setConfiguration));
	opFuncMap.set(terms.OPERATIONS_ENUM.EXPORT_TO_S3, new OperationFunctionObject(executeJob, export_.export_to_s3));

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
	opFuncMap.set(terms.OPERATIONS_ENUM.RESTART, new OperationFunctionObject(restart.restart));
	opFuncMap.set(terms.OPERATIONS_ENUM.RESTART_SERVICE, new OperationFunctionObject(executeJob, restart.restartService));
	opFuncMap.set(terms.OPERATIONS_ENUM.CATCHUP, new OperationFunctionObject(catchup));
	opFuncMap.set(
		terms.OPERATIONS_ENUM.SYSTEM_INFORMATION,
		new OperationFunctionObject(systemInformation.systemInformation)
	);
	opFuncMap.set(
		terms.OPERATIONS_ENUM.DELETE_AUDIT_LOGS_BEFORE,
		new OperationFunctionObject(executeJob, delete_.deleteAuditLogsBefore)
	);
	opFuncMap.set(terms.OPERATIONS_ENUM.READ_AUDIT_LOG, new OperationFunctionObject(readAuditLog));
	opFuncMap.set(
		terms.OPERATIONS_ENUM.CREATE_AUTHENTICATION_TOKENS,
		new OperationFunctionObject(tokenAuthentication.createTokens)
	);
	opFuncMap.set(
		terms.OPERATIONS_ENUM.REFRESH_OPERATION_TOKEN,
		new OperationFunctionObject(tokenAuthentication.refreshOperationToken)
	);
	opFuncMap.set(terms.OPERATIONS_ENUM.LOGIN, new OperationFunctionObject(auth.login));
	opFuncMap.set(terms.OPERATIONS_ENUM.LOGOUT, new OperationFunctionObject(auth.logout));

	opFuncMap.set(terms.OPERATIONS_ENUM.GET_CONFIGURATION, new OperationFunctionObject(configUtils.getConfiguration));
	opFuncMap.set(
		terms.OPERATIONS_ENUM.CUSTOM_FUNCTIONS_STATUS,
		new OperationFunctionObject(customFunctionOperations.customFunctionsStatus)
	);
	opFuncMap.set(
		terms.OPERATIONS_ENUM.GET_CUSTOM_FUNCTIONS,
		new OperationFunctionObject(customFunctionOperations.getCustomFunctions)
	);
	opFuncMap.set(
		terms.OPERATIONS_ENUM.GET_COMPONENT_FILE,
		new OperationFunctionObject(customFunctionOperations.getComponentFile)
	);
	opFuncMap.set(
		terms.OPERATIONS_ENUM.GET_COMPONENTS,
		new OperationFunctionObject(customFunctionOperations.getComponents)
	);
	opFuncMap.set(
		terms.OPERATIONS_ENUM.SET_COMPONENT_FILE,
		new OperationFunctionObject(customFunctionOperations.setComponentFile)
	);
	opFuncMap.set(
		terms.OPERATIONS_ENUM.DROP_COMPONENT,
		new OperationFunctionObject(customFunctionOperations.dropComponent)
	);
	opFuncMap.set(
		terms.OPERATIONS_ENUM.GET_CUSTOM_FUNCTION,
		new OperationFunctionObject(customFunctionOperations.getCustomFunction)
	);
	opFuncMap.set(
		terms.OPERATIONS_ENUM.SET_CUSTOM_FUNCTION,
		new OperationFunctionObject(customFunctionOperations.setCustomFunction)
	);
	opFuncMap.set(
		terms.OPERATIONS_ENUM.DROP_CUSTOM_FUNCTION,
		new OperationFunctionObject(customFunctionOperations.dropCustomFunction)
	);
	opFuncMap.set(
		terms.OPERATIONS_ENUM.ADD_CUSTOM_FUNCTION_PROJECT,
		new OperationFunctionObject(customFunctionOperations.addComponent)
	);
	opFuncMap.set(
		terms.OPERATIONS_ENUM.ADD_COMPONENT,
		new OperationFunctionObject(customFunctionOperations.addComponent)
	);
	opFuncMap.set(
		terms.OPERATIONS_ENUM.DROP_CUSTOM_FUNCTION_PROJECT,
		new OperationFunctionObject(customFunctionOperations.dropCustomFunctionProject)
	);
	opFuncMap.set(
		terms.OPERATIONS_ENUM.PACKAGE_CUSTOM_FUNCTION_PROJECT,
		new OperationFunctionObject(customFunctionOperations.packageComponent)
	);
	opFuncMap.set(
		terms.OPERATIONS_ENUM.PACKAGE_COMPONENT,
		new OperationFunctionObject(customFunctionOperations.packageComponent)
	);
	opFuncMap.set(
		terms.OPERATIONS_ENUM.DEPLOY_CUSTOM_FUNCTION_PROJECT,
		new OperationFunctionObject(customFunctionOperations.deployComponent)
	);
	opFuncMap.set(
		terms.OPERATIONS_ENUM.DEPLOY_COMPONENT,
		new OperationFunctionObject(customFunctionOperations.deployComponent)
	);
	opFuncMap.set(
		terms.OPERATIONS_ENUM.READ_TRANSACTION_LOG,
		new OperationFunctionObject(transactionLog.readTransactionLog)
	);
	opFuncMap.set(
		terms.OPERATIONS_ENUM.DELETE_TRANSACTION_LOGS_BEFORE,
		new OperationFunctionObject(executeJob, transactionLog.deleteTransactionLogsBefore)
	);
	opFuncMap.set(terms.OPERATIONS_ENUM.INSTALL_NODE_MODULES, new OperationFunctionObject(npmUtilities.installModules));
	opFuncMap.set(terms.OPERATIONS_ENUM.GET_BACKUP, new OperationFunctionObject(schema.getBackup));
	opFuncMap.set(terms.OPERATIONS_ENUM.CLEANUP_ORPHAN_BLOBS, new OperationFunctionObject(schema.cleanupOrphanBlobs));

	opFuncMap.set(terms.OPERATIONS_ENUM.GET_ANALYTICS, new OperationFunctionObject(analytics.getOp));
	opFuncMap.set(terms.OPERATIONS_ENUM.LIST_METRICS, new OperationFunctionObject(analytics.listMetricsOp));
	opFuncMap.set(terms.OPERATIONS_ENUM.DESCRIBE_METRIC, new OperationFunctionObject(analytics.describeMetricOp));

	// set status operations
	opFuncMap.set(terms.OPERATIONS_ENUM.GET_STATUS, new OperationFunctionObject(status.get));
	opFuncMap.set(terms.OPERATIONS_ENUM.SET_STATUS, new OperationFunctionObject(status.set));
	opFuncMap.set(terms.OPERATIONS_ENUM.CLEAR_STATUS, new OperationFunctionObject(status.clear));

	return opFuncMap;
}
