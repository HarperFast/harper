"use strict";
const path = require('path');
const fs = require('fs-extra');
const log = require('./logging/harper_logger');
const fs_extra = require('fs-extra');
const truncate = require('truncate-utf8-bytes');
const os = require('os');
const terms = require('./hdbTerms');
const ps_list = require('./psList');
const papa_parse = require('papaparse');
const cluster_messages = require('../server/socketcluster/room/RoomMessageObjects');
const {inspect} = require('util');

const async_set_timeout = require('util').promisify(setTimeout);
const HDB_PROC_START_TIMEOUT = 100;
const CHECK_PROCS_LOOP_LIMIT = 5;

const EMPTY_STRING = '';
const FILE_EXTENSION_LENGTH = 4;
const CHARACTER_LIMIT = 255;

const HDB_PROC_NAME = 'hdb_express.js';

//Because undefined will not return in a JSON response, we convert undefined to null when autocasting
const AUTOCAST_COMMON_STRINGS = {
    'true': true,
    'false': false,
    'undefined': null,
    'null': null,
    'NaN': NaN
};

module.exports = {
    isEmpty:isEmpty,
    isEmptyOrZeroLength:isEmptyOrZeroLength,
    arrayHasEmptyValues:arrayHasEmptyValues,
    arrayHasEmptyOrZeroLengthValues:arrayHasEmptyOrZeroLengthValues,
    buildFolderPath: buildFolderPath,
    isBoolean: isBoolean,
    errorizeMessage: errorizeMessage,
    stripFileExtension: stripFileExtension,
    autoCast: autoCast,
    removeDir: removeDir,
    compareVersions,
    escapeRawValue: escapeRawValue,
    unescapeValue: unescapeValue,
    stringifyProps: stringifyProps,
    valueConverter: valueConverter,
    timeoutPromise: timeoutPromise,
    callProcessSend: callProcessSend,
    isHarperRunning: isHarperRunning,
    isClusterOperation: isClusterOperation,
    getClusterUser: getClusterUser,
    sendTransactionToSocketCluster,
    checkGlobalSchemaTable: checkGlobalSchemaTable,
    getHomeDir: getHomeDir,
    getPropsFilePath: getPropsFilePath,
    promisifyPapaParse,
    removeBOM,
    getClusterMessage,
    createEventPromise,
    checkProcessRunning,
    checkSchemaTableExist,
    promisifyPapaParseURL
};

/**
 * Converts a message to an error containing the error as a message. Will always return an error if the passed in error is
 * not a message.
 * @param message
 * @returns {*}
 */
function errorizeMessage(message) {
    if(!(message instanceof Error)) {
        return new Error(message);
    }
    return message;
}

/**
 * Test if the passed value is null or undefined.  This will not check string length.
 * @param value - the value to test
 * @returns {boolean}
 */
function isEmpty(value) {
    return (value === undefined || value === null);
}

/**
 * Test if the passed value is null, undefined, or zero length.
 * @param value - the value to test
 * @returns {boolean}
 */
function isEmptyOrZeroLength(value) {
    return (isEmpty(value) || value.length === 0);
}

/**
 * Test if the passed array contains any null or undefined values.
 * @param values_list - An array of values
 * @returns {boolean}
 */
function arrayHasEmptyValues(values_list) {
    if(isEmpty(values_list)) {
        return true;
    }
    for(let val=0; val<values_list.length; val++) {
        if(isEmpty(values_list[val])) {
            return true;
        }
    }
    return false;
}

/**
 * Test if the passed array contains any null or undefined values.
 * @param values_list - An array of values
 * @returns {boolean}
 */
function arrayHasEmptyOrZeroLengthValues(values_list) {
    if(isEmptyOrZeroLength(values_list)) {
        return true;
    }
    for(let val=0; val<values_list.length; val++) {
        if(isEmptyOrZeroLength(values_list[val])) {
            return true;
        }
    }
    return false;
}

/**
 * takes an array of strings and joins them with the folder separator to return a path
 * @param path_elements
 */
function buildFolderPath(...path_elements){
    try {
        return path_elements.join(path.sep);
    } catch(e){
        console.error(path_elements);
    }
}

/**
 * takes a value and checks if it is a boolean value (true/false)
 * @param value
 * @returns {boolean}
 */
function isBoolean(value){
    if(isEmpty(value)){
        return false;
    }

    if(value === true || value === false){
        return true;
    }
    return false;
}

/**
 * Strip the .hdb file extension from file names.  To keep this efficient, this will not check that the
 * parameter contains the .hdb extension.
 * @param file_name - the filename.
 * @returns {string}
 */
function stripFileExtension(file_name) {
    if(isEmptyOrZeroLength(file_name)) {
        return EMPTY_STRING;
    }
    return file_name.substr(0, file_name.length-FILE_EXTENSION_LENGTH);
}

/**
 * Takes a raw string value and casts it to the correct data type, including Object & Array, but not Dates
 * @param data
 * @returns
 */
function autoCast(data){
    if(isEmpty(data) || data === ""){
        return data;
    }

    //if this is already typed other than string, return data
    if(typeof data !== 'string'){
        return data;
    }

    // Try to make it a common string
    if (AUTOCAST_COMMON_STRINGS[data] !== undefined) {
        return AUTOCAST_COMMON_STRINGS[data];
    }

    // Try to cast it to a number
    let to_number;
    if ((to_number = +data) == to_number) {
        return to_number;
    }

    //in order to handle json and arrays we test the string to see if it seems minimally like an object or array and perform a JSON.parse on it.
    //if it fails we assume it is just a regular string
    if((data.startsWith('{') && data.endsWith('}')) || (data.startsWith('[') && data.endsWith(']'))){
        try{
            data = JSON.parse(data);
        } catch(e) {
            //no-op
        }
    }
    return data;
}

/**
 * Removes all files in a given directory path.
 * @param dir_path
 * @returns {Promise<[any]>}
 */
async function removeDir(dir_path) {
    if(isEmptyOrZeroLength(dir_path)) {
        throw new Error(`Directory path: ${dir_path} does not exist`);
    }
    try {
        await fs_extra.emptyDir(dir_path);
        await fs_extra.remove(dir_path);
    } catch(e) {
        log.error(`Error removing files in ${dir_path} -- ${e}`);
        throw e;
    }
}

/**
 * Sorting function, Get old_version list of version directives to run during an upgrade.
 * Can be used via [<versions>].sort(compareVersions). Can also be used to just compare strictly version
 * numbers.  Returns a number less than 0 if the old_version is less than new_version.
 * e.x. compareVersionsompareVersions('1.1.0', '2.0.0') will return a value less than 0.
 * @param old_version - As an UpgradeDirective object or just a version number as a string
 * @param new_version - Newest version As an UpgradeDirective object or just a version number as a string
 * @returns {*}
 */
function compareVersions (old_version, new_version) {
    if(isEmptyOrZeroLength(old_version)) {
        log.info('Invalid current version sent as parameter.');
        return;
    }
    if(isEmptyOrZeroLength(new_version)) {
        log.info('Invalid upgrade version sent as parameter.');
        return;
    }
    let diff;
    let regExStrip0 = /(\.0+)+$/;
    let old_version_as_string = ((old_version.version) ? old_version.version : old_version);
    let new_version_as_string = ((new_version.version) ? new_version.version : new_version);
    let segmentsA = old_version_as_string.replace(regExStrip0, '').split('.');
    let segmentsB = new_version_as_string.replace(regExStrip0, '').split('.');
    let l = Math.min(segmentsA.length, segmentsB.length);

    for (let i = 0; i < l; i++) {
        diff = parseInt(segmentsA[i], 10) - parseInt(segmentsB[i], 10);
        if (diff) {
            return diff;
        }
    }
    return segmentsA.length - segmentsB.length;
}

/**
 * takes a raw value and replaces any forward slashes with the unicode equivalent.  if the value directly matches "." or ".." then it replaces with their unicode equivalent
 * the reason for this is to because linux does not allow forward slashes in folder names and "." & ".." are already taken
 * @param value
 * @returns {string}
 */
function escapeRawValue(value){
    if(isEmpty(value)){
        return value;
    }
    let the_value = String(value);

    if(the_value === '.') {
        return terms.UNICODE_PERIOD;
    }

    if(the_value === '..') {
        return terms.UNICODE_PERIOD + terms.UNICODE_PERIOD;
    }

    return the_value.replace(terms.FORWARD_SLASH_REGEX, terms.UNICODE_FORWARD_SLASH);
}

/**
 * takes the value and unesacapes the unicode for any occurrance of "U+002F" and exact values of  "U+002E", "U+002EU+002E"
 * @param value
 * @returns {string}
 */
function unescapeValue(value){
    if(isEmpty(value)){
        return value;
    }

    let the_value = String(value);

    if(the_value === terms.UNICODE_PERIOD) {
        return '.';
    }

    if(the_value === terms.UNICODE_PERIOD + terms.UNICODE_PERIOD) {
        return '..';
    }

    return String(value).replace(terms.ESCAPED_FORWARD_SLASH_REGEX, '/');
}

/**
 * Takes a PropertiesReader object and converts it to a string so it can be printed to a file.
 * @param prop_reader_object - An object of type properties-reader containing properties stored in settings.js
 * @param comments - Object with key,value describing comments that should be placed above a variable in the settings file.
 * The key is the variable name (PROJECT_DIR) and the value will be the string comment.
 * @returns {string}
 */
function stringifyProps(prop_reader_object, comments) {
    if(isEmpty(prop_reader_object)) {
        log.info('Properties object is null');
        return '';
    }
    let lines = '';
    prop_reader_object.each(function (key, value) {
        try {
            if (comments && comments[key]) {
                let curr_comments = comments[key];
                for (let comm of curr_comments) {
                    lines += (';' + comm + os.EOL);
                }
            }
            if(!isEmptyOrZeroLength(key) && key[0] === ';') {
                // This is a comment, just write it all
                lines += '\t' + key + value + os.EOL;
            }
            else if(!isEmptyOrZeroLength(key) ) {
                lines += key + '=' + value + os.EOL;
            }
        } catch(e) {
            log.error(`Found bad property during upgrade with key ${key} and value: ${value}`);
        }
    });
    return lines;
}

//TODO - FS-specific methods like the one below need to be moved to an FS-specific module
/**
 * For FS only - takes a raw value from an attribute, replaces "/", ".", ".." with unicode equivalents and returns the value, escaped value & the value path
 * @param raw_value
 * @returns {{value: string, value_stripped: string, value_path: string}}
 */
function valueConverter(raw_value){
    let value;
    try {
        value = typeof raw_value === 'object' ? JSON.stringify(raw_value) : raw_value;
    } catch(e){
        log.error(e);
        value = raw_value;
    }
    let value_stripped = String(escapeRawValue(value));
    let value_path = Buffer.byteLength(value_stripped) > CHARACTER_LIMIT ? truncate(value_stripped, CHARACTER_LIMIT) + '/blob' : value_stripped;

    return {
        value: value,
        value_stripped: value_stripped,
        value_path: value_path
    };
}

function getHomeDir() {
    let home_dir = undefined;
    try {
        home_dir = os.homedir();
    } catch(err) {
        // could get here in android
        home_dir = process.env.HOME;
    }
    if(!home_dir) {
        home_dir = '~/';
    }
    return home_dir;
}

/**
 * This function will attempt to find the hdb_boot_properties.file path.  IT IS SYNCHRONOUS, SO SHOULD ONLY BE
 * CALLED IN CERTAIN SITUATIONS (startup, upgrade, etc).
 */
function getPropsFilePath() {
    let boot_props_file_path = path.join(getHomeDir(), terms.HDB_HOME_DIR_NAME, terms.BOOT_PROPS_FILE_NAME);
    // this checks how we used to store the boot props file for older installations.
    if(!fs.existsSync(boot_props_file_path)) {
        boot_props_file_path = path.join(__dirname, '../', 'hdb_boot_properties.file');
    }
    return boot_props_file_path;
}

/**
 * Creates a promisified timeout that exposes a cancel() function in case the timeout needs to be cancelled.
 * @param ms
 * @param msg - The message to resolve the promise with should it timeout
 * @returns {{promise: (Promise|Promise<any>), cancel: cancel}}
 */
function timeoutPromise(ms, msg) {
    let timeout, promise;

    promise = new Promise(function(resolve) {
        timeout = setTimeout(function() {
            resolve(msg);
        }, ms);
    });

    return {
        promise: promise,
        cancel: function() {
            clearTimeout(timeout);
        }
    };
}

/**
 * Wrapper function for process.send, will catch cases where master tries to send an IPC message.
 * @param process_msg - The message to send.
 */
function callProcessSend(process_msg) {
    if(process.send === undefined || global.isMaster) {
        log.error('Tried to call process.send() but process.send is undefined.');
        return;
    }
    process.send(process_msg);
}

/**
 * Uses module ps_list to check if hdb process is running
 * @returns {process}
 */
async function isHarperRunning(){
    try {
        let hdb_running = false;
        const list = await ps_list.findPs(HDB_PROC_NAME);

        if(!isEmptyOrZeroLength(list)) {
            hdb_running = true;
        }

        return hdb_running;
    } catch(err) {
        throw err;
    }
}

/**
 * Returns true if a given operation name is a cluster operation.  Should always return a boolean.
 * @param operation_name - the operation name being called
 * @returns {boolean|*}
 */
function isClusterOperation(operation_name) {
    try {
        return terms.CLUSTER_OPERATIONS[operation_name.toLowerCase()] !== undefined;
    } catch(err) {
        log.error(`Error checking operation against cluster ops ${err}`);
    }
    return false;
}

/**
 * sends a processed transaction from HarperDB to socketcluster
 * @param channel
 * @param transaction
 */
function sendTransactionToSocketCluster(channel, transaction, originator) {
    if(global.hdb_socket_client !== undefined) {
        log.trace(`Sending transaction to channel: ${channel}`);
        let {hdb_user, hdb_auth_header, ...data} = transaction;
        if(!data.__originator) {
            data.__originator = {};
        }
        data.__transacted = true;
        if(originator) {
            data.__originator[originator] = terms.ORIGINATOR_SET_VALUE;
        }
        global.hdb_socket_client.publish(channel, data);
    }
}

/**
 * Checks the global hdb_schema for a schema and table
 * @param schema_name
 * @param table_name
 * @returns only returns a thrown message if schema and or table does not exist
 */
function checkGlobalSchemaTable(schema_name, table_name) {
    if (!global.hdb_schema[schema_name]) {
        throw `schema ${schema_name} does not exist`;
    }
    if (!global.hdb_schema[schema_name] || !global.hdb_schema[schema_name][table_name]) {
        throw `table ${schema_name}.${table_name} does not exist`;
    }
}

function getClusterUser(users, cluster_user_name){
    if(isEmpty(cluster_user_name)){
        log.warn('No CLUSTERING_USER defined, clustering disabled');
        return;
    }

    if(isEmptyOrZeroLength(users)){
        log.warn('No users to search.');
        return;
    }

    let cluster_user = undefined;
    try {
        for (let x = 0; x < users.length; x++) {
            let user = users[x];
            if (user.username === cluster_user_name && user.role.permission.cluster_user === true && user.active === true) {
                cluster_user = user;
                break;
            }
        }
    } catch(e){
        log.error(`unable to find cluster_user due to: ${e.message}`);
        return;
    }

    if(cluster_user === undefined){
        log.warn(`CLUSTERING_USER: ${cluster_user_name} not found or is not active.`);
        return;
    }

    return cluster_user;
}

/**
 * Promisify csv parser papaparse. Once function is promisified it can be called with:
 * papa_parse.parsePromise(<reject-promise-obj>, <read-stream>, <chunking-function>)
 * In the case of an error, reject promise object must be called from chunking-function, it will bubble up
 * through bind to this function.
 */
function promisifyPapaParse() {
    papa_parse.parsePromise = function (stream, chunk_func) {
        return new Promise(function (resolve, reject) {
            papa_parse.parse(stream,
                {
                    header: true,
                    transformHeader: removeBOM,
                    chunk: chunk_func.bind(null, reject),
                    skipEmptyLines: true,
                    dynamicTyping: true,
                    error: reject,
                    complete: resolve
                });
        });
    };
}

function promisifyPapaParseURL() {
    papa_parse.parsePromiseURL = function (url, chunk_func) {
        return new Promise(function (resolve, reject) {
            papa_parse.parse(url,
                {
                    download: true,
                    header: true,
                    transformHeader: removeBOM,
                    chunk: chunk_func.bind(null, reject),
                    skipEmptyLines: true,
                    dynamicTyping: true,
                    error: reject,
                    complete: resolve
                });
        });
    };
}


/**
 * Removes the byte order mark from a string
 * @param string
 * @returns a string minus any byte order marks
 */
function removeBOM(data_string) {
    if (typeof data_string !== 'string') {
        throw new TypeError(`Expected a string, got ${typeof data_string}`);
    }

    if (data_string.charCodeAt(0) === 0xFEFF) {
        return data_string.slice(1);
    }

    return data_string;
}

function createEventPromise(event_name, event_emitter_object, timeout_promise) {
    let event_promise = new Promise((resolve) => {
        event_emitter_object.on(event_name, (msg) => {
            let curr_timeout_promise = timeout_promise;
            log.info(`Got cluster status event response: ${inspect(msg)}`);
            try {
                curr_timeout_promise.cancel();
            } catch(err) {
                log.error('Error trying to cancel timeout.');
            }
            resolve(msg);
        });
    });
    return event_promise;
}

function getClusterMessage(cluster_msg_type_enum) {
    if(!cluster_msg_type_enum) {
        log.info('Invalid clustering message type passed to getClusterMessage.');
        return null;
    }
    let built_msg = undefined;
    switch(cluster_msg_type_enum) {
        case terms.CLUSTERING_MESSAGE_TYPES.GET_CLUSTER_STATUS: {
            built_msg = new cluster_messages.HdbCoreClusterStatusRequestMessage();
            break;
        }
        case terms.CLUSTERING_MESSAGE_TYPES.HDB_TRANSACTION: {
            built_msg = new cluster_messages.HdbCoreTransactionMessage();
            break;
        }
        default:
            log.info('Invalid cluster message type sent to getClusterMessage');
            break;
    }
    return built_msg;
}

/**
 * Verifies the named process has started before fulfilling promise.
 * @returns {Promise<void>}
 */
async function checkProcessRunning(proc_name){
    let go_on = true;
    let x = 0;
    do{
        await async_set_timeout(HDB_PROC_START_TIMEOUT * x++);

        let instances = await ps_list.findPs(proc_name);

        if(instances.length > 0) {
            go_on = false;
        }
    } while(go_on && x < CHECK_PROCS_LOOP_LIMIT);

    if(go_on) {
        throw new Error(`process ${proc_name} was not started`);
    }
}

/**
 * Checks the global schema to see if a Schema or Table exist.
 * @param schema
 * @param table
 */
function checkSchemaTableExist(schema, table) {
    if (!global.hdb_schema[schema]) {
        throw new Error(`Schema '${schema}' does not exist`);
    }

    if (!global.hdb_schema[schema][table]) {
        throw new Error(`Table '${table}' does not exist in schema '${schema}'`);
    }
}