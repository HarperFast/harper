'use strict';

const testUtils = require('../testUtils.js');
testUtils.preTestPrep();

const assert = require('node:assert');
const { AccessViolation } = require('#src/utility/errors/hdbError');
const { EventEmitter } = require('node:events');

// The module reads its interval once at import and the first register() starts a real timer; a
// background tick landing mid-test would add rechecks the test does not count on.
process.env.HARPER_SUBSCRIPTION_REAUTH_INTERVAL_MS = String(24 * 60 * 60 * 1000);

const {
	registerLiveSubscription,
	_liveSubscriptionCount,
	_sweepNow,
	_notifyUserChange,
	_tickNow,
} = require('#src/server/liveSubscriptionAuth');
const hdbLogger = require('#js/utility/logging/harper_logger');
const userModule = require('#src/security/user');
const { databases, table } = require('#src/resources/databases');
const { setMainIsWorker } = require('#src/server/threads/manageThreads');
const { RequestTarget } = require('#src/resources/RequestTarget');
const { waitFor } = require('../waitFor');

const SLICE_SIZE = 256;
const turn = () => new Promise((resolve) => setImmediate(resolve));
const change = ({ usernames = [], roleIds = [] } = {}) => ({
	usernames: new Set(usernames),
	roleIds: new Set(roleIds),
});

// `.calls` is the arg list of each invocation, in order.
function spyFn(impl) {
	function spy(...args) {
		spy.calls.push(args);
		return impl ? impl(...args) : undefined;
	}
	spy.calls = [];
	return spy;
}

// Stand-in for the SSE/WS/MQTT subscription object.
function fakeSubscription() {
	const subscription = new EventEmitter();
	subscription.end = spyFn();
	return subscription;
}

describe('liveSubscriptionAuth.ts registerLiveSubscription', () => {
	// Registry is module-level state shared by every test in this process (and by the unref'd
	// sweep timer), so every test must leave it empty — otherwise a later test, or a later test
	// file, inherits stale entries.
	const handles = [];
	function register(opts) {
		const handle = registerLiveSubscription(opts);
		handles.push(handle);
		return handle;
	}

	afterEach(() => {
		while (handles.length) handles.pop().unregister();
		assert.strictEqual(_liveSubscriptionCount(), 0, 'test left an entry in the registry');
	});

	describe('revoke absent (regression: unchanged from #1414)', () => {
		it('defaults terminate to end() on sweep-triggered revocation (expiry)', async () => {
			const subscription = fakeSubscription();
			const originalEnd = subscription.end; // registering replaces subscription.end with a wrapper
			// Sweep-triggered revocation (expired) exercises the default terminate, which calls the
			// (wrapped) end() — proving both the default terminate and the end-wrapping in one path.
			register({
				subscription,
				username: 'alice',
				authExpiresAt: 0, // 1970 — already expired
				recheck: async () => true,
			});
			handles.pop(); // sweep will remove this entry itself

			await _sweepNow();

			assert.strictEqual(originalEnd.calls.length, 1);
			assert.strictEqual(_liveSubscriptionCount(), 0);
		});

		it('logs each expected revocation at info and one aggregate warn per sweep', async () => {
			const originalInfo = hdbLogger.info;
			const originalWarn = hdbLogger.warn;
			const infoMessages = [];
			const warnMessages = [];
			hdbLogger.info = (message) => infoMessages.push(message);
			hdbLogger.warn = (message) => warnMessages.push(message);
			try {
				for (const username of ['logged-user', 'logged-user-2', 'logged-user-3']) {
					register({ subscription: fakeSubscription(), username, authExpiresAt: 0, recheck: async () => true });
					handles.pop();
				}

				await _sweepNow();

				assert.ok(
					infoMessages.some((message) => message.includes('logged-user')),
					`expected a revocation log for the default terminate path, got: ${JSON.stringify(infoMessages)}`
				);
				assert.strictEqual(
					infoMessages.filter((message) => message.includes('revoking subscription')).length,
					3,
					`expected one info line per revoked subscriber, got: ${JSON.stringify(infoMessages)}`
				);
				// the default logging level drops info, so the pass must still be visible at warn — once,
				// not once per subscriber
				assert.strictEqual(
					warnMessages.length,
					1,
					`routine expiry must warn once per sweep, got: ${JSON.stringify(warnMessages)}`
				);
				assert.ok(
					warnMessages[0].includes('revoking 3 live subscriptions') && warnMessages[0].includes('token expired: 3'),
					`the aggregate must carry the count and reasons, got: ${warnMessages[0]}`
				);
				assert.strictEqual(_liveSubscriptionCount(), 0);
			} finally {
				hdbLogger.info = originalInfo;
				hdbLogger.warn = originalWarn;
			}
		});

		it('logs a permission denial as an expected subscription revocation', async () => {
			const username = 'expected-nested-permission-denial';
			const originalInfo = hdbLogger.info;
			const originalWarn = hdbLogger.warn;
			const infoMessages = [];
			const warnMessages = [];
			hdbLogger.info = (message) => infoMessages.push(String(message));
			hdbLogger.warn = (message) => warnMessages.push(String(message));
			try {
				register({
					subscription: fakeSubscription(),
					username,
					recheck: async () => {
						throw new AccessViolation({ username });
					},
				});
				await _sweepNow();
				assert.ok(
					infoMessages.some((message) => message.includes(username) && message.includes('no longer authorized'))
				);
				assert.strictEqual(
					warnMessages.find((message) => message.includes(username)),
					undefined
				);
			} finally {
				hdbLogger.info = originalInfo;
				hdbLogger.warn = originalWarn;
			}
		});

		it('does not log an aggregate for a sweep that revokes nothing', async () => {
			const originalWarn = hdbLogger.warn;
			const warnMessages = [];
			hdbLogger.warn = (message) => warnMessages.push(message);
			try {
				register({ subscription: fakeSubscription(), username: 'stays', recheck: async () => true });

				await _sweepNow();

				assert.deepStrictEqual(warnMessages, []);
				assert.strictEqual(_liveSubscriptionCount(), 1);
			} finally {
				hdbLogger.warn = originalWarn;
			}
		});

		it('falls back to close() when end() is absent', async () => {
			const subscription = { close: spyFn() };
			register({
				subscription,
				username: 'bob',
				authExpiresAt: 0,
				recheck: async () => true,
			});
			handles.pop();

			await _sweepNow();

			assert.strictEqual(subscription.close.calls.length, 1);
			assert.strictEqual(_liveSubscriptionCount(), 0);
		});

		it("falls back to emit('close') when end() and close() are both absent", async () => {
			const subscription = new EventEmitter();
			const originalEmit = subscription.emit.bind(subscription);
			const emitCalls = [];
			subscription.emit = (...args) => {
				emitCalls.push(args);
				return originalEmit(...args);
			};
			register({
				subscription,
				username: 'carol',
				authExpiresAt: 0,
				recheck: async () => true,
			});
			handles.pop();

			await _sweepNow();

			assert.ok(emitCalls.some((args) => args[0] === 'close'));
			assert.strictEqual(_liveSubscriptionCount(), 0);
		});

		it("self-unregisters on the subscription's own 'close' event, independent of sweep", async () => {
			const subscription = fakeSubscription();
			register({ subscription, username: 'dave', recheck: async () => true });
			assert.strictEqual(_liveSubscriptionCount(), 1);

			subscription.emit('close');

			assert.strictEqual(_liveSubscriptionCount(), 0);
			handles.pop(); // already unregistered by the 'close' listener
		});

		it('calling end() invokes the original end() exactly once and unregisters first', () => {
			const subscription = fakeSubscription();
			const originalEnd = subscription.end; // registering replaces subscription.end with a wrapper
			register({ subscription, username: 'erin', recheck: async () => true });

			subscription.end('arg');

			assert.strictEqual(originalEnd.calls.length, 1);
			assert.deepStrictEqual(originalEnd.calls[0], ['arg']);
			assert.strictEqual(_liveSubscriptionCount(), 0);
			handles.pop(); // already unregistered by end()
		});
	});

	describe('revoke supplied (new seam)', () => {
		it('uses revoke as terminate instead of end()/close()/emit', async () => {
			const subscription = fakeSubscription();
			const revoke = spyFn();
			register({
				subscription,
				username: 'frank',
				authExpiresAt: 0,
				recheck: async () => true,
				revoke,
			});
			handles.pop();

			await _sweepNow();

			assert.strictEqual(revoke.calls.length, 1);
			assert.strictEqual(subscription.end.calls.length, 0, 'revoke must be used instead of end()');
			assert.strictEqual(_liveSubscriptionCount(), 0);
		});

		it('does not mutate the subscription object: end identity and listener count unchanged', () => {
			const subscription = fakeSubscription();
			const originalEnd = subscription.end;
			const listenersBefore = subscription.listenerCount('close');

			register({ subscription, username: 'grace', recheck: async () => true, revoke: spyFn() });

			assert.strictEqual(subscription.end, originalEnd, 'subscription.end must not be replaced');
			assert.strictEqual(subscription.listenerCount('close'), listenersBefore, "no 'close' listener should be added");
		});

		it('registers successfully with revoke supplied even when subscription is null/undefined/closed', async () => {
			const revokeForNull = spyFn();
			const revokeForUndefined = spyFn();
			const revokeForClosed = spyFn();
			register({
				subscription: null,
				username: 'null-sub',
				authExpiresAt: 0,
				recheck: async () => true,
				revoke: revokeForNull,
			});
			register({
				subscription: undefined,
				username: 'undefined-sub',
				authExpiresAt: 0,
				recheck: async () => true,
				revoke: revokeForUndefined,
			});
			register({
				subscription: { closed: true },
				username: 'closed-sub',
				authExpiresAt: 0,
				recheck: async () => true,
				revoke: revokeForClosed,
			});
			assert.strictEqual(
				_liveSubscriptionCount(),
				3,
				'revoke-supplied callers must not need a live subscription object'
			);

			await _sweepNow();

			assert.strictEqual(revokeForNull.calls.length, 1);
			assert.strictEqual(revokeForUndefined.calls.length, 1);
			assert.strictEqual(revokeForClosed.calls.length, 1);
			assert.strictEqual(_liveSubscriptionCount(), 0);
		});

		it('reports a revocation by another path during verify as a revocation', async () => {
			let release;
			const held = new Promise((resolve) => (release = resolve));
			const revoke = spyFn();
			const handle = register({
				username: 'verify_expires',
				authExpiresAt: Math.floor(Date.now() / 1000) + 1,
				recheck: () => held.then(() => true),
				revoke,
			});
			const outcome = handle.verify();
			await waitFor(() => revoke.calls.length === 1, { timeout: 3000, message: 'the token never expired' });
			release();

			assert.strictEqual(await outcome, 'revoked');
		});

		it('reports a registration it did not track as unverified', async () => {
			const handle = registerLiveSubscription({
				subscription: { closed: true },
				username: 'closed',
				recheck: async () => true,
			});
			assert.strictEqual(await handle.verify(), 'closed');
		});

		it('returns an unregister handle that removes only its own entry', () => {
			const subscription = fakeSubscription();
			const a = register({ subscription, username: 'a', recheck: async () => true, revoke: spyFn() });
			register({ subscription, username: 'b', recheck: async () => true, revoke: spyFn() });
			assert.strictEqual(_liveSubscriptionCount(), 2);

			a.unregister();
			handles.splice(handles.indexOf(a), 1);

			assert.strictEqual(_liveSubscriptionCount(), 1);
		});

		it('revoking one of N entries sharing one subscription object invokes only that revoke, leaves the rest registered, and never touches the shared subscription', async () => {
			const subscription = fakeSubscription();
			const originalEmit = subscription.emit.bind(subscription);
			const emitCalls = [];
			subscription.emit = (...args) => {
				emitCalls.push(args);
				return originalEmit(...args);
			};
			const revokeA = spyFn();
			const revokeB = spyFn();
			const revokeC = spyFn();
			register({ subscription, username: 'a', authExpiresAt: 0, recheck: async () => true, revoke: revokeA });
			register({ subscription, username: 'b', recheck: async () => true, revoke: revokeB });
			register({ subscription, username: 'c', recheck: async () => true, revoke: revokeC });
			assert.strictEqual(_liveSubscriptionCount(), 3);

			await _sweepNow();

			assert.strictEqual(revokeA.calls.length, 1, 'the expired subscriber should be revoked');
			assert.strictEqual(revokeB.calls.length, 0, 'other subscribers must not be revoked');
			assert.strictEqual(revokeC.calls.length, 0, 'other subscribers must not be revoked');
			assert.strictEqual(_liveSubscriptionCount(), 2, 'the other two entries must remain registered');
			assert.strictEqual(subscription.end.calls.length, 0, 'the shared subscription must not be ended');
			assert.strictEqual(emitCalls.length, 0, 'the shared subscription must not be closed');
		});

		it('a throwing recheck among several sharing one subscription revokes only that entry, at warn (fail-closed)', async () => {
			const originalWarn = hdbLogger.warn;
			const warnMessages = [];
			hdbLogger.warn = (message) => warnMessages.push(message);
			try {
				const subscription = fakeSubscription();
				const revokeThrows = spyFn();
				const revokeOkA = spyFn();
				const revokeOkB = spyFn();
				register({
					subscription,
					username: 'throws',
					recheck: async () => {
						throw new Error('recheck backend unavailable');
					},
					revoke: revokeThrows,
				});
				register({ subscription, username: 'ok-a', recheck: async () => true, revoke: revokeOkA });
				register({ subscription, username: 'ok-b', recheck: async () => true, revoke: revokeOkB });
				assert.strictEqual(_liveSubscriptionCount(), 3);

				await _sweepNow();

				assert.strictEqual(revokeThrows.calls.length, 1);
				assert.strictEqual(revokeOkA.calls.length, 0);
				assert.strictEqual(revokeOkB.calls.length, 0);
				assert.strictEqual(_liveSubscriptionCount(), 2);
				assert.strictEqual(subscription.end.calls.length, 0);
				assert.ok(
					warnMessages.some((message) => message.includes('throws') && message.includes('recheck backend unavailable')),
					`a recheck failure must still warn, got: ${JSON.stringify(warnMessages)}`
				);
			} finally {
				hdbLogger.warn = originalWarn;
			}
		});

		it('revokes on token expiry without consulting recheck', async () => {
			const subscription = fakeSubscription();
			const revoke = spyFn();
			const recheck = spyFn(() => Promise.reject(new Error('recheck must not be called for an expired token')));
			const nowSec = Math.floor(Date.now() / 1000);
			register({ subscription, username: 'expired', authExpiresAt: nowSec - 5, recheck, revoke });
			handles.pop();

			await _sweepNow();

			assert.strictEqual(recheck.calls.length, 0);
			assert.strictEqual(revoke.calls.length, 1);
			assert.strictEqual(_liveSubscriptionCount(), 0);
		});

		it('keeps a subscription registered while its token remains valid', async () => {
			const subscription = fakeSubscription();
			const revoke = spyFn();
			const recheck = spyFn(() => Promise.resolve(true));
			const nowSec = Math.floor(Date.now() / 1000);
			register({ subscription, username: 'still-valid', authExpiresAt: nowSec + 300, recheck, revoke });

			await _sweepNow();

			assert.strictEqual(recheck.calls.length, 1);
			assert.strictEqual(revoke.calls.length, 0);
			assert.strictEqual(_liveSubscriptionCount(), 1);
		});

		it('a throwing revoke is contained and does not disturb other subscribers sharing the object', async () => {
			const subscription = fakeSubscription();
			const revoke = () => {
				throw new Error('revoke failed mid-teardown (e.g. a shared-feed refcount decrement)');
			};
			const revokeOther = spyFn();
			register({
				subscription,
				username: 'throws-on-revoke',
				authExpiresAt: 0,
				recheck: async () => true,
				revoke,
			});
			handles.pop(); // sweep untracks this entry itself
			register({ subscription, username: 'other', recheck: async () => true, revoke: revokeOther });
			assert.strictEqual(_liveSubscriptionCount(), 2);

			await _sweepNow();

			assert.strictEqual(revokeOther.calls.length, 0, 'other subscribers sharing the object must not be revoked');
			assert.strictEqual(subscription.end.calls.length, 0, 'the shared subscription must not be ended');
			assert.strictEqual(_liveSubscriptionCount(), 1, 'the revoked entry is untracked; the other stays registered');
		});

		it('an async revoke that rejects is contained (no unhandled rejection) and is not retried', async () => {
			const subscription = fakeSubscription();
			let calls = 0;
			const revoke = async () => {
				calls++;
				throw new Error('shared-feed release failed (e.g. backing store timeout)');
			};
			register({
				subscription,
				username: 'async-revoke-rejects',
				authExpiresAt: 0,
				recheck: async () => true,
				revoke,
			});
			handles.pop();

			// If the rejection escaped, testUtils' unhandled-rejection handler would fail this test.
			await _sweepNow();
			await new Promise((resolveTick) => setImmediate(resolveTick)); // let the rejection settle

			assert.strictEqual(calls, 1);
			assert.strictEqual(_liveSubscriptionCount(), 0);

			await _sweepNow();

			assert.strictEqual(calls, 1, 'a rejected revoke is best effort: the registry does not retry it');
		});

		it('a never-settling revoke cannot wedge the sweep or block the entries after it', async () => {
			let hangingCalls = 0;
			const hangingRevoke = () => {
				hangingCalls++;
				return new Promise(() => {}); // never settles
			};
			const otherRevoke = spyFn();
			register({
				subscription: fakeSubscription(),
				username: 'hangs-on-revoke',
				authExpiresAt: 0,
				recheck: async () => true,
				revoke: hangingRevoke,
			});
			register({
				subscription: fakeSubscription(),
				username: 'other',
				authExpiresAt: 0,
				recheck: async () => true,
				revoke: otherRevoke,
			});
			handles.length = 0; // sweep untracks both entries itself
			assert.strictEqual(_liveSubscriptionCount(), 2);

			// Without terminate being fire-and-forget, this await would never resolve — the point of the test.
			await _sweepNow();

			assert.strictEqual(hangingCalls, 1);
			assert.strictEqual(otherRevoke.calls.length, 1, 'a hung revoke must not block later entries in the same sweep');
			assert.strictEqual(_liveSubscriptionCount(), 0);

			await _sweepNow(); // the sweep loop is not wedged; nothing is left to re-invoke

			assert.strictEqual(hangingCalls, 1);
		});

		it('does not terminate an entry the caller already unregistered while its recheck was still in flight', async () => {
			const subscription = fakeSubscription();
			const revoke = spyFn();
			let releaseRecheck;
			const recheckGate = new Promise((resolveGate) => {
				releaseRecheck = resolveGate;
			});
			const handle = register({
				subscription,
				username: 'racer',
				recheck: async () => {
					await recheckGate;
					return false; // resolves "no longer authorized" only after the caller has already torn down
				},
				revoke,
			});
			handles.pop(); // this test manages the handle itself

			const sweepPromise = _sweepNow();
			await new Promise((resolveTick) => setImmediate(resolveTick)); // let sweep reach the awaited recheck
			handle.unregister(); // the caller (e.g. a client disconnect) tears down mid-recheck
			assert.strictEqual(_liveSubscriptionCount(), 0);

			releaseRecheck();
			await sweepPromise;

			assert.strictEqual(revoke.calls.length, 0, 'revoke must not fire for an entry the caller already unregistered');
			assert.strictEqual(_liveSubscriptionCount(), 0);
		});

		it('does not recheck a snapshotted entry that unregisters before the sweep reaches it', async () => {
			let releaseFirstRecheck;
			const firstRecheckGate = new Promise((resolveGate) => {
				releaseFirstRecheck = resolveGate;
			});
			register({
				subscription: fakeSubscription(),
				username: 'first',
				recheck: async () => {
					await firstRecheckGate;
					return true;
				},
				revoke: spyFn(),
			});
			const laterRecheck = spyFn(() => Promise.resolve(true));
			const laterHandle = register({
				subscription: fakeSubscription(),
				username: 'later',
				recheck: laterRecheck,
				revoke: spyFn(),
			});

			const sweepPromise = _sweepNow();
			await new Promise((resolveTick) => setImmediate(resolveTick));
			laterHandle.unregister();
			handles.splice(handles.indexOf(laterHandle), 1);
			releaseFirstRecheck();
			await sweepPromise;

			assert.strictEqual(laterRecheck.calls.length, 0);
			assert.strictEqual(_liveSubscriptionCount(), 1);
		});
	});

	describe('targeted rechecks', () => {
		before(async () => {
			testUtils.setupTestDBPath();
			setMainIsWorker(true);
			await testUtils.ensureSystemTables();
		});

		afterEach(() => testUtils.seedUsers());

		const targetRole = (id) => ({ id, role: id, permission: { super_user: false } });

		it('rechecks only the changed user’s subscriptions after an hdb_user write', async () => {
			await testUtils.seedUsers([
				{ username: 'target_a', active: true, role: targetRole('target_role_a') },
				{ username: 'target_b', active: true, role: targetRole('target_role_b') },
			]);
			const recheckA = spyFn(async () => true);
			const recheckB = spyFn(async () => true);
			register({ username: 'target_a', recheck: recheckA, revoke: spyFn() });
			register({ username: 'target_a', recheck: recheckA, revoke: spyFn() });
			register({ username: 'target_b', recheck: recheckB, revoke: spyFn() });

			await databases.system.hdb_user.put({ username: 'target_a', active: true, role: 'target_role_a' });

			await waitFor(() => recheckA.calls.length === 2, { message: () => `A rechecks: ${recheckA.calls.length}` });
			await turn();
			assert.strictEqual(recheckB.calls.length, 0, 'a write to user A must not recheck user B');
		});

		it('rechecks only holders of the changed role after an hdb_role write', async () => {
			await testUtils.seedUsers([
				{ username: 'holder_a', active: true, role: targetRole('held_role') },
				{ username: 'holder_b', active: true, role: targetRole('held_role') },
				{ username: 'other_c', active: true, role: targetRole('other_role') },
			]);
			const recheckHolders = spyFn(async () => true);
			const recheckOther = spyFn(async () => true);
			register({ username: 'holder_a', recheck: recheckHolders, revoke: spyFn() });
			register({ username: 'holder_b', recheck: recheckHolders, revoke: spyFn() });
			register({ username: 'other_c', recheck: recheckOther, revoke: spyFn() });

			await databases.system.hdb_role.put(targetRole('held_role'));

			await waitFor(() => recheckHolders.calls.length === 2, {
				message: () => `holder rechecks: ${recheckHolders.calls.length}`,
			});
			await turn();
			assert.strictEqual(recheckOther.calls.length, 0, 'a role change must not recheck users without that role');
		});

		it('follows a role reassignment: the new role targets the user, the old one no longer does', async () => {
			await testUtils.seedUsers([
				{ username: 'mover', active: true, role: targetRole('old_role') },
				{ username: 'new_role_anchor', active: true, role: targetRole('new_role') },
			]);
			const recheck = spyFn(async () => true);
			register({ username: 'mover', recheck, revoke: spyFn() });

			await databases.system.hdb_user.put({ username: 'mover', active: true, role: 'new_role' });
			await waitFor(() => recheck.calls.length === 1, { message: 'the reassignment rechecks the user' });

			await _notifyUserChange(change({ roleIds: ['old_role'] }));
			assert.strictEqual(recheck.calls.length, 1, 'the old role no longer targets the user');
			await _notifyUserChange(change({ roleIds: ['new_role'] }));
			assert.strictEqual(recheck.calls.length, 2, 'the new role targets the user');
		});

		it('re-indexes a role reassigned while a pass is under way', async () => {
			await testUtils.seedUsers([
				{ username: 'mid_mover', active: true, role: targetRole('mid_old') },
				{ username: 'mid_anchor', active: true, role: targetRole('mid_new') },
			]);
			let rechecks = 0;
			let moved;
			const recheck = async () => {
				if (++rechecks === SLICE_SIZE) {
					moved = databases.system.hdb_user.put({ username: 'mid_mover', active: true, role: 'mid_new' });
				}
				return true;
			};
			const entries = SLICE_SIZE * 2;
			for (let index = 0; index < entries; index++) register({ username: 'mid_mover', recheck, revoke: spyFn() });

			await _sweepNow();
			await moved;
			await waitFor(() => rechecks >= entries * 2, { message: () => `rechecks after the move: ${rechecks}` });
			await turn();
			const settled = rechecks;
			await _notifyUserChange(change({ roleIds: ['mid_old'] }));
			assert.strictEqual(rechecks, settled, 'the old role no longer targets the user');
			await _notifyUserChange(change({ roleIds: ['mid_new'] }));
			assert.strictEqual(rechecks, settled + entries, 'the new role targets every entry of the user');
		});

		it('rechecks every subscription for a change whose identity is unknown', async () => {
			const recheckA = spyFn(async () => true);
			const recheckB = spyFn(async () => true);
			register({ username: 'unknown_a', recheck: recheckA, revoke: spyFn() });
			register({ username: 'unknown_b', recheck: recheckB, revoke: spyFn() });

			await _notifyUserChange(undefined);

			assert.strictEqual(recheckA.calls.length, 1);
			assert.strictEqual(recheckB.calls.length, 1);
		});

		it('falls back to a full pass once pending identities exceed the bound', async () => {
			const recheck = spyFn(async () => true);
			const usernames = [];
			for (let index = 0; index <= 1000; index++) {
				usernames.push(`bulk_${index}`);
				register({ username: `bulk_${index}`, recheck, revoke: spyFn() });
			}
			const outsider = spyFn(async () => true);
			register({ username: 'bulk_outsider', recheck: outsider, revoke: spyFn() });

			await _notifyUserChange(change({ usernames }));

			assert.strictEqual(outsider.calls.length, 1, 'an oversized change set rechecks everything');
		});

		it('rechecks a user whose role could not be read on any role change', async () => {
			const original = userModule.userRecordVersions;
			userModule.userRecordVersions = () => {
				throw new Error('system store closing');
			};
			const recheck = spyFn(async () => true);
			try {
				register({ username: 'unreadable_role', recheck, revoke: spyFn() });
			} finally {
				userModule.userRecordVersions = original;
			}

			await _notifyUserChange(change({ roleIds: ['some_other_role'] }));

			assert.strictEqual(recheck.calls.length, 1);
		});

		it('rechecks a policy entry once when a user change and a tick share a pass', async () => {
			const originalEpoch = userModule.userChangeNotificationEpoch;
			userModule.userChangeNotificationEpoch = () => 5;
			try {
				const recheck = spyFn(async () => true);
				register({ username: 'dedupe_policy', recheck, revoke: spyFn() });
				await _sweepNow();

				await Promise.all([_notifyUserChange(change({ usernames: ['dedupe_policy'] })), _tickNow()]);

				assert.strictEqual(recheck.calls.length, 2, 'once for the sweep, once for the shared pass');
			} finally {
				userModule.userChangeNotificationEpoch = originalEpoch;
			}
		});

		it('ignores a change to an identity no subscription holds', async () => {
			const recheck = spyFn(async () => true);
			register({ username: 'bystander', recheck, revoke: spyFn() });

			await _notifyUserChange(change({ usernames: ['nobody_subscribed'], roleIds: ['no_holders'] }));

			assert.strictEqual(recheck.calls.length, 0);
		});
	});

	describe('periodic tick', () => {
		let epoch;
		const originalEpoch = userModule.userChangeNotificationEpoch;
		beforeEach(() => {
			userModule.userChangeNotificationEpoch = () => epoch;
		});
		afterEach(() => {
			userModule.userChangeNotificationEpoch = originalEpoch;
		});

		it('rechecks only policy entries while delivery since the last full pass is certified', async () => {
			const identity = spyFn(async () => true);
			const policy = spyFn(async () => true);
			register({ username: 'tick_identity', identityOnly: true, recheck: identity, revoke: spyFn() });
			register({ username: 'tick_policy', recheck: policy, revoke: spyFn() });
			epoch = 7;
			await _sweepNow();
			assert.strictEqual(identity.calls.length, 1);

			await _tickNow();

			assert.strictEqual(policy.calls.length, 2, 'a policy entry is rechecked on every tick');
			assert.strictEqual(identity.calls.length, 1, 'an identity-only entry waits for the backstop');
		});

		it('rechecks everything when delivery is not certified, or was interrupted since the last full pass', async () => {
			const identity = spyFn(async () => true);
			register({ username: 'tick_uncertified', identityOnly: true, recheck: identity, revoke: spyFn() });
			epoch = 3;
			await _sweepNow();

			epoch = 0;
			await _tickNow();
			assert.strictEqual(identity.calls.length, 2, 'uncertified delivery: full pass');

			epoch = 4;
			await _tickNow();
			assert.strictEqual(identity.calls.length, 3, 'a new epoch since the last full pass: full pass');

			await _tickNow();
			assert.strictEqual(identity.calls.length, 3, 'the same epoch as that full pass: no full pass');
		});

		it('rechecks everything once the backstop interval has passed since the last full pass', async () => {
			const identity = spyFn(async () => true);
			register({ username: 'tick_backstop', identityOnly: true, recheck: identity, revoke: spyFn() });
			epoch = 9;
			await _sweepNow();
			const originalNow = Date.now;
			Date.now = () => originalNow() + 25 * 60 * 60 * 1000;
			try {
				await _tickNow();
			} finally {
				Date.now = originalNow;
			}
			assert.strictEqual(identity.calls.length, 2);
		});
	});

	describe('time slicing', () => {
		it('yields to the event loop during a pass', async () => {
			let rechecks = 0;
			const recheck = async () => {
				rechecks++;
				return true;
			};
			for (let index = 0; index < SLICE_SIZE * 3; index++)
				register({ username: `slice_${index % 7}`, recheck, revoke: spyFn() });
			let seenMidPass;
			setImmediate(() => (seenMidPass = rechecks));

			await _sweepNow();

			assert.ok(seenMidPass > 0 && seenMidPass < SLICE_SIZE * 3, `a turn ran mid-pass after ${seenMidPass} rechecks`);
			assert.strictEqual(rechecks, SLICE_SIZE * 3);
		});
	});

	describe('token expiry', () => {
		const nowSeconds = () => Math.floor(Date.now() / 1000);

		it('terminates at the token’s exp without a sweep', async () => {
			const recheck = spyFn(async () => true);
			const revoke = spyFn();
			register({ username: 'expires_soon', authExpiresAt: nowSeconds() + 1, recheck, revoke });
			handles.pop();

			await waitFor(() => revoke.calls.length === 1, { timeout: 3000, message: 'expiry did not terminate' });

			assert.strictEqual(recheck.calls.length, 0, 'expiry needs no recheck');
			assert.strictEqual(_liveSubscriptionCount(), 0);
		});

		it('does not fire early for an exp beyond the setTimeout range', async () => {
			const warnings = [];
			const onWarning = (warning) => warnings.push(warning.name);
			process.on('warning', onWarning);
			const originalSetTimeout = global.setTimeout;
			const delays = [];
			global.setTimeout = function (callback, delay, ...args) {
				delays.push(delay);
				return originalSetTimeout(callback, delay, ...args);
			};
			try {
				const revoke = spyFn();
				register({
					username: 'long_lived',
					authExpiresAt: nowSeconds() + 30 * 24 * 60 * 60,
					recheck: async () => true,
					revoke,
				});
				for (let index = 0; index < 5; index++) await new Promise((resolve) => originalSetTimeout(resolve, 5));

				assert.strictEqual(revoke.calls.length, 0);
				assert.strictEqual(_liveSubscriptionCount(), 1);
				assert.ok(delays.length > 0 && delays.every((delay) => delay <= 2 ** 31 - 1), `armed delays: ${delays}`);
				assert.ok(!warnings.includes('TimeoutOverflowWarning'));
			} finally {
				global.setTimeout = originalSetTimeout;
				process.off('warning', onWarning);
			}
		});

		it('re-arms for an earlier exp and skips removed entries, at the root or below it', async () => {
			const late = spyFn();
			const removedRoot = spyFn();
			const removedInner = spyFn();
			const early = spyFn();
			register({ username: 'heap_late', authExpiresAt: nowSeconds() + 3600, recheck: async () => true, revoke: late });
			const rootHandle = register({
				username: 'heap_root',
				authExpiresAt: nowSeconds() + 1,
				recheck: async () => true,
				revoke: removedRoot,
			});
			const innerHandle = register({
				username: 'heap_inner',
				authExpiresAt: nowSeconds() + 2,
				recheck: async () => true,
				revoke: removedInner,
			});
			register({ username: 'heap_early', authExpiresAt: nowSeconds() + 1, recheck: async () => true, revoke: early });
			rootHandle.unregister();
			innerHandle.unregister();

			await waitFor(() => early.calls.length === 1, { timeout: 3000, message: 'the earlier exp re-armed the timer' });
			await new Promise((resolve) => setTimeout(resolve, 1100));

			assert.strictEqual(removedRoot.calls.length, 0);
			assert.strictEqual(removedInner.calls.length, 0);
			assert.strictEqual(late.calls.length, 0);
			assert.strictEqual(_liveSubscriptionCount(), 1, 'only the late entry is still tracked');
		});

		it('terminates a cohort sharing one exp in slices, with one aggregate warn', async () => {
			const originalWarn = hdbLogger.warn;
			const originalInfo = hdbLogger.info;
			const warnMessages = [];
			hdbLogger.warn = (message) => warnMessages.push(message);
			hdbLogger.info = () => {};
			try {
				let revoked = 0;
				const revoke = () => revoked++;
				const cohort = SLICE_SIZE * 3;
				for (let index = 0; index < cohort; index++) {
					register({ username: `cohort_${index}`, authExpiresAt: 1, recheck: async () => true, revoke });
				}
				const perTurn = [];
				let last = 0;
				const deadline = Date.now() + 5000;
				while (revoked < cohort) {
					assert.ok(Date.now() < deadline, `expiry stalled after ${revoked} of ${cohort}`);
					await turn();
					perTurn.push(revoked - last);
					last = revoked;
				}

				assert.ok(Math.max(...perTurn) <= SLICE_SIZE, `terminations per turn: ${perTurn.filter(Boolean)}`);
				assert.deepStrictEqual(warnMessages, [
					`liveSubscriptionAuth: revoking ${cohort} live subscriptions (token expired: ${cohort})`,
				]);
			} finally {
				hdbLogger.warn = originalWarn;
				hdbLogger.info = originalInfo;
			}
		});

		it('expires other entries on time beside an entry with a non-finite exp', async () => {
			const healthy = spyFn();
			register({ username: 'finite_exp', authExpiresAt: nowSeconds() + 1, recheck: async () => true, revoke: healthy });
			register({ username: 'nan_exp', authExpiresAt: NaN, recheck: async () => true, revoke: spyFn() });

			await waitFor(() => healthy.calls.length === 1, { timeout: 3000, message: 'the NaN entry blocked expiry' });
			assert.strictEqual(_liveSubscriptionCount(), 1, 'a non-finite exp does not expire');
		});

		it('contains throwing, rejecting and never-settling teardown on the expiry path', async () => {
			const settled = spyFn();
			register({
				username: 'expiry_throws',
				authExpiresAt: 1,
				recheck: async () => true,
				revoke: () => {
					throw new Error('revoke threw');
				},
			});
			register({
				username: 'expiry_rejects',
				authExpiresAt: 1,
				recheck: async () => true,
				revoke: async () => {
					throw new Error('revoke rejected');
				},
			});
			register({
				username: 'expiry_hangs',
				authExpiresAt: 1,
				recheck: async () => true,
				revoke: () => new Promise(() => {}),
			});
			register({ username: 'expiry_settles', authExpiresAt: 1, recheck: async () => true, revoke: settled });

			await waitFor(() => _liveSubscriptionCount() === 0, {
				message: 'the expiry batch stopped at a failing teardown',
			});
			await turn();

			assert.strictEqual(settled.calls.length, 1);
		});

		it('keeps expiring while a recheck is held', async () => {
			let release;
			const held = new Promise((resolve) => (release = resolve));
			register({ username: 'held_recheck', recheck: () => held.then(() => true), revoke: spyFn() });
			const revoke = spyFn();
			register({ username: 'expires_during_hold', authExpiresAt: nowSeconds() + 1, recheck: async () => true, revoke });
			handles.pop();
			const pass = _sweepNow();
			try {
				await waitFor(() => revoke.calls.length === 1, {
					timeout: 3000,
					message: 'expiry waited for the held recheck',
				});
			} finally {
				release();
				await pass;
			}
		});
	});

	describe('Resource subscriptions', () => {
		let Docs;
		let Overridden;
		let overriddenReads = 0;

		before(async () => {
			testUtils.setupTestDBPath();
			setMainIsWorker(true);
			await testUtils.ensureSystemTables();
			const Parents = table({
				table: 'ReauthParents',
				database: 'test',
				attributes: [{ name: 'id', isPrimaryKey: true }, { name: 'value' }],
			});
			const Table = table({
				table: 'ReauthDocs',
				database: 'test',
				attributes: [
					{ name: 'id', isPrimaryKey: true },
					{ name: 'value' },
					{ name: 'parentId' },
					{ name: 'parent', relationship: { from: 'parentId' }, definition: { tableClass: Parents } },
				],
			});
			Docs = class extends Table {
				subscribe() {
					return fakeSubscription();
				}
			};
			Overridden = class extends Docs {
				allowRead() {
					overriddenReads++;
					return true;
				}
			};
		});

		afterEach(() => testUtils.seedUsers());

		const readRole = (id) => ({
			id,
			role: id,
			permission: {
				super_user: false,
				test: {
					tables: {
						ReauthDocs: { read: true, insert: false, update: false, delete: false, attribute_permissions: [] },
					},
				},
			},
		});
		const resolve = (username) => userModule.findAndValidateUser(username, undefined, false);

		async function subscribe(Resource, user) {
			const context = { user, authorize: true };
			const subscription = await Resource.subscribe('topic', undefined, context);
			handles.push({ unregister: () => subscription.end() });
			return { context, subscription };
		}

		function countResolutions() {
			const counter = { calls: [] };
			const original = userModule.findAndValidateUser;
			userModule.findAndValidateUser = function (...args) {
				counter.calls.push(args[0]);
				return original.apply(this, args);
			};
			counter.restore = () => (userModule.findAndValidateUser = original);
			return counter;
		}

		it('resolves each username once per pass and gives every context its own user view', async () => {
			await testUtils.seedUsers([
				{ username: 'grouped_a', active: true, role: readRole('grouped_role') },
				{ username: 'grouped_b', active: true, role: readRole('grouped_role') },
			]);
			const userA = await resolve('grouped_a');
			const userB = await resolve('grouped_b');
			const subscriptions = [];
			for (const user of [userA, userA, userA, userB, userB]) subscriptions.push(await subscribe(Docs, user));
			const resolutions = countResolutions();
			try {
				await _sweepNow();
			} finally {
				resolutions.restore();
			}

			assert.deepStrictEqual(resolutions.calls.sort(), ['grouped_a', 'grouped_b']);
			assert.strictEqual(_liveSubscriptionCount(), 5);
			const [first, second] = subscriptions.map(({ context }) => context.user);
			assert.notStrictEqual(first, second);
			assert.notStrictEqual(first.role, second.role);
			assert.notStrictEqual(first.role.permission, second.role.permission);
			first.role.permission = { super_user: false };
			assert.ok(second.role.permission.test.tables.ReauthDocs.read);
			await _sweepNow();
			assert.strictEqual(_liveSubscriptionCount(), 5);
		});

		it('evaluates an overridden allowRead per subscription, on every tick', async () => {
			await testUtils.seedUsers([{ username: 'override_user', active: true, role: readRole('override_role') }]);
			const user = await resolve('override_user');
			await subscribe(Overridden, user);
			await subscribe(Overridden, user);
			await subscribe(Docs, user);
			const originalEpoch = userModule.userChangeNotificationEpoch;
			userModule.userChangeNotificationEpoch = () => 11;
			try {
				await _sweepNow();
				overriddenReads = 0;
				const resolutions = countResolutions();
				try {
					await _tickNow();
				} finally {
					resolutions.restore();
				}
				assert.strictEqual(overriddenReads, 2, 'each overridden subscription is evaluated on the tick');
				assert.deepStrictEqual(resolutions.calls, ['override_user']);
			} finally {
				userModule.userChangeNotificationEpoch = originalEpoch;
			}
		});

		it('keeps an authorization-narrowed target on the identity-only cadence, but not a caller’s select', async () => {
			const attributeRole = readRole('attribute_role');
			attributeRole.permission.test.tables.ReauthDocs.attribute_permissions = [
				{ attribute_name: 'id', read: true, insert: false, update: false },
				{ attribute_name: 'value', read: false, insert: false, update: false },
			];
			await testUtils.seedUsers([{ username: 'attribute_user', active: true, role: attributeRole }]);
			const user = await resolve('attribute_user');
			const { context: narrowed } = await subscribe(Docs, user);
			const selected = { user, authorize: true };
			const target = new RequestTarget('/topic');
			target.id = 'topic';
			target.select = ['id'];
			const selectedSubscription = await Docs.subscribe(target, undefined, selected);
			handles.push({ unregister: () => selectedSubscription.end() });
			const originalEpoch = userModule.userChangeNotificationEpoch;
			userModule.userChangeNotificationEpoch = () => 13;
			try {
				await _sweepNow();
				const narrowedUser = narrowed.user;
				const selectedUser = selected.user;

				await _tickNow();

				assert.strictEqual(narrowed.user, narrowedUser, 'a select written by authorization stays identity-only');
				assert.notStrictEqual(selected.user, selectedUser, 'a caller’s select is rechecked on every tick');
			} finally {
				userModule.userChangeNotificationEpoch = originalEpoch;
			}
		});

		it('rechecks a subscription filtered through a relationship on every tick, but not a scalar filter', async () => {
			const role = readRole('filter_role');
			role.permission.test.tables.ReauthParents = role.permission.test.tables.ReauthDocs;
			await testUtils.seedUsers([{ username: 'filter_user', active: true, role }]);
			const user = await resolve('filter_user');
			let originalEnd;
			class Tracked extends Docs {
				subscribe() {
					const subscription = super.subscribe();
					originalEnd = subscription.end;
					return subscription;
				}
			}
			async function subscribeWhere(attribute) {
				const context = { user, authorize: true };
				const target = new RequestTarget('/topic');
				target.id = 'topic';
				target.conditions = [{ attribute, value: 'x' }];
				const subscription = await Tracked.subscribe(target, undefined, context);
				handles.push({ unregister: () => subscription.end() });
				context.end = originalEnd;
				return context;
			}
			const scalar = await subscribeWhere('value');
			const related = await subscribeWhere(['parent', 'value']);
			const originalEpoch = userModule.userChangeNotificationEpoch;
			userModule.userChangeNotificationEpoch = () => 13;
			try {
				await _sweepNow();
				const scalarUser = scalar.user;
				const relatedUser = related.user;

				await _tickNow();

				assert.strictEqual(scalar.user, scalarUser, 'a scalar filter stays identity-only');
				assert.notStrictEqual(related.user, relatedUser, 'a filter through a relationship is rechecked');

				delete role.permission.test.tables.ReauthParents;
				await testUtils.seedUsers([{ username: 'filter_user', active: true, role }]);
				await _sweepNow();
				assert.strictEqual(related.end.calls.length, 1, 'losing the related table ends it');
				assert.strictEqual(scalar.end.calls.length, 0, 'a scalar filter keeps its subscription');
			} finally {
				userModule.userChangeNotificationEpoch = originalEpoch;
			}
		});

		it('rechecks a principal with no record provenance on every tick', async () => {
			await testUtils.seedUsers([{ username: 'component_user', active: true, role: readRole('component_role') }]);
			const resolved = await resolve('component_user');
			// as a component's server.getUser might build it: no record provenance
			const componentUser = { username: 'component_user', active: true, role: { ...resolved.role } };
			const { context } = await subscribe(Docs, componentUser);
			const originalEpoch = userModule.userChangeNotificationEpoch;
			userModule.userChangeNotificationEpoch = () => 17;
			try {
				await _sweepNow();
				const afterSweep = context.user;
				await _tickNow();
				assert.notStrictEqual(context.user, afterSweep, 'the tick rechecked it');
			} finally {
				userModule.userChangeNotificationEpoch = originalEpoch;
			}
		});

		function resolvedByComponent(username, build) {
			const versions = userModule.userRecordVersions(username);
			const user = build();
			userModule.trackUserRecords(user, versions);
			return user;
		}

		it('keeps a principal built with no hdb_user record, rechecking it with its allowRead alone', async () => {
			let allowed = true;
			let reads = 0;
			class Gated extends Docs {
				allowRead() {
					reads++;
					return allowed;
				}
			}
			const user = resolvedByComponent('component_only', () => ({
				username: 'component_only',
				active: true,
				role: readRole('component_only_role'),
			}));
			const { context } = await subscribe(Gated, user);
			reads = 0;
			const resolutions = countResolutions();
			try {
				await _sweepNow();
				await _tickNow();
			} finally {
				resolutions.restore();
			}
			assert.strictEqual(_liveSubscriptionCount(), 1);
			assert.deepStrictEqual(resolutions.calls, [], 'never re-resolved by name');
			assert.strictEqual(context.user, user, 'the admitted principal is kept');
			assert.strictEqual(reads, 2, 'each pass ran its allowRead');

			allowed = false;
			await _tickNow();
			assert.strictEqual(_liveSubscriptionCount(), 0, 'its allowRead still revokes it');
		});

		const unrelatedRecord = (username) => ({
			username,
			active: true,
			role: { id: `${username}_other`, role: `${username}_other`, permission: { super_user: false } },
		});

		it('keeps a principal built with no hdb_user record when a record takes its name', async () => {
			const before = resolvedByComponent('component_named', () => ({
				username: 'component_named',
				active: true,
				role: readRole('component_named_role'),
			}));
			const first = await subscribe(Docs, before);
			await testUtils.seedUsers([unrelatedRecord('component_named')]);
			const second = await subscribe(Docs, before);
			await _sweepNow();
			assert.strictEqual(_liveSubscriptionCount(), 2, 'an unrelated record does not stand in for it');
			assert.strictEqual(first.context.user, before);
			assert.strictEqual(second.context.user, before);
		});

		it('keeps the principal a Basic login through a component’s server.getUser built with no record', async () => {
			const { authentication } = require('#src/security/auth');
			const { Headers } = require('#src/server/serverHelpers/Headers');
			const { server } = require('#src/server/Server');
			const getUser = server.getUser;
			server.getUser = async (username) => ({ username, active: true, role: readRole('component_basic_role') });
			try {
				let user;
				const authorization = 'Basic ' + Buffer.from('component_basic:a-token').toString('base64');
				await authentication(
					{ headers: { asObject: { authorization, host: 'localhost' } }, method: 'GET', pathname: '/', ip: '10.0.0.1' },
					async (request) => {
						user = request.user;
						return { status: 200, headers: new Headers(), body: {} };
					}
				);
				const { context } = await subscribe(Docs, user);
				await testUtils.seedUsers([unrelatedRecord('component_basic')]);
				await _sweepNow();
				assert.strictEqual(_liveSubscriptionCount(), 1);
				assert.strictEqual(context.user, user);
			} finally {
				server.getUser = getUser;
			}
		});

		it('rechecks by name a principal whose name gained a record while it resolved', async () => {
			const versions = userModule.userRecordVersions('component_raced');
			await testUtils.seedUsers([unrelatedRecord('component_raced')]);
			const user = { username: 'component_raced', active: true, role: readRole('component_raced_role') };
			userModule.trackUserRecords(user, versions);
			await assert.rejects(subscribe(Docs, user), { statusCode: 403 });
			assert.strictEqual(_liveSubscriptionCount(), 0);
		});

		it('ends a recordless principal’s subscription at its authExpiresAt', async () => {
			const user = resolvedByComponent('component_expiring', () => ({
				username: 'component_expiring',
				active: true,
				role: readRole('component_expiring_role'),
				authExpiresAt: Date.now() / 1000 + 0.5,
			}));
			await subscribe(Docs, user);
			assert.strictEqual(_liveSubscriptionCount(), 1);
			await waitFor(() => _liveSubscriptionCount() === 0, { message: 'the subscription outlived its expiry' });
		});

		it('re-resolves a record-backed user a component returned, in place or as a tracked copy', async () => {
			await testUtils.seedUsers([
				{ username: 'returned_user', active: true, role: readRole('returned_role') },
				{ username: 'copied_user', active: true, role: readRole('copied_role') },
			]);
			const returned = await resolve('returned_user');
			returned.client_id = 'returned_user';
			const copied = resolvedByComponent('copied_user', () =>
				structuredClone(userModule.getUserWithRole('copied_user'))
			);
			assert.strictEqual(userModule.hasRecordProvenance(copied), true);
			await subscribe(Docs, returned);
			await subscribe(Docs, copied);

			await databases.system.hdb_user.delete('returned_user');
			await databases.system.hdb_user.delete('copied_user');
			await _sweepNow();

			assert.strictEqual(_liveSubscriptionCount(), 0, 'both are revoked once their records are gone');
		});

		function grantingByUsername(username) {
			const gate = { grant: true, end: undefined };
			gate.Resource = class extends Docs {
				subscribe() {
					const subscription = super.subscribe();
					gate.end = subscription.end;
					return subscription;
				}
				allowRead(principal) {
					return gate.grant && principal?.username === username;
				}
			};
			return gate;
		}
		const certificate = async (username) => userModule.certificatePrincipal(await resolve(username));

		it('keeps a certificate principal with no hdb_user while the allowRead that admitted it still grants it', async () => {
			const user = await certificate('cert_only_cn');
			assert.strictEqual(user.role, undefined);
			const gate = grantingByUsername('cert_only_cn');
			const { context } = await subscribe(gate.Resource, user);

			await _sweepNow();
			await _tickNow();

			assert.strictEqual(gate.end.calls.length, 0, 'a recheck revoked what admission granted');
			assert.strictEqual(_liveSubscriptionCount(), 1);
			assert.strictEqual(context.user.username, 'cert_only_cn');

			gate.grant = false;
			await _sweepNow();
			assert.strictEqual(gate.end.calls.length, 1, 'revoked once its allowRead denies it');
		});

		it('still revokes a principal admitted with a role once its hdb_user is dropped', async () => {
			await testUtils.seedUsers([{ username: 'dropped_cn', active: true, role: readRole('dropped_role') }]);
			const user = await resolve('dropped_cn');
			const gate = grantingByUsername('dropped_cn');
			await subscribe(gate.Resource, user);
			await _sweepNow();
			assert.strictEqual(gate.end.calls.length, 0);

			await testUtils.seedUsers();
			await _sweepNow();

			assert.strictEqual(gate.end.calls.length, 1, 'losing the role it was admitted with revokes it');
		});

		it('still requires a role of a certificate principal built from an hdb_user record', async () => {
			await testUtils.seedUsers([{ username: 'roleless_record', active: true, role: 'missing_role' }]);
			const user = await certificate('roleless_record');
			assert.strictEqual(user.role, undefined);
			const gate = grantingByUsername('roleless_record');
			await subscribe(gate.Resource, user);

			await _sweepNow();

			assert.strictEqual(gate.end.calls.length, 1, 'a record behind the certificate requires a role');
		});

		it('requires a role once an hdb_user record appears for a certificate principal admitted without one', async () => {
			const roleless = grantingByUsername('late_record_cn');
			await subscribe(roleless.Resource, await certificate('late_record_cn'));
			await testUtils.seedUsers([{ username: 'late_record_cn', active: true, role: 'missing_role' }]);
			await _sweepNow();
			assert.strictEqual(roleless.end.calls.length, 1, 'a record with no role revokes it');

			await testUtils.seedUsers();
			const dropped = grantingByUsername('late_record_cn');
			await subscribe(dropped.Resource, await certificate('late_record_cn'));
			await testUtils.seedUsers([{ username: 'late_record_cn', active: true, role: readRole('late_record_role') }]);
			await _sweepNow();
			assert.strictEqual(dropped.end.calls.length, 0, 'a record with a role keeps it');
			await testUtils.seedUsers();
			await _sweepNow();
			assert.strictEqual(dropped.end.calls.length, 1, 'dropping that record revokes it');
		});

		it('rechecks a certificate principal with no role against an object checkPermission, as MQTT admission passes', async () => {
			const user = await certificate('cert_permission_cn');
			const seen = [];
			const Recorded = class extends Docs {
				allowRead(principal, target) {
					seen.push(target?.checkPermission);
					return principal?.username === 'cert_permission_cn';
				}
			};
			await subscribe(Recorded, user);
			seen.length = 0;

			await _sweepNow();

			assert.strictEqual(_liveSubscriptionCount(), 1);
			assert.ok(seen.length > 0, 'the sweep rechecked it');
			for (const permission of seen) assert.ok(permission && typeof permission === 'object');
		});

		it('revokes a principal with no hdb_user that no certificate named', async () => {
			const user = await resolve('no_record_user');
			assert.strictEqual(userModule.isRecordBacked(user), false);
			const gate = grantingByUsername('no_record_user');
			await subscribe(gate.Resource, user);

			await _sweepNow();

			assert.strictEqual(gate.end.calls.length, 1, 'a missing record alone does not exempt it from the role');
		});

		it('requires the role a certificate principal arrived with, even with no hdb_user', async () => {
			const user = userModule.certificatePrincipal({
				...(await resolve('cert_role_cn')),
				role: readRole('cert_role_role'),
			});
			const gate = grantingByUsername('cert_role_cn');
			await subscribe(gate.Resource, user);

			await _sweepNow();

			assert.strictEqual(gate.end.calls.length, 1, 'the recheck resolved it with no role');
		});

		it('keeps the certificate mark on the view a recheck installs, for a later subscription on that context', async () => {
			const gate = grantingByUsername('cert_context_cn');
			const context = { user: await certificate('cert_context_cn'), authorize: true };
			const first = await gate.Resource.subscribe('topic', undefined, context);
			handles.push({ unregister: () => first.end() });
			await _sweepNow();
			assert.strictEqual(userModule.isCertificatePrincipal(context.user), true);

			const second = await gate.Resource.subscribe('topic', undefined, context);
			handles.push({ unregister: () => second.end() });
			await _sweepNow();

			assert.strictEqual(gate.end.calls.length, 0, 'a recheck revoked a subscription the same certificate admitted');
		});

		it('revokes a principal with no record provenance and no role unless a certificate named it', async () => {
			const unnamed = grantingByUsername('component_roleless');
			await subscribe(unnamed.Resource, { username: 'component_roleless' });
			const named = grantingByUsername('component_roleless');
			await subscribe(named.Resource, userModule.certificatePrincipal({ username: 'component_roleless' }));

			await _sweepNow();

			assert.strictEqual(unnamed.end.calls.length, 1, 'no certificate named it');
			assert.strictEqual(named.end.calls.length, 0, 'a certificate named it');
		});

		it('requires a role of a later subscription on a context where a record backed the certificate principal', async () => {
			const context = { user: await certificate('context_latch_cn'), authorize: true };
			const first = grantingByUsername('context_latch_cn');
			const firstSubscription = await first.Resource.subscribe('topic', undefined, context);
			handles.push({ unregister: () => firstSubscription.end() });
			await testUtils.seedUsers([{ username: 'context_latch_cn', active: true, role: 'missing_role' }]);
			await _sweepNow();
			assert.strictEqual(first.end.calls.length, 1, 'a record with no role revokes it');

			await testUtils.seedUsers();
			const later = grantingByUsername('context_latch_cn');
			await assert.rejects(later.Resource.subscribe('topic', undefined, context), { statusCode: 403 });
			assert.strictEqual(_liveSubscriptionCount(), 0, 'a later subscription on that context needs a role too');
		});

		it('requires a role of a later SUBSCRIBE that reuses the principal a record backed, as an MQTT session does', async () => {
			const user = await certificate('session_latch_cn');
			const first = grantingByUsername('session_latch_cn');
			const firstSubscription = await first.Resource.subscribe('topic', undefined, { user, authorize: true });
			handles.push({ unregister: () => firstSubscription.end() });
			await testUtils.seedUsers([{ username: 'session_latch_cn', active: true, role: 'missing_role' }]);
			await _sweepNow();
			assert.strictEqual(first.end.calls.length, 1, 'a record with no role revokes it');

			await testUtils.seedUsers();
			const later = grantingByUsername('session_latch_cn');
			await assert.rejects(later.Resource.subscribe('topic', undefined, { user, authorize: true }), {
				statusCode: 403,
			});
			assert.strictEqual(
				_liveSubscriptionCount(),
				0,
				'a later SUBSCRIBE with that principal needs a role, before it delivers'
			);
		});

		it('requires a role of an earlier subscription once another subscription on its context latched it', async () => {
			await testUtils.seedUsers([{ username: 'latch_source', active: true, role: 'missing_role' }]);
			const source = await resolve('latch_source');
			const context = { user: await certificate('shared_latch_cn'), authorize: true };
			const earlier = grantingByUsername('shared_latch_cn');
			const earlierSubscription = await earlier.Resource.subscribe('topic', undefined, context);
			handles.push({ unregister: () => earlierSubscription.end() });

			// A later subscription on the context, by a principal whose records changed, is rechecked alone at
			// registration, and finds a record for the name that no notification has brought to the earlier one.
			const unbacked = await resolve('latch_stale');
			context.user = userModule.certificatePrincipal({ ...unbacked, username: 'shared_latch_cn' });
			await databases.system.hdb_user.put({ username: 'latch_stale', active: true, role: 'missing_role' });
			const findAndValidateUser = userModule.findAndValidateUser;
			userModule.findAndValidateUser = (name, ...rest) =>
				name === 'shared_latch_cn'
					? Promise.resolve({ ...source, username: name })
					: findAndValidateUser(name, ...rest);
			try {
				const later = grantingByUsername('shared_latch_cn');
				await assert.rejects(later.Resource.subscribe('topic', undefined, context), { statusCode: 403 });
				assert.strictEqual(earlier.end.calls.length, 0, 'not rechecked yet');
			} finally {
				userModule.findAndValidateUser = findAndValidateUser;
			}
			await _sweepNow();
			assert.strictEqual(
				earlier.end.calls.length,
				1,
				'the earlier subscription needs a role too, though no record remains'
			);
		});

		it('requires a role of a later SUBSCRIBE once an inactive record appeared for its principal', async () => {
			const user = await certificate('inactive_latch_cn');
			const first = grantingByUsername('inactive_latch_cn');
			const firstSubscription = await first.Resource.subscribe('topic', undefined, { user, authorize: true });
			handles.push({ unregister: () => firstSubscription.end() });
			await testUtils.seedUsers([{ username: 'inactive_latch_cn', active: false, role: 'missing_role' }]);
			await _sweepNow();
			assert.strictEqual(first.end.calls.length, 1, 'an inactive record revokes it');

			await testUtils.seedUsers();
			const later = grantingByUsername('inactive_latch_cn');
			await assert.rejects(later.Resource.subscribe('topic', undefined, { user, authorize: true }), {
				statusCode: 403,
			});
			assert.strictEqual(_liveSubscriptionCount(), 0, 'a later SUBSCRIBE with that principal needs a role');
		});

		it('requires a role of a subscription by the view a recheck installed before the principal was latched', async () => {
			const context = { user: await certificate('view_latch_cn'), authorize: true };
			const first = grantingByUsername('view_latch_cn');
			const firstSubscription = await first.Resource.subscribe('topic', undefined, context);
			handles.push({ unregister: () => firstSubscription.end() });
			await _sweepNow();
			const view = context.user;
			assert.strictEqual(userModule.isCertificatePrincipal(view), true, 'a recheck installed a marked view');
			await testUtils.seedUsers([{ username: 'view_latch_cn', active: true, role: 'missing_role' }]);
			await _sweepNow();
			assert.strictEqual(first.end.calls.length, 1, 'a record with no role revokes it');

			await testUtils.seedUsers();
			const later = grantingByUsername('view_latch_cn');
			await assert.rejects(later.Resource.subscribe('topic', undefined, { user: view, authorize: true }), {
				statusCode: 403,
			});
			assert.strictEqual(_liveSubscriptionCount(), 0, 'a subscription by that view needs a role');
		});

		it('requires a role of a subscription by a view held outside its context once a record backed the admission', async () => {
			// application code can keep a view a recheck installed (getCurrentUser())
			const installed = [];
			let current = await certificate('retained_latch_cn');
			const context = {
				authorize: true,
				get user() {
					return current;
				},
				set user(view) {
					installed.push(view);
					current = view;
				},
			};
			const first = grantingByUsername('retained_latch_cn');
			const firstSubscription = await first.Resource.subscribe('topic', undefined, context);
			handles.push({ unregister: () => firstSubscription.end() });
			const second = grantingByUsername('retained_latch_cn');
			const secondSubscription = await second.Resource.subscribe('topic', undefined, context);
			handles.push({ unregister: () => secondSubscription.end() });
			await _sweepNow();
			assert.strictEqual(installed.length, 2, 'each subscription installed its own view');
			const retained = installed[0];
			assert.notStrictEqual(context.user, retained, "the other subscription's view replaced it");
			assert.strictEqual(
				userModule.certificateAdmission(retained),
				userModule.certificateAdmission(context.user),
				'both views carry the one admission'
			);
			await testUtils.seedUsers([{ username: 'retained_latch_cn', active: true, role: 'missing_role' }]);
			await _sweepNow();
			assert.strictEqual(first.end.calls.length + second.end.calls.length, 2, 'a record with no role revokes both');

			await testUtils.seedUsers();
			const later = grantingByUsername('retained_latch_cn');
			// a subscription admitted with no recheck returns synchronously, which assert.rejects needs as a rejection
			await assert.rejects(
				async () => later.Resource.subscribe('topic', undefined, { user: retained, authorize: true }),
				{
					statusCode: 403,
				}
			);
			assert.strictEqual(_liveSubscriptionCount(), 0, 'a subscription by a retained view needs a role');
		});

		for (const active of [true, false]) {
			const kind = active ? 'a record' : 'an inactive record';
			it(`latches an admission whose recheck finds ${kind} even on a context that already required a role`, async () => {
				const username = active ? 'relatch_cn' : 'relatch_inactive_cn';
				const context = { user: await certificate(username), authorize: true };
				const first = grantingByUsername(username);
				const firstSubscription = await first.Resource.subscribe('topic', undefined, context);
				handles.push({ unregister: () => firstSubscription.end() });
				await testUtils.seedUsers([{ username, active, role: 'missing_role' }]);
				await _sweepNow();
				assert.strictEqual(first.end.calls.length, 1, 'the record latches the context');

				await testUtils.seedUsers();
				const other = await certificate(username);
				await testUtils.seedUsers([{ username, active, role: 'missing_role' }]);
				context.user = other;
				const second = grantingByUsername(username);
				await assert.rejects(async () => second.Resource.subscribe('topic', undefined, context), { statusCode: 403 });

				await testUtils.seedUsers();
				const later = grantingByUsername(username);
				await assert.rejects(
					async () => later.Resource.subscribe('topic', undefined, { user: other, authorize: true }),
					{
						statusCode: 403,
					}
				);
				assert.strictEqual(_liveSubscriptionCount(), 0, 'its own recheck latched that admission');
			});
		}

		it('latches the admission of the view a context holds when a record backs that name', async () => {
			const context = { user: await certificate('held_latch_cn'), authorize: true };
			const first = grantingByUsername('held_latch_cn');
			const firstSubscription = await first.Resource.subscribe('topic', undefined, context);
			handles.push({ unregister: () => firstSubscription.end() });
			const held = await certificate('held_latch_cn');
			context.user = held;
			await testUtils.seedUsers([{ username: 'held_latch_cn', active: true, role: 'missing_role' }]);
			await _sweepNow();
			assert.strictEqual(first.end.calls.length, 1, 'a record with no role revokes it');

			await testUtils.seedUsers();
			const later = grantingByUsername('held_latch_cn');
			await assert.rejects(async () => later.Resource.subscribe('topic', undefined, { user: held, authorize: true }), {
				statusCode: 403,
			});
			assert.strictEqual(_liveSubscriptionCount(), 0, 'the held view of another admission needs a role');
		});

		it('requires a role of a view an MCP refresh built after the record that backed the admission was dropped', async () => {
			await testUtils.seedUsers([{ username: 'refreshed_cn', active: true, role: readRole('refreshed_role') }]);
			const admitted = await certificate('refreshed_cn');
			assert.strictEqual(userModule.isRecordBacked(admitted), true);
			await testUtils.seedUsers();
			const refreshed = userModule.withCertificateAdmission(await resolve('refreshed_cn'), admitted);
			assert.strictEqual(userModule.isRecordBacked(refreshed), false, 'the refresh found no record');
			const gate = grantingByUsername('refreshed_cn');
			await assert.rejects(
				async () => gate.Resource.subscribe('topic', undefined, { user: refreshed, authorize: true }),
				{
					statusCode: 403,
				}
			);
			assert.strictEqual(_liveSubscriptionCount(), 0, 'a record backed its admission, so it needs a role');
		});

		it('requires a role of a refreshed view of a certificate admission that arrived with a role and no record', async () => {
			const admitted = userModule.certificatePrincipal(
				{ username: 'role_admission_cn', role: readRole('role_admission_role') },
				async () => undefined
			);
			assert.strictEqual(userModule.isRecordBacked(admitted), undefined, 'no lookup tracked it');
			const refreshed = userModule.withCertificateAdmission(await resolve('role_admission_cn'), admitted);
			assert.strictEqual(refreshed.role, undefined);
			const gate = grantingByUsername('role_admission_cn');
			await assert.rejects(
				async () => gate.Resource.subscribe('topic', undefined, { user: refreshed, authorize: true }),
				{
					statusCode: 403,
				}
			);
			assert.strictEqual(_liveSubscriptionCount(), 0, 'it arrived with a role, so every view of it needs one');
		});

		it('requires a role of a view built after drop_user once an MCP refresh found a record behind the admission', async () => {
			const admitted = await certificate('refresh_saw_cn');
			await testUtils.seedUsers([{ username: 'refresh_saw_cn', active: true, role: readRole('refresh_saw_role') }]);
			const backed = userModule.withCertificateAdmission(await resolve('refresh_saw_cn'), admitted);
			assert.strictEqual(userModule.isRecordBacked(backed), true);
			await testUtils.seedUsers();
			const dropped = userModule.withCertificateAdmission(await resolve('refresh_saw_cn'), backed);
			assert.strictEqual(userModule.certificateAdmission(dropped), admitted);
			const gate = grantingByUsername('refresh_saw_cn');
			await assert.rejects(
				async () => gate.Resource.subscribe('topic', undefined, { user: dropped, authorize: true }),
				{
					statusCode: 403,
				}
			);
			assert.strictEqual(_liveSubscriptionCount(), 0, 'the refresh saw the record, so the admission needs a role');
		});

		it('keeps the CONNECT lookup of a certificate principal a component built with no hdb_user', async () => {
			const built = { username: 'component_cert_cn', active: true };
			const admission = {};
			const user = userModule.certificatePrincipal(
				await userModule.getTrackedUser('component_cert_cn', null, null, admission, { getUser: async () => built })
			);
			assert.notStrictEqual(user, built);
			assert.strictEqual(userModule.isRecordlessPrincipal(user), true, 'the copy keeps the lookup that tracked it');
			const gate = grantingByUsername('component_cert_cn');
			const context = { user, authorize: true, session: { user, userProvenance: admission.provenance } };
			const subscription = await gate.Resource.subscribe('topic', undefined, context);
			handles.push({ unregister: () => subscription.end() });
			const resolutions = countResolutions();
			try {
				await _sweepNow();
			} finally {
				resolutions.restore();
			}
			assert.strictEqual(gate.end.calls.length, 0, 'a recheck revoked it');
			assert.deepStrictEqual(resolutions.calls, [], 'never re-resolved by name');
		});

		it('rejects a subscription admitted by a user whose records changed before it registered', async () => {
			await testUtils.seedUsers([{ username: 'stale_user', active: true, role: readRole('stale_role') }]);
			const user = await resolve('stale_user');
			await databases.system.hdb_user.put({ username: 'stale_user', active: false, role: 'stale_role' });

			await assert.rejects(subscribe(Docs, user), { statusCode: 403 });
			assert.strictEqual(_liveSubscriptionCount(), 0);
		});

		it('returns a closed or absent subscription to a stale principal unchanged', async () => {
			await testUtils.seedUsers([{ username: 'stale_closed', active: true, role: readRole('stale_closed_role') }]);
			const user = await resolve('stale_closed');
			await databases.system.hdb_role.put(readRole('stale_closed_role'));
			const Closed = class extends Docs {
				subscribe() {
					return { closed: true, end() {}, on() {} };
				}
			};
			const Absent = class extends Docs {
				subscribe() {
					return undefined;
				}
			};

			assert.strictEqual((await Closed.subscribe('topic', undefined, { user, authorize: true })).closed, true);
			assert.strictEqual(await Absent.subscribe('topic', undefined, { user, authorize: true }), undefined);
			assert.strictEqual(_liveSubscriptionCount(), 0);
		});

		it('returns a stale principal’s subscription that its owner closed during the admission recheck', async () => {
			await testUtils.seedUsers([{ username: 'stale_closing', active: true, role: readRole('stale_closing_role') }]);
			const user = await resolve('stale_closing');
			await databases.system.hdb_role.put(readRole('stale_closing_role'));
			let release;
			const gate = new Promise((resolve) => (release = resolve));
			let recheckStarted = false;
			const subscription = fakeSubscription();
			const Gated = class extends Docs {
				subscribe() {
					return subscription;
				}
				allowRead(principal) {
					// the recheck evaluates the context's fresh view, not the admitting user
					if (principal === user) return true;
					recheckStarted = true;
					return gate.then(() => true);
				}
			};
			const pending = Gated.subscribe('topic', undefined, { user, authorize: true });
			await waitFor(() => recheckStarted, { message: 'the admission recheck never started' });
			subscription.emit('close');
			release();

			assert.strictEqual(await pending, subscription, 'a close is not a denial');
			assert.strictEqual(_liveSubscriptionCount(), 0);
		});

		it('admits a stale principal that is still authorized, with its context on the current user', async () => {
			await testUtils.seedUsers([{ username: 'stale_ok', active: true, role: readRole('stale_ok_role') }]);
			const user = await resolve('stale_ok');
			await databases.system.hdb_role.put(readRole('stale_ok_role'));

			const { context } = await subscribe(Docs, user);

			assert.strictEqual(_liveSubscriptionCount(), 1);
			assert.notStrictEqual(context.user, user);
			assert.ok(userModule.isCurrentUser(context.user));
		});

		describe('attribute read permissions', () => {
			let Notes;
			const roleId = 'notes_role';
			const narrowerRoleId = 'notes_narrower_role';

			before(() => {
				const NoteParents = table({
					table: 'ReauthNoteParents',
					database: 'test',
					attributes: [{ name: 'id', isPrimaryKey: true }, { name: 'name' }],
				});
				const Table = table({
					table: 'ReauthNotes',
					database: 'test',
					attributes: [
						{ name: 'id', isPrimaryKey: true },
						{ name: 'title' },
						{ name: 'note' },
						{ name: 'parentId' },
						{ name: 'parent', relationship: { from: 'parentId' }, definition: { tableClass: NoteParents } },
					],
				});
				Notes = class extends Table {
					subscribe() {
						const subscription = fakeSubscription();
						// registration wraps end()
						subscription.endSpy = subscription.end;
						return subscription;
					}
				};
			});

			// `readable` undefined: table read with no attribute permissions
			const notesRole = (id, readable, superUser = false) => ({
				id,
				role: id,
				permission: {
					super_user: superUser,
					test: {
						tables: {
							ReauthNotes: {
								read: true,
								insert: false,
								update: false,
								delete: false,
								attribute_permissions: (readable ?? []).map((attribute_name) => ({
									attribute_name,
									read: true,
									insert: false,
									update: false,
								})),
							},
							ReauthNoteParents: { read: true, insert: false, update: false, delete: false, attribute_permissions: [] },
						},
					},
				},
			});

			async function subscribeAs(user, shape = {}, authorize = true) {
				const context = authorize ? { user, authorize: true } : { user };
				const target = new RequestTarget('/topic');
				target.id = 'topic';
				Object.assign(target, shape);
				const subscription = await Notes.subscribe(target, undefined, context);
				handles.push({ unregister: () => subscription.end() });
				return subscription;
			}
			const ended = (subscription) => subscription.endSpy.calls.length > 0;

			it('ends a subscription once its role can no longer read an attribute it could at admission', async () => {
				// a condition through `parent` needs it readable
				await testUtils.seedUsers([
					{ username: 'notes_user', active: true, role: notesRole(roleId, ['title', 'note', 'parent']) },
				]);
				const user = await resolve('notes_user');
				const shared = await subscribeAs(user);
				const selected = await subscribeAs(user, { select: ['title', 'note'] });
				const related = await subscribeAs(user, { conditions: [{ attribute: ['parent', 'name'], value: 'x' }] });
				await _notifyUserChange(change({ roleIds: [roleId] }));
				assert.ok(![shared, selected, related].some(ended), 'an unchanged role keeps every subscription');

				await testUtils.seedUsers([
					{ username: 'notes_user', active: true, role: notesRole(roleId, ['title', 'parent']) },
				]);
				await _notifyUserChange(change({ roleIds: [roleId] }));

				assert.ok(ended(shared), 'the subscription the role decision is shared for ends');
				assert.ok(ended(selected), 'a subscription with a caller select ends');
				assert.ok(ended(related), 'a subscription filtered through a relationship ends');
				assert.strictEqual(_liveSubscriptionCount(), 0);
			});

			it('ends a subscription once its user moves to a role that reads fewer attributes', async () => {
				const narrower = notesRole(narrowerRoleId, ['title']);
				await testUtils.seedUsers([
					{ username: 'notes_mover', active: true, role: notesRole(roleId, ['title', 'note']) },
					{ username: 'notes_placeholder', active: true, role: narrower },
				]);
				const subscription = await subscribeAs(await resolve('notes_mover'));

				await testUtils.seedUsers([
					{ username: 'notes_mover', active: true, role: narrowerRoleId },
					{ username: 'notes_placeholder', active: true, role: narrower },
				]);
				await _notifyUserChange(change({ usernames: ['notes_mover'] }));

				assert.ok(ended(subscription));
			});

			it('keeps a subscription its role can still read in full, whatever its target', async () => {
				await testUtils.seedUsers([
					{ username: 'notes_keeper', active: true, role: notesRole(roleId, ['title', 'note', 'parent']) },
					{ username: 'notes_super', active: true, role: notesRole('notes_super_role', undefined, true) },
				]);
				const user = await resolve('notes_keeper');
				const kept = [
					await subscribeAs(user),
					await subscribeAs(user, { select: ['title', 'parent'] }),
					// authorization rewrites a relationship property into a select of the related record
					await subscribeAs(user, { property: 'parent' }),
					await subscribeAs(user, { conditions: [{ attribute: ['parent', 'name'], value: 'x' }] }),
					await subscribeAs(user, {}, false),
					await subscribeAs(await resolve('notes_super')),
				];
				const reseed = (readable) =>
					testUtils.seedUsers([
						{ username: 'notes_keeper', active: true, role: notesRole(roleId, readable) },
						{ username: 'notes_super', active: true, role: notesRole('notes_super_role', undefined, true) },
					]);
				await _sweepNow();
				await _sweepNow();
				assert.deepStrictEqual(
					kept.map(ended),
					kept.map(() => false),
					'an unchanged role'
				);

				await reseed(['title', 'note', 'parent', 'parentId']);
				await _sweepNow();
				assert.deepStrictEqual(
					kept.map(ended),
					kept.map(() => false),
					'a widened role'
				);

				await reseed(undefined);
				await _sweepNow();
				assert.deepStrictEqual(
					kept.map(ended),
					kept.map(() => false),
					'a role no longer restricted'
				);

				await reseed(['title']);
				await _sweepNow();
				assert.deepStrictEqual(
					kept.map(ended),
					[true, true, true, true, true, false],
					'a narrowed role, below admission'
				);
			});

			it('ends a subscription filtered through a relationship once its role cannot read the related attribute', async () => {
				const role = (parentReadable) => {
					const filtering = notesRole(roleId, ['title', 'parent']);
					filtering.permission.test.tables.ReauthNoteParents.attribute_permissions = parentReadable.map(
						(attribute_name) => ({ attribute_name, read: true, insert: false, update: false })
					);
					return filtering;
				};
				await testUtils.seedUsers([{ username: 'notes_filtering', active: true, role: role(['name']) }]);
				const subscription = await subscribeAs(await resolve('notes_filtering'), {
					conditions: [{ attribute: ['parent', 'name'], value: 'x' }],
				});
				await _sweepNow();
				assert.ok(!ended(subscription));

				await testUtils.seedUsers([{ username: 'notes_filtering', active: true, role: role(['id']) }]);
				await _sweepNow();

				assert.ok(ended(subscription));
			});

			it('ends a subscription admitted without attribute restrictions once its role gains them', async () => {
				await testUtils.seedUsers([{ username: 'notes_open', active: true, role: notesRole(roleId, undefined) }]);
				const subscription = await subscribeAs(await resolve('notes_open'));

				await testUtils.seedUsers([
					{ username: 'notes_open', active: true, role: notesRole(roleId, ['title', 'note']) },
				]);
				await _sweepNow();

				assert.ok(ended(subscription));
			});

			it('compares each subscription with what its role could read when it was admitted', async () => {
				const seedRole = (readable) =>
					testUtils.seedUsers([{ username: 'notes_twice', active: true, role: notesRole(roleId, readable) }]);
				await seedRole(['title']);
				const narrowAdmission = await subscribeAs(await resolve('notes_twice'));
				await seedRole(['title', 'note']);
				await _sweepNow();
				const wideAdmission = await subscribeAs(await resolve('notes_twice'));
				assert.ok(!ended(narrowAdmission), 'widening keeps the earlier subscription');

				await seedRole(['title']);
				await _sweepNow();

				assert.ok(!ended(narrowAdmission), 'admitted with title alone, it can still read everything it could');
				assert.ok(ended(wideAdmission), 'admitted with note, it ends');
			});

			it('ends a subscription whose allowRead override defers to the table once its role narrows', async () => {
				class Deferring extends Notes {
					allowRead(user, target, context) {
						return super.allowRead(user, target, context);
					}
				}
				await testUtils.seedUsers([
					{ username: 'notes_deferring', active: true, role: notesRole(roleId, ['title', 'note']) },
				]);
				const context = { user: await resolve('notes_deferring'), authorize: true };
				const subscription = await Deferring.subscribe('topic', undefined, context);
				handles.push({ unregister: () => subscription.end() });

				await testUtils.seedUsers([{ username: 'notes_deferring', active: true, role: notesRole(roleId, ['title']) }]);
				await _sweepNow();

				assert.ok(ended(subscription));
			});

			it('rejects a subscription admitted by a role that lost an attribute before it registered', async () => {
				await testUtils.seedUsers([
					{ username: 'notes_stale', active: true, role: notesRole(roleId, ['title', 'note']) },
				]);
				const user = await resolve('notes_stale');
				await databases.system.hdb_role.put(notesRole(roleId, ['title']));

				await assert.rejects(subscribeAs(user), { statusCode: 403 });
				assert.strictEqual(_liveSubscriptionCount(), 0);
			});

			it('admits a stale principal whose role still reads every attribute it read', async () => {
				await testUtils.seedUsers([{ username: 'notes_stale_ok', active: true, role: notesRole(roleId, ['title']) }]);
				const user = await resolve('notes_stale_ok');
				await databases.system.hdb_role.put(notesRole(roleId, ['title', 'note']));

				const subscription = await subscribeAs(user);

				assert.ok(!ended(subscription));
				assert.strictEqual(_liveSubscriptionCount(), 1);
			});
		});
	});
});
