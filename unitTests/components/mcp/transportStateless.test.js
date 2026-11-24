const assert = require('node:assert');
const { handleMcpRequest } = require('#src/components/mcp/transport');
const { _setSessionTableForTest } = require('#src/components/mcp/session');
const { addTool, _resetRegistryForTest } = require('#src/components/mcp/toolRegistry');
const { addPrompt, _resetPromptRegistryForTest } = require('#src/components/mcp/promptRegistry');
const { setMcpQuotaHandler } = require('#src/components/mcp/quota');
const { _resetForTest: resetRateLimits } = require('#src/components/mcp/rateLimit');
const { _sessionRegistrySize } = require('#src/components/mcp/sessionRegistry');
const { _inflightCallCount } = require('#src/components/mcp/callRegistry');
const env = require('#src/utility/environment/environmentManager');
const { CONFIG_PARAMS } = require('#src/utility/hdbTerms');

const untouchableSessionTable = new Proxy(
	{},
	{
		get(_target, property) {
			throw new Error(`stateless request touched the session table (${String(property)})`);
		},
	}
);

function request(overrides = {}) {
	return {
		method: 'POST',
		headers: {},
		body: '{}',
		user: 'alice',
		profile: 'application',
		stateless: true,
		...overrides,
	};
}

function rpc(id, method, params) {
	const message = { jsonrpc: '2.0', method };
	if (id !== undefined) message.id = id;
	if (params !== undefined) message.params = params;
	return JSON.stringify(message);
}

// .mocharc.json disables timeouts, so a stream that never closes would hang the run
function collectFrames(queue, ms = 5_000) {
	return new Promise((resolve, reject) => {
		const frames = [];
		const timer = setTimeout(() => reject(new Error(`stream did not close within ${ms}ms`)), ms);
		queue.on('data', (frame) => frames.push(frame.data));
		queue.once('close', () => {
			clearTimeout(timer);
			resolve(frames);
		});
	});
}

describe('mcp/transport stateless application profile (#4346)', () => {
	let contexts;
	beforeEach(() => {
		contexts = [];
		resetRateLimits();
		_resetRegistryForTest();
		_resetPromptRegistryForTest();
		_setSessionTableForTest(untouchableSessionTable);
		addTool({
			name: 'probe',
			description: 'records its context',
			inputSchema: { type: 'object' },
			profile: 'application',
			visibleTo: () => true,
			handler: async (_args, context) => {
				contexts.push(context);
				context.progress?.({ progress: 1 });
				return { content: [{ type: 'text', text: 'ok' }] };
			},
		});
	});
	afterEach(() => {
		_setSessionTableForTest(undefined);
		_resetRegistryForTest();
		_resetPromptRegistryForTest();
		setMcpQuotaHandler(undefined);
		resetRateLimits();
		env.setProperty(CONFIG_PARAMS.MCP_APPLICATION_RATELIMIT_PERTOOLBURST, undefined);
	});

	it('initializes without a session id, writing nothing, and advertises no session-bound capability', async () => {
		const response = await handleMcpRequest(request({ body: rpc(1, 'initialize', { protocolVersion: '2025-06-18' }) }));

		assert.equal(response.status, 200);
		assert.equal(response.headers['Mcp-Session-Id'], undefined);
		assert.equal(response.jsonBody.result.protocolVersion, '2025-06-18');
		assert.deepEqual(response.jsonBody.result.capabilities, {
			tools: {},
			resources: {},
			prompts: {},
			completions: {},
		});
	});

	it('serves tools/list and tools/call with no Mcp-Session-Id, and ignores a leftover one', async () => {
		for (const headers of [{}, { 'mcp-session-id': 'from-a-stateful-node' }]) {
			const list = await handleMcpRequest(request({ headers, body: rpc(2, 'tools/list') }));
			assert.equal(list.status, 200);
			assert.deepEqual(
				list.jsonBody.result.tools.map((tool) => tool.name),
				['probe']
			);

			const call = await handleMcpRequest(request({ headers, body: rpc(3, 'tools/call', { name: 'probe' }) }));
			assert.equal(call.status, 200);
			assert.equal(call.jsonBody.result.content[0].text, 'ok');
		}
		assert.equal(contexts.length, 2);
		for (const context of contexts) {
			assert.equal(context.sessionId, undefined);
			assert.equal(context.serverRequest, undefined);
		}
		assert.equal(_inflightCallCount(), 0);
	});

	it('streams a call without offering server-to-client requests', async () => {
		const response = await handleMcpRequest(
			request({
				headers: { accept: 'application/json, text/event-stream' },
				body: rpc(4, 'tools/call', { name: 'probe', _meta: { progressToken: 'p' } }),
			})
		);
		const frames = await collectFrames(response.sseIterable);

		assert.equal(frames[0].method, 'notifications/progress');
		assert.equal(frames[1].result.content[0].text, 'ok');
		assert.equal(contexts[0].serverRequest, undefined);
		assert.equal(contexts[0].sessionId, undefined);
	});

	it('accepts any supported MCP-Protocol-Version and refuses an unsupported one', async () => {
		for (const version of [undefined, '2025-06-18', '2025-03-26']) {
			const headers = version ? { 'mcp-protocol-version': version } : {};
			const response = await handleMcpRequest(request({ headers, body: rpc(5, 'ping') }));
			assert.equal(response.status, 200, String(version));
			assert.deepEqual(response.jsonBody.result, {});
		}
		const refused = await handleMcpRequest(
			request({ headers: { 'mcp-protocol-version': '1999-01-01' }, body: rpc(6, 'ping') })
		);
		assert.equal(refused.status, 400);
		assert.match(refused.jsonBody.error.message, /unsupported MCP-Protocol-Version/);
	});

	it('answers session-only methods with method-not-found', async () => {
		for (const [method, params] of [
			['resources/subscribe', { uri: 'harper://x' }],
			['resources/unsubscribe', { uri: 'harper://x' }],
			['logging/setLevel', { level: 'info' }],
		]) {
			const response = await handleMcpRequest(request({ body: rpc(7, method, params) }));
			assert.equal(response.status, 200, method);
			assert.equal(response.jsonBody.error.code, -32601, method);
			assert.match(response.jsonBody.error.message, /stateless/, method);
		}
	});

	it('accepts notifications and client responses with 202 and no effect', async () => {
		for (const body of [
			rpc(undefined, 'notifications/initialized'),
			rpc(undefined, 'notifications/cancelled', { requestId: 3 }),
			JSON.stringify({ jsonrpc: '2.0', id: 'srv-1', result: {} }),
		]) {
			const response = await handleMcpRequest(request({ body }));
			assert.equal(response.status, 202, body);
		}
	});

	it('answers GET and DELETE with 405 Allow: POST, opening no stream', async () => {
		for (const method of ['GET', 'DELETE']) {
			const response = await handleMcpRequest(
				request({ method, headers: { 'accept': 'text/event-stream', 'mcp-session-id': 'x' } })
			);
			assert.equal(response.status, 405, method);
			assert.equal(response.headers.Allow, 'POST', method);
		}
		assert.equal(_sessionRegistrySize(), 0);
	});

	it('passes no session id to prompt renders and the quota handler', async () => {
		let renderContext;
		addPrompt({
			name: 'hello',
			profile: 'application',
			render: (_args, context) => {
				renderContext = context;
				return { messages: [] };
			},
		});
		const quotaCalls = [];
		setMcpQuotaHandler((info) => {
			quotaCalls.push(info);
			return true;
		});

		await handleMcpRequest(request({ body: rpc(8, 'prompts/get', { name: 'hello' }) }));
		await handleMcpRequest(request({ clientIp: '10.0.0.1', body: rpc(9, 'tools/call', { name: 'probe' }) }));

		assert.ok(renderContext);
		assert.equal(renderContext.sessionId, undefined);
		assert.equal(quotaCalls.length, 1);
		assert.equal(quotaCalls[0].sessionId, undefined);
		assert.equal(quotaCalls[0].identity, '10.0.0.1');
	});

	it('keys the per-session rate limits on the principal and client address', async () => {
		env.setProperty(CONFIG_PARAMS.MCP_APPLICATION_RATELIMIT_PERTOOLBURST, 1);
		const call = (user, clientIp) =>
			handleMcpRequest(request({ user, clientIp, body: rpc(10, 'tools/call', { name: 'probe' }) }));
		const limited = (response) =>
			response.jsonBody.result.isError === true &&
			JSON.parse(response.jsonBody.result.content[0].text).kind === 'rate_limited';

		assert.equal(limited(await call('alice', '10.0.0.1')), false);
		assert.equal(
			limited(await call('alice', '10.0.0.1')),
			true,
			'the same principal from the same address shares a bucket'
		);
		assert.equal(limited(await call('bob', '10.0.0.1')), false, 'another principal has its own bucket');
		assert.equal(limited(await call('alice', '10.0.0.2')), false, 'another address has its own bucket');
	});
});
