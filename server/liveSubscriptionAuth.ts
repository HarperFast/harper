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
	/** Stop delivery and tear down the subscription. */
	terminate: () => void;
}

const registry = new Set<LiveSubscription>();
let sweepTimer: any = null;
let itcListenerInstalled = false;
let sweeping = false;

function ensureStarted(): void {
	if (!sweepTimer) {
		sweepTimer = setInterval(() => void sweep(), RECHECK_INTERVAL_MS);
		// don't keep the worker alive solely for the recheck timer
		sweepTimer.unref?.();
	}
	if (!itcListenerInstalled) {
		try {
			// Fire an immediate sweep when a user/role mutation propagates. serverHandlers rebuilds the
			// user/role cache before invoking listeners, so recheck() observes the new permissions.
			const handlers = require('./itc/serverHandlers.js');
			if (handlers?.userHandler?.addListener) {
				handlers.userHandler.addListener(() => void sweep());
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
 * Register a live subscription for continuous re-authorization. The returned subscription's normal
 * teardown (end()/close) automatically unregisters it, so callers don't need to.
 */
export function registerLiveSubscription(opts: {
	subscription: any;
	username: string;
	authExpiresAt?: number;
	recheck: () => Promise<boolean>;
}): void {
	const { subscription, username, authExpiresAt, recheck } = opts;
	if (!subscription || typeof subscription !== 'object') return;

	const entry: LiveSubscription = {
		username,
		authExpiresAt,
		recheck,
		terminate: () => {
			// emit('close') runs the subscription's own teardown wiring; end() removes it from the
			// broadcast notify loop so no further events are delivered. Both are idempotent.
			try {
				subscription.emit?.('close');
			} catch {
				/* ignore */
			}
			try {
				subscription.end?.();
			} catch {
				/* ignore */
			}
		},
	};
	registry.add(entry);

	const unregister = () => {
		registry.delete(entry);
		stopIfIdle();
	};
	// Both transports ultimately call end() on normal teardown (MQTT unsubscribe/disconnect; SSE close
	// is wired to end()); wrap it so a closed stream never leaks a registry entry. Also listen for
	// 'close' to cover any iterable that closes without an end().
	const originalEnd = typeof subscription.end === 'function' ? subscription.end.bind(subscription) : null;
	if (originalEnd) {
		subscription.end = function () {
			unregister();
			return originalEnd();
		};
	}
	subscription.on?.('close', unregister);

	ensureStarted();
}

async function sweep(): Promise<void> {
	if (sweeping) return; // a slow recheck must not overlap with the next tick/event
	sweeping = true;
	try {
		const now = Date.now();
		for (const entry of registry) {
			try {
				const expired = entry.authExpiresAt != null && now >= entry.authExpiresAt * 1000;
				const stillAuthorized = expired ? false : await entry.recheck();
				const revoke = expired || !stillAuthorized;
				if (revoke) {
					registry.delete(entry);
					entry.terminate();
				}
			} catch (error) {
				// fail closed: if authorization can't be confirmed, revoke
				registry.delete(entry);
				try {
					entry.terminate();
				} catch {
					/* ignore */
				}
				hdbLogger.warn?.(
					`liveSubscriptionAuth: revoked subscription for ${entry.username} after recheck error: ${(error as Error).message}`
				);
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
