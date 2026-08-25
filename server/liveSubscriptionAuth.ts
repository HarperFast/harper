import hdbLogger from '../utility/logging/harper_logger.ts';

/**
 * Continuous re-authorization for live subscriptions (#1414).
 *
 * Subscribe-time authorization is a point-in-time check: once a stream (SSE / WebSocket / MQTT)
 * is open, it keeps delivering even if the principal later loses access (drop_user, role/permission
 * change) or its bearer token expires. This registry re-evaluates each live subscription's
 * authorization — at the TABLE/RBAC level, matching how the subscription was granted; there is no
 * per-record evaluation — and terminates any that no longer authorize.
 *
 * Triggers: (1) immediately on the ITC user-change broadcast (the same signal that rebuilds the
 * user/role cache), and (2) on a fixed interval as a backstop and to catch token expiry, which is
 * not event-signaled.
 */

// Backstop interval; also catches token expiry, which is not event-signaled. Overridable for tests.
const RECHECK_INTERVAL_MS = Number(process.env.HARPER_SUBSCRIPTION_REAUTH_INTERVAL_MS) || 30_000;

interface LiveSubscription {
	username: string;
	/** JWT `exp` (seconds since epoch) of the credential the subscription was opened with, if any. */
	authExpiresAt?: number;
	/** Returns true if the principal is still authorized for this subscription. */
	recheck: () => Promise<boolean>;
	/** Stop delivery and tear down. May be async (e.g. a shared-feed refcount release). */
	terminate: () => void | Promise<void>;
}

function errorMessage(error: unknown): string {
	try {
		return error instanceof Error ? error.message : String(error);
	} catch {
		return '<error message unavailable>';
	}
}

function safeLog(log: ((message: string) => void) | undefined, message: string): void {
	try {
		log?.(message);
	} catch {
		/* a broken logger must not turn a contained failure into a new one */
	}
}

const registry = new Set<LiveSubscription>();
let sweepTimer: any = null;
let itcListenerInstalled = false;
let sweeping = false;

const NOOP_HANDLE = { unregister: () => {} };

function triggerSweep(): void {
	void sweep().catch((error) => safeLog(hdbLogger.error, `liveSubscriptionAuth: sweep failed: ${errorMessage(error)}`));
}

function ensureStarted(): void {
	if (!sweepTimer) {
		sweepTimer = setInterval(triggerSweep, RECHECK_INTERVAL_MS);
		// don't keep the worker alive solely for the recheck timer
		sweepTimer.unref?.();
	}
	if (!itcListenerInstalled) {
		try {
			// Fire an immediate sweep when a user/role mutation propagates. serverHandlers rebuilds the
			// user/role cache before invoking listeners, so recheck() observes the new permissions.
			const handlers = require('./itc/serverHandlers.js');
			if (handlers?.userHandler?.addListener) {
				handlers.userHandler.addListener(triggerSweep);
				itcListenerInstalled = true;
			}
		} catch (error) {
			hdbLogger.trace?.(`liveSubscriptionAuth: ITC userHandler unavailable: ${(error as Error).message}`);
		}
	}
}

function stopIfIdle(): void {
	if (registry.size === 0 && sweepTimer) {
		clearInterval(sweepTimer);
		sweepTimer = null;
	}
}

/**
 * Register a live subscription for continuous re-authorization.
 *
 * If `revoke` is omitted, behavior matches #1414 exactly: terminate defaults to
 * end()/close()/emit('close') on `subscription`, and the subscription's own teardown (end()/close)
 * automatically unregisters it.
 *
 * If `revoke` is supplied, it is used as the entry's terminate instead and the subscription object
 * is left untouched (no `end` wrapping, no 'close' listener) — the caller unregisters through the
 * returned handle. This is the seam a feed shared by many subscribers needs: revocation must stay
 * per subscriber even once feed delivery is shared, so the registry can't assume it owns the
 * subscription object or that only one registrant will ever mutate it.
 *
 * Three invariants a `revoke` caller must uphold, none enforced here: (1) it owns the entry's
 * lifetime end-to-end — nothing detects a leaked registration, so a caller that forgets
 * `unregister()` on some teardown path degrades sweep latency for every other tracked subscriber,
 * not just its own; (2) if it shares one feed (and one `recheck`) across subscribers, `recheck`
 * must not mutate state shared across them — `registerLiveSubscriptionForContext` in
 * resources/Resource.ts mutates `context.user` to the freshly-rechecked principal, which is safe
 * only because each context today belongs to exactly one subscriber; (3) `revoke` gets exactly one
 * best-effort invocation — the entry is untracked before it runs, so a `revoke` that throws, rejects
 * or never settles is logged and never retried, and a caller needing recovery from a failed teardown
 * must implement it inside `revoke`.
 */
export function registerLiveSubscription(
	opts: {
		username: string;
		authExpiresAt?: number;
		recheck: () => Promise<boolean>;
	} & (
		| { subscription: any; revoke?: undefined }
		// a revoke-only registrant may own no subscription object; requiring one of the two modes keeps
		// a caller that supplies neither from type-checking into a silent no-op registration
		| { subscription?: any; revoke: () => void | Promise<void> }
	)
): { unregister: () => void } {
	const { subscription, username, authExpiresAt, recheck, revoke } = opts;
	if (!revoke && (!subscription || typeof subscription !== 'object' || subscription.closed)) return NOOP_HANDLE;

	const entry: LiveSubscription = {
		username,
		authExpiresAt,
		recheck,
		terminate:
			revoke ??
			(() => {
				// end() removes the subscription from the broadcast loop and closes its iterable queue.
				if (subscription.end) subscription.end();
				else if (subscription.close) subscription.close();
				else subscription.emit?.('close');
			}),
	};
	registry.add(entry);

	const unregister = () => {
		registry.delete(entry);
		stopIfIdle();
	};

	if (!revoke) {
		// Both transports ultimately call end() on normal teardown (MQTT unsubscribe/disconnect; SSE close
		// is wired to end()); wrap it so a closed stream never leaks a registry entry. Also listen for
		// 'close' to cover any iterable that closes without an end(). Skipped when `revoke` is supplied:
		// the caller owns unregistration, and a subscription shared by many subscribers must not be
		// mutated once per registrant.
		const originalEnd = typeof subscription.end === 'function' ? subscription.end.bind(subscription) : null;
		if (originalEnd) {
			subscription.end = function (...args: any[]) {
				unregister();
				return originalEnd(...args);
			};
		}
		subscription.on?.('close', unregister);
	}

	ensureStarted();
	return { unregister };
}

/**
 * Untrack an entry and tear it down, best effort. Untracking first keeps a `revoke` that hangs or
 * fails from wedging the sweep or being re-entered by a later one; recovering from a failed teardown
 * is the caller's job, per registerLiveSubscription's third invariant.
 */
function terminateEntry(entry: LiveSubscription, reason: string): void {
	registry.delete(entry);
	safeLog(hdbLogger.warn, `liveSubscriptionAuth: revoking subscription for ${entry.username} (${reason})`);
	const failed = (error: unknown) =>
		safeLog(
			hdbLogger.error,
			`liveSubscriptionAuth: terminate failed for ${entry.username} (${reason}): ${errorMessage(error)}`
		);
	try {
		// an async terminate's rejection would otherwise surface as an unhandled rejection on the timer's stack
		Promise.resolve(entry.terminate()).catch(failed);
	} catch (error) {
		failed(error);
	}
}

async function sweep(): Promise<void> {
	if (sweeping) return; // a slow recheck must not overlap with the next tick/event
	sweeping = true;
	try {
		// snapshot: an entry the caller unregisters mid-sweep must not be rechecked or revoked
		for (const entry of Array.from(registry)) {
			if (!registry.has(entry)) continue;
			try {
				const expired = entry.authExpiresAt != null && Date.now() >= entry.authExpiresAt * 1000;
				const stillAuthorized = expired ? false : await entry.recheck();
				if (!registry.has(entry)) continue;
				if (expired || !stillAuthorized) terminateEntry(entry, expired ? 'token expired' : 'no longer authorized');
			} catch (error) {
				// fail closed: if authorization can't be confirmed, revoke
				if (registry.has(entry)) terminateEntry(entry, `recheck error: ${errorMessage(error)}`);
			}
		}
	} finally {
		sweeping = false;
		stopIfIdle();
	}
}

/** Test-only: current number of tracked subscriptions. */
export function _liveSubscriptionCount(): number {
	return registry.size;
}

/** Test-only: run a sweep synchronously, bypassing the interval/ITC triggers. */
export function _sweepNow(): Promise<void> {
	return sweep();
}
