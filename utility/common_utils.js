"use strict"
const path = require('path');
const log = require('./logging/harper_logger');
const fs_extra = require('fs-extra');
const truncate = require('truncate-utf8-bytes');
const os = require('os');
const { promisify } = require('util');
const {PERIOD_REGEX,
    DOUBLE_PERIOD_REGEX,
    UNICODE_PERIOD,
    FORWARD_SLASH_REGEX,
    UNICODE_FORWARD_SLASH,
    ESCAPED_FORWARD_SLASH_REGEX,
    ESCAPED_PERIOD_REGEX,
    ESCAPED_DOUBLE_PERIOD_REGEX} = require('./hdbTerms');

const EMPTY_STRING = '';

const CHARACTER_LIMIT = 255;

const AUTOCAST_COMMON_STRINGS = {
    'true': true,
    'false': false,
    'undefined': undefined,
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
    compareVersions: compareVersions,
    escapeRawValue: escapeRawValue,
    unescapeValue: unescapeValue,
    stringifyProps: stringifyProps,
    valueConverter: valueConverter,
    timeoutPromise: timeoutPromise,
    callProcessSend: callProcessSend,
    sendTransactionToSocketCluster: sendTransactionToSocketCluster
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
    return file_name.substr(0, file_name.length-4);
}

/**
 * Takes a raw string value and casts it to the correct data type, including Object & Array, but not Dates
 * @param data
 * @returns
 */
function autoCast(data){
    if(isEmpty(data)){
        return data;
    }

    //if this is already typed other than string, return data
    if(typeof data !== 'string'){
        return data;
    }

    // Try to make it a common string
    if ((data === 'undefined' && AUTOCAST_COMMON_STRINGS[data] === undefined) || AUTOCAST_COMMON_STRINGS[data] !== undefined) {
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
        return UNICODE_PERIOD;
    }

    if(the_value === '..') {
        return UNICODE_PERIOD + UNICODE_PERIOD;
    }

    return the_value.replace(FORWARD_SLASH_REGEX, UNICODE_FORWARD_SLASH);
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

    if(the_value === UNICODE_PERIOD) {
        return '.';
    }

    if(the_value === UNICODE_PERIOD + UNICODE_PERIOD) {
        return '..';
    }

    return String(value).replace(ESCAPED_FORWARD_SLASH_REGEX, '/');
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
    let section = null;
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

/**
 * takes a raw value from an attribute, replaces "/", ".", ".." with unicode equivalents and returns the value, escaped value & the value path
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

/**
 * Creates a promisified timeout that exposes a cancel() function in case the timeout needs to be cancelled.
 * @param ms
 * @param msg - The message to resolve the promise with should it timeout
 * @param action_function - Function that will be run after the timeout and before the promise is resolved.
 * @returns {{promise: (Promise|Promise<any>), cancel: cancel}}
 */
function timeoutPromise(ms, msg, action_function) {
    let timeout, promise;

    promise = new Promise(function(resolve, reject) {
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

function callProcessSend(process_msg) {
    if(process.send === undefined || global.isMaster) {
        log.error('Tried to call process.send() but process.send is undefined.');
        return;
    }
    process.send(process_msg);
}

/**
 * sends a transaction to the local socketserver which needs to broadcast to the cluster
 * @param transaction
 */
function sendTransactionToSocketCluster(transaction){
    //we do not want to send system level transactions over the wire
    if(global.hdb_socket_client !== undefined && transaction.schema !== 'system'){
        global.hdb_socket_client.publish(`${transaction.schema}:${transaction.table}`, transaction);
    }
}