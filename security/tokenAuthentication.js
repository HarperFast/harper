'use strict';

const jwt = require('jsonwebtoken');
const fs = require('fs-extra');

const hdb_utils = require('../utility/common_utils');
const terms = require('../utility/hdbTerms');
const {handleHDBError, hdb_errors} = require('../utility/errors/hdbError');
const { HTTP_STATUS_CODES, AUTHENTICATION_ERROR_MSGS} = hdb_errors;
const logger = require('../utility/logging/harper_logger');
const user_functions = require('./user');
const env = require('../utility/environment/environmentManager');
if(!env.isInitialized()){
    env.initSync();
}

const path = require('path');
const {JWTTokens, JWTRSAKeys, TOKEN_TYPE_ENUM} = require('./JWTObjects');

const OPERATION_TOKEN_TIMEOUT = '30m';
const REFRESH_TOKEN_TIMEOUT = '30d';
const RSA_ALGORITHM = 'RS256';

let rsa_keys = undefined;

module.exports = {
    createTokens,
    validateOperationToken,
    refreshOperationToken,
    validateRefreshToken
};

async function createTokens(auth_object){
    //validate auth_object
    if(hdb_utils.isEmpty(auth_object) || typeof auth_object !== 'object'){
        throw handleHDBError(new Error(), AUTHENTICATION_ERROR_MSGS.INVALID_AUTH_OBJECT, HTTP_STATUS_CODES.BAD_REQUEST);
    }

    if(hdb_utils.isEmpty(auth_object.username)){
        throw handleHDBError(new Error(), AUTHENTICATION_ERROR_MSGS.USERNAME_REQUIRED, HTTP_STATUS_CODES.BAD_REQUEST);
    }

    if(hdb_utils.isEmpty(auth_object.password)){
        throw handleHDBError(new Error(), AUTHENTICATION_ERROR_MSGS.PASSWORD_REQUIRED, HTTP_STATUS_CODES.BAD_REQUEST);
    }

    //query for user/pw
    try {
        let user = await user_functions.findAndValidateUser(auth_object.username, auth_object.password);
        if (!user) {
            throw handleHDBError(new Error(), AUTHENTICATION_ERROR_MSGS.INVALID_CREDENTIALS, HTTP_STATUS_CODES.UNAUTHORIZED);
        }
    }catch(e){
        logger.error(e);
        throw handleHDBError(new Error(), AUTHENTICATION_ERROR_MSGS.INVALID_CREDENTIALS, HTTP_STATUS_CODES.UNAUTHORIZED);
    }

    //get rsa key
    let keys = await getJWTRSAKeys();

    //sign & return tokens
    let operation_token = await signOperationToken(auth_object.username, keys.private_key, keys.passphrase);
    let refresh_token = await jwt.sign({username: auth_object.username},
        {key: keys.private_key, passphrase: keys.passphrase},
        {expiresIn: REFRESH_TOKEN_TIMEOUT, algorithm: RSA_ALGORITHM, subject: TOKEN_TYPE_ENUM.REFRESH});
    return new JWTTokens(operation_token, refresh_token);
}

async function signOperationToken(username, private_key, passphrase){
    return await jwt.sign({username: username},
        {key: private_key, passphrase: passphrase},
        {expiresIn: OPERATION_TOKEN_TIMEOUT, algorithm: RSA_ALGORITHM, subject: TOKEN_TYPE_ENUM.OPERATION});
}

/**
 * fetches the rsa keys from disk
 * @returns {Promise<JWTRSAKeys>}
 */
async function getJWTRSAKeys(){
    if(rsa_keys === undefined){
        try {
            let passphrase_path = path.join(env.getHdbBasePath(), terms.LICENSE_KEY_DIR_NAME, terms.JWT_ENUM.JWT_PASSPHRASE_NAME);
            let private_key_path = path.join(env.getHdbBasePath(), terms.LICENSE_KEY_DIR_NAME, terms.JWT_ENUM.JWT_PRIVATE_KEY_NAME);
            let public_key_path = path.join(env.getHdbBasePath(), terms.LICENSE_KEY_DIR_NAME, terms.JWT_ENUM.JWT_PUBLIC_KEY_NAME);

            let passphrase = (await fs.readFile(passphrase_path)).toString();
            let private_key = (await fs.readFile(private_key_path)).toString();
            let public_key = (await fs.readFile(public_key_path)).toString();

            rsa_keys = new JWTRSAKeys(public_key, private_key, passphrase);
        }catch(e){
            logger.error(e);
            throw handleHDBError(new Error(), AUTHENTICATION_ERROR_MSGS.NO_ENCRYPTION_KEYS,
                HTTP_STATUS_CODES.INTERNAL_SERVER_ERROR);
        }
    }

    return rsa_keys;
}

async function refreshOperationToken(token_object){
    if(!token_object){
        throw handleHDBError(new Error(), AUTHENTICATION_ERROR_MSGS.INVALID_BODY, HTTP_STATUS_CODES.BAD_REQUEST);
    }

    if(!token_object.refresh_token){
        throw handleHDBError(new Error(), AUTHENTICATION_ERROR_MSGS.REFRESH_TOKEN_REQUIRED, HTTP_STATUS_CODES.BAD_REQUEST);
    }

    let username = await validateRefreshToken(token_object.refresh_token);

    let keys = await getJWTRSAKeys();

    let operation_token = await signOperationToken(username, keys.private_key, keys.passphrase);
    return {operation_token};
}

async function validateOperationToken(token){
    try {
        let keys = await getJWTRSAKeys();
        let token_verified = await jwt.verify(token, keys.public_key, {
            algorithms: RSA_ALGORITHM,
            subject: TOKEN_TYPE_ENUM.OPERATION
        });
        return await user_functions.findAndValidateUser(token_verified.username, undefined, false);
    }catch(e){
        logger.warn(e);
        if(e.name && e.name === 'TokenExpiredError'){
            throw handleHDBError(new Error(), AUTHENTICATION_ERROR_MSGS.TOKEN_EXPIRED, HTTP_STATUS_CODES.FORBIDDEN);
        }
        throw handleHDBError(new Error(), AUTHENTICATION_ERROR_MSGS.INVALID_TOKEN, HTTP_STATUS_CODES.UNAUTHORIZED);
    }
}

async function validateRefreshToken(token){
    try {
        let keys = await getJWTRSAKeys();
        let token_verified = await jwt.verify(token, keys.public_key, {
            algorithms: RSA_ALGORITHM,
            subject: TOKEN_TYPE_ENUM.REFRESH
        });
        return await user_functions.findAndValidateUser(token_verified.username, undefined, false);
    }catch(e){
        logger.warn(e);
        if(e.name && e.name === 'TokenExpiredError'){
            throw handleHDBError(new Error(), AUTHENTICATION_ERROR_MSGS.TOKEN_EXPIRED, HTTP_STATUS_CODES.FORBIDDEN);
        }
        throw handleHDBError(new Error(), AUTHENTICATION_ERROR_MSGS.INVALID_TOKEN, HTTP_STATUS_CODES.UNAUTHORIZED);
    }
}

