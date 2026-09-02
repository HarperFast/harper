import jwt, { type Algorithm, type JwtPayload, type Secret, type SignOptions } from 'jsonwebtoken';
import fs from 'fs-extra';
import path from 'node:path';
import Joi from 'joi';
import { validateBySchema } from '../validation/validationWrapper.ts';
import {
	CONFIG_PARAMS,
	JWT_ENUM,
	LICENSE_KEY_DIR_NAME,
	SYSTEM_SCHEMA_NAME,
	SYSTEM_TABLE_NAMES,
} from '../utility/hdbTerms.ts';
import { ClientError, ServerError, hdbErrors } from '../utility/errors/hdbError.ts';
const { HTTP_STATUS_CODES, AUTHENTICATION_ERROR_MSGS } = hdbErrors;
import logger from '../utility/logging/harper_logger.ts';
import * as password from '../utility/password.ts';
import { findAndValidateUser, type User } from './user.ts';
import { attachScopeToToken, attachScopeToUser, hasOperationScope } from './operationScope.ts';
import {
	WORKLOAD_IDENTITY_CLAIM,
	attachWorkloadIdentityToUser,
	isWorkloadIdentityPrincipal,
	markTokenAsWorkloadIdentity,
} from './credentialProvenance.ts';
import { buildScopedTokenUser, syntheticRoleName } from './impersonation.ts';
import { credentialRejectionError, isCredentialRejection } from './credentialRejection.ts';
import type { ImpersonatePayload } from '../server/operationsServer.ts';
import { expandOperationsPerms } from '../utility/operationPermissions.ts';
import { update } from '../dataLayer/insert.ts';
import UpdateObject from '../dataLayer/UpdateObject.ts';
import * as signalling from '../utility/signalling.ts';
import { isOperationAuthorizationBypassed } from '../server/serverHelpers/operationAuthorizationState.ts';
import { UserEventMsg } from '../server/threads/itc.js';
import * as env from '../utility/environment/environmentManager.ts';
env.initSync();

type StringValue = SignOptions['expiresIn'];
const OPERATION_TOKEN_TIMEOUT: StringValue = env.get(CONFIG_PARAMS.AUTHENTICATION_OPERATIONTOKENTIMEOUT) || '1d';
const REFRESH_TOKEN_TIMEOUT: StringValue = env.get(CONFIG_PARAMS.AUTHENTICATION_REFRESHTOKENTIMEOUT) || '30d';
// Default lifetime of a login-purpose token (see TOKEN_TYPE.LOGIN below). It only exists to be
// exchanged for a session cookie, so it defaults far shorter than an operation token; callers can
// still override via expires_in.
const LOGIN_TOKEN_TIMEOUT: StringValue = '1m';
const RSA_ALGORITHM: Algorithm = 'RS256';

const TOKEN_TYPE = {
	OPERATION: 'operation',
	REFRESH: 'refresh',
	// Purpose-scoped exchange token minted by createTokens({ purpose: 'login' }) and accepted only
	// by validateLoginToken (the `login` operation). Its `sub` claim differs from
	// TOKEN_TYPE.OPERATION, so validateOperationToken's Bearer-API path rejects it automatically —
	// it can't be replayed as a general API credential the way a full operation token could.
	LOGIN: 'login',
	// Minted by createTokens with an inline `role` object (super_user-gated): the token embeds its
	// own downgraded permission set and its bearer needs no hdb_user row. Accepted by
	// validateOperationToken, which builds a synthetic user from the embedded role.
	SCOPED: 'scoped-operation',
};

interface JWTRSAKeys {
	publicKey: string;
	privateKey: string;
	passphrase: string;
}

interface AuthObject {
	username?: string;
	password?: string;
	// A string role is stamped into the payload verbatim for component-defined token validation
	// (such tokens are rejected by validateOperationToken). An object role mints a scoped token —
	// see TOKEN_TYPE.SCOPED.
	role?: string | ImpersonatePayload['role'];
	expires_in?: string | number;
	hdb_user?: User;
	// 'login' mints a single short-lived, login-scoped token instead of an operation/refresh pair —
	// see TOKEN_TYPE.LOGIN.
	purpose?: 'login';
}

interface TokenObject {
	refresh_token: string;
}

interface JWTTokens {
	// Always the mint result: an operation JWT normally, or (purpose: 'login') the login-scoped
	// exchange JWT — same field, same response shape, callers don't need to branch on purpose.
	operation_token: string;
	refresh_token?: string;
}

/**
 * fetches the rsa keys from cache var or disk
 * @returns {Promise<JWTRSAKeys>}
 */
let rsaKeys: JWTRSAKeys | undefined = undefined;
// Bumped by every clearJWTRSAKeysCache() call. getJWTRSAKeys() captures it before its file reads and
// refuses to commit a result whose generation is stale, so a read that started before a clear (e.g. a
// Bearer-auth request in flight while node cloning replaces the key files) cannot resurrect the
// pre-clear keys into the cache after the clear ran.
let rsaKeysGeneration = 0;
export async function getJWTRSAKeys(): Promise<JWTRSAKeys> {
	if (rsaKeys) return rsaKeys;
	const generation: number = rsaKeysGeneration;
	try {
		const keysDir: string = path.join(env.getHdbBasePath(), LICENSE_KEY_DIR_NAME);
		const passphrase: string = await fs.readFile(path.join(keysDir, JWT_ENUM.JWT_PASSPHRASE_NAME), 'utf8');
		const privateKey: string = await fs.readFile(path.join(keysDir, JWT_ENUM.JWT_PRIVATE_KEY_NAME), 'utf8');
		const publicKey: string = await fs.readFile(path.join(keysDir, JWT_ENUM.JWT_PUBLIC_KEY_NAME), 'utf8');
		const keys: JWTRSAKeys = { publicKey, privateKey, passphrase };
		// Only populate the cache if no clear happened while we were reading; otherwise return the freshly
		// read keys without caching so the next call re-reads (the files may have just been replaced).
		if (generation === rsaKeysGeneration) rsaKeys = keys;
		return keys;
	} catch (err) {
		logger.error(err);
		throw new ClientError(AUTHENTICATION_ERROR_MSGS.NO_ENCRYPTION_KEYS, HTTP_STATUS_CODES.INTERNAL_SERVER_ERROR);
	}
}

/**
 * Drops the in-memory JWT RSA key cache so the next getJWTRSAKeys() re-reads from disk. Needed when the
 * key files are replaced underneath a running process — e.g. node cloning overwrites .jwtPublic/.jwtPrivate/
 * .jwtPass with the leader's keys after Harper (and thus the operations API) is already up, and an early
 * Bearer-auth request may have already cached the pre-clone install-generated keys. The operations API runs
 * only on the main thread, so clearing this process-local cache there is sufficient. Bumping the generation
 * also invalidates any getJWTRSAKeys() read already in flight, so it can't write the pre-clear keys back.
 */
export function clearJWTRSAKeysCache(): void {
	rsaKeysGeneration++;
	rsaKeys = undefined;
}

/**
 * Creates a new operation token and refresh token (or, with `purpose: 'login'`, a single
 * login-scoped token — see TOKEN_TYPE.LOGIN).
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
			role: Joi.alternatives(Joi.string(), Joi.object()).optional(),
			expires_in: Joi.alternatives(Joi.string(), Joi.number()).optional(),
			purpose: Joi.string().valid('login').optional(),
		})
	);
	if (validation) throw new ClientError(validation.message);

	// create_authentication_tokens is NO_AUTH, so verifyPerms — and the token-scope gate inside it —
	// never runs here. A caller holding a workload-identity token (#2171) must not mint any standing
	// credential through it: honoring expires_in verbatim turns a minutes-long leak into an
	// arbitrarily long-lived one, and the refresh_token write below hands out a 30-day credential —
	// both defeating the exchange's ephemerality guarantee. A CI token needs none of this; it already
	// holds the operation token the exchange gave it, and gets a fresh one next run.
	//
	// Gated on provenance, NOT on the scope: a trust policy carries `operations` only when the
	// operator opts in, so the ordinary exchanged token is unscoped and a scope-only check would let
	// exactly the common case through. The scope check stays as well, covering a scoped credential
	// from any other source.
	//
	// First, ahead of the user lookup and the `purpose` branch: this reads only the caller's own
	// principal, so a refused request should cost no database read and write nothing. That also
	// covers the login path, where a session is minted from a username alone and so cannot be
	// narrowed after the fact.
	// `authObj?.` — a bare createTokens() reaches here, and must still fail as invalid credentials
	// below rather than as a TypeError out of this guard.
	if (isWorkloadIdentityPrincipal(authObj?.hdb_user)) {
		throw new ClientError('a workload identity token cannot mint authentication tokens', HTTP_STATUS_CODES.FORBIDDEN);
	}
	if (hasOperationScope((authObj?.hdb_user as any)?.tokenOperations)) {
		throw new ClientError('a scoped token cannot mint authentication tokens', HTTP_STATUS_CODES.FORBIDDEN);
	}

	if (authObj?.role && typeof authObj.role === 'object') {
		return createScopedToken(authObj);
	}

	let user: any;
	try {
		// Trusted bypass is dispatch/async-context state (set by a component calling
		// server.operation(..., false)), never a body field — authObj.bypass_auth is
		// caller-controlled and would let anyone mint tokens for an arbitrary username
		// without a password (see operationAuthorizationState.ts).
		let validatePassword: boolean = !isOperationAuthorizationBypassed();
		if (!authObj.username && !authObj.password) {
			// A scoped-token bearer must not self-mint: its username is an unverified attribution
			// label, and resolving it here without a password would hand out standing operation/
			// refresh tokens for whatever real user later takes that name (privilege escalation).
			if (authObj.hdb_user?._scopedToken) {
				throw new ClientError(AUTHENTICATION_ERROR_MSGS.INVALID_CREDENTIALS, HTTP_STATUS_CODES.UNAUTHORIZED);
			}
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
	if (user.role?.permission) {
		superUser = user.role.permission.super_user === true;
	}

	const payload: {
		username: string;
		super_user: boolean;
		role?: any;
	} = { username: authObj.username, super_user: superUser };
	if (authObj.role) payload.role = authObj.role;

	const keys: JWTRSAKeys = await getJWTRSAKeys();

	if (authObj.purpose === 'login') {
		// Login-scoped exchange token: no refresh token, no user record update — it's a one-shot
		// ticket for the `login` operation to trade for a session cookie, not a standing credential.
		const loginToken = jwt.sign(
			{ username: authObj.username },
			{ key: keys.privateKey, passphrase: keys.passphrase } satisfies Secret,
			{
				expiresIn: (authObj.expires_in ?? LOGIN_TOKEN_TIMEOUT) as StringValue,
				algorithm: RSA_ALGORITHM,
				subject: TOKEN_TYPE.LOGIN,
			} satisfies SignOptions
		);
		return { operation_token: loginToken };
	}

	const operationToken = jwt.sign(
		payload,
		{ key: keys.privateKey, passphrase: keys.passphrase } satisfies Secret,
		{
			expiresIn: (authObj.expires_in ?? OPERATION_TOKEN_TIMEOUT) as StringValue,
			algorithm: RSA_ALGORITHM,
			subject: TOKEN_TYPE.OPERATION,
		} satisfies SignOptions
	);

	const refreshToken = jwt.sign(
		payload,
		{ key: keys.privateKey, passphrase: keys.passphrase } satisfies Secret,
		{
			expiresIn: REFRESH_TOKEN_TIMEOUT,
			algorithm: RSA_ALGORITHM,
			subject: TOKEN_TYPE.REFRESH,
		} satisfies SignOptions
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
 * Mints a scoped token: a single operation-usable JWT that embeds an inline role object, so its
 * bearer needs no hdb_user or hdb_role row. Requires an authenticated super_user minter (or
 * trusted internal dispatch). `username` is attribution only, must NOT name an existing user,
 * and defaults to `scoped:<minter>`. No refresh token is issued and no user record is touched,
 * so the token is irrevocable until expiry — size expires_in accordingly.
 */
// Measured on the signed token (base64url payload + signature), so it reflects what the
// Authorization header actually carries; keeps tokens inside common 16KB header limits.
const MAX_SCOPED_TOKEN_LENGTH = 12288;

async function createScopedToken(authObj: AuthObject): Promise<JWTTokens> {
	if (authObj.password) {
		throw new ClientError("'password' cannot be combined with an inline 'role' object");
	}
	if (authObj.purpose) {
		throw new ClientError("'purpose' cannot be combined with an inline 'role' object");
	}
	const scopedUser = await buildScopedTokenUser(
		authObj.hdb_user,
		{ username: authObj.username, role: authObj.role as ImpersonatePayload['role'] },
		isOperationAuthorizationBypassed()
	);
	const keys: JWTRSAKeys = await getJWTRSAKeys();
	const operationToken = jwt.sign(
		{
			username: scopedUser.username,
			super_user: false,
			role: { permission: scopedUser.role.permission },
			minted_by: authObj.hdb_user?.username,
		},
		{ key: keys.privateKey, passphrase: keys.passphrase } satisfies Secret,
		{
			expiresIn: (authObj.expires_in ?? OPERATION_TOKEN_TIMEOUT) as StringValue,
			algorithm: RSA_ALGORITHM,
			subject: TOKEN_TYPE.SCOPED,
		} satisfies SignOptions
	);
	if (operationToken.length > MAX_SCOPED_TOKEN_LENGTH) {
		throw new ClientError(
			`the minted token exceeds ${MAX_SCOPED_TOKEN_LENGTH} bytes and would not fit in an Authorization header; reduce the role permission size`
		);
	}
	// role.role is the content hash of the granted permission set — logged so an operator can
	// correlate outstanding tokens with what they grant.
	logger.info(
		`Scoped token minted by "${authObj.hdb_user?.username ?? '<internal>'}" for "${scopedUser.username}" (${scopedUser.role.role})`
	);
	return { operation_token: operationToken };
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
	const decodedJWT = jwt.decode(refresh_token, { json: true });
	const refreshedPayload: { username: string; super_user: boolean; operations?: string[] } = {
		username: decodedJWT.username,
		super_user: decodedJWT.super_user,
	};
	// Refreshing a scoped refresh token must not widen back to the full role.
	attachScopeToToken(refreshedPayload, decodedJWT.operations);
	const operationToken = jwt.sign(
		refreshedPayload,
		{ key: keys.privateKey, passphrase: keys.passphrase } satisfies Secret,
		{
			expiresIn: OPERATION_TOKEN_TIMEOUT as StringValue,
			algorithm: RSA_ALGORITHM,
			subject: TOKEN_TYPE.OPERATION,
		} satisfies SignOptions
	);

	return { operation_token: operationToken };
}

/**
 * Signs a standalone operation token. No refresh token, no write to the user record.
 *
 * createTokens cannot serve this: it overwrites hdb_user.refresh_token as a side effect, silently
 * revoking whatever credential that user already held (#2018). The OIDC exchange (#2171) exists so
 * CI holds no durable credential at all, so minting one on its behalf would defeat the point.
 *
 * The caller is responsible for having established that the user exists, is active, and is entitled
 * to this token — nothing here re-checks that.
 */
export async function createOperationToken(
	user: { username: string; super_user: boolean; operations?: string[] },
	expiresIn: StringValue
): Promise<string> {
	const keys: JWTRSAKeys = await getJWTRSAKeys();
	const payload: { username: string; super_user: boolean; operations?: string[] } = {
		username: user.username,
		super_user: user.super_user,
	};
	// A narrowing scope, never a grant: verifyPerms intersects it with the user's role. An empty scope
	// (deny-all) is preserved rather than dropped — attachScopeToToken carries any array, which is
	// what keeps this from failing open.
	attachScopeToToken(payload, user.operations);
	// Unconditional, because every token this function mints is minted without a password — the
	// caller vouched for the user instead. That is precisely the credential that must not be able to
	// trade itself for a longer-lived one, whether or not a scope narrows it.
	markTokenAsWorkloadIdentity(payload);

	return jwt.sign(
		payload,
		{ key: keys.privateKey, passphrase: keys.passphrase } satisfies Secret,
		{
			expiresIn,
			algorithm: RSA_ALGORITHM,
			subject: TOKEN_TYPE.OPERATION,
		} satisfies SignOptions
	);
}

export async function validateOperationToken(token: string): Promise<any> {
	return validateToken(token, TOKEN_TYPE.OPERATION);
}

export async function validateRefreshToken(token: string): Promise<any> {
	return validateToken(token, TOKEN_TYPE.REFRESH);
}

/**
 * Validates a login-purpose token minted via createTokens({ purpose: 'login' }). Used solely by
 * the `login` operation to exchange the token for an httpOnly session cookie — this is the only
 * place a `sub: 'login'` token is accepted.
 */
export async function validateLoginToken(token: string): Promise<any> {
	return validateToken(token, TOKEN_TYPE.LOGIN);
}

async function validateToken(token: string, tokenType: string): Promise<any> {
	try {
		const keys: JWTRSAKeys = await getJWTRSAKeys();
		assertUsableVerificationKey(keys.publicKey);
		// The OPERATION type also accepts scoped tokens, so the subject is checked after
		// verification rather than pinned in the verify options.
		const tokenVerified = jwt.verify(
			token,
			keys.publicKey,
			tokenType === TOKEN_TYPE.OPERATION
				? { algorithms: [RSA_ALGORITHM] }
				: { algorithms: [RSA_ALGORITHM], subject: tokenType }
		) as JwtPayload;

		if (tokenType === TOKEN_TYPE.OPERATION && tokenVerified.sub === TOKEN_TYPE.SCOPED) {
			return buildUserFromScopedToken(tokenVerified);
		}
		if (tokenVerified.sub !== tokenType) {
			throw credentialRejectionError(AUTHENTICATION_ERROR_MSGS.INVALID_TOKEN, HTTP_STATUS_CODES.UNAUTHORIZED);
		}

		// If a role is present, it means the token is not an operation token. The validation of
		// the token will happen in the respective function/component that uses the token.
		if (tokenVerified.role) {
			throw credentialRejectionError(AUTHENTICATION_ERROR_MSGS.INVALID_TOKEN, HTTP_STATUS_CODES.UNAUTHORIZED);
		}

		const user: any = await findAndValidateUser(tokenVerified.username, undefined, false);
		if (tokenType === TOKEN_TYPE.REFRESH && !password.validate(user.refresh_token, token)) {
			throw credentialRejectionError(AUTHENTICATION_ERROR_MSGS.INVALID_TOKEN, HTTP_STATUS_CODES.UNAUTHORIZED);
		}

		// Surfaced as `tokenOperations` rather than merged into role.permission.operations: that field
		// is not purely narrowing (verifyPerms gate 2 treats an explicit SU-only listing as a grant),
		// so merging a token scope into it could widen. verifyPerms intersects this separately, ahead
		// of every bypass.
		attachScopeToUser(user, tokenVerified.operations);
		// Provenance rides the same lift: the claim is signed, so a caller cannot strip it to look
		// like a password-minted principal at createTokens.
		attachWorkloadIdentityToUser(user, tokenVerified[WORKLOAD_IDENTITY_CLAIM]);

		return user;
	} catch (err) {
		logger.warn(err);
		if (err?.name === 'TokenExpiredError') {
			throw credentialRejectionError(AUTHENTICATION_ERROR_MSGS.TOKEN_EXPIRED, HTTP_STATUS_CODES.FORBIDDEN);
		}
		// Only a client-side rejection may be reported as one. Everything else here — unreadable or
		// malformed JWT key material, a storage failure inside findAndValidateUser, a bug — propagates
		// unmasked, because callers distinguish a rejected credential from an internal authentication
		// fault and only the former is deferred past route matching. Masking a fault as
		// `invalid token` would let a key or storage outage read as an unknown credential.
		if (!isTokenRejection(err)) throw err;

		throw credentialRejectionError(AUTHENTICATION_ERROR_MSGS.INVALID_TOKEN, HTTP_STATUS_CODES.UNAUTHORIZED);
	}
}

/**
 * `jsonwebtoken` error names that describe the *token*: syntax, signature, subject/audience claims,
 * and the not-before/expiry windows. Anything else it raises is about Harper's own configuration.
 */
const JWT_REJECTION_ERROR_NAMES = new Set(['JsonWebTokenError', 'NotBeforeError', 'TokenExpiredError']);
/**
 * `jsonwebtoken` reports an unusable verification key through the same `JsonWebTokenError` type it
 * uses for a bad token, distinguished only by message — either its own `secretOrPublicKey…` guards
 * or a passed-through OpenSSL failure. Those are Harper-side faults and must never be reported to a
 * client as a rejected credential.
 */
const KEY_MATERIAL_FAULT = /secretOrPublicKey|asymmetric key|PEM routines|^error:/i;

/**
 * True only when `err` says the presented token is not acceptable, rather than that Harper failed to
 * evaluate it. Never inferred from the 4xx range: `findAndValidateUser()` lazily loads the user cache
 * and can surface a default-status-400 `ClientError` from a missing system table, which is a storage
 * fault wearing a client-error status.
 */
function isTokenRejection(err: any): boolean {
	if (isCredentialRejection(err)) return true;
	if (!JWT_REJECTION_ERROR_NAMES.has(err?.name)) return false;
	return !KEY_MATERIAL_FAULT.test(String(err?.message ?? ''));
}

/**
 * Fails closed before `jwt.verify()` when the configured public key cannot be verification key
 * material at all. Without this, `jsonwebtoken` folds the failure into a `JsonWebTokenError`, which
 * is otherwise indistinguishable from a forged signature.
 */
function assertUsableVerificationKey(publicKey: unknown): void {
	if (typeof publicKey !== 'string' || !publicKey.includes('-----BEGIN')) {
		throw new ServerError(AUTHENTICATION_ERROR_MSGS.NO_ENCRYPTION_KEYS, HTTP_STATUS_CODES.INTERNAL_SERVER_ERROR);
	}
}

/**
 * Builds the request user for a verified scoped token from its embedded role. No hdb_user lookup:
 * the signed claims are the whole identity. The downgrade is re-applied here as defense-in-depth,
 * so no scoped token — whatever minted it — can ever assert super_user or cluster_user.
 */
function buildUserFromScopedToken(claims: JwtPayload): User {
	const embedded = (claims.role as { permission?: Record<string, unknown> })?.permission;
	if (!embedded || typeof embedded !== 'object' || Array.isArray(embedded) || typeof claims.username !== 'string') {
		throw credentialRejectionError(AUTHENTICATION_ERROR_MSGS.INVALID_TOKEN, HTTP_STATUS_CODES.UNAUTHORIZED);
	}
	const permission: Record<string, unknown> = { ...embedded, super_user: false, cluster_user: false };
	// Hashed from the server-side downgraded clone (before the _expandedOperations Set is attached),
	// so the memo key reflects the effective permissions — see syntheticRoleName.
	const roleName = syntheticRoleName('_scoped_token', permission);
	if (Array.isArray(permission.operations)) {
		permission._expandedOperations = expandOperationsPerms(permission.operations as string[]);
	}
	return {
		username: claims.username,
		active: true,
		_scopedToken: true,
		_mintedBy: claims.minted_by,
		role: {
			permission: permission as User['role']['permission'],
			role: roleName,
			id: roleName,
			__updatedtime__: 0,
			__createdtime__: 0,
		},
	};
}

/**
 * Decodes a JWT and returns its payload.
 * @param {string} token The JWT token to decode.
 * @returns {Object|null} The decoded payload or null if invalid.
 */
export function decodeJWT(token: string): null | { exp: number; iat: number } {
	try {
		const parts = token.split('.');
		if (parts.length !== 3) return null;
		const payload = parts[1];
		const decoded = Buffer.from(payload, 'base64').toString('utf8');
		return JSON.parse(decoded);
	} catch {
		return null;
	}
}

/**
 * Decodes a JWT and checks if it has expired or is going to expire soon (based on the buffer seconds).
 */
export function isJWTExpired(token: string, bufferSeconds = 300): boolean {
	const payload = decodeJWT(token);
	if (!payload || !payload.exp) return true;
	const now = Math.floor(Date.now() / 1000);
	return payload.exp < now + bufferSeconds;
}
