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
const delete_ = require('../data_layer/delete');
const user = require('../security/user');
const role = require('../security/role');
const harper_logger = require('../utility/logging/harper_logger');
const common_utils = require('./common_utils.js');
const bucket = require('../sqlTranslator/sql_statement_bucket');
const cluster_utilities = require('../server/clustering/clusterUtilities');
const data_export = require('../data_layer/export');
const reg = require('./registration/registrationHandler');
const stop = require('../bin/stop');

const required_permissions = new Map();
const DELETE_PERM = 'delete';
const INSERT_PERM = 'insert';
const READ_PERM = 'read';
const UPDATE_PERM = 'update';

//SQL operations supported
//The delete (or any other operation) comes through the parser as an operation separate from the delete_.delete opertaion.
// Since we store the required permissions for each operation, we need to store required permissions for the SQL delete o
// peration separate from the delete_.delete operation.
const SQL_CREATE = "create";
const SQL_DROP = 'drop';
const SQL_DELETE = 'delete';
const SQL_SELECT = 'select';
const SQL_INSERT = 'insert';
const SQL_UPDATE = 'update';

const WILDCARD = '*';
const ERR_PROCESSING = 'There was an error processing your request.  Please check the logs and try again.';

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
required_permissions.set(schema.describeSchema.name, new permission(false, [READ_PERM]));
required_permissions.set(schema.describeTable.name, new permission(false, [READ_PERM]));
required_permissions.set(schema.describeAll.name, new permission(false, [READ_PERM]));
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
required_permissions.set(cluster_utilities.removeNode.name, new permission(true, []));
required_permissions.set(cluster_utilities.configureCluster.name, new permission(true, []));
required_permissions.set(cluster_utilities.clusterStatus.name, new permission(true, []));
required_permissions.set(reg.getFingerprint.name, new permission(true, []));
required_permissions.set(reg.setLicense.name, new permission(true, []));
required_permissions.set(data_export.export_to_s3.name, new permission(false, [READ_PERM]));
required_permissions.set(data_export.export_local.name, new permission(false, [READ_PERM]));
required_permissions.set(delete_.deleteFilesBefore.name, new permission(true, []));
required_permissions.set(stop.restartProcesses.name, new permission(true, []));

// SQL operations are distinct from operations above, so we need to store required perms for both.
required_permissions.set(SQL_CREATE, new permission(false, [INSERT_PERM]));
required_permissions.set(SQL_DROP, new permission(false, [DELETE_PERM]));
required_permissions.set(SQL_DELETE, new permission(false, [DELETE_PERM]));
required_permissions.set(SQL_SELECT, new permission(false, [READ_PERM]));
required_permissions.set(SQL_INSERT, new permission(false, [INSERT_PERM]));
required_permissions.set(SQL_UPDATE, new permission(false, [UPDATE_PERM]));

module.exports = {
    verifyPerms:verifyPerms,
    verifyPermsAst:verifyPermsAst
};

/**
 * Verifies permissions and restrictions for a SQL operation based on the user's assigned role.
 * @param ast - The SQL statement in Syntax Tree form.
 * @param user - The user and role specification
 * @param operation - The operation specified in the call.
 * @returns {boolean} - True if permissions match, false if not authorized.
 */
function verifyPermsAst(ast, user, operation) {
    if(common_utils.isEmptyOrZeroLength(ast)) {
        harper_logger.info('verify_perms_ast has an empty user parameter');
        throw new Error(ERR_PROCESSING);
    }
    if(common_utils.isEmptyOrZeroLength(user)) {
        harper_logger.info('verify_perms_ast has an empty user parameter');
        throw new Error(ERR_PROCESSING);
    }
    if(common_utils.isEmptyOrZeroLength(operation)) {
        harper_logger.info('verify_perms_ast has a null operation parameter');
        throw new Error(ERR_PROCESSING);
    }
    try {
        let parsed_ast = new bucket(ast);
        let schemas = parsed_ast.getSchemas();

        let schema_table_map = new Map();
        // Should not continue if there are no schemas defined and there are table columns defined.
        // This is defined so we can do calc selects like : SELECT ABS(-12)
        if((!schemas || schemas.length === 0) && (parsed_ast.affected_attributes && parsed_ast.affected_attributes.size > 0) ) {
            harper_logger.info(`No schemas defined in verifyPermsAst(), will not continue.`);
            throw new Error(ERR_PROCESSING);
        }
        // set to true if this operation affects a system table.  Only su can read from system tables, but can't update/delete.
        let is_su_system_operation = schemas.includes('system');
        if(user.role.permission.super_user && !is_su_system_operation) {
            //admins can do (almost) anything through the hole in sheet!
            return true;
        }

        for(let s = 0; s<schemas.length; s++) {
            let tables = parsed_ast.getTablesBySchemaName(schemas[s]);
            if(!tables) {
                return false;
            }

            for(let t = 0; t<tables.length; t++) {
                let attributes = parsed_ast.getAttributesBySchemaTableName(schemas[s], tables[t]);
                if(!checkAttributePerms(attributes, getAttributeRestrictions(user, schemas[s],tables[t]), operation) ) {
                    return false;
                }
            }
            schema_table_map.set(schemas[s], tables);
            return hasPermissions(user, operation, schema_table_map);
        }
        return true;
    } catch(e) {
        harper_logger.info(e);
        throw new Error(ERR_PROCESSING);
    }
}

/**
 * Checks if the user's role has the required permissions for the opertion specified.
 * @param user - the hdb_user specified in the request body
 * @param op - the name of the operation
 * @param schema_table_map - A map in the format [schema_key, [tables]].
 * @returns {boolean} - True if permissions match, false if not authorized.
 */
function hasPermissions(user, op, schema_table_map ) {
    if(common_utils.arrayHasEmptyOrZeroLengthValues([user,op,schema_table_map])) {
        harper_logger.info(`hasPermissions has an invalid parameter`);
        throw new Error(ERR_PROCESSING);
    }
    // set to true if this operation affects a system table.  Only su can read from system tables, but can't update/delete.
    let is_su_system_operation = schema_table_map.has('system');
    if(user.role.permission.super_user && !is_su_system_operation) {
         //admins can do (almost) anything through the hole in sheet!
        return true;
    }
    if(!required_permissions.get(op) || (required_permissions.get(op) && required_permissions.get(op).requires_su)) {
        // still here after the su check above but this operation require su, so fail.
        harper_logger.info(`operation ${op} not found or requires SU permissions.`);
        return false;
    }
    for(let schema of schema_table_map.keys()) {
        //ASSUME ALL TABLES AND SCHEMAS ARE WIDE OPEN
        // check for schema restrictions
        for(let table of schema_table_map.get(schema)) {
            let table_restrictions = [];
            try {
                table_restrictions = user.role.permission[schema];
            } catch (e) {
                // no-op, no restrictions is OK;
            }

            if(table_restrictions && table) {
                try {
                    //Here we check all required permissions for the operation defined in the map with the values of the permissions in the role.
                    for(let i = 0; i<required_permissions.get(op).perms.length; i++) {
                                let perms = required_permissions.get(op).perms[i];
                        let permission = user.role.permission[schema].tables[table][perms];
                        if (permission === undefined || permission === null || permission === false) {
                            harper_logger.info(`Required permission not found for operation ${op} in role ${user.role.id}`);
                            return false;
                        }
                    }
                } catch(e) {
                    harper_logger.info(e);
                    // If we are here, either there are not any permissions specified for the operation, or the schema/table was not found
                    // In those cases we want to return true, as we assume wide open access unless specified otherwise.
                    //return true;
                }
            }
        }
    }
    return true;
}

/**
 * Verifies permissions and restrictions for the NoSQL operation based on the user's assigned role.
 * @param request_json - The request body as json
 * @param operation - The name of the operation specifed in the request.
 * @returns {boolean} - True if permissions match, false if not authorized.
 */
function verifyPerms(request_json, operation) {
    if(request_json === null || operation === null || request_json.hdb_user === undefined || request_json.hdb_user === null) {
        harper_logger.info(`null required parameter in verifyPerms`);
        return false;
    }

    //passing in the function rather than the function name is an easy mistake to make, so taking care of that case here.
    let op = undefined;
    if(operation instanceof Function) {
        op = operation.name;
    } else {
        op = operation;
    }

    let schema = request_json.schema;
    let table = request_json.table;

    let schema_table_map = new Map();
    schema_table_map.set(schema, [table]);

    if(common_utils.isEmptyOrZeroLength(request_json.hdb_user.role) || common_utils.isEmptyOrZeroLength(request_json.hdb_user.role.permission)) {
        harper_logger.error(`User ${request_json.hdb_user.username }has no role or permissions.  Please assign the user a valid role.`);
        return false;
    }
    // set to true if this operation affects a system table.  Only su can read from system tables, but can't update/delete.
    let is_su_system_operation = schema_table_map.has('system');
    if(request_json.hdb_user.role.permission.super_user && !is_su_system_operation) {
        //admins can do (almost) anything through the hole in sheet!
        return true;
    }
    // go
    if(hasPermissions(request_json.hdb_user, op, schema_table_map)) {
        return checkAttributePerms(getRecordAttributes(request_json), getAttributeRestrictions(request_json.hdb_user, schema, table),op);
    }
    return false;
}

/**
 * Compare the attributes specified in the call with the user's role.  If there are restrictions in the role,
 * ensure that the permission required for the operation matches the restriction in the role.
 * @param record_attributes - An array of the attributes specified in the operation
 * @param role_attribute_restrictions - A Map of each restriction in the user role, specified as [table_name, [attribute_restrictions]].
 * @param operation
 * @returns {boolean} - True if permissions match, false if not authorized.
 */
function checkAttributePerms(record_attributes, role_attribute_restrictions, operation) {
    if(!record_attributes || !role_attribute_restrictions) {
        harper_logger.info(`no attributes specified in checkAttributePerms.`);
        throw new Error(ERR_PROCESSING);
    }
    // check each attribute with role permissions.  Required perm should match the per in the operation
    let needed_perm = required_permissions.get(operation);
    if(!needed_perm || needed_perm === '') {
        // We should never get in here since all of our operations should have a perm, but just in case we should fail
        // any operation that doesn't have perms.
        harper_logger.info(`no permissions found for ${operation} in checkAttributePerms().`);
        throw new Error(ERR_PROCESSING);
    }

    //TODO: Replace with common utils empty check when it is merged
    // leave early if the role has no attribute permissions set
    if(!role_attribute_restrictions || role_attribute_restrictions.size === 0) {
        harper_logger.info(`No role restrictions set (this is OK).`);
        return true;
    }

    // Check if each specified attribute in the call (record_attributes) has a restriction specified in the role.  If there is
    // a restriction, check if the operation permission/ restriction is false.
    for(let element of record_attributes) {
        // If there is a wildcard, we need to make sure there are no role_attribute_restrictions that have the needed_perm (READ, UPDATE, etc)
        // set to false.
        if(element === WILDCARD) {
            if(needed_perm.perms) {
                for (let perm of needed_perm.perms) {
                    for(let restriction of role_attribute_restrictions.keys()) {
                        if(role_attribute_restrictions.get(restriction)[perm] === false) {
                            return false;
                        }
                    }
                }
            }
        } else {
            let restriction = role_attribute_restrictions.get(element);
            if (restriction && needed_perm.perms) {
                for (let perm of needed_perm.perms) {
                    if (restriction[perm] === false) {
                        return false;
                    }
                }
            }
        }
    }
    return true;
}

/**
 * Pull the table attributes specified in the statement.  Will always return a Set, even if empty or on error.
 * @param json - json containing the request
 * @returns {Set} - all attributes affected by the request statement.
 */
function getRecordAttributes(json) {
    let affected_attributes = new Set();
    try {
        if(!json.records || json.records.length === 0) {
            if(!json.get_attributes || !json.get_attributes.length === 0) {
                return affected_attributes;
            } else {
                for(let record = 0; record < json.get_attributes.length; record++) {
                    if (!affected_attributes.has(json.get_attributes[record])) {
                        affected_attributes.add(json.get_attributes[record]);
                    }
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
 * @param schema - The schema specified in the request
 * @param table - The table specified.
 * @returns {Map} A Map of attribute restrictions of the form [attribute_name, attribute_restriction];
 */
function getAttributeRestrictions(json_hdb_user, schema, table) {
    //TODO: It might be worth caching these to avoid this for every call.
    let role_attribute_restrictions = new Map();
    if(!json_hdb_user || json_hdb_user.length === 0) {
        harper_logger.info(`no hdb_user specified in getAttributeRestrictions`);
        return role_attribute_restrictions;
    }
    if(json_hdb_user.role.permission.super_user) {
        return role_attribute_restrictions;
    }
    // Some commands do not require a table to be specified.  If there is no table, there is likely not
    // anything attribute restrictions needs to check.
    if(!schema || !table) {
        return role_attribute_restrictions;
    }
    try {
        json_hdb_user.role.permission[schema].tables[table].attribute_restrictions.forEach(function (restriction) {
            if (!role_attribute_restrictions.has(restriction.attribute_name)) {
                role_attribute_restrictions.set(restriction.attribute_name, restriction);
            }
        });
    } catch (e) {
        harper_logger.info(`No attribute restrictions found for schema ${schema} and table ${table}.`);
    }
    return role_attribute_restrictions;
}
