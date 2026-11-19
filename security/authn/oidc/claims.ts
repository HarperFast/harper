/**
 * Issuer-agnostic claim matching and constraint validation (#2171).
 *
 * Pure — no network, no storage, and nothing that knows which issuer a token came from. Rules that
 * depend on the issuer live in providers/.
 */

import { ClientError } from '../../../utility/errors/hdbError.ts';
import type { ClaimConstraint, TokenClaims } from './types.ts';

/** Issuers may encode a numeric id as a JSON number; anything non-scalar is not comparable. */
function claimToString(value: unknown): string | undefined {
	if (typeof value === 'string') return value;
	if (typeof value === 'number' && Number.isFinite(value)) return String(value);
	return undefined;
}

/**
 * Returns undefined on a match, or the first failure's reason — for the log, never the caller.
 *
 * A constrained claim absent from the token fails rather than passes, so a policy cannot be weakened
 * by an issuer that stops emitting a claim.
 */
export function matchTrustPolicyClaims(
	claims: TokenClaims,
	policyClaims: Record<string, ClaimConstraint>
): string | undefined {
	const constraints = Object.entries(policyClaims);
	// validateClaimConstraintShape rejects this at write time; this backstops a row that reached the
	// table another way, such as replication from a peer.
	if (constraints.length === 0) return 'policy constrains no claims';

	for (const [claimName, constraint] of constraints) {
		const actual = claimToString(claims[claimName]);
		if (actual === undefined || actual === '') return `token has no usable ${claimName} claim`;
		const accepted = Array.isArray(constraint) ? constraint : [constraint];
		// Exact membership, deliberately — never a prefix, wildcard, or regex. Relaxing this to
		// something like `startsWith` is the classic trusted-publishing escalation: a policy pinning
		// `HarperFast/my-app` would then also admit `HarperFast/my-app-evil`, a repository anyone can
		// create. unitTests/security/authn/oidc/claims.test.js pins both argument orders.
		if (!accepted.includes(actual)) return `${claimName} does not match the policy`;
	}
	return undefined;
}

/**
 * Validates the *shape* of a policy's constraints — that each is a usable set of comparable values.
 * Whether the set is specific enough to be safe depends on the issuer; that is the provider profile's
 * assertPolicyIsSpecific.
 *
 * Throws ClientError naming the first problem; the reader is an administrator writing a policy.
 */
export function validateClaimConstraintShape(
	policyClaims: unknown
): asserts policyClaims is Record<string, ClaimConstraint> {
	if (!policyClaims || typeof policyClaims !== 'object' || Array.isArray(policyClaims)) {
		throw new ClientError('claims must be an object of claim constraints');
	}

	const entries = Object.entries(policyClaims as Record<string, unknown>);
	if (entries.length === 0) throw new ClientError('claims must constrain at least one claim');

	for (const [claimName, constraint] of entries) {
		const values = Array.isArray(constraint) ? constraint : [constraint];
		if (values.length === 0) throw new ClientError(`claims.${claimName} must accept at least one value`);
		for (const value of values) {
			if (typeof value !== 'string' || value === '') {
				throw new ClientError(`claims.${claimName} must be a non-empty string or an array of non-empty strings`);
			}
		}
	}
}
