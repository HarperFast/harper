/**
 * MCP v1 — application-profile conformance over real HTTP (#1317).
 *
 * Boots a real Harper with BOTH MCP profiles and a sample exported `@table`
 * Resource (the `custom-resources` fixture), then drives the application
 * endpoint with the official `@modelcontextprotocol/sdk` client.
 *
 * The application profile previously 500'd on every request — Harper wraps the
 * inbound body in a `RequestBody` that is not async-iterable, and the adapter
 * read it with `for await`, throwing `TypeError: body is not async iterable`
 * (P1). The adapter's unit tests mocked the body as a real async-iterable, so
 * they passed while the integrated path failed; this suite closes that gap by
 * exercising the real wrapper end-to-end.
 *
 * Also asserts the malformed-JSON framing (S1) — the application profile reads
 * the raw body and returns a JSON-RPC `-32700` frame, while the operations
 * (Fastify) profile rejects with a spec-permitted HTTP 400 — and the
 * unrecognized-cursor `-32602` frame (S2).
 */
import { suite, test, before, after } from 'node:test';
import { ok, strictEqual, match } from 'node:assert/strict';
import { resolve } from 'node:path';

import { setupHarperWithFixture, teardownHarper, type ContextWithHarper } from '@harperfast/integration-testing';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const FIXTURE_PATH = resolve(import.meta.dirname, '../fixtures/custom-resources');

function authHeader(ctx: ContextWithHarper): string {
	return `Basic ${Buffer.from(`${ctx.harper.admin.username}:${ctx.harper.admin.password}`).toString('base64')}`;
}

// Application profile is mounted on the HTTP (app) port, not the operations port.
async function newAppClient(
	ctx: ContextWithHarper
): Promise<{ client: Client; transport: StreamableHTTPClientTransport }> {
	const transport = new StreamableHTTPClientTransport(new URL('/mcp', ctx.harper.httpURL), {
		requestInit: { headers: { Authorization: authHeader(ctx) } },
	});
	const client = new Client({ name: 'harper-app-e2e', version: '1.0.0' }, { capabilities: {} });
	await client.connect(transport);
	return { client, transport };
}

/** Raw JSON-RPC POST to an MCP endpoint (used for S1/S2 frame assertions). */
async function rawRpc(
	ctx: ContextWithHarper,
	opts: { baseUrl?: string; sessionId?: string; protocolVersion?: string; body: string }
): Promise<{ status: number; sessionId: string | null; json: any }> {
	const headers: Record<string, string> = {
		'content-type': 'application/json',
		'accept': 'application/json, text/event-stream',
		'authorization': authHeader(ctx),
	};
	if (opts.sessionId) headers['mcp-session-id'] = opts.sessionId;
	if (opts.protocolVersion) headers['mcp-protocol-version'] = opts.protocolVersion;
	const res = await fetch(new URL('/mcp', opts.baseUrl ?? ctx.harper.operationsAPIURL), {
		method: 'POST',
		headers,
		body: opts.body,
	});
	const text = await res.text();
	let json: any;
	try {
		json = JSON.parse(text);
	} catch {
		json = undefined;
	}
	return { status: res.status, sessionId: res.headers.get('mcp-session-id'), json };
}

suite('MCP v1 application profile + operations error framing (#1317)', (ctx: ContextWithHarper) => {
	before(async () => {
		// mountPath set explicitly: flattenObject skips empty profile objects.
		await setupHarperWithFixture(ctx, FIXTURE_PATH, {
			config: { mcp: { operations: { mountPath: '/mcp' }, application: { mountPath: '/mcp' } } },
			env: {},
		});
	});

	after(async () => {
		await teardownHarper(ctx);
	});

	test('P1: initialize handshake succeeds on the application endpoint (was 500)', async () => {
		const { client, transport } = await newAppClient(ctx);
		const info = client.getServerVersion();
		ok(info?.name, 'serverInfo.name present after initialize');
		await transport.close();
	});

	test('P1: tools/list exposes auto-generated CRUD tools for the exported table', async () => {
		const { client, transport } = await newAppClient(ctx);
		const { tools } = await client.listTools();
		const names = tools.map((t) => t.name);
		ok(
			names.some((n) => /^create_/.test(n)),
			`expected a create_* tool, got: ${names.join(', ')}`
		);
		ok(
			names.some((n) => /^get_/.test(n)),
			`expected a get_* tool, got: ${names.join(', ')}`
		);
		await transport.close();
	});

	test('P1: create_/get_ round-trip persists and reads back a record', async () => {
		const { client, transport } = await newAppClient(ctx);
		const { tools } = await client.listTools();
		// Target the WorkItem table specifically — it's a full-CRUD @table @export.
		// (Don't just grab the first create_* tool: the fixture also has an
		// expiration-only AbuseCounter with no post handler.)
		const names = tools.map((t) => t.name);
		ok(
			names.includes('create_WorkItem') && names.includes('get_WorkItem'),
			`create_/get_ WorkItem present, got: ${names.join(', ')}`
		);

		// WorkItem.post (fixture) generates its own id and stores the body as the
		// `payload` field, returning { id, state }. Capture the id, then read back.
		const createRes: any = await client.callTool({
			name: 'create_WorkItem',
			arguments: { state: 'open', payload: 'hello-1317' },
		});
		ok(!createRes.isError, `create should succeed: ${JSON.stringify(createRes.content)}`);
		const created = JSON.parse((createRes.content ?? []).map((c: any) => c.text).join(''));
		ok(created.id, `create should return the new id: ${JSON.stringify(created)}`);

		const getRes: any = await client.callTool({ name: 'get_WorkItem', arguments: { id: created.id } });
		ok(!getRes.isError, `get should succeed: ${JSON.stringify(getRes.content)}`);
		const text = (getRes.content ?? []).map((c: any) => c.text).join('');
		match(text, /hello-1317/);
		await transport.close();
	});

	test('P1: resources/list includes the schema resource and harper://openapi', async () => {
		const { client, transport } = await newAppClient(ctx);
		const { resources } = await client.listResources();
		const uris = resources.map((r) => r.uri);
		ok(
			uris.some((u) => u.startsWith('harper://schema/')),
			`expected a harper://schema/{db}/{table} resource, got: ${uris.join(', ')}`
		);
		ok(uris.includes('harper://openapi'), `expected harper://openapi, got: ${uris.join(', ')}`);
		await transport.close();
	});

	test('S1: malformed JSON returns a JSON-RPC -32700 frame (application profile)', async () => {
		// The application profile reads the raw body itself, so the transport's
		// parseMessage surfaces a malformed envelope as a -32700 frame.
		const res = await rawRpc(ctx, { baseUrl: ctx.harper.httpURL, body: '{ this is not json' });
		strictEqual(res.status, 400);
		ok(res.json, 'response body is a JSON-RPC frame');
		strictEqual(res.json.error.code, -32700);
	});

	test('S1: malformed JSON on the operations profile returns Fastify HTTP 400 (spec-permitted)', async () => {
		// Operations uses Fastify's JSON body parser, which rejects malformed JSON
		// with an HTTP 400 before the handler runs. The Streamable HTTP transport
		// permits an HTTP error for unparseable input, so we don't force a -32700
		// frame here (that would require route encapsulation incompatible with
		// Harper's response serializers — #1317).
		const res = await rawRpc(ctx, { body: '{ this is not json' });
		strictEqual(res.status, 400);
	});

	test('S2: an unrecognized pagination cursor returns -32602 (operations profile)', async () => {
		// Establish a session via initialize, then page tools/list with a bogus cursor.
		const init = await rawRpc(ctx, {
			body: JSON.stringify({
				jsonrpc: '2.0',
				id: 1,
				method: 'initialize',
				params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'raw', version: '0' } },
			}),
		});
		strictEqual(init.status, 200);
		const sessionId = init.sessionId;
		ok(sessionId, 'initialize returned an Mcp-Session-Id');
		const negotiated = init.json.result.protocolVersion;

		const res = await rawRpc(ctx, {
			sessionId: sessionId!,
			protocolVersion: negotiated,
			body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: { cursor: 'not-a-real-cursor' } }),
		});
		strictEqual(res.status, 200);
		strictEqual(res.json.error.code, -32602);
	});
});
