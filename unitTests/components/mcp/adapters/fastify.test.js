const assert = require('node:assert/strict');
const { createFastifyHandler } = require('#src/components/mcp/adapters/fastify');
const { _setSessionTableForTest, loadSession } = require('#src/components/mcp/session');

function makeFakeTable() {
	const store = new Map();
	return {
		async put(record) {
			store.set(record.id, { ...record });
		},
		async get(id) {
			const r = store.get(id);
			return r ? { ...r } : undefined;
		},
		async delete(id) {
			store.delete(id);
		},
	};
}

function makeReply() {
	const reply = {
		statusCode: undefined,
		headers: {},
		body: undefined,
		code(s) {
			reply.statusCode = s;
			return reply;
		},
		header(k, v) {
			reply.headers[k] = v;
			return reply;
		},
		send(b) {
			reply.body = b;
			return reply;
		},
	};
	return reply;
}

describe('mcp/adapters/fastify', () => {
	beforeEach(() => _setSessionTableForTest(makeFakeTable()));
	afterEach(() => _setSessionTableForTest(undefined));

	it('forwards an initialize request and writes 200 + JSON body back to Fastify', async () => {
		const handler = createFastifyHandler('operations');
		const reply = makeReply();
		const request = {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } },
			hdb_user: { username: 'alice' },
		};
		await handler(request, reply);
		assert.equal(reply.statusCode, 200);
		assert.match(reply.headers['Mcp-Session-Id'], /^[0-9a-f-]{36}$/);
		assert.equal(reply.body.id, 1);
		assert.equal(reply.body.result.protocolVersion, '2025-06-18');
	});

	it('uses an empty username when hdb_user is absent', async () => {
		const handler = createFastifyHandler('operations');
		const reply = makeReply();
		await handler(
			{
				method: 'POST',
				headers: {},
				body: { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } },
			},
			reply
		);
		// Still succeeds — auth bypass is not this adapter's call to make. The
		// session ends up bound to user `""`. Upstream auth is the gate.
		assert.equal(reply.statusCode, 200);
	});

	it('handles a notification body (no JSON-RPC id) by sending 202 empty', async () => {
		const handler = createFastifyHandler('operations');
		// First, initialize a session.
		const initReply = makeReply();
		await handler(
			{
				method: 'POST',
				headers: {},
				body: { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } },
				hdb_user: { username: 'alice' },
			},
			initReply
		);
		const sessionId = initReply.headers['Mcp-Session-Id'];

		const notifReply = makeReply();
		await handler(
			{
				method: 'POST',
				headers: { 'mcp-session-id': sessionId, 'mcp-protocol-version': '2025-06-18' },
				body: { jsonrpc: '2.0', method: 'notifications/initialized' },
				hdb_user: { username: 'alice' },
			},
			notifReply
		);
		assert.equal(notifReply.statusCode, 202);
		assert.equal(notifReply.body, undefined);
		const session = await loadSession(sessionId);
		assert.equal(session.initialized, true);
	});

	it('normalizes header arrays (Fastify may emit an array for some headers)', async () => {
		const handler = createFastifyHandler('operations');
		const reply = makeReply();
		await handler(
			{
				method: 'POST',
				headers: { 'mcp-session-id': ['nope'] },
				body: { jsonrpc: '2.0', id: 1, method: 'tools/list' },
				hdb_user: { username: 'alice' },
			},
			reply
		);
		assert.equal(reply.statusCode, 404);
	});

	it('returns 400 on GET without an Mcp-Session-Id header', async () => {
		// GET is the server-push SSE channel (#619). Without a session id it
		// can't open a stream, so 400 — not 405. The 405-with-Allow happens
		// for genuinely unsupported methods (PUT, PATCH, ...).
		const handler = createFastifyHandler('operations');
		const reply = makeReply();
		await handler({ method: 'GET', headers: {}, hdb_user: { username: 'alice' } }, reply);
		assert.equal(reply.statusCode, 400);
	});
});
