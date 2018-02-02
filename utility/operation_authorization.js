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
    common_utils = require('../utility/common_utils'),
    cluser_utilities = require('../server/clustering/cluster_utilities');

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
required_permissions.set(cluser_utilities.addNode.name, new permission(true, []));
required_permissions.set(search.search.name, new permission(false, [READ_PERM]));
required_permissions.set(read_log.read_log.name, new permission(true, []));
required_permissions.set(SQL_CREATE, new permission(false, [INSERT_PERM]));
required_permissions.set(SQL_DROP, new permission(false, [DELETE_PERM]));
required_permissions.set(SQL_SELECT, new permission(false, [READ_PERM]));
required_permissions.set(SQL_INSERT, new permission(false, [UPDATE_PERM]));

module.exports = {
    verify_perms:verify_perms,
    verify_perms_ast:verify_perms_ast
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

function verify_perms_ast(ast, user, operation) {
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
        //TODO: Remove console message
        console.log(e);
        harper_logger.info(e);
        return false;
    }
}

function hasPermissions(user, op, schema_table_map ) {
    if(user.role.permission.super_user) {
        //admins can do anything through the hole in sheet!
        return true;
    }

    if(required_permissions.get(op) && required_permissions.get(op).requires_su) {
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
                        let permission = user.role.permission[schema].tables[table][required_permissions.get(op).perms[i]];
                        if (permission === undefined || permission === null || permission === false) {
                            harper_logger.info(`Required permission not found for operation ${op} in role ${user.role.id}`);
                            return false;
                        }
                    }
                } catch(e) {
                    harper_logger.info(e);
                    return false;
                }
            }
        }
    }
    return true;
}

function verify_perms(json, operation) {
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

    if(json.hdb_user.role.permission.super_user) {
        //admins can do anything through the hole in sheet!
        return true;
    }

    if(required_permissions.get(op) && required_permissions.get(op).requires_su) {
        // still here after the su check above but this operation require su, so fail.
        return false;
    }

    let schema = json.schema;
    let table = json.table;

    //ASSUME ALL TABLES AND SCHEMAS ARE WIDE OPEN
    // check for schema restrictions
    let table_restrictions = [];
    try {
        table_restrictions = json.hdb_user.role.permission[schema];
    } catch (e) {
        // no-op, no restrictions is OK;
    }

    // if there are table_restrictions and table is specified
    if(table_restrictions && table) {
        try {
            if (json.hdb_user.role.permission[schema].tables[table] === undefined || json.hdb_user.role.permission[schema].tables[table] === null) {
                return true;
            }
            //Here we check all required permissions for the operation defined in the map with the values of the permissions in the role.
            for(let i = 0; i<required_permissions.get(op).perms.length; i++) {
                let permission = json.hdb_user.role.permission[schema].tables[table][required_permissions.get(op).perms[i]];
                if (permission === undefined || permission === null || permission === false) {
                    harper_logger.info(`Required permission not found for operation ${op} in role ${json.hdb_user.role.id}`);
                    return false;
                }
            }
        } catch(e) {
            harper_logger.info(e);
            return false;
        }
    }
    // go
    return true;
}