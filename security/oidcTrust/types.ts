/**
 * Types for OIDC trusted publishing (#2171).
 */

/** A claim constraint: one accepted value, or a set of accepted values. */
export type ClaimConstraint = string | string[];

/**
 * A stored trust policy. Matching a policy lets an external CI run act as `user` without holding
 * any Harper credential — so every field here is load-bearing, and `claims` is validated at write
 * time (see validateTrustPolicyClaims) rather than trusted as written.
 */
export interface OidcTrustPolicy {
	/** Caller-supplied identifier, and the handle used to revoke. */
	id: string;
	/** Expected `iss`. Also the base for OIDC discovery. */
	issuer: string;
	/**
	 * Expected `aud`. Must identify *this* instance: the issuer's default audience is shared by
	 * every repository under an owner, so without an instance-specific audience a token minted for
	 * an unrelated service is replayable here.
	 */
	audience: string;
	/** Claim constraints, matched against the normalized token claims. */
	claims: Record<string, ClaimConstraint>;
	/**
	 * Harper user the exchanged token authenticates as. Least privilege is this user's role — the
	 * policy deliberately carries no operation allowlist of its own, because a second authorization
	 * mechanism running alongside roles is one more place for the two to disagree.
	 */
	user: string;
	/** Defaults to true; false keeps the policy for reference without honoring it. */
	enabled?: boolean;
	/** Free-text note for whoever reads `list_oidc_trust` a year from now. */
	description?: string;
}

/** Claims carried by a verified identity token, plus the derived entries normalizeTokenClaims adds. */
export type TokenClaims = Record<string, unknown>;
