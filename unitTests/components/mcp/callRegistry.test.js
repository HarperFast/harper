const assert = require('node:assert/strict');
const { registerCall, unregisterCall, cancelCall, _inflightCallCount } = require('#src/components/mcp/callRegistry');

describe('mcp/callRegistry', () => {
	it('aborts the registered controller for a matching session + request id', () => {
		const controller = new AbortController();
		registerCall('sess-1', 7, controller);
		assert.equal(_inflightCallCount(), 1);
		const cancelled = cancelCall('sess-1', 7, 'cancelled by client');
		assert.equal(cancelled, true);
		assert.equal(controller.signal.aborted, true);
		assert.equal(_inflightCallCount(), 0, 'entry removed after cancel');
	});

	it('returns false (no-op) when no call matches', () => {
		assert.equal(cancelCall('sess-x', 999), false);
	});

	it('scopes cancellation to the session — same request id in another session is untouched', () => {
		const a = new AbortController();
		const b = new AbortController();
		registerCall('sess-a', 1, a);
		registerCall('sess-b', 1, b);
		cancelCall('sess-a', 1);
		assert.equal(a.signal.aborted, true);
		assert.equal(b.signal.aborted, false, 'other session not cancelled');
		unregisterCall('sess-b', 1);
		assert.equal(_inflightCallCount(), 0);
	});

	it('unregisterCall removes the entry so a later cancel is a no-op', () => {
		const controller = new AbortController();
		registerCall('sess-2', 3, controller);
		unregisterCall('sess-2', 3);
		assert.equal(cancelCall('sess-2', 3), false);
		assert.equal(controller.signal.aborted, false);
	});

	it('matches string and number request ids by their string form', () => {
		const controller = new AbortController();
		registerCall('sess-3', 'abc', controller);
		assert.equal(cancelCall('sess-3', 'abc'), true);
		assert.equal(controller.signal.aborted, true);
	});
});
