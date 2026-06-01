const assert = require('node:assert/strict');
const {
	registerSession,
	unregisterSession,
	getRegisteredSession,
	forEachSessionByProfile,
	_resetSessionRegistryForTest,
	_sessionRegistrySize,
} = require('#src/components/mcp/sessionRegistry');

const SUPER = { username: 'admin', role: { permission: { super_user: true } } };

describe('mcp/sessionRegistry', () => {
	afterEach(() => {
		_resetSessionRegistryForTest();
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
});
