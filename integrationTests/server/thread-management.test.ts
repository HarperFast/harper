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

suite('Thread Management', (ctx: ContextWithHarper) => {
	before(async () => {
		await startHarper(ctx, { config: {}, env: {} });
	});

	after(async () => {
		await teardownHarper(ctx);
	});

	test('server handles concurrent requests across threads', async () => {
		// Send multiple concurrent requests to verify thread handling
		const requests = [];
		for (let i = 0; i < 20; i++) {
			requests.push(
				fetch(ctx.harper.operationsAPIURL, {
					method: 'POST',
					headers: {
						'Content-Type': 'application/json',
						'Authorization': `Basic ${Buffer.from(`${ctx.harper.admin.username}:${ctx.harper.admin.password}`).toString('base64')}`,
					},
					body: JSON.stringify({ operation: 'describe_all' }),
				})
			);
		}

		const responses = await Promise.all(requests);

		for (const response of responses) {
			strictEqual(response.status, 200, 'All concurrent requests should succeed');
		}
	});

	test('server recovers from malformed requests without affecting subsequent requests', async () => {
		// Send multiple malformed requests
		const badRequests = [];
		for (let i = 0; i < 5; i++) {
			badRequests.push(
				fetch(ctx.harper.operationsAPIURL, {
					method: 'POST',
					headers: {
						'Content-Type': 'application/json',
						'Authorization': `Basic ${Buffer.from(`${ctx.harper.admin.username}:${ctx.harper.admin.password}`).toString('base64')}`,
					},
					body: 'not json',
				})
			);
		}

		const badResponses = await Promise.all(badRequests);
		for (const response of badResponses) {
			strictEqual(response.status, 400);
		}

		// Server should still handle good requests after bad ones
		const goodRequests = [];
		for (let i = 0; i < 5; i++) {
			goodRequests.push(
				fetch(ctx.harper.operationsAPIURL, {
					method: 'POST',
					headers: {
						'Content-Type': 'application/json',
						'Authorization': `Basic ${Buffer.from(`${ctx.harper.admin.username}:${ctx.harper.admin.password}`).toString('base64')}`,
					},
					body: JSON.stringify({ operation: 'describe_all' }),
				})
			);
		}

		const goodResponses = await Promise.all(goodRequests);
		for (const response of goodResponses) {
			strictEqual(response.status, 200, 'Server should recover and handle valid requests');
		}
	});

	test('server handles mixed concurrent valid and invalid requests', async () => {
		// Mix of good and bad requests simultaneously
		const requests = [];
		for (let i = 0; i < 20; i++) {
			if (i % 3 === 0) {
				// Bad request
				requests.push(
					fetch(ctx.harper.operationsAPIURL, {
						method: 'POST',
						headers: {
							'Content-Type': 'application/json',
							'Authorization': `Basic ${Buffer.from(`${ctx.harper.admin.username}:${ctx.harper.admin.password}`).toString('base64')}`,
						},
						body: 'invalid json',
					}).then((r) => ({ status: r.status, expected: 400 }))
				);
			} else {
				// Good request
				requests.push(
					fetch(ctx.harper.operationsAPIURL, {
						method: 'POST',
						headers: {
							'Content-Type': 'application/json',
							'Authorization': `Basic ${Buffer.from(`${ctx.harper.admin.username}:${ctx.harper.admin.password}`).toString('base64')}`,
						},
						body: JSON.stringify({ operation: 'describe_all' }),
					}).then((r) => ({ status: r.status, expected: 200 }))
				);
			}
		}

		const results = await Promise.all(requests);

		for (const result of results) {
			strictEqual(result.status, result.expected, `Expected ${result.expected}, got ${result.status}`);
		}
	});
});
