"use strict";

const LMDB_ERRORS = require('../commonErrors').LMDB_ERRORS_ENUM;
const lmdb = require('node-lmdb');
const lmdb_terms = require('./terms');
const Buffer = require('buffer').Buffer;

const MAX_BYTE_SIZE = 254;
/**
 * validates the env argument
 * @param env - environment object used thigh level to interact with all data in an environment
 */
function validateEnv(env){
    if(!(env instanceof lmdb.Env)){

        if(env === undefined){
            throw new Error(LMDB_ERRORS.ENV_REQUIRED);
        }

        throw new Error(LMDB_ERRORS.INVALID_ENVIRONMENT);
    }
}

/**
 * converts raw data to it's string version
 * @param raw_value
 * @returns {Number|String|null}
 */
function stringifyData(raw_value){
    if(raw_value === null || raw_value === undefined || raw_value === ''){
        return null;
    }

    let value;

    try {
        value = typeof raw_value === 'object' ? JSON.stringify(raw_value) : raw_value.toString();
    } catch(e){
        value = raw_value.toString();
    }

    //LMDB has a 511 byte limit for keys, so we return null if the byte size is larger than 511 to not index that value
    if(Buffer.byteLength(value) > MAX_BYTE_SIZE){
        return null;
    }

    return value;
}

/**
 * takes a raw value and converts it to be written to LMDB. String is sonverted to string, while number is converted to a double written to a buffer. https://nodejs.org/dist/latest-v12.x/docs/api/buffer.html#buffer_buf_writedoublebe_value_offset
 * @param {*} raw_value - raw value which needs to be converted
 * @param {lmdb_terms.DBI_KEY_TYPES} key_type - determines how to convert the value for LMDB, defaults to STRING
 * @returns {String|Buffer}
 */
function convertKeyValueToWrite(raw_value, key_type){
    let buf;
    let value = null;
    switch(key_type){
        case lmdb_terms.DBI_KEY_TYPES.STRING:
            value = stringifyData(raw_value);
            break;
        case lmdb_terms.DBI_KEY_TYPES.NUMBER:
            if(isNaN(raw_value) === false) {
                buf = Buffer.alloc(8);
                buf.writeDoubleBE(raw_value, 0);
                value = buf;
            }
            break;
        default:
            value = stringifyData(raw_value);
            break;
    }
    return value;
}

/**
 * takes a raw value from LMDB and converts it to an expected format, primarily for number types since they are stored in LMDB as buffers
 * @param raw_value
 * @param {lmdb_terms.DBI_KEY_TYPES} key_type - determines how to convert the value for LMDB, defaults to STRING
 * @returns {*}
 */
function convertKeyValueFromSearch(raw_value, key_type){
    let value = null;
    switch(key_type){
        case lmdb_terms.DBI_KEY_TYPES.STRING:
            value = raw_value;
            break;
        case lmdb_terms.DBI_KEY_TYPES.NUMBER:
            value = raw_value.readDoubleBE(0);
            break;
        default:
            value = raw_value;
            break;
    }
    return value;
}

module.exports = {
    validateEnv,
    stringifyData,
    convertKeyValueToWrite,
    convertKeyValueFromSearch
};