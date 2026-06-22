const assert = require('node:assert/strict');
const rewire = require('rewire');
const transport_mod = rewire('#src/components/mcp/transport');
const { handleMcpRequest } = transport_mod;
const { _setSessionTableForTest, createSession, loadSession, saveSession } = require('#src/components/mcp/session');
const {
	getRegisteredSession,
	pushSessionFrame,
	registerSession,
	_resetSessionRegistryForTest,
} = require('#src/components/mcp/sessionRegistry');
const { addTool, _resetRegistryForTest } = require('#src/components/mcp/toolRegistry');
const { addPrompt, _resetPromptRegistryForTest } = require('#src/components/mcp/promptRegistry');
const {
	_setItcForTest,
	_resetServerRequestsForTest,
	_pendingServerRequestCount,
} = require('#src/components/mcp/serverRequests');
const {
	_setResourcesForTest,
	_setOpenApiGeneratorForTest,
	_setHttpUrlPrefixForTest,
	_setSubscribeImplForTest,
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
		_resetPromptRegistryForTest();
		_setResourcesForTest(makeFakeResources([]));
		_setOpenApiGeneratorForTest(() => ({ openapi: '3.0.3', info: { title: 'fake' }, paths: {} }));
		_setHttpUrlPrefixForTest('');
	});

	afterEach(() => {
		_setSessionTableForTest(undefined);
		_resetRegistryForTest();
		_resetPromptRegistryForTest();
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

		it('logging/setLevel accepts a valid level, returns {}, and persists it on the session record', async () => {
			const res = await handleMcpRequest(
				makeReq({
					body: jsonRpc(2, 'logging/setLevel', { level: 'warning' }),
					headers: { 'mcp-session-id': sessionId, 'mcp-protocol-version': '2025-06-18' },
				})
			);
			assert.equal(res.status, 200);
			assert.equal(res.jsonBody.error, undefined);
			assert.deepEqual(res.jsonBody.result, {});
			// Persisted durably so it survives an SSE reconnect (#1349 logging design).
			const session = await loadSession(sessionId);
			assert.equal(session.logLevel, 'warning');
		});

		it('does not roll back lastActivity when persisting the level (touchSession adopted)', async () => {
			// Force a known-old lastActivity, then setLevel: the request's touchSession
			// must advance it, and the level-persisting saveSession must NOT write the
			// stale load-time value back (root fix — handlePost adopts the touched copy).
			const stale = await loadSession(sessionId);
			await saveSession({ ...stale, lastActivity: 1 });
			await handleMcpRequest(
				makeReq({
					body: jsonRpc(2, 'logging/setLevel', { level: 'info' }),
					headers: { 'mcp-session-id': sessionId, 'mcp-protocol-version': '2025-06-18' },
				})
			);
			const after = await loadSession(sessionId);
			assert.ok(after.lastActivity > 1, `lastActivity should advance, not roll back; got ${after.lastActivity}`);
			assert.equal(after.logLevel, 'info', 'level still persisted');
		});

		it('seeds the live SSE record from a level set before the GET stream opened', async () => {
			// setLevel arrives with no open GET stream → persisted only. Opening the
			// stream afterward must seed the live record from the persisted level so
			// notifications/message are not silently suppressed (Codex review).
			await handleMcpRequest(
				makeReq({
					body: jsonRpc(2, 'logging/setLevel', { level: 'error' }),
					headers: { 'mcp-session-id': sessionId, 'mcp-protocol-version': '2025-06-18' },
				})
			);
			assert.equal(getRegisteredSession(sessionId), undefined, 'no live record before GET');
			const get = await handleMcpRequest(
				makeReq({
					method: 'GET',
					headers: { 'mcp-session-id': sessionId, 'mcp-protocol-version': '2025-06-18' },
				})
			);
			assert.equal(get.status, 200);
			assert.equal(getRegisteredSession(sessionId).logLevel, 'error', 'live record seeded from persisted level');
		});

		it('logging/setLevel rejects an invalid level with -32602', async () => {
			const res = await handleMcpRequest(
				makeReq({
					body: jsonRpc(2, 'logging/setLevel', { level: 'verbose' }),
					headers: { 'mcp-session-id': sessionId, 'mcp-protocol-version': '2025-06-18' },
				})
			);
			assert.equal(res.status, 200);
			assert.equal(res.jsonBody.error.code, -32602);
		});
	});

	describe('POST ping', () => {
		let sessionId;
		beforeEach(async () => {
			const res = await handleMcpRequest(
				makeReq({ body: jsonRpc(1, 'initialize', { protocolVersion: '2025-06-18' }) })
			);
			sessionId = res.headers['Mcp-Session-Id'];
		});

		it('answers ping with an empty result on a valid session', async () => {
			const res = await handleMcpRequest(
				makeReq({
					body: jsonRpc(7, 'ping'),
					headers: { 'mcp-session-id': sessionId, 'mcp-protocol-version': '2025-06-18' },
				})
			);
			assert.equal(res.status, 200);
			assert.equal(res.jsonBody.error, undefined);
			assert.deepEqual(res.jsonBody.result, {});
			assert.equal(res.jsonBody.id, 7);
		});

		it('does not mask an unknown/expired session — ping returns 404, not success', async () => {
			const res = await handleMcpRequest(
				makeReq({
					body: jsonRpc(7, 'ping'),
					headers: { 'mcp-session-id': 'not-a-session', 'mcp-protocol-version': '2025-06-18' },
				})
			);
			assert.equal(res.status, 404);
		});

		it('returns 202 (no response) for a ping sent as a notification', async () => {
			const res = await handleMcpRequest(
				makeReq({
					body: jsonRpc(undefined, 'ping'),
					headers: { 'mcp-session-id': sessionId, 'mcp-protocol-version': '2025-06-18' },
				})
			);
			assert.equal(res.status, 202);
			assert.equal(res.jsonBody, undefined);
		});
	});

	describe('POST after initialize (continued)', () => {
		let sessionId;
		beforeEach(async () => {
			const res = await handleMcpRequest(
				makeReq({ body: jsonRpc(1, 'initialize', { protocolVersion: '2025-06-18' }) })
			);
			sessionId = res.headers['Mcp-Session-Id'];
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

		describe('tools/call streaming (progress + cancellation)', () => {
			// Consume the per-call SSE queue the way the production adapters do —
			// via the event API (on('data')/once('close')), which drains buffered
			// frames synchronously on subscribe. (The queue's async iterator does NOT
			// terminate on 'close', so `for await` would hang.)
			function collectFrames(queue) {
				return new Promise((resolve) => {
					const frames = [];
					queue.on('data', (f) => frames.push(f.data));
					queue.once('close', () => resolve(frames));
				});
			}

			it('streams progress then the final result even for a synchronous handler (no close-before-subscribe race)', async () => {
				// No gate: the handler emits its frames and returns immediately. The
				// consumer is attached only AFTER handleMcpRequest returns (mirroring the
				// adapter). The handler must be deferred (setImmediate) so it can't emit
				// the final frame + 'close' before we subscribe — the queue buffers 'data'
				// but not 'close', so without the deferral the stream would never end.
				addTool({
					name: 'streamer',
					description: 'emits progress then a result',
					inputSchema: { type: 'object' },
					profile: 'application',
					visibleTo: () => true,
					handler: async (args, ctx) => {
						ctx.progress?.({ progress: 1, total: 2, message: 'step 1' });
						ctx.progress?.({ progress: 2, total: 2 });
						return { content: [{ type: 'text', text: 'done' }] };
					},
				});
				const res = await handleMcpRequest(
					makeReq({
						body: jsonRpc(40, 'tools/call', { name: 'streamer', arguments: {}, _meta: { progressToken: 'tok-1' } }),
						headers: {
							'mcp-session-id': sessionId,
							'mcp-protocol-version': '2025-06-18',
							'accept': 'application/json, text/event-stream',
						},
					})
				);
				assert.equal(res.status, 200);
				assert.equal(res.jsonBody, undefined, 'streaming response carries no jsonBody');
				assert.ok(res.sseIterable, 'streaming response carries an sseIterable');
				assert.match(res.headers['Content-Type'], /text\/event-stream/);
				// Attach only now — the deferral guarantees the handler hasn't produced yet.
				const frames = await collectFrames(res.sseIterable);
				const progress = frames.filter((d) => d.method === 'notifications/progress');
				assert.equal(progress.length, 2);
				assert.equal(progress[0].params.progressToken, 'tok-1');
				assert.equal(progress[0].params.progress, 1);
				assert.equal(progress[0].params.total, 2);
				assert.equal(progress[0].params.message, 'step 1');
				const final = frames.find((d) => d.id === 40);
				assert.ok(final, 'final JSON-RPC response delivered on the stream');
				assert.equal(final.result.content[0].text, 'done');
			});

			it('aborts the in-flight handler when the SSE stream closes (client disconnect)', async () => {
				let aborted = false;
				addTool({
					name: 'waiter_disconnect',
					description: 'resolves when its signal aborts',
					inputSchema: { type: 'object' },
					profile: 'application',
					visibleTo: () => true,
					handler: (args, ctx) =>
						new Promise((resolve) => {
							const finish = () => {
								aborted = true;
								resolve({ content: [{ type: 'text', text: 'aborted' }] });
							};
							if (ctx.signal?.aborted) return finish();
							ctx.signal?.addEventListener('abort', finish);
						}),
				});
				const res = await handleMcpRequest(
					makeReq({
						body: jsonRpc(44, 'tools/call', {
							name: 'waiter_disconnect',
							arguments: {},
							_meta: { progressToken: 'tok-d' },
						}),
						headers: {
							'mcp-session-id': sessionId,
							'mcp-protocol-version': '2025-06-18',
							'accept': 'application/json, text/event-stream',
						},
					})
				);
				assert.ok(res.sseIterable, 'streaming opened');
				// Simulate the adapter tearing the stream down on client disconnect.
				res.sseIterable.emit('close');
				// Let the deferred handler run with the now-aborted signal and settle.
				await new Promise((r) => setImmediate(r));
				await new Promise((r) => setImmediate(r));
				assert.equal(aborted, true, 'handler signal aborted when the stream closed');
			});

			it('returns a single JSON response (no stream) when no progressToken is supplied', async () => {
				addTool({
					name: 'streamer2',
					description: 'would stream',
					inputSchema: { type: 'object' },
					profile: 'application',
					visibleTo: () => true,
					handler: async (args, ctx) => {
						ctx.progress?.({ progress: 1 });
						return { content: [{ type: 'text', text: 'done' }] };
					},
				});
				const res = await handleMcpRequest(
					makeReq({
						body: jsonRpc(41, 'tools/call', { name: 'streamer2', arguments: {} }),
						headers: {
							'mcp-session-id': sessionId,
							'mcp-protocol-version': '2025-06-18',
							'accept': 'application/json, text/event-stream',
						},
					})
				);
				assert.equal(res.status, 200);
				assert.equal(res.sseIterable, undefined, 'no stream without a progressToken');
				assert.equal(res.jsonBody.result.content[0].text, 'done');
			});

			it('aborts an in-flight streaming call when notifications/cancelled references its id', async () => {
				let abortedSeen = false;
				addTool({
					name: 'waiter',
					description: 'waits until cancelled',
					inputSchema: { type: 'object' },
					profile: 'application',
					visibleTo: () => true,
					handler: (args, ctx) =>
						new Promise((resolve) => {
							// Check `aborted` before subscribing: the handler is deferred, so a
							// cancellation can land before it runs — a listener added after the
							// signal already fired would never resolve. (This is the discipline
							// the ToolCallContext.signal doc calls for.)
							const finish = () => {
								abortedSeen = true;
								resolve({ content: [{ type: 'text', text: 'cancelled' }] });
							};
							if (ctx.signal?.aborted) return finish();
							ctx.signal?.addEventListener('abort', finish);
						}),
				});
				const res = await handleMcpRequest(
					makeReq({
						body: jsonRpc(42, 'tools/call', { name: 'waiter', arguments: {}, _meta: { progressToken: 'tok-2' } }),
						headers: {
							'mcp-session-id': sessionId,
							'mcp-protocol-version': '2025-06-18',
							'accept': 'application/json, text/event-stream',
						},
					})
				);
				assert.ok(res.sseIterable, 'streaming response opened');
				const collected = collectFrames(res.sseIterable);
				const cancelRes = await handleMcpRequest(
					makeReq({
						body: jsonRpc(undefined, 'notifications/cancelled', { requestId: 42 }),
						headers: { 'mcp-session-id': sessionId, 'mcp-protocol-version': '2025-06-18' },
					})
				);
				assert.equal(cancelRes.status, 202);
				const frames = await collected;
				assert.equal(abortedSeen, true, 'handler observed the abort');
				const final = frames.find((d) => d.id === 42);
				assert.ok(final, 'final response delivered after cancellation');
				assert.equal(final.result.content[0].text, 'cancelled');
			});
		});

		describe('prompts/list + prompts/get', () => {
			beforeEach(() => {
				addPrompt({
					name: 'greet',
					profile: 'application',
					title: 'Greeting',
					description: 'greets a person',
					arguments: [{ name: 'who', required: true }],
					render: (args) => ({
						description: 'a greeting',
						messages: [{ role: 'user', content: { type: 'text', text: `Hello, ${args.who}!` } }],
					}),
				});
			});

			it('prompts/list returns the registered prompt descriptors', async () => {
				const res = await handleMcpRequest(
					makeReq({
						body: jsonRpc(50, 'prompts/list'),
						headers: { 'mcp-session-id': sessionId, 'mcp-protocol-version': '2025-06-18' },
					})
				);
				assert.equal(res.status, 200);
				const names = res.jsonBody.result.prompts.map((p) => p.name);
				assert.ok(names.includes('greet'));
				const greet = res.jsonBody.result.prompts.find((p) => p.name === 'greet');
				assert.equal(greet.title, 'Greeting');
				assert.equal(greet.render, undefined, 'render is not serialized to the client');
			});

			it('prompts/get renders messages with the supplied arguments', async () => {
				const res = await handleMcpRequest(
					makeReq({
						body: jsonRpc(51, 'prompts/get', { name: 'greet', arguments: { who: 'Ada' } }),
						headers: { 'mcp-session-id': sessionId, 'mcp-protocol-version': '2025-06-18' },
					})
				);
				assert.equal(res.status, 200);
				assert.equal(res.jsonBody.result.description, 'a greeting');
				assert.equal(res.jsonBody.result.messages[0].content.text, 'Hello, Ada!');
			});

			it('prompts/get returns -32602 for an unknown prompt', async () => {
				const res = await handleMcpRequest(
					makeReq({
						body: jsonRpc(52, 'prompts/get', { name: 'nope' }),
						headers: { 'mcp-session-id': sessionId, 'mcp-protocol-version': '2025-06-18' },
					})
				);
				assert.equal(res.jsonBody.error.code, -32602);
			});

			it('prompts/get treats an array arguments payload as empty (no array reaches render)', async () => {
				addPrompt({
					name: 'echo_args',
					profile: 'application',
					render: (args) => ({
						messages: [{ role: 'user', content: { type: 'text', text: Array.isArray(args) ? 'ARRAY' : 'OBJECT' } }],
					}),
				});
				const res = await handleMcpRequest(
					makeReq({
						body: jsonRpc(55, 'prompts/get', { name: 'echo_args', arguments: ['x', 'y'] }),
						headers: { 'mcp-session-id': sessionId, 'mcp-protocol-version': '2025-06-18' },
					})
				);
				assert.equal(res.status, 200);
				assert.equal(res.jsonBody.result.messages[0].content.text, 'OBJECT', 'array arguments must not pass through');
			});

			it('prompts/get returns -32602 when a required argument is missing', async () => {
				const res = await handleMcpRequest(
					makeReq({
						body: jsonRpc(53, 'prompts/get', { name: 'greet', arguments: {} }),
						headers: { 'mcp-session-id': sessionId, 'mcp-protocol-version': '2025-06-18' },
					})
				);
				assert.equal(res.jsonBody.error.code, -32602);
				assert.match(res.jsonBody.error.message, /who/);
			});

			it('prompts/get coerces non-string argument values to strings (gemini #1404 review)', async () => {
				// A client sending a number must not throw a TypeError inside render's string ops.
				const res = await handleMcpRequest(
					makeReq({
						body: jsonRpc(54, 'prompts/get', { name: 'greet', arguments: { who: 42 } }),
						headers: { 'mcp-session-id': sessionId, 'mcp-protocol-version': '2025-06-18' },
					})
				);
				assert.equal(res.status, 200);
				assert.equal(res.jsonBody.result.messages[0].content.text, 'Hello, 42!');
			});

			it('prompts/get still flags a required argument sent as null as missing', async () => {
				// Coercion omits null/undefined so required-arg validation is preserved.
				const res = await handleMcpRequest(
					makeReq({
						body: jsonRpc(56, 'prompts/get', { name: 'greet', arguments: { who: null } }),
						headers: { 'mcp-session-id': sessionId, 'mcp-protocol-version': '2025-06-18' },
					})
				);
				assert.equal(res.jsonBody.error.code, -32602);
				assert.match(res.jsonBody.error.message, /who/);
			});
		});

		describe('GET reconnect replay (§3.8 resumability)', () => {
			it('replays buffered frames after Last-Event-ID on reconnect', async () => {
				const getHeaders = {
					'mcp-session-id': sessionId,
					'mcp-protocol-version': '2025-06-18',
					'accept': 'text/event-stream',
				};
				// Open the stream (registers the session), then push two frames.
				const get1 = await handleMcpRequest(makeReq({ method: 'GET', headers: getHeaders }));
				assert.equal(get1.status, 200);
				const rec = getRegisteredSession(sessionId);
				pushSessionFrame(rec, { event: 'message', data: { method: 'one' } }); // id 1
				pushSessionFrame(rec, { event: 'message', data: { method: 'two' } }); // id 2

				// Reconnect echoing Last-Event-ID: 1 → only the id-2 frame should replay.
				const get2 = await handleMcpRequest(
					makeReq({ method: 'GET', headers: { ...getHeaders, 'last-event-id': '1' } })
				);
				assert.equal(get2.status, 200);
				const frames = [];
				get2.sseIterable.on('data', (f) => frames.push(f));
				await new Promise((r) => setImmediate(r));
				const replayed = frames.find((f) => f.data?.method === 'two');
				assert.ok(replayed, 'frame after Last-Event-ID replayed');
				assert.equal(replayed.id, '2');
				assert.ok(!frames.some((f) => f.data?.method === 'one'), 'frame at/before Last-Event-ID not replayed');
			});
		});

		describe('tools/call server→client requests (§3.7)', () => {
			beforeEach(() => _setItcForTest({ send: () => {}, onMessage: () => {} }));
			afterEach(() => {
				_resetServerRequestsForTest();
				_setItcForTest(undefined);
			});

			it('stores client capabilities on initialize and round-trips a server→client request', async () => {
				// Initialize WITH the elicitation capability so the session records it.
				const initRes = await handleMcpRequest(
					makeReq({
						body: jsonRpc(1, 'initialize', {
							protocolVersion: '2025-06-18',
							capabilities: { elicitation: {} },
						}),
					})
				);
				const sid = initRes.headers['Mcp-Session-Id'];
				const saved = await loadSession(sid);
				assert.deepEqual(saved.clientCapabilities, { elicitation: {} }, 'capabilities persisted');

				addTool({
					name: 'asker',
					description: 'asks the client',
					inputSchema: { type: 'object' },
					profile: 'application',
					visibleTo: () => true,
					handler: async (args, ctx) => {
						const answer = await ctx.serverRequest('elicitation/create', { message: 'name?' });
						return { content: [{ type: 'text', text: `got ${answer.name}` }] };
					},
				});

				const res = await handleMcpRequest(
					makeReq({
						body: jsonRpc(70, 'tools/call', { name: 'asker', arguments: {}, _meta: { progressToken: 't' } }),
						headers: {
							'mcp-session-id': sid,
							'mcp-protocol-version': '2025-06-18',
							'accept': 'application/json, text/event-stream',
						},
					})
				);
				assert.ok(res.sseIterable, 'streaming opened');

				const frames = [];
				let reqId;
				res.sseIterable.on('data', (f) => {
					frames.push(f.data);
					if (f.data.method === 'elicitation/create') reqId = f.data.id;
				});
				// Handler is deferred (setImmediate) — wait for the server→client request frame.
				for (let i = 0; i < 100 && reqId === undefined; i++) await new Promise((r) => setImmediate(r));
				assert.ok(reqId, 'server→client request frame delivered on the stream');

				// Client answers via a fresh POST → resolves the pending request.
				const respRes = await handleMcpRequest(
					makeReq({
						body: JSON.stringify({ jsonrpc: '2.0', id: reqId, result: { name: 'Ada' } }),
						headers: { 'mcp-session-id': sid, 'mcp-protocol-version': '2025-06-18' },
					})
				);
				assert.equal(respRes.status, 202, 'client response acked with 202');

				await new Promise((resolve) => res.sseIterable.once('close', resolve));
				const final = frames.find((d) => d.id === 70);
				assert.ok(final, 'final tool result delivered after the client responded');
				assert.equal(final.result.content[0].text, 'got Ada');
			});

			it('a GET stream close does not reject a pending tool server→client request', async () => {
				const initRes = await handleMcpRequest(
					makeReq({
						body: jsonRpc(1, 'initialize', { protocolVersion: '2025-06-18', capabilities: { elicitation: {} } }),
					})
				);
				const sid = initRes.headers['Mcp-Session-Id'];

				addTool({
					name: 'slow-asker',
					description: 'asks the client and never gets answered here',
					inputSchema: { type: 'object' },
					profile: 'application',
					visibleTo: () => true,
					handler: async (args, ctx) => {
						await ctx.serverRequest('elicitation/create', { message: 'name?' });
						return { content: [{ type: 'text', text: 'done' }] };
					},
				});

				// Open a GET SSE stream for this session, then issue a streaming tools/call
				// whose handler awaits a server→client request (rides the POST stream).
				const get = await handleMcpRequest(
					makeReq({
						method: 'GET',
						headers: { 'mcp-session-id': sid, 'mcp-protocol-version': '2025-06-18', 'accept': 'text/event-stream' },
					})
				);
				assert.equal(get.status, 200);
				const call = await handleMcpRequest(
					makeReq({
						body: jsonRpc(80, 'tools/call', { name: 'slow-asker', arguments: {}, _meta: { progressToken: 't' } }),
						headers: {
							'mcp-session-id': sid,
							'mcp-protocol-version': '2025-06-18',
							'accept': 'application/json, text/event-stream',
						},
					})
				);
				assert.ok(call.sseIterable, 'streaming opened');
				let delivered = false;
				call.sseIterable.on('data', (f) => {
					if (f.data?.method === 'elicitation/create') delivered = true;
				});
				for (let i = 0; i < 100 && !delivered; i++) await new Promise((r) => setImmediate(r));
				assert.equal(_pendingServerRequestCount(), 1, 'server→client request is pending');

				// Simulate a GET reconnect/drop: close the GET stream. The server request
				// rides the POST stream, so it must survive — not get rejected as isError.
				get.sseIterable.emit('close');
				await new Promise((r) => setImmediate(r));
				assert.equal(_pendingServerRequestCount(), 1, 'pending server request survives GET close');

				call.sseIterable.emit('close'); // clean up the dangling POST stream
			});
		});

		describe('resources/subscribe + resources/unsubscribe', () => {
			beforeEach(() => {
				// A live GET stream is required to subscribe — register one for the session.
				registerSession(sessionId, 'application', { username: 'alice', role: { permission: { super_user: true } } });
				// Inject a fake change stream so dispatch doesn't need the real audit log.
				// `null` for the sentinel path makes the resource non-subscribable.
				_setSubscribeImplForTest(async (path) =>
					/nope/.test(path)
						? null
						: {
								end() {},
								[Symbol.asyncIterator]() {
									return { next: () => new Promise(() => {}), return: () => Promise.resolve({ done: true }) };
								},
							}
				);
			});
			afterEach(() => {
				_setSubscribeImplForTest(undefined);
				_resetSessionRegistryForTest();
			});

			it('rejects subscribe when no GET SSE stream is open for the session', async () => {
				_resetSessionRegistryForTest(); // no live stream for this session
				const res = await handleMcpRequest(
					makeReq({
						body: jsonRpc(75, 'resources/subscribe', { uri: 'https://app.test:9926/Product/1' }),
						headers: { 'mcp-session-id': sessionId, 'mcp-protocol-version': '2025-06-18' },
					})
				);
				assert.equal(res.jsonBody.error.code, -32602);
				assert.match(res.jsonBody.error.message, /GET SSE stream/);
			});

			it('subscribes to a row-backed URI and returns an empty result', async () => {
				const res = await handleMcpRequest(
					makeReq({
						body: jsonRpc(70, 'resources/subscribe', { uri: 'https://app.test:9926/Product/1' }),
						headers: { 'mcp-session-id': sessionId, 'mcp-protocol-version': '2025-06-18' },
					})
				);
				assert.equal(res.status, 200);
				assert.deepEqual(res.jsonBody.result, {});
				const saved = await loadSession(sessionId);
				assert.ok(saved.subscriptions.includes('https://app.test:9926/Product/1'), 'persisted on the session record');
			});

			it('returns -32602 for a non-subscribable URI', async () => {
				const res = await handleMcpRequest(
					makeReq({
						body: jsonRpc(71, 'resources/subscribe', { uri: 'harper://about' }),
						headers: { 'mcp-session-id': sessionId, 'mcp-protocol-version': '2025-06-18' },
					})
				);
				assert.equal(res.jsonBody.error.code, -32602);
			});

			it('returns -32602 when params.uri is missing', async () => {
				const res = await handleMcpRequest(
					makeReq({
						body: jsonRpc(72, 'resources/subscribe', {}),
						headers: { 'mcp-session-id': sessionId, 'mcp-protocol-version': '2025-06-18' },
					})
				);
				assert.equal(res.jsonBody.error.code, -32602);
			});

			it('unsubscribe removes the URI from the durable record', async () => {
				const uri = 'https://app.test:9926/Product/2';
				await handleMcpRequest(
					makeReq({
						body: jsonRpc(73, 'resources/subscribe', { uri }),
						headers: { 'mcp-session-id': sessionId, 'mcp-protocol-version': '2025-06-18' },
					})
				);
				const res = await handleMcpRequest(
					makeReq({
						body: jsonRpc(74, 'resources/unsubscribe', { uri }),
						headers: { 'mcp-session-id': sessionId, 'mcp-protocol-version': '2025-06-18' },
					})
				);
				assert.equal(res.status, 200);
				assert.deepEqual(res.jsonBody.result, {});
				const saved = await loadSession(sessionId);
				assert.ok(!(saved.subscriptions ?? []).includes(uri), 'URI dropped from the record');
			});
		});

		describe('completion/complete', () => {
			it('completes a prompt argument (ref/prompt) from author-declared values', async () => {
				addPrompt({
					name: 'pick',
					profile: 'application',
					arguments: [{ name: 'color', values: ['red', 'green', 'blue'] }],
					render: () => ({ messages: [] }),
				});
				const res = await handleMcpRequest(
					makeReq({
						body: jsonRpc(60, 'completion/complete', {
							ref: { type: 'ref/prompt', name: 'pick' },
							argument: { name: 'color', value: 'r' },
						}),
						headers: { 'mcp-session-id': sessionId, 'mcp-protocol-version': '2025-06-18' },
					})
				);
				assert.equal(res.status, 200);
				assert.deepEqual(res.jsonBody.result.completion.values, ['red']);
				assert.equal(res.jsonBody.result.completion.hasMore, false);
			});

			it('returns -32602 when ref.type or argument.name is missing', async () => {
				const res = await handleMcpRequest(
					makeReq({
						body: jsonRpc(61, 'completion/complete', { ref: { type: 'ref/prompt' } }),
						headers: { 'mcp-session-id': sessionId, 'mcp-protocol-version': '2025-06-18' },
					})
				);
				assert.equal(res.jsonBody.error.code, -32602);
			});

			it('returns an empty completion for an unknown ref type', async () => {
				const res = await handleMcpRequest(
					makeReq({
						body: jsonRpc(62, 'completion/complete', {
							ref: { type: 'ref/mystery' },
							argument: { name: 'x', value: '' },
						}),
						headers: { 'mcp-session-id': sessionId, 'mcp-protocol-version': '2025-06-18' },
					})
				);
				assert.deepEqual(res.jsonBody.result.completion, { values: [], total: 0, hasMore: false });
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

			it('rejects a malformed pagination cursor with -32602', async () => {
				const res = await handleMcpRequest(
					makeReq({
						body: jsonRpc(32, 'resources/templates/list', { cursor: 'not-a-real-cursor!' }),
						headers: { 'mcp-session-id': sessionId, 'mcp-protocol-version': '2025-06-18' },
					})
				);
				assert.equal(res.status, 200);
				assert.equal(res.jsonBody.error.code, -32602);
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
