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
    cluser_utilities = require('../server/clustering/cluster_utilities');

const required_permissions = new Map();
const DELETE_PERM = 'delete';
const INSERT_PERM = 'insert';
const READ_PERM = 'read';
const UPDATE_PERM = 'update';

required_permissions.set(write.insert.name, [INSERT_PERM]);
required_permissions.set(write.update.name, [UPDATE_PERM]);
required_permissions.set(search.searchByHash.name, [READ_PERM]);
required_permissions.set(search.searchByValue.name, [READ_PERM]);
required_permissions.set(search.search.name,[READ_PERM]);
required_permissions.set(csv.csvDataLoad.name, [INSERT_PERM]);
required_permissions.set(csv.csvFileLoad.name, [INSERT_PERM]);
required_permissions.set(csv.csvURLLoad.name, [INSERT_PERM]);
required_permissions.set(schema.createSchema.name, [INSERT_PERM]);
required_permissions.set(schema.createTable.name, [INSERT_PERM]);
required_permissions.set(schema.createAttribute.name, [INSERT_PERM]);
required_permissions.set(schema.dropSchema.name, [DELETE_PERM]);
required_permissions.set(schema.dropTable.name, [DELETE_PERM]);
required_permissions.set(schema.describeSchema.name, [READ_PERM]);
required_permissions.set(schema.describeTable.name, [READ_PERM]);
required_permissions.set(schema.describeAll.name, [READ_PERM]);
required_permissions.set(delete_.delete.name, [DELETE_PERM]);
required_permissions.set(user.addUser.name, [INSERT_PERM]);
required_permissions.set(user.alterUser.name, [UPDATE_PERM]);
required_permissions.set(user.dropUser.name, [DELETE_PERM]);
required_permissions.set(user.listUsers.name, [READ_PERM]);
required_permissions.set(role.listRoles.name, [READ_PERM]);
required_permissions.set(role.addRole.name, [INSERT_PERM]);
required_permissions.set(role.alterRole.name, [UPDATE_PERM]);
required_permissions.set(role.dropRole.name, [DELETE_PERM]);
required_permissions.set(user.userInfo.name, [READ_PERM]);
required_permissions.set(read_log.read_log.name, [READ_PERM]);
required_permissions.set(cluser_utilities.addNode.name, [INSERT_PERM]);

module.exports = {
    verify_perms:verify_perms
};

function verify_perms(json, operation) {
    if(json === null || operation === null || json.hdb_user === undefined || json.hdb_user === null) {
        return false;
    }
    if(json.hdb_user.role.permission.super_admin) {
        return true;
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
            for(let i = 0; i<required_permissions.get(operation).length; i++) {
                let permission = json.hdb_user.role.permission[schema].tables[table][required_permissions.get(operation)[i]];
                if (permission === undefined || permission === null || permission === false) {
                    harper_logger.info(`Required permission not found for operation ${operation} in role ${json.hdb_user.role.id}`);
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