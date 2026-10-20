import { server, getBearerValidators, type BearerValidatorEntry } from '../server/Server.ts';
import type { Request } from '../server/serverHelpers/Request.ts';
import { cloneUserView, isCurrentUser, trackUserRecords, userRecordVersions, type User } from './user.ts';
import { credentialRejectionError } from './credentialRejection.ts';
import harperLogger from '../utility/logging/harper_logger.ts';
import { hdbErrors } from '../utility/errors/hdbError.ts';
const { AUTHENTICATION_ERROR_MSGS, HTTP_STATUS_CODES } = hdbErrors;
const authLogger = harperLogger.forComponent('authentication');

const DEFAULT_TTL_SECONDS = 300;
const MAX_TTL_SECONDS = 365 * 24 * 60 * 60;
// role is refused rather than ignored, so inline permissions can be added later without changing what an existing result means
const RESULT_FIELDS = new Set(['username', 'authExpiresAt', 'authCacheable']);

interface ValidatorDeadline {
	at: number;
	budgetMs: number;
}

export interface BearerValidatorClaim {
	entry: BearerValidatorEntry;
	result: any;
	deadline: ValidatorDeadline;
}

export async function runBearerValidators(token: string, request: Request): Promise<BearerValidatorClaim | undefined> {
	const entries = getBearerValidators();
	let budgetMs = 0;
	for (const entry of entries) {
		if (entry.active && entry.timeoutMs > budgetMs) budgetMs = entry.timeoutMs;
	}
	const deadline: ValidatorDeadline = { at: Date.now() + budgetMs, budgetMs };
	for (const entry of entries) {
		if (!entry.active) continue;
		if (deadline.at <= Date.now()) throw new Error(`Bearer validator chain timed out after ${budgetMs}ms`);
		const abortController = new AbortController();
		const result: any = await withinDeadline(
			entry.validator(token, request, abortController.signal),
			entry.timeoutMs,
			deadline,
			abortController
		);
		if (!entry.active || result == null) continue;
		if (
			typeof result !== 'object' ||
			Array.isArray(result) ||
			typeof result.username !== 'string' ||
			result.username.length === 0
		) {
			throw new Error('Bearer validator must return { username, authExpiresAt?, authCacheable? }, or null/undefined');
		}
		for (const field of Object.keys(result)) {
			if (!RESULT_FIELDS.has(field)) {
				throw new Error(
					`Bearer validator result field '${field}' is not supported; return { username, authExpiresAt?, authCacheable? } and let server.getUser supply the role`
				);
			}
		}
		if (result.authCacheable !== undefined && typeof result.authCacheable !== 'boolean') {
			throw new Error('Bearer validator authCacheable must be a boolean');
		}
		return { entry, result, deadline };
	}
	return undefined;
}

export async function principalFromClaim(
	{ entry, result, deadline }: BearerValidatorClaim,
	decodedToken: any,
	request: Request
): Promise<{ user: User; cacheable: boolean }> {
	const { authExpiresAt, expired } = effectiveExpiry(result.authExpiresAt, decodedToken);
	const user = await resolveUser(entry, result.username, request, deadline);
	// the server.getUser lookup can outlast the token
	if (authExpiresAt * 1000 <= Date.now()) {
		throw credentialRejectionError(AUTHENTICATION_ERROR_MSGS.TOKEN_EXPIRED, HTTP_STATUS_CODES.UNAUTHORIZED);
	}
	user._bearerValidator = true;
	user.authExpiresAt = authExpiresAt;
	// an expired self-described JWT the validator still accepted is served once, never from cache
	return { user, cacheable: !expired && result.authCacheable !== false };
}

/**
 * The validator's `authExpiresAt`, capped by the token's own future `exp`; with neither, a short
 * default, so a principal the validator would now refuse is not served from cache for long.
 */
function effectiveExpiry(claimedExp: unknown, decodedToken: any): { authExpiresAt: number; expired: boolean } {
	const nowSec = Date.now() / 1000;
	if (
		claimedExp !== undefined &&
		(typeof claimedExp !== 'number' || !Number.isFinite(claimedExp) || claimedExp > nowSec + MAX_TTL_SECONDS)
	) {
		throw new Error('Bearer validator authExpiresAt must be a finite number of epoch seconds within a year');
	}
	const claimed = claimedExp as number | undefined;
	if (claimed !== undefined && claimed <= nowSec) {
		throw credentialRejectionError(AUTHENTICATION_ERROR_MSGS.TOKEN_EXPIRED, HTTP_STATUS_CODES.UNAUTHORIZED);
	}
	// decodedToken is unverified: it may shorten the lifetime, never extend it
	const tokenExp =
		typeof decodedToken?.exp === 'number' && Number.isFinite(decodedToken.exp) ? decodedToken.exp : undefined;
	const futureTokenExp = tokenExp !== undefined && tokenExp > nowSec ? tokenExp : undefined;
	const exp = claimed ?? Math.floor(nowSec) + DEFAULT_TTL_SECONDS;
	return {
		authExpiresAt: futureTokenExp !== undefined ? Math.min(exp, futureTokenExp) : exp,
		expired: tokenExp !== undefined && tokenExp <= nowSec,
	};
}

async function resolveUser(
	entry: BearerValidatorEntry,
	username: string,
	request: Request,
	deadline: ValidatorDeadline
): Promise<User> {
	const versions = userRecordVersions(username);
	const resolved: any = await withinDeadline(server.getUser(username, null, request), entry.timeoutMs, deadline);
	// core server.getUser answers an unknown username with a role-less view
	if (
		!resolved ||
		typeof resolved !== 'object' ||
		!isPlainObject(resolved.role) ||
		!isPlainObject(resolved.role.permission)
	) {
		throw credentialRejectionError(AUTHENTICATION_ERROR_MSGS.GENERIC_AUTH_FAIL, HTTP_STATUS_CODES.UNAUTHORIZED);
	}
	if (resolved.active === false) {
		throw credentialRejectionError(AUTHENTICATION_ERROR_MSGS.USER_INACTIVE, HTTP_STATUS_CODES.UNAUTHORIZED);
	}
	trackUserRecords(resolved, versions);
	if (!isCurrentUser(resolved)) {
		authLogger.warn(
			`Bearer validator's server.getUser view for '${username}' no longer matches its hdb_user/hdb_role records (user modified since lookup, or a getUser view memoized across updates)`
		);
		throw credentialRejectionError(AUTHENTICATION_ERROR_MSGS.GENERIC_AUTH_FAIL, HTTP_STATUS_CODES.UNAUTHORIZED);
	}
	const user = cloneUserView(resolved);
	if (user.active === undefined) user.active = true;
	return user;
}

function isPlainObject(value: unknown): value is Record<string, any> {
	return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

async function withinDeadline<T>(
	value: T | Promise<T>,
	timeoutMs: number,
	deadline: ValidatorDeadline,
	abortController?: AbortController
): Promise<T> {
	if (value == null || typeof (value as Promise<T>).then !== 'function') return value as T;
	const pending = Promise.resolve(value);
	pending.catch(() => {}); // a rejection after the deadline has nobody listening
	const chainRemainingMs = Math.max(0, deadline.at - Date.now());
	const remainingMs = Math.min(timeoutMs, chainRemainingMs);
	const timeoutError = () =>
		chainRemainingMs < timeoutMs
			? new Error(`Bearer validator chain timed out after ${deadline.budgetMs}ms (remaining budget ${remainingMs}ms)`)
			: new Error(`Bearer validator timed out after ${timeoutMs}ms`);
	if (remainingMs <= 0) {
		const error = timeoutError();
		abortController?.abort(error);
		throw error;
	}
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		return await Promise.race([
			pending,
			new Promise<never>((_resolve, reject) => {
				timer = setTimeout(() => {
					const error = timeoutError();
					// settle first: an abort listener that resolves the validator must not win the race
					reject(error);
					abortController?.abort(error);
				}, remainingMs);
				timer.unref?.();
			}),
		]);
	} finally {
		clearTimeout(timer);
	}
}
