const assert = require('node:assert/strict');
const rewire = require('rewire');
const transport_mod = rewire('#src/components/mcp/transport');
const { handleMcpRequest } = transport_mod;
const { _setSessionTableForTest, createSession, loadSession } = require('#src/components/mcp/session');
const { addTool, _resetRegistryForTest } = require('#src/components/mcp/toolRegistry');
const {
	_setResourcesForTest,
	_setOpenApiGeneratorForTest,
	_setHttpUrlPrefixForTest,
} = require('#src/components/mcp/resources');

function makeFakeResources(entries) {
	const map = new Map();
	for (const [path, ResourceClass] of entries) {
		map.set(path, { Resource: ResourceClass, path, exportTypes: {}, hasSubPaths: false, relativeURL: '' });
	}
	map.getMatch = (url) => {
		let best;
		for (const [p, entry] of map) {
			if (url === p || url.startsWith(p + '/')) {
				if (!best || p.length > best.path.length) best = entry;
			}
		}
		return best;
	};
	return map;
}

function makeFakeTable() {
	const store = new Map();
	return {
		store,
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

function makeReq(overrides = {}) {
	return {
		method: 'POST',
		headers: {},
		body: '{}',
		user: 'alice',
		profile: 'application',
		...overrides,
	};
}

function jsonRpc(id, method, params) {
	const msg = { jsonrpc: '2.0', method };
	if (id !== undefined) msg.id = id;
	if (params !== undefined) msg.params = params;
	return JSON.stringify(msg);
}

describe('mcp/transport', () => {
	let envOverrides;
	const envStub = {
		get(key) {
			return envOverrides[key];
		},
	};

	beforeEach(() => {
		envOverrides = {};
		transport_mod.__set__('env', envStub);
		_setSessionTableForTest(makeFakeTable());
		_resetRegistryForTest();
		_setResourcesForTest(makeFakeResources([]));
		_setOpenApiGeneratorForTest(() => ({ openapi: '3.0.3', info: { title: 'fake' }, paths: {} }));
		_setHttpUrlPrefixForTest('');
	});

	afterEach(() => {
		_setSessionTableForTest(undefined);
		_resetRegistryForTest();
		_setResourcesForTest(undefined);
		_setOpenApiGeneratorForTest(undefined);
		_setHttpUrlPrefixForTest(undefined);
	});

	describe('POST initialize', () => {
		it('creates a session and returns 200 + Mcp-Session-Id', async () => {
			const res = await handleMcpRequest(
				makeReq({
					body: jsonRpc(1, 'initialize', { protocolVersion: '2025-06-18' }),
				})
			);
			assert.equal(res.status, 200);
			assert.match(res.headers['Mcp-Session-Id'], /^[0-9a-f-]{36}$/);
			assert.equal(res.jsonBody.id, 1);
			assert.equal(res.jsonBody.result.protocolVersion, '2025-06-18');
			assert.equal(res.jsonBody.result.serverInfo.name, 'harper-mcp');
			assert.equal(res.jsonBody.result.capabilities.tools.listChanged, true);
		});

		it('negotiates an unsupported protocolVersion down to the preferred one (spec: MUST respond with a supported version)', async () => {
			const res = await handleMcpRequest(
				makeReq({
					body: jsonRpc(1, 'initialize', { protocolVersion: '1999-01-01' }),
				})
			);
			assert.equal(res.status, 200);
			assert.equal(res.jsonBody.result.protocolVersion, '2025-06-18');
			assert.ok(res.headers['Mcp-Session-Id'], 'session created on negotiated version');
		});

		it('rejects missing protocolVersion with 400', async () => {
			const res = await handleMcpRequest(makeReq({ body: jsonRpc(1, 'initialize') }));
			assert.equal(res.status, 400);
		});
	});

	describe('POST after initialize', () => {
		let sessionId;
		beforeEach(async () => {
			const res = await handleMcpRequest(
				makeReq({ body: jsonRpc(1, 'initialize', { protocolVersion: '2025-06-18' }) })
			);
			sessionId = res.headers['Mcp-Session-Id'];
		});

		it('returns 400 when Mcp-Session-Id header is missing', async () => {
			const res = await handleMcpRequest(
				makeReq({
					body: jsonRpc(2, 'tools/list'),
					headers: { 'mcp-protocol-version': '2025-06-18' },
				})
			);
			assert.equal(res.status, 400);
			assert.equal(res.jsonBody.error.code, -32600);
		});

		it('returns 404 when Mcp-Session-Id is unknown', async () => {
			const res = await handleMcpRequest(
				makeReq({
					body: jsonRpc(2, 'tools/list'),
					headers: { 'mcp-session-id': 'not-a-session', 'mcp-protocol-version': '2025-06-18' },
				})
			);
			assert.equal(res.status, 404);
		});

		it('returns 403 when session belongs to a different user', async () => {
			const res = await handleMcpRequest(
				makeReq({
					user: 'mallory',
					body: jsonRpc(2, 'tools/list'),
					headers: { 'mcp-session-id': sessionId, 'mcp-protocol-version': '2025-06-18' },
				})
			);
			assert.equal(res.status, 403);
		});

		it('returns 400 when MCP-Protocol-Version is unsupported', async () => {
			const res = await handleMcpRequest(
				makeReq({
					body: jsonRpc(2, 'tools/list'),
					headers: { 'mcp-session-id': sessionId, 'mcp-protocol-version': '1999-01-01' },
				})
			);
			assert.equal(res.status, 400);
		});

		it('returns 400 when MCP-Protocol-Version mismatches the session version', async () => {
			const res = await handleMcpRequest(
				makeReq({
					body: jsonRpc(2, 'tools/list'),
					headers: { 'mcp-session-id': sessionId, 'mcp-protocol-version': '2025-03-26' },
				})
			);
			assert.equal(res.status, 400);
			assert.match(res.jsonBody.error.message, /mismatch/);
		});

		it('treats missing MCP-Protocol-Version as 2025-03-26 (spec compatibility rule)', async () => {
			// Session is on 2025-06-18 from initialize above, so missing header
			// (treated as 2025-03-26) should mismatch.
			const res = await handleMcpRequest(
				makeReq({
					body: jsonRpc(2, 'tools/list'),
					headers: { 'mcp-session-id': sessionId },
				})
			);
			assert.equal(res.status, 400);
		});

		it('accepts a matching MCP-Protocol-Version and returns Method-not-found for unknown methods', async () => {
			const res = await handleMcpRequest(
				makeReq({
					body: jsonRpc(2, 'definitely/not/a/method'),
					headers: { 'mcp-session-id': sessionId, 'mcp-protocol-version': '2025-06-18' },
				})
			);
			assert.equal(res.status, 200);
			assert.equal(res.jsonBody.error.code, -32601);
			assert.match(res.jsonBody.error.message, /definitely\/not\/a\/method/);
		});

		it('returns 202 on notifications/initialized and flips session.initialized', async () => {
			const res = await handleMcpRequest(
				makeReq({
					body: jsonRpc(undefined, 'notifications/initialized'),
					headers: { 'mcp-session-id': sessionId, 'mcp-protocol-version': '2025-06-18' },
				})
			);
			assert.equal(res.status, 202);
			const session = await loadSession(sessionId);
			assert.equal(session.initialized, true);
		});

		it('returns 202 on any client notification', async () => {
			const res = await handleMcpRequest(
				makeReq({
					body: jsonRpc(undefined, 'notifications/cancelled'),
					headers: { 'mcp-session-id': sessionId, 'mcp-protocol-version': '2025-06-18' },
				})
			);
			assert.equal(res.status, 202);
		});

		it('returns 202 on a client response frame (result envelope)', async () => {
			const res = await handleMcpRequest(
				makeReq({
					body: JSON.stringify({ jsonrpc: '2.0', id: 99, result: 'ok' }),
					headers: { 'mcp-session-id': sessionId, 'mcp-protocol-version': '2025-06-18' },
				})
			);
			assert.equal(res.status, 202);
		});

		it('returns 400 PARSE_ERROR on invalid JSON', async () => {
			const res = await handleMcpRequest(
				makeReq({
					body: '{not json',
					headers: { 'mcp-session-id': sessionId, 'mcp-protocol-version': '2025-06-18' },
				})
			);
			assert.equal(res.status, 400);
			assert.equal(res.jsonBody.error.code, -32700);
		});

		describe('tools/list', () => {
			it('returns an empty list when no tools are registered', async () => {
				const res = await handleMcpRequest(
					makeReq({
						body: jsonRpc(7, 'tools/list'),
						headers: { 'mcp-session-id': sessionId, 'mcp-protocol-version': '2025-06-18' },
					})
				);
				assert.equal(res.status, 200);
				assert.deepEqual(res.jsonBody.result, { tools: [] });
			});

			it('returns registered tools for the matching profile only', async () => {
				addTool({
					name: 'app_tool',
					description: 'app',
					inputSchema: { type: 'object' },
					profile: 'application',
					visibleTo: () => true,
					handler: async () => ({ content: [{ type: 'text', text: 'ok' }] }),
				});
				addTool({
					name: 'ops_tool',
					description: 'ops',
					inputSchema: { type: 'object' },
					profile: 'operations',
					visibleTo: () => true,
					handler: async () => ({ content: [{ type: 'text', text: 'ok' }] }),
				});
				const res = await handleMcpRequest(
					makeReq({
						body: jsonRpc(7, 'tools/list'),
						headers: { 'mcp-session-id': sessionId, 'mcp-protocol-version': '2025-06-18' },
					})
				);
				assert.deepEqual(
					res.jsonBody.result.tools.map((t) => t.name),
					['app_tool']
				);
			});

			it('filters via visibleTo using the request user object', async () => {
				addTool({
					name: 'super_only',
					description: 'requires super_user',
					inputSchema: { type: 'object' },
					profile: 'application',
					visibleTo: (u) => u?.role?.permission?.super_user === true,
					handler: async () => ({ content: [{ type: 'text', text: 'ok' }] }),
				});
				const resNonSuper = await handleMcpRequest(
					makeReq({
						body: jsonRpc(8, 'tools/list'),
						headers: { 'mcp-session-id': sessionId, 'mcp-protocol-version': '2025-06-18' },
						userObject: { username: 'alice', role: { permission: {} } },
					})
				);
				assert.equal(resNonSuper.jsonBody.result.tools.length, 0);

				const resSuper = await handleMcpRequest(
					makeReq({
						body: jsonRpc(9, 'tools/list'),
						headers: { 'mcp-session-id': sessionId, 'mcp-protocol-version': '2025-06-18' },
						userObject: { username: 'alice', role: { permission: { super_user: true } } },
					})
				);
				assert.deepEqual(
					resSuper.jsonBody.result.tools.map((t) => t.name),
					['super_only']
				);
			});

			it('paginates via opaque nextCursor capped at the profile maxTools', async () => {
				envOverrides.mcp_application_maxTools = 2;
				for (let i = 0; i < 5; i++) {
					addTool({
						name: `tool_${i.toString().padStart(2, '0')}`,
						description: 't',
						inputSchema: { type: 'object' },
						profile: 'application',
						visibleTo: () => true,
						handler: async () => ({ content: [{ type: 'text', text: 'ok' }] }),
					});
				}
				const page1 = await handleMcpRequest(
					makeReq({
						body: jsonRpc(10, 'tools/list'),
						headers: { 'mcp-session-id': sessionId, 'mcp-protocol-version': '2025-06-18' },
					})
				);
				assert.equal(page1.jsonBody.result.tools.length, 2);
				assert.ok(page1.jsonBody.result.nextCursor);
				const page2 = await handleMcpRequest(
					makeReq({
						body: jsonRpc(11, 'tools/list', { cursor: page1.jsonBody.result.nextCursor }),
						headers: { 'mcp-session-id': sessionId, 'mcp-protocol-version': '2025-06-18' },
					})
				);
				assert.equal(page2.jsonBody.result.tools.length, 2);
				assert.notEqual(page1.jsonBody.result.tools[0].name, page2.jsonBody.result.tools[0].name);
			});

			it('omits nextCursor when the page completes the list', async () => {
				addTool({
					name: 'only',
					description: 'x',
					inputSchema: { type: 'object' },
					profile: 'application',
					visibleTo: () => true,
					handler: async () => ({ content: [{ type: 'text', text: 'ok' }] }),
				});
				const res = await handleMcpRequest(
					makeReq({
						body: jsonRpc(12, 'tools/list'),
						headers: { 'mcp-session-id': sessionId, 'mcp-protocol-version': '2025-06-18' },
					})
				);
				assert.equal(res.jsonBody.result.nextCursor, undefined);
			});

			it('rejects an invalid cursor with -32602 instead of silently returning page 1 (#1317 S2)', async () => {
				const res = await handleMcpRequest(
					makeReq({
						body: jsonRpc(13, 'tools/list', { cursor: 'not-a-real-cursor' }),
						headers: { 'mcp-session-id': sessionId, 'mcp-protocol-version': '2025-06-18' },
					})
				);
				assert.equal(res.status, 200);
				assert.equal(res.jsonBody.error.code, -32602);
				assert.equal(res.jsonBody.result, undefined);
			});
		});

		describe('tools/call', () => {
			beforeEach(() => {
				addTool({
					name: 'echo',
					description: 'echoes args back',
					inputSchema: { type: 'object', properties: { msg: { type: 'string' } } },
					profile: 'application',
					visibleTo: () => true,
					handler: async (args) => ({ content: [{ type: 'text', text: `you sent ${JSON.stringify(args)}` }] }),
				});
			});

			it('dispatches to the registered handler and returns the tool result', async () => {
				const res = await handleMcpRequest(
					makeReq({
						body: jsonRpc(20, 'tools/call', { name: 'echo', arguments: { msg: 'hi' } }),
						headers: { 'mcp-session-id': sessionId, 'mcp-protocol-version': '2025-06-18' },
					})
				);
				assert.equal(res.status, 200);
				assert.equal(res.jsonBody.id, 20);
				assert.equal(res.jsonBody.result.content[0].text, 'you sent {"msg":"hi"}');
			});

			it('returns -32601 when the tool is unknown', async () => {
				const res = await handleMcpRequest(
					makeReq({
						body: jsonRpc(21, 'tools/call', { name: 'no_such_tool' }),
						headers: { 'mcp-session-id': sessionId, 'mcp-protocol-version': '2025-06-18' },
					})
				);
				assert.equal(res.status, 200);
				assert.equal(res.jsonBody.error.code, -32601);
			});

			it('returns -32601 when the tool belongs to a different profile', async () => {
				addTool({
					name: 'ops_only',
					description: 'x',
					inputSchema: { type: 'object' },
					profile: 'operations',
					visibleTo: () => true,
					handler: async () => ({ content: [{ type: 'text', text: 'ok' }] }),
				});
				const res = await handleMcpRequest(
					makeReq({
						body: jsonRpc(22, 'tools/call', { name: 'ops_only' }),
						headers: { 'mcp-session-id': sessionId, 'mcp-protocol-version': '2025-06-18' },
					})
				);
				assert.equal(res.jsonBody.error.code, -32601);
			});

			it('returns -32602 when params.name is missing or non-string', async () => {
				const res = await handleMcpRequest(
					makeReq({
						body: jsonRpc(23, 'tools/call', { arguments: {} }),
						headers: { 'mcp-session-id': sessionId, 'mcp-protocol-version': '2025-06-18' },
					})
				);
				assert.equal(res.jsonBody.error.code, -32602);
			});

			it('maps handler exceptions to result.isError=true (not a JSON-RPC error)', async () => {
				addTool({
					name: 'boom',
					description: 'always throws',
					inputSchema: { type: 'object' },
					profile: 'application',
					visibleTo: () => true,
					handler: async () => {
						throw new Error('something broke inside the handler');
					},
				});
				const res = await handleMcpRequest(
					makeReq({
						body: jsonRpc(24, 'tools/call', { name: 'boom' }),
						headers: { 'mcp-session-id': sessionId, 'mcp-protocol-version': '2025-06-18' },
					})
				);
				assert.equal(res.status, 200);
				assert.equal(res.jsonBody.error, undefined);
				assert.equal(res.jsonBody.result.isError, true);
				const payload = JSON.parse(res.jsonBody.result.content[0].text);
				assert.equal(payload.kind, 'harper_error');
				assert.match(payload.message, /something broke/);
			});

			it('passes through to the handler even when visibleTo would return false (security boundary is in the handler, not the filter)', async () => {
				// Per the design doc (#465 "Tool-list filtering"), `visibleTo`
				// controls UX (what shows up in tools/list) but is NOT a
				// security boundary. Real enforcement is `transactional()` +
				// `allow{Read,Create,Update,Delete}` in the handler. This test
				// documents the intentional pass-through so a future change
				// that adds visibleTo to the call path is caught.
				let handlerCalled = false;
				addTool({
					name: 'hidden_from_list',
					description:
						'visible-to=false; the LLM should never see this in list, but a hallucinated call still reaches the handler',
					inputSchema: { type: 'object' },
					profile: 'application',
					visibleTo: () => false,
					handler: async () => {
						handlerCalled = true;
						return { content: [{ type: 'text', text: 'handler was reached' }] };
					},
				});
				const res = await handleMcpRequest(
					makeReq({
						body: jsonRpc(26, 'tools/call', { name: 'hidden_from_list' }),
						headers: { 'mcp-session-id': sessionId, 'mcp-protocol-version': '2025-06-18' },
					})
				);
				assert.equal(handlerCalled, true);
				assert.equal(res.status, 200);
				assert.equal(res.jsonBody.result.content[0].text, 'handler was reached');
			});

			it('passes args and context (user, profile, sessionId) to the handler', async () => {
				let received;
				addTool({
					name: 'spy',
					description: 'spies on context',
					inputSchema: { type: 'object' },
					profile: 'application',
					visibleTo: () => true,
					handler: async (args, ctx) => {
						received = { args, ctx };
						return { content: [{ type: 'text', text: 'ok' }] };
					},
				});
				await handleMcpRequest(
					makeReq({
						body: jsonRpc(25, 'tools/call', { name: 'spy', arguments: { x: 1 } }),
						headers: { 'mcp-session-id': sessionId, 'mcp-protocol-version': '2025-06-18' },
						userObject: { username: 'alice', role: { permission: { super_user: true } } },
					})
				);
				assert.deepEqual(received.args, { x: 1 });
				assert.equal(received.ctx.profile, 'application');
				assert.equal(received.ctx.sessionId, sessionId);
				assert.equal(received.ctx.user.username, 'alice');
				assert.equal(received.ctx.user.role.permission.super_user, true);
			});
		});

		describe('resources/list', () => {
			it('returns synthetic harper:// URIs as a baseline', async () => {
				const res = await handleMcpRequest(
					makeReq({
						body: jsonRpc(30, 'resources/list'),
						headers: { 'mcp-session-id': sessionId, 'mcp-protocol-version': '2025-06-18' },
					})
				);
				assert.equal(res.status, 200);
				const uris = res.jsonBody.result.resources.map((r) => r.uri);
				assert.ok(uris.includes('harper://about'));
				assert.ok(uris.includes('harper://openapi')); // application profile
			});

			it('paginates via opaque cursor', async () => {
				// Stuff in enough table resources to need paging.
				const entries = [];
				for (let i = 0; i < 5; i++) {
					entries.push([`Table${i}`, { databaseName: 'data', tableName: `t${i}`, attributes: [{ name: 'id' }] }]);
				}
				_setResourcesForTest(makeFakeResources(entries));
				const superUser = { username: 'alice', role: { permission: { super_user: true } } };
				// Page 1
				const page1 = await handleMcpRequest(
					makeReq({
						body: jsonRpc(31, 'resources/list'),
						headers: { 'mcp-session-id': sessionId, 'mcp-protocol-version': '2025-06-18' },
						userObject: superUser,
					})
				);
				assert.equal(page1.status, 200);
				// Default page size is 200, so everything fits in one page; just verify shape.
				assert.ok(Array.isArray(page1.jsonBody.result.resources));
				assert.equal(page1.jsonBody.result.nextCursor, undefined);
			});

			it('rejects an invalid cursor with -32602 (#1317 S2)', async () => {
				const res = await handleMcpRequest(
					makeReq({
						body: jsonRpc(35, 'resources/list', { cursor: 'not-a-real-cursor' }),
						headers: { 'mcp-session-id': sessionId, 'mcp-protocol-version': '2025-06-18' },
					})
				);
				assert.equal(res.status, 200);
				assert.equal(res.jsonBody.error.code, -32602);
				assert.equal(res.jsonBody.result, undefined);
			});
		});

		describe('resources/templates/list', () => {
			it('returns the application URI templates', async () => {
				const res = await handleMcpRequest(
					makeReq({
						body: jsonRpc(32, 'resources/templates/list'),
						headers: { 'mcp-session-id': sessionId, 'mcp-protocol-version': '2025-06-18' },
					})
				);
				assert.equal(res.status, 200);
				const templates = res.jsonBody.result.resourceTemplates;
				assert.ok(Array.isArray(templates));
				assert.ok(templates.some((t) => t.uriTemplate === 'harper://schema/{database}/{table}'));
			});
		});

		describe('resources/read', () => {
			it('returns the harper://about body', async () => {
				const res = await handleMcpRequest(
					makeReq({
						body: jsonRpc(33, 'resources/read', { uri: 'harper://about' }),
						headers: { 'mcp-session-id': sessionId, 'mcp-protocol-version': '2025-06-18' },
					})
				);
				assert.equal(res.status, 200);
				const body = JSON.parse(res.jsonBody.result.contents[0].text);
				assert.equal(body.serverInfo.name, 'harper-mcp');
				assert.equal(body.profile, 'application');
			});

			it('returns -32602 when params.uri is missing', async () => {
				const res = await handleMcpRequest(
					makeReq({
						body: jsonRpc(34, 'resources/read'),
						headers: { 'mcp-session-id': sessionId, 'mcp-protocol-version': '2025-06-18' },
					})
				);
				assert.equal(res.jsonBody.error.code, -32602);
			});

			it('returns -32601 when the resource is not found', async () => {
				const superUser = { username: 'alice', role: { permission: { super_user: true } } };
				_setHttpUrlPrefixForTest('https://harper.example.com:9926');
				const res = await handleMcpRequest(
					makeReq({
						body: jsonRpc(35, 'resources/read', { uri: 'https://harper.example.com:9926/Ghost' }),
						headers: { 'mcp-session-id': sessionId, 'mcp-protocol-version': '2025-06-18' },
						userObject: superUser,
					})
				);
				assert.equal(res.jsonBody.error.code, -32601);
				assert.match(res.jsonBody.error.message, /no resource matches/);
			});

			it('returns -32602 for permission denied / invalid input', async () => {
				const res = await handleMcpRequest(
					makeReq({
						body: jsonRpc(36, 'resources/read', { uri: 'harper://operations' }),
						headers: { 'mcp-session-id': sessionId, 'mcp-protocol-version': '2025-06-18' },
					})
				);
				// Application profile rejecting harper://operations → -32602.
				assert.equal(res.jsonBody.error.code, -32602);
			});
		});
	});

	describe('GET /mcp', () => {
		it('returns 400 when no Mcp-Session-Id header is present', async () => {
			const res = await handleMcpRequest(makeReq({ method: 'GET' }));
			assert.equal(res.status, 400);
		});

		it('returns 404 when the session id is unknown', async () => {
			const res = await handleMcpRequest(
				makeReq({ method: 'GET', headers: { 'mcp-session-id': 'not-a-real-session' } })
			);
			assert.equal(res.status, 404);
		});

		it('returns 403 when the session belongs to a different user', async () => {
			const session = await createSession({ user: 'alice', protocolVersion: '2025-06-18' });
			const res = await handleMcpRequest(
				makeReq({
					method: 'GET',
					user: 'bob',
					headers: { 'mcp-session-id': session.id, 'mcp-protocol-version': '2025-06-18' },
				})
			);
			assert.equal(res.status, 403);
		});

		it('opens an SSE channel for an authenticated session', async () => {
			const session = await createSession({ user: 'alice', protocolVersion: '2025-06-18' });
			const res = await handleMcpRequest(
				makeReq({
					method: 'GET',
					headers: { 'mcp-session-id': session.id, 'mcp-protocol-version': '2025-06-18' },
				})
			);
			assert.equal(res.status, 200);
			assert.equal(res.headers['Content-Type'], 'text/event-stream');
			assert.ok(res.sseIterable, 'sseIterable returned for the SSE channel');
		});
	});

	describe('DELETE /mcp', () => {
		it('returns 405 when allowClientDelete is not configured', async () => {
			const res = await handleMcpRequest(makeReq({ method: 'DELETE' }));
			assert.equal(res.status, 405);
			// GET is always allowed (server-push channel). DELETE listed iff allowClientDelete.
			assert.equal(res.headers.Allow, 'POST, GET');
		});

		it('terminates the session and returns 204 when allowClientDelete is true', async () => {
			envOverrides.mcp_session_allowClientDelete = true;
			const session = await createSession({ user: 'alice', protocolVersion: '2025-06-18' });
			const res = await handleMcpRequest(makeReq({ method: 'DELETE', headers: { 'mcp-session-id': session.id } }));
			assert.equal(res.status, 204);
			assert.equal(await loadSession(session.id), null);
		});

		it('returns 400 when allowClientDelete is true but session-id is missing', async () => {
			envOverrides.mcp_session_allowClientDelete = true;
			const res = await handleMcpRequest(makeReq({ method: 'DELETE' }));
			assert.equal(res.status, 400);
		});

		it('returns 404 when session-id is unknown', async () => {
			envOverrides.mcp_session_allowClientDelete = true;
			const res = await handleMcpRequest(makeReq({ method: 'DELETE', headers: { 'mcp-session-id': 'nope' } }));
			assert.equal(res.status, 404);
		});

		it('returns 403 when session belongs to a different user', async () => {
			envOverrides.mcp_session_allowClientDelete = true;
			const session = await createSession({ user: 'alice', protocolVersion: '2025-06-18' });
			const res = await handleMcpRequest(
				makeReq({ method: 'DELETE', user: 'mallory', headers: { 'mcp-session-id': session.id } })
			);
			assert.equal(res.status, 403);
		});
	});

	describe('Origin validation', () => {
		it('accepts any Origin when allow-list is empty/unset', async () => {
			const res = await handleMcpRequest(
				makeReq({
					body: jsonRpc(1, 'initialize', { protocolVersion: '2025-06-18' }),
					headers: { origin: 'https://anywhere.example.com' },
				})
			);
			assert.equal(res.status, 200);
		});

		it('accepts when Origin is missing (curl, server-to-server)', async () => {
			envOverrides.http_corsAccessList = ['https://app.example.com'];
			const res = await handleMcpRequest(
				makeReq({
					body: jsonRpc(1, 'initialize', { protocolVersion: '2025-06-18' }),
				})
			);
			assert.equal(res.status, 200);
		});

		it('accepts any Origin when CORS is enabled but allow-list is empty', async () => {
			envOverrides.http_cors = true;
			envOverrides.http_corsAccessList = [];
			const res = await handleMcpRequest(
				makeReq({
					body: jsonRpc(1, 'initialize', { protocolVersion: '2025-06-18' }),
					headers: { origin: 'https://anywhere.example.com' },
				})
			);
			assert.equal(res.status, 200);
		});

		it('accepts any Origin when CORS is disabled even if allow-list is set', async () => {
			envOverrides.http_cors = false;
			envOverrides.http_corsAccessList = ['https://only-me.example.com'];
			const res = await handleMcpRequest(
				makeReq({
					body: jsonRpc(1, 'initialize', { protocolVersion: '2025-06-18' }),
					headers: { origin: 'https://evil.example.com' },
				})
			);
			assert.equal(res.status, 200);
		});

		it('returns 403 when CORS is enabled and Origin is not in the allow-list', async () => {
			envOverrides.http_cors = true;
			envOverrides.http_corsAccessList = ['https://app.example.com'];
			const res = await handleMcpRequest(
				makeReq({
					body: jsonRpc(1, 'initialize', { protocolVersion: '2025-06-18' }),
					headers: { origin: 'https://evil.example.com' },
				})
			);
			assert.equal(res.status, 403);
		});

		it('uses the operations CORS list for the operations profile', async () => {
			envOverrides.operationsApi_network_cors = true;
			envOverrides.operationsApi_network_corsAccessList = ['https://ops.example.com'];
			const res = await handleMcpRequest(
				makeReq({
					profile: 'operations',
					body: jsonRpc(1, 'initialize', { protocolVersion: '2025-06-18' }),
					headers: { origin: 'https://app.example.com' }, // app list, not ops
				})
			);
			assert.equal(res.status, 403);
		});

		it('accepts Origin in the allow-list', async () => {
			envOverrides.http_cors = true;
			envOverrides.http_corsAccessList = ['https://app.example.com'];
			const res = await handleMcpRequest(
				makeReq({
					body: jsonRpc(1, 'initialize', { protocolVersion: '2025-06-18' }),
					headers: { origin: 'https://app.example.com' },
				})
			);
			assert.equal(res.status, 200);
		});

		it('honors the "*" wildcard in the allow-list', async () => {
			envOverrides.http_cors = true;
			envOverrides.http_corsAccessList = ['*'];
			const res = await handleMcpRequest(
				makeReq({
					body: jsonRpc(1, 'initialize', { protocolVersion: '2025-06-18' }),
					headers: { origin: 'https://anywhere.example.com' },
				})
			);
			assert.equal(res.status, 200);
		});
	});

	describe('Accept content negotiation (#1317 S3)', () => {
		it('allows POST when Accept is absent (treated as */*)', async () => {
			const res = await handleMcpRequest(
				makeReq({ body: jsonRpc(1, 'initialize', { protocolVersion: '2025-06-18' }) })
			);
			assert.equal(res.status, 200);
		});

		it('allows POST when Accept includes application/json', async () => {
			const res = await handleMcpRequest(
				makeReq({
					body: jsonRpc(1, 'initialize', { protocolVersion: '2025-06-18' }),
					headers: { accept: 'application/json, text/event-stream' },
				})
			);
			assert.equal(res.status, 200);
		});

		it('allows POST when Accept is a wildcard', async () => {
			const res = await handleMcpRequest(
				makeReq({
					body: jsonRpc(1, 'initialize', { protocolVersion: '2025-06-18' }),
					headers: { accept: 'application/*' },
				})
			);
			assert.equal(res.status, 200);
		});

		it('returns 406 for POST when Accept is present and excludes application/json', async () => {
			const res = await handleMcpRequest(
				makeReq({
					body: jsonRpc(1, 'initialize', { protocolVersion: '2025-06-18' }),
					headers: { accept: 'text/plain' },
				})
			);
			assert.equal(res.status, 406);
		});

		it('returns 406 for GET when Accept excludes text/event-stream', async () => {
			const res = await handleMcpRequest(makeReq({ method: 'GET', headers: { accept: 'application/json' } }));
			assert.equal(res.status, 406);
		});
	});

	describe('unsupported HTTP methods', () => {
		it('returns 405 for PUT with accurate Allow header', async () => {
			const res = await handleMcpRequest(makeReq({ method: 'PUT' }));
			assert.equal(res.status, 405);
			assert.equal(res.headers.Allow, 'POST, GET');
		});

		it('PUT 405 advertises DELETE when allowClientDelete is enabled', async () => {
			envOverrides.mcp_session_allowClientDelete = true;
			const res = await handleMcpRequest(makeReq({ method: 'PUT' }));
			assert.equal(res.status, 405);
			assert.equal(res.headers.Allow, 'POST, GET, DELETE');
		});
	});
});
