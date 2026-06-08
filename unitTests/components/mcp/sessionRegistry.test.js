const assert = require('node:assert/strict');
const {
	registerSession,
	unregisterSession,
	getRegisteredSession,
	forEachSessionByProfile,
	touchRegisteredSession,
	_resetSessionRegistryForTest,
	_sessionRegistrySize,
	_setClockForTest,
} = require('#src/components/mcp/sessionRegistry');

const SUPER = { username: 'admin', role: { permission: { super_user: true } } };

describe('mcp/sessionRegistry', () => {
	let clock = 0;
	beforeEach(() => {
		clock = 0;
		_setClockForTest(() => clock);
	});
	afterEach(() => {
		_resetSessionRegistryForTest();
		_setClockForTest(undefined);
	});

	it('registers and retrieves a session', () => {
		const rec = registerSession('sid-1', 'application', SUPER);
		assert.equal(rec.sessionId, 'sid-1');
		assert.equal(rec.profile, 'application');
		assert.equal(rec.user, SUPER);
		assert.ok(rec.queue, 'queue created');
		assert.equal(getRegisteredSession('sid-1'), rec);
	});

	it('unregister removes the session and closes its queue', () => {
		const rec = registerSession('sid-1', 'application', SUPER);
		let closed = false;
		rec.queue.on('close', () => {
			closed = true;
		});
		unregisterSession('sid-1');
		assert.equal(getRegisteredSession('sid-1'), undefined);
		assert.equal(closed, true);
	});

	it('re-registering the same session id closes the prior queue', () => {
		const first = registerSession('sid-1', 'application', SUPER);
		let firstClosed = false;
		first.queue.on('close', () => {
			firstClosed = true;
		});
		const second = registerSession('sid-1', 'application', SUPER);
		assert.equal(firstClosed, true);
		assert.notEqual(first.queue, second.queue);
		assert.equal(getRegisteredSession('sid-1'), second);
	});

	it('forEachSessionByProfile applies to only matching sessions', () => {
		registerSession('ops-1', 'operations', SUPER);
		registerSession('ops-2', 'operations', SUPER);
		registerSession('app-1', 'application', SUPER);
		const opsIds = [];
		forEachSessionByProfile('operations', (r) => opsIds.push(r.sessionId));
		assert.deepEqual(opsIds.sort(), ['ops-1', 'ops-2']);
		const appIds = [];
		forEachSessionByProfile('application', (r) => appIds.push(r.sessionId));
		assert.deepEqual(appIds, ['app-1']);
	});

	it('_resetSessionRegistryForTest clears all sessions and closes queues', () => {
		registerSession('a', 'application', SUPER);
		registerSession('b', 'operations', SUPER);
		assert.equal(_sessionRegistrySize(), 2);
		_resetSessionRegistryForTest();
		assert.equal(_sessionRegistrySize(), 0);
	});

	describe('on-close hook (dropped SSE connection)', () => {
		it('emitting "close" on the queue unregisters the session', () => {
			const rec = registerSession('drop-1', 'application', SUPER);
			assert.equal(_sessionRegistrySize(), 1);
			// Simulate the iterator return/throw path: emit 'close' on the queue,
			// which is what EventQueueIterator.return() does when the consumer
			// stops iterating (HTTP server detects client disconnect).
			rec.queue.emit('close');
			assert.equal(_sessionRegistrySize(), 0);
			assert.equal(getRegisteredSession('drop-1'), undefined);
		});

		it('explicit unregisterSession does not loop via the on-close listener', () => {
			const rec = registerSession('drop-2', 'application', SUPER);
			// unregisterSession itself emits 'close', which would re-enter
			// unregisterSession via the listener. The "once" listener + the
			// registry.get check above guard against a recursive loop.
			let emitCount = 0;
			rec.queue.on('close', () => emitCount++);
			unregisterSession('drop-2');
			assert.equal(_sessionRegistrySize(), 0);
			// The user-added 'close' listener should have fired exactly once.
			assert.equal(emitCount, 1);
		});
	});

	describe('idle-session prune (backstop for missed on-close)', () => {
		it('drops sessions whose lastSeen is past the idle window', () => {
			registerSession('idle-1', 'application', SUPER);
			assert.equal(_sessionRegistrySize(), 1);
			// Past prune-interval AND past idle window. Pruning runs on
			// register, so registering a different session triggers the sweep.
			clock += 61 * 60 * 1000;
			registerSession('idle-2', 'application', SUPER);
			// 'idle-1' is past the idle window and has no active iterator —
			// should have been pruned. Only 'idle-2' remains.
			assert.equal(_sessionRegistrySize(), 1);
			assert.equal(getRegisteredSession('idle-1'), undefined);
			assert.ok(getRegisteredSession('idle-2'));
		});

		it('does not prune a session whose iterator is actively awaiting data', () => {
			const rec = registerSession('live-1', 'application', SUPER);
			// Force the queue into an "iterator awaiting" state by reading
			// from it. The async iterator's next() sets resolveNext.
			const iter = rec.queue[Symbol.asyncIterator]();
			const pending = iter.next();
			assert.notEqual(rec.queue.resolveNext, null, 'iterator should be awaiting');
			clock += 61 * 60 * 1000;
			registerSession('live-2', 'application', SUPER);
			// 'live-1' has an active iterator — even past the idle window
			// it should survive the prune.
			assert.ok(getRegisteredSession('live-1'), 'active session survives prune');
			// Cleanup: resolve the pending iter by emitting close.
			rec.queue.emit('close');
			pending.catch(() => {});
		});

		it('touchRegisteredSession bumps lastSeen so a busy session escapes the prune window', () => {
			registerSession('busy-1', 'application', SUPER);
			// Half-way through the idle window, simulate tools/call activity.
			clock += 30 * 60 * 1000;
			touchRegisteredSession('busy-1');
			// Another 40 minutes — would normally be past 60-minute idle.
			clock += 40 * 60 * 1000;
			registerSession('busy-2', 'application', SUPER);
			// Without touchSession, busy-1 would be pruned (70 > 60). With
			// the touch at t=30min, last-seen is 70-40 = 30min ago, under 60.
			assert.ok(getRegisteredSession('busy-1'), 'touched session survives');
		});

		it('prune is throttled — a second sweep within PRUNE_INTERVAL_MS is a no-op', () => {
			// First prune fires when we register past the idle window.
			registerSession('throttle-a', 'application', SUPER);
			clock += 61 * 60 * 1000;
			registerSession('throttle-b', 'application', SUPER);
			assert.equal(getRegisteredSession('throttle-a'), undefined, 'first prune ran');
			// Now make throttle-b artificially "idle" by jumping <5 min into
			// the future (still within the prune-interval cooldown) but
			// >IDLE_PRUNE_MS old by lastSeen accounting. The prune should
			// SKIP entirely, so throttle-b survives.
			clock += 1 * 60 * 1000;
			registerSession('throttle-c', 'application', SUPER);
			assert.ok(getRegisteredSession('throttle-b'), 'prune throttled, b survives');
		});
	});
});
