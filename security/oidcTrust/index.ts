/**
 * Identity-token verification for OIDC trusted publishing (#2171).
 *
 * Verifies that a token was signed by the configured issuer and is addressed to this instance.
 * Matching the token against a trust policy's claim constraints is separate (see claims.ts), because
 * one verification serves every policy sharing an issuer and audience.
 */

import jwt, { type Algorithm, type JwtPayload } from 'jsonwebtoken';
import type { KeyObject } from 'node:crypto';
import { ClientError } from '../../utility/errors/hdbError.ts';
import { loggerWithTag } from '../../utility/logging/logger.ts';
import { getSigningKey as defaultGetSigningKey, normalizeIssuer } from './jwks.ts';
import { normalizeTokenClaims } from './claims.ts';
import type { TokenClaims } from './types.ts';

const logger = loggerWithTag('oidc-trust');

/**
 * Asymmetric signatures only. Passing this to jwt.verify is what prevents algorithm confusion: an
 * `alg: none` token, or one signed with HMAC using a public key as the secret, is rejected before
 * the signature is considered.
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

/** Leeway for clock skew between the runner, the issuer, and this instance. */
const CLOCK_TOLERANCE_SECONDS = 60;

/**
 * Ceiling on a token's own declared lifetime. CI identity tokens are minted per job and live minutes
 * — a correctly-signed token claiming a far-future expiry is not something we should honor for that
 * long, whatever the issuer intended.
 */
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
 * Fails verification. The reason is logged but never returned: the exchange endpoint is
 * unauthenticated, and a caller told exactly which check failed can probe a policy one claim at a
 * time.
 */
function rejectToken(detail: string): never {
	logger.warn?.(`Rejecting identity token: ${detail}`);
	throw new ClientError('Identity token was rejected', 401);
}

/**
 * Verifies a CI identity token against one issuer/audience pair and returns its normalized claims.
 *
 * The audience check is not incidental: an issuer's default audience is shared by every repository
 * under an owner, so a token minted for some other service would otherwise be replayable here.
 */
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

	// Check the algorithm before resolving a key so a garbage header costs no outbound request.
	const algorithm = decoded.header.alg as Algorithm;
	if (!ALLOWED_ALGORITHMS.includes(algorithm)) rejectToken(`unsupported algorithm ${decoded.header.alg}`);

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

	// jsonwebtoken only enforces `exp` when it is present, so a token without one never expires.
	if (typeof payload.exp !== 'number') rejectToken('token has no exp claim');
	if (typeof payload.iat === 'number' && payload.exp - payload.iat > MAX_TOKEN_LIFETIME_SECONDS) {
		rejectToken(`token lifetime exceeds ${MAX_TOKEN_LIFETIME_SECONDS}s`);
	}
	// The exchange records `jti` to block replay within the token's window; a token we cannot identify
	// is one we cannot replay-protect, so it is not one we will accept.
	if (typeof payload.jti !== 'string' || payload.jti === '') rejectToken('token has no jti claim');

	return normalizeTokenClaims(payload as TokenClaims);
}
