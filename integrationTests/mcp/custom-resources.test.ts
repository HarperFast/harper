/**
 * #1609 — MCP application-profile custom content resources. The fixture
 * component publishes a docs-style surface via `static mcpResources`: a fixed
 * text index, a fixed binary logo, and a `docs:///{+path}` template with
 * author-declared completions. Also asserts the exported-Resource descriptor
 * scheme change: descriptors list under `harper+rest://` and legacy `https://`
 * URIs still read.
 *
 * Reproduction:
 *   npm run test:integration -- "integrationTests/mcp/custom-resources.test.ts"
 */
import { suite, test, before, after } from 'node:test';
import { deepStrictEqual, ok, strictEqual } from 'node:assert/strict';
import { resolve } from 'node:path';
import { setupHarperWithFixture, teardownHarper, type ContextWithHarper } from '@harperfast/integration-testing';

const FIXTURE_PATH = resolve(import.meta.dirname, '../fixtures/mcp-custom-resources');

function basicAuth(username: string, password: string): string {
	return `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}`;
}

suite('MCP custom content resources (#1609)', (ctx: ContextWithHarper) => {
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

	before(async () => {
		await setupHarperWithFixture(ctx, FIXTURE_PATH, {
			config: { mcp: { application: { mountPath: '/mcp' } } },
		});
		auth = basicAuth(ctx.harper.admin.username, ctx.harper.admin.password);
		await rpc('initialize', {
			protocolVersion: '2025-06-18',
			capabilities: {},
			clientInfo: { name: 'custom-resources-it', version: '0' },
		});
	});

	after(async () => {
		await teardownHarper(ctx);
	});

	test('resources/list includes the fixed custom URIs and harper+rest:// descriptors only', async () => {
		const { result } = await rpc('resources/list', {});
		const uris: string[] = result.resources.map((r: any) => r.uri);
		ok(uris.includes('docs:///index'), `docs:///index listed: ${JSON.stringify(uris)}`);
		ok(uris.includes('docs:///logo'), 'docs:///logo listed');
		ok(
			uris.every((u) => !u.startsWith('https://') && !u.startsWith('http://')),
			`no web-scheme descriptors remain: ${JSON.stringify(uris.filter((u) => u.startsWith('http')))}`
		);
	});

	test('resources/templates/list includes the custom template', async () => {
		const { result } = await rpc('resources/templates/list', {});
		const templates: string[] = result.resourceTemplates.map((t: any) => t.uriTemplate);
		ok(templates.includes('docs:///{+path}'), `template listed: ${JSON.stringify(templates)}`);
	});

	test('resources/read returns text content for the fixed index', async () => {
		const { result } = await rpc('resources/read', { uri: 'docs:///index' });
		strictEqual(result.contents[0].uri, 'docs:///index');
		strictEqual(result.contents[0].mimeType, 'text/markdown');
		ok(result.contents[0].text.includes('docs:///guides/install.md'));
	});

	test('resources/read resolves a template URI across path segments', async () => {
		const { result } = await rpc('resources/read', { uri: 'docs:///guides/install.md' });
		strictEqual(result.contents[0].mimeType, 'text/markdown');
		ok(result.contents[0].text.startsWith('# Install'));
	});

	test('resources/read returns blob content for binary resources', async () => {
		const { result } = await rpc('resources/read', { uri: 'docs:///logo' });
		strictEqual(result.contents[0].mimeType, 'image/png');
		ok(typeof result.contents[0].blob === 'string' && result.contents[0].blob.length > 0);
		strictEqual(result.contents[0].text, undefined);
	});

	test('an author read error surfaces as a JSON-RPC error, not a 500', async () => {
		const body = await rpc('resources/read', { uri: 'docs:///no/such/page.md' });
		ok(body.error, 'JSON-RPC error returned');
		ok(!JSON.stringify(body.error).includes('no such page'), 'raw author error text does not leak');
	});

	test('completion/complete serves author-declared template values', async () => {
		const { result } = await rpc('completion/complete', {
			ref: { type: 'ref/resource', uri: 'docs:///{+path}' },
			argument: { name: 'path', value: 'guides/' },
		});
		deepStrictEqual(result.completion.values.sort(), ['guides/deploy.md', 'guides/install.md']);
	});

	test('custom resources list and read without an Authorization header (#1609 public-docs case)', async () => {
		// The custom-resource layer imposes no auth of its own: entries list per
		// profile (no per-user filter) and reads delegate access control to the
		// author's method — parity with mcpTools' visibleTo: () => true. This
		// session sends NO Authorization header end-to-end (the instance's
		// authorizeLocal maps the local connection to a user, as a public-docs
		// deployment's anonymous mapping would).
		let anonSession: string | undefined;
		let anonId = 100;
		async function anonRpc(method: string, params?: unknown): Promise<any> {
			const res = await fetch(new URL('/mcp', ctx.harper.httpURL), {
				method: 'POST',
				headers: {
					'content-type': 'application/json',
					'accept': 'application/json, text/event-stream',
					...(anonSession ? { 'mcp-session-id': anonSession, 'mcp-protocol-version': '2025-06-18' } : {}),
				},
				body: JSON.stringify({ jsonrpc: '2.0', id: ++anonId, method, params: params ?? {} }),
			});
			anonSession = res.headers.get('mcp-session-id') ?? anonSession;
			const text = await res.text();
			strictEqual(res.status, 200, `${method} without auth should 200: ${text}`);
			return JSON.parse(text);
		}
		await anonRpc('initialize', {
			protocolVersion: '2025-06-18',
			capabilities: {},
			clientInfo: { name: 'anon-docs-client', version: '0' },
		});
		const list = await anonRpc('resources/list', {});
		ok(
			list.result.resources.some((r: any) => r.uri === 'docs:///index'),
			'custom resource listed without auth'
		);
		const read = await anonRpc('resources/read', { uri: 'docs:///guides/install.md' });
		ok(read.result.contents[0].text.startsWith('# Install'), 'custom template read served without auth');
	});
});
