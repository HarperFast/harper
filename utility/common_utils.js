"use strict"
const path = require('path');
const cast = require('autocast');
const fs = require('fs');
const log = require('./logging/harper_logger');
const { promisify } = require('util');

const EMPTY_STRING = '';

//Promisify functions
const p_fs_stat = promisify(fs.stat);
const p_fs_readdir = promisify(fs.readdir);
const p_fs_unlink = promisify(fs.unlink);


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
    removeDir: removeDir
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

    let value = cast(data);

    //in order to handle json and arrays we test the string to see if it seems minimally like an object or array and perform a JSON.parse on it.
    //if it fails we assume it is just a regular string
    if(typeof value === 'string'){
        if((value.startsWith('{') && value.endsWith('}')) || (value.startsWith('[') && value.endsWith(']'))){
            try{
                value = JSON.parse(value);
            } catch(e) {
            }
        }
    }
    return value;
}

/**
 * Removes all files in a given directory path.  This currently does not recurse into existing directories, so it only
 * works on directorys with a depth of 1.
 * @param dir_path
 * @returns {Promise<[any]>}
 */
async function removeDir(dir_path) {
    if(isEmptyOrZeroLength(dir_path)) {
        throw new Error(`Directory path: ${dir_path} does not exist`);
    }
    let files = await p_fs_readdir(dir_path).catch((e) => {
        throw e;
    });
    if(files && files.length > 0) {
        try {
            const unlinkPromises = files.map(filename => p_fs_unlink(`${dir_path}/${filename}`));
            return await Promise.all(unlinkPromises);
        } catch(e) {
            log.error(`Error removing files in ${dir_path} -- ${e}`);
            throw e;
        }
    }
}