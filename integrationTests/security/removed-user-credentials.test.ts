/**
 * Exercises stored-user credential admission and auditing through real HTTP requests.
 * https://github.com/HarperFast/harper/issues/4124 and https://github.com/HarperFast/harper/issues/4040
 */
import { ok, strictEqual } from 'node:assert';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
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
				logging: { auditAuthEvents: { logFailed: true } },
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

	async function addUser(username: string) {
		await expectStatus(
			await operation({ operation: 'add_user', username, password, role: 'credential_test', active: true }, admin),
			200
		);
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

	function waitForSession(request: () => Promise<Response>): Promise<Response> {
		return waitFor(
			async () => {
				const response = await request();
				if (response.status !== 401) return response;
				await response.text();
				return false;
			},
			{ timeout: 5000, message: 'expected the live session to authenticate' }
		);
	}

	function expectExpiredCookie(response: Response, cookie: string) {
		const cookieName = cookie.split('=')[0];
		const expired = response.headers.getSetCookie().find((value) => value.startsWith(`${cookieName}=;`));
		ok(expired?.includes('Expires=Thu, 01 Jan 1970 00:00:00 GMT'), 'expected the browser to discard the cookie');
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
					await addUser(username);
					const headers =
						credential === 'token'
							? { Authorization: `Bearer ${await issueToken({ username, password })}` }
							: await issueCookie(username);
					const request = () => (isOperations ? operation({ operation: 'user_info' }, headers) : mcp(headers));

					const admitted = credential === 'cookie' ? await waitForSession(request) : await request();
					const body = await expectStatus(admitted, 200);
					if (isOperations) strictEqual(JSON.parse(body).username, username);
					else ok(admitted.headers.get('mcp-session-id'), 'expected an MCP session');
					await expectStatus(await operation({ ...mutation, username }, admin), 200);
					const response = await request();
					await expectStatus(response, 401);
					if (!isOperations) strictEqual(response.headers.get('mcp-session-id'), null);
					if (headers.Cookie) expectExpiredCookie(response, headers.Cookie);
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
		await addUser(username);
		const token = await issueToken({ username, password, purpose: 'login' });
		await expectStatus(await operation({ operation: 'drop_user', username }, admin), 200);
		const response = await operation({ operation: 'login', token }, { Origin: origin });
		await expectStatus(response, 401);
		strictEqual(response.headers.get('set-cookie'), null);
	});

	test('a browser can retry login after the Operations API expires a dropped user’s cookie', async () => {
		await addUser('retired_session_user');
		await addUser('replacement_session_user');
		const session = await issueCookie('retired_session_user');
		await expectStatus(await waitForSession(() => operation({ operation: 'user_info' }, session)), 200);
		await expectStatus(await operation({ operation: 'drop_user', username: 'retired_session_user' }, admin), 200);

		const login = { operation: 'login', username: 'replacement_session_user', password };
		const rejected = await operation(login, session);
		await expectStatus(rejected, 401);
		expectExpiredCookie(rejected, session.Cookie);

		const retried = await operation(login, { Origin: origin });
		await expectStatus(retried, 200);
		const cookieName = session.Cookie.split('=')[0];
		const replacementCookie = retried.headers.getSetCookie().find((value) => value.startsWith(`${cookieName}=`));
		ok(replacementCookie && !replacementCookie.startsWith(`${cookieName}=;`), 'expected a fresh session cookie');
	});

	test('a rejected token request leaves the accompanying cookie out of the audit event', async () => {
		await addUser('audit_cookie_user');
		await addUser('audit_dropped_bearer');
		const session = await issueCookie('audit_cookie_user');
		const token = await issueToken({ username: 'audit_dropped_bearer', password });
		await expectStatus(await operation({ operation: 'drop_user', username: 'audit_dropped_bearer' }, admin), 200);

		const referer = `${origin}/credential-revocation-audit`;
		const denied = await operation(
			{ operation: 'user_info' },
			{ ...session, Authorization: `Bearer ${token}`, Referer: referer }
		);
		await expectStatus(denied, 401);
		strictEqual(denied.headers.get('set-cookie'), null, 'the unrelated cookie should be left alone');
		const logPath = join(ctx.harper.logDir ?? join(ctx.harper.dataRootDir, 'log'), 'hdb.log');
		const auditEvent = await waitFor(
			async () => {
				const log = await readFile(logPath, 'utf8');
				return log
					.split(/(?=^\d{4}-\d{2}-\d{2}T)/m)
					.find((entry) => entry.includes('[auth-event]') && entry.includes(referer));
			},
			{ timeout: 5000, message: 'expected a failed authentication audit event' }
		);
		const sessionId = session.Cookie.slice(session.Cookie.indexOf('=') + 1);
		ok(!auditEvent.includes(sessionId), 'authentication audit events must not contain a raw session ID');
	});
});
