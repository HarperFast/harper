import { createHash } from 'node:crypto';
import type { User, UserRole } from './user.ts';
import type { ImpersonatePayload } from '../server/operationsServer.ts';
import { getUsersWithRolesCache } from './user.ts';
import { validateOperations } from '../utility/operationPermissions.ts';
import { addRoleValidation } from '../validation/role_validation.ts';
import { ClientError } from '../utility/errors/hdbError.ts';
import harperLogger from '../utility/logging/harper_logger.ts';
import { getRoleByName } from './role.ts';
import { attachScopeToUser } from './operationScope.ts';
import { attachWorkloadIdentityToUser } from './credentialProvenance.ts';

/**
 * Content-derived identity for synthetic (inline) roles. getRolePermissions memoizes translated
 * permissions by role name, so synthetic roles must never share a constant name: two inline roles
 * with different permissions would alias in that cache and leak permissions across principals.
 * Hashing the (already downgraded) permission content isolates distinct permission sets while
 * letting identical ones share a cache entry. The paired __updatedtime__ of 0 keeps the memo key
 * stable across requests; the content hash in the name is what invalidates on permission change.
 */
export function syntheticRoleName(prefix: string, permission: object): string {
	return `${prefix}_${createHash('sha256').update(JSON.stringify(permission)).digest('hex').slice(0, 24)}`;
}

/**
 * Applies impersonation to a request. The authenticated user must be a super_user.
 * Returns a new User object with downgraded permissions based on the impersonate payload.
 *
 * Mode A (inline role): `impersonate.role` is present — builds a synthetic user with the given permissions.
 * Mode B (existing user): `impersonate.username` is present (no role/role_name) — looks up the user from cache.
 * Mode C (existing role): `impersonate.role_name` is present (no role) — looks up the role by name and builds a synthetic user.
 */
export async function applyImpersonation(authenticatedUser: User, payload: ImpersonatePayload): Promise<User> {
	// Gate: only super_user can impersonate
	if (!authenticatedUser?.role?.permission?.super_user) {
		throw new ClientError('Only super_user can use impersonation', 403);
	}

	validatePayload(payload);

	let impersonatedUser: User;

	if (payload.role) {
		// Mode A: inline permissions
		impersonatedUser = buildInlineUser(authenticatedUser, payload);
	} else if (payload.role_name) {
		// Mode C: look up existing role by name
		impersonatedUser = await lookupRole(authenticatedUser, payload);
	} else {
		// Mode B: look up existing user by username
		impersonatedUser = await lookupUser(payload.username!);
	}

	// Enforce downgrade: never allow escalation
	enforceDowngrade(impersonatedUser);

	// A token's operation scope (#2174) constrains the credential regardless of which principal it
	// acts as, so it survives impersonation. enforceDowngrade only bounds the impersonated role's
	// permissions; without carrying the scope, a scoped super_user token would shed it by impersonating.
	attachScopeToUser(impersonatedUser, (authenticatedUser as any).tokenOperations);
	// Same reasoning for provenance (#2171), and the omission would be worse: impersonation returns a
	// NEW principal, so dropping the marker here would let a workload token impersonate — even down to
	// a lesser role — and then mint a 30-day credential that createTokens would no longer refuse.
	attachWorkloadIdentityToUser(impersonatedUser, (authenticatedUser as any).fromWorkloadIdentity);

	// Re-key the synthetic role by its effective (post-downgrade) content so it can never alias
	// another impersonation's permissions or poison a persisted role's memoized translation —
	// getRolePermissions caches by role name (see syntheticRoleName).
	if (impersonatedUser.role) {
		impersonatedUser.role = {
			...impersonatedUser.role,
			role: syntheticRoleName('_impersonated', impersonatedUser.role.permission),
			__updatedtime__: 0,
		};
	}

	// Tag for audit trail
	impersonatedUser._impersonated = true;
	impersonatedUser._impersonatedBy = authenticatedUser.username;

	harperLogger.info(
		`Impersonation applied: "${authenticatedUser.username}" impersonating as "${impersonatedUser.username}"`
	);

	return impersonatedUser;
}

/**
 * Builds the synthetic user embedded in a scoped authentication token
 * (create_authentication_tokens with an inline `role` object). Same gate and downgrade rules as
 * impersonation Mode A. `trusted` marks internal dispatch (operation authorization bypassed),
 * where no authenticated minter exists.
 */
export function buildScopedTokenUser(minter: User | undefined, payload: ImpersonatePayload, trusted = false): User {
	if (!trusted && !minter?.role?.permission?.super_user) {
		throw new ClientError('Only super_user can create a token with an inline role', 403);
	}
	validatePayload(payload, 'scoped token role');
	if (!payload.role) {
		throw new ClientError("A scoped token requires 'role' with 'permission'");
	}
	const username = payload.username || minter?.username;
	if (!username || typeof username !== 'string') {
		throw new ClientError("A scoped token requires a 'username'");
	}
	// Downgrade first so validation and the content hash see the effective permission set
	// (same silent downgrade as impersonation).
	const permission = {
		...payload.role.permission,
		super_user: false,
		cluster_user: false,
	} as UserRole['permission'];
	// Full persisted-role validation: a malformed shape must fail at mint (400), not at every use.
	const deepValidation = addRoleValidation({ role: 'scoped_token', permission });
	if (deepValidation) throw deepValidation;
	const roleName = syntheticRoleName('_scoped_token', permission);
	return {
		username,
		active: true,
		role: {
			permission,
			role: roleName,
			id: roleName,
			__updatedtime__: 0,
			__createdtime__: 0,
		},
	};
}

function validatePayload(payload: ImpersonatePayload, context = 'impersonate payload'): void {
	if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
		throw new ClientError(`Invalid ${context}: must be an object`);
	}

	const hasRole = payload.role !== undefined;
	const hasUsername = typeof payload.username === 'string' && payload.username.length > 0;
	const hasRoleName = typeof payload.role_name === 'string' && payload.role_name.length > 0;

	if (!hasRole && !hasUsername && !hasRoleName) {
		throw new ClientError(`Invalid ${context}: must include 'username', 'role_name', or 'role' with 'permission'`);
	}

	if (hasRole) {
		if (typeof payload.role !== 'object' || payload.role === null) {
			throw new ClientError(`Invalid ${context}: 'role' must be an object`);
		}
		if (typeof payload.role.permission !== 'object' || payload.role.permission === null) {
			throw new ClientError(`Invalid ${context}: 'role.permission' must be an object`);
		}
		validateOperationsField(payload.role.permission, context);
	}
}

function validateOperationsField(permission: Record<string, unknown>, context = 'impersonate payload'): void {
	const operations = permission.operations;
	if (operations === undefined) return;

	if (!Array.isArray(operations)) {
		throw new ClientError(`Invalid ${context}: 'operations' must be an array`);
	}

	const invalidOp = validateOperations(operations);
	if (invalidOp !== null) {
		throw new ClientError(`Invalid ${context}: unknown operation '${invalidOp}'`);
	}
}

function buildInlineUser(authenticatedUser: User, payload: ImpersonatePayload): User {
	const username = payload.username || authenticatedUser.username;

	return {
		username,
		active: true,
		role: {
			permission: { ...payload.role!.permission },
			role: `_impersonated`,
			id: `_impersonated_${username}`,
			__updatedtime__: Date.now(),
			__createdtime__: Date.now(),
		},
	};
}

async function lookupUser(username: string): Promise<User> {
	const cache = await getUsersWithRolesCache();
	const cachedUser = cache.get(username);

	if (!cachedUser) {
		throw new ClientError(`Impersonation target user '${username}' not found`, 404);
	}

	if (cachedUser.active === false) {
		throw new ClientError(`Impersonation target user '${username}' is inactive`, 403);
	}

	// Shallow-clone to avoid mutating cache (same pattern as auth.ts)
	const cloned: User = {
		...cachedUser,
		role: cachedUser.role
			? {
					...cachedUser.role,
					permission: { ...cachedUser.role.permission },
					id: `_impersonated_${username}`,
				}
			: cachedUser.role,
	};
	return cloned;
}

async function lookupRole(authenticatedUser: User, payload: ImpersonatePayload): Promise<User> {
	const role = await getRoleByName(payload.role_name);

	if (!role) {
		throw new ClientError(`Impersonation target role '${payload.role_name}' not found`, 404);
	}

	const username = payload.username || authenticatedUser.username;

	return {
		username,
		active: true,
		role: {
			permission: { ...role.permission },
			role: role.role,
			id: `_impersonated_${username}`,
			__updatedtime__: Date.now(),
			__createdtime__: Date.now(),
		},
	};
}

function enforceDowngrade(user: User): void {
	if (!user.role?.permission) return;
	user.role.permission.super_user = false;
	user.role.permission.cluster_user = false;
}
