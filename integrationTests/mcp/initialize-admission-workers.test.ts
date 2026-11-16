/** MCP initialize budgets are independent on deterministically selected HTTP workers. */
import { suite, test, before, after } from 'node:test';
import assert from 'node:assert';
import { resolve, join } from 'node:path';
import { readdir } from 'node:fs/promises';
import { createConnection } from 'node:net';
import { Agent, request as httpRequest } from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';
import { setupHarperWithFixture, teardownHarper, type ContextWithHarper } from '@harperfast/integration-testing';

const FIXTURE_PATH = resolve(import.meta.dirname, '../fixtures/mcp-initialize-limit');
const WORKERS = 4;
const RATE = 0.01;
const BURST = 5;
const OPTIONS = {
	config: {
		threads: { count: WORKERS },
		tls: { unixDomainSockets: true },
		mcp: { application: { mountPath: '/mcp', rateLimit: { initializePerSecond: RATE, initializeBurst: BURST } } },
		authentication: { authorizeLocal: false },
	},
	env: { AUTHENTICATION_AUTHORIZELOCAL: 'false' },
};

suite(
	'MCP initialize admission limit is per http worker',
	{ skip: process.platform === 'win32' && 'Windows serves HTTP from one thread' },
	(ctx: ContextWithHarper) => {
		let admin: string;
		let mcpUrl: URL;

		function initialize(
			agent: Agent
		): Promise<{ status: number; sessionId: string | undefined; retryAfter: string | undefined }> {
			const payload = JSON.stringify({
				jsonrpc: '2.0',
				id: 1,
				method: 'initialize',
				params: {
					protocolVersion: '2025-06-18',
					capabilities: {},
					clientInfo: { name: 'initialize-admission-workers', version: '0' },
				},
			});
			return new Promise((resolveReply, reject) => {
				const req = httpRequest(
					{
						host: mcpUrl.hostname,
						port: Number(mcpUrl.port),
						path: mcpUrl.pathname,
						method: 'POST',
						agent,
						headers: {
							'content-type': 'application/json',
							'accept': 'application/json, text/event-stream',
							'content-length': Buffer.byteLength(payload),
						},
						timeout: 60_000,
					},
					(res) => {
						res.resume();
						res.on('error', reject);
						res.on('close', () => {
							if (!res.complete) reject(new Error(`initialize: connection closed before the response completed`));
						});
						res.on('end', () =>
							resolveReply({
								status: res.statusCode ?? 0,
								sessionId: res.headers['mcp-session-id'] as string | undefined,
								retryAfter: res.headers['retry-after'] as string | undefined,
							})
						);
					}
				);
				req.on('error', reject);
				req.on('timeout', () => req.destroy(new Error('initialize timed out')));
				req.end(payload);
			});
		}
		async function sessionRows(): Promise<any[]> {
			const response = await fetch(`${ctx.harper.httpURL}/McpInitializeSessions/`, {
				headers: { Authorization: admin, Accept: 'application/json' },
				signal: AbortSignal.timeout(45_000),
			});
			const text = await response.text();
			assert.strictEqual(response.status, 200, `sessions oracle: ${response.status} ${text.slice(0, 300)}`);
			const body = JSON.parse(text);
			assert.strictEqual(
				body.loaded,
				true,
				`sessions oracle: system.mcp_session not loaded in the worker: ${text.slice(0, 300)}`
			);
			assert.ok(Array.isArray(body.rows), `sessions oracle body: ${text.slice(0, 300)}`);
			return body.rows;
		}

		before(async () => {
			await setupHarperWithFixture(ctx, FIXTURE_PATH, OPTIONS);
			admin = `Basic ${Buffer.from(`${ctx.harper.admin.username}:${ctx.harper.admin.password}`).toString('base64')}`;
			mcpUrl = new URL('/mcp', ctx.harper.httpURL);
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

		test('W each selected worker admits BURST then denies the same identity', async () => {
			const socketDir = join(ctx.harper.dataRootDir, 'sockets');
			const mirrors = (await readdir(socketDir)).filter((name) => /^\d+-.*9927\.sock$/.test(name)).sort();
			assert.strictEqual(mirrors.length, WORKERS);
			const workerIds = new Set<number>();
			const ids = new Set<string>();
			for (const mirror of mirrors) {
				const agent = new Agent({ keepAlive: true, maxSockets: 1 });
				agent.createConnection = () => createConnection(join(socketDir, mirror));
				try {
					const workerId = await new Promise<number>((resolveId, reject) => {
						const req = httpRequest(
							new URL('/WorkerIdentity', ctx.harper.httpURL),
							{
								agent,
								headers: { authorization: admin },
								timeout: 10_000,
							},
							(res) => {
								let body = '';
								res.on('data', (chunk) => {
									body += chunk;
								});
								res.on('error', reject);
								res.on('end', () => {
									try {
										assert.strictEqual(res.statusCode, 200, body);
										resolveId(JSON.parse(body).threadId);
									} catch (error) {
										reject(error);
									}
								});
							}
						);
						req.on('error', reject);
						req.on('timeout', () => req.destroy(new Error('worker probe timed out')));
						req.end();
					});
					assert.ok(Number.isInteger(workerId));
					assert.ok(!workerIds.has(workerId), `mirror ${mirror} repeated worker ${workerId}`);
					workerIds.add(workerId);
					for (let i = 0; i < BURST; i++) {
						const reply = await initialize(agent);
						assert.strictEqual(reply.status, 200, `worker ${workerId} admission ${i + 1}`);
						assert.ok(reply.sessionId);
						assert.ok(!ids.has(reply.sessionId));
						ids.add(reply.sessionId);
					}
					const denied = await initialize(agent);
					assert.strictEqual(denied.status, 429, `worker ${workerId} must exhaust its own bucket`);
					assert.strictEqual(denied.retryAfter, String(Math.ceil(1 / RATE)));
				} finally {
					agent.destroy();
				}
			}
			const rowIds = new Set((await sessionRows()).map((row) => row.id));
			for (const id of ids) assert.ok(rowIds.has(id), `admitted session ${id} has no row`);
			console.log(`INITIALIZE-ARM W ${JSON.stringify({ workers: [...workerIds], admitted: ids.size, burst: BURST })}`);
		});
	}
);
