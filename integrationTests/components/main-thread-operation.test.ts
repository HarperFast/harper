/**
 * #4134: `server.operation()` on a worker thread must reach an operation that only the main thread
 * registered. The built-in agent registers its operations from `startOnMainThread`, and components
 * load per worker, so only an integration test crosses the boundary that hid them.
 */
import { suite, test, before, after } from 'node:test';
import { strictEqual, ok } from 'node:assert';
import { resolve } from 'node:path';

import { setupHarperWithFixture, teardownHarper, type ContextWithHarper } from '@harperfast/integration-testing';

const FIXTURE_PATH = resolve(import.meta.dirname, 'fixtures/main-thread-operation');
const LIMITED_ROLE = 'main_thread_op_limited_role';
const LIMITED_USER = 'main_thread_op_limited_user';
const USER_PASS = 'Abc1234!';

suite('Component: operation registered on the main thread (#4134)', (ctx: ContextWithHarper) => {
	function authorization(): string {
		const { username, password } = ctx.harper.admin;
		return `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}`;
	}

	async function op(body: any): Promise<{ status: number; body: any }> {
		const response = await fetch(ctx.harper.operationsAPIURL, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json', 'Authorization': authorization() },
			body: JSON.stringify(body),
		});
		return { status: response.status, body: await response.json() };
	}

	async function probe(path: string): Promise<any> {
		const response = await fetch(new URL(path, ctx.harper.httpURL), { headers: { Authorization: authorization() } });
		strictEqual(response.status, 200, await response.clone().text());
		return response.json();
	}

	before(async () => {
		await setupHarperWithFixture(ctx, FIXTURE_PATH, {
			config: {
				threads: { count: 2 },
				agent: { enabled: true },
				logging: { console: true, level: 'error' },
			},
		});
		let result = await op({ operation: 'add_role', role: LIMITED_ROLE, permission: { super_user: false } });
		strictEqual(result.status, 200, JSON.stringify(result.body));
		result = await op({
			operation: 'add_user',
			role: LIMITED_ROLE,
			username: LIMITED_USER,
			password: USER_PASS,
			active: true,
		});
		strictEqual(result.status, 200, JSON.stringify(result.body));
	});

	after(async () => {
		await teardownHarper(ctx);
	});

	test('a worker reaches the main-thread operation in-process', async () => {
		const expected = await op({ operation: 'get_agent_config' });
		strictEqual(expected.status, 200, JSON.stringify(expected.body));

		const result = await probe('/Probe/');
		strictEqual(result.isMainThread, false);
		strictEqual(result.builtin.ok, true, JSON.stringify(result.builtin));
		strictEqual(result.agent.ok, true, JSON.stringify(result.agent));
		strictEqual(result.agent.result.enabled, true);
		strictEqual(JSON.stringify(result.agent.result), JSON.stringify(expected.body));
	});

	test('authorize=false carries across the thread boundary', async () => {
		const result = await probe('/Probe/');
		strictEqual(result.unauthorized.ok, true, JSON.stringify(result.unauthorized));
	});

	test('the main thread enforces the operation permission for the forwarded user', async () => {
		const result = await probe(`/ProbeAs/${LIMITED_USER}`);
		strictEqual(result.agent.ok, false, JSON.stringify(result.agent));
		strictEqual(result.agent.statusCode, 403, JSON.stringify(result.agent));
	});

	test('an operation error keeps its message and status across the thread boundary', async () => {
		const result = await probe('/Probe/');
		strictEqual(result.missingSession.ok, false, JSON.stringify(result.missingSession));
		strictEqual(result.missingSession.statusCode, 404, JSON.stringify(result.missingSession));
		ok(result.missingSession.error.includes('Unknown session'), JSON.stringify(result.missingSession));
	});

	test('concurrent calls from the workers each get their own answer', async () => {
		const results = await Promise.all(Array.from({ length: 12 }, () => probe('/Probe/')));
		for (const result of results) strictEqual(result.agent.result?.enabled, true, JSON.stringify(result.agent));
	});

	test('an operation no thread registered still fails as not found', async () => {
		const result = await probe('/Probe/');
		strictEqual(result.unknown.ok, false);
		ok(result.unknown.error.includes('not found'), JSON.stringify(result.unknown));
	});
});
