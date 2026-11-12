/**
 * encrypted_operation against a running node with a test custody key: a relay carries
 * only ciphertext, the node runs the sealed operation as the caller, and neither sealed values nor the
 * result reach the node's info-level log. The unix-socket case is the Fabric relay path: the socket
 * authenticates as the super user with no credentials, and the minted token comes back sealed. It is
 * skipped on Bun, which serves the operations API through Fastify inject() rather than on the socket
 * (server/operationsServer.ts).
 *
 * Run:
 *   npm run build && npm run test:integration -- "integrationTests/security/encrypted-operation.test.ts"
 */
import { suite, test, before, after } from 'node:test';
import { deepStrictEqual, ok, strictEqual, throws } from 'node:assert';
import { request as httpRequest } from 'node:http';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { setupHarperWithFixture, teardownHarper, type ContextWithHarper } from '@harperfast/integration-testing';
// @ts-expect-error utils/client.mjs has no type declarations; runtime resolves fine
import { createApiClient, createHeaders } from '../apiTests/utils/client.mjs';
import { openResponse, sealOperation } from '../../dist/utility/sealedOperation.js';

const FIXTURE_PATH = resolve(import.meta.dirname, 'fixtures/encrypted-operation');
const TABLE = 'EncryptedOperationDog';
const MARKER = 'eo-integration-sealed-marker-7f3a';
const SCOPED_ROLE = 'eo_scoped_role';
const SCOPED = { username: 'eo_scoped_user', password: 'Eo-scoped-pw-1!' };

function postOverSocket(socketPath: string, body: unknown): Promise<{ status: number; body: any }> {
	return new Promise((resolvePost, reject) => {
		const req = httpRequest(
			{ socketPath, method: 'POST', path: '/', headers: { 'Content-Type': 'application/json' } },
			(res) => {
				let text = '';
				res.setEncoding('utf8');
				res.on('data', (chunk) => (text += chunk));
				res.on('end', () => resolvePost({ status: res.statusCode, body: JSON.parse(text) }));
			}
		);
		req.on('error', reject);
		req.end(JSON.stringify(body));
	});
}

// The UDS path must stay short: sun_path is limited to ~104 bytes on macOS.
const socketDirectory = process.platform === 'win32' ? undefined : mkdtempSync(join(tmpdir(), 'eo-'));
const socketPath = socketDirectory && join(socketDirectory, 'ops.sock');

suite('encrypted_operation on a running node', { skip: process.platform === 'win32' }, (ctx: ContextWithHarper) => {
	let client: ReturnType<typeof createApiClient>;
	let publicKey: string;
	let kid: string;
	let logPath: string;

	const readLog = () => (existsSync(logPath) ? readFileSync(logPath, 'utf8') : '');

	async function sealedCall(
		op: Record<string, any>,
		options: Record<string, unknown> = {},
		headers?: Record<string, string>
	) {
		const { request, responseKey, nonce } = sealOperation({ op: op as any, publicKey, kid, ...options });
		const response = await (headers ? client.reqAs(headers) : client.req()).send(request);
		return {
			request,
			response,
			responseKey,
			nonce,
			open: () => openResponse(response.body.encrypted_response, responseKey, nonce),
		};
	}

	before(async () => {
		await setupHarperWithFixture(ctx, FIXTURE_PATH, {
			config: { logging: { level: 'info' }, operationsApi: { network: { domainSocket: socketPath } } },
			env: {
				HARPER_BUILTIN_COMPONENTS:
					'encryptedOperationTestCustody=@/integrationTests/security/fixtures/encrypted-operation/registerCustody.js',
			},
		});
		client = createApiClient(ctx.harper);
		logPath = ctx.harper.logDir ? join(ctx.harper.logDir, 'hdb.log') : join(ctx.harper.dataRootDir, 'log', 'hdb.log');

		const deadline = Date.now() + 30_000;
		while (Date.now() < deadline) {
			const keyResponse = await client.req().send({ operation: 'get_secrets_public_key' });
			if (keyResponse.status === 200 && keyResponse.body?.fingerprint) {
				publicKey = keyResponse.body.public_key;
				kid = keyResponse.body.fingerprint;
				break;
			}
			await sleep(250);
		}
		ok(publicKey, 'the test custody never registered');

		await client
			.req()
			.send({ operation: 'create_table', database: 'data', table: TABLE, primary_key: 'id' })
			.expect(200);
		await client
			.req()
			.send({
				operation: 'add_role',
				role: SCOPED_ROLE,
				permission: { super_user: false, operations: ['encrypted_operation', 'user_info'] },
			})
			.expect(200);
		await client
			.req()
			.send({
				operation: 'add_user',
				role: SCOPED_ROLE,
				username: SCOPED.username,
				password: SCOPED.password,
				active: true,
			})
			.expect(200);
	});

	after(async () => {
		await teardownHarper(ctx);
		if (socketDirectory) rmSync(socketDirectory, { recursive: true, force: true });
	});

	test('mints tokens over the operations socket with no credentials and returns them sealed', async (t) => {
		if (process.env.HARPER_RUNTIME === 'bun') return t.skip('Bun does not serve the operations domain socket');
		const { request, responseKey, nonce } = sealOperation({
			op: { operation: 'create_authentication_tokens' },
			publicKey,
			kid,
			actor: 'eo-integration-socket',
		});
		const reply = await postOverSocket(socketPath, request);
		strictEqual(reply.status, 200);
		deepStrictEqual(Object.keys(reply.body), ['encrypted_response']);
		const result = openResponse(reply.body.encrypted_response, responseKey, nonce);
		strictEqual(result.status, 200);
		const token = result.body.operation_token;
		ok(typeof token === 'string' && token.length > 20, 'no operation token in the sealed result');
		ok(!JSON.stringify(reply.body).includes(token), 'the token crossed the relay in plaintext');

		const info = await client
			.reqAs({ 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' })
			.send({ operation: 'user_info' });
		strictEqual(info.status, 200, JSON.stringify(info.body));

		await sleep(500);
		const log = readLog();
		ok(log.includes('eo-integration-socket'), 'the sealed operation was never logged');
		ok(!log.includes(token), 'the minted token reached the node log');
		ok(!log.includes(result.body.refresh_token), 'the refresh token reached the node log');
	});

	test('writes a fields-mode insert whose values never appear in plaintext or in the log', async () => {
		const { request, response, open } = await sealedCall(
			{ operation: 'insert', database: 'data', table: TABLE, records: [{ id: 1, secret: MARKER }] },
			{ mode: 'fields' }
		);
		strictEqual(response.status, 200);
		strictEqual(response.body.status, 200);
		ok(!request.op.includes(MARKER));
		strictEqual(open().status, 200);

		const read = await client
			.req()
			.send({ operation: 'search_by_id', database: 'data', table: TABLE, ids: [1], get_attributes: ['*'] });
		strictEqual(read.body[0].secret, MARKER);

		await sleep(500);
		const log = readLog();
		ok(log.includes(TABLE), 'the visible table name was not logged');
		ok(log.includes('[sealed]'), 'the sealed values were not masked in the log');
		ok(!log.includes(MARKER), 'a sealed value reached the node log');
	});

	test('refuses a replayed envelope', async () => {
		const { request } = await sealedCall({ operation: 'describe_all' });
		const replay = await client.req().send(request);
		strictEqual(replay.status, 409, JSON.stringify(replay.body));
	});

	test('authorizes the wrapper and the inner operation for a restricted role', async () => {
		const headers = createHeaders(SCOPED.username, SCOPED.password);
		const allowed = await sealedCall({ operation: 'user_info' }, {}, headers);
		strictEqual(allowed.open().status, 200);
		strictEqual(allowed.open().body.username, SCOPED.username);
		const denied = await sealedCall({ operation: 'describe_all' }, {}, headers);
		strictEqual(denied.open().status, 403);
	});

	test("answers another key's envelope with this node's fingerprint and a tampered reply fails to open", async () => {
		const foreign = sealOperation({
			op: { operation: 'describe_all' },
			publicKey: (await import('node:crypto')).generateKeyPairSync('rsa', {
				modulusLength: 2048,
				publicKeyEncoding: { type: 'spki', format: 'pem' },
				privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
			}).publicKey,
			kid: 'f'.repeat(64),
		});
		const mismatch = await client.req().send(foreign.request);
		strictEqual(mismatch.status, 409);
		strictEqual(mismatch.body.custody_fingerprint, kid);

		const { response, responseKey, nonce, open } = await sealedCall({ operation: 'describe_all' });
		strictEqual(open().status, 200);
		const tampered = { ...response.body.encrypted_response, tag: Buffer.alloc(16).toString('base64') };
		throws(() => openResponse(tampered, responseKey, nonce));
	});
});
