/**
 * A request over the operations domain socket is trusted by its transport and runs as the fixed `local`
 * principal, which no stored user backs. `create_authentication_tokens` sent there with no credentials —
 * how a host agent mints the short-lived token new nodes use against this node — is minted for a stored,
 * active super user instead, so the token authenticates over TCP as that user and stays revocable. With
 * no such user the socket still administers the instance, and minting fails with a clear error.
 *
 * The first suite turns `authorizeLocal` off so a TCP request from the harness's loopback address is
 * not trusted itself: only the Bearer token can authenticate it, which the unauthenticated control
 * proves. The second keeps the harness default (on), where that loopback request is the principal.
 *
 * The first suite is skipped on Bun: the operations API there is served through Fastify inject(), whose
 * auth shim has no `_nodeRequest`, so the domain-socket trust it exercises does not apply
 * (server/operationsServer.ts).
 *
 * Run:
 *   npm run test:integration -- "integrationTests/security/local-principal-token-mint.test.ts"
 */
import { suite, test, before, after } from 'node:test';
import { strictEqual as equal, ok } from 'node:assert';
import { request } from 'node:http';
import { isAbsolute, join } from 'node:path';
import { startHarper, teardownHarper, type ContextWithHarper } from '@harperfast/integration-testing';

const skipSuite = process.env.HARPER_RUNTIME === 'bun' || process.platform === 'win32';

interface OperationResponse {
	status: number;
	body: any;
}

function overSocket(socketPath: string, operation: object): Promise<OperationResponse> {
	return new Promise((resolve, reject) => {
		const req = request(
			{ socketPath, path: '/', method: 'POST', headers: { 'Content-Type': 'application/json' } },
			(res) => {
				let text = '';
				res.setEncoding('utf8');
				res.on('data', (chunk) => (text += chunk));
				res.on('end', () => resolve({ status: res.statusCode, body: text && JSON.parse(text) }));
			}
		);
		req.on('error', reject);
		req.setTimeout(30_000, () => req.destroy(new Error('no response over the domain socket')));
		req.end(JSON.stringify(operation));
	});
}

async function overTcp(ctx: ContextWithHarper, operation: object, authorization?: string): Promise<OperationResponse> {
	const headers: Record<string, string> = { 'Content-Type': 'application/json' };
	if (authorization) headers.Authorization = authorization;
	const response = await fetch(ctx.harper.operationsAPIURL, {
		method: 'POST',
		headers,
		body: JSON.stringify(operation),
	});
	return { status: response.status, body: await response.json() };
}

const claimsOf = (token: string) => JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString());

suite('the operations domain socket runs as the local principal', { skip: skipSuite }, (ctx: ContextWithHarper) => {
	let socketPath: string;
	let adminBasic: string;

	before(async () => {
		await startHarper(ctx, { config: { authentication: { authorizeLocal: false } } });
		const { username, password } = ctx.harper.admin;
		adminBasic = `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}`;
		const config = await overTcp(ctx, { operation: 'get_configuration' }, adminBasic);
		equal(config.status, 200, JSON.stringify(config.body));
		const configured = config.body.operationsApi.network.domainSocket;
		socketPath = isAbsolute(configured) ? configured : join(ctx.harper.dataRootDir, configured);
	});

	after(async () => {
		await teardownHarper(ctx);
	});

	test('a TCP request with no credentials is not trusted', async () => {
		const response = await overTcp(ctx, { operation: 'user_info' });
		equal(response.status, 401, JSON.stringify(response.body));
	});

	test('a credential-free socket request is the local principal', async () => {
		const response = await overSocket(socketPath, { operation: 'user_info' });
		equal(response.status, 200, JSON.stringify(response.body));
		equal(response.body.username, 'local');
		equal(response.body.role.permission.super_user, true);
	});

	test('add_user refuses the reserved name', async () => {
		const response = await overSocket(socketPath, {
			operation: 'add_user',
			username: 'local',
			password: 'Reserved-Name-Pw1!',
			role: 'super_user',
			active: true,
		});
		equal(response.status, 400, JSON.stringify(response.body));
		ok(/reserved username/.test(response.body.error), JSON.stringify(response.body));
	});

	let operationToken: string;

	test('a token minted over the socket with no credentials authenticates over TCP as the stored admin', async () => {
		const minted = await overSocket(socketPath, { operation: 'create_authentication_tokens', expires_in: '5m' });
		equal(minted.status, 200, JSON.stringify(minted.body));
		operationToken = minted.body.operation_token;
		ok(minted.body.refresh_token, 'a refresh token is minted as before');
		const claims = claimsOf(operationToken);
		equal(claims.username, ctx.harper.admin.username);
		equal(claims.super_user, true);
		equal(claims.exp - claims.iat, 300);

		const asBearer = await overTcp(ctx, { operation: 'user_info' }, `Bearer ${operationToken}`);
		equal(asBearer.status, 200, JSON.stringify(asBearer.body));
		equal(asBearer.body.username, ctx.harper.admin.username);
	});

	test('with no stored users the socket still administers, minting fails clearly, and the token no longer authorizes', async () => {
		const users = await overSocket(socketPath, { operation: 'list_users' });
		equal(users.status, 200, JSON.stringify(users.body));
		// a raw system-table delete: drop_user refuses to remove the last super user
		const deleted = await overSocket(socketPath, {
			operation: 'delete',
			database: 'system',
			table: 'hdb_user',
			ids: users.body.map((user: { username: string }) => user.username),
		});
		equal(deleted.status, 200, JSON.stringify(deleted.body));

		const remaining = await overSocket(socketPath, { operation: 'list_users' });
		equal(remaining.status, 200, JSON.stringify(remaining.body));
		equal(remaining.body.length, 0);
		const principal = await overSocket(socketPath, { operation: 'user_info' });
		equal(principal.body.username, 'local');

		const minted = await overSocket(socketPath, { operation: 'create_authentication_tokens' });
		equal(minted.status, 409, JSON.stringify(minted.body));
		equal(minted.body.error, 'no user to mint a token for; create a user first');

		// a token naming a deleted user resolves to a principal with no role
		const asBearer = await overTcp(ctx, { operation: 'user_info' }, `Bearer ${operationToken}`);
		equal(asBearer.status, 403, JSON.stringify(asBearer.body));
	});
});

suite('a loopback request under authorizeLocal runs as the local principal', (ctx: ContextWithHarper) => {
	before(async () => {
		await startHarper(ctx);
	});

	after(async () => {
		await teardownHarper(ctx);
	});

	test('a credential-free TCP request is the local principal, and mints for the stored admin', async () => {
		const principal = await overTcp(ctx, { operation: 'user_info' });
		equal(principal.status, 200, JSON.stringify(principal.body));
		equal(principal.body.username, 'local');

		const minted = await overTcp(ctx, { operation: 'create_authentication_tokens' });
		equal(minted.status, 200, JSON.stringify(minted.body));
		equal(claimsOf(minted.body.operation_token).username, ctx.harper.admin.username);
	});
});
