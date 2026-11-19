/**
 * A token operation scope (#2174) narrows a credential to a subset of its user's operations.
 *
 * It lives under two property names depending on the carrier: the claim `operations` on a JWT
 * payload, and `tokenOperations` on an in-memory user principal (validateToken lifts the claim onto
 * the user; verifyPerms reads it there). Every path that PRODUCES a credential or principal must
 * carry the scope forward or the result is unscoped — the five bypasses this feature had to close
 * were each a produce-a-credential path that forgot to. So the guard lives here, called at each such
 * site, rather than re-inlined as `Array.isArray(...)` in six places that could drift apart.
 *
 * A present scope is an array — INCLUDING an empty (deny-all) array, which must be preserved rather
 * than treated as "no scope". Anything else (absent/null) is skipped, so unscoped credentials behave
 * exactly as they did before this existed.
 */

export type OperationScope = string[];

/** True for a present scope: an array, including the empty deny-all array. */
export function hasOperationScope(scope: unknown): scope is OperationScope {
	return Array.isArray(scope);
}

/** Copies a present scope onto a JWT payload (claim name `operations`). Returns the payload. */
export function attachScopeToToken<T extends object>(payload: T, scope: unknown): T {
	if (hasOperationScope(scope)) (payload as any).operations = scope;
	return payload;
}

/** Copies a present scope onto a user principal (property `tokenOperations`). Returns the user. */
export function attachScopeToUser<T extends object>(user: T, scope: unknown): T {
	if (hasOperationScope(scope)) (user as any).tokenOperations = scope;
	return user;
}
