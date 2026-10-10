import hdbLogger from '../utility/logging/harper_logger.ts';
import { coalesceRefresh } from '../utility/coalesceRefresh.ts';
import type { UserChange } from '../security/user.ts';

/**
 * Continuous re-authorization for live subscriptions (#1414).
 *
 * Subscribe-time authorization is a point-in-time check: once a stream (SSE / WebSocket / MQTT)
 * is open, it keeps delivering even if the principal later loses access (drop_user, role/permission
 * change) or its bearer token expires. This registry re-evaluates each live subscription's
 * authorization — at the TABLE/RBAC level, matching how the subscription was granted; there is no
 * per-record evaluation — and terminates any that no longer authorize.
 *
 * Targeting invariant: an entry is rechecked after every committed change to its username's hdb_user
 * record or to the hdb_role record that user names, and terminated by a timer at its token's expiry.
 * The tick rechecks every entry that is not `identityOnly`; an identity-only one only when delivery
 * since the last full pass is not certified, or every BACKSTOP_INTERVAL_MS. See server/DESIGN.md.
 */

const intervalOverride = Number(process.env.HARPER_SUBSCRIPTION_REAUTH_INTERVAL_MS) || undefined;
const RECHECK_INTERVAL_MS = intervalOverride ?? 30_000;
const BACKSTOP_INTERVAL_MS = intervalOverride ?? 300_000;
// a larger setTimeout delay overflows and fires at once
const MAX_TIMEOUT_MS = 2 ** 31 - 1;
const SLICE_SIZE = 256;
// past this many distinct pending identities a full pass is cheaper to track than the ids
const MAX_PENDING_IDS = 1000;

export interface RecheckPass {
	/** `compute(scope, key)` for the first call in this pass with this scope and key; its result after that. */
	memo<T>(scope: unknown, key: unknown, compute: (scope: any, key: any) => T): T;
}

interface PrincipalGroup {
	username: string;
	entries: Set<LiveSubscription>;
	/** The role id the user's hdb_user record named when last read. */
	roleId?: unknown;
}

interface LiveSubscription {
	username: string;
	/** JWT `exp` (seconds since epoch) of the credential the subscription was opened with, if any. */
	authExpiresAt?: number;
	identityOnly: boolean;
	/** Returns true if the principal is still authorized for this subscription. */
	recheck: (pass: RecheckPass) => Promise<boolean>;
	/** Stop delivery and tear down. May be async (e.g. a shared-feed refcount release). */
	terminate: () => void | Promise<void>;
	/** Set exactly while tracked: the only membership test. */
	group?: PrincipalGroup;
	/** Position in expiryHeap, or -1, so removal on unregister needs no search. */
	heapIndex: number;
	/** Set when re-authorization, rather than its owner, removed it. */
	revoked?: boolean;
}

interface LiveSubscriptionHandle {
	unregister: () => void;
	/**
	 * Rechecks this subscription now, outside any queued pass, terminating it if it no longer authorizes.
	 * Resolves 'revoked' when this recheck terminated it, and 'closed' when it was not or is no longer
	 * registered for another reason (its owner closed it).
	 */
	verify: () => Promise<'authorized' | 'revoked' | 'closed'>;
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

const groups = new Map<string, PrincipalGroup>();
const roleHolders = new Map<unknown, Set<PrincipalGroup>>();
const policyEntries = new Set<LiveSubscription>();
let trackedCount = 0;

let securityUser: typeof import('../security/user.ts') | undefined;
let tickTimer: any = null;
let userChangeListenerInstalled = false;

let pendingFull = false;
let pendingPolicy = false;
const pendingUsernames = new Set<unknown>();
const pendingRoleIds = new Set<unknown>();
const ANY_ROLE = Symbol('any role');
/** The notification epoch and start time of the last full pass that completed. */
let lastFullPass = { epoch: 0, startedAt: 0 };

const NOOP_HANDLE: LiveSubscriptionHandle = { unregister: () => {}, verify: () => Promise.resolve('closed') };

class Pass implements RecheckPass {
	sinceYield = 0;
	rechecked = 0;
	revokedByReason = new Map<string, number>();
	#memos = new Map<unknown, Map<unknown, unknown>>();

	memo<T>(scope: unknown, key: unknown, compute: (scope: any, key: any) => T): T {
		let values = this.#memos.get(scope);
		if (!values) this.#memos.set(scope, (values = new Map()));
		if (values.has(key)) return values.get(key) as T;
		const value = compute(scope, key);
		values.set(key, value);
		return value;
	}

	countRevocation(reason: string): void {
		this.revokedByReason.set(reason, (this.revokedByReason.get(reason) ?? 0) + 1);
	}
}

// A change that lands while a pass runs gets a pass of its own; the running one may have rechecked its entry already
const runPendingCoalesced = coalesceRefresh(runPending);

function schedulePending(): Promise<void> {
	return runPendingCoalesced().catch((error) =>
		safeLog(hdbLogger.error, `liveSubscriptionAuth: recheck pass failed: ${errorMessage(error)}`)
	);
}

function onUserChanged(change?: UserChange): void {
	if (!change) pendingFull = true;
	else if (!pendingFull) {
		// only identities tracked now: a later registration is checked at admission (`verify`)
		for (const username of change.usernames) {
			if (groups.has(username as string)) pendingUsernames.add(username);
		}
		for (const roleId of change.roleIds) {
			if (roleHolders.has(roleId)) pendingRoleIds.add(roleId);
		}
		if (change.roleIds.size > 0 && roleHolders.has(ANY_ROLE)) pendingRoleIds.add(ANY_ROLE);
		if (pendingUsernames.size + pendingRoleIds.size > MAX_PENDING_IDS) pendingFull = true;
	}
	if (pendingFull) {
		pendingUsernames.clear();
		pendingRoleIds.clear();
	} else if (pendingUsernames.size === 0 && pendingRoleIds.size === 0) return;
	void schedulePending();
}

function notificationEpoch(): number {
	try {
		return userChangeListenerInstalled ? securityUser!.userChangeNotificationEpoch() : 0;
	} catch {
		return 0;
	}
}

function tick(): void {
	const epoch = notificationEpoch();
	if (epoch === 0 || epoch !== lastFullPass.epoch || Date.now() - lastFullPass.startedAt >= BACKSTOP_INTERVAL_MS)
		pendingFull = true;
	else if (policyEntries.size > 0) pendingPolicy = true;
	else return;
	void schedulePending();
}

function ensureStarted(): void {
	if (!tickTimer) {
		tickTimer = setInterval(tick, RECHECK_INTERVAL_MS);
		// don't keep the worker alive solely for the recheck timer
		tickTimer.unref?.();
	}
	if (!userChangeListenerInstalled) {
		try {
			securityUser ??= require('../security/user');
			securityUser!.onUserChange(onUserChanged);
			userChangeListenerInstalled = true;
		} catch (error) {
			hdbLogger.trace?.(`liveSubscriptionAuth: user change notifications unavailable: ${(error as Error).message}`);
		}
	}
}

function stopIfIdle(): void {
	if (trackedCount === 0 && tickTimer) {
		clearInterval(tickTimer);
		tickTimer = null;
	}
}

/** Reads the role id the username's hdb_user record names; a group whose read failed is a holder of every role. */
function indexRole(group: PrincipalGroup): void {
	let roleId: unknown;
	try {
		securityUser ??= require('../security/user');
		roleId = securityUser!.userRecordVersions(group.username).roleId;
	} catch {
		roleId = ANY_ROLE;
	}
	setRole(group, roleId);
}

function setRole(group: PrincipalGroup, roleId: unknown): void {
	if (group.roleId === roleId) return;
	if (group.roleId != null) {
		const holders = roleHolders.get(group.roleId);
		holders?.delete(group);
		if (holders?.size === 0) roleHolders.delete(group.roleId);
	}
	group.roleId = roleId;
	if (roleId != null) {
		let holders = roleHolders.get(roleId);
		if (!holders) roleHolders.set(roleId, (holders = new Set()));
		holders.add(group);
	}
}

function track(entry: LiveSubscription): void {
	let group = groups.get(entry.username);
	if (!group) {
		group = { username: entry.username, entries: new Set() };
		groups.set(entry.username, group);
		indexRole(group);
	}
	group.entries.add(entry);
	entry.group = group;
	trackedCount++;
	if (!entry.identityOnly) policyEntries.add(entry);
	// a non-finite exp never expires (as isExpired reads it) and would disorder the heap
	if (Number.isFinite(entry.authExpiresAt)) addExpiry(entry);
}

/** The only way an entry leaves the registry; true if it was tracked. */
function untrack(entry: LiveSubscription): boolean {
	const group = entry.group;
	if (!group) return false;
	entry.group = undefined;
	trackedCount--;
	group.entries.delete(entry);
	if (group.entries.size === 0 && groups.get(group.username) === group) {
		groups.delete(group.username);
		setRole(group, undefined);
	}
	policyEntries.delete(entry);
	removeExpiry(entry);
	stopIfIdle();
	return true;
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
 * `unregister()` degrades pass latency for every other tracked subscriber. It also owns teardown
 * recovery — the entry is untracked before `revoke` runs and `revoke` is invoked exactly once, so one
 * that throws, rejects or never settles is logged and never retried. A `recheck` shared across
 * subscribers must not mutate state shared across them: `registerLiveSubscriptionForContext` in
 * resources/Resource.ts mutates `context.user`, which is safe only while each context has exactly
 * one subscriber.
 *
 * `identityOnly` declares that `recheck`'s decision reads nothing but the principal's hdb_user and
 * hdb_role records, so certified change notifications cover it and the periodic pass need not.
 */
export function registerLiveSubscription(
	opts: {
		username: string;
		authExpiresAt?: number;
		identityOnly?: boolean;
		recheck: (pass: RecheckPass) => Promise<boolean>;
	} & (
		| { subscription: any; revoke?: undefined }
		// requiring one of the two modes stops a caller that supplies neither from type-checking
		// into a silent no-op registration; a revoke-only registrant may own no subscription object
		| { subscription?: any; revoke: () => void | Promise<void> }
	)
): LiveSubscriptionHandle {
	const { subscription, username, authExpiresAt, identityOnly, recheck, revoke } = opts;
	if (!revoke && (!subscription || typeof subscription !== 'object' || subscription.closed)) return NOOP_HANDLE;

	const entry: LiveSubscription = {
		username,
		authExpiresAt,
		identityOnly: identityOnly === true,
		recheck,
		terminate:
			revoke ??
			(() => {
				// end() removes the subscription from the broadcast loop and closes its iterable queue.
				if (subscription.end) subscription.end();
				else if (subscription.close) subscription.close();
				else subscription.emit?.('close');
			}),
		heapIndex: -1,
	};
	ensureStarted();
	track(entry);

	const unregister = () => {
		untrack(entry);
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

	const verify = async (): Promise<'authorized' | 'revoked' | 'closed'> => {
		const pass = new Pass();
		await recheckEntry(pass, entry);
		reportRevocations(pass.revokedByReason);
		if (entry.group) return 'authorized';
		return entry.revoked ? 'revoked' : 'closed';
	};
	return { unregister, verify };
}

/** Untrack first: a `terminate` that hangs or fails must not wedge a pass or be re-entered by a later one. */
function terminateEntry(
	entry: LiveSubscription,
	reason: string,
	notice: ((message: string) => void) | undefined = hdbLogger.info
): boolean {
	if (!untrack(entry)) return false;
	entry.revoked = true;
	safeLog(notice, `liveSubscriptionAuth: revoking subscription for ${entry.username} (${reason})`);
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
	return true;
}

// the per-subscriber lines are info, which the shipped default (logging.level: warn) drops; one
// aggregate keeps a pass visible without making a mass role change a warn per subscriber
function reportRevocations(revokedByReason: Map<string, number>): void {
	if (revokedByReason.size === 0) return;
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

const yieldTurn = () => new Promise<void>((resolve) => setImmediate(resolve));

function isExpired(entry: LiveSubscription): boolean {
	return entry.authExpiresAt != null && Date.now() >= entry.authExpiresAt * 1000;
}

async function recheckEntry(pass: Pass, entry: LiveSubscription): Promise<void> {
	if (++pass.sinceYield >= SLICE_SIZE) {
		pass.sinceYield = 0;
		await yieldTurn();
	}
	if (!entry.group) return;
	pass.rechecked++;
	try {
		const expired = isExpired(entry);
		const stillAuthorized = expired ? false : await entry.recheck(pass);
		if (!entry.group) return;
		if (expired || !stillAuthorized) {
			const reason = expired ? 'token expired' : 'no longer authorized';
			if (terminateEntry(entry, reason)) pass.countRevocation(reason);
		}
	} catch (error) {
		// fail closed: if authorization can't be confirmed, revoke
		if (terminateEntry(entry, `recheck error: ${errorMessage(error)}`, hdbLogger.warn))
			pass.countRevocation('recheck error');
	}
}

async function recheckGroups(pass: Pass, scope: Iterable<PrincipalGroup>): Promise<void> {
	// snapshots bound the pass to what is present when it reaches each group; entry.group guards the rest
	for (const group of Array.from(scope)) {
		if (groups.get(group.username) !== group) continue;
		// a role reassignment is an hdb_user change for this username, so this pass re-reads it
		indexRole(group);
		for (const entry of Array.from(group.entries)) await recheckEntry(pass, entry);
	}
}

async function runPending(): Promise<void> {
	const full = pendingFull;
	const policy = pendingPolicy;
	const usernames = Array.from(pendingUsernames);
	const roleIds = Array.from(pendingRoleIds);
	pendingFull = pendingPolicy = false;
	pendingUsernames.clear();
	pendingRoleIds.clear();
	if (!full && !policy && usernames.length === 0 && roleIds.length === 0) return;
	const pass = new Pass();
	const startedAt = Date.now();
	try {
		if (full) {
			// captured at the start: what was notified before it is covered by this pass
			const epoch = notificationEpoch();
			await recheckGroups(pass, groups.values());
			lastFullPass = { epoch, startedAt };
			return;
		}
		const targets = new Set<PrincipalGroup>();
		for (const username of usernames) {
			const group = groups.get(username as string);
			if (group) targets.add(group);
		}
		for (const roleId of roleIds) {
			for (const group of roleHolders.get(roleId) ?? []) targets.add(group);
		}
		await recheckGroups(pass, targets);
		if (policy) {
			for (const entry of Array.from(policyEntries)) {
				if (!targets.has(entry.group!)) await recheckEntry(pass, entry);
			}
		}
	} finally {
		reportRevocations(pass.revokedByReason);
		hdbLogger.trace?.(
			`liveSubscriptionAuth: ${full ? 'full' : policy ? 'policy' : 'targeted'} pass rechecked ${pass.rechecked} subscription(s) in ${Date.now() - startedAt} ms`
		);
	}
}

const expiryHeap: LiveSubscription[] = [];
let expiryTimer: any = null;
let expiryTimerAt = Infinity;
let expiredInCohort = 0;

const expiresAtMs = (entry: LiveSubscription) => entry.authExpiresAt! * 1000;

function placeInHeap(entry: LiveSubscription, index: number): void {
	expiryHeap[index] = entry;
	entry.heapIndex = index;
}

function siftUp(index: number): void {
	const entry = expiryHeap[index];
	while (index > 0) {
		const parentIndex = (index - 1) >> 1;
		const parent = expiryHeap[parentIndex];
		if (expiresAtMs(parent) <= expiresAtMs(entry)) break;
		placeInHeap(parent, index);
		index = parentIndex;
	}
	placeInHeap(entry, index);
}

function siftDown(index: number): void {
	const entry = expiryHeap[index];
	const length = expiryHeap.length;
	while (true) {
		let childIndex = 2 * index + 1;
		if (childIndex >= length) break;
		if (childIndex + 1 < length && expiresAtMs(expiryHeap[childIndex + 1]) < expiresAtMs(expiryHeap[childIndex]))
			childIndex++;
		if (expiresAtMs(expiryHeap[childIndex]) >= expiresAtMs(entry)) break;
		placeInHeap(expiryHeap[childIndex], index);
		index = childIndex;
	}
	placeInHeap(entry, index);
}

function addExpiry(entry: LiveSubscription): void {
	expiryHeap.push(entry);
	siftUp(expiryHeap.length - 1);
	if (expiresAtMs(entry) < expiryTimerAt) armExpiryTimer(expiresAtMs(entry));
}

function removeExpiry(entry: LiveSubscription): void {
	const index = entry.heapIndex;
	if (index < 0) return;
	entry.heapIndex = -1;
	const last = expiryHeap.pop()!;
	if (last !== entry) {
		placeInHeap(last, index);
		siftDown(index);
		siftUp(last.heapIndex);
	}
	// a timer armed for an earlier head than the new one just fires and re-arms
	if (expiryHeap.length === 0 && expiryTimer) {
		clearTimeout(expiryTimer);
		expiryTimer = null;
		expiryTimerAt = Infinity;
	}
}

function armExpiryTimer(deadline: number): void {
	if (expiryTimer) clearTimeout(expiryTimer);
	expiryTimerAt = deadline;
	expiryTimer = setTimeout(expireDue, Math.min(Math.max(deadline - Date.now(), 0), MAX_TIMEOUT_MS));
	expiryTimer.unref?.();
}

function expireDue(): void {
	expiryTimer = null;
	expiryTimerAt = Infinity;
	const now = Date.now();
	let terminated = 0;
	while (expiryHeap.length > 0 && expiresAtMs(expiryHeap[0]) <= now) {
		if (terminated++ >= SLICE_SIZE) {
			// a cohort sharing one exp would otherwise hold the event loop for its whole teardown
			armExpiryTimer(now);
			return;
		}
		if (terminateEntry(expiryHeap[0], 'token expired')) expiredInCohort++;
	}
	if (expiredInCohort > 0) {
		reportRevocations(new Map([['token expired', expiredInCohort]]));
		expiredInCohort = 0;
	}
	if (expiryHeap.length > 0) armExpiryTimer(expiresAtMs(expiryHeap[0]));
}

/** Test-only: current number of tracked subscriptions. */
export function _liveSubscriptionCount(): number {
	return trackedCount;
}

/** Test-only: recheck every subscription now, after any pass already running. */
export function _sweepNow(): Promise<void> {
	pendingFull = true;
	return schedulePending();
}

/** Test-only: deliver a user-change notification as `onUserChange` would; resolves after the pass it queues. */
export function _notifyUserChange(change?: UserChange): Promise<void> {
	onUserChanged(change);
	return runPendingCoalesced();
}

/** Test-only: run the periodic tick now; resolves after the pass it queues, if any. */
export function _tickNow(): Promise<void> {
	tick();
	return runPendingCoalesced();
}
