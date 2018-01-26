
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

required_permissions.set(write.insert, [INSERT_PERM]);
required_permissions.set(write.update, [UPDATE_PERM]);
required_permissions.set(search.searchByHash, [READ_PERM]);
required_permissions.set(search.searchByValue, [READ_PERM]);
required_permissions.set(search.search,[READ_PERM]);
required_permissions.set(csv.csvDataLoad, [INSERT_PERM]);
required_permissions.set(csv.csvFileLoad, [INSERT_PERM]);
required_permissions.set(csv.csvURLLoad, [INSERT_PERM]);
required_permissions.set(schema.createSchema, [INSERT_PERM]);
required_permissions.set(schema.createTable, [INSERT_PERM]);
required_permissions.set(schema.createAttribute, [INSERT_PERM]);
required_permissions.set(schema.dropSchema, [UPDATE_PERM]);
required_permissions.set(schema.dropTable, [UPDATE_PERM]);
required_permissions.set(schema.describeSchema, [READ_PERM]);
required_permissions.set(schema.describeTable, [READ_PERM]);
required_permissions.set(schema.describeAll, [READ_PERM]);
required_permissions.set(delete_.delete, [UPDATE_PERM]);
required_permissions.set(user.addUser, [INSERT_PERM]);
required_permissions.set(user.alterUser, [UPDATE_PERM]);
required_permissions.set(user.dropUser, [UPDATE_PERM]);
required_permissions.set(user.listUsers, [READ_PERM]);
required_permissions.set(role.listRoles, [READ_PERM]);
required_permissions.set(role.addRole, [INSERT_PERM]);
required_permissions.set(role.alterRole, [UPDATE_PERM]);
required_permissions.set(role.dropRole, [UPDATE_PERM]);
required_permissions.set(user.userInfo, [READ_PERM]);
required_permissions.set(read_log.read_log, [READ_PERM]);
required_permissions.set(cluser_utilities.addNode, [INSERT_PERM]);

module.exports = {
    chooseOperation: chooseOperation,
    processLocalTransaction: processLocalTransaction,
    proccessDelegatedTransaction: proccessDelegatedTransaction,
    processInThread: processInThread
}


function processLocalTransaction(req, res, operation_function, callback){
    try {
        if(req.body.operation != 'read_log')
            //winston.info(JSON.stringify(req.body));
            harper_logger.info(JSON.stringify(req.body));

        operation_function(req.body, (error, data) => {
            if (error) {
                harper_logger.info(error);
                if(typeof error != 'object')
                    error = {"error": error};
                callback(error);
                res.status(500).json({error: (error.message ? error.message : error.error)});
                return;
            }
            if(typeof data != 'object')
                data = {"message": data};

            res.status(200).json(data);
            return callback(null, data);
        });
    } catch (e) {
        harper_logger.error(e);
        callback(e);
        return res.status(500).json(e);
    }
}

function processInThread(operation, operation_function, callback){
    try {
        if(operation.operation != 'read_log')
            harper_logger.info(JSON.stringify(operation));

        operation_function(operation, (error, data) => {
            if (error) {
                harper_logger.info(error);
                if(typeof error != 'object')
                    error = {"error": error};
                return callback(null, error);
            }
            if(typeof data != 'object')
                data = {"message": data};
            return callback(null, data);
        });
    } catch (e) {
        harper_logger.error(e);
        return callback(e);
    }
}



function proccessDelegatedTransaction(operation, operation_function, callback){
    let f = Math.floor(Math.random() * Math.floor(global.forks.length))
    let payload = {
        "id": uuidv1(),
        "body":operation,
        "type":"delegate_transaction"
    }
    global.delegate_callback_queue[payload.id] = callback;
    global.forks[f].send(payload);
}

function chooseOperation(json, callback) {
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
            operation_function = schema.createSchema;
            break;
        case 'create_table':
            operation_function = schema.createTable;
            break;
        case 'create_attribute':
            operation_function = schema.createAttribute;
            break;
        case 'drop_schema':
            operation_function = schema.dropSchema;
            break;
        case 'drop_table':
            operation_function = schema.dropTable;
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
            operation_function = schema.describeTable;
            break;
        case 'describe_all':
            operation_function = schema.describeAll;
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
    if(json.hdb_user === undefined || json.hdb_user === null) {
        return false;
    }
    if(json.hdb_user.super_user) {
        return true;
    }
    let schema = json.schema;
    let table = json.table;

    //ASSUME ALL TABLES AND SCHEMAS ARE WIDE OPEN
    // get user schemas
    let schema_perms = json.hdb_user.role.permission;

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
            if (json.hdb_user.role.permission[schema].tables[table] === undefined) {
                return false;
            }
            //TODO: These are for debugging, remove when released
            let test2 = json.hdb_user.role.permission[schema].tables[table];
            //Here we check all required permissions for the operation defined in the map with the values of the permissions in the role.
            for(let i = 0; i<required_permissions.get(operation).length; i++) {
                //TODO: These are for debugging, remove when released
                let test_val = required_permissions.get(operation)[i];
                let test3 = json.hdb_user.role.permission[schema].tables[table][required_permissions.get(operation)[i]];
                if (json.hdb_user.role.permission[schema].tables[table][required_permissions.get(operation)[i]] === false) {
                    harper_logger.info(`Required permission not found for operation ${operation.name} in role ${json.hdb_user.role.id}`);
                    return false;
                }
            }
        } catch(e) {
            harper_logger.info(e);
            return false;
        }
    }
    //if user tables has permission
    // check permission on operation
    //
    // if tables not specified
    // go

    return true;
}

function getTableRestrictions(schema) {
    if(schema === undefined) {
        return [];
    }
    else {
        return json.hdb_user.role.permission[schema];
    }
}

function nullOperation(json, callback) {
    callback('Invalid operation');
}
