/**
 * Role-level operation visibility for MCP discovery, shared by the two surfaces that advertise
 * operations: `tools/list` (toolRegistry.ts) and the `harper://operations` catalog (resources.ts).
 *
 * Discovery must answer the same question dispatch answers, in the same order. Where it does not,
 * a tool is advertised and then fails closed on call, which is worse than not filtering at all.
 */
import { expandOperationsPerms } from '../../utility/operationPermissions.ts';

/** The slice of Harper's authenticated user both MCP profiles' `AuthedUser` satisfies. */
export interface RoleScopedUser {
	role?: {
		permission?: {
			super_user?: boolean;
			structure_user?: boolean | string[];
			operations?: string[];
		};
	};
}

type RolePermission = NonNullable<NonNullable<RoleScopedUser['role']>['permission']>;

/**
 * Operations published under a name that is not their handler's canonical `api_name`.
 * `verifyOperationsAllowlist` resolves the handler's `api_name` before testing membership, so
 * discovery resolves the same alias — otherwise `operations: ['create_database']` hides
 * `create_schema`, which dispatch allows, and `operations: ['create_schema']` advertises it,
 * which dispatch denies.
 *
 * These are the `OPERATION_FUNCTION_MAP` entries where two operation names share one handler
 * (`server/serverHelpers/serverUtilities.ts`); that map pulls in the server, so it cannot be
 * imported here. Each pair is pinned behaviorally through the real stack in
 * `integrationTests/mcp/operations-role-listing.test.ts`. A newly aliased pair has to be added
 * here by hand.
 */
const OPERATION_API_NAME_ALIASES = new Map([
	['create_schema', 'create_database'],
	['drop_schema', 'drop_database'],
	['describe_database', 'describe_schema'],
	['search_by_id', 'search_by_hash'],
]);

/** Structure ops a `structure_user` array grant can reach; the array names which databases. */
const STRUCTURE_TABLE_OPERATIONS = new Set(['create_table', 'drop_table', 'create_attribute', 'drop_attribute']);

/**
 * Structure ops that need an unrestricted `structure_user === true`. `STRUCTURE_USER_OPS` in
 * `operation_authorization.ts` holds only the table/attribute ops, so an array grant falls through
 * to `requires_su` and is denied for these four.
 */
const STRUCTURE_DATABASE_OPERATIONS = new Set(['create_schema', 'create_database', 'drop_schema', 'drop_database']);

/**
 * Role `operations` allowlist membership, mirroring gate 1 of `verifyPerms`. `null` when the role
 * declares no allowlist. A present but malformed value fails closed.
 */
function allowlistAllows(perm: RolePermission, operation: string): boolean | null {
	const list = perm.operations;
	if (list == null) return null;
	if (!Array.isArray(list)) return false;
	// Normally built at role cache-load time. Inline-asserted roles (impersonation, scoped tokens)
	// arrive without it, and a listing calls this once per operation, so memoize onto the same
	// field the cache-load path uses rather than re-expanding ~150 times per request.
	const holder = perm as { _expandedOperations?: unknown };
	let expanded = holder._expandedOperations;
	if (!(expanded instanceof Set)) {
		expanded = expandOperationsPerms(list);
		holder._expandedOperations = expanded;
	}
	return (expanded as Set<string>).has(OPERATION_API_NAME_ALIASES.get(operation) ?? operation);
}

/**
 * True when the role carries the role-level privilege to invoke `operation`. Per-target
 * schema/table predicates still run at call time in `verifyPerms`; what cannot be deferred is the
 * `operations` allowlist, which runs ahead of every privilege early-return at dispatch
 * (harper#2176) and therefore bounds super_user and structure_user alike.
 */
export function canRoleInvokeOperation(user: RoleScopedUser | undefined, operation: string): boolean {
	const perm = user?.role?.permission;
	if (!perm) return false;
	const allowlisted = allowlistAllows(perm, operation);
	if (allowlisted === false) return false;
	if (perm.super_user === true) return true;
	const structureUser = perm.structure_user;
	if (structureUser === true) {
		if (STRUCTURE_TABLE_OPERATIONS.has(operation) || STRUCTURE_DATABASE_OPERATIONS.has(operation)) return true;
	} else if (Array.isArray(structureUser) && structureUser.length > 0) {
		// An empty array names no database, so `structureUser.indexOf(schema)` never matches.
		if (STRUCTURE_TABLE_OPERATIONS.has(operation)) return true;
	}
	return allowlisted === true;
}
