'use strict';

const testUtils = require('../testUtils.js');
testUtils.preTestPrep();

const assert = require('node:assert');
const { EventEmitter } = require('node:events');

// The module reads its interval once at import and the first register() starts a real timer; a
// background tick landing mid-test would make _sweepNow() a no-op via the `sweeping` guard.
process.env.HARPER_SUBSCRIPTION_REAUTH_INTERVAL_MS = String(24 * 60 * 60 * 1000);

const { registerLiveSubscription, _liveSubscriptionCount, _sweepNow } = require('#src/server/liveSubscriptionAuth');
const hdbLogger = require('#src/utility/logging/harper_logger');

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

		it('logs an expected revocation at info, not warn', async () => {
			const originalInfo = hdbLogger.info;
			const originalWarn = hdbLogger.warn;
			const infoMessages = [];
			const warnMessages = [];
			hdbLogger.info = (message) => infoMessages.push(message);
			hdbLogger.warn = (message) => warnMessages.push(message);
			try {
				const subscription = fakeSubscription();
				register({
					subscription,
					username: 'logged-user',
					authExpiresAt: 0,
					recheck: async () => true,
				});
				handles.pop();

				await _sweepNow();

				assert.ok(
					infoMessages.some((message) => message.includes('logged-user')),
					`expected a revocation log for the default terminate path, got: ${JSON.stringify(infoMessages)}`
				);
				assert.deepStrictEqual(warnMessages, [], 'routine expiry must not warn once per subscriber');
				assert.strictEqual(_liveSubscriptionCount(), 0);
			} finally {
				hdbLogger.info = originalInfo;
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
			hdbLogger.warn = originalWarn;
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
});
