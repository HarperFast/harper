"use strict";

const write = require('../data_layer/insert');
const uuidv1 = require('uuid/v1');
const search = require('../data_layer/search');
const sql = require('../sqlTranslator/index');
const csv = require('../data_layer/csvBulkLoad');
const schema = require('../data_layer/schema');
const delete_ = require('../data_layer/delete');
const user = require('../security/user');
const role = require('../security/role');
const read_log = require('../utility/logging/read_logs');
const cluster_utilities = require('./clustering/clusterUtilities');
const auth = require('../security/auth');
const harper_logger = require('../utility/logging/harper_logger');
const export_ = require('../data_layer/export');
const op_auth = require('../utility/operation_authorization');
const jobs = require('./jobs');
const signal = require('../utility/signalling');
const job_runner = require('./jobRunner');
const terms = require('../utility/hdbTerms');
const reg = require('../utility/registration/registrationHandler');

const UNAUTH_RESPONSE = 403;
const UNAUTHORIZED_TEXT = 'You are not authorized to perform the operation specified';
let OPERATION_PARAM_ERROR_MSG = `operation parameter is undefined`;

module.exports = {
    chooseOperation: chooseOperation,
    processLocalTransaction: processLocalTransaction,
    proccessDelegatedTransaction: proccessDelegatedTransaction,
    processInThread: processInThread,
    UNAUTH_RESPONSE,
    UNAUTHORIZED_TEXT
};

function processLocalTransaction(req, res, operation_function, callback) {
    try {
        if (req.body.operation !== 'read_log') {
            if(harper_logger.log_level === harper_logger.INFO ||
            harper_logger.log_level === harper_logger.DEBUG ||
            harper_logger.log_level === harper_logger.TRACE) {
                // Need to remove auth variables, but we don't want to create an object unless
                // the logging is actually going to happen.
                const { hdb_user, hdb_auth_header, ...clean_body } = req.body;
                harper_logger.info(JSON.stringify(clean_body));
            }
        }
    } catch (e) {
        harper_logger.error(e);
        callback(e);
        return res.status(500).json(e);
    }

    operation_function(req.body, (error, data) => {
        if (error) {
            harper_logger.info(error);
            if(error === UNAUTH_RESPONSE) {
                res.status(403).json({error: UNAUTHORIZED_TEXT});
                return callback(error);
            }
            if(typeof error !== 'object') {
                error = {"error": error};
            }
            res.status(500).json({error: (error.message ? error.message : error.error)});
            return callback(error);
        }
        if (typeof data !== 'object')
            data = {"message": data};
        res.status(200).json(data);
        return callback(null, data);
    });
}

function processInThread(operation, operation_function, callback) {
    if (!operationParameterValid(operation)) {
        return callback(OPERATION_PARAM_ERROR_MSG, null);
    }
    if (operation_function === undefined || operation_function === null) {
        let msg = `operation_function parameter in processInThread is undefined`;
        harper_logger.error(msg);
        return callback(msg, null);
    }
    try {
        if (operation.operation !== 'read_log')
            harper_logger.info(JSON.stringify(operation));
    } catch (e) {
        harper_logger.error(e);
        return callback(e);
    }
    operation_function(operation, (error, data) => {
        if (error) {
            harper_logger.info(error);
            if (typeof error !== 'object')
                error = {"error": error};
            return callback(error, null);
        }
        if (typeof data !== 'object')
            data = {"message": data};
        return callback(null, data);
    });
}

//TODO: operation_function is not used, do we need it?
function proccessDelegatedTransaction(operation, operation_function, callback) {
    if (!operationParameterValid(operation)) {
        return callback(OPERATION_PARAM_ERROR_MSG, null);
    }
    if (global.forks === undefined || global.forks === null) {
        let message = 'global forks is undefined';
        harper_logger.error(message);
        return callback(message, null);
    }

    let req = {};
    req.headers = {};
    req.headers.authorization = operation.hdb_auth_header;

    auth.authorize(req, null, function (err, user) {
        if (err) {
            return callback(err);
        }

        operation.hdb_user = user;
        let f = Math.floor(Math.random() * Math.floor(global.forks.length))
        let payload = {
            "id": uuidv1(),
            "body": operation,
            "type": "delegate_transaction"
        };
        global.delegate_callback_queue[payload.id] = callback;
        global.forks[f].send(payload);
    });
}

// TODO: This doesn't really need a callback, should simplify it to a return statement.
function chooseOperation(json, callback) {
    if (json === undefined || json === null) {
        harper_logger.error(`invalid message body parameters found`);
        return nullOperation(json, callback);
    }
    let operation_function = nullOperation;
    let job_operation_function = undefined;

    switch (json.operation) {
        case terms.OPERATIONS_ENUM.INSERT:
            operation_function = write.insert;
            break;
        case terms.OPERATIONS_ENUM.UPDATE:
            operation_function = write.update;
            break;
        case terms.OPERATIONS_ENUM.SEARCH_BY_HASH:
            operation_function = search.searchByHash;
            break;
        case terms.OPERATIONS_ENUM.SEARCH_BY_VALUE:
            operation_function = search.searchByValue;
            break;
        case terms.OPERATIONS_ENUM.SEARCH:
            operation_function = search.search;
            break;
        case terms.OPERATIONS_ENUM.SQL:
            operation_function = sql.evaluateSQL;
            break;
        case terms.OPERATIONS_ENUM.CSV_DATA_LOAD:
            operation_function = signalJob;
            job_operation_function = csv.csvDataLoad;
            break;
        case terms.OPERATIONS_ENUM.CSV_FILE_LOAD:
            operation_function = signalJob;
            job_operation_function = csv.csvFileLoad;
            break;
        case terms.OPERATIONS_ENUM.CSV_URL_LOAD:
            operation_function = signalJob;
            job_operation_function = csv.csvURLLoad;
            break;
        case terms.OPERATIONS_ENUM.CREATE_SCHEMA:
            operation_function = schema.createSchema;
            break;
        case terms.OPERATIONS_ENUM.CREATE_TABLE:
            operation_function = schema.createTable;
            break;
        case terms.OPERATIONS_ENUM.CREATE_ATTRIBUTE:
            operation_function = schema.createAttribute;
            break;
        case terms.OPERATIONS_ENUM.DROP_SCHEMA:
            operation_function = schema.dropSchema;
            break;
        case terms.OPERATIONS_ENUM.DROP_TABLE:
            operation_function = schema.dropTable;
            break;
        case terms.OPERATIONS_ENUM.DROP_ATTRIBUTE:
            operation_function = schema.dropAttribute;
            break;
        case terms.OPERATIONS_ENUM.DESCRIBE_SCHEMA:
            operation_function = schema.describeSchema;
            break;
        case terms.OPERATIONS_ENUM.DESCRIBE_TABLE:
            operation_function = schema.describeTable;
            break;
        case terms.OPERATIONS_ENUM.DESCRIBE_ALL:
            operation_function = schema.describeAll;
            break;
        case terms.OPERATIONS_ENUM.DELETE:
            operation_function = delete_.delete;
            break;
        case terms.OPERATIONS_ENUM.ADD_USER:
            operation_function = user.addUser;
            break;
        case terms.OPERATIONS_ENUM.ALTER_USER:
            operation_function = user.alterUser;
            break;
        case terms.OPERATIONS_ENUM.DROP_USER:
            operation_function = user.dropUser;
            break;
        case terms.OPERATIONS_ENUM.LIST_USERS:
            operation_function = user.listUsersExternal;
            break;
        case terms.OPERATIONS_ENUM.LIST_ROLES:
            operation_function = role.listRoles;
            break;
        case terms.OPERATIONS_ENUM.ADD_ROLE:
            operation_function = role.addRole;
            break;
        case terms.OPERATIONS_ENUM.ALTER_ROLE:
            operation_function = role.alterRole;
            break;
        case terms.OPERATIONS_ENUM.DROP_ROLE:
            operation_function = role.dropRole;
            break;
        case terms.OPERATIONS_ENUM.USER_INFO:
            operation_function = user.userInfo;
            break;
        case terms.OPERATIONS_ENUM.READ_LOG:
            operation_function = read_log.read_log;
            break;
        case terms.OPERATIONS_ENUM.ADD_NODE:
            operation_function = cluster_utilities.addNode;
            break;
        case terms.OPERATIONS_ENUM.REMOVE_NODE:
            operation_function = cluster_utilities.removeNode;
            break;
        case terms.OPERATIONS_ENUM.CONFIGURE_CLUSTER:
            operation_function = cluster_utilities.configureCluster;
            break;
        case terms.OPERATIONS_ENUM.CLUSTER_STATUS:
            operation_function = cluster_utilities.clusterStatus;
            break;
        case terms.OPERATIONS_ENUM.EXPORT_TO_S3:
            operation_function = signalJob;
            job_operation_function = export_.export_to_s3;
            break;
        case terms.OPERATIONS_ENUM.DELETE_FILES_BEFORE:
            operation_function = signalJob;
            job_operation_function = delete_.deleteFilesBefore;
            break;
        case terms.OPERATIONS_ENUM.EXPORT_LOCAL:
            operation_function = signalJob;
            job_operation_function = export_.export_local;
			break;
        case terms.OPERATIONS_ENUM.SEARCH_JOBS_BY_START_DATE:
            operation_function = jobs.jobHandler;
            break;
        case terms.OPERATIONS_ENUM.GET_JOB:
            operation_function = jobs.jobHandler;
            break;
        case terms.OPERATIONS_ENUM.DELETE_JOB:
            operation_function = jobs.jobHandler;
            break;
        case terms.OPERATIONS_ENUM.UPDATE_JOB:
            operation_function = jobs.updateJob;
            break;
        case terms.OPERATIONS_ENUM.GET_FINGERPRINT:
            operation_function = reg.getFingerprint;
            break;
        case terms.OPERATIONS_ENUM.SET_LICENSE:
            operation_function = reg.setLicense;
            break;
        default:
            break;
    }
    // Here there is a SQL statement in either the operation or the search_operation (from jobs like export_local).  Need to check the perms
    // on all affected tables/attributes.
    try {
        if (json.operation === 'sql' || (json.search_operation && json.search_operation.operation === 'sql')) {
            let sql_statement = (json.operation === 'sql' ? json.sql : json.search_operation.sql);
            let parsed_sql_object = sql.convertSQLToAST(sql_statement);
            json.parsed_sql_object = parsed_sql_object;
            if (!sql.checkASTPermissions(json, parsed_sql_object)) {
                harper_logger.error(`${UNAUTH_RESPONSE} from operation ${json.search_operation}`);
                return callback(UNAUTH_RESPONSE, `${UNAUTH_RESPONSE} from operation ${json.search_operation}`);
            }
        } else {
            let function_to_check = (job_operation_function === undefined ? operation_function : job_operation_function);
            let operation_json = ((json.search_operation) ? json.search_operation : json);
            if (!operation_json.hdb_user) {
                operation_json.hdb_user = json.hdb_user;
            }
            if (!op_auth.verifyPerms(operation_json, function_to_check)) {
                harper_logger.error(`${UNAUTH_RESPONSE} from operation ${json.search_operation}`);
                return callback(UNAUTH_RESPONSE, null);
            }
        }
    } catch (e) {
        // This should catch all non auth related processing errors and return the message
        return callback(e.message, null);
    }
    return callback(null, operation_function);
}

function nullOperation(json, callback) {
    callback('Invalid operation');
}

function signalJob(json, callback) {
    let new_job_object = undefined;
    jobs.addJob(json).then( (result) => {
        new_job_object = result.createdJob;
        let job_runner_message = new job_runner.RunnerMessage(new_job_object, json);
        let job_signal_message = new signal.JobAddedSignalObject(new_job_object.id, job_runner_message);
        if (process.send !== undefined) {
            signal.signalJobAdded(job_signal_message);
            // purposefully not waiting for a response as we want to callback immediately.
        } else {
            try {
                job_runner.parseMessage(job_signal_message.runner_message);
            } catch(e) {
                harper_logger.error(`Got an error trying to run a job with message ${job_runner_message}. ${e}`);
            }
            // purposefully not waiting for a response as we want to callback immediately.
        }

        return callback(null, `Starting job with id ${new_job_object.id}`);
    }).catch(function caughtError(err) {
        let message = `There was an error adding a job: ${err}`;
        harper_logger.error(message);
        return callback(message, null);
    });
}

function operationParameterValid(operation) {
    if (operation === undefined || operation === null) {
        harper_logger.error(OPERATION_PARAM_ERROR_MSG);
        return false;
    }
    return true;
}