/**
 * #1736: `server.registerOperation()` from a component's resources.js must be reachable
 * through the ops API.
 *
 * Components load per worker thread, so their registrations land in worker-local
 * OPERATION_FUNCTION_MAP instances; the ops-API dispatcher runs on the main thread with its
 * own instance. The cross-thread bridge (server/serverHelpers/registeredOperations.ts)
 * forwards an unrecognized operation to one registering worker and relays the result.
 *
 * The same split governs the role `operations` allowlist: registerOperationPermission marks a
 * declared op grantable on the worker, but validateOperations is consulted on the main thread.
 * Only an integration test crosses that boundary — unit tests register and validate on one
 * thread, so the topology, and therefore the gap, is invisible to them.
 */
import { suite, test, before, after } from 'node:test';
import { strictEqual, ok } from 'node:assert';
import { resolve } from 'node:path';

import { setupHarperWithFixture, teardownHarper, type ContextWithHarper } from '@harperfast/integration-testing';

const FIXTURE_PATH = resolve(import.meta.dirname, 'fixtures/registered-operation');

const GRANTABLE_OP = 'component_registered_grantable';
const GRANTED_ROLE = 'component_op_granted_role';
const GRANTED_USER = 'component_op_granted_user';
const UNGRANTED_ROLE = 'component_op_ungranted_role';
const UNGRANTED_USER = 'component_op_ungranted_user';
const USER_PASS = 'Abc1234!';

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

	async function asUser(username: string, body: any): Promise<{ status: number; body: any }> {
		const response = await fetch(ctx.harper.operationsAPIURL, {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				'Authorization': `Basic ${Buffer.from(`${username}:${USER_PASS}`).toString('base64')}`,
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

	suite('grantable in a role `operations` allowlist across the worker/main boundary', () => {
		before(async () => {
			// The announcement is fire-and-forget ITC. A successful forward proves the handler ran, and
			// it carries the grantable flag in the same message — so this gates on the exact state
			// these tests depend on, rather than on elapsed time.
			const deadline = Date.now() + 15_000;
			for (;;) {
				const { status } = await op({ operation: GRANTABLE_OP });
				if (status === 200) break;
				if (Date.now() > deadline) throw new Error(`main thread never registered '${GRANTABLE_OP}'`);
				await new Promise((resolve) => setTimeout(resolve, 100));
			}
		});

		test('add_role accepts the worker-registered op name in `operations`', async () => {
			const { status, body } = await op({
				operation: 'add_role',
				role: GRANTED_ROLE,
				permission: { operations: [GRANTABLE_OP] },
			});
			strictEqual(status, 200, JSON.stringify(body));
		});

		test('add_role still rejects an op name no component registered', async () => {
			// Guards the test above: a validateOperations that stopped running would look like a pass.
			const { status, body } = await op({
				operation: 'add_role',
				role: 'component_op_bogus_role',
				permission: { operations: ['component_registered_never_declared'] },
			});
			strictEqual(status, 400, JSON.stringify(body));
			ok(
				JSON.stringify(body).includes('component_registered_never_declared'),
				`expected the offending op name in the error, got: ${JSON.stringify(body)}`
			);
		});

		test('alter_role accepts it too', async () => {
			const { status, body } = await op({
				operation: 'alter_role',
				id: GRANTED_ROLE,
				permission: { operations: [GRANTABLE_OP, 'user_info'] },
			});
			strictEqual(status, 200, JSON.stringify(body));
		});

		test('a non-super_user granted the op can actually call it', async () => {
			const added = await op({
				operation: 'add_user',
				role: GRANTED_ROLE,
				username: GRANTED_USER,
				password: USER_PASS,
				active: true,
			});
			strictEqual(added.status, 200, JSON.stringify(added.body));

			const { status, body } = await asUser(GRANTED_USER, { operation: GRANTABLE_OP });
			strictEqual(status, 200, JSON.stringify(body));
			strictEqual(body.granted, true);
			strictEqual(body.username, GRANTED_USER);
			strictEqual(body.executedOnMainThread, false);
		});

		test('a non-super_user without the grant is still denied (enforcement unchanged)', async () => {
			const role = await op({
				operation: 'add_role',
				role: UNGRANTED_ROLE,
				permission: { operations: ['user_info'] },
			});
			strictEqual(role.status, 200, JSON.stringify(role.body));
			const added = await op({
				operation: 'add_user',
				role: UNGRANTED_ROLE,
				username: UNGRANTED_USER,
				password: USER_PASS,
				active: true,
			});
			strictEqual(added.status, 200, JSON.stringify(added.body));

			const { status, body } = await asUser(UNGRANTED_USER, { operation: GRANTABLE_OP });
			strictEqual(status, 403, JSON.stringify(body));
		});

		test('impersonation accepts an inline role naming the op', async () => {
			const { status, body } = await op({
				operation: GRANTABLE_OP,
				impersonate: { role: { permission: { operations: [GRANTABLE_OP] } } },
			});
			strictEqual(status, 200, JSON.stringify(body));
			strictEqual(body.granted, true);
		});
	});
});
