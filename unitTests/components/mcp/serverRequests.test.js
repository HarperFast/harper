const assert = require('node:assert/strict');
const {
	sendServerRequest,
	routeClientResponse,
	dropSessionServerRequests,
	isClientResponse,
	_pendingServerRequestCount,
	_resetServerRequestsForTest,
	_setItcForTest,
} = require('#src/components/mcp/serverRequests');

describe('mcp/serverRequests', () => {
	let itcSent;
	let itcOnMessage; // the cross-worker response listener registered by the module
	beforeEach(() => {
		itcSent = [];
		itcOnMessage = null;
		_setItcForTest({
			send: (e) => itcSent.push(e),
			onMessage: (_type, cb) => {
				itcOnMessage = cb;
			},
		});
		_resetServerRequestsForTest();
	});
	afterEach(() => {
		_resetServerRequestsForTest();
		_setItcForTest(undefined);
	});

	const CAPS = { sampling: {}, elicitation: {}, roots: {} };

	describe('isClientResponse', () => {
		it('classifies responses, not requests or notifications', () => {
			assert.equal(isClientResponse({ jsonrpc: '2.0', id: 1, result: {} }), true);
			assert.equal(isClientResponse({ jsonrpc: '2.0', id: 1, error: { code: -1, message: 'x' } }), true);
			assert.equal(isClientResponse({ jsonrpc: '2.0', id: 1, method: 'tools/call' }), false);
			assert.equal(isClientResponse({ jsonrpc: '2.0', method: 'notifications/cancelled' }), false);
		});
	});

	it('delivers the request frame and resolves when the matching response arrives', async () => {
		let frame;
		const p = sendServerRequest({
			sessionId: 's1',
			method: 'elicitation/create',
			params: { message: 'name?' },
			clientCapabilities: CAPS,
			deliver: (f) => (frame = f),
		});
		assert.equal(frame.method, 'elicitation/create');
		assert.ok(typeof frame.id === 'string');
		assert.equal(_pendingServerRequestCount(), 1);
		routeClientResponse('s1', { id: frame.id, result: { action: 'accept' } });
		assert.deepEqual(await p, { action: 'accept' });
		assert.equal(_pendingServerRequestCount(), 0, 'pending cleared on response');
	});

	it('generates worker-unique request ids (UUID, not a per-worker counter)', async () => {
		const ids = [];
		for (let i = 0; i < 3; i++) {
			sendServerRequest({
				sessionId: 's1',
				method: 'roots/list',
				params: {},
				clientCapabilities: CAPS,
				deliver: (f) => ids.push(f.id),
				timeoutMs: 50,
			}).catch(() => {});
		}
		// UUID form, not `srv-1`/`srv-2` — two workers starting a counter at 1 would
		// collide on (sessionId, id) and misroute responses.
		assert.equal(new Set(ids).size, 3, 'all ids distinct');
		for (const id of ids) assert.match(id, /^srv-[0-9a-f]{8}-[0-9a-f]{4}-/, 'UUID-form id');
	});

	it('rejects an error response', async () => {
		let frame;
		const p = sendServerRequest({
			sessionId: 's1',
			method: 'roots/list',
			params: {},
			clientCapabilities: CAPS,
			deliver: (f) => (frame = f),
		});
		routeClientResponse('s1', { id: frame.id, error: { code: -32000, message: 'denied' } });
		await assert.rejects(p, /denied/);
	});

	it('rejects when the client did not declare the required capability', async () => {
		await assert.rejects(
			sendServerRequest({
				sessionId: 's1',
				method: 'sampling/createMessage',
				params: {},
				clientCapabilities: { elicitation: {} }, // no sampling
				deliver: () => {},
			}),
			/sampling/
		);
		assert.equal(_pendingServerRequestCount(), 0, 'no pending entry for a gated-out request');
	});

	it('times out when the client never responds', async () => {
		await assert.rejects(
			sendServerRequest({
				sessionId: 's1',
				method: 'roots/list',
				params: {},
				clientCapabilities: CAPS,
				deliver: () => {},
				timeoutMs: 20,
			}),
			/timed out/
		);
		assert.equal(_pendingServerRequestCount(), 0);
	});

	it('fans a non-local response out over ITC (cross-worker correlation)', () => {
		// No local pending for this id → broadcast so the owning worker resolves it.
		routeClientResponse('s2', { id: 'srv-999', result: { x: 1 } });
		assert.equal(itcSent.length, 1);
		assert.equal(itcSent[0].message.sessionId, 's2');
		assert.equal(itcSent[0].message.id, 'srv-999');
		assert.deepEqual(itcSent[0].message.result, { x: 1 });
	});

	it('does NOT fan out a response whose id is not a server-minted (srv-) id', () => {
		// A client echoing an arbitrary id / a duplicate frame can't match any pending
		// server→client request, so broadcasting it cluster-wide would be pure amplification.
		routeClientResponse('s2', { id: 42, result: { x: 1 } });
		routeClientResponse('s2', { id: 'client-generated', result: { x: 2 } });
		assert.equal(itcSent.length, 0, 'non-srv ids must not trigger an ITC broadcast');
	});

	it('enforces a per-session cap independent of the global cap', async () => {
		// Saturate one session; the per-session cap (25) trips well before the global 100.
		// These never resolve here — afterEach's reset rejects+clears them.
		for (let i = 0; i < 25; i++) {
			sendServerRequest({
				sessionId: 's1',
				method: 'roots/list',
				params: {},
				clientCapabilities: CAPS,
				deliver: () => {},
			}).catch(() => {});
		}
		assert.equal(_pendingServerRequestCount(), 25);

		// 26th for the same session is rejected by the per-session cap.
		await assert.rejects(
			sendServerRequest({
				sessionId: 's1',
				method: 'roots/list',
				params: {},
				clientCapabilities: CAPS,
				deliver: () => {},
			}),
			/for this session/
		);

		// A different session is unaffected (well under both caps).
		let frame;
		const p = sendServerRequest({
			sessionId: 's2',
			method: 'roots/list',
			params: {},
			clientCapabilities: CAPS,
			deliver: (f) => (frame = f),
		});
		assert.ok(frame, 'a different session can still issue a request');
		routeClientResponse('s2', { id: frame.id, result: { ok: true } });
		assert.deepEqual(await p, { ok: true });
	});

	it('resolves a pending request from a cross-worker ITC response', async () => {
		let frame;
		const p = sendServerRequest({
			sessionId: 's1',
			method: 'roots/list',
			params: {},
			clientCapabilities: CAPS,
			deliver: (f) => (frame = f),
		});
		// Simulate the ITC fan-out arriving on this (owning) worker.
		assert.ok(itcOnMessage, 'module registered an ITC listener');
		itcOnMessage({ message: { sessionId: 's1', id: frame.id, result: { ok: true } } });
		assert.deepEqual(await p, { ok: true });
	});

	it('dropSessionServerRequests rejects + clears all pending for a session', async () => {
		const p = sendServerRequest({
			sessionId: 's1',
			method: 'roots/list',
			params: {},
			clientCapabilities: CAPS,
			deliver: () => {},
		});
		dropSessionServerRequests('s1');
		await assert.rejects(p, /session closed/);
		assert.equal(_pendingServerRequestCount(), 0);
	});
});
