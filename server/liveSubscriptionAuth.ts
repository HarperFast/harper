import hdbLogger from '../utility/logging/harper_logger.ts';
import { coalesceRefresh } from '../utility/coalesceRefresh.ts';
import { CLOSES_WHEN_ENDED } from '../resources/IterableEventQueue.ts';

/**
 * Continuous re-authorization for live subscriptions (#1414).
 *
 * Subscribe-time authorization is a point-in-time check: once a stream (SSE / WebSocket / MQTT)
 * is open, it keeps delivering even if the principal later loses access (drop_user, role/permission
 * change) or its bearer token expires. This registry re-evaluates each live subscription's
 * authorization — at the TABLE/RBAC level, matching how the subscription was granted; there is no
 * per-record evaluation — and terminates any that no longer authorize.
 *
 * Triggers: (1) promptly on a user or role change (`onUserChange`: hdb_user/hdb_role table
 * subscriptions), and (2) on a fixed interval as a backstop and to catch token expiry, which is not
 * event-signaled.
 *
 * Scale: an MQTT fan-out holds 150k+ subscriptions per worker that collapse to a handful of distinct
 * admissions (resource class, user, target), so a registration may name its admission (`authKey`) and
 * identical ones share one group: one recheck per group per sweep, and one admitted target and resource
 * retained per group rather than per subscription. Only the token-expiry comparison stays per
 * subscription. A registration with no key gets a group of its own, which is the per-subscription behavior.
 */

// Backstop interval; also catches token expiry, which is not event-signaled. Overridable for tests.
const RECHECK_INTERVAL_MS = Number(process.env.HARPER_SUBSCRIPTION_REAUTH_INTERVAL_MS) || 30_000;

interface LiveSubscription {
	group: RecheckGroup;
	/** JWT `exp` (seconds since epoch) of the credential the subscription was opened with, if any. */
	authExpiresAt?: number;
	/** The subscription's own context, handed to its group's recheck. */
	context?: any;
	/** Torn down by end()/close()/emit('close') unless `revoke` is supplied. */
	subscription?: any;
	/** Stop delivery and tear down instead. May be async (e.g. a shared-feed refcount release). */
	revoke?: () => void | Promise<void>;
}

interface RecheckGroup {
	username: string;
	/** Present for a shared group; a group of its own has none. */
	key?: string;
	/**
	 * Returns true if the principal is still authorized, given the contexts of the members being
	 * rechecked. A shared group keeps the recheck of its first registration: its members were admitted
	 * identically.
	 */
	recheck: (contexts: any[]) => Promise<boolean>;
	entries: Set<LiveSubscription>;
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

const groups = new Set<RecheckGroup>();
const groupsByKey = new Map<string, RecheckGroup>();
let entryCount = 0;
/** A subscription's registry entries (one, or an array), found by its shared teardown hooks. */
const ENTRIES = Symbol('liveSubscriptionAuthEntries');
/** The end() a non-closing subscription had before registration wrapped it. */
const ORIGINAL_END = Symbol('liveSubscriptionAuthOriginalEnd');
let sweepTimer: any = null;
let userChangeListenerInstalled = false;
let sweeping = false;

const NOOP_HANDLE = { unregister: () => {} };

// A change that lands while a sweep runs gets a sweep of its own; the running one may have rechecked its entry already
const coalescedSweep = coalesceRefresh(sweep);

function triggerSweep(): void {
	void coalescedSweep().catch((error) =>
		safeLog(hdbLogger.error, `liveSubscriptionAuth: sweep failed: ${errorMessage(error)}`)
	);
}

function ensureStarted(): void {
	if (!sweepTimer) {
		sweepTimer = setInterval(triggerSweep, RECHECK_INTERVAL_MS);
		// don't keep the worker alive solely for the recheck timer
		sweepTimer.unref?.();
	}
	if (!userChangeListenerInstalled) {
		try {
			require('../security/user').onUserChange(triggerSweep);
			userChangeListenerInstalled = true;
		} catch (error) {
			hdbLogger.trace?.(`liveSubscriptionAuth: user change notifications unavailable: ${(error as Error).message}`);
		}
	}
}

function stopIfIdle(): void {
	if (entryCount === 0 && sweepTimer) {
		clearInterval(sweepTimer);
		sweepTimer = null;
	}
}

/**
 * Register a live subscription for continuous re-authorization.
 *
 * Without `revoke`, teardown is end()/close()/emit('close') on `subscription`, and the
 * subscription's own teardown unregisters the entry so callers need not.
 *
 * With `revoke`, that becomes the teardown and `subscription` is never touched — no `end` wrapping,
 * no 'close' listener — because a feed shared by many subscribers must stay revocable per subscriber,
 * so the registry can neither own the shared object nor let every registrant mutate it. A `revoke`
 * caller owns the entry's lifetime: nothing detects a leaked registration, and a forgotten
 * `unregister()` degrades sweep latency for every other tracked subscriber. It also owns teardown
 * recovery — the entry is untracked before `revoke` runs and `revoke` is invoked exactly once, so one
 * that throws, rejects or never settles is logged and never retried. A `recheck` shared across
 * subscribers must not mutate state shared across them: `registerLiveSubscriptionForContext` in
 * resources/Resource.ts mutates `context.user`, which is safe only while each context has exactly
 * one subscriber.
 *
 * With an `authKey`, the entry joins the group of earlier registrations with the same key and its
 * `recheck` is dropped for the group's, which runs once per sweep for all of its members and is given
 * their contexts. The group also keeps whatever its recheck holds (the first registration's resource
 * and admitted target) until its last member ends.
 */
export function registerLiveSubscription(
	opts: {
		username: string;
		authExpiresAt?: number;
		/** Rechecks this admission; a shared group passes the contexts of the members it rechecks. */
		recheck: (contexts: any[]) => Promise<boolean>;
		/** Identity of the admission; registrations with the same key share one group and its recheck. */
		authKey?: string | null;
		/** This subscription's context, handed to the group's recheck. */
		context?: any;
	} & (
		| { subscription: any; revoke?: undefined }
		// requiring one of the two modes stops a caller that supplies neither from type-checking
		// into a silent no-op registration; a revoke-only registrant may own no subscription object
		| { subscription?: any; revoke: () => void | Promise<void> }
	)
): { unregister: () => void } {
	const { subscription, username, authExpiresAt, recheck, authKey, context, revoke } = opts;
	if (!revoke && (!subscription || typeof subscription !== 'object' || subscription.closed)) return NOOP_HANDLE;

	let group = authKey != null ? groupsByKey.get(authKey) : undefined;
	if (!group) {
		group = { username, recheck, entries: new Set() };
		if (authKey != null) {
			group.key = authKey;
			groupsByKey.set(authKey, group);
		}
		groups.add(group);
	}
	const entry: LiveSubscription = { group, authExpiresAt, context };
	if (revoke) entry.revoke = revoke;
	else entry.subscription = subscription;
	group.entries.add(entry);
	entryCount++;

	if (!revoke) {
		// Both transports ultimately call end() on normal teardown (MQTT unsubscribe/disconnect; SSE close
		// is wired to end()), and a table subscription's end() emits 'close'. Listening for 'close' covers
		// those and any iterable that closes without an end(); end() is wrapped only on an iterable whose
		// end() may not close it, so a closed stream never leaks a registry entry. Both hooks are shared
		// functions that find the entries on the subscription. Skipped when `revoke` is supplied: the caller
		// owns unregistration, and a subscription shared by many subscribers must not be mutated once per
		// registrant.
		const existing = subscription[ENTRIES];
		if (existing === undefined) {
			subscription[ENTRIES] = entry;
			if (!subscription[CLOSES_WHEN_ENDED] && typeof subscription.end === 'function') {
				subscription[ORIGINAL_END] = subscription.end;
				subscription.end = endAndUnregister;
			}
			subscription.on?.('close', unregisterOnClose);
		} else if (Array.isArray(existing)) existing.push(entry);
		else subscription[ENTRIES] = [existing, entry];
	}

	ensureStarted();
	return { unregister: () => removeEntry(entry) };
}

function removeEntry(entry: LiveSubscription): void {
	const group = entry.group;
	if (!group.entries.delete(entry)) return; // already gone: end() and 'close' both unregister
	entryCount--;
	if (group.entries.size === 0) {
		groups.delete(group);
		if (group.key !== undefined) groupsByKey.delete(group.key);
	}
	stopIfIdle();
}

function unregisterSubscription(subscription: any): void {
	const entries = subscription[ENTRIES];
	if (Array.isArray(entries)) for (const entry of entries) removeEntry(entry);
	else if (entries) removeEntry(entries);
}

/** A registered subscription's 'close' listener (an emitter calls it with `this` bound), one for all of them. */
function unregisterOnClose(this: any) {
	unregisterSubscription(this);
}

/** Replaces end() on a registered subscription whose end() may not close it: unregisters, then ends. */
function endAndUnregister(this: any, ...args: any[]) {
	unregisterSubscription(this);
	return this[ORIGINAL_END](...args);
}

/** Untrack first: a `terminate` that hangs or fails must not wedge the sweep or be re-entered by a later one. */
function terminateEntry(
	entry: LiveSubscription,
	reason: string,
	notice: ((message: string) => void) | undefined = hdbLogger.info
): void {
	removeEntry(entry);
	const { username } = entry.group;
	safeLog(notice, `liveSubscriptionAuth: revoking subscription for ${username} (${reason})`);
	const failed = (error: unknown) =>
		safeLog(
			hdbLogger.error,
			`liveSubscriptionAuth: terminate failed for ${username} (${reason}): ${errorMessage(error)}`
		);
	try {
		// an async terminate's rejection would otherwise surface as an unhandled rejection on the timer's stack
		Promise.resolve(terminate(entry)).catch(failed);
	} catch (error) {
		failed(error);
	}
}

function terminate(entry: LiveSubscription): void | Promise<void> {
	if (entry.revoke) return entry.revoke();
	// end() removes the subscription from the broadcast loop and closes its iterable queue.
	const subscription = entry.subscription;
	if (subscription.end) subscription.end();
	else if (subscription.close) subscription.close();
	else subscription.emit?.('close');
}

async function sweep(): Promise<void> {
	if (sweeping) return; // a slow recheck must not overlap with the next tick/event
	sweeping = true;
	// the per-subscriber lines are info, which the shipped default (logging.level: warn) drops; one
	// aggregate keeps the pass visible without making a mass role change a warn per subscriber
	const revokedByReason = new Map<string, number>();
	const countRevocation = (reason: string) => revokedByReason.set(reason, (revokedByReason.get(reason) ?? 0) + 1);
	try {
		// snapshots bound the pass to groups and members present at its start; the has() guards cover the rest
		for (const group of Array.from(groups)) {
			const members: LiveSubscription[] = [];
			for (const entry of Array.from(group.entries)) {
				if (entry.authExpiresAt != null && Date.now() >= entry.authExpiresAt * 1000) {
					terminateEntry(entry, 'token expired');
					countRevocation('token expired');
				} else members.push(entry);
			}
			if (members.length === 0) continue;
			let stillAuthorized = false;
			let failure: unknown;
			try {
				stillAuthorized = await group.recheck(members.map((entry) => entry.context));
			} catch (error) {
				failure = error;
			}
			for (const entry of members) {
				if (!group.entries.has(entry)) continue;
				if (failure !== undefined) {
					// fail closed: if authorization can't be confirmed, revoke
					terminateEntry(entry, `recheck error: ${errorMessage(failure)}`, hdbLogger.warn);
					countRevocation('recheck error');
				} else if (!stillAuthorized) {
					terminateEntry(entry, 'no longer authorized');
					countRevocation('no longer authorized');
				}
			}
		}
	} finally {
		sweeping = false;
		stopIfIdle();
		if (revokedByReason.size > 0) {
			let total = 0;
			for (const count of revokedByReason.values()) total += count;
			const breakdown = Array.from(revokedByReason, ([reason, count]) => `${reason}: ${count}`).join(', ');
			safeLog(
				hdbLogger.warn,
				// "revoking", like the per-subscriber line: teardown is dispatched, not awaited, and a
				// failure surfaces on its own error line
				`liveSubscriptionAuth: revoking ${total} live subscription${total === 1 ? '' : 's'} (${breakdown})`
			);
		}
	}
}

/** Test-only: current number of tracked subscriptions. */
export function _liveSubscriptionCount(): number {
	return entryCount;
}

/** Test-only: current number of recheck groups. */
export function _liveSubscriptionGroupCount(): number {
	return groups.size;
}

/** Test-only: run a sweep synchronously, bypassing the interval/ITC triggers. */
export function _sweepNow(): Promise<void> {
	return sweep();
}
