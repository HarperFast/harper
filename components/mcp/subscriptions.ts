/**
 * Live MCP resource iterators for the worker holding the GET-SSE stream.
 *
 * Live subscription objects can't be persisted, so they live here keyed by
 * session + URI; the durable list of subscribed URIs lives on the `mcp_session`
 * record and is reconciled by `subscriptionState.ts` on changes and reconnect. Each
 * change pushes a `notifications/resources/updated` frame onto the session's
 * GET-stream queue. Resource eligibility is decided by `subscribeToResource`.
 *
 * Per-worker, like the session registry: a subscription is bound to the worker
 * holding the session's SSE stream; the audit-log broadcast delivers changes
 * locally on that worker.
 */
import { AccessViolation } from '../../utility/errors/hdbError.ts';
import harperLogger from '../../utility/logging/harper_logger.ts';
import { subscribeToResource, type ResourceSubscription } from './resources.ts';
import { getRegisteredSession, pushSessionFrame } from './sessionRegistry.ts';
import type { AuthedUser } from './toolRegistry.ts';

/** sessionId → (uri → live subscription). */
const live = new Map<string, Map<string, ResourceSubscription>>();

/**
 * Start (or replace) a subscription for `uri` on `sessionId`. Pushes
 * `notifications/resources/updated` to the session's queue on each change.
 * Returns false if the URI isn't subscribable or its GET closes during installation.
 */
export async function addResourceSubscription(
	sessionId: string,
	uri: string,
	user: AuthedUser,
	onStop?: () => void
): Promise<boolean> {
	const owner = getRegisteredSession(sessionId);
	if (!owner) return false;
	const subscription = await subscribeToResource(uri, user, owner.profile);
	if (!subscription) return false;
	if (getRegisteredSession(sessionId) !== owner || subscription.stopped) {
		subscription.stop();
		if (subscription.revoked) throw new AccessViolation(user);
		return false;
	}
	const frame = {
		event: 'message' as const,
		data: { jsonrpc: '2.0', method: 'notifications/resources/updated', params: { uri } },
	};
	subscription.start(() => {
		if (Date.now() >= Math.min(user.authExpiresAt ?? Infinity, owner.user.authExpiresAt ?? Infinity) * 1000) {
			owner.queue.close();
			return;
		}
		const record = getRegisteredSession(sessionId);
		if (record === owner) {
			pushSessionFrame(record, frame);
		}
	});
	await Promise.resolve();
	if (getRegisteredSession(sessionId) !== owner || subscription.stopped) {
		subscription.stop();
		if (subscription.revoked) throw new AccessViolation(user);
		return false;
	}
	let bySession = live.get(sessionId);
	if (!bySession) live.set(sessionId, (bySession = new Map()));
	// Publish the replacement before stopping its predecessor, whose onStop would otherwise empty the map.
	const previous = bySession.get(uri);
	bySession.set(uri, subscription);
	previous?.stop();
	subscription.onStop(() => {
		const entries = live.get(sessionId);
		if (entries?.get(uri) === subscription) {
			entries.delete(uri);
			if (entries.size === 0) live.delete(sessionId);
			if (!subscription.revoked) onStop?.();
		}
	});
	return true;
}

/** Stop and drop a single subscription. Returns false if it wasn't subscribed. */
export function removeResourceSubscription(sessionId: string, uri: string): boolean {
	const bySession = live.get(sessionId);
	const subscription = bySession?.get(uri);
	if (!subscription) return false;
	bySession!.delete(uri);
	if (bySession!.size === 0) live.delete(sessionId);
	subscription.stop();
	return true;
}

/** Stop every live subscription for a session (on SSE-stream close / DELETE / prune). */
export function dropSessionSubscriptions(sessionId: string): void {
	const bySession = live.get(sessionId);
	if (!bySession) return;
	live.delete(sessionId);
	for (const subscription of bySession.values()) {
		try {
			subscription.stop();
		} catch (err) {
			harperLogger.trace(`MCP subscription drop: ${(err as Error).message}`);
		}
	}
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
