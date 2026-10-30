/**
 * One query object reused by a delegate across requests is authorized for each requesting principal.
 *
 * The documented delegate pattern (resource-api.md, `checkPermission`): a resource calls
 * `tables.X.search(query, context)` / `tables.X.get(query, context)` with `checkPermission: true` on the
 * query. Each delegate in the fixture keeps ONE module-level query object and reuses it on every request.
 * Two principals differ only in the related table's attribute permissions: `restricted` may not read
 * `ReuseDepartment.secret`. Whichever principal used the query first, the second must receive its own
 * projection; the query object must come back as the application wrote it.
 *
 * Reproduction:
 *   npm run test:integration -- "integrationTests/security/delegated-query-reuse.test.ts"
 */
import { suite, test, before, after } from 'node:test';
import assert from 'node:assert';
import { resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { setupHarperWithFixture, teardownHarper, type ContextWithHarper } from '@harperfast/integration-testing';

const FIXTURE_PATH = resolve(import.meta.dirname, 'fixtures/delegated-query-reuse');
const PASSWORD = 'Reuse-query-4410!';
const BROAD = 'reuse_query_broad';
const RESTRICTED = 'reuse_query_restricted';

const FULL_DEPARTMENT = { id: 'd1', label: 'Engineering', secret: 'payroll-code-7731' };
const NARROW_DEPARTMENT = { id: 'd1', label: 'Engineering' };
const EMPLOYEE = { id: 'e1', name: 'Ada' };
const expectedFor = (user: string) => ({
	...EMPLOYEE,
	department: user === RESTRICTED ? NARROW_DEPARTMENT : FULL_DEPARTMENT,
});
const AUTHORED_SELECT = ['id', 'name', { name: 'department', select: ['id', 'label', 'secret'] }];

function basic(user: string, password = PASSWORD) {
	return `Basic ${Buffer.from(`${user}:${password}`).toString('base64')}`;
}

suite('Delegated reads reusing one query object', (ctx: ContextWithHarper) => {
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
	async function rest(path: string, auth: string) {
		const response = await fetch(`${ctx.harper.httpURL}${path}`, {
			headers: { Authorization: auth, Accept: 'application/json' },
			signal: AbortSignal.timeout(45_000),
		});
		const text = await response.text();
		assert.strictEqual(response.status, 200, `GET ${path}: ${text}`);
		return { body: JSON.parse(text), headers: response.headers };
	}
	async function getOne(resource: string, auth: string) {
		return (await rest(`/${resource}/e1`, auth)).body;
	}
	async function searchOne(resource: string, auth: string) {
		const { body } = await rest(`/${resource}/`, auth);
		assert.ok(Array.isArray(body) && body.length === 1, `one row: ${JSON.stringify(body)}`);
		return body[0];
	}
	async function addUser(role: string, readableAttributes: string[] | undefined) {
		const withoutSecret = () => ({
			read: true,
			insert: false,
			update: false,
			delete: false,
			attribute_permissions: readableAttributes
				? ['id', 'label', 'secret'].map((attribute_name) => ({
						attribute_name,
						read: readableAttributes.includes(attribute_name),
						insert: false,
						update: false,
					}))
				: [],
		});
		await operation({
			operation: 'add_role',
			role,
			permission: {
				super_user: false,
				data: {
					tables: {
						ReuseEmployee: { read: true, insert: false, update: false, delete: false, attribute_permissions: [] },
						ReuseDepartment: withoutSecret(),
						ReuseCachedLabel: withoutSecret(),
					},
				},
			},
		});
		await operation({ operation: 'add_user', username: role, password: PASSWORD, role, active: true });
	}

	before(async () => {
		await setupHarperWithFixture(ctx, FIXTURE_PATH, {
			config: { threads: { count: 1 } },
			env: { AUTHENTICATION_AUTHORIZELOCAL: 'false' },
		});
		admin = basic(ctx.harper.admin.username, ctx.harper.admin.password);
		await operation({ operation: 'insert', schema: 'data', table: 'ReuseDepartment', records: [FULL_DEPARTMENT] });
		await operation({
			operation: 'insert',
			schema: 'data',
			table: 'ReuseEmployee',
			records: [{ ...EMPLOYEE, departmentId: 'd1' }],
		});
		await addUser(BROAD, undefined);
		await addUser(RESTRICTED, ['id', 'label']);
		const deadline = Date.now() + 120_000;
		for (;;) {
			const probe = await fetch(`${ctx.harper.httpURL}/SearchFreshRoot/`, {
				headers: { Authorization: admin },
				signal: AbortSignal.timeout(10_000),
			});
			await probe.text();
			if (probe.status !== 404) break;
			if (Date.now() > deadline) throw new Error('SearchFreshRoot route never became ready');
			await delay(500);
		}
	});

	after(async () => {
		await teardownHarper(ctx);
	});

	test('control: a fresh query object per request projects each principal', async () => {
		for (const user of [BROAD, RESTRICTED, BROAD, RESTRICTED]) {
			assert.deepStrictEqual(await searchOne('SearchFreshRoot', basic(user)), expectedFor(user));
		}
	});

	test('search, broad then restricted: restricted never receives the department secret', async () => {
		assert.deepStrictEqual(await searchOne('SearchBroadFirst', basic(BROAD)), expectedFor(BROAD));
		assert.deepStrictEqual(await searchOne('SearchBroadFirst', basic(RESTRICTED)), expectedFor(RESTRICTED));
		assert.deepStrictEqual(await searchOne('SearchBroadFirst', basic(BROAD)), expectedFor(BROAD));
	});

	test('search, restricted then broad: broad still receives the department secret', async () => {
		assert.deepStrictEqual(await searchOne('SearchRestrictedFirst', basic(RESTRICTED)), expectedFor(RESTRICTED));
		assert.deepStrictEqual(await searchOne('SearchRestrictedFirst', basic(BROAD)), expectedFor(BROAD));
		assert.deepStrictEqual(await searchOne('SearchRestrictedFirst', basic(RESTRICTED)), expectedFor(RESTRICTED));
	});

	test('get, broad then restricted: restricted never receives the department secret', async () => {
		assert.deepStrictEqual(await getOne('GetBroadFirst', basic(BROAD)), expectedFor(BROAD));
		assert.deepStrictEqual(await getOne('GetBroadFirst', basic(RESTRICTED)), expectedFor(RESTRICTED));
		assert.deepStrictEqual(await getOne('GetBroadFirst', basic(BROAD)), expectedFor(BROAD));
	});

	test('get, restricted then broad: broad still receives the department secret', async () => {
		assert.deepStrictEqual(await getOne('GetRestrictedFirst', basic(RESTRICTED)), expectedFor(RESTRICTED));
		assert.deepStrictEqual(await getOne('GetRestrictedFirst', basic(BROAD)), expectedFor(BROAD));
		assert.deepStrictEqual(await getOne('GetRestrictedFirst', basic(RESTRICTED)), expectedFor(RESTRICTED));
	});

	test('a trusted read sharing a nested selector with a user-facing resource keeps its projection', async () => {
		assert.deepStrictEqual((await rest('/TrustedRead/', admin)).body, expectedFor('admin'));
		assert.deepStrictEqual(await getOne('SharedSelectorCard', basic(RESTRICTED)), expectedFor(RESTRICTED));
		assert.deepStrictEqual((await rest('/TrustedRead/', admin)).body, expectedFor('admin'));
	});

	test('every shared query object is left as the application wrote it', async () => {
		const { body: state } = await rest('/RootState/', admin);
		for (const key of ['SearchBroadFirst', 'SearchRestrictedFirst', 'GetBroadFirst', 'GetRestrictedFirst']) {
			assert.strictEqual(state[key].checkPermission, true, `${key}: checkPermission`);
			assert.deepStrictEqual(state[key].select, AUTHORED_SELECT, `${key}: select`);
			assert.deepStrictEqual(state[key].symbols, [], `${key}: authorization symbols`);
		}
		assert.deepStrictEqual(state.INTERNAL_SELECT.select, AUTHORED_SELECT, 'shared nested selector');
	});

	test('a delegate forwarding its REST target to an authorized caching-table read still reports cache hits', async () => {
		const miss = await rest('/CachedLabelView/k1', basic(RESTRICTED));
		assert.deepStrictEqual(miss.body, { id: 'k1', label: 'label k1' }, 'the forwarded read is authorized');
		assert.strictEqual(miss.headers.get('age'), null, 'a source load is not aged');
		const hit = await rest('/CachedLabelView/k1', basic(RESTRICTED));
		assert.deepStrictEqual(hit.body, { id: 'k1', label: 'label k1' });
		assert.match(hit.headers.get('age') ?? '', /^\d+$/, 'a cache hit carries Age');
		assert.deepStrictEqual((await rest('/CachedLabelSourceReads/', admin)).body, { sourceReads: 1 });
	});
});
