/**
 * An `.optional` contract body over the live MCP application profile: no body keys on the tool's
 * required list, and a call without body arguments reaches the handler as an omitted body.
 *
 * Reproduction:
 *   npm run test:integration -- "integrationTests/mcp/contract-optional-body.test.ts"
 */
import { suite, test, before, after } from 'node:test';
import { deepStrictEqual, ok, strictEqual } from 'node:assert';
import { resolve } from 'node:path';
import { setupHarperWithFixture, teardownHarper, type ContextWithHarper } from '@harperfast/integration-testing';

const FIXTURE_PATH = resolve(import.meta.dirname, '../fixtures/mcp-contract-optional-body');

suite('MCP application tools honor an .optional contract body', (ctx: ContextWithHarper) => {
	let auth: string;
	let sessionId: string | undefined;
	let rpcId = 0;

	async function rpc(method: string, params?: unknown): Promise<any> {
		const res = await fetch(new URL('/mcp', ctx.harper.httpURL), {
			method: 'POST',
			headers: {
				'content-type': 'application/json',
				'accept': 'application/json, text/event-stream',
				'authorization': auth,
				...(sessionId ? { 'mcp-session-id': sessionId, 'mcp-protocol-version': '2025-06-18' } : {}),
			},
			body: JSON.stringify({ jsonrpc: '2.0', id: ++rpcId, method, params: params ?? {} }),
		});
		sessionId = res.headers.get('mcp-session-id') ?? sessionId;
		const text = await res.text();
		strictEqual(res.status, 200, `${method} should 200: ${text}`);
		return JSON.parse(text);
	}

	async function toolInputSchema(name: string): Promise<any> {
		const { result } = await rpc('tools/list', {});
		const tool = result.tools.find((candidate: any) => candidate.name === name);
		ok(tool, `${name} listed: ${JSON.stringify(result.tools.map((candidate: any) => candidate.name))}`);
		return tool.inputSchema;
	}

	before(async () => {
		await setupHarperWithFixture(ctx, FIXTURE_PATH, {
			config: { mcp: { application: { mountPath: '/mcp' } } },
		});
		auth = `Basic ${Buffer.from(`${ctx.harper.admin.username}:${ctx.harper.admin.password}`).toString('base64')}`;
		await rpc('initialize', {
			protocolVersion: '2025-06-18',
			capabilities: {},
			clientInfo: { name: 'contract-optional-body-it', version: '0' },
		});
	});

	after(async () => {
		await teardownHarper(ctx);
	});

	test('an .optional body leaves its keys off the advertised required list; a required body keeps them', async () => {
		strictEqual((await toolInputSchema('create_OptionalIntake')).required, undefined);
		deepStrictEqual((await toolInputSchema('create_RequiredIntake')).required, ['name']);
	});

	test('a call without body arguments reaches the handler as an omitted body', async () => {
		const { result } = await rpc('tools/call', { name: 'create_OptionalIntake', arguments: {} });
		strictEqual(result.isError, undefined, JSON.stringify(result));
		deepStrictEqual(result.structuredContent, { omitted: true });
	});

	test('a supplied body is still validated and forwarded', async () => {
		const { result } = await rpc('tools/call', { name: 'create_OptionalIntake', arguments: { name: 'a' } });
		strictEqual(result.isError, undefined, JSON.stringify(result));
		deepStrictEqual(result.structuredContent, { omitted: false, name: 'a' });
	});

	test('a required body is still rejected when omitted', async () => {
		const { result } = await rpc('tools/call', { name: 'create_RequiredIntake', arguments: {} });
		strictEqual(result.isError, true);
		ok(result.content[0].text.includes('body.name'), result.content[0].text);
	});
});
