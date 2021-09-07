'use strict';

const TOKEN_TYPE_ENUM = {
	OPERATION: 'operation',
	REFRESH: 'refresh',
};

/**
 * return object for create_token function
 */
class JWTTokens {
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
 * the public & private RSA keys to encode/decode the JWT
 */
class JWTRSAKeys {
	/**
	 * @param {string} public_key
	 * @param {string} private_key
	 * @param {string} passphrase
	 */
	constructor(public_key, private_key, passphrase) {
		this.public_key = public_key;
		this.private_key = private_key;
		this.passphrase = passphrase;
	}
}

module.exports = {
	JWTTokens,
	TOKEN_TYPE_ENUM,
	JWTRSAKeys,
};
