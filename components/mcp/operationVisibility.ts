/**
 * Role-level operation visibility for MCP discovery, shared by `tools/list` (toolRegistry.ts) and
 * the `harper://operations` catalog (resources.ts). The invariant it exists to hold, and the three
 * ways it has been broken, are in components/mcp/DESIGN.md.
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
 * Operations whose handler registers a different canonical `api_name`, which is what
 * `verifyOperationsAllowlist` tests. Hand-maintained: the `OPERATION_FUNCTION_MAP` that defines
 * them pulls in the server and cannot be imported here, so a newly aliased pair has to be added.
 */
const OPERATION_API_NAME_ALIASES = new Map([
	['create_schema', 'create_database'],
	['drop_schema', 'drop_database'],
	['describe_database', 'describe_schema'],
	['search_by_id', 'search_by_hash'],
]);

const STRUCTURE_TABLE_OPERATIONS = new Set(['create_table', 'drop_table', 'create_attribute', 'drop_attribute']);

/** Denied at dispatch for an array grant: `STRUCTURE_USER_OPS` holds only the table ops. */
const STRUCTURE_DATABASE_OPERATIONS = new Set(['create_schema', 'create_database', 'drop_schema', 'drop_database']);

/**
 * Keyed on the `operations` array, not the permission: replacing the array must miss, and an
 * inline-asserted role (impersonation, scoped token) may be frozen, where writing the expansion
 * onto the permission would throw under SES.
 */
const inlineExpansions = new WeakMap<readonly string[], Set<string>>();

/** `null` when the role declares no allowlist. A present but malformed value fails closed. */
function allowlistAllows(perm: RolePermission, operation: string): boolean | null {
	const list = perm.operations;
	if (list == null) return null;
	if (!Array.isArray(list)) return false;
	const cached = (perm as { _expandedOperations?: unknown })._expandedOperations;
	let expanded = cached instanceof Set ? (cached as Set<string>) : inlineExpansions.get(list);
	if (!expanded) {
		expanded = expandOperationsPerms(list);
		inlineExpansions.set(list, expanded);
	}
	return expanded.has(OPERATION_API_NAME_ALIASES.get(operation) ?? operation);
}

/**
 * Role-level privilege to invoke `operation`. Per-target schema/table predicates still run at call
 * time in `verifyPerms`; the `operations` allowlist cannot be deferred to it, because it runs ahead
 * of every privilege early-return at dispatch and so bounds super_user and structure_user alike.
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
