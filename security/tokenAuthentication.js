'use strict';

const jwt = require('jsonwebtoken');
const fs = require('fs-extra');

const hdb_utils = require('../utility/common_utils');
const terms = require('../utility/hdbTerms');
const { handleHDBError, hdb_errors } = require('../utility/errors/hdbError');
const { HTTP_STATUS_CODES, AUTHENTICATION_ERROR_MSGS } = hdb_errors;
const logger = require('../utility/logging/harper_logger');
const password = require('../utility/password');
const user_functions = require('./user');
const update = require('../dataLayer/insert').update;
const UpdateObject = require('../dataLayer/UpdateObject');
const signalling = require('../utility/signalling');
const { UserEventMsg } = require('../server/threads/itc');
const env = require('../utility/environment/environmentManager');
env.initSync();

const path = require('path');
const { JWTTokens, JWTRSAKeys, TOKEN_TYPE_ENUM } = require('./JWTObjects');

const OPERATION_TOKEN_TIMEOUT = env.get(terms.HDB_SETTINGS_NAMES.OPERATION_TOKEN_TIMEOUT_KEY)
	? env.get(terms.HDB_SETTINGS_NAMES.OPERATION_TOKEN_TIMEOUT_KEY)
	: '1d';
const REFRESH_TOKEN_TIMEOUT = env.get(terms.HDB_SETTINGS_NAMES.REFRESH_TOKEN_TIMEOUT_KEY)
	? env.get(terms.HDB_SETTINGS_NAMES.REFRESH_TOKEN_TIMEOUT_KEY)
	: '30d';
const RSA_ALGORITHM = 'RS256';

let rsa_keys = undefined;

module.exports = {
	createTokens,
	validateOperationToken,
	refreshOperationToken,
	validateRefreshToken,
	getJWTRSAKeys,
};

async function createTokens(auth_object) {
	//validate auth_object
	if (hdb_utils.isEmpty(auth_object) || typeof auth_object !== 'object') {
		throw handleHDBError(
			new Error(),
			AUTHENTICATION_ERROR_MSGS.INVALID_AUTH_OBJECT,
			HTTP_STATUS_CODES.BAD_REQUEST,
			undefined,
			undefined,
			true
		);
	}

	if (hdb_utils.isEmpty(auth_object.username)) {
		throw handleHDBError(
			new Error(),
			AUTHENTICATION_ERROR_MSGS.USERNAME_REQUIRED,
			HTTP_STATUS_CODES.BAD_REQUEST,
			undefined,
			undefined,
			true
		);
	}

	if (hdb_utils.isEmpty(auth_object.password)) {
		throw handleHDBError(
			new Error(),
			AUTHENTICATION_ERROR_MSGS.PASSWORD_REQUIRED,
			HTTP_STATUS_CODES.BAD_REQUEST,
			undefined,
			undefined,
			true
		);
	}

	//query for user/pw
	let user;
	try {
		user = await user_functions.findAndValidateUser(auth_object.username, auth_object.password);
		if (!user) {
			throw handleHDBError(
				new Error(),
				AUTHENTICATION_ERROR_MSGS.INVALID_CREDENTIALS,
				HTTP_STATUS_CODES.UNAUTHORIZED,
				undefined,
				undefined,
				true
			);
		}
	} catch (e) {
		logger.error(e);
		throw handleHDBError(
			new Error(),
			AUTHENTICATION_ERROR_MSGS.INVALID_CREDENTIALS,
			HTTP_STATUS_CODES.UNAUTHORIZED,
			undefined,
			undefined,
			true
		);
	}

	//get rsa key
	let keys = await getJWTRSAKeys();

	let super_user = false;
	let cluster_user = false;
	if (user.role && user.role.permission) {
		super_user = user.role.permission.super_user === true;
		cluster_user = user.role.permission.cluster_user === true;
	}

	let payload = { username: auth_object.username, super_user: super_user, cluster_user: cluster_user };

	//sign & return tokens
	let operation_token = await signOperationToken(payload, keys.private_key, keys.passphrase);
	let refresh_token = await jwt.sign(
		payload,
		{ key: keys.private_key, passphrase: keys.passphrase },
		{ expiresIn: REFRESH_TOKEN_TIMEOUT, algorithm: RSA_ALGORITHM, subject: TOKEN_TYPE_ENUM.REFRESH }
	);

	let hashed_token = password.hash(refresh_token);
	//update the user.refresh_token
	let update_user_object = new UpdateObject(terms.SYSTEM_SCHEMA_NAME, terms.SYSTEM_TABLE_NAMES.USER_TABLE_NAME, [
		{ username: auth_object.username, refresh_token: hashed_token },
	]);

	let result;
	let update_error;
	try {
		result = await update(update_user_object);
	} catch (e) {
		logger.error(e);
		update_error = e;
	}

	if (update_error !== undefined || result.skipped_hashes.length > 0) {
		throw handleHDBError(
			new Error(),
			AUTHENTICATION_ERROR_MSGS.REFRESH_TOKEN_SAVE_FAILED,
			HTTP_STATUS_CODES.INTERNAL_SERVER_ERROR
		);
	}

	signalling.signalUserChange(new UserEventMsg(process.pid));

	return new JWTTokens(operation_token, refresh_token);
}

async function signOperationToken(payload, private_key, passphrase) {
	return await jwt.sign(
		payload,
		{ key: private_key, passphrase: passphrase },
		{ expiresIn: OPERATION_TOKEN_TIMEOUT, algorithm: RSA_ALGORITHM, subject: TOKEN_TYPE_ENUM.OPERATION }
	);
}

/**
 * fetches the rsa keys from disk
 * @returns {Promise<JWTRSAKeys>}
 */
async function getJWTRSAKeys() {
	if (rsa_keys === undefined) {
		try {
			let passphrase_path = path.join(
				env.getHdbBasePath(),
				terms.LICENSE_KEY_DIR_NAME,
				terms.JWT_ENUM.JWT_PASSPHRASE_NAME
			);
			let private_key_path = path.join(
				env.getHdbBasePath(),
				terms.LICENSE_KEY_DIR_NAME,
				terms.JWT_ENUM.JWT_PRIVATE_KEY_NAME
			);
			let public_key_path = path.join(
				env.getHdbBasePath(),
				terms.LICENSE_KEY_DIR_NAME,
				terms.JWT_ENUM.JWT_PUBLIC_KEY_NAME
			);

			let passphrase = (await fs.readFile(passphrase_path)).toString();
			let private_key = (await fs.readFile(private_key_path)).toString();
			let public_key = (await fs.readFile(public_key_path)).toString();

			rsa_keys = new JWTRSAKeys(public_key, private_key, passphrase);
		} catch (e) {
			logger.error(e);
			throw handleHDBError(
				new Error(),
				AUTHENTICATION_ERROR_MSGS.NO_ENCRYPTION_KEYS,
				HTTP_STATUS_CODES.INTERNAL_SERVER_ERROR
			);
		}
	}

	return rsa_keys;
}

async function refreshOperationToken(token_object) {
	if (!token_object) {
		throw handleHDBError(
			new Error(),
			AUTHENTICATION_ERROR_MSGS.INVALID_BODY,
			HTTP_STATUS_CODES.BAD_REQUEST,
			undefined,
			undefined,
			true
		);
	}

	if (!token_object.refresh_token) {
		throw handleHDBError(
			new Error(),
			AUTHENTICATION_ERROR_MSGS.REFRESH_TOKEN_REQUIRED,
			HTTP_STATUS_CODES.BAD_REQUEST,
			undefined,
			undefined,
			true
		);
	}

	await validateRefreshToken(token_object.refresh_token);

	let keys = await getJWTRSAKeys();
	let decoded = await jwt.decode(token_object.refresh_token);
	let operation_token = await signOperationToken(
		{ username: decoded.username, super_user: decoded.super_user, cluster_user: decoded.cluster_user },
		keys.private_key,
		keys.passphrase
	);
	return { operation_token };
}

async function validateOperationToken(token) {
	try {
		let keys = await getJWTRSAKeys();

		let token_verified = await jwt.verify(token, keys.public_key, {
			algorithms: RSA_ALGORITHM,
			subject: TOKEN_TYPE_ENUM.OPERATION,
		});
		return await user_functions.findAndValidateUser(token_verified.username, undefined, false);
	} catch (e) {
		logger.warn(e);
		if (e.name && e.name === 'TokenExpiredError') {
			throw handleHDBError(new Error(), AUTHENTICATION_ERROR_MSGS.TOKEN_EXPIRED, HTTP_STATUS_CODES.FORBIDDEN);
		}
		throw handleHDBError(new Error(), AUTHENTICATION_ERROR_MSGS.INVALID_TOKEN, HTTP_STATUS_CODES.UNAUTHORIZED);
	}
}

async function validateRefreshToken(token) {
	let user;
	try {
		let keys = await getJWTRSAKeys();
		let token_verified = await jwt.verify(token, keys.public_key, {
			algorithms: RSA_ALGORITHM,
			subject: TOKEN_TYPE_ENUM.REFRESH,
		});
		user = await user_functions.findAndValidateUser(token_verified.username, undefined, false);
	} catch (e) {
		logger.warn(e);
		if (e.name && e.name === 'TokenExpiredError') {
			throw handleHDBError(new Error(), AUTHENTICATION_ERROR_MSGS.TOKEN_EXPIRED, HTTP_STATUS_CODES.FORBIDDEN);
		}
		throw handleHDBError(new Error(), AUTHENTICATION_ERROR_MSGS.INVALID_TOKEN, HTTP_STATUS_CODES.UNAUTHORIZED);
	}

	if (!password.validate(user.refresh_token, token)) {
		throw handleHDBError(new Error(), AUTHENTICATION_ERROR_MSGS.INVALID_TOKEN, HTTP_STATUS_CODES.UNAUTHORIZED);
	}
	return user;
}
