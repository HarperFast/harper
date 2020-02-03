"use strict";

const LMDB_ERRORS = require('../commonErrors').LMDB_ERRORS_ENUM;
const lmdb = require('node-lmdb');

const MAX_BYTE_SIZE = 511;
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
 * @returns {string|null}
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

module.exports = {
    validateEnv,
    stringifyData
};