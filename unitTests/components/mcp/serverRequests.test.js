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
