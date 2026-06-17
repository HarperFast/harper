const assert = require('node:assert/strict');
const {
	isValidMcpLogLevel,
	setSessionLogLevel,
	getSessionLogLevel,
	emitMcpLogToSession,
	emitMcpLogToProfile,
} = require('#src/components/mcp/logging');
const {
	registerSession,
	unregisterSession,
	_resetSessionRegistryForTest,
} = require('#src/components/mcp/sessionRegistry');

const SUPER = { username: 'admin', role: { permission: { super_user: true } } };

// Attach a 'data' listener immediately so the queue routes sends to us
// (IterableEventQueue only emits 'data' once it has a listener).
function capture(record) {
	const frames = [];
	record.queue.on('data', (f) => frames.push(f));
	return frames;
}

describe('mcp/logging', () => {
	afterEach(() => {
		_resetSessionRegistryForTest();
	});

	it('validates RFC 5424 levels and rejects everything else', () => {
		for (const level of ['debug', 'info', 'notice', 'warning', 'error', 'critical', 'alert', 'emergency']) {
			assert.equal(isValidMcpLogLevel(level), true, level);
		}
		for (const bad of ['verbose', 'trace', 'warn', 'fatal', '', 5, null, undefined, {}]) {
			assert.equal(isValidMcpLogLevel(bad), false, String(bad));
		}
	});

	it('stores the level on the registered session and clears it when the session unregisters', () => {
		registerSession('s1', 'application', SUPER);
		setSessionLogLevel('s1', 'warning');
		assert.equal(getSessionLogLevel('s1'), 'warning');
		unregisterSession('s1');
		assert.equal(getSessionLogLevel('s1'), undefined);
	});

	it('setSessionLogLevel is a no-op for a session with no open SSE stream', () => {
		setSessionLogLevel('ghost', 'debug'); // never registered → nowhere to store
		assert.equal(getSessionLogLevel('ghost'), undefined);
	});

	it('emits nothing until the session has set a level (no unsolicited messages)', () => {
		const rec = registerSession('s1', 'application', SUPER);
		const frames = capture(rec);
		emitMcpLogToSession('s1', 'error', { msg: 'x' });
		assert.equal(frames.length, 0);
	});

	it('delivers a notifications/message at or above the session level', () => {
		const rec = registerSession('s1', 'application', SUPER);
		const frames = capture(rec);
		setSessionLogLevel('s1', 'warning');
		emitMcpLogToSession('s1', 'error', { code: 1 }, 'mcp.test'); // error >= warning
		assert.equal(frames.length, 1);
		assert.equal(frames[0].event, 'message');
		assert.deepEqual(frames[0].data, {
			jsonrpc: '2.0',
			method: 'notifications/message',
			params: { level: 'error', logger: 'mcp.test', data: { code: 1 } },
		});
	});

	it('suppresses a record below the session level', () => {
		const rec = registerSession('s1', 'application', SUPER);
		const frames = capture(rec);
		setSessionLogLevel('s1', 'error');
		emitMcpLogToSession('s1', 'info', { msg: 'low' }); // info < error
		assert.equal(frames.length, 0);
	});

	it('does not admit an unrecognized level even when the session minimum is debug (rank 0)', () => {
		// Defensive: an invalid recordLevel must not slip past a `debug` minimum by
		// defaulting to rank 0 (Gemini review).
		const rec = registerSession('s1', 'application', SUPER);
		const frames = capture(rec);
		setSessionLogLevel('s1', 'debug');
		emitMcpLogToSession('s1', 'bogus', { msg: 'invalid level' });
		assert.equal(frames.length, 0);
	});

	it('admits a record exactly at the session level', () => {
		const rec = registerSession('s1', 'application', SUPER);
		const frames = capture(rec);
		setSessionLogLevel('s1', 'notice');
		emitMcpLogToSession('s1', 'notice', { at: 'boundary' });
		assert.equal(frames.length, 1);
	});

	it('no-ops when the session has a level but no open SSE stream', () => {
		setSessionLogLevel('ghost', 'debug');
		assert.doesNotThrow(() => emitMcpLogToSession('ghost', 'error', {}));
	});

	it('emitMcpLogToProfile fans out only to admitting sessions on the matching profile', () => {
		const a = registerSession('a', 'application', SUPER);
		const b = registerSession('b', 'application', SUPER);
		const c = registerSession('c', 'operations', SUPER);
		const fa = capture(a);
		const fb = capture(b);
		const fc = capture(c);
		setSessionLogLevel('a', 'info'); // admits info
		setSessionLogLevel('b', 'error'); // suppresses info
		setSessionLogLevel('c', 'debug'); // different profile, not targeted
		emitMcpLogToProfile('application', 'info', { hello: true });
		assert.equal(fa.length, 1);
		assert.equal(fb.length, 0);
		assert.equal(fc.length, 0);
	});
});
