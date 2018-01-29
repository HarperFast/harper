
const  write = require('../data_layer/insert'),
    uuidv1 = require('uuid/v1'),
    search = require('../data_layer/search'),
    sql = require('../sqlTranslator/index').evaluateSQL,
    csv = require('../data_layer/csvBulkLoad'),
    schema = require('../data_layer/schema'),
    delete_ = require('../data_layer/delete'),
    user = require('../security/user'),
    role = require('../security/role'),
    read_log = require('../utility/logging/read_logs'),
    harper_logger = require('../utility/logging/harper_logger'),
    cluser_utilities = require('./clustering/cluster_utilities');

const error_message = 'You do not have the required permissions to perform this action.';

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
    chooseOperation: chooseOperation,
    processLocalTransaction: processLocalTransaction,
    proccessDelegatedTransaction: proccessDelegatedTransaction,
    processInThread: processInThread
}


function processLocalTransaction(req, res, operation_function, callback) {
    try {
        if (req.body.operation != 'read_log')
            harper_logger.info(JSON.stringify(req.body));
    } catch (e) {
        harper_logger.error(e);
        callback(e);
        return res.status(500).json(e);
    }

    operation_function(req.body, (error, data) => {
        if (error) {
            harper_logger.info(error);
            if(typeof error != 'object')
                error = {"error": error};
            res.status(500).json({error: (error.message ? error.message : error.error)});
            return callback(error);;
        }
        if(typeof data != 'object')
            data = {"message": data};

        res.status(200).json(data);
        return callback(null, data);
    });
}

function processInThread(operation, operation_function, callback) {
    if(operation === undefined || operation === null ) {
        let msg = `operation parameter in processInThread is undefined`;
        harper_logger.error(msg);
        return callback(msg, null);
    }
    if(operation_function === undefined || operation_function === null ) {
        let msg = `operation_function parameter in processInThread is undefined`;
        harper_logger.error(msg);
        return callback(msg, null);
    }
    try {
        if(operation.operation != 'read_log')
            harper_logger.info(JSON.stringify(operation));
    } catch (e) {
        harper_logger.error(e);
        return callback(e);
    }
    operation_function(operation, (error, data) => {
        if (error) {
            harper_logger.info(error);
            if(typeof error != 'object')
                error = {"error": error};
            return callback(error, null);
        }
        if(typeof data != 'object')
            data = {"message": data};
        return callback(null, data);
    });
}

//TODO: operation_function is not used, do we need it?
function proccessDelegatedTransaction(operation, operation_function, callback) {
    if(operation === null || operation === undefined) {
        let message = 'operation parameter is null';
        harper_logger.error(message);
        return callback(message, null);
    }
    if(global.forks === undefined || global.forks === null ) {
        let message = 'global forks is undefined';
        harper_logger.error(message);
        return callback(message, null);
    }
    let f = Math.floor(Math.random() * Math.floor(global.forks.length));
    let payload = {
        "id": uuidv1(),
        "body":operation,
        "type":"delegate_transaction"
    };
    global.delegate_callback_queue[payload.id] = callback;
    global.forks[f].send(payload);
}

// TODO: This doesn't really need a callback, should simplify it to a return statement.
function chooseOperation(json, callback) {
    if(json === undefined || json === null) {
        harper_logger.error(`invalid message body parameters found`);
        return nullOperation(json, callback);
    }
    let operation_function = nullOperation;

    switch (json.operation) {
        case 'insert':
            if(verify_perms(json, write.insert) === true) {
                operation_function = write.insert;
            } else {
                harper_logger.error(error_message);
                return callback(error_message, null);
            }
            break;
        case 'update':
            operation_function = write.update;
            break;
        case 'search_by_hash':
            operation_function = search.searchByHash;
            break;
        case 'search_by_value':
            operation_function = search.searchByValue;
            break;
        case 'search':
            operation_function = search.search;
            break;
        case 'sql':
            operation_function = sql;
            break;
        case 'csv_data_load':
            operation_function = csv.csvDataLoad;
            break;
        case 'csv_file_load':
            operation_function = csv.csvFileLoad;
            break;
        case 'csv_url_load':
            operation_function = csv.csvURLLoad;
            break;
        case 'create_schema':
            if(verify_perms(json, schema.createSchema) === true) {
                operation_function = schema.createSchema;
            } else {
                harper_logger.error(error_message);
                return callback(error_message, null);
            }
            break;
        case 'create_table':
            if(verify_perms(json, schema.createTable) === true) {
                operation_function = schema.createTable;
            } else {
                harper_logger.error(error_message);
                return callback(error_message, null);
            }
            break;
        case 'create_attribute':
            operation_function = schema.createAttribute;
            break;
        case 'drop_schema':
            if(verify_perms(json, schema.dropSchema) === true) {
                operation_function = schema.dropSchema;
            } else {
                harper_logger.error(error_message);
                return callback(error_message, null);
            }
            break;
        case 'drop_table':
            if(verify_perms(json, schema.dropTable) === true) {
                operation_function = schema.dropTable;
            } else {
                harper_logger.error(error_message);
                return callback(error_message, null);
            }
            break;
        case 'describe_schema':
            if(verify_perms(json, schema.describeSchema) === true) {
                operation_function = schema.describeSchema;
            } else {
                harper_logger.error(error_message);
                return callback(error_message, null);
            }
            break;
        case 'describe_table':
            if(verify_perms(json, schema.describeTable) === true) {
                operation_function = schema.describeTable;
            } else {
                harper_logger.error(error_message);
                return callback(error_message, null);
            }
            break;
        case 'describe_all':
            if(verify_perms(json, schema.describeAll) === true) {
                operation_function = schema.describeAll;
            } else {
                harper_logger.error(error_message);
                return callback(error_message, null);
            }
            break;
        case 'delete':
            operation_function = delete_.delete;
            break;
        case 'add_user':
            operation_function = user.addUser;
            break;
        case 'alter_user':
            operation_function = user.alterUser;
            break;
        case 'drop_user':
            operation_function = user.dropUser;
            break;
        case 'list_users':
            operation_function = user.listUsers;
            break;
        case 'list_roles':
            operation_function = role.listRoles;
            break;
        case 'add_role':
            operation_function = role.addRole;
            break;
        case 'alter_role':
            operation_function = role.alterRole;
            break;
        case 'drop_role':
            operation_function = role.dropRole;
            break;
        case 'user_info':
            operation_function = user.userInfo;
            break;
        case 'read_log':
            operation_function = read_log.read_log;
            break;
        case 'add_node':
            operation_function = cluser_utilities.addNode;
            break;
        default:
            break;
    }

    callback(null, operation_function);
}

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

function nullOperation(json, callback) {
    callback('Invalid operation');
}
