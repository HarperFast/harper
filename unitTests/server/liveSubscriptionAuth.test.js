'use strict';

const testUtils = require('../testUtils.js');
testUtils.preTestPrep();

const assert = require('node:assert');
const { EventEmitter } = require('node:events');
const sinon = require('sinon');

const {
	registerLiveSubscription,
	_liveSubscriptionCount,
	_sweepNow,
} = require('#src/server/liveSubscriptionAuth');

// A minimal stand-in for the SSE/WS/MQTT subscription object: an EventEmitter (for the 'close'
// self-wiring path) with an end() the registry can wrap.
function fakeSubscription() {
	const subscription = new EventEmitter();
	subscription.end = sinon.stub();
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

			assert.strictEqual(originalEnd.callCount, 1);
			assert.strictEqual(_liveSubscriptionCount(), 0);
		});

		it('falls back to close() when end() is absent', async () => {
			const subscription = { close: sinon.stub() };
			register({
				subscription,
				username: 'bob',
				authExpiresAt: 0,
				recheck: async () => true,
			});
			handles.pop();

			await _sweepNow();

			assert.strictEqual(subscription.close.callCount, 1);
			assert.strictEqual(_liveSubscriptionCount(), 0);
		});

		it("falls back to emit('close') when end() and close() are both absent", async () => {
			const subscription = new EventEmitter();
			const emitSpy = sinon.spy(subscription, 'emit');
			register({
				subscription,
				username: 'carol',
				authExpiresAt: 0,
				recheck: async () => true,
			});
			handles.pop();

			await _sweepNow();

			assert.ok(emitSpy.calledWith('close'));
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

			assert.strictEqual(originalEnd.callCount, 1);
			assert.deepStrictEqual(originalEnd.firstCall.args, ['arg']);
			assert.strictEqual(_liveSubscriptionCount(), 0);
			handles.pop(); // already unregistered by end()
		});
	});

	describe('revoke supplied (new seam)', () => {
		it('uses revoke as terminate instead of end()/close()/emit', async () => {
			const subscription = fakeSubscription();
			const revoke = sinon.stub();
			register({
				subscription,
				username: 'frank',
				authExpiresAt: 0,
				recheck: async () => true,
				revoke,
			});
			handles.pop();

			await _sweepNow();

			assert.strictEqual(revoke.callCount, 1);
			assert.strictEqual(subscription.end.callCount, 0, 'revoke must be used instead of end()');
			assert.strictEqual(_liveSubscriptionCount(), 0);
		});

		it('does not mutate the subscription object: end identity and listener count unchanged', () => {
			const subscription = fakeSubscription();
			const originalEnd = subscription.end;
			const listenersBefore = subscription.listenerCount('close');

			register({ subscription, username: 'grace', recheck: async () => true, revoke: sinon.stub() });

			assert.strictEqual(subscription.end, originalEnd, 'subscription.end must not be replaced');
			assert.strictEqual(
				subscription.listenerCount('close'),
				listenersBefore,
				"no 'close' listener should be added"
			);
		});

		it('returns an unregister handle that removes only its own entry', () => {
			const subscription = fakeSubscription();
			const a = register({ subscription, username: 'a', recheck: async () => true, revoke: sinon.stub() });
			register({ subscription, username: 'b', recheck: async () => true, revoke: sinon.stub() });
			assert.strictEqual(_liveSubscriptionCount(), 2);

			a.unregister();
			handles.splice(handles.indexOf(a), 1);

			assert.strictEqual(_liveSubscriptionCount(), 1);
		});

		it('revoking one of N entries sharing one subscription object invokes only that revoke, leaves the rest registered, and never touches the shared subscription', async () => {
			const subscription = fakeSubscription();
			const emitSpy = sinon.spy(subscription, 'emit');
			const revokeA = sinon.stub();
			const revokeB = sinon.stub();
			const revokeC = sinon.stub();
			register({ subscription, username: 'a', authExpiresAt: 0, recheck: async () => true, revoke: revokeA });
			register({ subscription, username: 'b', recheck: async () => true, revoke: revokeB });
			register({ subscription, username: 'c', recheck: async () => true, revoke: revokeC });
			assert.strictEqual(_liveSubscriptionCount(), 3);

			await _sweepNow();

			assert.strictEqual(revokeA.callCount, 1, 'the expired subscriber should be revoked');
			assert.strictEqual(revokeB.callCount, 0, 'other subscribers must not be revoked');
			assert.strictEqual(revokeC.callCount, 0, 'other subscribers must not be revoked');
			assert.strictEqual(_liveSubscriptionCount(), 2, 'the other two entries must remain registered');
			assert.strictEqual(subscription.end.callCount, 0, 'the shared subscription must not be ended');
			assert.strictEqual(emitSpy.called, false, 'the shared subscription must not be closed');
		});

		it('a throwing recheck among several sharing one subscription revokes only that entry (fail-closed)', async () => {
			const subscription = fakeSubscription();
			const revokeThrows = sinon.stub();
			const revokeOkA = sinon.stub();
			const revokeOkB = sinon.stub();
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

			assert.strictEqual(revokeThrows.callCount, 1);
			assert.strictEqual(revokeOkA.callCount, 0);
			assert.strictEqual(revokeOkB.callCount, 0);
			assert.strictEqual(_liveSubscriptionCount(), 2);
			assert.strictEqual(subscription.end.callCount, 0);
		});

		it('revokes on token expiry without consulting recheck', async () => {
			const subscription = fakeSubscription();
			const revoke = sinon.stub();
			const recheck = sinon.stub().rejects(new Error('recheck must not be called for an expired token'));
			register({ subscription, username: 'expired', authExpiresAt: 0, recheck, revoke });
			handles.pop();

			await _sweepNow();

			assert.strictEqual(recheck.callCount, 0);
			assert.strictEqual(revoke.callCount, 1);
			assert.strictEqual(_liveSubscriptionCount(), 0);
		});
	});
});
