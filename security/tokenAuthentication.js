'use strict';

const jwt = require('jsonwebtoken');
const fs = require('fs-extra');
const {promisify} = require('util');
const auth = require('./auth');
const p_find_validate_user = promisify(auth.findAndValidateUser);
const hdb_utils = require('../utility/common_utils');
const terms = require('../utility/hdbTerms');
const {handleHDBError, hdb_errors} = require('../utility/errors/hdbError');
const { HTTP_STATUS_CODES } = hdb_errors;
const env = require('../utility/environment/environmentManager');
if(!env.isInitialized()){
    env.initSync();
}

const path = require('path');
const {JWTTokens, JWTRSAKeys, TOKEN_TYPE_ENUM} = require('./JWTObjects');

let rsa_keys = undefined;

module.exports = {createTokens};

async function createTokens(auth_object){
    //validate auth_object
    if(hdb_utils.isEmpty(auth_object) || typeof auth_object !== 'object'){
        throw handleHDBError(new Error(), 'invalid auth_object', HTTP_STATUS_CODES.INTERNAL_SERVER_ERROR);
    }

    if(hdb_utils.isEmpty(auth_object.username)){
        throw handleHDBError(new Error(), 'username is required', HTTP_STATUS_CODES.INTERNAL_SERVER_ERROR);
    }

    if(hdb_utils.isEmpty(auth_object.password)){
        throw handleHDBError(new Error(), 'password is required', HTTP_STATUS_CODES.INTERNAL_SERVER_ERROR);
    }

    //query for user/pw
    try {
        let user = await p_find_validate_user(auth_object.username, auth_object.password);
        if (!user) {
            throw handleHDBError(new Error(), 'invalid credentials', HTTP_STATUS_CODES.UNAUTHORIZED);
        }
    }catch(e){
        throw handleHDBError(new Error(), 'invalid credentials', HTTP_STATUS_CODES.UNAUTHORIZED);
    }

    //get rsa key
    let rsa_keys = undefined;
    try {
        rsa_keys = await getJWTRSAKeys();
    }catch(e){
        throw handleHDBError(new Error(), 'unable to generate JWT as there are no encryption keys.  please contact your administrator', HTTP_STATUS_CODES.INTERNAL_SERVER_ERROR);
    }

    //sign & return tokens
    let operation_token = await jwt.sign({username: auth_object.username, token_type: TOKEN_TYPE_ENUM.OPERATION}, rsa_keys.private_key, {expiresIn: '30m', algorithm: 'RS256'});
    let refresh_token = await jwt.sign({username: auth_object.username, token_type: TOKEN_TYPE_ENUM.REFRESH}, rsa_keys.private_key, {expiresIn: '30d', algorithm: 'RS256'});
    return new JWTTokens(operation_token, refresh_token);
}

/**
 * fetches the rsa keys from disk
 * @returns {Promise<JWTRSAKeys>}
 */
async function getJWTRSAKeys(){
    if(rsa_keys === undefined){
        let private_key_path = path.join(env.getHdbBasePath(), terms.LICENSE_KEY_DIR_NAME, terms.JWT_PRIVATE_KEY_NAME);
        let public_key_path = path.join(env.getHdbBasePath(), terms.LICENSE_KEY_DIR_NAME, terms.JWT_PUBLIC_KEY_NAME);

        let private_key = (await fs.readFile(private_key_path)).toString();
        let public_key = (await fs.readFile(public_key_path)).toString();

        rsa_keys = new JWTRSAKeys(public_key, private_key);
    }

    return rsa_keys;
}