import type { User } from './user.ts';
import type { ImpersonatePayload } from '../server/operationsServer.ts';
import { getUsersWithRolesCache } from './user.ts';
import { validateOperations } from '../utility/operationPermissions.ts';
import { ClientError } from '../utility/errors/hdbError.js';
import harperLogger from '../utility/logging/harper_logger.js';
import { getRoleByName } from './role.js';

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

	// Tag for audit trail
	impersonatedUser._impersonated = true;
	impersonatedUser._impersonatedBy = authenticatedUser.username;

	harperLogger.info(
		`Impersonation applied: "${authenticatedUser.username}" impersonating as "${impersonatedUser.username}"`
	);

	return impersonatedUser;
}

function validatePayload(payload: ImpersonatePayload): void {
	if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
		throw new ClientError('Invalid impersonate payload: must be an object');
	}

	const hasRole = payload.role !== undefined;
	const hasUsername = typeof payload.username === 'string' && payload.username.length > 0;
	const hasRoleName = typeof payload.role_name === 'string' && payload.role_name.length > 0;

	if (!hasRole && !hasUsername && !hasRoleName) {
		throw new ClientError(
			"Invalid impersonate payload: must include 'username', 'role_name', or 'role' with 'permission'"
		);
	}

	if (hasRole) {
		if (typeof payload.role !== 'object' || payload.role === null) {
			throw new ClientError("Invalid impersonate payload: 'role' must be an object");
		}
		if (typeof payload.role.permission !== 'object' || payload.role.permission === null) {
			throw new ClientError("Invalid impersonate payload: 'role.permission' must be an object");
		}
		validateOperationsField(payload.role.permission);
	}
}

function validateOperationsField(permission: Record<string, unknown>): void {
	const operations = permission.operations;
	if (operations === undefined) return;

	if (!Array.isArray(operations)) {
		throw new ClientError("Invalid impersonate payload: 'operations' must be an array");
	}

	const invalidOp = validateOperations(operations);
	if (invalidOp !== null) {
		throw new ClientError(`Invalid impersonate payload: unknown operation '${invalidOp}'`);
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
