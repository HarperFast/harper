/**
 * MCP Streamable HTTP transport — integration tests (#614).
 *
 * Verifies end-to-end behavior against a real Harper boot with
 * `mcp.operations: {}` in config:
 *   - initialize handshake (request + Mcp-Session-Id response)
 *   - notifications/initialized → 202 empty
 *   - GET /mcp → 405 (no SSE channel in v1)
 *   - DELETE /mcp → 405 by default
 *   - Unknown method → 200 + JSON-RPC -32601
 *   - Missing/unknown session id → 400 / 404
 *   - User binding on session
 */
import { suite, test, before, after } from 'node:test';
import { ok, strictEqual, match } from 'node:assert/strict';

import { startHarper, teardownHarper, type ContextWithHarper } from '@harperfast/integration-testing';

function authHeader(ctx: ContextWithHarper): string {
	return `Basic ${Buffer.from(`${ctx.harper.admin.username}:${ctx.harper.admin.password}`).toString('base64')}`;
}

function mcpUrl(ctx: ContextWithHarper): string {
	return `${ctx.harper.operationsAPIURL}/mcp`;
}

async function jsonRpcPost(
	ctx: ContextWithHarper,
	body: object,
	extraHeaders: Record<string, string> = {}
): Promise<Response> {
	return fetch(mcpUrl(ctx), {
		method: 'POST',
		headers: {
			'Content-Type': 'application/json',
			'Accept': 'application/json, text/event-stream',
			'Authorization': authHeader(ctx),
			...extraHeaders,
		},
		body: JSON.stringify(body),
	});
}

suite('MCP Streamable HTTP transport (operations profile)', (ctx: ContextWithHarper) => {
	before(async () => {
		// NOTE on the explicit `mountPath`: the integration-testing harness
		// passes config via the `HARPER_SET_CONFIG` env var, which is applied
		// via `applyConfigLayer` → `flattenObject` in
		// `config/harperConfigEnvVars.ts:176`. `flattenObject` skips empty
		// objects (no flat paths to set), so `mcp: { operations: {} }` would
		// be lost entirely from the runtime override. Production YAML loading
		// preserves empty objects, so the presence-based enablement works for
		// real users — this is a harness-only workaround.
		await startHarper(ctx, {
			config: {
				mcp: { operations: { mountPath: '/mcp' } },
			},
			env: {},
		});
	});

	after(async () => {
		await teardownHarper(ctx);
	});

	test('initialize returns 200 with Mcp-Session-Id header and capabilities', async () => {
		const res = await jsonRpcPost(ctx, {
			jsonrpc: '2.0',
			id: 1,
			method: 'initialize',
			params: {
				protocolVersion: '2025-06-18',
				capabilities: {},
				clientInfo: { name: 'mcp-integration-test', version: '0.0.0' },
			},
		});
		strictEqual(res.status, 200);
		const sessionId = res.headers.get('mcp-session-id');
		ok(sessionId, 'expected Mcp-Session-Id response header');
		match(sessionId!, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
		const body = (await res.json()) as {
			jsonrpc: string;
			id: number;
			result: {
				protocolVersion: string;
				serverInfo: { name: string; version: string };
				capabilities: { tools: { listChanged: boolean }; resources: { listChanged: boolean }; logging: object };
			};
		};
		strictEqual(body.jsonrpc, '2.0');
		strictEqual(body.id, 1);
		strictEqual(body.result.protocolVersion, '2025-06-18');
		strictEqual(body.result.serverInfo.name, 'harper-mcp');
		strictEqual(body.result.capabilities.tools.listChanged, true);
		strictEqual(body.result.capabilities.resources.listChanged, true);
	});

	test('full handshake: initialize → notifications/initialized → 202 empty', async () => {
		const initRes = await jsonRpcPost(ctx, {
			jsonrpc: '2.0',
			id: 1,
			method: 'initialize',
			params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'x', version: '0' } },
		});
		strictEqual(initRes.status, 200);
		const sessionId = initRes.headers.get('mcp-session-id')!;
		await initRes.body?.cancel();

		const notifRes = await jsonRpcPost(
			ctx,
			{ jsonrpc: '2.0', method: 'notifications/initialized' },
			{ 'Mcp-Session-Id': sessionId, 'MCP-Protocol-Version': '2025-06-18' }
		);
		strictEqual(notifRes.status, 202);
		const text = await notifRes.text();
		strictEqual(text, '');
	});

	test('unknown method on an active session returns 200 + JSON-RPC -32601', async () => {
		const initRes = await jsonRpcPost(ctx, {
			jsonrpc: '2.0',
			id: 1,
			method: 'initialize',
			params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'x', version: '0' } },
		});
		const sessionId = initRes.headers.get('mcp-session-id')!;
		await initRes.body?.cancel();

		// Use a guaranteed-unknown method name; tools/list, resources/list, and
		// resources/read are all real handlers now.
		const res = await jsonRpcPost(
			ctx,
			{ jsonrpc: '2.0', id: 2, method: 'definitely/not/a/method' },
			{ 'Mcp-Session-Id': sessionId, 'MCP-Protocol-Version': '2025-06-18' }
		);
		strictEqual(res.status, 200);
		const body = (await res.json()) as { jsonrpc: string; id: number; error: { code: number; message: string } };
		strictEqual(body.error.code, -32601);
		match(body.error.message, /definitely\/not\/a\/method/);
	});

	test('request without Mcp-Session-Id returns 400', async () => {
		const res = await jsonRpcPost(
			ctx,
			{ jsonrpc: '2.0', id: 1, method: 'tools/list' },
			{
				'MCP-Protocol-Version': '2025-06-18',
			}
		);
		strictEqual(res.status, 400);
	});

	test('request with unknown Mcp-Session-Id returns 404', async () => {
		const res = await jsonRpcPost(
			ctx,
			{ jsonrpc: '2.0', id: 1, method: 'tools/list' },
			{ 'Mcp-Session-Id': 'not-a-real-session', 'MCP-Protocol-Version': '2025-06-18' }
		);
		strictEqual(res.status, 404);
	});

	test('GET /mcp returns 400 without a session id (SSE channel landed in #619)', async () => {
		// GET is the server-push SSE channel; needs Mcp-Session-Id to open.
		// Without it, transport returns 400 — not 405. Previously this test
		// asserted 405 because GET was a stub until #619.
		const res = await fetch(mcpUrl(ctx), {
			method: 'GET',
			headers: { Accept: 'text/event-stream', Authorization: authHeader(ctx) },
		});
		strictEqual(res.status, 400);
		await res.body?.cancel();
	});

	test('DELETE /mcp returns 405 when allowClientDelete is not configured', async () => {
		const res = await fetch(mcpUrl(ctx), {
			method: 'DELETE',
			headers: { Authorization: authHeader(ctx) },
		});
		strictEqual(res.status, 405);
		await res.body?.cancel();
	});

	test('parse error returns 400 with JSON-RPC -32700', async () => {
		const res = await fetch(mcpUrl(ctx), {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				'Accept': 'application/json',
				'Authorization': authHeader(ctx),
			},
			body: '{not json',
		});
		strictEqual(res.status, 400);
	});

	test('resources/list returns harper:// synthetic URIs (#616)', async () => {
		const initRes = await jsonRpcPost(ctx, {
			jsonrpc: '2.0',
			id: 1,
			method: 'initialize',
			params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'x', version: '0' } },
		});
		const sessionId = initRes.headers.get('mcp-session-id')!;
		await initRes.body?.cancel();

		const res = await jsonRpcPost(
			ctx,
			{ jsonrpc: '2.0', id: 40, method: 'resources/list' },
			{ 'Mcp-Session-Id': sessionId, 'MCP-Protocol-Version': '2025-06-18' }
		);
		strictEqual(res.status, 200);
		const body = (await res.json()) as {
			jsonrpc: string;
			id: number;
			result: { resources: Array<{ uri: string; name: string }> };
		};
		const uris = body.result.resources.map((r) => r.uri);
		ok(uris.includes('harper://about'), `expected harper://about in resources/list, got ${uris.join(', ')}`);
		// Operations profile exposes harper://operations, not harper://openapi.
		ok(uris.includes('harper://operations'), `expected harper://operations on operations profile`);
	});

	test('resources/read for harper://about returns the server metadata (#616)', async () => {
		const initRes = await jsonRpcPost(ctx, {
			jsonrpc: '2.0',
			id: 1,
			method: 'initialize',
			params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'x', version: '0' } },
		});
		const sessionId = initRes.headers.get('mcp-session-id')!;
		await initRes.body?.cancel();

		const res = await jsonRpcPost(
			ctx,
			{ jsonrpc: '2.0', id: 41, method: 'resources/read', params: { uri: 'harper://about' } },
			{ 'Mcp-Session-Id': sessionId, 'MCP-Protocol-Version': '2025-06-18' }
		);
		strictEqual(res.status, 200);
		const body = (await res.json()) as {
			jsonrpc: string;
			id: number;
			result: { contents: Array<{ uri: string; mimeType?: string; text?: string }> };
		};
		strictEqual(body.result.contents[0].uri, 'harper://about');
		strictEqual(body.result.contents[0].mimeType, 'application/json');
		const payload = JSON.parse(body.result.contents[0].text!) as {
			serverInfo: { name: string };
			profile: string;
		};
		strictEqual(payload.serverInfo.name, 'harper-mcp');
		strictEqual(payload.profile, 'operations');
	});

	test('resources/templates/list returns the URI templates for the profile (#616)', async () => {
		const initRes = await jsonRpcPost(ctx, {
			jsonrpc: '2.0',
			id: 1,
			method: 'initialize',
			params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'x', version: '0' } },
		});
		const sessionId = initRes.headers.get('mcp-session-id')!;
		await initRes.body?.cancel();

		const res = await jsonRpcPost(
			ctx,
			{ jsonrpc: '2.0', id: 42, method: 'resources/templates/list' },
			{ 'Mcp-Session-Id': sessionId, 'MCP-Protocol-Version': '2025-06-18' }
		);
		strictEqual(res.status, 200);
		const body = (await res.json()) as {
			jsonrpc: string;
			id: number;
			result: { resourceTemplates: Array<{ uriTemplate: string }> };
		};
		// Operations profile has no application templates, so the array is empty here.
		ok(Array.isArray(body.result.resourceTemplates));
	});

	test('resources/read with missing params.uri returns JSON-RPC -32602 (#616)', async () => {
		const initRes = await jsonRpcPost(ctx, {
			jsonrpc: '2.0',
			id: 1,
			method: 'initialize',
			params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'x', version: '0' } },
		});
		const sessionId = initRes.headers.get('mcp-session-id')!;
		await initRes.body?.cancel();

		const res = await jsonRpcPost(
			ctx,
			{ jsonrpc: '2.0', id: 43, method: 'resources/read' },
			{ 'Mcp-Session-Id': sessionId, 'MCP-Protocol-Version': '2025-06-18' }
		);
		strictEqual(res.status, 200);
		const body = (await res.json()) as { jsonrpc: string; id: number; error: { code: number; message: string } };
		strictEqual(body.error.code, -32602);
	});

	test('tools/list returns the default-allow operations as MCP tools (#617)', async () => {
		const initRes = await jsonRpcPost(ctx, {
			jsonrpc: '2.0',
			id: 1,
			method: 'initialize',
			params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'x', version: '0' } },
		});
		const sessionId = initRes.headers.get('mcp-session-id')!;
		await initRes.body?.cancel();

		const res = await jsonRpcPost(
			ctx,
			{ jsonrpc: '2.0', id: 50, method: 'tools/list' },
			{ 'Mcp-Session-Id': sessionId, 'MCP-Protocol-Version': '2025-06-18' }
		);
		strictEqual(res.status, 200);
		const body = (await res.json()) as {
			result: { tools: Array<{ name: string; description: string; inputSchema: { type: string } }> };
		};
		const names = body.result.tools.map((t) => t.name);
		ok(names.includes('describe_all'), `expected describe_all in tools/list, got: ${names.join(', ')}`);
		ok(names.includes('list_users'));
		ok(names.includes('system_information'));
		ok(!names.includes('insert'), 'insert should not be in the default allow list');
		ok(!names.includes('drop_table'), 'drop_table should not be in the default allow list');
		const describeAll = body.result.tools.find((t) => t.name === 'describe_all')!;
		strictEqual(describeAll.inputSchema.type, 'object');
	});

	test('tools/call describe_all returns the schema tree end-to-end (#617)', async () => {
		const initRes = await jsonRpcPost(ctx, {
			jsonrpc: '2.0',
			id: 1,
			method: 'initialize',
			params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'x', version: '0' } },
		});
		const sessionId = initRes.headers.get('mcp-session-id')!;
		await initRes.body?.cancel();

		const res = await jsonRpcPost(
			ctx,
			{ jsonrpc: '2.0', id: 51, method: 'tools/call', params: { name: 'describe_all' } },
			{ 'Mcp-Session-Id': sessionId, 'MCP-Protocol-Version': '2025-06-18' }
		);
		strictEqual(res.status, 200);
		const body = (await res.json()) as {
			result: { content: Array<{ type: string; text: string }>; structuredContent?: object; isError?: boolean };
		};
		strictEqual(body.result.isError ?? false, false);
		// structuredContent for describe_all is an object keyed by database name.
		ok(body.result.structuredContent && typeof body.result.structuredContent === 'object');
		ok(body.result.content[0].type === 'text');
	});

	test('tools/call for an unknown operation returns -32601', async () => {
		const initRes = await jsonRpcPost(ctx, {
			jsonrpc: '2.0',
			id: 1,
			method: 'initialize',
			params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'x', version: '0' } },
		});
		const sessionId = initRes.headers.get('mcp-session-id')!;
		await initRes.body?.cancel();

		const res = await jsonRpcPost(
			ctx,
			{ jsonrpc: '2.0', id: 52, method: 'tools/call', params: { name: 'this_tool_does_not_exist' } },
			{ 'Mcp-Session-Id': sessionId, 'MCP-Protocol-Version': '2025-06-18' }
		);
		strictEqual(res.status, 200);
		const body = (await res.json()) as { error: { code: number; message: string } };
		strictEqual(body.error.code, -32601);
		ok(body.error.message.includes('this_tool_does_not_exist'));
	});
});
