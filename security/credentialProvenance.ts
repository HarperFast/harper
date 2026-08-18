/**
 * Provenance for a credential minted from a workload identity exchange (#2171) rather than from a
 * password.
 *
 * The exchange's whole guarantee is that CI holds nothing durable: a one-hour operation token, no
 * refresh token, nothing on disk to leak. That guarantee is only as strong as the paths that turn
 * one credential into another. `create_authentication_tokens` is such a path and does not look like
 * one: it is in `NO_AUTH_OPERATIONS`, but `serverHandlers.js` special-cases it so a call with no
 * username/password authenticates by Bearer token instead — so an exchanged token is accepted there
 * as if it were a password, honors a caller-supplied `expires_in` verbatim, and returns a 30-day
 * refresh token. That converts a minutes-long leak into a month-long one, which is the exact
 * exposure this feature exists to remove.
 *
 * A scope (operationScope.ts) cannot carry this weight. A trust policy names `operations` only when
 * the operator opts in, so the ordinary exchanged token is UNSCOPED and a scope check finds nothing
 * to deny — the common case would sail through a scope-only guard. Provenance is therefore recorded
 * independently of scope, on every exchanged token.
 *
 * Like the scope, it lives under two names depending on the carrier: the claim `workload_identity`
 * on a JWT payload, and `fromWorkloadIdentity` on an in-memory principal (validateToken lifts the
 * claim across). And like the scope, every path that produces a credential or a principal has to
 * carry it forward — impersonation included, or a workload token launders its provenance by
 * impersonating and then mints freely.
 */

/** The JWT claim name. Signed with the rest of the payload, so it cannot be stripped in transit. */
export const WORKLOAD_IDENTITY_CLAIM = 'workload_identity';

/** Stamps a token payload as workload-identity provenance. Returns the payload. */
export function markTokenAsWorkloadIdentity<T extends object>(payload: T): T {
	(payload as any)[WORKLOAD_IDENTITY_CLAIM] = true;
	return payload;
}

/** Lifts the claim from a verified token onto a user principal. Returns the user. */
export function attachWorkloadIdentityToUser<T extends object>(user: T, claim: unknown): T {
	if (claim === true) (user as any).fromWorkloadIdentity = true;
	return user;
}

/**
 * True when this principal authenticated with a workload-identity token. Checked strictly against
 * `true` so a forged string or object on a user record cannot widen it.
 */
export function isWorkloadIdentityPrincipal(user: unknown): boolean {
	return (user as any)?.fromWorkloadIdentity === true;
}
