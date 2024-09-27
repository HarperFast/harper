'use strict';
/**
 * This module is used before a SQL or NoSQL operation is performed in order to ensure the user's assigned role
 * has the permissions and lack of restrictions needed to process the operation.  Only verifyPerms and verifyPermsAST
 * should be outward facing functions.
 *
 * verifyPerms() should be used to check permissions for NoSQL calls.  verifyPermsAST() should be used to check permissions
 * for SQL calls.
 *
 * The required_permissions member contains the permissions needed for each operation.  Any new operations added to
 * Harper need to have operations specified in here or they will never pass the permissions checks.
 * */
const write = require('../dataLayer/insert');
const search = require('../dataLayer/search');
const schema = require('../dataLayer/schema');
const schema_describe = require('../dataLayer/schemaDescribe');
const delete_ = require('../dataLayer/delete');
const read_audit_log = require('../dataLayer/readAuditLog');
const get_backup = require('../dataLayer/getBackup');
const user = require('../security/user');
const role = require('../security/role');
const harper_logger = require('../utility/logging/harper_logger');
const read_log = require('../utility/logging/readLog');
const add_node = require('../utility/clustering/addNode');
const update_node = require('../utility/clustering/updateNode');
const remove_node = require('../utility/clustering/removeNode');
const configure_cluster = require('../utility/clustering/configureCluster');
const purge_stream = require('../utility/clustering/purgeStream');
const cluster_status = require('../utility/clustering/clusterStatus');
const cluster_network = require('../utility/clustering/clusterNetwork');
const routes = require('../utility/clustering/routes');
const common_utils = require('./common_utils');
const bucket = require('../sqlTranslator/sql_statement_bucket');
const reg = require('./registration/registrationHandler');
const restart = require('../bin/restart');
const terms = require('./hdbTerms');
const permsTranslator = require('../security/permissionsTranslator');
const system_information = require('../utility/environment/systemInformation');
const token_authentication = require('../security/tokenAuthentication');
const auth = require('../security/auth');
const config_utils = require('../config/configUtils');
const functions_operations = require('../components/operations');
const alasql = require('alasql');
const transaction_log = require('../utility/logging/transactionLog');
const npm_utilities = require('./npmUtilities');

const PermissionResponseObject = require('../security/data_objects/PermissionResponseObject');
const { handleHDBError, hdb_errors } = require('../utility/errors/hdbError');
const { HDB_ERROR_MSGS, HTTP_STATUS_CODES } = hdb_errors;

const required_permissions = new Map();
const DELETE_PERM = 'delete';
const INSERT_PERM = 'insert';
const READ_PERM = 'read';
const UPDATE_PERM = 'update';
const DESCRIBE_PERM = 'describe';

const UPSERT_OP = 'upsert';

const DESCRIBE_SCHEMA_KEY = schema_describe.describeSchema.name;
const DESCRIBE_TABLE_KEY = schema_describe.describeTable.name;
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
	constructor(requires_su, perms) {
		this.requires_su = requires_su;
		this.perms = perms;
	}
}

required_permissions.set(write.insert.name, new permission(false, [INSERT_PERM]));
required_permissions.set(write.update.name, new permission(false, [UPDATE_PERM]));
required_permissions.set(write.upsert.name, new permission(false, [INSERT_PERM, UPDATE_PERM]));
required_permissions.set(search.searchByConditions.name, new permission(false, [READ_PERM]));
required_permissions.set(search.searchByHash.name, new permission(false, [READ_PERM]));
required_permissions.set(search.searchByValue.name, new permission(false, [READ_PERM]));
required_permissions.set(search.search.name, new permission(false, [READ_PERM]));
required_permissions.set(schema.createSchema.name, new permission(true, []));
required_permissions.set(schema.createTable.name, new permission(true, []));
required_permissions.set(schema.createAttribute.name, new permission(false, [INSERT_PERM]));
required_permissions.set(schema.dropSchema.name, new permission(true, []));
required_permissions.set(schema.dropTable.name, new permission(true, []));
required_permissions.set(schema.dropAttribute.name, new permission(true, []));
required_permissions.set(schema_describe.describeSchema.name, new permission(false, [READ_PERM]));
required_permissions.set(schema_describe.describeTable.name, new permission(false, [READ_PERM]));
required_permissions.set(delete_.deleteRecord.name, new permission(false, [DELETE_PERM]));
required_permissions.set(user.addUser.name, new permission(true, []));
required_permissions.set(user.alterUser.name, new permission(true, []));
required_permissions.set(user.dropUser.name, new permission(true, []));
required_permissions.set(user.listUsersExternal.name, new permission(true, []));
required_permissions.set(role.listRoles.name, new permission(true, []));
required_permissions.set(role.addRole.name, new permission(true, []));
required_permissions.set(role.alterRole.name, new permission(true, []));
required_permissions.set(role.dropRole.name, new permission(true, []));
required_permissions.set(read_log.name, new permission(true, []));
required_permissions.set(add_node.name, new permission(true, []));
required_permissions.set(update_node.name, new permission(true, []));
required_permissions.set(remove_node.name, new permission(true, []));
required_permissions.set(configure_cluster.name, new permission(true, []));
required_permissions.set(purge_stream.name, new permission(true, []));
required_permissions.set(routes.setRoutes.name, new permission(true, []));
required_permissions.set(routes.getRoutes.name, new permission(true, []));
required_permissions.set(routes.deleteRoutes.name, new permission(true, []));
required_permissions.set(config_utils.setConfiguration.name, new permission(true, []));
required_permissions.set(cluster_status.clusterStatus.name, new permission(true, []));
required_permissions.set(cluster_network.name, new permission(true, []));
required_permissions.set(reg.getFingerprint.name, new permission(true, []));
required_permissions.set(reg.setLicense.name, new permission(true, []));
required_permissions.set(delete_.deleteFilesBefore.name, new permission(true, []));
required_permissions.set(delete_.deleteAuditLogsBefore.name, new permission(true, []));
required_permissions.set(restart.restart.name, new permission(true, []));
required_permissions.set(restart.restartService.name, new permission(true, []));
required_permissions.set(read_audit_log.name, new permission(true, []));
required_permissions.set(get_backup.name, new permission(true, [READ_PERM]));
required_permissions.set(system_information.systemInformation.name, new permission(true, []));
required_permissions.set(config_utils.getConfiguration.name, new permission(true, []));
required_permissions.set(transaction_log.readTransactionLog.name, new permission(true, []));
required_permissions.set(transaction_log.deleteTransactionLogsBefore.name, new permission(true, []));
required_permissions.set(npm_utilities.installModules.name, new permission(true, []));
required_permissions.set(npm_utilities.auditModules.name, new permission(true, []));

//this operation must be available to all users so they can create authentication tokens and login
required_permissions.set(token_authentication.createTokens.name, new permission(false, []));
required_permissions.set(token_authentication.refreshOperationToken.name, new permission(false, []));
required_permissions.set(auth.login.name, new permission(false, []));
required_permissions.set(auth.logout.name, new permission(false, []));

//Operations specific to HDB Functions
required_permissions.set(functions_operations.customFunctionsStatus.name, new permission(true, []));
required_permissions.set(functions_operations.getCustomFunctions.name, new permission(true, []));
required_permissions.set(functions_operations.getComponents.name, new permission(true, []));
required_permissions.set(functions_operations.getComponentFile.name, new permission(true, []));
required_permissions.set(functions_operations.setComponentFile.name, new permission(true, []));
required_permissions.set(functions_operations.dropComponent.name, new permission(true, []));
required_permissions.set(functions_operations.getCustomFunction.name, new permission(true, []));
required_permissions.set(functions_operations.setCustomFunction.name, new permission(true, []));
required_permissions.set(functions_operations.dropCustomFunction.name, new permission(true, []));
required_permissions.set(functions_operations.addComponent.name, new permission(true, []));
required_permissions.set(functions_operations.dropCustomFunctionProject.name, new permission(true, []));
required_permissions.set(functions_operations.packageComponent.name, new permission(true, []));
required_permissions.set(functions_operations.deployComponent.name, new permission(true, []));

//Below are functions that are currently open to all roles
required_permissions.set(reg.getRegistrationInfo.name, new permission(false, []));
required_permissions.set(user.userInfo.name, new permission(false, []));
//Describe_all will only return the schema values a user has permissions for
required_permissions.set(schema_describe.describeAll.name, new permission(false, []));

//Below function names are hardcoded b/c of circular dependency issues
required_permissions.set(HANDLE_GET_JOB, new permission(false, []));
required_permissions.set(HANDLE_GET_JOB_BY_START_DATE, new permission(true, []));
required_permissions.set(CATCHUP, new permission(true, []));
required_permissions.set(BULK_OPS.CSV_DATA_LOAD, new permission(false, [INSERT_PERM, UPDATE_PERM]));
required_permissions.set(BULK_OPS.CSV_URL_LOAD, new permission(false, [INSERT_PERM, UPDATE_PERM]));
required_permissions.set(BULK_OPS.CSV_FILE_LOAD, new permission(false, [INSERT_PERM, UPDATE_PERM]));
required_permissions.set(BULK_OPS.IMPORT_FROM_S3, new permission(false, [INSERT_PERM, UPDATE_PERM]));
required_permissions.set(DATA_EXPORT.EXPORT_TO_S3, new permission(true, []));
required_permissions.set(DATA_EXPORT.EXPORT_LOCAL, new permission(true, []));

//NOTE: 'registration_info' and 'user_info' operations are intentionally left off here since both should be accessible
// for all roles/users no matter what their permissions are

// SQL operations are distinct from operations above, so we need to store required perms for both.
required_permissions.set(terms.VALID_SQL_OPS_ENUM.DELETE, new permission(false, [DELETE_PERM]));
required_permissions.set(terms.VALID_SQL_OPS_ENUM.SELECT, new permission(false, [READ_PERM]));
required_permissions.set(terms.VALID_SQL_OPS_ENUM.INSERT, new permission(false, [INSERT_PERM]));
required_permissions.set(terms.VALID_SQL_OPS_ENUM.UPDATE, new permission(false, [UPDATE_PERM]));

module.exports = {
	verifyPerms,
	verifyPermsAst,
	verifyBulkLoadAttributePerms,
};

/**
 * Verifies permissions and restrictions for a SQL operation based on the user's assigned role.
 * @param ast - The SQL statement in Syntax Tree form.
 * @param user_object - The user and role specification
 * @param operation - The operation specified in the call.
 * @returns {null | PermissionResponseObject} - null if permissions match, errors returned in the PermissionResponseObject
 */
function verifyPermsAst(ast, user_object, operation) {
	//TODO - update these validation checks to use validate.js
	if (common_utils.isEmptyOrZeroLength(ast)) {
		harper_logger.info('verify_perms_ast has an empty user parameter');
		throw handleHDBError(new Error());
	}
	if (common_utils.isEmptyOrZeroLength(user_object)) {
		harper_logger.info('verify_perms_ast has an empty user parameter');
		throw handleHDBError(new Error());
	}
	if (common_utils.isEmptyOrZeroLength(operation)) {
		harper_logger.info('verify_perms_ast has a null operation parameter');
		throw handleHDBError(new Error());
	}
	try {
		const permsResponse = new PermissionResponseObject();
		let parsed_ast = new bucket(ast);
		let schemas = parsed_ast.getSchemas();
		let schema_table_map = new Map();

		// Should not continue if there are no schemas defined and there are table columns defined.
		// This is defined so we can do calc selects like : SELECT ABS(-12)
		if (
			(!schemas || schemas.length === 0) &&
			parsed_ast.affected_attributes &&
			parsed_ast.affected_attributes.size > 0
		) {
			harper_logger.info(`No schemas defined in verifyPermsAst(), will not continue.`);
			throw handleHDBError(new Error());
		}
		// set to true if this operation affects a system table.  Only su can read from system tables, but can't update/delete.
		const is_super_user = !!user_object.role.permission.super_user;
		const is_su_system_operation = schemas.includes('system');

		if (is_su_system_operation && FORBIDDEN_SYSTEM_OPS_ENUM[operation]) {
			throw handleHDBError(new Error(), HDB_ERROR_MSGS.DROP_SYSTEM, HTTP_STATUS_CODES.FORBIDDEN);
		}

		if (is_super_user && !is_su_system_operation) {
			//admins can do (almost) anything through the hole in sheet!
			return null;
		}

		const full_role_perms = permsTranslator.getRolePermissions(user_object.role);
		user_object.role.permission = full_role_perms;

		//If the AST is for a SELECT, we need to check for wildcards and, if they exist, update the AST to include the
		// attributes that the user has READ perms for - we can skip this step for super users
		if (!is_super_user && ast instanceof alasql.yy.Select) {
			ast = parsed_ast.updateAttributeWildcardsForRolePerms(full_role_perms);
		}

		for (let s = 0; s < schemas.length; s++) {
			//NOSONAR
			let tables = parsed_ast.getTablesBySchemaName(schemas[s]);
			if (tables) {
				schema_table_map.set(schemas[s], tables);
			}
		}

		let table_perm_restriction = hasPermissions(user_object, operation, schema_table_map, permsResponse); //NOSONAR;
		if (table_perm_restriction) {
			return table_perm_restriction;
		}

		schema_table_map.forEach((tables, schema_key) => {
			for (let t = 0; t < tables.length; t++) {
				let attributes = parsed_ast.getAttributesBySchemaTableName(schema_key, tables[t]);
				const attribute_permissions = getAttributePermissions(user_object.role.permission, schema_key, tables[t]);
				checkAttributePerms(attributes, attribute_permissions, operation, tables[t], schema_key, permsResponse);
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
 * @param request_json - The request body as json
 * @param operation - The name of the operation specified in the request.
 * @returns { null | PermissionResponseObject } - null if permissions match, errors are consolidated into PermissionResponseObj.
 */
function verifyPerms(request_json, operation) {
	if (
		request_json === null ||
		operation === null ||
		request_json.hdb_user === undefined ||
		request_json.hdb_user === null
	) {
		harper_logger.info(`null required parameter in verifyPerms`);
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
	let action = request_json.action;

	let operation_schema = request_json.schema ?? request_json.database;
	let table = request_json.table;

	let schema_table_map = new Map();
	if (operation_schema && table) {
		schema_table_map.set(operation_schema, [table]);
	}

	const permsResponse = new PermissionResponseObject();

	if (
		common_utils.isEmptyOrZeroLength(request_json.hdb_user?.role) ||
		common_utils.isEmptyOrZeroLength(request_json.hdb_user?.role?.permission)
	) {
		harper_logger.info(
			`User ${request_json.hdb_user?.username} has no role or permissions.  Please assign the user a valid role.`
		);
		return permsResponse.handleUnauthorizedItem(HDB_ERROR_MSGS.USER_HAS_NO_PERMS(request_json.hdb_user?.username));
	}

	const is_super_user = !!request_json.hdb_user?.role?.permission?.super_user;
	const structure_user = request_json.hdb_user?.role?.permission?.structure_user;
	// set to true if this operation affects a system table.  Only su can read from system tables, but can't update/delete.
	let is_su_system_operation =
		schema_table_map.has(terms.SYSTEM_SCHEMA_NAME) || operation_schema === terms.SYSTEM_SCHEMA_NAME;

	if (is_su_system_operation && FORBIDDEN_SYSTEM_OPS_ENUM[op]) {
		throw handleHDBError(new Error(), HDB_ERROR_MSGS.DROP_SYSTEM, HTTP_STATUS_CODES.FORBIDDEN);
	}

	if (is_super_user && !is_su_system_operation) {
		//admins can do (almost) anything
		return null;
	}

	//structure_users can create/drop schemas if they are not locked down to specific schemas.
	if (structure_user === true && (op === schema.createSchema.name || op === schema.dropSchema.name)) {
		return null;
	}

	//check if this is a structure_user & trying to perform a structure user op
	if (STRUCTURE_USER_OPS.indexOf(op) >= 0 && (structure_user === true || Array.isArray(structure_user))) {
		//if true can perform op all schemas
		if (structure_user === true) {
			return null;
		}

		//if the structure_user value is an array and contains the operation schema, all good
		if (structure_user.indexOf(operation_schema) >= 0) {
			return null;
		}

		//if we get here then error out
		return permsResponse.handleUnauthorizedItem(
			`User does not have access to perform '${request_json.operation}' against schema '${operation_schema}'`
		);
	}

	const full_role_perms = permsTranslator.getRolePermissions(request_json.hdb_user?.role);
	if (request_json.hdb_user?.role) request_json.hdb_user.role.permission = full_role_perms;

	//check if user is trying to describe a system table and, if so, return schema perm error
	if (op === DESCRIBE_SCHEMA_KEY || op === DESCRIBE_TABLE_KEY) {
		if (operation_schema === terms.SYSTEM_SCHEMA_NAME) {
			return permsResponse.handleUnauthorizedItem(HDB_ERROR_MSGS.SCHEMA_PERM_ERROR(operation_schema));
		}

		if (!full_role_perms.super_user) {
			// eslint-disable-next-line radar/no-collapsible-if
			if (op === DESCRIBE_SCHEMA_KEY) {
				if (!full_role_perms[operation_schema] || !full_role_perms[operation_schema][DESCRIBE_PERM]) {
					return permsResponse.handleInvalidItem(HDB_ERROR_MSGS.SCHEMA_NOT_FOUND(operation_schema));
				}
			}

			if (
				op === DESCRIBE_TABLE_KEY &&
				(!full_role_perms[operation_schema] ||
					!full_role_perms[operation_schema].tables[table] ||
					!full_role_perms[operation_schema].tables[table][DESCRIBE_PERM])
			) {
				return permsResponse.handleInvalidItem(HDB_ERROR_MSGS.TABLE_NOT_FOUND(operation_schema, table));
			}
		}
	}

	let failed_permissions = hasPermissions(request_json.hdb_user, op, schema_table_map, permsResponse, action);
	//check if failed_table_perms are back and return them B/C it will be an op-level permission issue
	if (failed_permissions) {
		return failed_permissions;
	}

	if (required_permissions.get(op) && required_permissions.get(op).perms.length === 0) {
		return null;
	}

	//For a NoSQL search op with `get_attributes: '*'` - as long as the role has READ permissions on the table,
	//we will convert the * to the specific attributes the user has READ permissions for via their role.
	if (
		!is_super_user &&
		request_json.get_attributes &&
		terms.SEARCH_WILDCARDS.includes(request_json.get_attributes[0])
	) {
		let final_get_attrs = [];
		const table_perms = full_role_perms[operation_schema].tables[table];

		if (table_perms[terms.PERMS_CRUD_ENUM.READ]) {
			if (table_perms.attribute_permissions.length > 0) {
				const table_attr_perms = table_perms.attribute_permissions.filter((perm) => perm[terms.PERMS_CRUD_ENUM.READ]);
				table_attr_perms.forEach((perm) => {
					final_get_attrs.push(perm.attribute_name);
				});
			} else {
				final_get_attrs = global.hdb_schema[operation_schema][table].attributes.map((obj) => obj.attribute);
			}

			request_json.get_attributes = final_get_attrs;
		}
	}

	const record_attrs = getRecordAttributes(request_json);
	const attr_permissions = getAttributePermissions(request_json.hdb_user?.role?.permission, operation_schema, table);
	checkAttributePerms(record_attrs, attr_permissions, op, table, operation_schema, permsResponse, action);

	//This result value will be null if no perms issues were found in checkAttributePerms
	return permsResponse.getPermsResponse();
}

/**
 * Checks if the user's role has the required permissions for the operation specified.
 * @param user_object - the hdb_user specified in the request body
 * @param op - the name of the operation
 * @param schema_table_map - A map in the format [schema_key, [tables]].
 * @returns {PermissionResponseObject | null} - null value if permissions match, PermissionResponseObject if not.
 */
function hasPermissions(user_object, op, schema_table_map, permsResponse, action) {
	if (common_utils.arrayHasEmptyValues([user_object, op, schema_table_map])) {
		harper_logger.info(`hasPermissions has an invalid parameter`);
		throw handleHDBError(new Error());
	}
	// set to true if this operation affects a system table.  Only su can read from system tables, but can't update/delete.
	let is_su_system_operation = schema_table_map.has('system');
	const user_perms = user_object.role.permission;
	if (user_perms.super_user && (!is_su_system_operation || required_permissions.get(op).requires_su)) {
		//admins can do (almost) anything through the hole in sheet!
		return null;
	}

	// still here after the su check above but this operation require su, so fail.
	if (!required_permissions.get(op)) {
		harper_logger.info(`operation ${op} not found.`);
		//This is here to catch if an operation has not been added to the permissions map above
		throw handleHDBError(new Error(), HDB_ERROR_MSGS.OP_NOT_FOUND(op), HTTP_STATUS_CODES.BAD_REQUEST);
	}

	if (required_permissions.get(op) && required_permissions.get(op).requires_su) {
		harper_logger.info(`operation ${op} requires SU permissions.`);
		return permsResponse.handleUnauthorizedItem(HDB_ERROR_MSGS.OP_IS_SU_ONLY(op));
	}

	const schema_table_keys = schema_table_map.keys();
	for (let schema_table of schema_table_keys) {
		//check if schema exists and, if so, if user has DESCRIBE perms
		try {
			if ((schema_table && !user_perms[schema_table]) || user_perms[schema_table][DESCRIBE_PERM] === false) {
				//add schema does not exist error message
				permsResponse.addInvalidItem(HDB_ERROR_MSGS.SCHEMA_NOT_FOUND(schema_table));
				continue;
			}
		} catch (e) {
			//we should never get here b/c if statement above should catch any possible errors and log the issue to
			// permsResponse but keeping this here just to be safe
			permsResponse.addInvalidItem(HDB_ERROR_MSGS.SCHEMA_NOT_FOUND(schema_table));
			continue;
		}

		const schema_table_data = schema_table_map.get(schema_table);
		for (let table of schema_table_data) {
			const table_permissions = user_perms[schema_table].tables[table];

			//if table perms don't exist or DESCRIBE perm set to false, we add an invalid item error to response
			if (!table_permissions || table_permissions[DESCRIBE_PERM] === false) {
				permsResponse.addInvalidItem(HDB_ERROR_MSGS.TABLE_NOT_FOUND(schema_table, table));
			} else {
				try {
					//Here we check all required permissions for the operation defined in the map with the values of the permissions in the role.
					const required_table_perms = [];
					let required_perms = required_permissions.get(op).perms;

					//If an 'action' is included in the operation json, we want to only check permissions for that action
					if (!common_utils.isEmpty(action) && required_perms.includes(action)) {
						required_perms = [action];
					}

					for (let i = 0; i < required_perms.length; i++) {
						let perm = required_perms[i];
						let user_permission = table_permissions[perm];
						if (user_permission === undefined || user_permission === null || user_permission === false) {
							//need to check if any perm on table OR should return table not found
							harper_logger.info(
								`Required ${perm} permission not found for ${op} ${action ? `${action} ` : ''}operation in role ${
									user_object.role.id
								}`
							);
							required_table_perms.push(perm);
						}
					}

					if (required_table_perms.length > 0) {
						permsResponse.addUnauthorizedTable(schema_table, table, required_table_perms);
					}
				} catch (e) {
					//if we hit an error here, we need to block operation and return error
					const err_msg = HDB_ERROR_MSGS.UNKNOWN_OP_AUTH_ERROR(op, schema_table, table);
					harper_logger.error(err_msg);
					harper_logger.error(e);
					throw handleHDBError(hdb_errors.CHECK_LOGS_WRAPPER(err_msg));
				}
			}
		}
	}

	//We need to check if there are multiple schemas in this operation (i.e. SQL cross schema select) and, if so,
	// we continue to check specific attribute perms b/c there may be a mix of perms issues across schema
	if (schema_table_map.size < 2) {
		return permsResponse.getPermsResponse();
	}
	return null;
}

/**
 * Compare the attributes specified in the call with the user's role.  If there are permissions in the role,
 * ensure that the permission required for the operation matches the permission in the role.
 * @param record_attributes - An array of the attributes specified in the operation
 * @param role_attribute_permissions - A Map of each permission in the user role, specified as [table_name, [attribute_permissions]].
 * @param operation
 * @param table_name - name of the table being checked
 * @param schema_name - name of schema being checked
 * @param permsResponse - PermissionResponseObject instance being used to track permissions issues to return in response, if necessary
 * @returns {} - this function does not return a value - it updates the permsResponse which is checked later
 */
function checkAttributePerms(
	record_attributes,
	role_attribute_permissions,
	operation,
	table_name,
	schema_name,
	permsResponse,
	action
) {
	if (!record_attributes || !role_attribute_permissions) {
		harper_logger.info(`no attributes specified in checkAttributePerms.`);
		throw handleHDBError(new Error());
	}

	// check each attribute with role permissions.  Required perm should match the per in the operation
	let needed_perms = required_permissions.get(operation).perms;

	if (!needed_perms || needed_perms === '') {
		// We should never get in here since all of our operations should have a perm, but just in case we should fail
		// any operation that doesn't have perms.
		harper_logger.info(`no permissions found for ${operation} in checkAttributePerms().`);
		throw handleHDBError(new Error());
	}

	//Leave early if the role has no attribute permissions set
	if (common_utils.isEmptyOrZeroLength(role_attribute_permissions)) {
		harper_logger.info(`No role permissions set (this is OK).`);
		return null;
	}

	//If an 'action' is included in the operation json, we want to only check permissions for that action
	if (action && needed_perms.includes(action)) {
		needed_perms = [action];
	}

	let required_attr_perms = {};
	// Check if each specified attribute in the call (record_attributes) has a permission specified in the role.  If there is
	// a permission, check if the operation permission is false.
	for (let element of record_attributes) {
		const permission = role_attribute_permissions.get(element);
		if (permission) {
			if (permission[DESCRIBE_PERM] === false) {
				permsResponse.addInvalidItem(
					HDB_ERROR_MSGS.ATTR_NOT_FOUND(schema_name, table_name, element),
					schema_name,
					table_name
				);
				continue;
			}
			if (needed_perms) {
				for (let perm of needed_perms) {
					if (terms.TIME_STAMP_NAMES.includes(permission.attribute_name) && perm !== READ_PERM) {
						throw handleHDBError(new Error(), HDB_ERROR_MSGS.SYSTEM_TIMESTAMP_PERMS_ERR, HTTP_STATUS_CODES.FORBIDDEN);
					}
					if (permission[perm] === false) {
						if (!required_attr_perms[permission.attribute_name]) {
							required_attr_perms[permission.attribute_name] = [perm];
						} else {
							required_attr_perms[permission.attribute_name].push(perm);
						}
					}
				}
			}
		} else {
			//if we get here, it means that this is a new attribute and, because there are attr-level perms set, the role
			// does not have permission to do anything with it b/c all perms will be set to FALSE by default
			permsResponse.addInvalidItem(
				HDB_ERROR_MSGS.ATTR_NOT_FOUND(schema_name, table_name, element),
				schema_name,
				table_name
			);
		}
	}

	const unauthorized_table_attributes = Object.keys(required_attr_perms);

	if (unauthorized_table_attributes.length > 0) {
		permsResponse.addUnauthorizedAttributes(
			unauthorized_table_attributes,
			schema_name,
			table_name,
			required_attr_perms
		);
	}
}

/**
 * Pull the table attributes specified in the statement.  Will always return a Set, even if empty or on error.
 * @param json - json containing the request
 * @returns {Set} - all attributes affected by the request statement.
 */
function getRecordAttributes(json) {
	let affected_attributes = new Set();
	try {
		//Bulk load operations need to have attr-level permissions checked during the validateChunk step of the operation
		// in the bulkLoad.js methods
		if (json.action) {
			return affected_attributes;
		}
		if (json.operation === terms.OPERATIONS_ENUM.SEARCH_BY_CONDITIONS) {
			json.conditions.forEach((condition) => {
				affected_attributes.add(condition.search_attribute);
			});
		}

		if (json && json.search_attribute) {
			affected_attributes.add(json.search_attribute);
		}

		if (!json.records || json.records.length === 0) {
			if (!json.get_attributes || !json.get_attributes.length === 0) {
				return affected_attributes;
			}

			for (let record = 0; record < json.get_attributes.length; record++) {
				affected_attributes.add(json.get_attributes[record]);
			}
		} else {
			// get unique affected_attributes
			for (let record = 0; record < json.records.length; record++) {
				let keys = Object.keys(json.records[record]);
				for (let att = 0; att < keys.length; att++) {
					affected_attributes.add(keys[att]);
				}
			}
		}
	} catch (err) {
		harper_logger.info(err);
	}
	return affected_attributes;
}

/**
 * Pull the attribute permissions for the schema/table.  Will always return a map, even empty or on error.
 * @param json_hdb_user - The hdb_user from the json request body
 * @param operation_schema - The schema specified in the request
 * @param table - The table specified.
 * @returns {Map} A Map of attribute permissions of the form [attribute_name, attribute_permission];
 */
function getAttributePermissions(role_perms, operation_schema, table) {
	let role_attribute_permissions = new Map();
	if (common_utils.isEmpty(role_perms)) {
		harper_logger.info(`no hdb_user specified in getAttributePermissions`);
		return role_attribute_permissions;
	}
	if (role_perms.super_user) {
		return role_attribute_permissions;
	}
	//Some commands do not require a table to be specified.  If there is no table, there is likely not
	// anything attribute permissions needs to check.
	if (!operation_schema || !table) {
		return role_attribute_permissions;
	}
	try {
		role_perms[operation_schema].tables[table].attribute_permissions.forEach((perm) => {
			if (!role_attribute_permissions.has(perm.attribute_name)) {
				role_attribute_permissions.set(perm.attribute_name, perm);
			}
		});
	} catch (e) {
		harper_logger.info(`No attribute permissions found for schema ${operation_schema} and table ${table}.`);
	}
	return role_attribute_permissions;
}

function verifyBulkLoadAttributePerms(
	role_perms,
	op,
	action,
	operation_schema,
	operation_table,
	attributes,
	permsResponse
) {
	const record_attrs = new Set(attributes);
	const attr_permissions = getAttributePermissions(role_perms, operation_schema, operation_table);
	checkAttributePerms(record_attrs, attr_permissions, op, operation_table, operation_schema, permsResponse, action);
}
