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

const THIRTY_MINUTE_EXPIRY = '30m';
const THIRTY_DAY_EXPIRY = '30d';
const RSA_ALGORITHM = 'RS256';

let rsa_keys = undefined;

module.exports = {
    createTokens,
    validateOperationToken,
    refreshToken
};

async function createTokens(auth_object){
    //validate auth_object
    if(hdb_utils.isEmpty(auth_object) || typeof auth_object !== 'object'){
        throw handleHDBError(new Error(), AUTHENTICATION_ERROR_MSGS.INVALID_AUTH_OBJECT, HTTP_STATUS_CODES.UNAUTHORIZED);
    }

    if(hdb_utils.isEmpty(auth_object.username)){
        throw handleHDBError(new Error(), AUTHENTICATION_ERROR_MSGS.USERNAME_REQUIRED, HTTP_STATUS_CODES.UNAUTHORIZED);
    }

    if(hdb_utils.isEmpty(auth_object.password)){
        throw handleHDBError(new Error(), AUTHENTICATION_ERROR_MSGS.PASSWORD_REQUIRED, HTTP_STATUS_CODES.UNAUTHORIZED);
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
    let rsa_keys = await getJWTRSAKeys();

    //sign & return tokens
    let operation_token = await signOperationToken(auth_object.username, rsa_keys.private_key, rsa_keys.passphrase);
    let refresh_token = await jwt.sign({username: auth_object.username},
        {key: rsa_keys.private_key, passphrase: rsa_keys.passphrase},
        {expiresIn: THIRTY_MINUTE_EXPIRY, algorithm: RSA_ALGORITHM, subject: TOKEN_TYPE_ENUM.REFRESH});
    return new JWTTokens(operation_token, refresh_token);
}

async function signOperationToken(username, private_key, passphrase){
    return await jwt.sign({username: username},
        {key: private_key, passphrase: passphrase},
        {expiresIn: THIRTY_DAY_EXPIRY, algorithm: RSA_ALGORITHM, subject: TOKEN_TYPE_ENUM.OPERATION});
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

async function refreshToken(token){
    let username = await validateRefreshToken(token);

    let rsa_keys = await getJWTRSAKeys();

    let operation_token = await signOperationToken(username, rsa_keys.private_key, rsa_keys.passphrase);
    return {operation_token};
}

async function validateOperationToken(token){
    try {
        let rsa_keys = await getJWTRSAKeys();
        let token_verified = await jwt.verify(token, rsa_keys.public_key, {
            algorithms: RSA_ALGORITHM,
            subject: TOKEN_TYPE_ENUM.OPERATION
        });
        return await user_functions.findAndValidateUser(token_verified.username, undefined, false);
    }catch(e){
        logger.warn(e);
        throw handleHDBError(new Error(), AUTHENTICATION_ERROR_MSGS.INVALID_TOKEN, HTTP_STATUS_CODES.UNAUTHORIZED);
    }
}

async function validateRefreshToken(token){
    try {
        let rsa_keys = await getJWTRSAKeys();
        let token_verified = await jwt.verify(token, rsa_keys.public_key, {
            algorithms: RSA_ALGORITHM,
            subject: TOKEN_TYPE_ENUM.REFRESH
        });
        return await user_functions.findAndValidateUser(token_verified.username, undefined, false);
    }catch(e){
        logger.warn(e);
        throw handleHDBError(new Error(), AUTHENTICATION_ERROR_MSGS.INVALID_TOKEN, HTTP_STATUS_CODES.UNAUTHORIZED);
    }
}

