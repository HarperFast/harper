
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
    op_auth = require('../utility/operation_authorization'),
    cluser_utilities = require('./clustering/cluster_utilities');

const UNAUTH_RESPONSE = 403;
const UNAUTHORIZED_TEXT = 'You are not authorized to performs the operation specified';
let OPERATION_PARAM_ERROR_MSG = `operation parameter is undefined`;

module.exports = {
    chooseOperation: chooseOperation,
    processLocalTransaction: processLocalTransaction,
    proccessDelegatedTransaction: proccessDelegatedTransaction,
    processInThread: processInThread,
    UNAUTH_RESPONSE,
    UNAUTHORIZED_TEXT
}

function processLocalTransaction(req, res, operation_function, callback) {
    try {
        if (req.body.operation !== 'read_log')
            harper_logger.info(JSON.stringify(req.body));
    } catch (e) {
        harper_logger.error(e);
        callback(e);
        return res.status(500).json(e);
    }

    operation_function(req.body, (error, data) => {
        if (error) {
            harper_logger.info(error);
            if(error === UNAUTH_RESPONSE) {
                error = UNAUTHORIZED_TEXT;
            }
            if (typeof error !== 'object') {
                error = {"error": error};
            }
            res.status(500).json({error: (error.message ? error.message : error.error)});
            return callback(error);
        }
        if(typeof data !== 'object')
            data = {"message": data};

        res.status(200).json(data);
        return callback(null, data);
    });
}

function processInThread(operation, operation_function, callback) {
    if(!operationParameterValid(operation)) {
        return callback(OPERATION_PARAM_ERROR_MSG, null);
    }
    if(operation_function === undefined || operation_function === null ) {
        let msg = `operation_function parameter in processInThread is undefined`;
        harper_logger.error(msg);
        return callback(msg, null);
    }
    try {
        if(operation.operation !== 'read_log')
            harper_logger.info(JSON.stringify(operation));
    } catch (e) {
        harper_logger.error(e);
        return callback(e);
    }
    operation_function(operation, (error, data) => {
        if (error) {
            harper_logger.info(error);
            if(typeof error !== 'object')
                error = {"error": error};
            return callback(error, null);
        }
        if(typeof data !== 'object')
            data = {"message": data};
        return callback(null, data);
    });
}

//TODO: operation_function is not used, do we need it?
function proccessDelegatedTransaction(operation, operation_function, callback) {
    if(!operationParameterValid(operation)) {
        return callback(OPERATION_PARAM_ERROR_MSG, null);
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
            operation_function = write.insert;
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
            operation_function = schema.describeSchema;
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
    // We need to do something different for sql operations as we don't want to parse
    // the SQL command twice.
    if(operation_function !== sql) {
        if (op_auth.verify_perms(json, operation_function) === false) {
            harper_logger.error(UNAUTH_RESPONSE);
            return callback(UNAUTH_RESPONSE, null);
        }
    }
    callback(null, operation_function);
}

function nullOperation(json, callback) {
    callback('Invalid operation');
}

function operationParameterValid(operation) {
    if(operation === undefined || operation === null ) {
        harper_logger.error(OPERATION_PARAM_ERROR_MSG);
        return false;
    }
    return true;
}