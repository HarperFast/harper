/**
 * A login token (`create_authentication_tokens` with `purpose: 'login'`) is exchanged by the `login` operation for a
 * session cookie. It is bound to the user record it was minted for, so changing that user's password, dropping the
 * user, or dropping and recreating the username leaves it unredeemable, and its lifetime is capped by
 * `authentication.maxLoginTokenTimeout` whatever `expires_in` asks for (harper#4618).
 *
 * `authorizeLocal` is off so the harness's loopback requests authenticate only by the credentials they carry.
 * Skipped on Bun: the operations API there is served through Fastify inject(), which sets no session cookie.
 *
 * Run:
 *   npm run test:integration -- "integrationTests/security/login-token-binding.test.ts"
 */
import { suite, test, before, after } from 'node:test';
import { strictEqual as equal, ok } from 'node:assert';
import { startHarper, teardownHarper, type ContextWithHarper } from '@harperfast/integration-testing';

const skipSuite = process.env.HARPER_RUNTIME === 'bun';

const PASSWORD = 'Login-Token-Pw1!';
const ROLE = 'login_token_role';

interface OperationResponse {
	status: number;
	body: any;
	setCookie: string[];
}

const claimsOf = (token: string) => JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString());

suite(
	'a login token is bound to its stored user and capped in lifetime',
	{ skip: skipSuite },
	(ctx: ContextWithHarper) => {
		let adminBasic: string;

		async function operation(body: object, authorization?: string): Promise<OperationResponse> {
			const headers: Record<string, string> = { 'Content-Type': 'application/json' };
			if (authorization) headers.Authorization = authorization;
			const response = await fetch(ctx.harper.operationsAPIURL, {
				method: 'POST',
				headers,
				body: JSON.stringify(body),
			});
			const text = await response.text();
			let parsed: any = text;
			try {
				parsed = JSON.parse(text);
			} catch {}
			return { status: response.status, body: parsed, setCookie: response.headers.getSetCookie() };
		}

		async function asAdmin(body: object): Promise<any> {
			const response = await operation(body, adminBasic);
			equal(response.status, 200, `${JSON.stringify(body)}: ${JSON.stringify(response.body)}`);
			return response.body;
		}

		async function addUser(username: string, password = PASSWORD) {
			await asAdmin({ operation: 'add_user', username, password, role: ROLE, active: true });
		}

		async function operationToken(username: string, password = PASSWORD): Promise<string> {
			const minted = await operation({ operation: 'create_authentication_tokens', username, password });
			equal(minted.status, 200, JSON.stringify(minted.body));
			return minted.body.operation_token;
		}

		async function mintLoginToken(fields: object, authorization?: string): Promise<string> {
			const minted = await operation(
				{ operation: 'create_authentication_tokens', purpose: 'login', ...fields },
				authorization
			);
			equal(minted.status, 200, JSON.stringify(minted.body));
			ok(minted.body.operation_token, JSON.stringify(minted.body));
			return minted.body.operation_token;
		}

		function login(token: string): Promise<OperationResponse> {
			return operation({ operation: 'login', token });
		}

		function assertLoggedIn(response: OperationResponse) {
			equal(response.status, 200, JSON.stringify(response.body));
			ok(
				response.setCookie.some((cookie) => cookie.includes('hdb-session=')),
				`expected an hdb-session cookie, got ${JSON.stringify(response.setCookie)}`
			);
		}

		before(async () => {
			await startHarper(ctx, {
				config: { authentication: { authorizeLocal: false, maxLoginTokenTimeout: '2m' } },
			});
			adminBasic = `Basic ${Buffer.from(`${ctx.harper.admin.username}:${ctx.harper.admin.password}`).toString('base64')}`;
			await asAdmin({ operation: 'add_role', role: ROLE, permission: { super_user: false } });
		});

		after(async () => {
			await teardownHarper(ctx);
		});

		test('a login token minted with the password logs in', async () => {
			await addUser('login_mint');
			const token = await mintLoginToken({ username: 'login_mint', password: PASSWORD });
			const claims = claimsOf(token);
			equal(claims.username, 'login_mint');
			equal(claims.exp - claims.iat, 60);
			assertLoggedIn(await login(token));
		});

		test('a longer expires_in is capped to maxLoginTokenTimeout', async () => {
			await addUser('login_cap');
			const bearer = `Bearer ${await operationToken('login_cap')}`;
			const token = await mintLoginToken({ expires_in: '3650d' }, bearer);
			const claims = claimsOf(token);
			equal(claims.exp - claims.iat, 120);
			const shorter = claimsOf(await mintLoginToken({ expires_in: 30 }, bearer));
			equal(shorter.exp - shorter.iat, 30);
			assertLoggedIn(await login(token));
		});

		test('a password change ends a login token minted before it', async () => {
			await addUser('login_password');
			const token = await mintLoginToken({ username: 'login_password', password: PASSWORD });
			await asAdmin({ operation: 'alter_user', username: 'login_password', password: 'Changed-Login-Pw2!' });
			equal((await login(token)).status, 401);
			assertLoggedIn(await login(await mintLoginToken({ username: 'login_password', password: 'Changed-Login-Pw2!' })));
		});

		test('another token mint for the same user leaves a login token usable', async () => {
			await addUser('login_refresh');
			const token = await mintLoginToken({ username: 'login_refresh', password: PASSWORD });
			// rewrites the stored refresh token on the same hdb_user record
			await operationToken('login_refresh');
			assertLoggedIn(await login(token));
		});

		test('drop_user ends a login token minted credential-free from an operation token', async () => {
			await addUser('login_drop');
			const bearer = `Bearer ${await operationToken('login_drop')}`;
			const token = await mintLoginToken({}, bearer);
			await asAdmin({ operation: 'drop_user', username: 'login_drop' });
			equal((await login(token)).status, 401);
		});

		test('a login token does not carry over to a user recreated under the same name', async () => {
			await addUser('login_recreate');
			const token = await mintLoginToken({ username: 'login_recreate', password: PASSWORD });
			await asAdmin({ operation: 'drop_user', username: 'login_recreate' });
			await addUser('login_recreate');
			equal((await login(token)).status, 401);
			assertLoggedIn(await login(await mintLoginToken({ username: 'login_recreate', password: PASSWORD })));
		});
	}
);
