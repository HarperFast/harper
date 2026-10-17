/**
 * Per-worker manager for MCP `resources/subscribe` subscriptions (#1349 §3.6).
 *
 * Live subscription objects can't be persisted, so they live here keyed by
 * session + URI; the durable list of subscribed URIs lives on the `mcp_session`
 * record (see `session.ts`) so they can be restored on an SSE reconnect. Each
 * change pushes a `notifications/resources/updated` frame onto the session's
 * GET-stream queue. `subscribeToResource` decides what is subscribable:
 * row-backed application resources and custom `mcpResources` entries that
 * declare `subscribe` (#3250).
 *
 * Per-worker, like the session registry: a subscription is bound to the worker
 * holding the session's SSE stream; the audit-log broadcast delivers changes
 * locally on that worker.
 *
 * A subscription belongs to the GET stream (`RegisteredSession` record) that
 * was registered when it was requested. Setup awaits the resource (an author's
 * method may do I/O), so it is admitted only if that record is still the
 * registered one and no later unsubscribe, re-subscribe or drop for the same
 * URI happened meanwhile; otherwise it is released and never delivers.
 */
import harperLogger from '../../utility/logging/harper_logger.ts';
import { describeError, isRecognizedResourceUri, subscribeToResource, type ResourceSubscription } from './resources.ts';
import { getRegisteredSession, pushSessionFrame, type RegisteredSession } from './sessionRegistry.ts';
import type { AuthedUser } from './toolRegistry.ts';
import type { McpProfile } from './transport.ts';

export class SubscriptionCancelledError extends Error {}

/** sessionId → (uri → live subscription). */
const live = new Map<string, Map<string, ResourceSubscription>>();

interface PendingSetup {
	cancelled?: string;
}
/** sessionId → (uri → the setup currently allowed to install). */
const pending = new Map<string, Map<string, PendingSetup>>();

function deletePending(sessionId: string, uri: string, setup: PendingSetup): void {
	const bySession = pending.get(sessionId);
	if (bySession?.get(uri) !== setup) return;
	bySession.delete(uri);
	if (bySession.size === 0) pending.delete(sessionId);
}

function cancelPending(sessionId: string, uri: string, reason: string): void {
	const setup = pending.get(sessionId)?.get(uri);
	if (!setup) return;
	setup.cancelled = reason;
	deletePending(sessionId, uri, setup);
}

function reserve(sessionId: string, uri: string): PendingSetup {
	cancelPending(sessionId, uri, 'superseded by a newer resources/subscribe');
	const setup: PendingSetup = {};
	let bySession = pending.get(sessionId);
	if (!bySession) pending.set(sessionId, (bySession = new Map()));
	bySession.set(uri, setup);
	return setup;
}

/**
 * Start (or replace) a subscription for `uri` on `sessionId`, owned by `owner`
 * (the session's current GET-stream record unless the caller passes its own).
 * Pushes `notifications/resources/updated` to that record's queue on each
 * change. Returns false if the URI isn't subscribable (caller maps that to
 * `-32602`); throws `SubscriptionCancelledError` if the setup was overtaken, and
 * whatever the resource's subscribe threw.
 */
export async function addResourceSubscription(
	sessionId: string,
	uri: string,
	user: AuthedUser,
	profile: McpProfile = 'application',
	owner: RegisteredSession | undefined = getRegisteredSession(sessionId)
): Promise<boolean> {
	if (!owner) {
		throw new SubscriptionCancelledError(`resources/subscribe for ${uri} needs an open GET SSE stream`);
	}
	return admit(sessionId, uri, user, profile, owner, reserve(sessionId, uri));
}

async function admit(
	sessionId: string,
	uri: string,
	user: AuthedUser,
	profile: McpProfile,
	owner: RegisteredSession,
	setup: PendingSetup
): Promise<boolean> {
	let subscription: ResourceSubscription | null = null;
	try {
		if (!setup.cancelled) subscription = await subscribeToResource(uri, user, profile);
	} finally {
		deletePending(sessionId, uri, setup);
	}
	const cancelled =
		setup.cancelled ?? (getRegisteredSession(sessionId) !== owner ? 'the GET SSE stream closed' : undefined);
	if (cancelled) {
		subscription?.stop();
		throw new SubscriptionCancelledError(`resources/subscribe for ${uri} was cancelled: ${cancelled}`);
	}
	if (!subscription) return false;
	// Replace any existing subscription for the same URI (idempotent re-subscribe).
	live.get(sessionId)?.get(uri)?.stop();
	let bySession = live.get(sessionId);
	if (!bySession) live.set(sessionId, (bySession = new Map()));
	bySession.set(uri, subscription);
	const installed = subscription;
	installed.onStop(() => {
		const current = live.get(sessionId);
		if (current?.get(uri) !== installed) return;
		current.delete(uri);
		if (current.size === 0) live.delete(sessionId);
	});
	installed.start(() => {
		// Only while `owner` is current: a closed or superseded stream drops its
		// subscriptions, and a reconnect restores its own.
		if (getRegisteredSession(sessionId) === owner) {
			pushSessionFrame(owner, {
				event: 'message',
				data: { jsonrpc: '2.0', method: 'notifications/resources/updated', params: { uri } },
			});
		}
	});
	return true;
}

/** Stop and drop a single subscription. Returns false if it wasn't subscribed. */
export function removeResourceSubscription(sessionId: string, uri: string): boolean {
	cancelPending(sessionId, uri, 'unsubscribed');
	const subscription = live.get(sessionId)?.get(uri);
	if (!subscription) return false;
	subscription.stop();
	return true;
}

/** Stop every live subscription for a session (on SSE-stream close / DELETE / prune). */
export function dropSessionSubscriptions(sessionId: string): void {
	const setups = pending.get(sessionId);
	if (setups) {
		pending.delete(sessionId);
		for (const setup of setups.values()) setup.cancelled = 'the session dropped its subscriptions';
	}
	const bySession = live.get(sessionId);
	if (!bySession) return;
	live.delete(sessionId);
	for (const subscription of bySession.values()) {
		try {
			subscription.stop();
		} catch (err) {
			harperLogger.trace(`MCP subscription drop for ${sessionId}: ${describeError(err)}`);
		}
	}
}

/**
 * Re-establish subscriptions on SSE reconnect from the durable URI list, owned
 * by `owner` (the reconnecting GET's record). Every URI is reserved up front, so
 * an unsubscribe for one not reached yet cancels it. Stops once `owner` is no
 * longer the registered record. Returns the URIs to keep on the durable list:
 * all but those reported not subscribable. A URI whose subscribe threw stays, so
 * a transient failure is retried on the next reconnect; so does a custom URI no
 * entry matches yet (its component may still be loading on this worker), and
 * one a newer subscribe has taken over since it was reported.
 */
export async function restoreResourceSubscriptions(
	sessionId: string,
	uris: ReadonlyArray<string>,
	user: AuthedUser,
	profile: McpProfile = 'application',
	owner: RegisteredSession | undefined = getRegisteredSession(sessionId)
): Promise<string[]> {
	if (!owner) return [...uris];
	const setups = uris.map((uri) => reserve(sessionId, uri));
	const kept: string[] = [];
	for (let index = 0; index < uris.length; index++) {
		const uri = uris[index];
		if (getRegisteredSession(sessionId) !== owner) {
			for (let rest = index; rest < uris.length; rest++) deletePending(sessionId, uris[rest], setups[rest]);
			kept.push(...uris.slice(index));
			break;
		}
		try {
			if (await admit(sessionId, uri, user, profile, owner, setups[index])) kept.push(uri);
			else if (!isRecognizedResourceUri(uri, profile)) kept.push(uri);
		} catch (err) {
			kept.push(uri);
			if (!(err instanceof SubscriptionCancelledError)) {
				harperLogger.warn(`MCP subscription restore ${uri} failed, kept for the next reconnect: ${describeError(err)}`);
			}
		}
	}
	if (kept.length === uris.length) return kept;
	const keptSet = new Set(kept);
	return uris.filter(
		(uri) => keptSet.has(uri) || live.get(sessionId)?.has(uri) === true || pending.get(sessionId)?.has(uri) === true
	);
}

/** Test seam — count of live subscriptions for a session. */
export function _liveSubscriptionCount(sessionId: string): number {
	return live.get(sessionId)?.size ?? 0;
}

/** Test seam — drop all live subscriptions. */
export function _resetSubscriptionsForTest(): void {
	const sessions = [...live.values()];
	live.clear();
	pending.clear();
	for (const bySession of sessions) {
		for (const subscription of bySession.values()) subscription.stop();
	}
}
