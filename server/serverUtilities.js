"use strict";

const search = require('../data_layer/search');
const sql = require('../sqlTranslator/index');
const csv = require('../data_layer/csvBulkLoad');
const schema = require('../data_layer/schema');
const schema_describe = require('../data_layer/schemaDescribe');
const delete_ = require('../data_layer/delete');
const user = require('../security/user');
const role = require('../security/role');
const cluster_utilities = require('./clustering/clusterUtilities');
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

const operation_function_caller = require(`../utility/OperationFunctionCaller`);
const common_utils = require(`../utility/common_utils`);
const env = require(`../utility/environment/environmentManager`);
const master_cluster_rate_limiter = require('../server/apiLimiter/MasterClusterRateLimiter');
const CounterObject = require('../server/apiLimiter/CounterObject');

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

module.exports = {
    chooseOperation,
    getOperationFunction,
    processLocalTransaction,
    postOperationHandler,
    createLimitsTimeout,
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
                const { hdb_user, hdb_auth_header, password, ...clean_body } = req.body;
                harper_logger.info(JSON.stringify(clean_body));
            }
        }
    } catch (e) {
        harper_logger.error(e);
        callback(e);
        setResponseStatus(res, terms.HTTP_STATUS_CODES.INTERNAL_SERVER_ERROR, e);
    }

    let post_op_function = (terms.CLUSTER_OPERATIONS[req.body.operation] === undefined ? null : postOperationHandler);

    operation_function_caller.callOperationFunctionAsAwait(operation_function, req.body, post_op_function)
        .then((data) => {
            if (typeof data !== 'object') {
                data = {"message": data};
            }
            if(data instanceof Error) {
                setResponseStatus(res, terms.HTTP_STATUS_CODES.INTERNAL_SERVER_ERROR, {error: data.message});
            }

            if (GLOBAL_SCHEMA_UPDATE_OPERATIONS_ENUM[req.body.operation]) {
                global_schema.setSchemaDataToGlobal((err) => {
                    if (err) {
                        harper_logger.error(err);
                    }
                });
            }

            setResponseStatus(res, terms.HTTP_STATUS_CODES.OK, data);
            return callback(null, data);
        })
        .catch((error) => {
            harper_logger.info(error);
            if(error === UNAUTH_RESPONSE) {
                setResponseStatus(res, terms.HTTP_STATUS_CODES.FORBIDDEN, {error: UNAUTHORIZED_TEXT});
                return callback(error);
            }
            if(typeof error !== 'object') {
                error = {"error": error};
            }

            if (GLOBAL_SCHEMA_UPDATE_OPERATIONS_ENUM[req.body.operation]) {
                global_schema.setSchemaDataToGlobal((err) => {
                    if (err) {
                        harper_logger.error(err);
                    }
                });
            }

            setResponseStatus(res, terms.HTTP_STATUS_CODES.INTERNAL_SERVER_ERROR, {error: (error.message ? error.message : error.error)});
            return callback(error);
        });
}

/**
 * Add any relevant data from an original request into a newly created outbound message.
 * @param outbound_message - The message about to be sent
 * @param orig_req - An inbound request which may contain relevant data the outbound message needs to contain (such as originator).
 */
function concatSourceMessageHeader(outbound_message, orig_req) {
    if(!outbound_message) {
        harper_logger.error('Invalid message passed to concatSourceMessageHeader');
        return;
    }
    if(!orig_req) {
        harper_logger.error('no orig request data passed to concatSourceMessageHeader');
        return;
    }
    // TODO: Do we need to include anything else in the hdb_header?
    if(orig_req.__originator) {
        if(!outbound_message.__originator) {
            outbound_message.__originator = {};
        }
        outbound_message.__originator = orig_req.__originator;
    }
}

function sendOperationTransaction(transaction_msg, request_body, hashes_to_send, orig_req) {
    if(request_body.schema === terms.SYSTEM_SCHEMA_NAME) {
        return;
    }
    transaction_msg = convertCRUDOperationToTransaction(request_body, hashes_to_send, global.hdb_schema[request_body.schema][request_body.table].hash_attribute);
    if(transaction_msg) {
        if(orig_req) {
            concatSourceMessageHeader(transaction_msg, orig_req);
        }
        common_utils.sendTransactionToSocketCluster(`${request_body.schema}:${request_body.table}`, transaction_msg, env.getProperty(terms.HDB_SETTINGS_NAMES.CLUSTERING_NODE_NAME_KEY));
    }
}

function sendSchemaTransaction(transaction_msg, operation, request_body, orig_req) {
    if(orig_req) {
        concatSourceMessageHeader(transaction_msg, orig_req);
    }
    common_utils.sendTransactionToSocketCluster(operation, transaction_msg, env.getProperty(terms.HDB_SETTINGS_NAMES.CLUSTERING_NODE_NAME_KEY));
}

function postOperationHandler(request_body, result, orig_req) {
    let transaction_msg = common_utils.getClusterMessage(terms.CLUSTERING_MESSAGE_TYPES.HDB_TRANSACTION);
    transaction_msg.__transacted = true;

    switch(request_body.operation) {
        case terms.OPERATIONS_ENUM.INSERT:
            try {
                sendOperationTransaction(transaction_msg, request_body, result.inserted_hashes, orig_req);
                sendAttributeTransaction(result, request_body, transaction_msg, orig_req);
            } catch(err) {
                harper_logger.error('There was an error calling insert followup function.');
                harper_logger.error(err);
            }
            break;
        case terms.OPERATIONS_ENUM.DELETE:
            try {
                sendOperationTransaction(transaction_msg, request_body, result.deleted_hashes, orig_req);
            } catch(err) {
                harper_logger.error('There was an error calling delete followup function.');
                harper_logger.error(err);
            }
            break;
        case terms.OPERATIONS_ENUM.UPDATE:
            try {
                sendOperationTransaction(transaction_msg, request_body, result.update_hashes, orig_req);
                sendAttributeTransaction(result, request_body, transaction_msg, orig_req);
            } catch(err) {
                harper_logger.error('There was an error calling delete followup function.');
                harper_logger.error(err);
            }
            break;
        case terms.OPERATIONS_ENUM.CREATE_SCHEMA:
            try {

                transaction_msg.transaction = {
                    operation: terms.OPERATIONS_ENUM.CREATE_SCHEMA,
                    schema: request_body.schema,
                };
                sendSchemaTransaction(transaction_msg, terms.INTERNAL_SC_CHANNELS.CREATE_SCHEMA, request_body, orig_req);
            } catch(err) {
                harper_logger.error('There was a problem sending the create_schema transaction to the cluster.');
            }
            break;
        case terms.OPERATIONS_ENUM.CREATE_TABLE:
            try {
                transaction_msg.transaction = {
                    operation: terms.OPERATIONS_ENUM.CREATE_TABLE,
                    schema: request_body.schema,
                    table: request_body.table,
                    hash_attribute: request_body.hash_attribute
                };
                sendSchemaTransaction(transaction_msg, terms.INTERNAL_SC_CHANNELS.CREATE_TABLE, request_body, orig_req);
            } catch(err) {
                harper_logger.error('There was a problem sending the create_schema transaction to the cluster.');
            }
            break;
        case terms.OPERATIONS_ENUM.CREATE_ATTRIBUTE:
            try {
                transaction_msg.transaction = {
                    operation: terms.OPERATIONS_ENUM.CREATE_ATTRIBUTE,
                    schema: request_body.schema,
                    table: request_body.table,
                    attribute: request_body.attribute
                };
                if(orig_req) {
                    concatSourceMessageHeader(transaction_msg, orig_req);
                }
                common_utils.sendTransactionToSocketCluster(terms.INTERNAL_SC_CHANNELS.CREATE_ATTRIBUTE, transaction_msg, env.getProperty(terms.HDB_SETTINGS_NAMES.CLUSTERING_NODE_NAME_KEY));
            } catch(err) {
                harper_logger.error('There was a problem sending the create_schema transaction to the cluster.');
            }
            break;
        case terms.OPERATIONS_ENUM.CSV_DATA_LOAD:
            try {
                transaction_msg.transaction = {
                    operation: terms.OPERATIONS_ENUM.CSV_DATA_LOAD,
                    schema: request_body.schema,
                    table: request_body.table,
                    attribute: request_body.attribute
                };
                sendSchemaTransaction(transaction_msg, terms.OPERATIONS_ENUM.CREATE_ATTRIBUTE, request_body, orig_req);
            } catch(err) {
                harper_logger.error('There was a problem sending the create_schema transaction to the cluster.');
            }
            break;
        default:
            //do nothing
            break;
    }
    return result;
}

/**
 * Converts a core CRUD operation to a cluster read message.
 * @param source_json - The source message body
 * @param affected_hashes - Affected (successful) CRUD hashes
 * @param hash_attribute - hash attribute of the target table.
 * @returns {*}
 */
function convertCRUDOperationToTransaction(source_json, affected_hashes, hash_attribute) {
    if (global.hdb_socket_client === undefined || Array.isArray(affected_hashes) && affected_hashes.length === 0) {
        return null;
    }
    let transaction = {
        operation: source_json.operation,
        schema: source_json.schema,
        table: source_json.table
    };

    if(source_json.operation === terms.OPERATIONS_ENUM.DELETE) {
        transaction.hash_values = [];
    } else{
        transaction.records = [];
    }

    source_json.records.forEach(record => {
        if (affected_hashes.indexOf(common_utils.autoCast(record[hash_attribute])) >= 0) {
            if(source_json.operation === terms.OPERATIONS_ENUM.DELETE) {
                transaction.hash_values.push(record[hash_attribute]);
            } else {
                transaction.records.push(record);
            }
        }
    });

    let transaction_msg = common_utils.getClusterMessage(terms.CLUSTERING_MESSAGE_TYPES.HDB_TRANSACTION);
    transaction_msg.transaction = transaction;
    return transaction_msg;
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
    harper_logger.trace(`getOperationFunction with operation: ${json.operation}`);
    let operation_function = nullOperationAwait;
    let job_operation_function = undefined;

    switch (json.operation) {
        case terms.OPERATIONS_ENUM.INSERT:
            operation_function = insert.insert;
            break;
        case terms.OPERATIONS_ENUM.UPDATE:
            operation_function = insert.update;
            break;
        case terms.OPERATIONS_ENUM.SEARCH_BY_HASH:
            operation_function = p_search_search_by_hash;
            break;
        case terms.OPERATIONS_ENUM.SEARCH_BY_VALUE:
            operation_function = p_search_search_by_value;
            break;
        case terms.OPERATIONS_ENUM.SEARCH:
            operation_function = p_search_search;
            break;
        case terms.OPERATIONS_ENUM.SQL:
            operation_function = p_sql_evaluate_sql;
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
            operation_function = schema_describe.describeSchema;
            break;
        case terms.OPERATIONS_ENUM.DESCRIBE_TABLE:
            operation_function = schema_describe.describeTable;
            break;
        case terms.OPERATIONS_ENUM.DESCRIBE_ALL:
            operation_function = schema_describe.describeAll;
            break;
        case terms.OPERATIONS_ENUM.DELETE:
            operation_function = p_delete;
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
            operation_function = harper_logger.readLog;
            break;
        case terms.OPERATIONS_ENUM.ADD_NODE:
            operation_function = cluster_utilities.addNode;
            break;
        case terms.OPERATIONS_ENUM.UPDATE_NODE:
            operation_function = cluster_utilities.updateNode;
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
        case terms.OPERATIONS_ENUM.RESTART:
            operation_function = stop.restartProcesses;
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

async function catchup(req) {
    harper_logger.trace('In serverUtils.catchup');
    let catchup_object = req.transaction;
    let split_channel = catchup_object.channel.split(':');

    let schema = split_channel[0];
    let table = split_channel[1];
    for (let transaction of catchup_object.transactions) {
        try {
            transaction.schema = schema;
            transaction.table = table;
            let result;
            switch (transaction.operation) {
                case terms.OPERATIONS_ENUM.INSERT:
                    result = await insert.insert(transaction);
                    break;
                case terms.OPERATIONS_ENUM.UPDATE:
                    result = await insert.update(transaction);
                    break;
                case terms.OPERATIONS_ENUM.DELETE:
                    result = await delete_.delete(transaction);
                    break;
                default:
                    harper_logger.warn('invalid operation in catchup');
                    break;
            }

            postOperationHandler(transaction, result, req);
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
        let message = `There was an error adding a job: ${err}`;
        harper_logger.error(message);
        throw new Error(message);
    }
}

function createLimitsTimeout(limiter_name_string, master_rate_limiter, timout_interval_ms) {
    setTimeout(async (info) => {
        try {
            harper_logger.debug('Restoring limits');
            let points = master_rate_limiter._rateLimiters[`apiclusterlimiter`].points;

        } catch (err) {
            harper_logger.log(err);
        }
    }, timout_interval_ms);
}

/**
 * Propagates attribute metadata across the entire cluster.
 * @param result
 * @param request_body
 * @param transaction_msg
 * @param original_req
 */
function sendAttributeTransaction(result, request_body, transaction_msg, original_req) {
    if (!common_utils.isEmptyOrZeroLength(result.new_attributes) && request_body.schema !== terms.SYSTEM_SCHEMA_NAME) {
        result.new_attributes.forEach((attribute) => {
            transaction_msg.transaction = {
                operation: terms.OPERATIONS_ENUM.CREATE_ATTRIBUTE,
                schema: request_body.schema,
                table: request_body.table,
                attribute: attribute
            };

            sendSchemaTransaction(transaction_msg, terms.INTERNAL_SC_CHANNELS.CREATE_ATTRIBUTE, request_body, original_req);
        });
    }
}
