/**
 * Types for OIDC trusted publishing (#2171).
 */

/** One accepted value, or a set of them. */
export type ClaimConstraint = string | string[];

/**
 * A stored trust policy. Matching one lets an external CI run act as `user` without holding any
 * Harper credential, so `claims` is validated at write time rather than trusted as written — see
 * validateTrustPolicyClaims for the structural requirements, and addOidcTrust for the rest.
 */
export interface OidcTrustPolicy {
	id: string;
	/** Expected `iss`, and the base for OIDC discovery. */
	issuer: string;
	/** Expected `aud`. Must identify this instance — see SHARED_DEFAULT_AUDIENCE. */
	audience: string;
	claims: Record<string, ClaimConstraint>;
	/** The exchanged token authenticates as this user, whose role is the least-privilege boundary. */
	user: string;
	/** Defaults to true; false keeps the policy for reference without honoring it. */
	enabled?: boolean;
	description?: string;
}

/** A verified token's payload, plus the entries normalizeTokenClaims derives. */
export type TokenClaims = Record<string, unknown>;
