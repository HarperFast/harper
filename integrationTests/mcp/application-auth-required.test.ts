/** The MCP SDK's own parser reads the challenge, so an off-the-shelf client can discover it. */
import { suite, test, before, after } from 'node:test';
import { deepStrictEqual, ok, strictEqual } from 'node:assert';
import { resolve } from 'node:path';
import { setupHarperWithFixture, teardownHarper, type ContextWithHarper } from '@harperfast/integration-testing';
import { extractWWWAuthenticateParams } from '@modelcontextprotocol/sdk/client/auth.js';

const FIXTURE_PATH = resolve(import.meta.dirname, '../fixtures/mcp-auth-required');
const RESOURCE_METADATA = 'https://auth.example.test/.well-known/oauth-protected-resource/mcp';
const VALID_TOKEN = 'auth-required-valid';
const REJECTED_TOKEN = 'auth-required-rejected';
const PROTOCOL_VERSION = '2025-06-18';

const initializeBody = JSON.stringify({
	jsonrpc: '2.0',
	id: 1,
	method: 'initialize',
	params: {
		protocolVersion: PROTOCOL_VERSION,
		capabilities: {},
		clientInfo: { name: 'auth-required-it', version: '0' },
	},
});

suite('MCP application profile: authentication.required (#4344)', (ctx: ContextWithHarper) => {
	let mcpUrl = '';
	let restUrl = '';
	let adminBasic = '';

	function post(headers: Record<string, string>, body = initializeBody) {
		return fetch(mcpUrl, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json', 'Accept': 'application/json, text/event-stream', ...headers },
			body,
		});
	}

	before(async () => {
		await setupHarperWithFixture(ctx, FIXTURE_PATH, {
			config: {
				threads: { count: 1 },
				authentication: { authorizeLocal: false },
				mcp: { application: { mountPath: '/mcp', authentication: { required: true } } },
			},
			env: {
				AUTHENTICATION_AUTHORIZELOCAL: 'false',
				HARPER_BUILTIN_COMPONENTS:
					'mcpAuthRequiredValidator=@/integrationTests/fixtures/mcp-auth-required/validator.js',
			},
		});
		restUrl = ctx.harper.httpURL;
		mcpUrl = `${restUrl}/mcp`;
		const { username, password } = ctx.harper.admin;
		adminBasic = `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}`;
	});

	after(async () => {
		await teardownHarper(ctx);
	});

	test('a tokenless initialize gets 401 with a challenge the MCP SDK resolves to the metadata URL', async () => {
		const response = await post({});
		const text = await response.text();
		strictEqual(response.status, 401, text);
		strictEqual(response.headers.get('www-authenticate'), `Bearer resource_metadata="${RESOURCE_METADATA}"`);
		strictEqual(response.headers.get('mcp-session-id'), null, 'no anonymous session is created');
		const params = extractWWWAuthenticateParams(response);
		strictEqual(params.resourceMetadataUrl?.href, RESOURCE_METADATA);
		strictEqual(params.error, undefined);
	});

	test('a tokenless GET gets the same challenge', async () => {
		const response = await fetch(mcpUrl, { headers: { Accept: 'text/event-stream' } });
		await response.text();
		strictEqual(response.status, 401);
		strictEqual(response.headers.get('www-authenticate'), `Bearer resource_metadata="${RESOURCE_METADATA}"`);
	});

	test('a Bearer token the validator rejects gets invalid_token with the metadata URL', async () => {
		const response = await post({ Authorization: `Bearer ${REJECTED_TOKEN}` });
		await response.text();
		strictEqual(response.status, 401);
		const params = extractWWWAuthenticateParams(response);
		strictEqual(params.error, 'invalid_token');
		strictEqual(params.resourceMetadataUrl?.href, RESOURCE_METADATA);
	});

	test('a Bearer token no validator recognizes gets invalid_token with the metadata URL', async () => {
		const response = await post({ Authorization: 'Bearer not-a-token-anyone-issued' });
		await response.text();
		strictEqual(response.status, 401);
		strictEqual(
			response.headers.get('www-authenticate'),
			`Bearer error="invalid_token", resource_metadata="${RESOURCE_METADATA}"`
		);
	});

	test('a valid Bearer token initializes, lists the custom tool and calls it as its user', async () => {
		const init = await post({ Authorization: `Bearer ${VALID_TOKEN}` });
		const initText = await init.text();
		strictEqual(init.status, 200, initText);
		const sessionId = init.headers.get('mcp-session-id');
		ok(sessionId, 'expected an Mcp-Session-Id');
		const session = {
			'Authorization': `Bearer ${VALID_TOKEN}`,
			'mcp-session-id': sessionId!,
			'mcp-protocol-version': PROTOCOL_VERSION,
		};

		const list = await post(session, JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }));
		const listText = await list.text();
		strictEqual(list.status, 200, listText);
		const names = (JSON.parse(listText).result?.tools ?? []).map((tool: { name: string }) => tool.name);
		ok(names.includes('auth_required_whoami'), `expected auth_required_whoami in ${names.join(', ')}`);

		const call = await post(
			session,
			JSON.stringify({
				jsonrpc: '2.0',
				id: 3,
				method: 'tools/call',
				params: { name: 'auth_required_whoami', arguments: {} },
			})
		);
		const callText = await call.text();
		strictEqual(call.status, 200, callText);
		const result = JSON.parse(callText).result;
		strictEqual(result.isError, undefined, callText);
		deepStrictEqual(JSON.parse(result.content[0].text), { username: 'admin' });
	});

	test('Harper Basic credentials still authenticate the required mount', async () => {
		const response = await post({ Authorization: adminBasic });
		const text = await response.text();
		strictEqual(response.status, 200, text);
	});

	test('a route outside the mount keeps its own rejection, with no resource_metadata', async () => {
		const response = await fetch(`${restUrl}/AuthRequiredProbe/`, {
			headers: { Authorization: 'Bearer not-a-token-anyone-issued' },
		});
		await response.text();
		strictEqual(response.status, 401);
		strictEqual(response.headers.get('www-authenticate'), 'Bearer realm="Harper", error="invalid_token"');
	});
});
