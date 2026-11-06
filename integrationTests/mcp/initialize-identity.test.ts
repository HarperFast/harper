/**
 * MCP `initialize` admission identity (PR #3537): the socket IP, or the first (client-most) value of
 * `mcp.<profile>.rateLimit.identityHeader` when that key is set (`docs/reference/mcp/configuration.md`
 * "identityHeader"; `components/mcp/rateLimit.ts` `resolveClientIdentity`). Covers the operations profile
 * (Fastify adapter: `request.ip`, no `trustProxy`) and the application profile with
 * `identityHeader: x-forwarded-for`. The identityHeader warning is emitted on a worker's first rate-limit
 * config read (`rateLimit.ts` `configFor`), not at startup, so the log arm runs after the traffic arms.
 *
 * One boot, `threads.count: 1`, `authorizeLocal: false`. Each arm uses its own loopback source address, so
 * no arm inherits a bucket another one spent.
 */
import { suite, test, before, after } from 'node:test';
import assert from 'node:assert';
import { resolve } from 'node:path';
import { request as httpRequest } from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';
import { setupHarperWithFixture, teardownHarper, type ContextWithHarper } from '@harperfast/integration-testing';

const FIXTURE_PATH = resolve(import.meta.dirname, '../fixtures/mcp-initialize-limit');
const RATE = 0.01;
const BURST = 4;
const RETRY_AFTER = String(Math.ceil(1 / RATE));
const IDENTITY_HEADER = 'x-forwarded-for';
const OPTIONS = {
	config: {
		threads: { count: 1 },
		mcp: {
			operations: { mountPath: '/mcp', rateLimit: { initializePerSecond: RATE, initializeBurst: BURST } },
			application: {
				mountPath: '/mcp',
				rateLimit: { initializePerSecond: RATE, initializeBurst: BURST, identityHeader: IDENTITY_HEADER },
			},
		},
		authentication: { authorizeLocal: false },
	},
	env: { AUTHENTICATION_AUTHORIZELOCAL: 'false' },
};
const SRC_O1 = '127.0.0.2';
const SRC_O2 = '127.0.0.3';
const SRC_H1 = '127.0.0.4';
const SRC_H2 = '127.0.0.5';
const SRC_H3 = '127.0.0.6';
const SRC_H4 = '127.0.0.7';

type Reply = { status: number; headers: Record<string, string | string[] | undefined>; text: string; json: any };

function standardParams(name: string) {
	return {
		protocolVersion: '2025-06-18',
		capabilities: { roots: { listChanged: true } },
		clientInfo: { name, version: '0' },
	};
}

suite(
	'MCP initialize admission identity: operations profile and identityHeader',
	{
		skip: process.platform === 'win32' && 'requires loopback source-address aliases',
	},
	(ctx: ContextWithHarper) => {
		let admin: string;
		let appUrl: URL;
		let opsUrl: URL;

		function initialize(
			target: URL,
			localAddress: string,
			extraHeaders: Record<string, string> = {},
			name = 'initialize-identity'
		): Promise<Reply> {
			const payload = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: standardParams(name) });
			return new Promise((resolveReply, reject) => {
				const req = httpRequest(
					{
						host: target.hostname,
						port: Number(target.port),
						path: target.pathname,
						method: 'POST',
						localAddress,
						agent: false,
						headers: {
							'content-type': 'application/json',
							'accept': 'application/json, text/event-stream',
							'content-length': Buffer.byteLength(payload),
							...extraHeaders,
						},
						timeout: 60_000,
					},
					(res) => {
						let text = '';
						res.setEncoding('utf8');
						res.on('error', reject);
						res.on('close', () => {
							if (!res.complete)
								reject(new Error(`initialize from ${localAddress}: connection closed before the response completed`));
						});
						res.on('data', (chunk) => (text += chunk));
						res.on('end', () => {
							let json: any;
							try {
								json = JSON.parse(text);
							} catch {
								json = undefined;
							}
							resolveReply({ status: res.statusCode ?? 0, headers: res.headers, text, json });
						});
					}
				);
				req.on('error', reject);
				req.on('timeout', () => req.destroy(new Error(`initialize from ${localAddress} timed out`)));
				req.end(payload);
			});
		}
		const app = (src: string, headers: Record<string, string> = {}) => initialize(appUrl, src, headers);
		const ops = (src: string, headers: Record<string, string> = {}) =>
			initialize(opsUrl, src, { Authorization: admin, ...headers });

		async function sessionCount(): Promise<number> {
			const response = await fetch(`${ctx.harper.httpURL}/McpInitializeSessions/`, {
				headers: { Authorization: admin, Accept: 'application/json' },
				signal: AbortSignal.timeout(45_000),
			});
			const text = await response.text();
			assert.strictEqual(response.status, 200, `sessions oracle: ${response.status} ${text.slice(0, 300)}`);
			const body = JSON.parse(text);
			assert.ok(Array.isArray(body.rows), `sessions oracle body: ${text.slice(0, 300)}`);
			assert.strictEqual(
				body.loaded,
				true,
				`sessions oracle: system.mcp_session not loaded in the worker: ${text.slice(0, 300)}`
			);
			return body.rows.length;
		}
		function expectAdmitted(reply: Reply, label: string): string {
			assert.strictEqual(reply.status, 200, `${label}: ${reply.status} ${reply.text.slice(0, 300)}`);
			const id = reply.headers['mcp-session-id'];
			assert.ok(
				typeof id === 'string' && id.length > 0,
				`${label}: no Mcp-Session-Id: ${JSON.stringify(reply.headers)}`
			);
			assert.ok(reply.json?.result?.protocolVersion, `${label}: no initialize result: ${reply.text.slice(0, 300)}`);
			return id;
		}
		function expectDenied(reply: Reply, label: string) {
			assert.strictEqual(reply.status, 429, `${label}: ${reply.status} ${reply.text.slice(0, 300)}`);
			assert.strictEqual(
				reply.headers['retry-after'],
				RETRY_AFTER,
				`${label}: Retry-After ${JSON.stringify(reply.headers)}`
			);
			assert.strictEqual(
				reply.headers['mcp-session-id'],
				undefined,
				`${label}: a denied initialize carried a session id`
			);
			assert.strictEqual(reply.json?.jsonrpc, '2.0', `${label}: not a JSON-RPC frame: ${reply.text.slice(0, 300)}`);
			assert.strictEqual(reply.json?.id, 1, `${label}: error frame id`);
			assert.match(String(reply.json?.error?.message ?? ''), /rate limit/i, `${label}: ${reply.text.slice(0, 300)}`);
		}
		async function burstThenDeny(send: () => Promise<Reply>, label: string, denials = 2): Promise<string[]> {
			const before = await sessionCount();
			const ids: string[] = [];
			for (let i = 1; i <= BURST; i++) ids.push(expectAdmitted(await send(), `${label} admit ${i}`));
			for (let i = 1; i <= denials; i++) expectDenied(await send(), `${label} deny ${i}`);
			const after = await sessionCount();
			assert.strictEqual(after, before + BURST, `${label}: rows ${before} -> ${after} for ${BURST} admits`);
			return ids;
		}

		before(async () => {
			await setupHarperWithFixture(ctx, FIXTURE_PATH, OPTIONS);
			admin = `Basic ${Buffer.from(`${ctx.harper.admin.username}:${ctx.harper.admin.password}`).toString('base64')}`;
			appUrl = new URL('/mcp', ctx.harper.httpURL);
			opsUrl = new URL('/mcp', ctx.harper.operationsAPIURL);
			const deadline = Date.now() + 60_000;
			for (;;) {
				const probe = await fetch(`${ctx.harper.httpURL}/McpInitializeSessions/`, {
					headers: { Authorization: admin },
					signal: AbortSignal.timeout(5_000),
				}).catch(() => undefined);
				if (probe?.status === 200 && (await probe.json().catch(() => undefined))?.loaded === true) break;
				await probe?.body?.cancel().catch(() => undefined);
				assert.ok(Date.now() < deadline, 'fixture route never became ready');
				await delay(200);
			}
		});
		after(async () => {
			await teardownHarper(ctx);
		});

		test('O operations profile: identity is the socket address; X-Forwarded-For does not mint one', async () => {
			const ids = await burstThenDeny(() => ops(SRC_O1), 'O first address');
			// a forwarded-for header on the direct TCP path: Fastify request.ip is the socket (no trustProxy)
			expectDenied(await ops(SRC_O1, { [IDENTITY_HEADER]: '203.0.113.9' }), 'O X-Forwarded-For');
			expectDenied(await ops(SRC_O1, { [IDENTITY_HEADER]: '203.0.113.10, 10.0.0.1' }), 'O X-Forwarded-For list');
			const before = await sessionCount();
			const other = expectAdmitted(await ops(SRC_O2), 'O second address');
			expectDenied(await ops(SRC_O1), 'O first address still denied');
			assert.strictEqual(await sessionCount(), before + 1, 'O second address: one row');
			console.log(`INITIALIZE-ARM O ${JSON.stringify({ admitted: ids.length, other })}`);
		});

		test('H1 identityHeader set: distinct header values from one source address mint one identity each', async () => {
			const before = await sessionCount();
			const n = BURST + 3;
			const ids: string[] = [];
			for (let i = 1; i <= n; i++)
				ids.push(expectAdmitted(await app(SRC_H1, { [IDENTITY_HEADER]: `203.0.113.${i}` }), `H1 value ${i}`));
			assert.strictEqual(new Set(ids).size, n, 'H1: session ids repeat');
			assert.strictEqual(await sessionCount(), before + n, `H1: rows for ${n} minted identities`);
			console.log(`INITIALIZE-ARM H1 ${JSON.stringify({ attempts: n, admitted: ids.length })}`);
		});

		test('H2 identityHeader set: one header value is one bucket (BURST admits, then 429)', async () => {
			const ids = await burstThenDeny(() => app(SRC_H2, { [IDENTITY_HEADER]: '203.0.113.250' }), 'H2');
			console.log(`INITIALIZE-ARM H2 ${JSON.stringify({ admitted: ids.length })}`);
		});

		test('H3 identityHeader set: the first (client-most) value of a comma list is the identity', async () => {
			await burstThenDeny(() => app(SRC_H3, { [IDENTITY_HEADER]: '203.0.113.251, 10.0.0.1' }), 'H3 list');
			expectDenied(
				await app(SRC_H3, { [IDENTITY_HEADER]: '203.0.113.251, 10.0.0.2' }),
				'H3 spent first value, other hop'
			);
			expectDenied(await app(SRC_H3, { [IDENTITY_HEADER]: '203.0.113.251' }), 'H3 spent first value, bare');
			const before = await sessionCount();
			expectAdmitted(await app(SRC_H3, { [IDENTITY_HEADER]: '203.0.113.252, 10.0.0.1' }), 'H3 fresh first value');
			assert.strictEqual(await sessionCount(), before + 1, 'H3 fresh first value: one row');
			console.log(`INITIALIZE-ARM H3 ${JSON.stringify({ firstValueWins: true })}`);
		});

		test('H4 identityHeader set but absent on the request: the socket address is the identity', async () => {
			const ids = await burstThenDeny(() => app(SRC_H4), 'H4 bare source');
			expectDenied(await app(SRC_H4, { [IDENTITY_HEADER]: '' }), 'H4 empty header value');
			console.log(`INITIALIZE-ARM H4 ${JSON.stringify({ admitted: ids.length })}`);
		});

		test('H5 Harper warned (on the first MCP request of the worker, not at startup) that identityHeader derives identity from a request header', async () => {
			const response = await fetch(ctx.harper.operationsAPIURL, {
				method: 'POST',
				headers: { 'Authorization': admin, 'Content-Type': 'application/json' },
				body: JSON.stringify({ operation: 'read_log', level: 'warn', limit: 5000, order: 'asc' }),
				signal: AbortSignal.timeout(45_000),
			});
			const text = await response.text();
			assert.strictEqual(response.status, 200, `read_log: ${response.status} ${text.slice(0, 300)}`);
			const entries = JSON.parse(text) as Array<{ message?: unknown; level?: string }>;
			const warning = entries.filter((entry) =>
				String(entry.message).includes(`rateLimit.identityHeader='${IDENTITY_HEADER}'`)
			);
			assert.ok(
				warning.length >= 1,
				`no identityHeader startup warning among ${entries.length} warn entries: ${entries
					.slice(0, 5)
					.map((entry) => String(entry.message).slice(0, 120))
					.join(' | ')}`
			);
			assert.match(String(warning[0].message), /application/, 'warning names the profile');
			assert.match(String(warning[0].message), /spoof|bypass/i, 'warning states the risk');
			console.log(
				`INITIALIZE-ARM H5 ${JSON.stringify({ warnings: warning.length, sample: String(warning[0].message).slice(0, 160) })}`
			);
		});
	}
);
