/**
 * Identity-token verification for OIDC trusted publishing (#2171).
 *
 * Verifies that a token was signed by the configured issuer and is addressed to this instance.
 * Matching it against a policy's claim constraints is separate (claims.ts), because one verification
 * serves every policy sharing an issuer and audience.
 */

import jwt, { type Algorithm, type JwtPayload } from 'jsonwebtoken';
import type { KeyObject } from 'node:crypto';
import { ClientError } from '../../../utility/errors/hdbError.ts';
import { loggerWithTag } from '../../../utility/logging/logger.ts';
import { getSigningKey as defaultGetSigningKey, normalizeIssuer } from './jwks.ts';
import { profileForIssuer } from './providers/index.ts';
import type { TokenClaims } from './types.ts';

const logger = loggerWithTag('oidc-trust');

/**
 * Asymmetric signatures only. Passing this to jwt.verify is what prevents algorithm confusion: an
 * `alg: none` token, or one HMAC-signed with a public key as the secret, is rejected before the
 * signature is considered.
 */
const ALLOWED_ALGORITHMS: Algorithm[] = [
	'RS256',
	'RS384',
	'RS512',
	'ES256',
	'ES384',
	'ES512',
	'PS256',
	'PS384',
	'PS512',
];

const CLOCK_TOLERANCE_SECONDS = 60;

/** CI identity tokens are minted per job and live minutes; a far-future expiry is not one to honor. */
const MAX_TOKEN_LIFETIME_SECONDS = 3_600;

export interface VerifyTokenTarget {
	issuer: string;
	audience: string;
}

export interface VerifyTokenOptions {
	/** Overridable for tests; defaults to the network-backed JWKS lookup. */
	getSigningKey?: (issuer: string, kid: unknown) => Promise<KeyObject>;
	/** Seconds since the epoch to evaluate expiry against; defaults to the real clock. */
	clockTimestamp?: number;
}

/**
 * Refuses a token. Shared with the exchange so both halves fail identically: the endpoint is
 * unauthenticated, and a caller told exactly which check failed can probe a policy one claim at a
 * time. The reason goes to the log instead.
 */
export function rejectToken(detail: string): never {
	logger.warn?.(`Rejecting identity token: ${detail}`);
	throw new ClientError('Identity token was rejected', 401);
}

/** Verifies a CI identity token against one issuer/audience pair and returns its normalized claims. */
export async function verifyIdentityToken(
	token: unknown,
	target: VerifyTokenTarget,
	options: VerifyTokenOptions = {}
): Promise<TokenClaims> {
	if (typeof token !== 'string' || token === '') throw new ClientError('token is required');
	const issuer = normalizeIssuer(target.issuer);
	if (typeof target.audience !== 'string' || target.audience === '') {
		throw new ClientError('audience is required');
	}

	const decoded = jwt.decode(token, { complete: true });
	if (!decoded) rejectToken('token is not a well-formed JWT');

	// Checked before resolving a key so a garbage header costs no outbound request.
	if (!ALLOWED_ALGORITHMS.includes(decoded.header.alg as Algorithm)) {
		rejectToken(`unsupported algorithm ${decoded.header.alg}`);
	}

	const getSigningKey = options.getSigningKey ?? defaultGetSigningKey;
	const key = await getSigningKey(issuer, decoded.header.kid);

	let payload: JwtPayload;
	try {
		payload = jwt.verify(token, key, {
			algorithms: ALLOWED_ALGORITHMS,
			issuer,
			audience: target.audience,
			clockTolerance: CLOCK_TOLERANCE_SECONDS,
			...(options.clockTimestamp === undefined ? {} : { clockTimestamp: options.clockTimestamp }),
		}) as JwtPayload;
	} catch (error) {
		rejectToken((error as Error).message);
	}

	// jsonwebtoken only enforces `exp` when present, so a token without one never expires.
	if (typeof payload.exp !== 'number') rejectToken('token has no exp claim');
	// `iat` is REQUIRED by OIDC, and required here rather than treated as optional: skipping the
	// ceiling when it is absent means a token carrying a distant `exp` and no `iat` is unbounded —
	// the ceiling would silently not apply to exactly the token that most needs it.
	if (typeof payload.iat !== 'number') rejectToken('token has no iat claim');

	// Bounded against the verification clock, not only as `exp - iat`. jsonwebtoken validates `exp`
	// and `nbf` but never rejects a future `iat`, so an issuer that shifts the whole pair forward
	// keeps a small delta and still hands out a token valid far longer than the ceiling. Both the
	// delta and the absolute distance to `exp` are checked; the tolerance mirrors the one given to
	// jwt.verify so genuine clock skew is not treated as an attack.
	const now = options.clockTimestamp ?? Math.floor(Date.now() / 1000);
	if (payload.iat > now + CLOCK_TOLERANCE_SECONDS) rejectToken('token iat is in the future');
	if (payload.exp - payload.iat > MAX_TOKEN_LIFETIME_SECONDS) {
		rejectToken(`token lifetime exceeds ${MAX_TOKEN_LIFETIME_SECONDS}s`);
	}
	if (payload.exp - now > MAX_TOKEN_LIFETIME_SECONDS + CLOCK_TOLERANCE_SECONDS) {
		rejectToken(`token expires more than ${MAX_TOKEN_LIFETIME_SECONDS}s from now`);
	}
	// No `jti` requirement: not every issuer emits one (Azure uses `uti`, others omit it), and the
	// exchange keys replay on a hash of the token itself, which is universal.

	return profileForIssuer(issuer).normalizeClaims(payload as TokenClaims);
}
