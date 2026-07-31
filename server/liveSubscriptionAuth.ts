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
	/** Stop delivery and tear down the subscription. May be async (e.g. a shared-feed refcount release). */
	terminate: () => void | Promise<void>;
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

const registry = new Set<LiveSubscription>();
let sweepTimer: any = null;
let itcListenerInstalled = false;
let sweeping = false;

const NOOP_HANDLE = { unregister: () => {} };

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
 * Register a live subscription for continuous re-authorization.
 *
 * If `revoke` is omitted, behavior matches #1414 exactly: terminate defaults to
 * end()/close()/emit('close') on `subscription`, and the subscription's own teardown (end()/close)
 * automatically unregisters it.
 *
 * If `revoke` is supplied, it is used as the entry's terminate instead, and the subscription object
 * is left untouched (no `end` wrapping, no 'close' listener) — the caller unregisters through the
 * returned handle instead. This is the seam a feed shared by many subscribers needs: revocation must
 * stay per subscriber even once feed delivery is shared, so the registry can't assume it owns the
 * subscription object or that only one registrant will ever mutate it.
 *
 * Two invariants a `revoke` caller must uphold, not enforced by this module: (1) it owns the entry's
 * lifetime end-to-end — nothing here detects a leaked registration, so a caller that forgets
 * `unregister()` on some teardown path degrades sweep latency for every other tracked subscriber, not
 * just its own; (2) if it shares one feed (and one `recheck`) across subscribers, `recheck` must not
 * mutate state shared across them — `registerLiveSubscriptionForContext` in resources/Resource.ts
 * mutates `context.user` to the freshly-rechecked principal, which is safe only because each context
 * today belongs to exactly one subscriber.
 */
export function registerLiveSubscription(opts: {
	subscription: any;
	username: string;
	authExpiresAt?: number;
	recheck: () => Promise<boolean>;
	revoke?: () => void | Promise<void>;
}): { unregister: () => void } {
	const { subscription, username, authExpiresAt, recheck, revoke } = opts;
	if (!subscription || typeof subscription !== 'object' || subscription.closed) return NOOP_HANDLE;

	const entry: LiveSubscription = {
		username,
		authExpiresAt,
		recheck,
		terminate:
			revoke ??
			(() => {
				// end() removes the subscription from the broadcast loop and closes its iterable queue.
				try {
					if (subscription.end) subscription.end();
					else if (subscription.close) subscription.close();
					else subscription.emit?.('close');
				} catch {
					/* ignore */
				}
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
 * Remove `entry` and run its terminate/revoke, but only commit the removal once terminate actually
 * succeeds — and only if the caller hasn't already unregistered this entry itself (checked via
 * `registry.has`, not a delete-then-restore, so a failed attempt never revisits the entry within the
 * same sweep pass; it's simply left in place for the next one). This makes revocation genuinely
 * fail-closed: a `revoke` that throws or rejects (e.g. a shared-feed refcount release hitting a
 * transient backing-store error) leaves the entry registered instead of being forgotten, so the next
 * sweep retries — recheck fails the same way, so the retry converges once teardown succeeds. It also
 * means a `revoke`/default-terminate failure never masquerades as a successful revocation in the log.
 * `terminate` is awaited (it may be async) so a rejection is caught here rather than becoming an
 * unhandled rejection on the worker.
 */
async function claimAndTerminate(entry: LiveSubscription, reason: string): Promise<boolean> {
	if (!registry.has(entry)) return false; // the caller already unregistered this entry itself
	try {
		await entry.terminate();
	} catch (error) {
		hdbLogger.error?.(
			`liveSubscriptionAuth: terminate failed for ${entry.username} (${reason}), will retry next sweep: ${errorMessage(error)}`
		);
		return false;
	}
	registry.delete(entry);
	hdbLogger.info?.(`liveSubscriptionAuth: revoked subscription for ${entry.username} (${reason})`);
	return true;
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
				if (expired || !stillAuthorized) {
					await claimAndTerminate(entry, expired ? 'token expired' : 'no longer authorized');
				}
			} catch (error) {
				// fail closed: if authorization can't be confirmed, revoke
				await claimAndTerminate(entry, `recheck error: ${errorMessage(error)}`);
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
