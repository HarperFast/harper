/**
 * MCP server-push notification dispatcher (#619). Subscribes to Harper's
 * existing role-cache-invalidation + schema-reload event channels and
 * emits per-session `notifications/tools/list_changed` /
 * `notifications/resources/list_changed` frames over the registered
 * SSE streams.
 *
 * Per-session computation only — never broadcast. For each event, we
 * walk the per-worker session registry, recompute that session's
 * tools/list (or resources/list) under its bound user, diff against the
 * snapshot from the prior emission, and push a notification iff the
 * visible set actually changed. Sessions whose visible surface is
 * unchanged see nothing.
 */
import harperLogger from '../../utility/logging/harper_logger.ts';
import { listResources } from './resources.ts';
import { type RegisteredSession, forEachSessionByProfile, getRegisteredSession } from './sessionRegistry.ts';
import { listTools } from './toolRegistry.ts';
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
 * Fan out a user/role change: for each session on either profile,
 * recompute the tools list and notify if changed. Resources may also
 * change visibility (table-perm-gated schema URIs), so we re-check
 * those too.
 */
function onUserChange(): void {
	forEachSessionByProfile('operations', (r) => {
		maybeNotifyToolsChanged(r);
		maybeNotifyResourcesChanged(r);
	});
	forEachSessionByProfile('application', (r) => {
		maybeNotifyToolsChanged(r);
		maybeNotifyResourcesChanged(r);
	});
}

/**
 * Schema changes touch both surfaces — application-profile tools are
 * generated from the Resources registry, and operations-profile
 * resources include the OPERATION list (unchanged) plus harper://schema
 * URIs (changed). Application sessions need the bigger refresh.
 */
function onSchemaChange(): void {
	forEachSessionByProfile('application', (r) => {
		maybeNotifyToolsChanged(r);
		maybeNotifyResourcesChanged(r);
	});
	// Operations sessions only need resources/list refresh — there are no
	// schema-derived operations tools, but `harper://schema/...` URIs may
	// shift if a new table appears under a database the user can describe.
	forEachSessionByProfile('operations', (r) => {
		maybeNotifyResourcesChanged(r);
	});
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
		onUserChangeBound = onUserChange;
		handlers.userHandler.addListener(onUserChangeBound);
		installed++;
	}
	if (handlers.schemaHandler?.addListener) {
		onSchemaChangeBound = onSchemaChange;
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
