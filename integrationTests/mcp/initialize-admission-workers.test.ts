/**
 * MCP `initialize` admission limit across HTTP workers (PR #3537): the bucket is per http worker
 * (`components/mcp/DESIGN.md` "The bucket is per worker thread"; `docs/reference/mcp/configuration.md`
 * "initializePerSecond"), so one source address is admitted up to `initializeBurst` on each worker before
 * it sees a 429 — the effective per-identity creation limit is the configured value times `threads.count`.
 *
 * Needs fresh connections spread across workers by SO_REUSEPORT, so the suite runs on Linux only (Windows
 * serves http from one thread, macOS binds without `reusePort`). Own instance (own thread count); shares
 * the `mcp-initialize-limit` fixture.
 */
import { suite, test, before, after } from 'node:test';
import assert from 'node:assert';
import { resolve } from 'node:path';
import { request as httpRequest } from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';
import { setupHarperWithFixture, teardownHarper, type ContextWithHarper } from '@harperfast/integration-testing';

const FIXTURE_PATH = resolve(import.meta.dirname, '../fixtures/mcp-initialize-limit');
const WORKERS = 4;
const RATE = 0.01;
const BURST = 5;
const ATTEMPTS = 40;
const OPTIONS = {
	config: {
		threads: { count: WORKERS },
		mcp: { application: { mountPath: '/mcp', rateLimit: { initializePerSecond: RATE, initializeBurst: BURST } } },
		authentication: { authorizeLocal: false },
	},
	env: { AUTHENTICATION_AUTHORIZELOCAL: 'false' },
};
const SRC = '127.0.0.204';

suite(
	'MCP initialize admission limit is per http worker',
	{
		skip:
			process.platform !== 'linux' &&
			'per-worker buckets need SO_REUSEPORT to spread fresh connections across workers (Windows serves http from one thread, macOS binds without reusePort)',
	},
	(ctx: ContextWithHarper) => {
		let admin: string;
		let mcpUrl: URL;

		function initialize(): Promise<{ status: number; sessionId: string | undefined; retryAfter: string | undefined }> {
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
						localAddress: SRC,
						agent: false, // a fresh connection per request, so the worker routing is the listener's
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
							if (!res.complete)
								reject(new Error(`initialize from ${SRC}: connection closed before the response completed`));
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

		test('W one address is admitted up to BURST per worker, never more', async () => {
			const replies = [];
			for (let i = 0; i < ATTEMPTS; i++) replies.push(await initialize());
			const admitted = replies.filter((reply) => reply.status === 200);
			const denied = replies.filter((reply) => reply.status === 429);
			assert.strictEqual(
				admitted.length + denied.length,
				ATTEMPTS,
				`other statuses: ${JSON.stringify(replies.map((r) => r.status))}`
			);
			for (const reply of denied) assert.strictEqual(reply.retryAfter, String(Math.ceil(1 / RATE)));
			const ids = new Set(admitted.map((reply) => reply.sessionId));
			assert.strictEqual(ids.size, admitted.length, 'every admit carries a distinct session id');
			// the oracle reads one worker's view; the table is shared, so every admitted id must be there
			const rows = await sessionRows();
			const rowIds = new Set(rows.map((row) => row.id));
			for (const id of ids) assert.ok(rowIds.has(id as string), `admitted session ${id} has no row`);
			console.log(
				`INITIALIZE-ARM W ${JSON.stringify({ attempts: ATTEMPTS, admitted: admitted.length, denied: denied.length, workers: WORKERS, burst: BURST })}`
			);
			assert.ok(admitted.length > BURST, `admitted ${admitted.length}: a single bucket would have admitted ${BURST}`);
			assert.ok(admitted.length <= BURST * WORKERS, `admitted ${admitted.length} > ${BURST} x ${WORKERS} workers`);
		});
	}
);
