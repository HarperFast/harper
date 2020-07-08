"use strict";
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
const write = require('../data_layer/insert');
const search = require('../data_layer/search');
const csv = require('../data_layer/csvBulkLoad');
const schema = require('../data_layer/schema');
const schema_describe = require('../data_layer/schemaDescribe');
const delete_ = require('../data_layer/delete');
const user = require('../security/user');
const role = require('../security/role');
const harper_logger = require('../utility/logging/harper_logger');
const common_utils = require('./common_utils');
const bucket = require('../sqlTranslator/sql_statement_bucket');
const cluster_utilities = require('../server/clustering/clusterUtilities');
const data_export = require('../data_layer/export');
const reg = require('./registration/registrationHandler');
const stop = require('../bin/stop');
const terms = require('./hdbTerms');
const permsTranslator = require('../security/permissionsTranslator');
const { handleHDBError, hdb_errors } = require('../utility/errors/hdbError');
const alasql = require('alasql');

const required_permissions = new Map();
const DELETE_PERM = 'delete';
const INSERT_PERM = 'insert';
const READ_PERM = 'read';
const UPDATE_PERM = 'update';

//SQL operations supported
//The delete (or any other operation) comes through the parser as an operation separate from the delete_.delete opertaion.
// Since we store the required permissions for each operation, we need to store required permissions for the SQL delete o
// peration separate from the delete_.delete operation.
const HANDLE_GET_JOB = 'handleGetJob';
const SQL_CREATE = "create";
const SQL_DROP = 'drop';
const SQL_DELETE = 'delete';
const SQL_SELECT = 'select';
const SQL_INSERT = 'insert';
const SQL_UPDATE = 'update';

const WILDCARD = '*';
// const ERR_PROCESSING = 'There was an error processing your request.  Please check the logs and try again.';

class permission {
    constructor(requires_su, perms) {
        this.requires_su = requires_su;
        this.perms = perms;
    }
}

required_permissions.set(write.insert.name, new permission(false, [INSERT_PERM]));
required_permissions.set(write.update.name, new permission(false, [UPDATE_PERM]));
required_permissions.set(search.searchByHash.name, new permission(false, [READ_PERM]));
required_permissions.set(search.searchByValue.name, new permission(false, [READ_PERM]));
required_permissions.set(search.search.name, new permission(false, [READ_PERM]));
required_permissions.set(csv.csvDataLoad.name, new permission(false, [INSERT_PERM]));
required_permissions.set(csv.csvFileLoad.name, new permission(false, [INSERT_PERM]));
required_permissions.set(csv.csvURLLoad.name, new permission(false, [INSERT_PERM]));
required_permissions.set(schema.createSchema.name, new permission(false, [INSERT_PERM]));
required_permissions.set(schema.createTable.name, new permission(false, [INSERT_PERM]));
required_permissions.set(schema.createAttribute.name, new permission(false, [INSERT_PERM]));
required_permissions.set(schema.dropSchema.name, new permission(false, [DELETE_PERM]));
required_permissions.set(schema.dropTable.name, new permission(false, [DELETE_PERM]));
required_permissions.set(schema_describe.describeSchema.name, new permission(false, [READ_PERM]));
required_permissions.set(schema_describe.describeTable.name, new permission(false, [READ_PERM]));
required_permissions.set(schema_describe.describeAll.name, new permission(false, [READ_PERM]));
required_permissions.set(delete_.delete.name, new permission(false, [DELETE_PERM]));
required_permissions.set(user.addUser.name, new permission(true, []));
required_permissions.set(user.alterUser.name, new permission(true, []));
required_permissions.set(user.dropUser.name, new permission(true, []));
required_permissions.set(user.listUsersExternal.name, new permission(true, []));
required_permissions.set(role.listRoles.name, new permission(true, []));
required_permissions.set(role.addRole.name, new permission(true, []));
required_permissions.set(role.alterRole.name, new permission(true, []));
required_permissions.set(role.dropRole.name, new permission(true, []));
required_permissions.set(user.userInfo.name, new permission(false, []));
required_permissions.set(harper_logger.readLog.name, new permission(true, []));
required_permissions.set(cluster_utilities.addNode.name, new permission(true, []));
required_permissions.set(cluster_utilities.updateNode.name, new permission(true, []));
required_permissions.set(cluster_utilities.removeNode.name, new permission(true, []));
required_permissions.set(cluster_utilities.configureCluster.name, new permission(true, []));
required_permissions.set(cluster_utilities.clusterStatus.name, new permission(true, []));
required_permissions.set(reg.getFingerprint.name, new permission(true, []));
required_permissions.set(reg.setLicense.name, new permission(true, []));
required_permissions.set(data_export.export_to_s3.name, new permission(false, [READ_PERM]));
required_permissions.set(data_export.export_local.name, new permission(false, [READ_PERM]));
required_permissions.set(delete_.deleteFilesBefore.name, new permission(true, []));
required_permissions.set(stop.restartProcesses.name, new permission(true, []));
//This function name is hardcoded b/c of a circular dependency issue
required_permissions.set(HANDLE_GET_JOB, new permission(false, [READ_PERM]));

// SQL operations are distinct from operations above, so we need to store required perms for both.
required_permissions.set(SQL_CREATE, new permission(false, [INSERT_PERM]));
required_permissions.set(SQL_DROP, new permission(false, [DELETE_PERM]));
required_permissions.set(SQL_DELETE, new permission(false, [DELETE_PERM]));
required_permissions.set(SQL_SELECT, new permission(false, [READ_PERM]));
required_permissions.set(SQL_INSERT, new permission(false, [INSERT_PERM]));
required_permissions.set(SQL_UPDATE, new permission(false, [UPDATE_PERM]));

module.exports = {
    verifyPerms,
    verifyPermsAst
};

/**
 * Verifies permissions and restrictions for a SQL operation based on the user's assigned role.
 * @param ast - The SQL statement in Syntax Tree form.
 * @param user_object - The user and role specification
 * @param operation - The operation specified in the call.
 * @returns {Array} - empty array if permissions match, errors are an array of objects.
 */
function verifyPermsAst(ast, user_object, operation) {
    if (common_utils.isEmptyOrZeroLength(ast)) {
        harper_logger.info('verify_perms_ast has an empty user parameter');
        throw new Error(hdb_errors.DEFAULT_ERROR_RESP);
    }
    if (common_utils.isEmptyOrZeroLength(user_object)) {
        harper_logger.info('verify_perms_ast has an empty user parameter');
        throw new Error(hdb_errors.DEFAULT_ERROR_RESP);
    }
    if (common_utils.isEmptyOrZeroLength(operation)) {
        harper_logger.info('verify_perms_ast has a null operation parameter');
        throw new Error(hdb_errors.DEFAULT_ERROR_RESP);
    }
    try {
        let parsed_ast = new bucket(ast);
        let schemas = parsed_ast.getSchemas();
        let schema_table_map = new Map();
        let failed_permission_objects = [];
        // Should not continue if there are no schemas defined and there are table columns defined.
        // This is defined so we can do calc selects like : SELECT ABS(-12)
        if ((!schemas || schemas.length === 0) && (parsed_ast.affected_attributes && parsed_ast.affected_attributes.size > 0)) {
            harper_logger.info(`No schemas defined in verifyPermsAst(), will not continue.`);
            throw new Error(hdb_errors.DEFAULT_ERROR_RESP);
        }
        // set to true if this operation affects a system table.  Only su can read from system tables, but can't update/delete.
        let is_su_system_operation = schemas.includes('system');
        if (user_object.role.permission.super_user && !is_su_system_operation) {
            //admins can do (almost) anything through the hole in sheet!
            return [];
        }

        const full_role_perms = permsTranslator.getRolePermissions(user_object.role);
        user_object.role.permission = full_role_perms;

        //TODO - SAM - add code comment
        if (ast instanceof alasql.yy.Select) {
            const astWildcards = getColumnWildcards(ast);
            if (astWildcards.length > 0) {
                ast = parsed_ast.updateAttributeWildcardsForRolePerms(full_role_perms, astWildcards);
            }
        }

        for (let s = 0; s < schemas.length; s++) { //NOSONAR
            let tables = parsed_ast.getTablesBySchemaName(schemas[s]);
            if(!tables) {
                return [];
            }

            schema_table_map.set(schemas[s], tables);
            let has_permissions = hasPermissions(user_object, operation, schema_table_map); //NOSONAR;
            if(has_permissions && has_permissions.length) {
                has_permissions.forEach((has_perms)=> {
                    let failed_perm_object = new terms.PermissionResponseObject();
                    failed_perm_object.schema = schemas[s];
                    failed_perm_object.table = has_perms.table;
                    has_perms.required_table_permissions.forEach((perm) => {
                        failed_perm_object.required_table_permissions.push(perm);
                    });
                    failed_permission_objects.push(failed_perm_object);
                });
            }

            for (let t = 0; t<tables.length; t++) {
                let attributes = parsed_ast.getAttributesBySchemaTableName(schemas[s], tables[t]);
                const attribute_restrictions = getAttributeRestrictions(user_object, schemas[s],tables[t]);
                let unauthorized_attributes = checkAttributePerms(attributes, attribute_restrictions, operation, tables[t], schemas[s]);
                if (unauthorized_attributes && Object.keys(unauthorized_attributes).length > 0) {
                    for(let failed_perm in unauthorized_attributes) {
                        failed_permission_objects.push(unauthorized_attributes[failed_perm]);
                    }
                }
            }
        }
        return failed_permission_objects;
    } catch(e) {
        harper_logger.info(e);
        throw new Error(hdb_errors.DEFAULT_ERROR_RESP);
    }
}

function getColumnWildcards(ast) {
    return ast.columns.filter(col => terms.SEARCH_WILDCARDS.includes(col.columnid));
}

/**
 * Checks if the user's role has the required permissions for the operation specified.
 * @param user_object - the hdb_user specified in the request body
 * @param op - the name of the operation
 * @param schema_table_map - A map in the format [schema_key, [tables]].
 * @returns {Array} - empty array if permissions match, errors are an array of objects.
 */
function hasPermissions(user_object, op, schema_table_map ) {
    let unauthorized_table = [];
    if (common_utils.arrayHasEmptyOrZeroLengthValues([user_object,op,schema_table_map])) {
        harper_logger.info(`hasPermissions has an invalid parameter`);
        throw new Error(hdb_errors.DEFAULT_ERROR_RESP);
    }
    // set to true if this operation affects a system table.  Only su can read from system tables, but can't update/delete.
    let is_su_system_operation = schema_table_map.has('system');
    if (user_object.role.permission.super_user && !is_su_system_operation) {
         //admins can do (almost) anything through the hole in sheet!
        return unauthorized_table;
    }
    if (!required_permissions.get(op) || (required_permissions.get(op) && required_permissions.get(op).requires_su)) {
        // still here after the su check above but this operation require su, so fail.
        harper_logger.info(`operation ${op} not found or requires SU permissions.`);
        unauthorized_table.push({"operation":op, "requires_su": true});
        return unauthorized_table;
    }
    for (let schema_table of schema_table_map.keys()) {
        for (let table of schema_table_map.get(schema_table)) {
            let table_restrictions = [];
            try {
                table_restrictions = user_object.role.permission[schema_table];
            } catch(e) {
                // no-op, no restrictions is OK;
            }

            if (table_restrictions && table) {
                try {
                    //Here we check all required permissions for the operation defined in the map with the values of the permissions in the role.
                    for (let i = 0; i<required_permissions.get(op).perms.length; i++) {
                        let perms = required_permissions.get(op).perms[i];
                        let user_permission = user_object.role.permission[schema_table].tables[table][perms];
                        if (user_permission === undefined || user_permission === null || user_permission === false) {
                            harper_logger.info(`Required permission not found for operation ${op} in role ${user_object.role.id}`);
                            let failed_table = new terms.PermissionResponseObject();
                            failed_table.schema = schema_table;
                            failed_table.table = table;
                            failed_table.required_table_permissions.push(perms);
                            unauthorized_table.push(failed_table);
                            return unauthorized_table;
                        }
                    }
                } catch(e) {
                    harper_logger.info(e);
                    // If we are here, either there are not any permissions specified for the operation, or the schema/table was not found
                    // In those cases we want to return true, as we assume wide open access unless specified otherwise.
                    return [];
                }
            }
        }
    }
    return unauthorized_table;
}

/**
 * Verifies permissions and restrictions for the NoSQL operation based on the user's assigned role.
 * @param request_json - The request body as json
 * @param operation - The name of the operation specified in the request.
 * @returns {Array} - empty array if permissions match, errors are an array of objects.
 */
function verifyPerms(request_json, operation) {
    if (request_json === null || operation === null || request_json.hdb_user === undefined || request_json.hdb_user === null) {
        harper_logger.info(`null required parameter in verifyPerms`);
        return [{"error": "invalid request"}];
    }

    //passing in the function rather than the function name is an easy mistake to make, so taking care of that case here.
    let op = undefined;
    if (operation instanceof Function) {
        op = operation.name;
    } else {
        op = operation;
    }

    let operation_schema = request_json.schema;
    let table = request_json.table;

    let schema_table_map = new Map();
    schema_table_map.set(operation_schema, [table]);

    if (common_utils.isEmptyOrZeroLength(request_json.hdb_user.role) || common_utils.isEmptyOrZeroLength(request_json.hdb_user.role.permission)) {
        harper_logger.error(`User ${request_json.hdb_user.username }has no role or permissions.  Please assign the user a valid role.`);
        return [{"error": `User ${request_json.hdb_user.username }has no role or permissions.  Please assign the user a valid role.`}];
    }
    const is_super_user = request_json.hdb_user.role.permission.super_user;
    // set to true if this operation affects a system table.  Only su can read from system tables, but can't update/delete.
    let is_su_system_operation = schema_table_map.has(terms.SYSTEM_SCHEMA_NAME);
    if (is_super_user && !is_su_system_operation) {
        //admins can do (almost) anything through the hole in sheet!
        return [];
    }

    const full_role_perms = permsTranslator.getRolePermissions(request_json.hdb_user.role);
    request_json.hdb_user.role.permission = full_role_perms;

    let failed_table_permissions = hasPermissions(request_json.hdb_user, op, schema_table_map);
    if (failed_table_permissions && failed_table_permissions.length > 0) {
        return failed_table_permissions;
    }

    //For a NoSQL search op with `get_attributes: '*'` - as long as the role has permissions READ permissions on the table,
    //we will convert the * to the specific attributes the user has READ permissions for via their role.
    if (!is_super_user && request_json.get_attributes && terms.SEARCH_WILDCARDS.includes(request_json.get_attributes[0])) {
        let final_get_attrs = [];
        const table_attr_perms = full_role_perms[operation_schema].tables[table].attribute_restrictions;
        if (table_attr_perms.length === 0) {
            final_get_attrs = global.hdb_schema[operation_schema][table].attributes;
        }  else {
            table_attr_perms.forEach(perm => {
                if (perm[terms.PERMS_CRUD_ENUM.READ]) {
                    final_get_attrs.push(perm.attribute_name);
                }
            });
        }
        request_json.get_attributes = final_get_attrs;
    }

    const record_attrs = getRecordAttributes(request_json);
    const attr_restrictions = getAttributeRestrictions(request_json.hdb_user, operation_schema, table);
    let unauthorized_attributes = checkAttributePerms(record_attrs, attr_restrictions, op, table, operation_schema);
    if(!common_utils.isEmptyOrZeroLength(unauthorized_attributes)) {
        return unauthorized_attributes;
    }
    // If you get to this point, it means that no restricted schema items have been specifically requested/used in the operation
    return [];
}

/**
 * Compare the attributes specified in the call with the user's role.  If there are restrictions in the role,
 * ensure that the permission required for the operation matches the restriction in the role.
 * @param record_attributes - An array of the attributes specified in the operation
 * @param role_attribute_restrictions - A Map of each restriction in the user role, specified as [table_name, [attribute_restrictions]].
 * @param operation
 * @param table_name - name of the table being checked
 * @param schema_name - name of schema being checked.
 * @returns {Array} - empty array if permissions match, errors are an array of objects.
 */
function checkAttributePerms(record_attributes, role_attribute_restrictions, operation, table_name, schema_name) {
    if (!record_attributes || !role_attribute_restrictions) {
        harper_logger.info(`no attributes specified in checkAttributePerms.`);
        throw new Error(hdb_errors.DEFAULT_ERROR_RESP);
    }
    // check each attribute with role permissions.  Required perm should match the per in the operation
    let needed_perm = required_permissions.get(operation);
    if (!needed_perm || needed_perm === '') {
        // We should never get in here since all of our operations should have a perm, but just in case we should fail
        // any operation that doesn't have perms.
        harper_logger.info(`no permissions found for ${operation} in checkAttributePerms().`);
        throw new Error(hdb_errors.DEFAULT_ERROR_RESP);
    }

    //Leave early if the role has no attribute permissions set
    if (common_utils.isEmptyOrZeroLength(role_attribute_restrictions)) {
        harper_logger.info(`No role restrictions set (this is OK).`);
        return [];
    }
    let unauthorized_attributes_array = [];
    // Check if each specified attribute in the call (record_attributes) has a restriction specified in the role.  If there is
    // a restriction, check if the operation permission/ restriction is false.
    for (let element of record_attributes) {
        let restriction = role_attribute_restrictions.get(element);
        if (restriction && needed_perm.perms) {
            for (let perm of needed_perm.perms) {
                if (restriction[perm] === false) {
                    let failed_perm_object = new terms.PermissionResponseObject();
                    failed_perm_object.table = table_name;
                    failed_perm_object.schema = schema_name;
                    let attribute_object = new terms.PermissionAttributeResponseObject();
                    attribute_object.attribute_name = restriction.attribute_name;
                    attribute_object.required_permissions.push(perm);
                    failed_perm_object.required_attribute_permissions.push(attribute_object);
                    unauthorized_attributes_array.push(failed_perm_object);
                }
            }
        }
    }
    return unauthorized_attributes_array;
}

/**
 * Pull the table attributes specified in the statement.  Will always return a Set, even if empty or on error.
 * @param json - json containing the request
 * @returns {Set} - all attributes affected by the request statement.
 */
function getRecordAttributes(json) {
    let affected_attributes = new Set();
    try {
        if (json && json.search_attribute) {
            affected_attributes.add(json.search_attribute);
        }
        if (!json.records || json.records.length === 0) {
            if (!json.get_attributes || !json.get_attributes.length === 0) {
                return affected_attributes;
            }

            for (let record = 0; record < json.get_attributes.length; record++) {
                if (!affected_attributes.has(json.get_attributes[record])) {
                    affected_attributes.add(json.get_attributes[record]);
                }
            }

        } else {
            // get unique affected_attributes
            for (let record = 0; record < json.records.length; record++) {
                let keys = Object.keys(json.records[record]);
                for (let att = 0; att < keys.length; att++) {
                    if (!affected_attributes.has(keys[att])) {
                        affected_attributes.add(keys[att]);
                    }
                }
            }
        }
    } catch (ex) {
        harper_logger.info(ex);
    }
    return affected_attributes;
}

/**
 * Pull the attribute restrictions for the schema/table.  Will always return a map, even empty or on error.
 * @param json_hdb_user - The hdb_user from the json request body
 * @param operation_schema - The schema specified in the request
 * @param table - The table specified.
 * @returns {Map} A Map of attribute restrictions of the form [attribute_name, attribute_restriction];
 */
function getAttributeRestrictions(json_hdb_user, operation_schema, table) {
    let role_attribute_restrictions = new Map();
    if ( !json_hdb_user || json_hdb_user.length === 0) {
        harper_logger.info(`no hdb_user specified in getAttributeRestrictions`);
        return role_attribute_restrictions;
    }
    if (json_hdb_user.role.permission.super_user) {
        return role_attribute_restrictions;
    }
    //Some commands do not require a table to be specified.  If there is no table, there is likely not
    // anything attribute restrictions needs to check.
    if (!operation_schema || !table) {
        return role_attribute_restrictions;
    }
    try {
        json_hdb_user.role.permission[operation_schema].tables[table].attribute_restrictions.forEach(function (restriction) {
            if (!role_attribute_restrictions.has(restriction.attribute_name)) {
                role_attribute_restrictions.set(restriction.attribute_name, restriction);
            }
        });
    } catch (e) {
        harper_logger.info(`No attribute restrictions found for schema ${operation_schema} and table ${table}.`);
    }
    return role_attribute_restrictions;
}
