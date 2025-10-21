'use strict';
/**
 * This module is used before a SQL or NoSQL operation is performed in order to ensure the user's assigned role
 * has the permissions and lack of restrictions needed to process the operation.  Only verifyPerms and verifyPermsAST
 * should be outward facing functions.
 *
 * verifyPerms() should be used to check permissions for NoSQL calls.  verifyPermsAST() should be used to check permissions
 * for SQL calls.
 *
 * The requiredPermissions member contains the permissions needed for each operation.  Any new operations added to
 * Harper need to have operations specified in here or they will never pass the permissions checks.
 * */
const write = require('../dataLayer/insert.js');
const search = require('../dataLayer/search.js');
const schema = require('../dataLayer/schema.js');
const schemaDescribe = require('../dataLayer/schemaDescribe.js');
const delete_ = require('../dataLayer/delete.js');
const readAuditLog = require('../dataLayer/readAuditLog.js');
const getBackup = require('../dataLayer/getBackup.js');
const user = require('../security/user.js');
const role = require('../security/role.js');
const harperLogger = require('../utility/logging/harper_logger.js');
const readLog = require('../utility/logging/readLog.js');
const addNode = require('../utility/clustering/addNode.js');
const update_node = require('../utility/clustering/updateNode.js');
const removeNode = require('../utility/clustering/removeNode.js');
const configureCluster = require('../utility/clustering/configureCluster.js');
const purgeStream = require('../utility/clustering/purgeStream.js');
const clusterStatus = require('../utility/clustering/clusterStatus.js');
const clusterNetwork = require('../utility/clustering/clusterNetwork.js');
const routes = require('../utility/clustering/routes.js');
const commonUtils = require('./common_utils.js');
const restart = require('../bin/restart.js');
const terms = require('./hdbTerms.ts');
const permsTranslator = require('../security/permissionsTranslator.js');
const systemInformation = require('../utility/environment/systemInformation.js');
const tokenAuthentication = require('../security/tokenAuthentication.ts');
const auth = require('../security/auth.ts');
const configUtils = require('../config/configUtils.js');
const functionsOperations = require('../components/operations.js');
const transactionLog = require('../utility/logging/transactionLog.js');
const npmUtilities = require('./npmUtilities.js');
const keys = require('../security/keys.js');
const setNode = require('../server/replication/setNode.ts');
const analytics = require('../resources/analytics/read.ts');
const status = require('../server/status/index.ts');
const usageLicensing = require('../resources/usageLicensing.ts');
const regDeprecated = require('../resources/registrationDeprecated.ts');
const PermissionResponseObject = require('../security/data_objects/PermissionResponseObject.js');
const { handleHDBError, hdbErrors } = require('../utility/errors/hdbError.js');
const { HDB_ERROR_MSGS, HTTP_STATUS_CODES } = hdbErrors;

const requiredPermissions = new Map();
const DELETE_PERM = 'delete';
const INSERT_PERM = 'insert';
const READ_PERM = 'read';
const UPDATE_PERM = 'update';
const DESCRIBE_PERM = 'describe';

const UPSERT_OP = 'upsert';

const DESCRIBE_SCHEMA_KEY = schemaDescribe.describeSchema.name;
const DESCRIBE_TABLE_KEY = schemaDescribe.describeTable.name;
const FORBIDDEN_SYSTEM_OPS_ENUM = {
	delete: true,
	deleteRecord: true,
	update: true,
	updateData: true,
	dropAttribute: true,
	dropTable: true,
	dropSchema: true,
	upsert: true,
	upsertData: true,
};

const ALLOWED_SYS_OPS = {
	insert: true,
	delete: true,
	deleteRecord: true,
	update: true,
	updateData: true,
	upsert: true,
	upsertData: true,
};

const CATCHUP = 'catchup';
const HANDLE_GET_JOB = 'handleGetJob';
const HANDLE_GET_JOB_BY_START_DATE = 'handleGetJobsByStartDate';
const BULK_OPS = {
	CSV_DATA_LOAD: 'csvDataLoad',
	CSV_URL_LOAD: 'csvURLLoad',
	CSV_FILE_LOAD: 'csvFileLoad',
	IMPORT_FROM_S3: 'importFromS3',
};

const STRUCTURE_USER_OPS = [
	schema.createTable.name,
	schema.createAttribute.name,
	schema.dropTable.name,
	schema.dropAttribute.name,
];

const DATA_EXPORT = {
	EXPORT_TO_S3: 'export_to_s3',
	EXPORT_LOCAL: 'export_local',
};

class permission {
	constructor(requiresSu, perms) {
		this.requires_su = requiresSu;
		this.perms = perms;
	}
}

requiredPermissions.set(write.insert.name, new permission(false, [INSERT_PERM]));
requiredPermissions.set(write.update.name, new permission(false, [UPDATE_PERM]));
requiredPermissions.set(write.upsert.name, new permission(false, [INSERT_PERM, UPDATE_PERM]));
requiredPermissions.set(search.searchByConditions.name, new permission(false, [READ_PERM]));
requiredPermissions.set(search.searchByHash.name, new permission(false, [READ_PERM]));
requiredPermissions.set(search.searchByValue.name, new permission(false, [READ_PERM]));
requiredPermissions.set(search.search.name, new permission(false, [READ_PERM]));
requiredPermissions.set(schema.createSchema.name, new permission(true, []));
requiredPermissions.set(schema.createTable.name, new permission(true, []));
requiredPermissions.set(schema.createAttribute.name, new permission(false, [INSERT_PERM]));
requiredPermissions.set(schema.dropSchema.name, new permission(true, []));
requiredPermissions.set(schema.dropTable.name, new permission(true, []));
requiredPermissions.set(schema.dropAttribute.name, new permission(true, []));
requiredPermissions.set(schemaDescribe.describeSchema.name, new permission(false, [READ_PERM]));
requiredPermissions.set(schemaDescribe.describeTable.name, new permission(false, [READ_PERM]));
requiredPermissions.set(delete_.deleteRecord.name, new permission(false, [DELETE_PERM]));
requiredPermissions.set(user.addUser.name, new permission(true, []));
requiredPermissions.set(user.alterUser.name, new permission(true, []));
requiredPermissions.set(user.dropUser.name, new permission(true, []));
requiredPermissions.set(user.listUsersExternal.name, new permission(true, []));
requiredPermissions.set(role.listRoles.name, new permission(true, []));
requiredPermissions.set(role.addRole.name, new permission(true, []));
requiredPermissions.set(role.alterRole.name, new permission(true, []));
requiredPermissions.set(role.dropRole.name, new permission(true, []));
requiredPermissions.set(readLog.name, new permission(true, []));
requiredPermissions.set(addNode.name, new permission(true, []));
requiredPermissions.set(update_node.name, new permission(true, []));
requiredPermissions.set(removeNode.name, new permission(true, []));
requiredPermissions.set(configureCluster.name, new permission(true, []));
requiredPermissions.set(purgeStream.name, new permission(true, []));
requiredPermissions.set(routes.setRoutes.name, new permission(true, []));
requiredPermissions.set(routes.getRoutes.name, new permission(true, []));
requiredPermissions.set(routes.deleteRoutes.name, new permission(true, []));
requiredPermissions.set(configUtils.setConfiguration.name, new permission(true, []));
requiredPermissions.set(clusterStatus.clusterStatus.name, new permission(true, []));
requiredPermissions.set(clusterNetwork.name, new permission(true, []));
requiredPermissions.set(delete_.deleteFilesBefore.name, new permission(true, []));
requiredPermissions.set(delete_.deleteAuditLogsBefore.name, new permission(true, []));
requiredPermissions.set(restart.restart.name, new permission(true, []));
requiredPermissions.set(restart.restartService.name, new permission(true, []));
requiredPermissions.set(readAuditLog.name, new permission(true, []));
requiredPermissions.set(getBackup.name, new permission(true, [READ_PERM]));
requiredPermissions.set(schema.cleanupOrphanBlobs.name, new permission(true, []));
requiredPermissions.set(systemInformation.systemInformation.name, new permission(true, []));
requiredPermissions.set(configUtils.getConfiguration.name, new permission(true, []));
requiredPermissions.set(transactionLog.readTransactionLog.name, new permission(true, []));
requiredPermissions.set(transactionLog.deleteTransactionLogsBefore.name, new permission(true, []));
requiredPermissions.set(npmUtilities.installModules.name, new permission(true, []));
requiredPermissions.set(keys.createCsr.name, new permission(true, []));
requiredPermissions.set(keys.signCertificate.name, new permission(true, []));
requiredPermissions.set(keys.listCertificates.name, new permission(true, []));
requiredPermissions.set(keys.addCertificate.name, new permission(true, []));
requiredPermissions.set(keys.removeCertificate.name, new permission(true, []));
requiredPermissions.set(keys.getKey.name, new permission(true, []));
requiredPermissions.set(setNode.addNodeBack.name, new permission(true, []));
requiredPermissions.set(setNode.removeNodeBack.name, new permission(true, []));
requiredPermissions.set(analytics.getOp.name, new permission(false, [READ_PERM]));
requiredPermissions.set(analytics.listMetricsOp.name, new permission(false, [READ_PERM]));
requiredPermissions.set(analytics.describeMetricOp.name, new permission(false, [READ_PERM]));
requiredPermissions.set(status.clear.name, new permission(true, []));
requiredPermissions.set(status.get.name, new permission(true, []));
requiredPermissions.set(status.set.name, new permission(true, []));
requiredPermissions.set(usageLicensing.installUsageLicenseOp.name, new permission(true, []));
requiredPermissions.set(usageLicensing.getUsageLicensesOp.name, new permission(true, []));
requiredPermissions.set(regDeprecated.getFingerprint.name, new permission(true, []));
requiredPermissions.set(regDeprecated.setLicense.name, new permission(true, []));

//this operation must be available to all users so they can create authentication tokens and login
requiredPermissions.set(tokenAuthentication.createTokens.name, new permission(false, []));
requiredPermissions.set(tokenAuthentication.refreshOperationToken.name, new permission(false, []));
requiredPermissions.set(auth.login.name, new permission(false, []));
requiredPermissions.set(auth.logout.name, new permission(false, []));

//Operations specific to HDB Functions
requiredPermissions.set(functionsOperations.customFunctionsStatus.name, new permission(true, []));
requiredPermissions.set(functionsOperations.getCustomFunctions.name, new permission(true, []));
requiredPermissions.set(functionsOperations.getComponents.name, new permission(true, []));
requiredPermissions.set(functionsOperations.getComponentFile.name, new permission(true, []));
requiredPermissions.set(functionsOperations.setComponentFile.name, new permission(true, []));
requiredPermissions.set(functionsOperations.dropComponent.name, new permission(true, []));
requiredPermissions.set(functionsOperations.getCustomFunction.name, new permission(true, []));
requiredPermissions.set(functionsOperations.setCustomFunction.name, new permission(true, []));
requiredPermissions.set(functionsOperations.dropCustomFunction.name, new permission(true, []));
requiredPermissions.set(functionsOperations.addComponent.name, new permission(true, []));
requiredPermissions.set(functionsOperations.dropCustomFunctionProject.name, new permission(true, []));
requiredPermissions.set(functionsOperations.packageComponent.name, new permission(true, []));
requiredPermissions.set(functionsOperations.deployComponent.name, new permission(true, []));
requiredPermissions.set(functionsOperations.addSSHKey.name, new permission(true, []));
requiredPermissions.set(functionsOperations.getSSHKey.name, new permission(true, []));
requiredPermissions.set(functionsOperations.updateSSHKey.name, new permission(true, []));
requiredPermissions.set(functionsOperations.deleteSSHKey.name, new permission(true, []));
requiredPermissions.set(functionsOperations.listSSHKeys.name, new permission(true, []));
requiredPermissions.set(functionsOperations.setSSHKnownHosts.name, new permission(true, []));
requiredPermissions.set(functionsOperations.getSSHKnownHosts.name, new permission(true, []));

//Below are functions that are currently open to all roles
requiredPermissions.set(regDeprecated.getRegistrationInfo.name, new permission(false, []));
requiredPermissions.set(user.userInfo.name, new permission(false, []));
//DescribeAll will only return the schema values a user has permissions for
requiredPermissions.set(schemaDescribe.describeAll.name, new permission(false, []));

//Below function names are hardcoded b/c of circular dependency issues
requiredPermissions.set(HANDLE_GET_JOB, new permission(false, []));
requiredPermissions.set(HANDLE_GET_JOB_BY_START_DATE, new permission(true, []));
requiredPermissions.set(CATCHUP, new permission(true, []));
requiredPermissions.set(BULK_OPS.CSV_DATA_LOAD, new permission(false, [INSERT_PERM, UPDATE_PERM]));
requiredPermissions.set(BULK_OPS.CSV_URL_LOAD, new permission(false, [INSERT_PERM, UPDATE_PERM]));
requiredPermissions.set(BULK_OPS.CSV_FILE_LOAD, new permission(false, [INSERT_PERM, UPDATE_PERM]));
requiredPermissions.set(BULK_OPS.IMPORT_FROM_S3, new permission(false, [INSERT_PERM, UPDATE_PERM]));
requiredPermissions.set(DATA_EXPORT.EXPORT_TO_S3, new permission(true, []));
requiredPermissions.set(DATA_EXPORT.EXPORT_LOCAL, new permission(true, []));

// SQL operations are distinct from operations above, so we need to store required perms for both.
requiredPermissions.set(terms.VALID_SQL_OPS_ENUM.DELETE, new permission(false, [DELETE_PERM]));
requiredPermissions.set(terms.VALID_SQL_OPS_ENUM.SELECT, new permission(false, [READ_PERM]));
requiredPermissions.set(terms.VALID_SQL_OPS_ENUM.INSERT, new permission(false, [INSERT_PERM]));
requiredPermissions.set(terms.VALID_SQL_OPS_ENUM.UPDATE, new permission(false, [UPDATE_PERM]));

module.exports = {
	verifyPerms,
	verifyPermsAst,
	verifyBulkLoadAttributePerms,
};

/**
 * Verifies permissions and restrictions for a SQL operation based on the user's assigned role.
 * @param ast - The SQL statement in Syntax Tree form.
 * @param userObject - The user and role specification
 * @param operation - The operation specified in the call.
 * @returns {null | PermissionResponseObject} - null if permissions match, errors returned in the PermissionResponseObject
 */
function verifyPermsAst(ast, userObject, operation) {
	//TODO - update these validation checks to use validate.js
	if (commonUtils.isEmptyOrZeroLength(ast)) {
		harperLogger.info('verify_perms_ast has an empty user parameter');
		throw handleHDBError(new Error());
	}
	if (commonUtils.isEmptyOrZeroLength(userObject)) {
		harperLogger.info('verify_perms_ast has an empty user parameter');
		throw handleHDBError(new Error());
	}
	if (commonUtils.isEmptyOrZeroLength(operation)) {
		harperLogger.info('verify_perms_ast has a null operation parameter');
		throw handleHDBError(new Error());
	}
	try {
		const bucket = require('../sqlTranslator/sql_statement_bucket.js');
		const alasql = require('alasql');

		const permsResponse = new PermissionResponseObject();
		let parsedAst = new bucket(ast);
		let schemas = parsedAst.getSchemas();
		let schemaTableMap = new Map();

		// Should not continue if there are no schemas defined and there are table columns defined.
		// This is defined so we can do calc selects like : SELECT ABS(-12)
		if ((!schemas || schemas.length === 0) && parsedAst.affected_attributes && parsedAst.affected_attributes.size > 0) {
			harperLogger.info(`No schemas defined in verifyPermsAst(), will not continue.`);
			throw handleHDBError(new Error());
		}
		// set to true if this operation affects a system table.  Only su can read from system tables, but can't update/delete.
		const isSuperUser = !!userObject.role.permission.super_user;
		const isSuSystemOperation = schemas.includes('system');

		if (isSuSystemOperation && FORBIDDEN_SYSTEM_OPS_ENUM[operation]) {
			throw handleHDBError(new Error(), HDB_ERROR_MSGS.DROP_SYSTEM, HTTP_STATUS_CODES.FORBIDDEN);
		}

		if (isSuperUser && !isSuSystemOperation) {
			//admins can do (almost) anything through the hole in sheet!
			return null;
		}

		const fullRolePerms = permsTranslator.getRolePermissions(userObject.role);
		userObject.role.permission = fullRolePerms;

		//If the AST is for a SELECT, we need to check for wildcards and, if they exist, update the AST to include the
		// attributes that the user has READ perms for - we can skip this step for super users
		if (!isSuperUser && ast instanceof alasql.yy.Select) {
			ast = parsedAst.updateAttributeWildcardsForRolePerms(fullRolePerms);
		}

		for (let s = 0; s < schemas.length; s++) {
			//NOSONAR
			let tables = parsedAst.getTablesBySchemaName(schemas[s]);
			if (tables) {
				schemaTableMap.set(schemas[s], tables);
			}
		}

		let tablePermRestriction = hasPermissions(userObject, operation, schemaTableMap, permsResponse); //NOSONAR;
		if (tablePermRestriction) {
			return tablePermRestriction;
		}

		schemaTableMap.forEach((tables, schemaKey) => {
			for (let t = 0; t < tables.length; t++) {
				let attributes = parsedAst.getAttributesBySchemaTableName(schemaKey, tables[t]);
				const attribute_permissions = getAttributePermissions(userObject.role.permission, schemaKey, tables[t]);
				checkAttributePerms(attributes, attribute_permissions, operation, tables[t], schemaKey, permsResponse);
			}
		});

		return permsResponse.getPermsResponse();
	} catch (e) {
		throw handleHDBError(e);
	}
}

/**
 * Verifies permissions and restrictions for the NoSQL operation based on the user's assigned role.
 *
 * @param requestJson - The request body as json
 * @param operation - The name of the operation specified in the request.
 * @returns { null | PermissionResponseObject } - null if permissions match, errors are consolidated into PermissionResponseObj.
 */
function verifyPerms(requestJson, operation) {
	if (
		requestJson === null ||
		operation === null ||
		requestJson.hdb_user === undefined ||
		requestJson.hdb_user === null
	) {
		harperLogger.info(`null required parameter in verifyPerms`);
		throw handleHDBError(new Error(), HDB_ERROR_MSGS.DEFAULT_INVALID_REQUEST, HTTP_STATUS_CODES.BAD_REQUEST);
	}

	//passing in the function rather than the function name is an easy mistake to make, so taking care of that case here.
	let op = undefined;
	if (operation instanceof Function) {
		op = operation.name;
	} else {
		op = operation;
	}
	//we need to use the action value, if present, to ensure the correct permission is checked below
	let action = requestJson.action;

	let operationSchema = requestJson.schema ?? requestJson.database;
	let table = requestJson.table;

	let schemaTableMap = new Map();
	if (operationSchema && table) {
		schemaTableMap.set(operationSchema, [table]);
	}

	const permsResponse = new PermissionResponseObject();

	if (
		commonUtils.isEmptyOrZeroLength(requestJson.hdb_user?.role) ||
		commonUtils.isEmptyOrZeroLength(requestJson.hdb_user?.role?.permission)
	) {
		harperLogger.info(
			`User ${requestJson.hdb_user?.username} has no role or permissions.  Please assign the user a valid role.`
		);
		return permsResponse.handleUnauthorizedItem(HDB_ERROR_MSGS.USER_HAS_NO_PERMS(requestJson.hdb_user?.username));
	}

	const isSuperUser = !!requestJson.hdb_user?.role?.permission?.super_user;
	const structureUser = requestJson.hdb_user?.role?.permission?.structure_user;
	// set to true if this operation affects a system table.  Only su can read from system tables, but can't update/delete.
	let isSuSystemOperation =
		schemaTableMap.has(terms.SYSTEM_SCHEMA_NAME) || operationSchema === terms.SYSTEM_SCHEMA_NAME;

	// Allow the hdbNodes, hdbRole & hdb_user tables to be modified by superusers
	if (
		isSuperUser &&
		isSuSystemOperation &&
		ALLOWED_SYS_OPS[requestJson.operation] &&
		(table === terms.SYSTEM_TABLE_NAMES.NODE_TABLE_NAME ||
			table === terms.SYSTEM_TABLE_NAMES.ROLE_TABLE_NAME ||
			table === terms.SYSTEM_TABLE_NAMES.USER_TABLE_NAME)
	) {
		return null;
	}

	if (isSuSystemOperation && FORBIDDEN_SYSTEM_OPS_ENUM[op]) {
		throw handleHDBError(new Error(), HDB_ERROR_MSGS.DROP_SYSTEM, HTTP_STATUS_CODES.FORBIDDEN);
	}

	if (isSuperUser && !isSuSystemOperation) {
		//admins can do (almost) anything
		return null;
	}

	//structureUsers can create/drop schemas if they are not locked down to specific schemas.
	if (structureUser === true && (op === schema.createSchema.name || op === schema.dropSchema.name)) {
		return null;
	}

	//check if this is a structureUser & trying to perform a structure user op
	if (STRUCTURE_USER_OPS.indexOf(op) >= 0 && (structureUser === true || Array.isArray(structureUser))) {
		//if true can perform op all schemas
		if (structureUser === true) {
			return null;
		}

		//if the structureUser value is an array and contains the operation schema, all good
		if (structureUser.indexOf(operationSchema) >= 0) {
			return null;
		}

		//if we get here then error out
		return permsResponse.handleUnauthorizedItem(
			`User does not have access to perform '${requestJson.operation}' against schema '${operationSchema}'`
		);
	}

	const fullRolePerms = permsTranslator.getRolePermissions(requestJson.hdb_user?.role);
	if (requestJson.hdb_user?.role) requestJson.hdb_user.role.permission = fullRolePerms;

	if (op === DESCRIBE_SCHEMA_KEY || op === DESCRIBE_TABLE_KEY) {
		if (!fullRolePerms.super_user) {
			if (operationSchema === terms.SYSTEM_SCHEMA_NAME) {
				return permsResponse.handleUnauthorizedItem(HDB_ERROR_MSGS.SCHEMA_PERM_ERROR(operationSchema));
			}

			if (op === DESCRIBE_SCHEMA_KEY) {
				if (!fullRolePerms[operationSchema] || !fullRolePerms[operationSchema][DESCRIBE_PERM]) {
					return permsResponse.handleInvalidItem(HDB_ERROR_MSGS.SCHEMA_NOT_FOUND(operationSchema));
				}
			}

			if (
				op === DESCRIBE_TABLE_KEY &&
				(!fullRolePerms[operationSchema] ||
					!fullRolePerms[operationSchema].tables[table] ||
					!fullRolePerms[operationSchema].tables[table][DESCRIBE_PERM])
			) {
				return permsResponse.handleInvalidItem(HDB_ERROR_MSGS.TABLE_NOT_FOUND(operationSchema, table));
			}
		}
	}

	let failedPermissions = hasPermissions(requestJson.hdb_user, op, schemaTableMap, permsResponse, action);
	//check if failedTablePerms are back and return them B/C it will be an op-level permission issue
	if (failedPermissions) {
		return failedPermissions;
	}

	if (requiredPermissions.get(op) && requiredPermissions.get(op).perms.length === 0) {
		return null;
	}

	//For a NoSQL search op with `get_attributes: '*'` - as long as the role has READ permissions on the table,
	//we will convert the * to the specific attributes the user has READ permissions for via their role.
	if (!isSuperUser && requestJson.get_attributes && terms.SEARCH_WILDCARDS.includes(requestJson.get_attributes[0])) {
		let finalGetAttrs = [];
		const table_perms = fullRolePerms[operationSchema].tables[table];

		if (table_perms[terms.PERMS_CRUD_ENUM.READ]) {
			if (table_perms.attribute_permissions.length > 0) {
				const tableAttrPerms = table_perms.attribute_permissions.filter((perm) => perm[terms.PERMS_CRUD_ENUM.READ]);
				tableAttrPerms.forEach((perm) => {
					finalGetAttrs.push(perm.attribute_name);
				});
			} else {
				finalGetAttrs = global.hdb_schema[operationSchema][table].attributes.map((obj) => obj.attribute);
			}

			requestJson.get_attributes = finalGetAttrs;
		}
	}

	const recordAttrs = getRecordAttributes(requestJson);
	const attrPermissions = getAttributePermissions(requestJson.hdb_user?.role?.permission, operationSchema, table);
	checkAttributePerms(recordAttrs, attrPermissions, op, table, operationSchema, permsResponse, action);

	//This result value will be null if no perms issues were found in checkAttributePerms
	return permsResponse.getPermsResponse();
}

/**
 * Checks if the user's role has the required permissions for the operation specified.
 * @param userObject - the hdb_user specified in the request body
 * @param op - the name of the operation
 * @param schemaTableMap - A map in the format [schemaKey, [tables]].
 * @returns {PermissionResponseObject | null} - null value if permissions match, PermissionResponseObject if not.
 */
function hasPermissions(userObject, op, schemaTableMap, permsResponse, action) {
	if (commonUtils.arrayHasEmptyValues([userObject, op, schemaTableMap])) {
		harperLogger.info(`hasPermissions has an invalid parameter`);
		throw handleHDBError(new Error());
	}
	// set to true if this operation affects a system table.  Only su can read from system tables, but can't update/delete.
	let isSuSystemOperation = schemaTableMap.has('system');
	const userPerms = userObject.role.permission;
	if (userPerms.super_user && (!isSuSystemOperation || requiredPermissions.get(op).requires_su)) {
		//admins can do (almost) anything through the hole in sheet!
		return null;
	}

	// still here after the su check above but this operation require su, so fail.
	if (!requiredPermissions.get(op)) {
		harperLogger.info(`operation ${op} not found.`);
		//This is here to catch if an operation has not been added to the permissions map above
		throw handleHDBError(new Error(), HDB_ERROR_MSGS.OP_NOT_FOUND(op), HTTP_STATUS_CODES.BAD_REQUEST);
	}

	if (requiredPermissions.get(op) && requiredPermissions.get(op).requires_su) {
		harperLogger.info(`operation ${op} requires SU permissions.`);
		return permsResponse.handleUnauthorizedItem(HDB_ERROR_MSGS.OP_IS_SU_ONLY(op));
	}

	const schemaTableKeys = schemaTableMap.keys();
	for (let schemaTable of schemaTableKeys) {
		//check if schema exists and, if so, if user has DESCRIBE perms
		try {
			if ((schemaTable && !userPerms[schemaTable]) || userPerms[schemaTable][DESCRIBE_PERM] === false) {
				//add schema does not exist error message
				permsResponse.addInvalidItem(HDB_ERROR_MSGS.SCHEMA_NOT_FOUND(schemaTable));
				continue;
			}
		} catch (e) {
			//we should never get here b/c if statement above should catch any possible errors and log the issue to
			// permsResponse but keeping this here just to be safe
			permsResponse.addInvalidItem(HDB_ERROR_MSGS.SCHEMA_NOT_FOUND(schemaTable));
			continue;
		}

		const schemaTableData = schemaTableMap.get(schemaTable);
		for (let table of schemaTableData) {
			const tablePermissions = userPerms[schemaTable].tables[table];

			//if table perms don't exist or DESCRIBE perm set to false, we add an invalid item error to response
			if (!tablePermissions || tablePermissions[DESCRIBE_PERM] === false) {
				permsResponse.addInvalidItem(HDB_ERROR_MSGS.TABLE_NOT_FOUND(schemaTable, table));
			} else {
				try {
					//Here we check all required permissions for the operation defined in the map with the values of the permissions in the role.
					const requiredTablePerms = [];
					let requiredPerms = requiredPermissions.get(op).perms;

					//If an 'action' is included in the operation json, we want to only check permissions for that action
					if (!commonUtils.isEmpty(action) && requiredPerms.includes(action)) {
						requiredPerms = [action];
					}

					for (let i = 0; i < requiredPerms.length; i++) {
						let perm = requiredPerms[i];
						let userPermission = tablePermissions[perm];
						if (userPermission === undefined || userPermission === null || userPermission === false) {
							//need to check if any perm on table OR should return table not found
							harperLogger.info(
								`Required ${perm} permission not found for ${op} ${action ? `${action} ` : ''}operation in role ${
									userObject.role.id
								}`
							);
							requiredTablePerms.push(perm);
						}
					}

					if (requiredTablePerms.length > 0) {
						permsResponse.addUnauthorizedTable(schemaTable, table, requiredTablePerms);
					}
				} catch (e) {
					//if we hit an error here, we need to block operation and return error
					const errMsg = HDB_ERROR_MSGS.UNKNOWN_OP_AUTH_ERROR(op, schemaTable, table);
					harperLogger.error(errMsg);
					harperLogger.error(e);
					throw handleHDBError(hdbErrors.CHECK_LOGS_WRAPPER(errMsg));
				}
			}
		}
	}

	//We need to check if there are multiple schemas in this operation (i.e. SQL cross schema select) and, if so,
	// we continue to check specific attribute perms b/c there may be a mix of perms issues across schema
	if (schemaTableMap.size < 2) {
		return permsResponse.getPermsResponse();
	}
	return null;
}

/**
 * Compare the attributes specified in the call with the user's role.  If there are permissions in the role,
 * ensure that the permission required for the operation matches the permission in the role.
 * @param recordAttributes - An array of the attributes specified in the operation
 * @param roleAttributePermissions - A Map of each permission in the user role, specified as [tableName, [attribute_permissions]].
 * @param operation
 * @param tableName - name of the table being checked
 * @param schemaName - name of schema being checked
 * @param permsResponse - PermissionResponseObject instance being used to track permissions issues to return in response, if necessary
 * @returns {} - this function does not return a value - it updates the permsResponse which is checked later
 */
function checkAttributePerms(
	recordAttributes,
	roleAttributePermissions,
	operation,
	tableName,
	schemaName,
	permsResponse,
	action
) {
	if (!recordAttributes || !roleAttributePermissions) {
		harperLogger.info(`no attributes specified in checkAttributePerms.`);
		throw handleHDBError(new Error());
	}

	// check each attribute with role permissions.  Required perm should match the per in the operation
	let neededPerms = requiredPermissions.get(operation).perms;

	if (!neededPerms || neededPerms === '') {
		// We should never get in here since all of our operations should have a perm, but just in case we should fail
		// any operation that doesn't have perms.
		harperLogger.info(`no permissions found for ${operation} in checkAttributePerms().`);
		throw handleHDBError(new Error());
	}

	//Leave early if the role has no attribute permissions set
	if (commonUtils.isEmptyOrZeroLength(roleAttributePermissions)) {
		harperLogger.info(`No role permissions set (this is OK).`);
		return null;
	}

	//If an 'action' is included in the operation json, we want to only check permissions for that action
	if (action && neededPerms.includes(action)) {
		neededPerms = [action];
	}

	let requiredAttrPerms = {};
	// Check if each specified attribute in the call (recordAttributes) has a permission specified in the role.  If there is
	// a permission, check if the operation permission is false.
	for (let element of recordAttributes) {
		const permission = roleAttributePermissions.get(element);
		if (permission) {
			if (permission[DESCRIBE_PERM] === false) {
				permsResponse.addInvalidItem(
					HDB_ERROR_MSGS.ATTR_NOT_FOUND(schemaName, tableName, element),
					schemaName,
					tableName
				);
				continue;
			}
			if (neededPerms) {
				for (let perm of neededPerms) {
					if (terms.TIME_STAMP_NAMES.includes(permission.attribute_name) && perm !== READ_PERM) {
						throw handleHDBError(new Error(), HDB_ERROR_MSGS.SYSTEM_TIMESTAMP_PERMS_ERR, HTTP_STATUS_CODES.FORBIDDEN);
					}
					if (permission[perm] === false) {
						if (!requiredAttrPerms[permission.attribute_name]) {
							requiredAttrPerms[permission.attribute_name] = [perm];
						} else {
							requiredAttrPerms[permission.attribute_name].push(perm);
						}
					}
				}
			}
		} else {
			//if we get here, it means that this is a new attribute and, because there are attr-level perms set, the role
			// does not have permission to do anything with it b/c all perms will be set to FALSE by default
			permsResponse.addInvalidItem(
				HDB_ERROR_MSGS.ATTR_NOT_FOUND(schemaName, tableName, element),
				schemaName,
				tableName
			);
		}
	}

	const unauthorizedTableAttributes = Object.keys(requiredAttrPerms);

	if (unauthorizedTableAttributes.length > 0) {
		permsResponse.addUnauthorizedAttributes(unauthorizedTableAttributes, schemaName, tableName, requiredAttrPerms);
	}
}

/**
 * Pull the table attributes specified in the statement.  Will always return a Set, even if empty or on error.
 * @param json - json containing the request
 * @returns {Set} - all attributes affected by the request statement.
 */
function getRecordAttributes(json) {
	let affectedAttributes = new Set();
	try {
		//Bulk load operations need to have attr-level permissions checked during the validateChunk step of the operation
		// in the bulkLoad.js methods
		if (json.action) {
			return affectedAttributes;
		}
		if (json.operation === terms.OPERATIONS_ENUM.SEARCH_BY_CONDITIONS) {
			json.conditions.forEach((condition) => {
				let attribute = condition.attribute;
				if (condition.search_attribute !== undefined) {
					attribute = condition.search_attribute;
				}
				affectedAttributes.add(attribute);
			});
		}

		if (json && (json.attribute || json.search_attribute)) {
			let attribute = json.attribute;
			if (json.search_attribute !== undefined) {
				attribute = json.search_attribute;
			}
			affectedAttributes.add(attribute);
		}

		if (!json.records || json.records.length === 0) {
			if (!json.get_attributes || json.get_attributes.length === 0) {
				return affectedAttributes;
			}

			for (const attr of json.get_attributes) {
				affectedAttributes.add(attr);
			}
		} else {
			// get unique affectedAttributes
			for (const record of json.records) {
				let keys = Object.keys(record);
				for (const key of keys) {
					affectedAttributes.add(key);
				}
			}
		}
	} catch (err) {
		harperLogger.info(err);
	}
	return affectedAttributes;
}

/**
 * Pull the attribute permissions for the schema/table.  Will always return a map, even empty or on error.
 * @param jsonHdbUser - The hdb_user from the json request body
 * @param operationSchema - The schema specified in the request
 * @param table - The table specified.
 * @returns {Map} A Map of attribute permissions of the form [attribute_name, attributePermission];
 */
function getAttributePermissions(rolePerms, operationSchema, table) {
	let roleAttributePermissions = new Map();
	if (commonUtils.isEmpty(rolePerms)) {
		harperLogger.info(`no hdb_user specified in getAttributePermissions`);
		return roleAttributePermissions;
	}
	if (rolePerms.super_user) {
		return roleAttributePermissions;
	}
	//Some commands do not require a table to be specified.  If there is no table, there is likely not
	// anything attribute permissions needs to check.
	if (!operationSchema || !table) {
		return roleAttributePermissions;
	}
	try {
		rolePerms[operationSchema].tables[table].attribute_permissions.forEach((perm) => {
			if (!roleAttributePermissions.has(perm.attribute_name)) {
				roleAttributePermissions.set(perm.attribute_name, perm);
			}
		});
	} catch (e) {
		harperLogger.info(`No attribute permissions found for schema ${operationSchema} and table ${table}.`);
	}
	return roleAttributePermissions;
}

function verifyBulkLoadAttributePerms(
	rolePerms,
	op,
	action,
	operationSchema,
	operationTable,
	attributes,
	permsResponse
) {
	const recordAttrs = new Set(attributes);
	const attrPermissions = getAttributePermissions(rolePerms, operationSchema, operationTable);
	checkAttributePerms(recordAttrs, attrPermissions, op, operationTable, operationSchema, permsResponse, action);
}
