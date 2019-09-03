"use strict";

const uuidv1 = require('uuid/v1');
const search = require('../data_layer/search');
const sql = require('../sqlTranslator/index');
const csv = require('../data_layer/csvBulkLoad');
const schema = require('../data_layer/schema');
const schema_describe = require('../data_layer/schemaDescribe');
const delete_ = require('../data_layer/delete');
const user = require('../security/user');
const role = require('../security/role');
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
const stop = require('../bin/stop');
const util = require('util');
const insert = require('../data_layer/insert');
const global_schema = require('../utility/globalSchema');
/**
 * Callback functions are still heavily relied on.
 * Callbackify takes an async function and converts to an error-first callback style function.
* */
const cb_insert_insert = util.callbackify(insert.insert);
const cb_insert_update = util.callbackify(insert.update);
const cb_schema_drop_attribute = util.callbackify(schema.dropAttribute);
const cb_user_add_user = util.callbackify(user.addUser);
const cb_user_alter_user = util.callbackify(user.alterUser);
const cb_user_drop_user = util.callbackify(user.dropUser);
const cb_user_user_info = util.callbackify(user.userInfo);
const cb_user_list_user_external = util.callbackify(user.listUsersExternal);
const cb_role_add_role = util.callbackify(role.addRole);
const cb_role_alter_role = util.callbackify(role.alterRole);
const cb_role_drop_role = util.callbackify(role.dropRole);
const cb_role_list_role = util.callbackify(role.listRoles);
const cb_reg_hand_get_finger = util.callbackify(reg.getFingerprint);
const cb_reg_hand_set_licence = util.callbackify(reg.setLicense);
const cb_clust_util_config = util.callbackify(cluster_utilities.configureCluster);
const cb_clust_util_status = util.callbackify(cluster_utilities.clusterStatus);
const cb_clust_util_add_node = util.callbackify(cluster_utilities.addNode);
const cb_clust_util_update_node = util.callbackify(cluster_utilities.updateNode);
const cb_clust_util_remove_node = util.callbackify(cluster_utilities.removeNode);
const cb_schema_create_schema = util.callbackify(schema.createSchema);
const cb_schema_create_attribute = util.callbackify(schema.createAttribute);
const cb_schema_create_table = util.callbackify(schema.createTable);
const cb_schema_drop_schema = util.callbackify(schema.dropSchema);
const cb_schema_drop_table = util.callbackify(schema.dropTable);
const cb_read_log = util.callbackify(harper_logger.readLog);

const UNAUTH_RESPONSE = 403;
const UNAUTHORIZED_TEXT = 'You are not authorized to perform the operation specified';
let OPERATION_PARAM_ERROR_MSG = `operation parameter is undefined`;

let GLOBAL_SCHEMA_UPDATE_FUNCTIONS = {};
GLOBAL_SCHEMA_UPDATE_FUNCTIONS[terms.OPERATIONS_ENUM.CREATE_ATTRIBUTE] = '';
GLOBAL_SCHEMA_UPDATE_FUNCTIONS[terms.OPERATIONS_ENUM.CREATE_TABLE] = '';
GLOBAL_SCHEMA_UPDATE_FUNCTIONS[terms.OPERATIONS_ENUM.CREATE_SCHEMA] = '';
GLOBAL_SCHEMA_UPDATE_FUNCTIONS[terms.OPERATIONS_ENUM.DROP_ATTRIBUTE] = '';
GLOBAL_SCHEMA_UPDATE_FUNCTIONS[terms.OPERATIONS_ENUM.DROP_TABLE] = '';
GLOBAL_SCHEMA_UPDATE_FUNCTIONS[terms.OPERATIONS_ENUM.DROP_SCHEMA] = '';

module.exports = {
    chooseOperation: chooseOperation,
    getOperationFunction: getOperationFunction,
    processLocalTransaction: processLocalTransaction,
    UNAUTH_RESPONSE,
    UNAUTHORIZED_TEXT
};

/**
 * This will process a command message on this receiving node rather than sending it to a remote node.  NOTE: this function
 * handles the response to the sender.
 * @param req
 * @param res
 * @param operation_function
 * @param callback
 * @returns {*}
 */
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
        setResponseStatus(res, terms.HTTP_STATUS_CODES.INTERNAL_SERVER_ERROR, e);
    }

    operation_function(req.body, (error, data) => {
        if (GLOBAL_SCHEMA_UPDATE_FUNCTIONS[req.body.operation]) {
            global_schema.setSchemaDataToGlobal((err) => {
                if (err) {
                    harper_logger.error(err);
                }
            });
        }

        if (error) {
            harper_logger.info(error);

            if (GLOBAL_SCHEMA_UPDATE_FUNCTIONS[req.body.operation]) {
                global_schema.setSchemaDataToGlobal((err) => {
                    if (err) {
                        harper_logger.error(err);
                    }
                });
            }

            if(error === UNAUTH_RESPONSE) {
                setResponseStatus(res, terms.HTTP_STATUS_CODES.FORBIDDEN, {error: UNAUTHORIZED_TEXT});
                return callback(error);
            }
            if(typeof error !== 'object') {
                error = {"error": error};
            }
            setResponseStatus(res, terms.HTTP_STATUS_CODES.INTERNAL_SERVER_ERROR, {error: (error.message ? error.message : error.error)});
            return callback(error);
        }
        if (typeof data !== 'object')
            data = {"message": data};
        setResponseStatus(res, terms.HTTP_STATUS_CODES.OK, data);
        return callback(null, data);
    });
}

/**
 * Wrapper for writing status, checks to see if the header is sent already.
 * @param res - the response object
 * @param status - the status object
 * @param msg - the response message.
 */
function setResponseStatus(res, status, msg) {
    try {
        if(!res._headerSent) {
            res.status(status).json(msg);
        }
    } catch(err) {
        harper_logger.info('Tried to set response status, but it has already been set.');
    }
}

// TODO: This doesn't really need a callback, should simplify it to a return statement.
function chooseOperation(json, callback) {
    if (json === undefined || json === null) {
        harper_logger.error(`invalid message body parameters found`);
        return nullOperation(json, callback);
    }

    let {operation_function, job_operation_function} = getOperationFunction(json);
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

function getOperationFunction(json){

    let operation_function = nullOperation;
    let job_operation_function = undefined;

    switch (json.operation) {
        case terms.OPERATIONS_ENUM.INSERT:
            operation_function = cb_insert_insert;
            break;
        case terms.OPERATIONS_ENUM.UPDATE:
            operation_function = cb_insert_update;
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
            operation_function = cb_schema_create_schema;
            break;
        case terms.OPERATIONS_ENUM.CREATE_TABLE:
            operation_function = cb_schema_create_table;
            break;
        case terms.OPERATIONS_ENUM.CREATE_ATTRIBUTE:
            operation_function = cb_schema_create_attribute;
            break;
        case terms.OPERATIONS_ENUM.DROP_SCHEMA:
            operation_function = cb_schema_drop_schema;
            break;
        case terms.OPERATIONS_ENUM.DROP_TABLE:
            operation_function = cb_schema_drop_table;
            break;
        case terms.OPERATIONS_ENUM.DROP_ATTRIBUTE:
            operation_function = cb_schema_drop_attribute;
            break;
        case terms.OPERATIONS_ENUM.DESCRIBE_SCHEMA:
            operation_function = schema_describe.describeSchema;
            break;
        case terms.OPERATIONS_ENUM.DESCRIBE_TABLE:
            operation_function = schema_describe.describeTable;
            break;
        case terms.OPERATIONS_ENUM.DESCRIBE_ALL:
            operation_function = schema_describe.describeAll;
            break;
        case terms.OPERATIONS_ENUM.DELETE:
            operation_function = delete_.delete;
            break;
        case terms.OPERATIONS_ENUM.ADD_USER:
            operation_function = cb_user_add_user;
            break;
        case terms.OPERATIONS_ENUM.ALTER_USER:
            operation_function = cb_user_alter_user;
            break;
        case terms.OPERATIONS_ENUM.DROP_USER:
            operation_function = cb_user_drop_user;
            break;
        case terms.OPERATIONS_ENUM.LIST_USERS:
            operation_function = cb_user_list_user_external;
            break;
        case terms.OPERATIONS_ENUM.LIST_ROLES:
            operation_function = cb_role_list_role;
            break;
        case terms.OPERATIONS_ENUM.ADD_ROLE:
            operation_function = cb_role_add_role;
            break;
        case terms.OPERATIONS_ENUM.ALTER_ROLE:
            operation_function = cb_role_alter_role;
            break;
        case terms.OPERATIONS_ENUM.DROP_ROLE:
            operation_function = cb_role_drop_role;
            break;
        case terms.OPERATIONS_ENUM.USER_INFO:
            operation_function = cb_user_user_info;
            break;
        case terms.OPERATIONS_ENUM.READ_LOG:
            operation_function = cb_read_log;
            break;
        case terms.OPERATIONS_ENUM.ADD_NODE:
            operation_function = cb_clust_util_add_node;
            break;
        case terms.OPERATIONS_ENUM.UPDATE_NODE:
            operation_function = cb_clust_util_update_node;
            break;
        case terms.OPERATIONS_ENUM.REMOVE_NODE:
            operation_function = cb_clust_util_remove_node;
            break;
        case terms.OPERATIONS_ENUM.CONFIGURE_CLUSTER:
            operation_function = cb_clust_util_config;
            break;
        case terms.OPERATIONS_ENUM.CLUSTER_STATUS:
            operation_function = cb_clust_util_status;
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
            operation_function = cb_reg_hand_get_finger;
            break;
        case terms.OPERATIONS_ENUM.SET_LICENSE:
            operation_function = cb_reg_hand_set_licence;
            break;
        case terms.OPERATIONS_ENUM.RESTART:
            // TODO: Does callbackify work?
            let restart_cb = util.callbackify(stop.restartProcesses);
            operation_function = restart_cb;
            break;
        case terms.OPERATIONS_ENUM.CATCHUP:
            operation_function = catchup;
            break;
        default:
            break;
    }

    return {
        operation_function: operation_function,
        job_operation_function: job_operation_function
    };
}

async function catchup(catchup_object) {
    let split_channel = catchup_object.channel.split(':');

    let schema = split_channel[0];
    let table = split_channel[1];
    let originator = catchup_object.__originator;
    for (let transaction of catchup_object.transactions) {
        try {
            transaction.schema = schema;
            transaction.table = table;
            transaction.__originator = originator;
            switch (transaction.operation) {
                case terms.OPERATIONS_ENUM.INSERT:
                    await insert.insert(transaction);
                    break;
                case terms.OPERATIONS_ENUM.UPDATE:
                    await insert.update(transaction);
                    break;
                case terms.OPERATIONS_ENUM.DELETE:
                    await delete_.delete(transaction);
                    break;
                default:
                    harper_logger.warn('invalid operation in catchup');
                    break;
            }
        }catch(e){
            harper_logger.error(e);
        }
    }
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