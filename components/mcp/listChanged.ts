/**
 * MCP server-push notification dispatcher (#619). Subscribes to Harper's
 * existing role-cache-invalidation + schema-reload event channels and
 * emits per-session `notifications/tools/list_changed` /
 * `notifications/resources/list_changed` frames over the registered
 * SSE streams.
 *
 * Per-session computation only — never broadcast. For each event, we
 * walk the per-worker session registry, re-resolve the session's user
 * (so the diff sees the freshly-mutated permission set, not the snapshot
 * captured at GET-stream open), recompute that session's tools/list (or
 * resources/list) under the fresh user, diff against the snapshot from
 * the prior emission, and push a notification iff the visible set
 * actually changed. Sessions whose visible surface is unchanged see
 * nothing.
 */
import harperLogger from '../../utility/logging/harper_logger.ts';
import { listResources } from './resources.ts';
import { type RegisteredSession, forEachSessionByProfile, getRegisteredSession } from './sessionRegistry.ts';
import { listTools, type AuthedUser } from './toolRegistry.ts';
import { refreshApplicationTools } from './tools/application.ts';
import type { McpProfile } from './transport.ts';

const MAX_TOOLS_PAGE = 1000;
const MAX_RESOURCES_PAGE = 1000;

let initialized = false;
let onUserChangeBound: (() => void) | undefined;
let onSchemaChangeBound: (() => void) | undefined;

// Test seams: avoid importing the real ITC handler from unit tests.
let _itcHandlersOverride:
	| {
			userHandler?: { addListener?: (fn: () => void) => void };
			schemaHandler?: { addListener?: (fn: () => void) => void };
	  }
	| undefined;

export function _setItcHandlersForTest(
	h:
		| {
				userHandler?: { addListener?: (fn: () => void) => void };
				schemaHandler?: { addListener?: (fn: () => void) => void };
		  }
		| undefined
): void {
	_itcHandlersOverride = h;
}

export function _resetListChangedForTest(): void {
	initialized = false;
	onUserChangeBound = undefined;
	onSchemaChangeBound = undefined;
}

function loadItcHandlers():
	| {
			userHandler?: { addListener?: (fn: () => void) => void };
			schemaHandler?: { addListener?: (fn: () => void) => void };
	  }
	| undefined {
	if (_itcHandlersOverride) return _itcHandlersOverride;
	try {
		return require('../../server/itc/serverHandlers');
	} catch (err) {
		harperLogger.trace(`MCP listChanged: ITC handlers unavailable (${(err as Error).message})`);
		return undefined;
	}
}

// Test seam: lets unit tests stub the user re-resolution without pulling in
// security/user.ts (which initializes the system catalogs at module-load).
let _userResolverOverride: ((username: string) => Promise<AuthedUser | undefined>) | undefined;

export function _setUserResolverForTest(fn: ((username: string) => Promise<AuthedUser | undefined>) | undefined): void {
	_userResolverOverride = fn;
}

async function resolveUser(username: string | undefined): Promise<AuthedUser | undefined> {
	if (!username) return undefined;
	if (_userResolverOverride) return _userResolverOverride(username);
	try {
		const { findAndValidateUser } = require('../../security/user');
		const fresh = await findAndValidateUser(username, null, false);
		return fresh as AuthedUser;
	} catch (err) {
		harperLogger.trace(`MCP listChanged: user re-resolve failed for ${username}: ${(err as Error).message}`);
		return undefined;
	}
}

function toolsListNames(profile: McpProfile, session: RegisteredSession): Array<{ name: string }> {
	const { tools } = listTools({
		user: session.user,
		profile,
		sessionId: session.sessionId,
		limit: MAX_TOOLS_PAGE,
	});
	return tools.map((t) => ({ name: t.name }));
}

function resourcesListUris(profile: McpProfile, session: RegisteredSession): Array<{ uri: string }> {
	const result = listResources({ user: session.user, profile, limit: MAX_RESOURCES_PAGE });
	return result.resources.map((r) => ({ uri: r.uri }));
}

function sameSet(
	a: ReadonlyArray<{ name?: string; uri?: string }> | undefined,
	b: ReadonlyArray<{ name?: string; uri?: string }>
): boolean {
	if (!a) return false;
	if (a.length !== b.length) return false;
	const aKeys = new Set(a.map((x) => x.name ?? x.uri));
	for (const x of b) {
		if (!aKeys.has(x.name ?? x.uri)) return false;
	}
	return true;
}

/**
 * Re-emit `notifications/tools/list_changed` for one session iff its
 * visible tools list has changed since the last snapshot. Wrapped in
 * try/catch so a single failing session never breaks the loop.
 */
function maybeNotifyToolsChanged(record: RegisteredSession): void {
	try {
		const current = toolsListNames(record.profile, record);
		if (sameSet(record.lastTools, current)) return;
		record.lastTools = current;
		record.queue.send({
			event: 'message',
			data: { jsonrpc: '2.0', method: 'notifications/tools/list_changed' },
		});
	} catch (err) {
		harperLogger.trace(`MCP listChanged tools/* for session ${record.sessionId}: ${(err as Error).message}`);
	}
}

function maybeNotifyResourcesChanged(record: RegisteredSession): void {
	try {
		const current = resourcesListUris(record.profile, record);
		if (sameSet(record.lastResources, current)) return;
		record.lastResources = current;
		record.queue.send({
			event: 'message',
			data: { jsonrpc: '2.0', method: 'notifications/resources/list_changed' },
		});
	} catch (err) {
		harperLogger.trace(`MCP listChanged resources/* for session ${record.sessionId}: ${(err as Error).message}`);
	}
}

/**
 * Snapshot the current registry as a flat list so re-resolves can happen
 * sequentially without re-walking the live map (which a concurrent
 * registerSession could mutate mid-iteration).
 */
function snapshotSessions(profile: McpProfile): RegisteredSession[] {
	const out: RegisteredSession[] = [];
	forEachSessionByProfile(profile, (r) => out.push(r));
	return out;
}

async function refreshSessionUser(record: RegisteredSession): Promise<void> {
	const fresh = await resolveUser(record.user?.username);
	if (fresh) record.user = fresh;
}

/**
 * Fan out a user/role change: for each session on either profile,
 * re-resolve the user (so a role-perm mutation is visible to the diff —
 * the captured `record.user` at GET-stream open is otherwise frozen),
 * recompute the tools list and notify if changed. Resources may also
 * change visibility (table-perm-gated schema URIs), so we re-check
 * those too.
 */
async function onUserChange(): Promise<void> {
	for (const r of snapshotSessions('operations')) {
		await refreshSessionUser(r);
		maybeNotifyToolsChanged(r);
		maybeNotifyResourcesChanged(r);
	}
	for (const r of snapshotSessions('application')) {
		await refreshSessionUser(r);
		maybeNotifyToolsChanged(r);
		maybeNotifyResourcesChanged(r);
	}
}

/**
 * Schema changes touch both surfaces — application-profile tools are
 * generated from the Resources registry, and operations-profile
 * resources include the OPERATION list (unchanged) plus harper://schema
 * URIs (changed). Application sessions need the bigger refresh. We also
 * re-resolve the user here in case the schema change coincided with a
 * role mutation (Harper sometimes fires both channels on database-level
 * grants).
 */
async function onSchemaChange(): Promise<void> {
	// Rebuild the application tool registry first so `tools/list` reflects the
	// current schema graph (a table may have been added/removed after the MCP
	// component loaded). No-op when the application profile isn't enabled.
	// Guarded: a throw here (e.g. an unexpected Resource shape during schema
	// iteration) must not abort the session-notification loops below.
	try {
		refreshApplicationTools();
	} catch (err) {
		// warn, not trace: a tool-rebuild failure leaves `tools/list` stale, which
		// is invisible at default log levels if only traced. The notification loops
		// below still run.
		harperLogger.warn(`MCP listChanged refreshApplicationTools failed: ${(err as Error).message}`);
	}
	for (const r of snapshotSessions('application')) {
		await refreshSessionUser(r);
		maybeNotifyToolsChanged(r);
		maybeNotifyResourcesChanged(r);
	}
	// Operations sessions only need resources/list refresh — there are no
	// schema-derived operations tools, but `harper://schema/...` URIs may
	// shift if a new table appears under a database the user can describe.
	for (const r of snapshotSessions('operations')) {
		await refreshSessionUser(r);
		maybeNotifyResourcesChanged(r);
	}
}

/**
 * Idempotent: subscribe once at component boot. Repeated calls are
 * no-ops. Returns true if subscriptions were actually installed (false
 * if Harper's ITC handlers aren't available in this process).
 */
export function initListChanged(): boolean {
	if (initialized) return true;
	const handlers = loadItcHandlers();
	if (!handlers) return false;
	let installed = 0;
	if (handlers.userHandler?.addListener) {
		// Harper's ITC handler treats listeners as `() => void`. Our handler is
		// async (re-resolves users); fire-and-forget with a swallow so a rejection
		// can never escape the event emitter as an UnhandledPromiseRejection.
		onUserChangeBound = () => {
			onUserChange().catch((err) => harperLogger.trace(`MCP listChanged onUserChange: ${(err as Error).message}`));
		};
		handlers.userHandler.addListener(onUserChangeBound);
		installed++;
	}
	if (handlers.schemaHandler?.addListener) {
		onSchemaChangeBound = () => {
			onSchemaChange().catch((err) => harperLogger.trace(`MCP listChanged onSchemaChange: ${(err as Error).message}`));
		};
		handlers.schemaHandler.addListener(onSchemaChangeBound);
		installed++;
	}
	initialized = installed > 0;
	if (initialized) {
		harperLogger.info(`MCP listChanged: subscribed to ${installed} event channel(s)`);
	} else {
		harperLogger.warn(
			'MCP listChanged: ITC handlers do not expose addListener; list_changed notifications will not fire'
		);
	}
	return initialized;
}

/**
 * Compute and stash the initial tools/resources snapshot for a session
 * that just opened its GET stream. Without this seed, the first event
 * would always be a "changed" because `lastTools === undefined !==
 * current`. Call right after registerSession.
 */
export function seedSessionSnapshot(sessionId: string): void {
	const record = getRegisteredSession(sessionId);
	if (!record) return;
	try {
		record.lastTools = toolsListNames(record.profile, record);
	} catch (err) {
		harperLogger.trace(`MCP seed tools list for ${sessionId}: ${(err as Error).message}`);
	}
	try {
		record.lastResources = resourcesListUris(record.profile, record);
	} catch (err) {
		harperLogger.trace(`MCP seed resources list for ${sessionId}: ${(err as Error).message}`);
	}
}
