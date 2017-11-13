module.exports = {
    chooseOperation: chooseOperation,
    processLocalTransaction: processLocalTransaction,
    proccessDelegatedTransaction: proccessDelegatedTransaction

}

const  write = require('../data_layer/insert'),
    search = require('../data_layer/search'),
    sql = require('../sqlTranslator/index').evaluateSQL,
    csv = require('../data_layer/csvBulkLoad'),
    schema = require('../data_layer/schema'),
    delete_ = require('../data_layer/delete'),
    user = require('../security/user'),
    role = require('../security/role'),
    read_log = require('../utility/logging/read_logs'),
    winston = require('../utility/logging/winston_logger');


function processLocalTransaction(req, res, operation_function, callback){
    try {
        if(req.body.operation != 'read_log')
            winston.info(JSON.stringify(req.body));

        operation_function(req.body, (error, data) => {
            if (error) {
                winston.info(error);
                if(typeof error != 'object')
                    error = {"error": error};
                callback(error);
                res.status(200).json(error);
                return;
            }
            if(typeof data != 'object')
                data = {"message": data};
            callback(null, data);
            return res.status(200).json(data);
        });
    } catch (e) {
        winston.error(e);
        callback(e);
        return res.status(500).json(e);
    }
}


function proccessDelegatedTransaction(operation, operation_function, callback){
    try {
        if(operation.operation != 'read_log')
            winston.info(JSON.stringify(operation));

        operation_function(operation, (error, data) => {
            if (error) {
                winston.info(error);
                if(typeof error != 'object')
                    error = {"error": error};

               return callback(null, error);
            }
            if(typeof data != 'object')
                data = {"message": data};
            return callback(null, data);
        });
    } catch (e) {
        winston.error(e);
        return callback(e);
    }

}

function chooseOperation(json, callback) {
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
            operation_function = global.cluster_server.addNode;
            break;


        default:
            break;
    }

    callback(null, operation_function);
}

function nullOperation(json, callback) {
    callback('Invalid operation');
}
