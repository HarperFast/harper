import * as search from '../../dataLayer/search.ts';
import * as bulkLoad from '../../dataLayer/bulkLoad.ts';
import * as schema from '../../dataLayer/schema.ts';
import * as schemaDescribe from '../../dataLayer/schemaDescribe.ts';
import * as delete_ from '../../dataLayer/delete.ts';
import readAuditLog from '../../dataLayer/readAuditLog.ts';
import * as user from '../../security/user.ts';
import * as role from '../../security/role.ts';
import customFunctionOperations from '../../components/operations.js';
import harperLogger from '../../utility/logging/harper_logger.ts';
import readLog from '../../utility/logging/readLog.ts';
import * as export_ from '../../dataLayer/export.ts';
import * as opAuth from '../../utility/operation_authorization.ts';
import * as jobs from '../jobs/jobs.ts';
import * as terms from '../../utility/hdbTerms.ts';
import { hdbErrors, handleHDBError } from '../../utility/errors/hdbError.ts';
const { HTTP_STATUS_CODES } = hdbErrors;
import * as restart from '../../bin/restart.ts';
import * as util from 'util';
import * as insert from '../../dataLayer/insert.ts';
import * as globalSchema from '../../utility/globalSchema.ts';
import { systemInformation } from '../../utility/environment/systemInformation.ts';
import * as jobRunner from '../jobs/jobRunner.ts';
import * as tokenAuthentication from '../../security/tokenAuthentication.ts';
import * as auth from '../../security/auth.ts';
import * as configUtils from '../../config/configUtils.ts';
import * as transactionLog from '../../utility/logging/transactionLog.ts';
import * as npmUtilities from '../../utility/npmUtilities.ts';
import { _assignPackageExport } from '../../globals.js';
import { transformReq } from '../../utility/common_utils.ts';
import { server } from '../Server.ts';
const operationLog = harperLogger.loggerWithTag('operation');
import * as analytics from '../../resources/analytics/read.ts';
import * as operationFunctionCaller from '../../utility/OperationFunctionCaller.ts';
import type { OperationRequest, OperationRequestBody } from '../operationsServer.ts';
import type { Context } from '../../resources/ResourceInterface.ts';
import * as status from '../status/index.ts';
import * as regDeprecated from '../../resources/registrationDeprecated.ts';
import * as deploymentOperations from '../../components/deploymentOperations.ts';
import * as secretOperations from '../../components/secretOperations.ts';
import { contextStorage } from '../../resources/transaction.ts';

const pSearchSearch = util.promisify(search.search);
let pEvaluateSql: (sql: string) => Promise<any>;
function evaluateSQL(command) {
	if (!pEvaluateSql) {
		const sql = require('../../sqlTranslator/index');
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

// Cluster/replication topology operations must NOT run under the request's ambient user context
// (the #1591 attribution wrap below). Two reasons:
//
//   1. Their writes are internal node-registry bookkeeping (hdb_nodes, certificates), not
//      user-authored data — they should not be stamped with a user principal.
//   2. Critically, they start long-lived, non-awaited replication subscription work (a peer
//      connection's connect/handshake/reconnect lifecycle) that outlives the handler. Because that
//      work is constructed while this handler's AsyncLocalStorage scope is active, it keeps
//      observing the ambient { user } for its ENTIRE life, not just the request — which corrupts
//      the subscription's identity and produces a WebSocket 1006 reconnect storm that never meshes
//      (regression from #1591/#1592; the pre-#1591 world gave this background work no ambient user).
//
// The durable fix is to detach that background work from the ambient context where it is spawned
// (harper-pro's replication component); this core-side exclusion resolves the regression for the
// operations that trigger it without that background work ever inheriting a user. The names span
// core and harper-pro's replication component (registered via server.registerOperation), so this
// set must be kept in sync if new topology-management operations are added.
const OPERATIONS_EXCLUDED_FROM_AMBIENT_USER = new Set<string>([
	terms.OPERATIONS_ENUM.ADD_NODE, // 'add_node'
	terms.OPERATIONS_ENUM.UPDATE_NODE, // 'update_node'
	terms.OPERATIONS_ENUM.SET_NODE_REPLICATION, // 'set_node_replication'
	'add_node_back',
	'set_node',
	'remove_node',
	'remove_node_back',
	'configure_cluster',
]);

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
			(harperLogger.logLevel === terms.LOG_LEVELS.INFO ||
				harperLogger.logLevel === terms.LOG_LEVELS.DEBUG ||
				harperLogger.logLevel === terms.LOG_LEVELS.TRACE)
		) {
			// Need to remove auth variables and secret-bearing fields (value/values carry .env
			// secrets from set_env_value; value/envelope carry secrets from set_secret), but we
			// don't want to create an object unless the logging is actually going to happen.
			// eslint-disable-next-line @typescript-eslint/no-unused-vars
			const { hdb_user, hdbAuthHeader, password, payload, value, values, envelope, ...cleanBody } = req.body;
			operationLog.info(cleanBody);
		}
	} catch (e) {
		operationLog.error(e);
	}

	// Bridge the authenticated user into the ambient async context so static Resource API calls
	// (e.g. table.put) inside operation handlers inherit user attribution for audit records
	// (issue #1591). An explicit context passed by a handler still takes precedence (the
	// transactional wrappers only fall back to contextStorage when no context is provided), and
	// an existing ambient context already carrying this user (e.g. server.operation() called
	// from within a request handler) is preserved rather than shadowed. When the ambient user
	// differs (or is absent), the ambient context is merged rather than replaced: other ambient
	// properties (open transaction, signal, caches) are preserved so atomicity is unaffected and
	// only the user is swapped for attribution; the outer context object itself is never mutated.
	// Cluster/replication topology operations are excluded (see OPERATIONS_EXCLUDED_FROM_AMBIENT_USER):
	// they spawn long-lived background work that would otherwise inherit this ambient user for its
	// whole life.
	const hdbUser = req.body.hdb_user;
	const currentStore = contextStorage.getStore();
	const callOperationFunction = () =>
		operationFunctionCaller.callOperationFunctionAsAwait(operationFunction, req.body, null);
	let data;
	if (OPERATIONS_EXCLUDED_FROM_AMBIENT_USER.has(req.body.operation)) {
		// Excluded operations must run with no ambient user principal. Strip any ambient user —
		// whether it would come from this request's hdb_user or from an enclosing ambient context
		// (e.g. a nested server.operation() call from within an authenticated handler) — so the
		// long-lived background work they spawn never inherits a user. Other ambient state is
		// preserved, and the outer context object is never mutated.
		data = currentStore
			? await contextStorage.run({ ...currentStore, user: undefined }, callOperationFunction)
			: await callOperationFunction();
	} else {
		data =
			hdbUser && currentStore?.user !== hdbUser
				? await contextStorage.run({ ...currentStore, user: hdbUser }, callOperationFunction)
				: await callOperationFunction();
	}

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

export const OPERATION_FUNCTION_MAP = initializeOperationFunctionMap();

server.operation = operation;
export type OperationDefinition = {
	name: string;
	execute: (operation: any) => any | Promise<any>;
	httpMethod?: 'DELETE' | 'GET' | 'HEAD' | 'OPTIONS' | 'PATCH' | 'POST' | 'PUT' | 'TRACE'; // method to use for REST
	isJob?: boolean;
	parametersSchema?: any[];
};

/**
 * Register an operation function with the server.
 * @param operationDefinition
 */
server.registerOperation = (operationDefinition: OperationDefinition) => {
	OPERATION_FUNCTION_MAP.set(operationDefinition.name as any, new OperationFunctionObject(operationDefinition.execute));
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
			const sql = require('../../sqlTranslator/index');
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
		throw handleHDBError(err, `There was an error when trying to choose an operation path`, 500);
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
			switch (transaction.operation) {
				case terms.OPERATIONS_ENUM.INSERT:
					await insert.insert(transaction);
					break;
				case terms.OPERATIONS_ENUM.UPDATE:
					await insert.update(transaction);
					break;
				case terms.OPERATIONS_ENUM.UPSERT:
					await insert.upsert(transaction);
					break;
				case terms.OPERATIONS_ENUM.DELETE:
					await delete_.deleteRecord(transaction);
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
		throw handleHDBError(err, message, 500);
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
	opFuncMap.set(
		terms.OPERATIONS_ENUM.REGISTRATION_INFO,
		new OperationFunctionObject(regDeprecated.getRegistrationInfo)
	);
	opFuncMap.set(terms.OPERATIONS_ENUM.RESTART, new OperationFunctionObject(restart.restart));
	opFuncMap.set(terms.OPERATIONS_ENUM.RESTART_SERVICE, new OperationFunctionObject(executeJob, restart.restartService));
	opFuncMap.set(terms.OPERATIONS_ENUM.CATCHUP, new OperationFunctionObject(catchup));
	opFuncMap.set(terms.OPERATIONS_ENUM.SYSTEM_INFORMATION, new OperationFunctionObject(systemInformation));
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
	opFuncMap.set(terms.OPERATIONS_ENUM.GET_ENV_KEYS, new OperationFunctionObject(customFunctionOperations.getEnvKeys));
	opFuncMap.set(terms.OPERATIONS_ENUM.SET_ENV_VALUE, new OperationFunctionObject(customFunctionOperations.setEnvValue));
	opFuncMap.set(
		terms.OPERATIONS_ENUM.DELETE_ENV_VALUE,
		new OperationFunctionObject(customFunctionOperations.deleteEnvValue)
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
		terms.OPERATIONS_ENUM.LIST_DEPLOYMENTS,
		new OperationFunctionObject(deploymentOperations.handleListDeployments)
	);
	opFuncMap.set(
		terms.OPERATIONS_ENUM.GET_DEPLOYMENT,
		new OperationFunctionObject(deploymentOperations.handleGetDeployment)
	);
	opFuncMap.set(terms.OPERATIONS_ENUM.SET_SECRET, new OperationFunctionObject(secretOperations.setSecret));
	opFuncMap.set(terms.OPERATIONS_ENUM.GRANT_SECRET, new OperationFunctionObject(secretOperations.grantSecret));
	opFuncMap.set(terms.OPERATIONS_ENUM.REVOKE_SECRET, new OperationFunctionObject(secretOperations.revokeSecret));
	opFuncMap.set(terms.OPERATIONS_ENUM.LIST_SECRETS, new OperationFunctionObject(secretOperations.listSecrets));
	opFuncMap.set(terms.OPERATIONS_ENUM.DELETE_SECRET, new OperationFunctionObject(secretOperations.deleteSecret));
	opFuncMap.set(
		terms.OPERATIONS_ENUM.GET_SECRETS_PUBLIC_KEY,
		new OperationFunctionObject(secretOperations.getSecretsPublicKey)
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
