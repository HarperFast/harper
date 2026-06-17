/**
 * MCP tool registry — framework for `tools/list` and `tools/call` per MCP
 * §server/tools. No real tools register here yet — the operations profile
 * walks `OPERATION_FUNCTION_MAP`, and the application profile walks the
 * `Resources` registry. Both call `addTool(def)` to publish.
 *
 * Filtering follows a two-step pattern:
 *   1. Class-level verb introspection (which tools are *publishable*)
 *      reuses the prototype-comparison helper from `resources/openApi.ts:149-153`.
 *   2. User-level RBAC walk (which publishable tools are *visible*) reuses
 *      the direct `user.role.permission[db].tables[table]` walk from
 *      `dataLayer/schemaDescribe.ts:29-49`. Resource.allow* methods are
 *      *not* used — they're per-record instance methods.
 *
 * Security model — important:
 *   - `visibleTo` controls **listing** (the LLM only sees what it's likely
 *     allowed to use). It is **not** invoked at `tools/call` time and is
 *     explicitly NOT a security boundary.
 *   - **Enforcement runs in the tool handler at call time**, via Harper's
 *     existing `transactional()` + per-record `allow{Read,Create,Update,
 *     Delete}` predicates. The framework intentionally passes a
 *     known-but-filtered-out tool through to its handler so an LLM that
 *     hallucinates a name gets a clean `isError` result from the runtime
 *     predicate. See the `tools/call` pass-through test in
 *     `transport.test.js`.
 */
import { encodeCursor } from './pagination.ts';
import type { McpProfile } from './transport.ts';

export interface ToolAnnotations {
	title?: string;
	readOnlyHint?: boolean;
	destructiveHint?: boolean;
	idempotentHint?: boolean;
	openWorldHint?: boolean;
}

export interface ToolContent {
	type: 'text' | 'image' | 'audio' | 'resource';
	text?: string;
	data?: string;
	mimeType?: string;
}

export interface ToolResult {
	content: ToolContent[];
	isError?: boolean;
	structuredContent?: unknown;
}

/** Public shape sent to clients on `tools/list`. */
export interface ToolDescriptor {
	name: string;
	description: string;
	inputSchema: object;
	outputSchema?: object;
	annotations?: ToolAnnotations;
}

/** Authenticated user object as Harper builds it (subset we touch). */
export interface AuthedUser {
	username?: string;
	role?: {
		role?: string;
		permission?: {
			super_user?: boolean;
			structure_user?: boolean;
			operations?: string[];
			[database: string]:
				| boolean
				| string[]
				| undefined
				| {
						describe?: boolean;
						tables?: {
							[table: string]:
								| undefined
								| {
										read?: boolean;
										insert?: boolean;
										update?: boolean;
										delete?: boolean;
										describe?: boolean;
										attribute_permissions?: unknown;
								  };
						};
				  };
		};
	};
}

export interface ToolCallContext {
	user: AuthedUser;
	profile: McpProfile;
	sessionId: string;
}

/**
 * Internal tool definition. `handler` and `visibleTo` are not sent to the
 * client; only the public `ToolDescriptor` fields are.
 */
export interface ToolDef extends ToolDescriptor {
	profile: McpProfile;
	visibleTo: (user: AuthedUser) => boolean;
	handler: (args: unknown, context: ToolCallContext) => Promise<ToolResult> | ToolResult;
}

const registry = new Map<string, ToolDef>();

/** Per-session pagination cache. Invalidated when a fresh `tools/list` (no cursor) call recomputes. */
const sessionListCache = new Map<string, { tools: ToolDescriptor[] }>();

export function addTool(def: ToolDef): void {
	if (!def?.name) throw new Error('addTool: name is required');
	registry.set(def.name, def);
	// New tool → drop pagination caches; next list call rebuilds.
	sessionListCache.clear();
}

export function removeTool(name: string): boolean {
	const existed = registry.delete(name);
	if (existed) sessionListCache.clear();
	return existed;
}

export function getTool(name: string): ToolDef | undefined {
	return registry.get(name);
}

/**
 * Snapshot every tool currently registered for a profile. Used to capture the
 * live tool set before an atomic rebuild so a mid-rebuild failure can restore
 * it (rather than leaving `tools/list` empty); see `registerApplicationTools`.
 */
export function snapshotProfileTools(profile: McpProfile): ToolDef[] {
	const out: ToolDef[] = [];
	for (const def of registry.values()) {
		if (def.profile === profile) out.push(def);
	}
	return out;
}

/**
 * Remove every tool registered for a profile. Used to rebuild the
 * application-profile tool set when schemas change (a table may have been
 * added/removed after the initial registration); see `refreshApplicationTools`.
 * Drops the pagination caches so the next `tools/list` recomputes.
 */
export function clearProfileTools(profile: McpProfile): void {
	let removed = 0;
	for (const [name, def] of registry) {
		if (def.profile === profile) {
			registry.delete(name);
			removed++;
		}
	}
	if (removed > 0) sessionListCache.clear();
}

/**
 * Drop the pagination cache entry for a session. Called by
 * `session.deleteSession` so the cache doesn't outlive the session that
 * created it. Without this, every session that ever paged tools/list
 * leaves an orphan entry until the process restarts.
 */
export function clearSessionCache(sessionId: string): void {
	sessionListCache.delete(sessionId);
}

/** Test seam: drop all registrations. */
export function _resetRegistryForTest(): void {
	registry.clear();
	sessionListCache.clear();
}

export interface ListToolsArgs {
	user: AuthedUser;
	profile: McpProfile;
	sessionId: string;
	/**
	 * Decoded pagination offset, or `undefined` for a fresh (first-page) call.
	 * The transport decodes the opaque cursor and rejects invalid cursors with
	 * `-32602` before calling us (see `decodeCursor` in pagination.ts).
	 */
	offset?: number;
	limit: number;
}

export interface ListToolsResult {
	tools: ToolDescriptor[];
	nextCursor?: string;
}

/**
 * Filter the registry to tools the user can see on this profile, then page.
 *
 * Cursor encoding: base64 of `{offset:N}`. Opaque to clients per MCP
 * §server/utilities/pagination. A fresh call (no cursor) recomputes and
 * caches the filtered list; subsequent paged calls reuse the cache so
 * pagination is stable even if the registry mutates between pages.
 */
export function listTools(args: ListToolsArgs): ListToolsResult {
	const { user, profile, sessionId, offset: cursorOffset, limit } = args;
	if (limit < 1) throw new Error('listTools: limit must be >= 1');

	let cached = sessionListCache.get(sessionId);
	let offset = 0;
	if (cursorOffset !== undefined) {
		offset = cursorOffset;
		if (!cached) {
			// Cache evicted (likely registry change). Treat as a fresh call from
			// the cursor's offset — best effort. The client may see the next
			// page from a slightly different list, which is acceptable per
			// MCP's eventual-consistency stance on listChanged.
			cached = { tools: computeFilteredList(user, profile) };
			sessionListCache.set(sessionId, cached);
		}
	} else {
		cached = { tools: computeFilteredList(user, profile) };
		sessionListCache.set(sessionId, cached);
	}

	const slice = cached.tools.slice(offset, offset + limit);
	const next = offset + slice.length;
	return {
		tools: slice,
		nextCursor: next < cached.tools.length ? encodeCursor(next) : undefined,
	};
}

function computeFilteredList(user: AuthedUser, profile: McpProfile): ToolDescriptor[] {
	const out: ToolDescriptor[] = [];
	for (const def of registry.values()) {
		if (def.profile !== profile) continue;
		if (!def.visibleTo(user)) continue;
		out.push({
			name: def.name,
			description: def.description,
			inputSchema: def.inputSchema,
			...(def.outputSchema ? { outputSchema: def.outputSchema } : {}),
			...(def.annotations ? { annotations: def.annotations } : {}),
		});
	}
	// Sort for deterministic pagination (insertion order would also work, but
	// the registry can mutate between calls and we want stable cursor offsets).
	out.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
	return out;
}

// ─── RBAC + introspection helpers ──────────────────────────────────────────

/** True if any role-level flag grants super-user privilege. */
export function isSuperUser(user: AuthedUser | undefined): boolean {
	return user?.role?.permission?.super_user === true;
}

/**
 * Class-level verb introspection. Mirrors `resources/openApi.ts:149-153` so
 * a class is considered to "have" a verb only if its prototype overrides the
 * base Resource implementation. Note that `post`'s default in Harper's
 * `Resource` is a no-op that ResourceClass implementations frequently
 * override implicitly via `update` — the openApi pattern accounts for that.
 */
export function hasClassLevelVerbs(
	prototype: any,
	resourcePrototype: any
): { get: boolean; post: boolean; put: boolean; patch: boolean; delete: boolean } {
	return {
		get: typeof prototype.get === 'function' && prototype.get !== resourcePrototype.get,
		post:
			(typeof prototype.post === 'function' && prototype.post !== resourcePrototype.post) ||
			typeof prototype.update === 'function',
		put: typeof prototype.put === 'function' && prototype.put !== resourcePrototype.put,
		patch: typeof prototype.patch === 'function' && prototype.patch !== resourcePrototype.patch,
		delete: typeof prototype.delete === 'function' && prototype.delete !== resourcePrototype.delete,
	};
}

/**
 * Role-level operations check for the operations profile. Returns true if
 * the user has the role-level privilege required to invoke `operation`,
 * regardless of any per-call schema/table predicate (those run at tool-call
 * time).
 *
 * The implementation here is intentionally conservative — only flags that
 * grant operations globally short-circuit. Per-operation per-target checks
 * are evaluated at call time by Harper's existing `verifyPerms`.
 */
export function canRoleInvokeOperation(user: AuthedUser, operation: string): boolean {
	if (isSuperUser(user)) return true;
	const perm = user?.role?.permission;
	if (!perm) return false;
	if (perm.structure_user && SCHEMA_STRUCTURE_OPERATIONS.has(operation)) return true;
	if (Array.isArray(perm.operations) && perm.operations.includes(operation)) return true;
	return false;
}

/**
 * Operations that `structure_user` is permitted to invoke. Pre-seeded with
 * the canonical structure ops so the helper is functional and tests have
 * something to assert against. Adding entries here is the right shape;
 * removing them is not (would silently lock users out).
 */
const SCHEMA_STRUCTURE_OPERATIONS = new Set([
	'create_schema',
	'create_database',
	'drop_schema',
	'drop_database',
	'create_table',
	'drop_table',
	'create_attribute',
	'drop_attribute',
]);
