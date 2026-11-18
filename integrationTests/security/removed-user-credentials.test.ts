/**
 * The Operations API and MCP reject stored users' credentials after drop_user or deactivation.
 * https://github.com/HarperFast/harper/issues/4124 and https://github.com/HarperFast/harper/issues/4040
 */
import { ok, strictEqual } from 'node:assert';
import { after, before, suite, test } from 'node:test';
import { startHarper, teardownHarper, type ContextWithHarper } from '@harperfast/integration-testing';
import { waitFor } from '../../unitTests/waitFor.js';

const initialize = {
	jsonrpc: '2.0',
	id: 1,
	method: 'initialize',
	params: {
		protocolVersion: '2025-06-18',
		capabilities: {},
		clientInfo: { name: 'removed-user-credentials', version: '1' },
	},
};
const password = 'Credential-revocation-test!';

suite('Stored user credential revocation', (ctx: ContextWithHarper) => {
	let admin: Record<string, string>;
	let origin: string;

	before(async () => {
		await startHarper(ctx, {
			config: {
				authentication: { authorizeLocal: false },
				mcp: { application: { mountPath: '/mcp', authentication: { required: true } } },
				threads: { count: 1 },
			},
			env: { AUTHENTICATION_AUTHORIZELOCAL: 'false' },
		});
		const { username, password } = ctx.harper.admin;
		admin = { Authorization: `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}` };
		origin = new URL(ctx.harper.httpURL).origin;
		await expectStatus(
			await operation({ operation: 'add_role', role: 'credential_test', permission: { super_user: false } }, admin),
			200
		);
	});

	after(async () => {
		await teardownHarper(ctx);
	});

	function operation(body: Record<string, unknown>, headers: Record<string, string> = {}) {
		return fetch(ctx.harper.operationsAPIURL, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json', ...headers },
			body: JSON.stringify(body),
		});
	}

	function mcp(headers: Record<string, string>) {
		return fetch(`${ctx.harper.httpURL}/mcp`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json', 'Accept': 'application/json, text/event-stream', ...headers },
			body: JSON.stringify(initialize),
		});
	}

	async function expectStatus(response: Response, status: number) {
		const body = await response.text();
		strictEqual(response.status, status, body);
		return body;
	}

	async function issueToken(fields: Record<string, unknown>) {
		const body = await expectStatus(
			await operation({ operation: 'create_authentication_tokens', expires_in: '10m', ...fields }, admin),
			200
		);
		const token = JSON.parse(body).operation_token;
		ok(token, 'expected an operation token');
		return token;
	}

	async function issueCookie(username: string) {
		const response = await operation({ operation: 'login', username, password }, { Origin: origin });
		await expectStatus(response, 200);
		const cookie = response.headers
			.getSetCookie()
			.map((value) => value.split(';')[0])
			.find((value) => value.includes('-hdb-session='));
		ok(cookie, 'expected a session cookie');
		return { Cookie: cookie, Origin: origin };
	}

	for (const [change, mutation] of [
		['dropping', { operation: 'drop_user' }],
		['deactivating', { operation: 'alter_user', active: false }],
	] as const) {
		for (const credential of ['token', 'cookie'] as const) {
			for (const surface of ['Operations API', 'MCP initialize'] as const) {
				test(`${surface} rejects the ${credential} after ${change} its user`, async () => {
					const isOperations = surface === 'Operations API';
					const username = `${change}_${credential}_${isOperations ? 'ops' : 'mcp'}`;
					await expectStatus(
						await operation(
							{ operation: 'add_user', username, password, role: 'credential_test', active: true },
							admin
						),
						200
					);
					const headers =
						credential === 'token'
							? { Authorization: `Bearer ${await issueToken({ username, password })}` }
							: await issueCookie(username);
					const request = () => (isOperations ? operation({ operation: 'user_info' }, headers) : mcp(headers));

					const admitted =
						credential === 'cookie'
							? await waitFor(
									async () => {
										const response = await request();
										if (response.status !== 401) return response;
										await response.text();
										return false;
									},
									{ timeout: 5000, message: 'expected the live session to authenticate' }
								)
							: await request();
					const body = await expectStatus(admitted, 200);
					if (isOperations) strictEqual(JSON.parse(body).username, username);
					else ok(admitted.headers.get('mcp-session-id'), 'expected an MCP session');
					await expectStatus(await operation({ ...mutation, username }, admin), 200);
					const response = await request();
					await expectStatus(response, 401);
					if (!isOperations) strictEqual(response.headers.get('mcp-session-id'), null);
				});
			}
		}
	}

	test('MCP initialize accepts a scoped token without a user record', async () => {
		const token = await issueToken({ username: 'scoped_credential_test', role: { permission: {} } });
		const response = await mcp({ Authorization: `Bearer ${token}` });
		await expectStatus(response, 200);
		ok(response.headers.get('mcp-session-id'), 'expected an MCP session');
	});

	test('a login-purpose token for a dropped user cannot create a session', async () => {
		const username = 'dropped_login_token';
		await expectStatus(
			await operation({ operation: 'add_user', username, password, role: 'credential_test', active: true }, admin),
			200
		);
		const token = await issueToken({ username, password, purpose: 'login' });
		await expectStatus(await operation({ operation: 'drop_user', username }, admin), 200);
		const response = await operation({ operation: 'login', token }, { Origin: origin });
		await expectStatus(response, 401);
		strictEqual(response.headers.get('set-cookie'), null);
	});
});
