/**
 * The reused delegate query object of `delegated-query-reuse.test.ts`, under four HTTP worker threads.
 *
 * Each worker holds its own copy of the module-level query object, so a restricted request only exercises
 * reuse when it lands on a worker an earlier broad request already used. Every request opens its own
 * connection to spread requests across workers, and the delegate reports its worker in `x-worker`; the test
 * keeps sending restricted requests until each broad-used worker has served one, and fails if routing
 * never gets there.
 *
 * Reproduction:
 *   npm run test:integration -- "integrationTests/security/delegated-query-reuse-workers.test.ts"
 */
import { suite, test, before, after } from 'node:test';
import assert from 'node:assert';
import { request } from 'node:http';
import { resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { setupHarperWithFixture, teardownHarper, type ContextWithHarper } from '@harperfast/integration-testing';

const FIXTURE_PATH = resolve(import.meta.dirname, 'fixtures/delegated-query-reuse');
const PASSWORD = 'Reuse-query-4410!';
const BROAD = 'reuse_query_broad';
const RESTRICTED = 'reuse_query_restricted';
const BROAD_REQUESTS = 16;
const RESTRICTED_BUDGET = 96;

function basic(user: string, password = PASSWORD) {
	return `Basic ${Buffer.from(`${user}:${password}`).toString('base64')}`;
}

/** GET on a fresh connection (no agent), so the server's accept distribution picks the worker. */
function getOnNewConnection(url: string, auth: string): Promise<{ status: number; worker: string; body: any }> {
	return new Promise((resolvePromise, reject) => {
		const req = request(
			url,
			{ agent: false, headers: { Authorization: auth, Accept: 'application/json' }, timeout: 45_000 },
			(response) => {
				let text = '';
				response.setEncoding('utf8');
				response.on('data', (chunk) => (text += chunk));
				response.on('end', () => {
					try {
						resolvePromise({
							status: response.statusCode ?? 0,
							worker: String(response.headers['x-worker']),
							body: JSON.parse(text),
						});
					} catch (error) {
						reject(new Error(`unparseable response ${response.statusCode}: ${text}`, { cause: error }));
					}
				});
			}
		);
		req.on('timeout', () => req.destroy(new Error(`GET ${url} timed out`)));
		req.on('error', reject);
		req.end();
	});
}

suite('Delegated query object reuse across worker threads', (ctx: ContextWithHarper) => {
	let admin: string;

	async function operation(body: Record<string, unknown>) {
		const response = await fetch(ctx.harper.operationsAPIURL, {
			method: 'POST',
			headers: { 'Authorization': admin, 'Content-Type': 'application/json' },
			body: JSON.stringify(body),
			signal: AbortSignal.timeout(45_000),
		});
		const text = await response.text();
		assert.strictEqual(response.status, 200, `${body.operation}: ${text}`);
	}
	async function addUser(role: string, departmentAttributes: string[] | undefined) {
		await operation({
			operation: 'add_role',
			role,
			permission: {
				super_user: false,
				data: {
					tables: {
						ReuseEmployee: { read: true, insert: false, update: false, delete: false, attribute_permissions: [] },
						ReuseDepartment: {
							read: true,
							insert: false,
							update: false,
							delete: false,
							attribute_permissions: departmentAttributes
								? ['id', 'label', 'secret'].map((attribute_name) => ({
										attribute_name,
										read: departmentAttributes.includes(attribute_name),
										insert: false,
										update: false,
									}))
								: [],
						},
					},
				},
			},
		});
		await operation({ operation: 'add_user', username: role, password: PASSWORD, role, active: true });
	}
	async function searchRow(user: string) {
		const response = await getOnNewConnection(`${ctx.harper.httpURL}/SearchAcrossWorkers/`, basic(user));
		assert.strictEqual(response.status, 200, JSON.stringify(response.body));
		assert.ok(Array.isArray(response.body) && response.body.length === 1, JSON.stringify(response.body));
		assert.notStrictEqual(response.worker, 'undefined', 'the delegate reports its worker');
		return { worker: response.worker, row: response.body[0] };
	}

	before(async () => {
		await setupHarperWithFixture(ctx, FIXTURE_PATH, {
			config: { threads: { count: 4 } },
			env: { AUTHENTICATION_AUTHORIZELOCAL: 'false' },
		});
		admin = basic(ctx.harper.admin.username, ctx.harper.admin.password);
		await operation({
			operation: 'insert',
			schema: 'data',
			table: 'ReuseDepartment',
			records: [{ id: 'd1', label: 'Engineering', secret: 'payroll-code-7731' }],
		});
		await operation({
			operation: 'insert',
			schema: 'data',
			table: 'ReuseEmployee',
			records: [{ id: 'e1', name: 'Ada', departmentId: 'd1' }],
		});
		await addUser(BROAD, undefined);
		await addUser(RESTRICTED, ['id', 'label']);
		const deadline = Date.now() + 120_000;
		for (;;) {
			const probe = await fetch(`${ctx.harper.httpURL}/SearchFreshRoot/`, { headers: { Authorization: admin } });
			await probe.text();
			if (probe.status !== 404) break;
			if (Date.now() > deadline) throw new Error('SearchFreshRoot route never became ready');
			await delay(500);
		}
	});

	after(async () => {
		await teardownHarper(ctx);
	});

	test('restricted requests on every broad-used worker never receive the department secret', async () => {
		const broadWorkers = new Set<string>();
		for (let i = 0; i < BROAD_REQUESTS; i++) {
			const { worker, row } = await searchRow(BROAD);
			assert.strictEqual(row.department?.secret, 'payroll-code-7731', `broad on worker ${worker}`);
			broadWorkers.add(worker);
		}
		console.log(`broad requests reached workers ${[...broadWorkers]}`);
		const unvisited = new Set(broadWorkers);
		let sent = 0;
		while (unvisited.size > 0 && sent < RESTRICTED_BUDGET) {
			const { worker, row } = await searchRow(RESTRICTED);
			sent++;
			assert.deepStrictEqual(row.department, { id: 'd1', label: 'Engineering' }, `restricted on worker ${worker}`);
			unvisited.delete(worker);
		}
		assert.strictEqual(
			unvisited.size,
			0,
			`restricted requests never reached broad-used workers ${[...unvisited]} within ${RESTRICTED_BUDGET} requests`
		);
		const { worker, row } = await searchRow(BROAD);
		assert.strictEqual(row.department?.secret, 'payroll-code-7731', `broad after restricted on worker ${worker}`);
	});
});
