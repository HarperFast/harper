/**
 * Per-worker manager for MCP `resources/subscribe` subscriptions (#1349 §3.6).
 *
 * Live subscription objects can't be persisted, so they live here keyed by
 * session + URI; the durable list of subscribed URIs lives on the `mcp_session`
 * record (see `session.ts`) so they can be restored on an SSE reconnect. Each
 * change pushes a `notifications/resources/updated` frame onto the session's
 * GET-stream queue. Row-backed URIs only — `subscribeToResource` returns null
 * for anything that isn't a subscribable application resource.
 *
 * Per-worker, like the session registry: a subscription is bound to the worker
 * holding the session's SSE stream; the audit-log broadcast delivers changes
 * locally on that worker.
 */
import harperLogger from '../../utility/logging/harper_logger.ts';
import { subscribeToResource, type ResourceSubscription } from './resources.ts';
import { getRegisteredSession, pushSessionFrame } from './sessionRegistry.ts';
import type { AuthedUser } from './toolRegistry.ts';

/** sessionId → (uri → live subscription). */
const live = new Map<string, Map<string, ResourceSubscription>>();

/**
 * Start (or replace) a subscription for `uri` on `sessionId`. Pushes
 * `notifications/resources/updated` to the session's queue on each change.
 * Returns false if the URI isn't subscribable (caller maps that to `-32602`).
 */
export async function addResourceSubscription(sessionId: string, uri: string, user: AuthedUser): Promise<boolean> {
	const subscription = await subscribeToResource(uri, user, () => {
		// Re-resolve the record each push: the SSE stream may have reconnected
		// (new queue) since the subscription started.
		const record = getRegisteredSession(sessionId);
		if (record) {
			pushSessionFrame(record, {
				event: 'message',
				data: { jsonrpc: '2.0', method: 'notifications/resources/updated', params: { uri } },
			});
		}
	});
	if (!subscription) return false;
	let bySession = live.get(sessionId);
	if (!bySession) live.set(sessionId, (bySession = new Map()));
	// Replace any existing subscription for the same URI (idempotent re-subscribe).
	bySession.get(uri)?.stop();
	bySession.set(uri, subscription);
	return true;
}

/** Stop and drop a single subscription. Returns false if it wasn't subscribed. */
export function removeResourceSubscription(sessionId: string, uri: string): boolean {
	const bySession = live.get(sessionId);
	const subscription = bySession?.get(uri);
	if (!subscription) return false;
	subscription.stop();
	bySession!.delete(uri);
	if (bySession!.size === 0) live.delete(sessionId);
	return true;
}

/** Stop every live subscription for a session (on SSE-stream close / DELETE / prune). */
export function dropSessionSubscriptions(sessionId: string): void {
	const bySession = live.get(sessionId);
	if (!bySession) return;
	for (const subscription of bySession.values()) {
		try {
			subscription.stop();
		} catch (err) {
			harperLogger.trace(`MCP subscription drop for ${sessionId}: ${(err as Error).message}`);
		}
	}
	live.delete(sessionId);
}

/**
 * Re-establish subscriptions on SSE reconnect from the durable URI list. Each is
 * best-effort: a URI that's no longer subscribable (resource removed) is skipped.
 * Returns the URIs that were successfully restored (the caller prunes the rest
 * from the durable record).
 */
export async function restoreResourceSubscriptions(
	sessionId: string,
	uris: ReadonlyArray<string>,
	user: AuthedUser
): Promise<string[]> {
	const restored: string[] = [];
	for (const uri of uris) {
		try {
			if (await addResourceSubscription(sessionId, uri, user)) restored.push(uri);
		} catch (err) {
			harperLogger.trace(`MCP subscription restore ${uri}: ${(err as Error).message}`);
		}
	}
	return restored;
}

/** Test seam — count of live subscriptions for a session. */
export function _liveSubscriptionCount(sessionId: string): number {
	return live.get(sessionId)?.size ?? 0;
}

/** Test seam — drop all live subscriptions. */
export function _resetSubscriptionsForTest(): void {
	for (const bySession of live.values()) {
		for (const subscription of bySession.values()) subscription.stop();
	}
	live.clear();
}
