'use strict';

const TOKEN_TYPE_ENUM = {
    OPERATION: 'operation',
    REFRESH: 'refresh'
};

/**
 * Payload object for creating a JWT
 */
class JWTPayload{
    /**
     * @param {string} username
     * @param {string} token_type
     */
    constructor(username, token_type) {
        this.username = username;
        this.token_type = token_type;
    }
}

/**
 * return object for create_token function
 */
class JWTTokens{
    /**
     *
     * @param {string} operation_token
     * @param {string} refresh_token
     */
    constructor(operation_token, refresh_token) {
        this.operation_token = operation_token;
        this.refresh_token = refresh_token;
    }
}

/**
 * options to generate a JWT
 */
class JWTOptions{
    /**
     * @param {string|number} expires_in - time length until token expires
     * @param {string} algorithm - algorithm to encode/decode token
     */
    constructor(expires_in = '30m', algorithm= 'RS256' ) {
        this.expiresIn = expires_in;
        this.algorithm = algorithm;
    }
}

/**
 * the public & private RSA keys to encode/decode the JWT
 */
class JWTRSAKeys{
    /**
     * @param {string} public_key
     * @param {string} private_key
     */
    constructor(public_key, private_key) {
        this.public_key = public_key;
        this.private_key = private_key;
    }
}

module.exports = {
    JWTTokens,
    JWTPayload,
    TOKEN_TYPE_ENUM,
    JWTRSAKeys,
    JWTOptions
};