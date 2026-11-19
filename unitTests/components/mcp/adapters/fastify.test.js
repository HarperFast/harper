const assert = require('node:assert');
const { createFastifyHandler } = require('#src/components/mcp/adapters/fastify');
const { _setSessionTableForTest, loadSession } = require('#src/components/mcp/session');
const { _resetForTest, _setClockForTest } = require('#src/components/mcp/rateLimit');
const env = require('#js/utility/environment/environmentManager');

function makeFakeTable() {
	const store = new Map();
	return {
		async put(record) {
			store.set(record.id, { ...record });
		},
		async patch(record) {
			store.set(record.id, { ...store.get(record.id), ...record });
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

	describe('initialize identity is the client address, not Fastify request.ip', () => {
		const originalEnvGet = env.get;
		const ADDRESS_HEADER = 'x-harper-internal-client-address';
		beforeEach(() => {
			_resetForTest();
			_setClockForTest(() => 0);
			env.get = (key) => (key === 'mcp_operations_rateLimit_initializeBurst' ? 1 : originalEnvGet.call(env, key));
		});
		afterEach(() => {
			env.get = originalEnvGet;
			_setClockForTest(undefined);
			_resetForTest();
		});

		async function initialize(transport) {
			const reply = makeReply();
			await createFastifyHandler('operations')(
				{
					method: 'POST',
					headers: { 'content-type': 'application/json', ...transport.headers },
					body: { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } },
					hdb_user: { username: 'alice' },
					raw: transport.raw,
					ip: transport.ip,
				},
				reply
			);
			return reply.statusCode;
		}
		// Bun and uWS: light-my-request reports 127.0.0.1 for every request; the bridge sets the header
		const injected = (address) => ({ raw: {}, ip: '127.0.0.1', headers: address ? { [ADDRESS_HEADER]: address } : {} });
		// a client-supplied header reaches Fastify unstripped on Node
		const node = (address, forged) => ({
			raw: { baseRequest: { ip: address } },
			ip: address,
			headers: { [ADDRESS_HEADER]: forged },
		});

		it('gives each injected address its own bucket', async () => {
			assert.equal(await initialize(injected('203.0.113.1')), 200);
			assert.equal(await initialize(injected('203.0.113.1')), 429);
			assert.equal(await initialize(injected('203.0.113.2')), 200);
		});

		it('keys a Node request on its own address, ignoring the header beside it', async () => {
			assert.equal(await initialize(node('203.0.113.3', '198.51.100.1')), 200);
			assert.equal(await initialize(node('203.0.113.3', '198.51.100.2')), 429);
		});

		it('puts injected requests with no address in the shared bucket, apart from known addresses', async () => {
			assert.equal(await initialize(injected(undefined)), 200);
			assert.equal(await initialize(injected(undefined)), 429);
			assert.equal(await initialize(injected('127.0.0.1')), 200);
		});
	});
});
