/**
 * #1736: `server.registerOperation()` from a component's resources.js must be reachable
 * through the ops API.
 *
 * Components load per worker thread, so their registrations land in worker-local
 * OPERATION_FUNCTION_MAP instances; the ops-API dispatcher runs on the main thread with its
 * own instance. The cross-thread bridge (server/serverHelpers/registeredOperations.ts)
 * forwards an unrecognized operation to one registering worker and relays the result.
 */
import { suite, test, before, after } from 'node:test';
import { strictEqual, ok } from 'node:assert';
import { resolve } from 'node:path';

import { setupHarperWithFixture, teardownHarper, type ContextWithHarper } from '@harperfast/integration-testing';

const FIXTURE_PATH = resolve(import.meta.dirname, 'fixtures/registered-operation');

suite('Component: registered-operation (#1736)', (ctx: ContextWithHarper) => {
	async function op(body: any): Promise<{ status: number; body: any }> {
		const { username, password } = ctx.harper.admin;
		const response = await fetch(ctx.harper.operationsAPIURL, {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				'Authorization': `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}`,
			},
			body: JSON.stringify(body),
		});
		return { status: response.status, body: await response.json() };
	}

	before(async () => {
		// Multiple HTTP workers so the forward actually has a choice of registering threads.
		await setupHarperWithFixture(ctx, FIXTURE_PATH, {
			config: {
				threads: { count: 2 },
				logging: { console: true, level: 'error' },
			},
		});
	});

	after(async () => {
		await teardownHarper(ctx);
	});

	test('operation registered in resources.js is reachable via the ops API', async () => {
		const { status, body } = await op({ operation: 'component_registered_echo', value: 'hello-1736' });
		strictEqual(status, 200, JSON.stringify(body));
		strictEqual(body.echoed, 'hello-1736');
		// Executed on a worker thread (where the component registered it), not the main thread.
		strictEqual(body.executedOnMainThread, false);
		ok(body.executedOnThreadId > 0, `expected a worker threadId, got ${body.executedOnThreadId}`);
		// The authenticated user was forwarded across the thread boundary (#1591 attribution input).
		strictEqual(body.username, ctx.harper.admin.username);
	});

	test('repeated calls keep working (round-robin across registering workers)', async () => {
		const threadIds = new Set<number>();
		for (let i = 0; i < 6; i++) {
			const { status, body } = await op({ operation: 'component_registered_echo', value: `call-${i}` });
			strictEqual(status, 200, JSON.stringify(body));
			strictEqual(body.echoed, `call-${i}`);
			threadIds.add(body.executedOnThreadId);
		}
		ok(threadIds.size >= 1, 'expected at least one executing worker thread');
	});

	test('operation errors propagate with their status code', async () => {
		const { status, body } = await op({ operation: 'component_registered_error' });
		strictEqual(status, 422, JSON.stringify(body));
		ok(
			JSON.stringify(body).includes('deliberate failure from component operation'),
			`expected the operation's error message, got: ${JSON.stringify(body)}`
		);
	});

	test('streaming results are rejected with an explicit error', async () => {
		const { status, body } = await op({ operation: 'component_registered_stream' });
		strictEqual(status, 501, JSON.stringify(body));
		ok(
			JSON.stringify(body).includes('not supported'),
			`expected the explicit streaming-unsupported error, got: ${JSON.stringify(body)}`
		);
	});

	test('unknown operations still fail fast with 400', async () => {
		const { status, body } = await op({ operation: 'definitely_not_registered_anywhere' });
		strictEqual(status, 400, JSON.stringify(body));
		ok(JSON.stringify(body).includes('not found'), `expected operation-not-found error, got: ${JSON.stringify(body)}`);
	});
});
