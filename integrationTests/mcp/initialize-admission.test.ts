/**
 * MCP `initialize` admission limit (PR #3537): one token bucket per profile and client identity; a denied
 * `initialize` answers 429 + `Retry-After` and creates no `system.mcp_session` row; the stored row keeps
 * only the names of the capabilities Harper gates on. Pinned on a real listener with real source addresses
 * and the persisted row (the unit tests under `unitTests/components/mcp/` drive the bucket in isolation).
 * Docs: `docs/reference/mcp/configuration.md` "initializePerSecond".
 *
 * One boot, `threads.count: 1` (buckets are per worker; the multi-worker leg is
 * `initialize-admission-workers.test.ts`). Each arm uses its own loopback source address (Linux routes all
 * of 127/8 to lo), so no arm inherits a bucket another one spent.
 */
import { suite, test, before, after } from 'node:test';
import assert from 'node:assert';
import { resolve } from 'node:path';
import { request as httpRequest } from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';
import { setupHarperWithFixture, teardownHarper, type ContextWithHarper } from '@harperfast/integration-testing';

const FIXTURE_PATH = resolve(import.meta.dirname, '../fixtures/mcp-initialize-limit');
const RATE = 0.1;
const BURST = 5;
const RETRY_AFTER = String(Math.ceil(1 / RATE));
const BODY_LIMIT = 4_000_000;
const OPTIONS = {
	config: {
		threads: { count: 1 },
		mcp: { application: { mountPath: '/mcp', rateLimit: { initializePerSecond: RATE, initializeBurst: BURST } } },
		http: { maxRequestBodySize: BODY_LIMIT },
		authentication: { authorizeLocal: false },
	},
	env: { AUTHENTICATION_AUTHORIZELOCAL: 'false' },
};
const SRC_A = '127.0.0.201';
const SRC_B = '127.0.0.202';
const SRC_C = '127.0.0.203';
const SRC_D = '127.0.0.205';
// capability names Harper gates on (components/mcp/serverRequests.ts GATED_CLIENT_CAPABILITIES)
const GATED = new Set(['roots', 'sampling', 'elicitation']);

type Reply = { status: number; headers: Record<string, string | string[] | undefined>; text: string; json: any };

function standardParams() {
	return {
		protocolVersion: '2025-06-18',
		capabilities: { roots: { listChanged: true } },
		clientInfo: { name: 'initialize-admission', version: '0' },
	};
}

suite(
	'MCP initialize admission limit and persisted session bytes',
	{
		skip:
			process.platform !== 'linux' &&
			'client source addresses 127.0.0.2xx bind on Linux only (outside the macOS lo0 alias pool; Windows serves http from one thread)',
	},
	(ctx: ContextWithHarper) => {
		let admin: string;
		let mcpUrl: URL;

		function initialize(
			localAddress: string,
			params: unknown,
			extraHeaders: Record<string, string> = {}
		): Promise<Reply> {
			const payload = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params });
			return new Promise((resolveReply, reject) => {
				const req = httpRequest(
					{
						host: mcpUrl.hostname,
						port: Number(mcpUrl.port),
						path: mcpUrl.pathname,
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

		async function sessionRows(): Promise<any[]> {
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
			return body.rows;
		}
		async function sessionRow(id: string): Promise<any> {
			const rows = (await sessionRows()).filter((row) => row.id === id);
			assert.strictEqual(rows.length, 1, `session ${id}: ${rows.length} rows`);
			return rows[0];
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

		const ids: Record<string, string[]> = { A: [], B: [], C: [] };

		test('A one source address: BURST admits, then 429 + Retry-After, and a denial creates no row', async () => {
			const before = (await sessionRows()).length;
			for (let i = 1; i <= BURST; i++)
				ids.A.push(expectAdmitted(await initialize(SRC_A, standardParams()), `A admit ${i}`));
			for (let i = 1; i <= 3; i++) expectDenied(await initialize(SRC_A, standardParams()), `A deny ${i}`);
			const rows = await sessionRows();
			assert.strictEqual(rows.length, before + BURST, `rows after ${BURST} admits and 3 denials: ${rows.length}`);
			for (const id of ids.A) await sessionRow(id);
			console.log(`INITIALIZE-ARM A ${JSON.stringify({ before, after: rows.length, admitted: ids.A.length })}`);
		});

		test('B an oversized initialize persists a bounded row: gated capability names only, no clientInfo', async () => {
			const padding: Record<string, unknown> = {};
			for (let i = 0; i < 12_000; i++) padding[`x${i}`] = { nested: 'y'.repeat(80), listChanged: true };
			const bigCapabilities = {
				...Object.fromEntries([...GATED].map((name) => [name, {}])),
				roots: { listChanged: true },
				...padding,
			};
			const params = {
				protocolVersion: '2025-06-18',
				capabilities: bigCapabilities,
				clientInfo: { name: 'n'.repeat(300_000), version: '0' },
			};
			const bodyBytes = Buffer.byteLength(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params }));
			assert.ok(bodyBytes > 1_000_000 && bodyBytes < BODY_LIMIT, `body ${bodyBytes} bytes`);
			const id = expectAdmitted(await initialize(SRC_B, params), 'B big');
			ids.B.push(id);
			const row = await sessionRow(id);
			const rowBytes = JSON.stringify(row).length;
			const stored = row.clientCapabilities ?? {};
			const storedKeys = Object.keys(stored).sort();
			console.log(
				`INITIALIZE-ARM B ${JSON.stringify({ bodyBytes, rowBytes, storedKeys: storedKeys.slice(0, 5), keyCount: storedKeys.length, hasClientInfo: 'clientInfo' in row })}`
			);
			assert.ok(rowBytes < 4096, `stored session row is ${rowBytes} bytes for a ${bodyBytes}-byte initialize`);
			assert.deepStrictEqual(
				storedKeys,
				[...GATED].sort(),
				`stored capability keys: ${storedKeys.slice(0, 5)}… (${storedKeys.length})`
			);
			assert.deepStrictEqual(
				stored.roots,
				{},
				`gated capability stored as presence only: ${JSON.stringify(stored.roots)}`
			);
			assert.ok(!('clientInfo' in row), `clientInfo persisted: ${Object.keys(row)}`);
			assert.strictEqual(JSON.stringify(row).includes('nnnnnnnnnn'), false, 'clientInfo.name bytes reached the row');

			const weird = expectAdmitted(
				await initialize(SRC_B, { ...standardParams(), protocolVersion: 'v'.repeat(100_000) }),
				'B protocolVersion'
			);
			const weirdRow = await sessionRow(weird);
			assert.ok(
				weirdRow.protocolVersion.length < 32,
				`protocolVersion persisted raw: ${weirdRow.protocolVersion.length} chars`
			);
		});

		test('C identity is the source address: a second address has its own bucket, X-Forwarded-For mints none', async () => {
			for (let i = 1; i <= BURST; i++)
				ids.C.push(expectAdmitted(await initialize(SRC_C, standardParams()), `C admit ${i}`));
			expectDenied(await initialize(SRC_C, standardParams()), 'C deny');
			// a forwarded-for header from the direct TCP path must not become the identity (Request.ip is the socket)
			expectDenied(
				await initialize(SRC_C, standardParams(), { 'x-forwarded-for': '203.0.113.9' }),
				'C X-Forwarded-For'
			);
			console.log(`INITIALIZE-ARM C ${JSON.stringify({ admittedC: ids.C.length })}`);
		});

		test('D the bucket refills at RATE: one admit after 1/RATE seconds, then denied again', async () => {
			// own address, drained here, so the refill window does not depend on how long A-C took
			for (let i = 1; i <= BURST; i++) expectAdmitted(await initialize(SRC_D, standardParams()), `D drain ${i}`);
			expectDenied(await initialize(SRC_D, standardParams()), 'D deny after drain');
			const waitMs = (1 / RATE) * 1000 + 1_500;
			await delay(waitMs);
			const admitted = expectAdmitted(await initialize(SRC_D, standardParams()), 'D refill admit');
			await sessionRow(admitted);
			expectDenied(await initialize(SRC_D, standardParams()), 'D deny after refill');
			console.log(`INITIALIZE-ARM D ${JSON.stringify({ waitedMs: waitMs })}`);
		});
	}
);
