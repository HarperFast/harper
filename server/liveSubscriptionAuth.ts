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

// Bounds how long a caller-supplied terminate/revoke may hold the serialized sweep before being
// treated as a failure (same fail-closed retry as a throw/rejection). The default terminate settles
// long before this — it only ever engages for a caller-supplied `revoke` that hangs. Read fresh per
// call rather than cached at module load, so tests can override it without a require-cache reset.
function terminateTimeoutMs(): number {
	return Number(process.env.HARPER_SUBSCRIPTION_TERMINATE_TIMEOUT_MS) || 5_000;
}

interface LiveSubscription {
	username: string;
	/** JWT `exp` (seconds since epoch) of the credential the subscription was opened with, if any. */
	authExpiresAt?: number;
	/** Returns true if the principal is still authorized for this subscription. */
	recheck: () => Promise<boolean>;
	/** Stop delivery and tear down the subscription. May be async (e.g. a shared-feed refcount release). */
	terminate: () => void | Promise<void>;
	/**
	 * The in-flight `terminate()` call, if a prior attempt is still pending (timed out, not settled).
	 * Reused rather than calling `terminate` again, so a hung `revoke` is never invoked twice for the
	 * same entry — the seam's documented idempotency invariant is enforced here rather than merely
	 * assumed of caller code.
	 */
	pendingTerminate?: Promise<void>;
}

function errorMessage(error: unknown): string {
	try {
		return error instanceof Error ? error.message : String(error);
	} catch {
		// a thrown value whose own String()/toString() throws (e.g. Object.create(null)) must not turn
		// a contained failure into a new one — this runs inside a sweep catch handler with no outer guard.
		return '<error message unavailable>';
	}
}

// hdbLogger's file-backed transport can itself throw (e.g. ENOSPC/EIO on the underlying
// fs.appendFileSync) with nothing between it and the caller. A logging call inside a fail-closed
// catch arm must never be the thing that defeats fail-closed by escaping as a new exception.
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

// sweep()'s own try/finally protects its recheck body, but a throw from claimAndTerminate's fail-
// closed catch-arm call (e.g. a logger call that itself throws) would otherwise escape as an
// unhandled rejection from these fire-and-forget triggers.
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
 * with the caller's own teardown — a failed attempt is retried on the next sweep (see
 * `claimAndTerminate`), and `unregister()` racing an in-flight `revoke` is only closed up to the point
 * the await begins, not for the remainder of it.
 */
export function registerLiveSubscription(opts: {
	subscription: any;
	username: string;
	authExpiresAt?: number;
	recheck: () => Promise<boolean>;
	revoke?: () => void | Promise<void>;
}): { unregister: () => void } {
	const { subscription, username, authExpiresAt, recheck, revoke } = opts;
	// The registry-owned teardown path needs a live, mutable subscription object to wrap; the
	// caller-owned `revoke` path never touches `subscription` at all (see below), so a caller with no
	// meaningful subscription object to hand over — the expected shape for a shared feed — isn't held
	// to that requirement.
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
 * Remove `entry` and run its terminate/revoke, but only if the caller hasn't already unregistered
 * this entry itself (checked via `registry.has`, not a delete-then-restore, so a failed attempt never
 * revisits the entry within the same sweep pass; it's simply left in place for the next one). This
 * makes revocation fail-closed on *tracking*: a `revoke` that throws, rejects, or never settles (e.g.
 * a shared-feed refcount release hitting a wedged backing store) leaves the entry registered instead
 * of being forgotten, so the next sweep retries — recheck fails the same way, so the retry converges
 * once teardown succeeds.
 *
 * `terminate` is invoked at most once per entry no matter how many sweeps it takes to settle.
 * `entry.pendingTerminate` caches the in-flight attempt, and the commit/failure handler is attached to
 * it ONCE, at creation — it fires whenever the attempt settles (success, rejection, or, for the
 * default terminate, a synchronous self-unregister via `subscription.end`'s wrapper), regardless of
 * whether any sweep is actively awaiting it at that moment. This is what makes a late success (one
 * that lands after this sweep's timeout window closes but before the next sweep starts) commit
 * exactly once instead of being silently discarded and re-invoked. A sweep that finds an attempt
 * already in flight from a previous pass does not re-invoke `terminate`/`revoke` and does not re-race
 * it either — the outcome will be handled by the original handler whenever it settles; there is
 * nothing left for a second wait to accomplish, and re-racing it would cost another full
 * `terminateTimeoutMs()` of serialized sweep time per stuck entry, every single pass, forever.
 *
 * Only the FIRST attempt is raced against `terminateTimeoutMs()`: without a bound, a caller-supplied
 * `revoke` that never settles would hold `sweeping` true forever (the `finally` in `sweep()` never
 * runs), silently disabling re-authorization for every subscription on the worker, not just this
 * entry's. `recheck` has the same unbounded-await shape but is registry-controlled Harper code;
 * `revoke` is arbitrary caller code, which is the materially wider exposure this bound closes.
 */
async function claimAndTerminate(entry: LiveSubscription, reason: string): Promise<boolean> {
	if (!registry.has(entry)) return false; // the caller already unregistered this entry itself
	if (entry.pendingTerminate) return false; // already being handled by a prior sweep's attempt

	const attempt = invokeTerminate(entry);
	entry.pendingTerminate = attempt;
	attempt.then(
		() => {
			if (entry.pendingTerminate === attempt) entry.pendingTerminate = undefined;
			registry.delete(entry);
			safeLog(hdbLogger.info, `liveSubscriptionAuth: revoked subscription for ${entry.username} (${reason})`);
		},
		(error) => {
			if (entry.pendingTerminate === attempt) entry.pendingTerminate = undefined;
			safeLog(
				hdbLogger.error,
				`liveSubscriptionAuth: terminate failed for ${entry.username} (${reason}), will retry next sweep: ${errorMessage(error)}`
			);
		}
	);

	const timeoutMs = terminateTimeoutMs();
	try {
		await withTimeout(attempt, timeoutMs, `terminate timed out after ${timeoutMs}ms`);
	} catch {
		// If the attempt itself already rejected, the handler above already logged the definitive
		// failure and cleared pendingTerminate — nothing more to do. If it's still pending (this is
		// our own timeout firing, not a rejection), pendingTerminate still points at it; log that this
		// sweep is still waiting so a persistently hung revoke doesn't go completely silent.
		if (entry.pendingTerminate === attempt) {
			safeLog(
				hdbLogger.error,
				`liveSubscriptionAuth: terminate for ${entry.username} (${reason}) still pending after ${timeoutMs}ms, will retry next sweep`
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
