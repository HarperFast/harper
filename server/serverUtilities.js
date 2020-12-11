"use strict";

const search = require('../data_layer/search');
const sql = require('../sqlTranslator/index');
const bulkLoad = require('../data_layer/bulkLoad');
const schema = require('../data_layer/schema');
const schema_describe = require('../data_layer/schemaDescribe');
const delete_ = require('../data_layer/delete');
const read_transaction_log = require('../data_layer/readTransactionLog');
const user = require('../security/user');
const role = require('../security/role');
const cluster_utilities = require('./clustering/clusterUtilities');
const harper_logger = require('../utility/logging/harper_logger');
const export_ = require('../data_layer/export');
const op_auth = require('../utility/operation_authorization');
const jobs = require('./jobs');
const terms = require('../utility/hdbTerms');
const { hdb_errors, handleHDBError } = require('../utility/errors/hdbError');
const reg = require('../utility/registration/registrationHandler');
const stop = require('../bin/stop');
const util = require('util');
const insert = require('../data_layer/insert');
const global_schema = require('../utility/globalSchema');
const system_information = require('../utility/environment/systemInformation');
const transact_to_clustering_utils = require('./transactToClusteringUtilities');
const job_runner = require('./jobRunner');
const signal = require('../utility/signalling');
const token_authentication = require('../security/tokenAuthentication');
const configuration = require('../server/configuration');

const operation_function_caller = require(`../utility/OperationFunctionCaller`);

const UNAUTH_RESPONSE = 403;
const UNAUTHORIZED_TEXT = 'You are not authorized to perform the operation specified';

const p_search_search_by_hash = util.promisify(search.searchByHash);
const p_search_search_by_value = util.promisify(search.searchByValue);
const p_search_search = util.promisify(search.search);
const p_sql_evaluate_sql = util.promisify(sql.evaluateSQL);
const p_delete = util.promisify(delete_.delete);

const GLOBAL_SCHEMA_UPDATE_OPERATIONS_ENUM = {
    [terms.OPERATIONS_ENUM.CREATE_ATTRIBUTE]: true,
    [terms.OPERATIONS_ENUM.CREATE_TABLE]: true,
    [terms.OPERATIONS_ENUM.CREATE_SCHEMA]: true,
    [terms.OPERATIONS_ENUM.DROP_ATTRIBUTE]: true,
    [terms.OPERATIONS_ENUM.DROP_TABLE]: true,
    [terms.OPERATIONS_ENUM.DROP_SCHEMA]: true
};

const OperationFunctionObject = require('./OperationFunctionObject');

const OPERATION_FUNCTION_MAP = initializeOperationFunctionMap();

module.exports = {
    chooseOperation,
    getOperationFunction,
    processLocalTransaction,
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
                // eslint-disable-next-line no-unused-vars
                const { hdb_user, hdb_auth_header, password, ...clean_body } = req.body;
                harper_logger.info(JSON.stringify(clean_body));
            }
        }
    } catch (e) {
        harper_logger.error(e);

        setResponseStatus(res, hdb_errors.HTTP_STATUS_CODES.INTERNAL_SERVER_ERROR, e);
        return callback(e);
    }

    let post_op_function = (terms.CLUSTER_OPERATIONS[req.body.operation] === undefined ? null : transact_to_clustering_utils.postOperationHandler);

    operation_function_caller.callOperationFunctionAsAwait(operation_function, req.body, post_op_function)
        .then((data) => {
            if (typeof data !== 'object') {
                data = {"message": data};
            }
            if(data instanceof Error) {
                setResponseStatus(res, hdb_errors.HTTP_STATUS_CODES.INTERNAL_SERVER_ERROR, {error: data.message});
            }

            if (GLOBAL_SCHEMA_UPDATE_OPERATIONS_ENUM[req.body.operation]) {
                global_schema.setSchemaDataToGlobal((err) => {
                    if (err) {
                        harper_logger.error(err);
                    }
                });
            }

            setResponseStatus(res, hdb_errors.HTTP_STATUS_CODES.OK, data);
            return callback(null, data);
        })
        .catch((error) => {
            harper_logger.info(error);
            if(error === UNAUTH_RESPONSE) {
                setResponseStatus(res, hdb_errors.HTTP_STATUS_CODES.FORBIDDEN, {error: UNAUTHORIZED_TEXT});
                return callback(error);
            }
            if(typeof error !== 'object') {
                error = { message: error };
            }

            //This final response status and error msg evaluation is required while we transition to using the new error
            // handling process with HDBError and the new properties set on the new error type
            const http_resp_status = error.http_resp_code ? error.http_resp_code : hdb_errors.HTTP_STATUS_CODES.INTERNAL_SERVER_ERROR;
            const http_resp_msg = error.http_resp_msg ? error.http_resp_msg : error.message ? error.message : hdb_errors.DEFAULT_ERROR_RESP;
            const error_msg = http_resp_msg.error ? http_resp_msg : { error: http_resp_msg};
            setResponseStatus(res, http_resp_status, error_msg);
            return callback(error);
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
        if (!res._headerSent) {
            res.status(status).send(msg);
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

    let getOpResult;
    try {
        getOpResult = getOperationFunction(json);
    } catch(err) {
        return callback(err, null);
    }

    const { operation_function, job_operation_function } = getOpResult;

    // Here there is a SQL statement in either the operation or the search_operation (from jobs like export_local).  Need to check the perms
    // on all affected tables/attributes.
    try {
        if (json.operation === 'sql' || (json.search_operation && json.search_operation.operation === 'sql')) {
            let sql_statement = (json.operation === 'sql' ? json.sql : json.search_operation.sql);
            let parsed_sql_object = sql.convertSQLToAST(sql_statement);
            json.parsed_sql_object = parsed_sql_object;
            let ast_perm_check = sql.checkASTPermissions(json, parsed_sql_object);
            if (ast_perm_check) {
                harper_logger.error(`${UNAUTH_RESPONSE} from operation ${json.search_operation}`);
                return callback(ast_perm_check, null);
            }
        //we need to bypass permission checks to allow the create_authorization_tokens
        } else if(json.operation !== terms.OPERATIONS_ENUM.CREATE_AUTHENTICATION_TOKENS){
            let function_to_check = (job_operation_function === undefined ? operation_function : job_operation_function);
            let operation_json = ((json.search_operation) ? json.search_operation : json);
            if (!operation_json.hdb_user) {
                operation_json.hdb_user = json.hdb_user;
            }

            let verify_perms_result = op_auth.verifyPerms(operation_json, function_to_check);

            if (verify_perms_result) {
                harper_logger.error(`${UNAUTH_RESPONSE} from operation ${json.operation}`);
                return callback(verify_perms_result, null);
            }
        }
    } catch (e) {
        // The below scenarios should catch all non auth related processing errors and return the message
        if (e.http_resp_code) {
            return callback(e, null);
        }
        return callback(e.message, null);
    }
    return callback(null, operation_function);
}

function getOperationFunction(json){
    harper_logger.trace(`getOperationFunction with operation: ${json.operation}`);

    if (OPERATION_FUNCTION_MAP.has(json.operation)){
        return OPERATION_FUNCTION_MAP.get(json.operation);
    }

    throw handleHDBError(new Error(), hdb_errors.HDB_ERROR_MSGS.OP_NOT_FOUND(json.operation), hdb_errors.HTTP_STATUS_CODES.BAD_REQUEST);
}

async function catchup(req) {
    harper_logger.trace('In serverUtils.catchup');
    let catchup_object = req.transaction;
    let split_channel = catchup_object.channel.split(':');

    let _schema = split_channel[0];
    let table = split_channel[1];
    for (let transaction of catchup_object.transactions) {
        try {
            transaction.schema = _schema;
            transaction.table = table;
            let result;
            switch (transaction.operation) {
                case terms.OPERATIONS_ENUM.INSERT:
                    result = await insert.insert(transaction);
                    break;
                case terms.OPERATIONS_ENUM.UPDATE:
                    result = await insert.update(transaction);
                    break;
                case terms.OPERATIONS_ENUM.UPSERT:
                    result = await insert.upsert(transaction);
                    break;
                case terms.OPERATIONS_ENUM.DELETE:
                    result = await delete_.delete(transaction);
                    break;
                default:
                    harper_logger.warn('invalid operation in catchup');
                    break;
            }

            transact_to_clustering_utils.postOperationHandler(transaction, result, req);
        } catch(e) {
            harper_logger.info('Invalid operation in transaction');
            harper_logger.error(e);
        }
    }
}

function nullOperation(json, callback) {
    callback('Invalid operation');
}

async function nullOperationAwait(json) {
    throw new Error('Invalid operation');
}

async function signalJob(json) {
    let new_job_object = undefined;
    let result = undefined;
    try {
        result = await jobs.addJob(json);
        new_job_object = result.createdJob;
        let job_runner_message = new job_runner.RunnerMessage(new_job_object, json);
        let job_signal_message = new signal.JobAddedSignalObject(new_job_object.id, job_runner_message);
        if (process.send !== undefined) {
            signal.signalJobAdded(job_signal_message);
        } else {
            try {
                // purposefully not waiting for await response as we want to callback immediately.
                job_runner.parseMessage(job_signal_message.runner_message);
            } catch (e) {
                harper_logger.error(`Got an error trying to run a job with message ${job_runner_message}. ${e}`);
            }
        }
        return `Starting job with id ${new_job_object.id}`;
    } catch (err) {
        let message = `There was an error adding a job: ${err.http_resp_msg ? err.http_resp_msg : err}`;
        harper_logger.error(message);
        throw handleHDBError(err, message);
    }
}

function initializeOperationFunctionMap(){
    let op_func_map = new Map();

    op_func_map.set(terms.OPERATIONS_ENUM.INSERT, new OperationFunctionObject(insert.insert));
    op_func_map.set(terms.OPERATIONS_ENUM.UPDATE, new OperationFunctionObject(insert.update));
    op_func_map.set(terms.OPERATIONS_ENUM.UPSERT, new OperationFunctionObject(insert.upsert));
    op_func_map.set(terms.OPERATIONS_ENUM.SEARCH_BY_HASH, new OperationFunctionObject(p_search_search_by_hash));
    op_func_map.set(terms.OPERATIONS_ENUM.SEARCH_BY_VALUE, new OperationFunctionObject(p_search_search_by_value));
    op_func_map.set(terms.OPERATIONS_ENUM.SEARCH, new OperationFunctionObject(p_search_search));
    op_func_map.set(terms.OPERATIONS_ENUM.SQL, new OperationFunctionObject(p_sql_evaluate_sql));
    op_func_map.set(terms.OPERATIONS_ENUM.CSV_DATA_LOAD, new OperationFunctionObject(signalJob, bulkLoad.csvDataLoad));
    op_func_map.set(terms.OPERATIONS_ENUM.CSV_FILE_LOAD, new OperationFunctionObject(signalJob, bulkLoad.csvFileLoad));
    op_func_map.set(terms.OPERATIONS_ENUM.CSV_URL_LOAD, new OperationFunctionObject(signalJob, bulkLoad.csvURLLoad));
    op_func_map.set(terms.OPERATIONS_ENUM.IMPORT_FROM_S3, new OperationFunctionObject(signalJob, bulkLoad.importFromS3));
    op_func_map.set(terms.OPERATIONS_ENUM.CREATE_SCHEMA, new OperationFunctionObject(schema.createSchema));
    op_func_map.set(terms.OPERATIONS_ENUM.CREATE_TABLE, new OperationFunctionObject(schema.createTable));
    op_func_map.set(terms.OPERATIONS_ENUM.CREATE_ATTRIBUTE, new OperationFunctionObject(schema.createAttribute));
    op_func_map.set(terms.OPERATIONS_ENUM.DROP_SCHEMA, new OperationFunctionObject(schema.dropSchema));
    op_func_map.set(terms.OPERATIONS_ENUM.DROP_TABLE, new OperationFunctionObject(schema.dropTable));
    op_func_map.set(terms.OPERATIONS_ENUM.DROP_ATTRIBUTE, new OperationFunctionObject(schema.dropAttribute));
    op_func_map.set(terms.OPERATIONS_ENUM.DESCRIBE_SCHEMA, new OperationFunctionObject(schema_describe.describeSchema));
    op_func_map.set(terms.OPERATIONS_ENUM.DESCRIBE_TABLE, new OperationFunctionObject(schema_describe.describeTable));
    op_func_map.set(terms.OPERATIONS_ENUM.DESCRIBE_ALL, new OperationFunctionObject(schema_describe.describeAll));
    op_func_map.set(terms.OPERATIONS_ENUM.DELETE, new OperationFunctionObject(p_delete));
    op_func_map.set(terms.OPERATIONS_ENUM.ADD_USER, new OperationFunctionObject(user.addUser));
    op_func_map.set(terms.OPERATIONS_ENUM.ALTER_USER, new OperationFunctionObject(user.alterUser));
    op_func_map.set(terms.OPERATIONS_ENUM.DROP_USER, new OperationFunctionObject(user.dropUser));
    op_func_map.set(terms.OPERATIONS_ENUM.LIST_USERS, new OperationFunctionObject(user.listUsersExternal));
    op_func_map.set(terms.OPERATIONS_ENUM.LIST_ROLES, new OperationFunctionObject(role.listRoles));
    op_func_map.set(terms.OPERATIONS_ENUM.ADD_ROLE, new OperationFunctionObject(role.addRole));
    op_func_map.set(terms.OPERATIONS_ENUM.ALTER_ROLE, new OperationFunctionObject(role.alterRole));
    op_func_map.set(terms.OPERATIONS_ENUM.DROP_ROLE, new OperationFunctionObject(role.dropRole));
    op_func_map.set(terms.OPERATIONS_ENUM.USER_INFO, new OperationFunctionObject(user.userInfo));
    op_func_map.set(terms.OPERATIONS_ENUM.READ_LOG, new OperationFunctionObject(harper_logger.readLog));
    op_func_map.set(terms.OPERATIONS_ENUM.ADD_NODE, new OperationFunctionObject(cluster_utilities.addNode));
    op_func_map.set(terms.OPERATIONS_ENUM.UPDATE_NODE, new OperationFunctionObject(cluster_utilities.updateNode));
    op_func_map.set(terms.OPERATIONS_ENUM.REMOVE_NODE, new OperationFunctionObject(cluster_utilities.removeNode));
    op_func_map.set(terms.OPERATIONS_ENUM.CONFIGURE_CLUSTER, new OperationFunctionObject(cluster_utilities.configureCluster));
    op_func_map.set(terms.OPERATIONS_ENUM.CLUSTER_STATUS, new OperationFunctionObject(cluster_utilities.clusterStatus));
    op_func_map.set(terms.OPERATIONS_ENUM.EXPORT_TO_S3, new OperationFunctionObject(signalJob, export_.export_to_s3));
    op_func_map.set(terms.OPERATIONS_ENUM.DELETE_FILES_BEFORE, new OperationFunctionObject(signalJob, delete_.deleteFilesBefore));
    op_func_map.set(terms.OPERATIONS_ENUM.EXPORT_LOCAL, new OperationFunctionObject(signalJob, export_.export_local));
    op_func_map.set(terms.OPERATIONS_ENUM.SEARCH_JOBS_BY_START_DATE, new OperationFunctionObject(jobs.handleGetJobsByStartDate));
    op_func_map.set(terms.OPERATIONS_ENUM.GET_JOB, new OperationFunctionObject(jobs.handleGetJob));
    op_func_map.set(terms.OPERATIONS_ENUM.GET_FINGERPRINT, new OperationFunctionObject(reg.getFingerprint));
    op_func_map.set(terms.OPERATIONS_ENUM.SET_LICENSE, new OperationFunctionObject(reg.setLicense));
    op_func_map.set(terms.OPERATIONS_ENUM.GET_REGISTRATION_INFO, new OperationFunctionObject(reg.getRegistrationInfo));
    op_func_map.set(terms.OPERATIONS_ENUM.RESTART, new OperationFunctionObject(stop.restartProcesses));
    op_func_map.set(terms.OPERATIONS_ENUM.CATCHUP, new OperationFunctionObject(catchup));
    op_func_map.set(terms.OPERATIONS_ENUM.SYSTEM_INFORMATION, new OperationFunctionObject(system_information.systemInformation));
    op_func_map.set(terms.OPERATIONS_ENUM.DELETE_TRANSACTION_LOGS_BEFORE, new OperationFunctionObject(signalJob, delete_.deleteTransactionLogsBefore));
    op_func_map.set(terms.OPERATIONS_ENUM.READ_TRANSACTION_LOG, new OperationFunctionObject(read_transaction_log));
    op_func_map.set(terms.OPERATIONS_ENUM.CREATE_AUTHENTICATION_TOKENS, new OperationFunctionObject(token_authentication.createTokens));
    op_func_map.set(terms.OPERATIONS_ENUM.REFRESH_OPERATION_TOKEN, new OperationFunctionObject(token_authentication.refreshOperationToken));
    op_func_map.set(terms.OPERATIONS_ENUM.GET_CONFIGURATION, new OperationFunctionObject(configuration.getConfiguration));

    return op_func_map;
}
