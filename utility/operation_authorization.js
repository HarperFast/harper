"use strict";
const write = require('../data_layer/insert'),
    search = require('../data_layer/search'),
    csv = require('../data_layer/csvBulkLoad'),
    schema = require('../data_layer/schema'),
    delete_ = require('../data_layer/delete'),
    user = require('../security/user'),
    role = require('../security/role'),
    read_log = require('../utility/logging/read_logs'),
    harper_logger = require('../utility/logging/harper_logger'),
    common_utils = require('./common_utils.js'),
    cluster_utilities = require('../server/clustering/cluster_utilities');

const required_permissions = new Map();
const DELETE_PERM = 'delete';
const INSERT_PERM = 'insert';
const READ_PERM = 'read';
const UPDATE_PERM = 'update';

//SQL operations supported
const SQL_CREATE = "create";
const SQL_DROP = 'drop';
const SQL_SELECT = 'select';
const SQL_INSERT = 'insert';

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
required_permissions.set(user.listUsers.name, new permission(true, []));
required_permissions.set(role.listRoles.name, new permission(true, []));
required_permissions.set(role.addRole.name, new permission(true, []));
required_permissions.set(role.alterRole.name, new permission(true, []));
required_permissions.set(role.dropRole.name, new permission(true, []));
required_permissions.set(user.userInfo.name, new permission(true, []));
required_permissions.set(read_log.read_log.name, new permission(true, []));
required_permissions.set(cluster_utilities.addNode.name, new permission(true, []));
required_permissions.set(search.search.name, new permission(false, [READ_PERM]));
required_permissions.set(read_log.read_log.name, new permission(true, []));
required_permissions.set(SQL_CREATE, new permission(false, [INSERT_PERM]));
required_permissions.set(SQL_DROP, new permission(false, [DELETE_PERM]));
required_permissions.set(SQL_SELECT, new permission(false, [READ_PERM]));
required_permissions.set(SQL_INSERT, new permission(false, [UPDATE_PERM]));

module.exports = {
    verifyPerms:verifyPerms,
    verifyPermsAst:verifyPermsAst
};

function updateMapValue(key, newValue, map) {
    if(common_utils.isEmptyOrZeroLength(key)) {
        harper_logger.info(`updateMapValue has an empty 'key' parameter`);
    }
    if(common_utils.isEmptyOrZeroLength(newValue)) {
        harper_logger.info(`updateMapValue has an empty value parameter`);
    }
    if(common_utils.isEmpty(map)) {
        harper_logger.info(`updateMapValue has a null map parameter`);
    }
    try {
        if (map.has(key)) {
            let temp = map.get(key);
            temp.push(newValue);
            map.set(key, temp);
        } else {
            map.set(key, [newValue]);
        }
    } catch(e) {
        throw e;
    }
}

function verifyPermsAst(ast, user, operation) {
    if(common_utils.isEmptyOrZeroLength(ast)) {
        harper_logger.info(`verify_perms_ast has an empty 'user' parameter`);
        return false;
    }
    if(common_utils.isEmptyOrZeroLength(user)) {
        harper_logger.info(`verify_perms_ast has an empty user parameter`);
        return false;
    }
    if(common_utils.isEmptyOrZeroLength(operation)) {
        harper_logger.info(`verify_perms_ast has a null operation parameter`);
        return false;
    }
    let schema_table_map = new Map();
    try {
        for (let tab = 0; tab < ast.from.length; tab++) {
            updateMapValue(ast.from[tab].databaseid, ast.from[tab].tableid, schema_table_map);
        }
        for (let join = 0; join < ast.joins.length; join++) {
            updateMapValue(ast.joins[join].table.databaseid, ast.joins[join].table.tableid, schema_table_map);
        }
        return hasPermissions(user, operation, schema_table_map);
    } catch(e) {
        harper_logger.info(e);
        return false;
    }
}

function hasPermissions(user, op, schema_table_map ) {
    if(common_utils.listHasEmptyOrZeroLengthValues([user,op,schema_table_map])) {
        harper_logger.info(`hasPermissions has an invalid parameter`);
        return false;
    }
    if(user.role.permission.super_user) {
         //admins can do anything through the hole in sheet!
        return true;
    }
    if(!required_permissions.get(op) || (required_permissions.get(op) && required_permissions.get(op).requires_su)) {
        // still here after the su check above but this operation require su, so fail.
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
                    return true;
                }
            }
        }
    }
    return true;
}

function verifyPerms(json, operation) {
    if(json === null || operation === null || json.hdb_user === undefined || json.hdb_user === null) {
        return false;
    }

    //passing in the function rather than the function name is an easy mistake to make, so taking care of that case here.
    let op = undefined;
    if(operation instanceof Function) {
        op = operation.name;
    } else {
        op = operation;
    }

    let schema = json.schema;
    let table = json.table;

    let schema_table_map = new Map();
    schema_table_map.set(schema, [table]);
    // go
    if(hasPermissions(json.hdb_user, op, schema_table_map)) {
        return checkAttributePerms(getRecordAttributes(json), getAttributeRestrictions(json),op);
    } else {
        return false;
    }
}

/**
 * Compare the attributes specified in the call with the user's role.  If there are restrictions in the role,
 * ensure that the permission required for the operation matches the restriction in the role.
 * @param json
 * @param operation
 * @returns {boolean}
 */
function checkAttributePerms(record_attributes, role_attribute_restrictions, operation) {

    if(!record_attributes || !role_attribute_restrictions) {
        return false;
    }
    // check each attribute with role permissions.  Required perm should match the per in the operation
    let needed_perm = required_permissions.get(operation);
    if(!needed_perm || needed_perm === '') {
        // We should never get in here since all of our operations should have a perm, but just in case we should fail
        // any operation that doesn't have perms.
        return false;
    }

    //TODO: Replace with common utils empty check when it is merged
    // leave early if the role has no attribute permissions set
    if(!role_attribute_restrictions || role_attribute_restrictions.size === 0) {
        return true;
    }

    // Check if each specified attribute in the call has a restriction specified in the role.  If there is
    // a restriction, check if the operation permission/ restriction is false.
    for(let element of record_attributes.values()) {
        let restriction = role_attribute_restrictions.get(element);
        if(restriction && needed_perm.perms) {
            for(let perm of needed_perm.perms) {
                if (restriction[perm] === false) {
                    return false;
                }
            }
        }
    }
    return true;
}

/**
 * Pull the table attributes specified in the statement.  Will always return a Set, even if empty or on error.
 * @param json
 * @returns {Set}
 */
function getRecordAttributes(json) {
    let affected_attributes = new Set();
    try {
        // get unique affected_attributes
        for (let record = 0; record < json.records.length; record++) {
            let keys = Object.keys(json.records[record]);
            for (let att = 0; att < keys.length; att++) {
                if (!affected_attributes.has(keys[att])) {
                    affected_attributes.add(keys[att]);
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
 * @param json
 * @returns {Map}
 */
function getAttributeRestrictions(json) {
    //TODO: It might be worth caching these to avoid this for every call.
    let role_attribute_restrictions = new Map();
    if(!json || json.length === 0) {
        return role_attribute_restrictions;
    }
    try {
        json.hdb_user.role.permission[json.schema].tables[json.table].attribute_restrictions.forEach(function (element) {
            if (!role_attribute_restrictions.has(element.attribute_name)) {
                role_attribute_restrictions.set(element.attribute_name, element);
            }
        });
    } catch (e) {
        harper_logger.info(e);
    }
    return role_attribute_restrictions;
}