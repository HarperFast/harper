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
const MAX_TIMEOUT_MS = 2_147_483_647;

// Read fresh per call so tests can override it without resetting the module cache.
function terminateTimeoutMs(): number {
	const timeoutMs = Number(process.env.HARPER_SUBSCRIPTION_TERMINATE_TIMEOUT_MS) || 5_000;
	return Math.min(Math.max(timeoutMs, 1), MAX_TIMEOUT_MS);
}

interface LiveSubscription {
	username: string;
	/** JWT `exp` (seconds since epoch) of the credential the subscription was opened with, if any. */
	authExpiresAt?: number;
	/** Returns true if the principal is still authorized for this subscription. */
	recheck: () => Promise<boolean>;
	/** Stop delivery and tear down the subscription. May be async (e.g. a shared-feed refcount release). */
	terminate: () => void | Promise<void>;
	/** The in-flight terminate call, cleared after it settles. */
	pendingTerminate?: Promise<void>;
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

function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => reject(new Error(message)), ms);
		// don't let a pending timeout keep the process alive
		(timer as any).unref?.();
		promise.then(
			(value) => {
				clearTimeout(timer);
				resolve(value);
			},
			(error) => {
				clearTimeout(timer);
				reject(error);
			}
		);
	});
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
 * If `revoke` is supplied, it is used as the entry's terminate instead, and the subscription object
 * is left untouched (no `end` wrapping, no 'close' listener) — the caller unregisters through the
 * returned handle instead. This is the seam a feed shared by many subscribers needs: revocation must
 * stay per subscriber even once feed delivery is shared, so the registry can't assume it owns the
 * subscription object or that only one registrant will ever mutate it.
 *
 * Three invariants a `revoke` caller must uphold, not enforced by this module: (1) it owns the
 * entry's lifetime end-to-end — nothing here detects a leaked registration, so a caller that forgets
 * `unregister()` on some teardown path degrades sweep latency for every other tracked subscriber, not
 * just its own; (2) if it shares one feed (and one `recheck`) across subscribers, `recheck` must not
 * mutate state shared across them — `registerLiveSubscriptionForContext` in resources/Resource.ts
 * mutates `context.user` to the freshly-rechecked principal, which is safe only because each context
 * today belongs to exactly one subscriber; (3) `revoke` must be idempotent and safe to run concurrently
 * with the caller's own teardown — a *rejected* attempt is re-invoked on the next sweep, but only if
 * that sweep's `recheck` again denies, so a subscription whose permission was restored in between is
 * left half-torn-down and treated as healthy; an attempt that never settles is not retried at all and
 * the entry is never rechecked again; and `unregister()` racing an in-flight `revoke` is only closed
 * up to the point the await begins, not for the remainder of it.
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

function invokeTerminate(entry: LiveSubscription): Promise<void> {
	try {
		return Promise.resolve(entry.terminate());
	} catch (error) {
		return Promise.reject(error);
	}
}

/**
 * Terminate a registered entry and remove it only after success. A rejected attempt remains tracked
 * for retry; a pending attempt is not invoked again. The settle handler commits a late success even
 * after the sweep's timeout has elapsed.
 */
async function claimAndTerminate(entry: LiveSubscription, reason: string): Promise<boolean> {
	if (!registry.has(entry)) return false; // the caller already unregistered this entry itself
	if (entry.pendingTerminate) return false; // at-most-once, enforced here so any caller gets it, not just sweep()

	const attempt = invokeTerminate(entry);
	entry.pendingTerminate = attempt;
	attempt.then(
		() => {
			if (entry.pendingTerminate === attempt) entry.pendingTerminate = undefined;
			registry.delete(entry);
			stopIfIdle();
			safeLog(hdbLogger.warn, `liveSubscriptionAuth: terminate completed for ${entry.username} (${reason})`);
		},
		(error) => {
			if (entry.pendingTerminate === attempt) entry.pendingTerminate = undefined;
			safeLog(
				hdbLogger.error,
				`liveSubscriptionAuth: terminate failed for ${entry.username} (${reason}), will retry on the next sweep that still denies: ${errorMessage(error)}`
			);
		}
	);

	const timeoutMs = terminateTimeoutMs();
	try {
		await withTimeout(attempt, timeoutMs, `terminate timed out after ${timeoutMs}ms`);
	} catch {
		if (entry.pendingTerminate === attempt) {
			safeLog(
				hdbLogger.error,
				`liveSubscriptionAuth: terminate for ${entry.username} (${reason}) still pending after ${timeoutMs}ms; awaiting settlement`
			);
		}
		return false;
	}
	return true;
}

async function sweep(): Promise<void> {
	if (sweeping) return; // a slow recheck must not overlap with the next tick/event
	sweeping = true;
	try {
		for (const entry of Array.from(registry)) {
			if (!registry.has(entry)) continue;
			if (entry.pendingTerminate) {
				safeLog(
					hdbLogger.error,
					`liveSubscriptionAuth: terminate for ${entry.username} (previously pending) still pending from an earlier sweep`
				);
				continue;
			}
			try {
				const now = Date.now();
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
