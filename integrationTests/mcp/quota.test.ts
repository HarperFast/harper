/**
 * #1610 — per-client-identity rate limiting + the durable quota hook.
 *
 * The instance configures identityHeader: x-test-client (so the test controls
 * identity per call), a per-client bucket of burst 6 with negligible refill,
 * and quota.resource: McpQuota (persisted per-identity counter, limit 3).
 * Every tools/call opens a FRESH session — the session-cycling abuse loop the
 * issue describes — so anything that throttles here is client-scoped, not
 * session-scoped. Expected ladder for one identity:
 *   calls 1–3: ok · calls 4–6: quota_exceeded (durable) · call 7+: per_client
 *
 * Reproduction:
 *   npm run test:integration -- "integrationTests/mcp/quota.test.ts"
 */
import { suite, test, before, after } from 'node:test';
import { ok, strictEqual } from 'node:assert';
import { resolve } from 'node:path';
import { setupHarperWithFixture, teardownHarper, type ContextWithHarper } from '@harperfast/integration-testing';

const FIXTURE_PATH = resolve(import.meta.dirname, '../fixtures/mcp-quota');

function basicAuth(username: string, password: string): string {
	return `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}`;
}

suite('MCP per-client rate limit + durable quota (#1610)', (ctx: ContextWithHarper) => {
	let auth: string;
	let rpcId = 0;

	/** initialize a FRESH session and issue one tools/call under `identity`. */
	async function callAnswerFreshSession(identity: string): Promise<any> {
		const baseHeaders = {
			'content-type': 'application/json',
			'accept': 'application/json, text/event-stream',
			'authorization': auth,
			'x-test-client': identity,
		};
		const initRes = await fetch(new URL('/mcp', ctx.harper.httpURL), {
			method: 'POST',
			headers: baseHeaders,
			body: JSON.stringify({
				jsonrpc: '2.0',
				id: ++rpcId,
				method: 'initialize',
				params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'quota-it', version: '0' } },
			}),
		});
		strictEqual(initRes.status, 200, `initialize should 200: ${await initRes.clone().text()}`);
		const sessionId = initRes.headers.get('mcp-session-id');
		ok(sessionId, 'session established');
		const callRes = await fetch(new URL('/mcp', ctx.harper.httpURL), {
			method: 'POST',
			headers: {
				...baseHeaders,
				'mcp-session-id': sessionId as string,
				'mcp-protocol-version': '2025-06-18',
			},
			body: JSON.stringify({
				jsonrpc: '2.0',
				id: ++rpcId,
				method: 'tools/call',
				params: { name: 'answer', arguments: { q: 'hello' } },
			}),
		});
		const text = await callRes.text();
		strictEqual(callRes.status, 200, `tools/call should 200: ${text}`);
		return JSON.parse(text);
	}

	/** Parse the JSON payload custom tools/denials embed in content[0].text. */
	function payloadOf(body: any): any {
		const text = body?.result?.content?.[0]?.text;
		try {
			return JSON.parse(text);
		} catch {
			return { raw: text };
		}
	}

	before(async () => {
		await setupHarperWithFixture(ctx, FIXTURE_PATH, {
			config: {
				mcp: {
					application: {
						mountPath: '/mcp',
						rateLimit: {
							// identity comes from this test-controlled header; negligible
							// refill makes the 6-token burst deterministic.
							identityHeader: 'x-test-client',
							perClientPerSecond: 0.001,
							perClientBurst: 6,
						},
						quota: { resource: 'McpQuota' },
					},
				},
			},
		});
		auth = basicAuth(ctx.harper.admin.username, ctx.harper.admin.password);
	});

	after(async () => {
		await teardownHarper(ctx);
	});

	test('session cycling cannot evade client-scoped limits: ok → quota_exceeded → per_client', async () => {
		const outcomes: string[] = [];
		for (let i = 0; i < 8; i++) {
			const body = await callAnswerFreshSession('client-a');
			const payload = payloadOf(body);
			if (body.result?.isError) {
				outcomes.push(payload.kind);
			} else {
				outcomes.push('ok');
				ok(JSON.stringify(payload).includes('hello'), 'tool actually ran');
			}
		}
		// 1–3 pass the durable quota; 4–6 burn remaining bucket tokens but the
		// counter is past the limit; 7–8 don't even reach the hook.
		strictEqual(outcomes.slice(0, 3).join(','), 'ok,ok,ok');
		strictEqual(outcomes.slice(3, 6).join(','), 'quota_exceeded,quota_exceeded,quota_exceeded');
		strictEqual(outcomes.slice(6).join(','), 'rate_limited,rate_limited');
	});

	test('quota denial carries the author message and retryAfterSeconds', async () => {
		// client-a's counter is exhausted but its bucket is too; use a sibling
		// identity and drain just the quota (limit 3) within the 6-token bucket.
		for (let i = 0; i < 3; i++) await callAnswerFreshSession('client-b');
		const body = await callAnswerFreshSession('client-b');
		const payload = payloadOf(body);
		strictEqual(body.result.isError, true);
		strictEqual(payload.kind, 'quota_exceeded');
		strictEqual(payload.message, 'daily quota reached');
		strictEqual(payload.retryAfterSeconds, 3600);
	});

	test('a different client identity is unaffected and the counter persists per identity', async () => {
		const body = await callAnswerFreshSession('client-c');
		strictEqual(body.result?.isError ?? false, false, `fresh identity admitted: ${JSON.stringify(body)}`);
		// The durable counter is a real table row, visible over REST.
		const res = await fetch(new URL('/QuotaCounter/client-c', ctx.harper.httpURL), {
			headers: { authorization: auth },
		});
		strictEqual(res.status, 200);
		const record = await res.json();
		strictEqual(record.used, 1);
	});
});
