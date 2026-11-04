/**
 * Fallback profile for issuers with no registered provider profile (#2171).
 *
 * Strict rather than permissive: the policy must pin `sub`. That is what makes workload identity work
 * with zero provider code — a Kubernetes service-account token
 * (`system:serviceaccount:<namespace>:<name>`), a GCP service account, and a SPIFFE SVID all carry a
 * stable canonical subject, so pinning it identifies exactly one principal.
 *
 * GitHub Actions needs its own profile precisely because its `sub` is the one claim you should not
 * pin: it varies by trigger, and its format changed for repositories created after 2026-07-15.
 */

import { ClientError } from '../../../../utility/errors/hdbError.ts';
import type { ClaimConstraint, TokenClaims } from '../types.ts';
import type { IdentityProviderProfile } from './index.ts';

export const genericProfile: IdentityProviderProfile = {
	name: 'generic OIDC',

	assertPolicyIsSpecific(policyClaims: Record<string, ClaimConstraint>): void {
		if (policyClaims.sub === undefined) {
			throw new ClientError(
				'claims must pin `sub` for an issuer with no registered provider profile — it is the only ' +
					'claim every OIDC issuer defines as identifying a single principal. Register a provider ' +
					'profile if this issuer needs richer rules.'
			);
		}
	},

	// No known shared default audience; the required `sub` pin already binds the policy to one principal.
	assertAudienceIsSpecific(): void {},

	normalizeClaims(payload: TokenClaims): TokenClaims {
		return { ...payload };
	},

	describePrincipal(claims: TokenClaims): string {
		return typeof claims.sub === 'string' ? claims.sub : 'unknown principal';
	},
};
