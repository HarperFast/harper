const assert = require('node:assert/strict');
const { Readable } = require('node:stream');
const { createHarperHttpHandler } = require('#src/components/mcp/adapters/harperHttp');
const { _setSessionTableForTest, loadSession } = require('#src/components/mcp/session');
const { Headers } = require('#src/server/serverHelpers/Headers');

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

function makeHeaders(init = {}) {
	const h = new Headers();
	for (const [k, v] of Object.entries(init)) h.set(k, v);
	return h;
}

function bodyStream(text) {
	return Readable.from([Buffer.from(text, 'utf8')]);
}

async function next() {
	return undefined;
}

describe('mcp/adapters/harperHttp', () => {
	beforeEach(() => _setSessionTableForTest(makeFakeTable()));
	afterEach(() => _setSessionTableForTest(undefined));

	it('handles an initialize request and returns 200 + JSON body + Mcp-Session-Id', async () => {
		const handler = createHarperHttpHandler('application');
		const result = await handler(
			{
				method: 'POST',
				headers: makeHeaders({ 'content-type': 'application/json' }),
				body: bodyStream(
					JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } })
				),
				user: { username: 'alice' },
			},
			next
		);
		assert.equal(result.status, 200);
		assert.match(result.headers['Mcp-Session-Id'], /^[0-9a-f-]{36}$/);
		assert.equal(result.headers['Content-Type'], 'application/json');
		const parsed = JSON.parse(result.body);
		assert.equal(parsed.id, 1);
		assert.equal(parsed.result.protocolVersion, '2025-06-18');
	});

	it('hands off WebSocket-upgrade requests to the next handler', async () => {
		const handler = createHarperHttpHandler('application');
		const out = await handler(
			{
				method: 'GET',
				headers: makeHeaders(),
				isWebSocket: true,
				user: { username: 'alice' },
			},
			() => 'next-handler-result'
		);
		assert.equal(out, 'next-handler-result');
	});

	it('reads chunked body streams (Buffer + string mix)', async () => {
		const handler = createHarperHttpHandler('application');
		const body = Readable.from([
			Buffer.from('{"jsonrpc":"2.0",', 'utf8'),
			'"id":1,"method":"initialize",',
			Buffer.from('"params":{"protocolVersion":"2025-06-18"}}', 'utf8'),
		]);
		const result = await handler({ method: 'POST', headers: makeHeaders(), body, user: { username: 'alice' } }, next);
		assert.equal(result.status, 200);
	});

	it('flips session.initialized via notifications/initialized', async () => {
		const handler = createHarperHttpHandler('application');
		const initResult = await handler(
			{
				method: 'POST',
				headers: makeHeaders(),
				body: bodyStream(
					JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } })
				),
				user: { username: 'alice' },
			},
			next
		);
		const sessionId = initResult.headers['Mcp-Session-Id'];

		const notifResult = await handler(
			{
				method: 'POST',
				headers: makeHeaders({ 'mcp-session-id': sessionId, 'mcp-protocol-version': '2025-06-18' }),
				body: bodyStream(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })),
				user: { username: 'alice' },
			},
			next
		);
		assert.equal(notifResult.status, 202);
		assert.equal(notifResult.body, undefined);
		const session = await loadSession(sessionId);
		assert.equal(session.initialized, true);
	});

	it('returns 400 on GET without an Mcp-Session-Id (SSE channel landed in #619)', async () => {
		const handler = createHarperHttpHandler('application');
		const result = await handler({ method: 'GET', headers: makeHeaders(), user: { username: 'alice' } }, next);
		assert.equal(result.status, 400);
	});

	it('returns empty body (no JSON.stringify) for 202/204', async () => {
		const handler = createHarperHttpHandler('application');
		const initResult = await handler(
			{
				method: 'POST',
				headers: makeHeaders(),
				body: bodyStream(
					JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } })
				),
				user: { username: 'alice' },
			},
			next
		);
		const sessionId = initResult.headers['Mcp-Session-Id'];
		const notif = await handler(
			{
				method: 'POST',
				headers: makeHeaders({ 'mcp-session-id': sessionId, 'mcp-protocol-version': '2025-06-18' }),
				body: bodyStream(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/cancelled' })),
				user: { username: 'alice' },
			},
			next
		);
		assert.equal(notif.status, 202);
		assert.equal(notif.body, undefined);
	});
});
