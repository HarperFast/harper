import jwt from 'jsonwebtoken';
import fs from 'fs-extra';
import path from 'node:path';
import Joi from 'joi';
import { validateBySchema } from '../validation/validationWrapper.js';
import {
	CONFIG_PARAMS,
	JWT_ENUM,
	LICENSE_KEY_DIR_NAME,
	SYSTEM_SCHEMA_NAME,
	SYSTEM_TABLE_NAMES,
} from '../utility/hdbTerms.ts';
import { ClientError, hdbErrors } from '../utility/errors/hdbError.js';
const { HTTP_STATUS_CODES, AUTHENTICATION_ERROR_MSGS } = hdbErrors;
import logger from '../utility/logging/harper_logger.js';
import * as password from '../utility/password.ts';
import { findAndValidateUser } from './user.js';
import { update } from '../dataLayer/insert.js';
import UpdateObject from '../dataLayer/UpdateObject.js';
import signalling from '../utility/signalling.js';
import { UserEventMsg } from '../server/threads/itc.js';
import env from '../utility/environment/environmentManager.js';
env.initSync();

const OPERATION_TOKEN_TIMEOUT: string = env.get(CONFIG_PARAMS.AUTHENTICATION_OPERATIONTOKENTIMEOUT) || '1d';
const REFRESH_TOKEN_TIMEOUT: string = env.get(CONFIG_PARAMS.AUTHENTICATION_REFRESHTOKENTIMEOUT) || '30d';
const RSA_ALGORITHM: string = 'RS256';

const TOKEN_TYPE = {
	OPERATION: 'operation',
	REFRESH: 'refresh',
};

interface JWTRSAKeys {
	publicKey: string;
	privateKey: string;
	passphrase: string;
}

interface AuthObject {
	username?: string;
	password?: string;
	role?: string;
	expires_in?: string | number;
}

interface TokenObject {
	refresh_token: string;
}

interface JWTTokens {
	operation_token: string;
	refresh_token?: string;
}

/**
 * fetches the rsa keys from cache var or disk
 * @returns {Promise<JWTRSAKeys>}
 */
let rsaKeys: JWTRSAKeys | undefined = undefined;
export async function getJWTRSAKeys(): Promise<JWTRSAKeys> {
	if (rsaKeys) return rsaKeys;
	try {
		const keysDir: string = path.join(env.getHdbBasePath(), LICENSE_KEY_DIR_NAME);
		const passphrase: string = await fs.readFile(path.join(keysDir, JWT_ENUM.JWT_PASSPHRASE_NAME), 'utf8');
		const privateKey: string = await fs.readFile(path.join(keysDir, JWT_ENUM.JWT_PRIVATE_KEY_NAME), 'utf8');
		const publicKey: string = await fs.readFile(path.join(keysDir, JWT_ENUM.JWT_PUBLIC_KEY_NAME), 'utf8');
		rsaKeys = { publicKey, privateKey, passphrase };
		return rsaKeys;
	} catch (err) {
		logger.error(err);
		throw new ClientError(AUTHENTICATION_ERROR_MSGS.NO_ENCRYPTION_KEYS, HTTP_STATUS_CODES.INTERNAL_SERVER_ERROR);
	}
}

/**
 * Creates a new operation token and refresh token.
 * If there is no username and password, the hdb_user making the request is used in the token.
 * An optional role can be provided which will be saved in the token payload.
 * The token expires in the time specified in the expires_in field or the default time.
 * @param authObj
 */
export async function createTokens(authObj: AuthObject): Promise<JWTTokens> {
	const validation: any = validateBySchema(
		authObj,
		Joi.object({
			username: Joi.string().optional(),
			password: Joi.string().optional(),
			role: Joi.string().optional(),
			expires_in: Joi.alternatives(Joi.string(), Joi.number()).optional(),
		})
	);
	if (validation) throw new ClientError(validation.message);

	let user: any;
	try {
		// bypassAuth will be set to true if this is called from a component
		let validatePassword: boolean = authObj.bypass_auth !== true;
		if (!authObj.username && !authObj.password) {
			// if the username and password are not provided, use the hdb_user making the request.
			authObj.username = authObj.hdb_user?.username;
			// the password would have been checked by authHandler before getting here
			validatePassword = false;
		}
		user = await findAndValidateUser(authObj.username, authObj.password, validatePassword);
	} catch (err) {
		logger.error(err);
		throw new ClientError(AUTHENTICATION_ERROR_MSGS.INVALID_CREDENTIALS, HTTP_STATUS_CODES.UNAUTHORIZED);
	}
	if (!user) throw new ClientError(AUTHENTICATION_ERROR_MSGS.INVALID_CREDENTIALS, HTTP_STATUS_CODES.UNAUTHORIZED);

	let superUser: boolean = false;
	let clusterUser: boolean = false;
	if (user.role?.permission) {
		superUser = user.role.permission.super_user === true;
		clusterUser = user.role.permission.cluster_user === true;
	}

	const payload: {
		username: string;
		super_user: boolean;
		cluster_user: boolean;
		role?: any;
	} = { username: authObj.username, super_user: superUser, cluster_user: clusterUser };
	if (authObj.role) payload.role = authObj.role;

	const keys: JWTRSAKeys = await getJWTRSAKeys();
	const operationToken = await jwt.sign(
		payload,
		{ key: keys.privateKey, passphrase: keys.passphrase },
		{
			expiresIn: authObj.expires_in ?? OPERATION_TOKEN_TIMEOUT,
			algorithm: RSA_ALGORITHM,
			subject: TOKEN_TYPE.OPERATION,
		}
	);

	const refreshToken = await jwt.sign(
		payload,
		{ key: keys.privateKey, passphrase: keys.passphrase },
		{ expiresIn: REFRESH_TOKEN_TIMEOUT, algorithm: RSA_ALGORITHM, subject: TOKEN_TYPE.REFRESH }
	);

	// update the user refresh token
	const hashedToken: string | Promise<string> = password.hash(refreshToken, password.HASH_FUNCTION.SHA256);
	const updateResult: any = await update(
		new UpdateObject(SYSTEM_SCHEMA_NAME, SYSTEM_TABLE_NAMES.USER_TABLE_NAME, [
			{ username: authObj.username, refresh_token: hashedToken },
		])
	);

	if (updateResult.skipped_hashes.length > 0)
		throw new ClientError(AUTHENTICATION_ERROR_MSGS.REFRESH_TOKEN_SAVE_FAILED, HTTP_STATUS_CODES.INTERNAL_SERVER_ERROR);

	signalling.signalUserChange(new UserEventMsg(process.pid));

	return {
		operation_token: operationToken,
		refresh_token: refreshToken,
	};
}

/**
 * Refreshes the operation token using the refresh token.
 * @param tokenObj
 */
export async function refreshOperationToken(tokenObj: TokenObject): Promise<JWTTokens> {
	const validation: any = validateBySchema(tokenObj, Joi.object({ refresh_token: Joi.string().required() }).required());
	if (validation) throw new ClientError(validation.message);
	const { refresh_token } = tokenObj;
	await validateRefreshToken(refresh_token);

	const keys: JWTRSAKeys = await getJWTRSAKeys();
	const decodedJWT = await jwt.decode(refresh_token);
	const operationToken = await jwt.sign(
		{ username: decodedJWT.username, super_user: decodedJWT.super_user, cluster_user: decodedJWT.cluster_user },
		{ key: keys.privateKey, passphrase: keys.passphrase },
		{ expiresIn: OPERATION_TOKEN_TIMEOUT, algorithm: RSA_ALGORITHM, subject: TOKEN_TYPE.OPERATION }
	);

	return { operation_token: operationToken };
}

export async function validateOperationToken(token: string): Promise<any> {
	return validateToken(token, TOKEN_TYPE.OPERATION);
}

export async function validateRefreshToken(token: string): Promise<any> {
	return validateToken(token, TOKEN_TYPE.REFRESH);
}

async function validateToken(token: string, tokenType: TOKEN_TYPE): Promise<any> {
	try {
		const keys: JWTRSAKeys = await getJWTRSAKeys();
		const tokenVerified: any = await jwt.verify(token, keys.publicKey, {
			algorithms: RSA_ALGORITHM,
			subject: tokenType,
		});

		// If a role is present, it means the token is not an operation token. The validation of
		// the token will happen in the respective function/component that uses the token.
		if (tokenVerified.role) {
			throw new Error('Invalid token');
		}

		const user: any = await findAndValidateUser(tokenVerified.username, undefined, false);
		if (tokenType === TOKEN_TYPE.REFRESH && !password.validate(user.refresh_token, token)) {
			throw new Error('Invalid token');
		}

		return user;
	} catch (err) {
		logger.warn(err);
		if (err?.name === 'TokenExpiredError') {
			throw new ClientError(AUTHENTICATION_ERROR_MSGS.TOKEN_EXPIRED, HTTP_STATUS_CODES.FORBIDDEN);
		}

		throw new ClientError(AUTHENTICATION_ERROR_MSGS.INVALID_TOKEN, HTTP_STATUS_CODES.UNAUTHORIZED);
	}
}
