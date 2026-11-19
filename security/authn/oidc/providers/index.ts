/**
 * Provider profiles for OIDC trusted publishing (#2171).
 *
 * Everything issuer-specific lives behind this interface, resolved by normalized issuer, so the core
 * stays generic: a new workload-identity issuer is a profile, not a change to verification, matching,
 * or storage. Issuers with no registered profile fall back to `generic`, which is strict rather than
 * permissive — see its `assertPolicyIsSpecific`.
 */

import type { ClaimConstraint, TokenClaims } from '../types.ts';
import { genericProfile } from './generic.ts';
import { githubActionsProfile } from './githubActions.ts';

export interface IdentityProviderProfile {
	/** Shown in policy-validation errors and the audit trail. */
	name: string;

	/**
	 * Rejects a claim set too broad to be a safe policy for this issuer. Called at write time, when
	 * the reader is an administrator who can act on the message.
	 */
	assertPolicyIsSpecific(policyClaims: Record<string, ClaimConstraint>): void;

	/**
	 * Rejects an audience the issuer shares across principals — the mistake that makes an audience
	 * check meaningless. A no-op for issuers with no such default.
	 */
	assertAudienceIsSpecific(audience: string): void;

	/** Adds issuer-specific derived claims. Must never displace a claim the token actually carries. */
	normalizeClaims(payload: TokenClaims): TokenClaims;

	/** One-line principal description for the audit trail. */
	describePrincipal(claims: TokenClaims): string;

	/**
	 * A match-time veto applied after the policy's own constraints pass, for runs this issuer should
	 * refuse unless a policy opts in explicitly. Returns a reason to deny, or undefined to allow.
	 */
	vetoClaims?(claims: TokenClaims, policyClaims: Record<string, ClaimConstraint>): string | undefined;
}

const PROFILES_BY_ISSUER = new Map<string, IdentityProviderProfile>([
	['https://token.actions.githubusercontent.com', githubActionsProfile],
]);

/** Never returns undefined: an unregistered issuer gets the strict generic profile. */
export function profileForIssuer(issuer: string): IdentityProviderProfile {
	return PROFILES_BY_ISSUER.get(issuer) ?? genericProfile;
}

export { genericProfile, githubActionsProfile };
