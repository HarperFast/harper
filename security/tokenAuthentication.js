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
const logger = require('../utility/logging/harper_logger');
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
        logger.error(e);
        throw handleHDBError(new Error(), 'invalid credentials', HTTP_STATUS_CODES.UNAUTHORIZED);
    }

    //get rsa key
    let rsa_keys = undefined;
    try {
        rsa_keys = await getJWTRSAKeys();
    }catch(e){
        logger.error(e);
        throw handleHDBError(new Error(), 'unable to generate JWT as there are no encryption keys.  please contact your administrator', HTTP_STATUS_CODES.INTERNAL_SERVER_ERROR);
    }

    //sign & return tokens
    let operation_token = await jwt.sign({username: auth_object.username},
        {key: rsa_keys.private_key, passphrase: rsa_keys.passphrase},
        {expiresIn: THIRTY_DAY_EXPIRY, algorithm: RSA_ALGORITHM, subject: TOKEN_TYPE_ENUM.OPERATION});
    let refresh_token = await jwt.sign({username: auth_object.username},
        {key: rsa_keys.private_key, passphrase: rsa_keys.passphrase},
        {expiresIn: THIRTY_MINUTE_EXPIRY, algorithm: RSA_ALGORITHM, subject: TOKEN_TYPE_ENUM.REFRESH});
    return new JWTTokens(operation_token, refresh_token);
}

/**
 * fetches the rsa keys from disk
 * @returns {Promise<JWTRSAKeys>}
 */
async function getJWTRSAKeys(){
    if(rsa_keys === undefined){
        let passphrase_path = path.join(env.getHdbBasePath(), terms.LICENSE_KEY_DIR_NAME, terms.JWT_ENUM.JWT_PASSPHRASE_NAME);
        let private_key_path = path.join(env.getHdbBasePath(), terms.LICENSE_KEY_DIR_NAME, terms.JWT_ENUM.JWT_PRIVATE_KEY_NAME);
        let public_key_path = path.join(env.getHdbBasePath(), terms.LICENSE_KEY_DIR_NAME, terms.JWT_ENUM.JWT_PUBLIC_KEY_NAME);

        let passphrase = (await fs.readFile(passphrase_path)).toString();
        let private_key = (await fs.readFile(private_key_path)).toString();
        let public_key = (await fs.readFile(public_key_path)).toString();

        rsa_keys = new JWTRSAKeys(public_key, private_key, passphrase);
    }

    return rsa_keys;
}

async function validateOperationToken(token){
    let rsa_keys = await getJWTRSAKeys();
    let token_verified = await jwt.verify(token, rsa_keys.public_key, {algorithms: RSA_ALGORITHM, subject: TOKEN_TYPE_ENUM.OPERATION});
    console.log(token_verified);
}

async function validateRefreshToken(token){
    let rsa_keys = await getJWTRSAKeys();
    let token_verified = await jwt.verify(token, rsa_keys.public_key, {algorithms: RSA_ALGORITHM, subject: TOKEN_TYPE_ENUM.REFRESH});
    console.log(token_verified);
}

validateRefreshToken('eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9.eyJ1c2VybmFtZSI6IkhEQl9BRE1JTiIsImlhdCI6MTYwMzQxOTQ5NCwiZXhwIjoxNjAzNDIxMjk0LCJzdWIiOiJyZWZyZXNoIn0.B7BDhD2R12jthsEymXnqvQvMCuqfgQMR24XNY18RgCOMv1Z26Jqv2OGwKiHIXSnuR-4cRasWl3vNkSR-xS1OuUrQ05pROfB-dHwaJsPWHixj2eJrVSyzDJBHfhHohOrG6tIoOd0KCpIuO3-1uki0HBnlZoqEIk39GOJHYrQyeK3j4S9QExVc1LktWk8KIAKUUW5YYjvuUIvLu2O3t2Cja69_AOG6CF8QgIlzZDDOGTyGwJuKNTdiSjdxE2b_XbHZztOyeHou5334t_ZF_Um0HErdTFXjO3TZpWjebzwYqpOcXsdc84eqLU7pvFqiY2MNY3VR--nHsDrI-TMZtfmzAE_tvifRPSkFOcmLzETXzSKnS-XDAa22pENZo6ayJdwYuMQFpi6AbuMtCKdXghAcV3XhA2nxtilSpA0-1tWzD_Lgf6qC9fr-LsOmVjlaln2hmIQYaAmggt6lYcYzw9CMgL-01zubItNEkqxAFA6StajL9QQh_oNMRzqAGUp3UP_8zfRfhxr5KCdDCKN8tCz4-2-ECW2uRhzN3FJ5iI9VbjPNa-ce_i-AkF1vhcQPoEYxDV-Vt2QWCe73vlwmt45xPvwxcpDzJJUXTy7x0xxog93Shx0r5BV8mOiwCnkma5QfVeqKlfBh7_pjZebP5wQYWrtgi12_8oiWyGpHhJgPqo8')
    .then(()=>{});
