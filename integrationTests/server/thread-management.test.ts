/**
 * Thread management integration tests.
 *
 * Tests worker thread functionality including:
 * - Concurrent request handling across threads
 * - Server resilience after errors
 */
import { suite, test, before, after } from 'node:test';
import { strictEqual } from 'node:assert/strict';

import { startHarper, teardownHarper, type ContextWithHarper } from '@harperfast/integration-testing';

const REQUEST_TIMEOUT_MS = 5000;

function authHeader(ctx: ContextWithHarper) {
	return `Basic ${Buffer.from(`${ctx.harper.admin.username}:${ctx.harper.admin.password}`).toString('base64')}`;
}

function opsRequest(ctx: ContextWithHarper, body: string) {
	return fetch(ctx.harper.operationsAPIURL, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json', 'Authorization': authHeader(ctx) },
		body,
		signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
	});
}

suite('Thread Management', (ctx: ContextWithHarper) => {
	before(async () => {
		await startHarper(ctx, { config: {}, env: {} });
	});

	after(async () => {
		await teardownHarper(ctx);
	});

	test('server handles concurrent requests across threads', { timeout: 15000 }, async () => {
		const requests = [];
		for (let i = 0; i < 20; i++) {
			requests.push(opsRequest(ctx, JSON.stringify({ operation: 'describe_all' })));
		}

		const responses = await Promise.all(requests);

		for (const response of responses) {
			strictEqual(response.status, 200, 'All concurrent requests should succeed');
		}
	});

	test(
		'server recovers from malformed requests without affecting subsequent requests',
		{ timeout: 15000 },
		async () => {
			const badResponses = await Promise.all(Array.from({ length: 5 }, () => opsRequest(ctx, 'not json')));
			for (const response of badResponses) {
				strictEqual(response.status, 400);
			}

			const goodResponses = await Promise.all(
				Array.from({ length: 5 }, () => opsRequest(ctx, JSON.stringify({ operation: 'describe_all' })))
			);
			for (const response of goodResponses) {
				strictEqual(response.status, 200, 'Server should recover and handle valid requests');
			}
		}
	);

	test('server handles mixed concurrent valid and invalid requests', { timeout: 15000 }, async () => {
		const requests = Array.from({ length: 20 }, (_, i) =>
			i % 3 === 0
				? opsRequest(ctx, 'invalid json').then((r) => ({ status: r.status, expected: 400 }))
				: opsRequest(ctx, JSON.stringify({ operation: 'describe_all' })).then((r) => ({
						status: r.status,
						expected: 200,
					}))
		);

		const results = await Promise.all(requests);

		for (const result of results) {
			strictEqual(result.status, result.expected, `Expected ${result.expected}, got ${result.status}`);
		}
	});
});
