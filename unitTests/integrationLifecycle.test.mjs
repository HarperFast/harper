import assert from 'node:assert';
import { waitForRouteReady } from '../integrationTests/apiTests/utils/lifecycle.mjs';

function createProbeClient(outcomes) {
	let attempts = 0;
	return {
		restURL: 'http://127.0.0.1:9926',
		get attempts() {
			return attempts;
		},
		reqRest() {
			return {
				timeout() {
					const outcome = outcomes[attempts++];
					return outcome instanceof Error ? Promise.reject(outcome) : Promise.resolve({ status: outcome });
				},
			};
		},
	};
}

describe('waitForRouteReady', () => {
	it('preserves the default non-404 readiness policy', async () => {
		const client = createProbeClient([404, 500]);

		await waitForRouteReady(client, '/Widget/', 1_000);

		assert.strictEqual(client.attempts, 2);
	});

	it('allows a caller to require a successful response', async () => {
		const client = createProbeClient([500, 204]);

		await waitForRouteReady(client, '/Widget/', 1_000, {
			isReady: (response) => response.status >= 200 && response.status < 300,
		});

		assert.strictEqual(client.attempts, 2);
	});

	it('propagates predicate errors immediately', async () => {
		const client = createProbeClient([200]);
		const predicateError = new Error('invalid readiness response');

		await assert.rejects(
			waitForRouteReady(client, '/Widget/', 1_000, {
				isReady: () => {
					throw predicateError;
				},
			}),
			(error) => error === predicateError
		);
		assert.strictEqual(client.attempts, 1);
	});

	it('rejects asynchronous predicates', async () => {
		const client = createProbeClient([200]);

		await assert.rejects(
			waitForRouteReady(client, '/Widget/', 1_000, {
				isReady: async () => {
					throw new Error('async predicate failure');
				},
			}),
			/waitForRouteReady isReady must return a boolean synchronously/
		);
		assert.strictEqual(client.attempts, 1);
	});

	it('reports the full URL and last HTTP status on timeout', async () => {
		const client = createProbeClient([500, 500]);

		await assert.rejects(
			waitForRouteReady(client, '/Widget/', 300, { isReady: () => false }),
			(error) =>
				error.message.includes('http://127.0.0.1:9926/Widget/') &&
				error.message.includes('last status=500') &&
				error.message.includes('last error=none')
		);
		assert.ok(client.attempts >= 1);
	});

	it('reports the last transport failure on timeout', async () => {
		const client = createProbeClient([new Error('connection refused'), new Error('connection refused')]);

		await assert.rejects(
			waitForRouteReady(client, '/Widget/', 300),
			(error) => error.message.includes('last status=none') && error.message.includes('last error=connection refused')
		);
		assert.ok(client.attempts >= 1);
	});
});
