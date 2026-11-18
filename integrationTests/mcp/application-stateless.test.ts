/**
 * Two independent Harper nodes serve one MCP client with `mcp.application.stateless` (#4346).
 *
 * Core has no replication, so nothing one node writes is visible to the other: a request that depended on an
 * earlier request's state (a `system.mcp_session` row) would get 404 on the other node. That is the GTM case,
 * where consecutive requests resolve to different nodes. Both nodes require authentication and verify the same
 * Bearer token, as a deployment's nodes do.
 */
import { suite, test, before, after } from 'node:test';
import { deepStrictEqual, notStrictEqual, ok, strictEqual } from 'node:assert';
import { resolve } from 'node:path';
import {
	createHarperContext,
	setupHarperWithFixture,
	teardownHarper,
	type HarperTestContext,
	type StartedHarperTestContext,
} from '@harperfast/integration-testing';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const FIXTURE_PATH = resolve(import.meta.dirname, '../fixtures/mcp-stateless');
const PROTOCOL_VERSION = '2025-06-18';
const BEARER = 'Bearer stateless-valid';
const INSTRUCTIONS = 'Each call names the node that served it.';
const SERVER_CARD = { name: 'test.harper/stateless-probe', description: 'Two stateless nodes behind one client.' };

suite('MCP application profile: stateless across two nodes (#4346)', (ctx) => {
	const nodes: HarperTestContext[] = [createHarperContext(`${ctx.name}-a`), createHarperContext(`${ctx.name}-b`)];
	let urls: string[] = [];

	before(async () => {
		await Promise.all(
			nodes.map((node) =>
				setupHarperWithFixture(node, FIXTURE_PATH, {
					config: {
						threads: { count: 1 },
						authentication: { authorizeLocal: false },
						mcp: {
							application: {
								mountPath: '/mcp',
								stateless: true,
								authentication: { required: true },
								instructions: INSTRUCTIONS,
								serverCard: SERVER_CARD,
							},
						},
					},
					env: {
						AUTHENTICATION_AUTHORIZELOCAL: 'false',
						HARPER_BUILTIN_COMPONENTS: 'mcpStatelessValidator=@/integrationTests/fixtures/mcp-stateless/validator.js',
					},
				})
			)
		);
		urls = (nodes as StartedHarperTestContext[]).map((node) => `${node.harper.httpURL}/mcp`);
	});

	after(async () => {
		await Promise.allSettled(nodes.map((node) => node.harper && teardownHarper(node as StartedHarperTestContext)));
	});

	function post(node: number, body: unknown, headers: Record<string, string> = {}) {
		return fetch(urls[node], {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				'Accept': 'application/json, text/event-stream',
				'Authorization': BEARER,
				...headers,
			},
			body: JSON.stringify(body),
		});
	}

	async function callNode(node: number, id: number) {
		const call = await post(
			node,
			{ jsonrpc: '2.0', id, method: 'tools/call', params: { name: 'stateless_node', arguments: {} } },
			{ 'mcp-protocol-version': PROTOCOL_VERSION }
		);
		const text = await call.text();
		strictEqual(call.status, 200, text);
		return JSON.parse(JSON.parse(text).result.content[0].text);
	}

	test('the SDK client initializes once and calls tools on alternating nodes without a 404', async () => {
		const routed: { node: number; method: string; status: number }[] = [];
		let next = 0;
		// Each request goes to the other node from the one before, as DNS load balancing can do.
		const alternatingFetch = async (input: string | URL | Request, init?: RequestInit) => {
			const node = next++ % 2;
			const target = new URL(input instanceof Request ? input.url : String(input));
			const response = await fetch(urls[node] + target.search, init);
			routed.push({ node, method: init?.method ?? 'GET', status: response.status });
			return response;
		};
		const transport = new StreamableHTTPClientTransport(new URL(urls[0]), {
			requestInit: { headers: { Authorization: BEARER } },
			fetch: alternatingFetch,
		});
		const client = new Client({ name: 'stateless-it', version: '0' }, { capabilities: {} });
		await client.connect(transport);
		strictEqual(transport.sessionId, undefined, 'a stateless server mints no session id');
		strictEqual(client.getInstructions(), INSTRUCTIONS, 'the client reads the configured instructions (#4362)');

		const pids = new Set<number>();
		for (let call = 0; call < 6; call++) {
			const result = await client.callTool({ name: 'stateless_node', arguments: {} });
			ok(!result.isError, JSON.stringify(result));
			const served = JSON.parse((result.content as { text: string }[])[0].text);
			strictEqual(served.username, 'admin', 'each node authenticated the token itself');
			strictEqual(served.sessionId, null, 'tool handlers see no session id');
			pids.add(served.pid);
		}
		await client.close();

		strictEqual(pids.size, 2, `both nodes served calls: ${[...pids].join(', ')}`);
		deepStrictEqual(
			routed.filter((entry) => entry.status === 404 || entry.status === 401),
			[],
			JSON.stringify(routed)
		);
		const posts = routed.filter((entry) => entry.method === 'POST');
		strictEqual(posts.length, 8, `initialize, initialized and six calls, no re-initialize: ${JSON.stringify(routed)}`);
		ok(
			posts.every((entry) => entry.status === 200 || entry.status === 202),
			JSON.stringify(routed)
		);
	});

	test('initialize on one node, then tools/list and tools/call on the other, over raw HTTP', async () => {
		const init = await post(0, {
			jsonrpc: '2.0',
			id: 1,
			method: 'initialize',
			params: { protocolVersion: PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: 'raw', version: '0' } },
		});
		const initText = await init.text();
		strictEqual(init.status, 200, initText);
		strictEqual(init.headers.get('mcp-session-id'), null);
		strictEqual(JSON.parse(initText).result.instructions, INSTRUCTIONS, 'configured instructions (#4362)');
		const capabilities = JSON.parse(initText).result.capabilities;
		strictEqual(capabilities.tools.listChanged, undefined, 'no list_changed push without a GET stream');
		strictEqual(capabilities.resources.subscribe, undefined);
		strictEqual(capabilities.logging, undefined);

		const headers = { 'mcp-protocol-version': PROTOCOL_VERSION };
		const initialized = await post(1, { jsonrpc: '2.0', method: 'notifications/initialized' }, headers);
		await initialized.text();
		strictEqual(initialized.status, 202);

		const list = await post(1, { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }, headers);
		const listText = await list.text();
		strictEqual(list.status, 200, listText);
		ok(JSON.parse(listText).result.tools.some((tool: { name: string }) => tool.name === 'stateless_node'));

		notStrictEqual((await callNode(1, 3)).pid, (await callNode(0, 4)).pid, 'two processes served the calls');
	});

	test('a leftover Mcp-Session-Id from a stateful deployment is ignored', async () => {
		const response = await post(
			1,
			{ jsonrpc: '2.0', id: 9, method: 'ping' },
			{ 'mcp-session-id': '00000000-0000-4000-8000-000000000000' }
		);
		const text = await response.text();
		strictEqual(response.status, 200, text);
		deepStrictEqual(JSON.parse(text).result, {});
	});

	test('GET and DELETE answer 405 with Allow: POST', async () => {
		for (const method of ['GET', 'DELETE']) {
			const response = await fetch(urls[0], {
				method,
				headers: { Accept: 'text/event-stream', Authorization: BEARER },
			});
			await response.text();
			strictEqual(response.status, 405, method);
			strictEqual(response.headers.get('allow'), 'POST', method);
		}
	});

	test('a request with no credential still gets the 401 challenge', async () => {
		const response = await fetch(urls[1], {
			method: 'POST',
			headers: { 'Content-Type': 'application/json', 'Accept': 'application/json, text/event-stream' },
			body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' }),
		});
		await response.text();
		strictEqual(response.status, 401);
		strictEqual(
			response.headers.get('www-authenticate'),
			'Bearer resource_metadata="https://auth.example.test/.well-known/oauth-protected-resource/mcp"'
		);
	});

	test('a token refused by a validator that declared no challenge names no metadata (#4352)', async () => {
		const response = await post(
			0,
			{ jsonrpc: '2.0', id: 1, method: 'ping' },
			{
				Authorization: 'Bearer stateless-refused-by-undeclared',
			}
		);
		await response.text();
		strictEqual(response.status, 401);
		strictEqual(response.headers.get('www-authenticate'), 'Bearer realm="Harper", error="invalid_token"');
	});

	test('serves the server card without credentials, even with a refused token (#4347)', async () => {
		for (const headers of [{}, { Authorization: 'Bearer stateless-refused-by-undeclared' }]) {
			const response = await fetch(`${urls[0]}/server-card`, {
				headers: { Accept: 'application/mcp-server-card+json', ...headers },
			});
			const text = await response.text();
			strictEqual(response.status, 200, text);
			strictEqual(response.headers.get('content-type'), 'application/mcp-server-card+json');
			strictEqual(response.headers.get('access-control-allow-origin'), '*');
			const card = JSON.parse(text);
			strictEqual(card.$schema, 'https://static.modelcontextprotocol.io/schemas/v1/server-card.schema.json');
			strictEqual(card.name, SERVER_CARD.name);
			strictEqual(card.description, SERVER_CARD.description);
			ok(card.version, 'a version');
			deepStrictEqual(card.remotes, [
				{ type: 'streamable-http', url: urls[0], supportedProtocolVersions: [PROTOCOL_VERSION, '2025-03-26'] },
			]);

			const revalidated = await fetch(`${urls[0]}/server-card`, {
				headers: { 'If-None-Match': response.headers.get('etag')!, ...headers },
			});
			await revalidated.text();
			strictEqual(revalidated.status, 304);
		}
	});

	test('answers a browser preflight for the server card (#4347)', async () => {
		const response = await fetch(`${urls[1]}/server-card`, {
			method: 'OPTIONS',
			headers: {
				'Origin': 'https://inspector.example',
				'Access-Control-Request-Method': 'GET',
				'Access-Control-Request-Headers': 'authorization, if-none-match',
			},
		});
		await response.text();
		strictEqual(response.status, 204);
		strictEqual(response.headers.get('access-control-allow-origin'), '*');
		ok(response.headers.get('access-control-allow-headers')?.includes('If-None-Match'));
		ok(response.headers.get('access-control-allow-headers')?.includes('Authorization'));
	});
});
