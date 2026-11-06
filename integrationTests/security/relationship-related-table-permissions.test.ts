/**
 * Reading through an `@relationship` applies the role's permissions on the related table, on every
 * read API: selecting the relationship, and filtering or sorting by a path through it. SQL, under
 * each engine, refuses a statement that reads a relationship to an unreadable table, leaves such a
 * relationship out of `*`, and narrows every other related record to its readable attributes.
 *
 * Run:
 *   npm run build && npm run test:integration -- "integrationTests/security/relationship-related-table-permissions.test.ts"
 */
import { suite, test, before, after } from 'node:test';
import { deepStrictEqual, ok, strictEqual } from 'node:assert';
import { resolve } from 'node:path';
import { encode as encodeCbor } from 'cbor-x';

import { setupHarperWithFixture, teardownHarper, type ContextWithHarper } from '@harperfast/integration-testing';
// @ts-expect-error utils/client.mjs has no type declarations; runtime resolves fine
import { createApiClient, createHeaders } from '../apiTests/utils/client.mjs';

const FIXTURE_PATH = resolve(import.meta.dirname, 'fixtures/relationship-related-table-permissions');
const skipSuite = process.env.HARPER_RUNTIME === 'bun' || process.platform === 'win32';

const DEPT = { id: 'd1', name: 'Eng', budget: 100 };
const EMP = { id: 'e1', name: 'Ann', deptId: 'd1', payload: { deptId: 'd1' } };
const SEAT = { id: 's1', deptId: 'd1' };
const TEAM = { id: 't1', name: 'Core', vaultId: 'v1' };
const VAULT = { id: 'v1', code: 'vault-code', teamId: 't1' };
const BADGE = { id: 'b1', teamId: 't1' };

const EMP_READ = { read: true, insert: false, update: false, delete: false, attribute_permissions: [] };
const EMP_WRITE = { ...EMP_READ, update: true, delete: true };
const WRITE_ONLY = { ...EMP_WRITE, read: false };
const DEPT_RESTRICTED = {
	...EMP_READ,
	attribute_permissions: [
		{ attribute_name: 'id', read: true, insert: false, update: false },
		{ attribute_name: 'name', read: true, insert: false, update: false },
		{ attribute_name: 'budget', read: false, insert: false, update: false },
	],
};
const ROLES = {
	full: { Emp: EMP_READ, Seat: EMP_READ, Dept: EMP_READ },
	empOnly: { Emp: EMP_READ, Seat: EMP_READ },
	restricted: { Emp: EMP_READ, Seat: EMP_READ, Dept: DEPT_RESTRICTED },
	deptWriter: { Emp: EMP_READ, Seat: EMP_READ, Dept: { ...EMP_READ, read: false, insert: true } },
	budgetWriter: {
		Emp: EMP_READ,
		Seat: EMP_READ,
		Dept: {
			...EMP_READ,
			insert: true,
			attribute_permissions: [
				{ attribute_name: 'id', read: true, insert: false, update: false },
				{ attribute_name: 'name', read: true, insert: false, update: false },
				{ attribute_name: 'budget', read: false, insert: true, update: false },
			],
		},
	},
	empWriter: { Emp: EMP_WRITE, Seat: EMP_READ },
	restrictedWriter: { Emp: EMP_WRITE, Seat: EMP_READ, Dept: DEPT_RESTRICTED },
	writeOnly: { Emp: WRITE_ONLY },
	writeOnlyDeptReader: { Emp: WRITE_ONLY, Dept: EMP_READ },
	teamOnly: { Badge: EMP_READ, Team: EMP_READ },
	teamFull: { Badge: EMP_READ, Team: EMP_READ, Vault: EMP_READ },
	vaultRestricted: {
		Badge: EMP_READ,
		Team: EMP_READ,
		Vault: {
			...EMP_READ,
			attribute_permissions: [
				{ attribute_name: 'id', read: true, insert: false, update: false },
				{ attribute_name: 'teamId', read: true, insert: false, update: false },
				{ attribute_name: 'code', read: false, insert: false, update: false },
			],
		},
	},
};
type RoleName = keyof typeof ROLES;
type Principal = RoleName | 'super';
const PASSWORD = 'Rel-perm-pw-3301!';

/** Starts Harper on the fixture with every role, its user and the records; returns each principal's headers. */
async function startFixture(ctx: ContextWithHarper, env: Record<string, string>) {
	await setupHarperWithFixture(ctx, FIXTURE_PATH, { config: {}, env });
	const client = createApiClient(ctx.harper);
	const headers = { super: client.headers } as Record<Principal, Record<string, string>>;
	for (const [name, tables] of Object.entries(ROLES)) {
		const role = `rel_perm_${name}`;
		await client
			.req()
			.send({ operation: 'add_role', role, permission: { super_user: false, data: { tables } } })
			.expect(200);
		await client
			.req()
			.send({ operation: 'add_user', role, username: role, password: PASSWORD, active: true })
			.expect(200);
		headers[name as RoleName] = createHeaders(role, PASSWORD);
	}
	for (const [table, record] of [
		['Dept', DEPT],
		['Emp', EMP],
		['Seat', SEAT],
		['Vault', VAULT],
		['Team', TEAM],
		['Badge', BADGE],
	] as const) {
		await client
			.req()
			.send({ operation: 'insert', table, records: [record] })
			.expect(200);
	}
	return { client, headers };
}

function assertRefused(response: { status: number; body: any }, context: string, denied?: 'Dept' | 'Dept.budget') {
	strictEqual(
		response.status,
		403,
		`${context}: expected 403, got ${response.status} ${JSON.stringify(response.body)}`
	);
	if (!denied) return;
	// the operations API answers for what the role cannot describe as it does for a root reference
	const [table, attribute] = denied.split('.');
	deepStrictEqual(
		response.body?.invalid_schema_items,
		[attribute ? `Attribute '${attribute}' does not exist on 'data.${table}'` : `Table 'data.${table}' does not exist`],
		`${context}: ${JSON.stringify(response.body)}`
	);
	deepStrictEqual(response.body.unauthorized_access, [], context);
}

/** Every object key anywhere in a response body, to show a denied attribute appears nowhere in it. */
function keysIn(value: any, keys = new Set<string>()): Set<string> {
	if (value && typeof value === 'object') {
		for (const key of Object.keys(value)) {
			if (!Array.isArray(value)) keys.add(key);
			keysIn(value[key], keys);
		}
	}
	return keys;
}

suite('@relationship reads apply the related table permissions', { skip: skipSuite }, (ctx: ContextWithHarper) => {
	let client: ReturnType<typeof createApiClient>;
	let restURL: string;
	const headers = {} as Record<RoleName | 'super', Record<string, string>>;

	async function op(as: RoleName | 'super', body: any) {
		const response = await fetch(ctx.harper.operationsAPIURL, {
			method: 'POST',
			headers: { ...headers[as], 'Content-Type': 'application/json' },
			body: JSON.stringify(body),
		});
		return { status: response.status, body: await response.json() };
	}
	async function rest(as: RoleName | 'super', path: string) {
		const response = await fetch(`${restURL}${path}`, { headers: { ...headers[as], Accept: 'application/json' } });
		const text = await response.text();
		return { status: response.status, body: text ? JSON.parse(text) : undefined };
	}
	async function graphql(as: RoleName | 'super', query: string) {
		const response = await fetch(`${restURL}/graphql`, {
			method: 'POST',
			headers: { ...headers[as], 'Content-Type': 'application/json', 'Accept': 'application/graphql-response+json' },
			body: JSON.stringify({ query }),
		});
		return { status: response.status, body: await response.json() };
	}
	const byHash = (as: RoleName | 'super', get_attributes: any[]) =>
		op(as, { operation: 'search_by_hash', table: 'Emp', hash_values: [EMP.id], get_attributes });
	const byConditions = (as: RoleName | 'super', conditions: any[], extra: any = {}) =>
		op(as, { operation: 'search_by_conditions', table: 'Emp', get_attributes: ['id'], conditions, ...extra });
	const deptName = [{ search_attribute: ['dept', 'name'], search_type: 'equals', search_value: DEPT.name }];
	const deptBudget = [{ search_attribute: ['dept', 'budget'], search_type: 'equals', search_value: DEPT.budget }];

	before(async () => {
		let started: Record<Principal, Record<string, string>>;
		({ client, headers: started } = await startFixture(ctx, {}));
		Object.assign(headers, started);
		restURL = ctx.harper.httpURL;
	});

	after(async () => {
		await teardownHarper(ctx);
	});

	suite('operations API get_attributes', () => {
		test('naming the relationship returns the related record to roles that can read it', async () => {
			for (const as of ['super', 'full'] as const) {
				const response = await byHash(as, ['id', 'dept']);
				strictEqual(response.status, 200, `${as}: ${JSON.stringify(response.body)}`);
				deepStrictEqual(response.body, [{ id: EMP.id, dept: DEPT }], as);
			}
		});

		test('naming the relationship is refused when the role cannot read the related table', async () => {
			assertRefused(await byHash('empOnly', ['id', 'dept']), 'search_by_hash', 'Dept');
			assertRefused(
				await op('empOnly', {
					operation: 'search_by_value',
					table: 'Emp',
					search_attribute: 'id',
					search_value: EMP.id,
					get_attributes: ['id', 'dept'],
				}),
				'search_by_value',
				'Dept'
			);
			assertRefused(
				await byConditions('empOnly', [{ search_attribute: 'id', search_type: 'equals', search_value: EMP.id }], {
					get_attributes: ['id', { name: 'dept', select: ['name'] }],
				}),
				'search_by_conditions sub-select',
				'Dept'
			);
		});

		test('the related record carries only the related attributes the role can read', async () => {
			const response = await byHash('restricted', ['id', 'dept']);
			strictEqual(response.status, 200, JSON.stringify(response.body));
			deepStrictEqual(response.body, [{ id: EMP.id, dept: { id: DEPT.id, name: DEPT.name } }]);
		});

		test('a related * sub-select narrows to the readable attributes', async () => {
			const response = await byConditions(
				'restricted',
				[{ search_attribute: 'id', search_type: 'equals', search_value: EMP.id }],
				{ get_attributes: ['id', { name: 'dept', select: ['*'] }] }
			);
			strictEqual(response.status, 200, JSON.stringify(response.body));
			deepStrictEqual(response.body, [{ id: EMP.id, dept: { id: DEPT.id, name: DEPT.name } }]);
		});

		test('a sub-select naming an unreadable related attribute is refused', async () => {
			assertRefused(
				await byConditions('restricted', [{ search_attribute: 'id', search_type: 'equals', search_value: EMP.id }], {
					get_attributes: ['id', { name: 'dept', select: 'budget' }],
				}),
				'scalar sub-select of budget',
				'Dept.budget'
			);
			assertRefused(
				await byConditions('restricted', [{ search_attribute: 'id', search_type: 'equals', search_value: EMP.id }], {
					get_attributes: ['id', { name: 'dept', select: ['budget'] }],
				}),
				'sub-select of budget',
				'Dept.budget'
			);
		});

		test('* omits the relationship when the role cannot read the related table', async () => {
			const response = await byHash('empOnly', ['*']);
			strictEqual(response.status, 200, JSON.stringify(response.body));
			deepStrictEqual(response.body, [EMP]);
		});

		test('* narrows the related record to readable attributes', async () => {
			const full = await byHash('full', ['*']);
			strictEqual(full.status, 200, JSON.stringify(full.body));
			deepStrictEqual(full.body, [{ ...EMP, dept: DEPT }]);

			const restricted = await byHash('restricted', ['*']);
			strictEqual(restricted.status, 200, JSON.stringify(restricted.body));
			deepStrictEqual(restricted.body, [{ ...EMP, dept: { id: DEPT.id, name: DEPT.name } }]);
		});

		test('the select alias is authorized like get_attributes', async () => {
			assertRefused(
				await op('empOnly', {
					operation: 'search_by_hash',
					table: 'Emp',
					hash_values: [EMP.id],
					get_attributes: ['id'],
					select: ['id', 'dept'],
				}),
				'relationship via select',
				'Dept'
			);
			assertRefused(
				await op('restricted', {
					operation: 'search_by_hash',
					table: 'Dept',
					hash_values: [DEPT.id],
					get_attributes: ['id'],
					select: ['id', 'budget'],
				}),
				'unreadable attribute via select',
				'Dept.budget'
			);
		});
		test('a selection cannot carry its own permissions or sort by an unreadable related attribute', async () => {
			const injected = await byConditions(
				'restricted',
				[{ search_attribute: 'id', search_type: 'equals', search_value: EMP.id }],
				{ get_attributes: ['id', { name: 'dept', checkPermission: { super_user: true } }] }
			);
			strictEqual(injected.status, 200, JSON.stringify(injected.body));
			deepStrictEqual(injected.body, [{ id: EMP.id, dept: { id: DEPT.id, name: DEPT.name } }]);
			assertRefused(
				await byConditions('restricted', [{ search_attribute: 'id', search_type: 'equals', search_value: EMP.id }], {
					get_attributes: ['id', { name: 'dept', select: ['name'], sort: { attribute: 'budget' } }],
				}),
				'nested sort',
				'Dept.budget'
			);
		});
		test('a plain JSON selection object without a sub-selection returns the value', async () => {
			const response = await byConditions(
				'full',
				[{ search_attribute: 'id', search_type: 'equals', search_value: EMP.id }],
				{ get_attributes: ['id', { name: 'payload' }] }
			);
			strictEqual(response.status, 200, JSON.stringify(response.body));
			deepStrictEqual(response.body, [{ id: EMP.id, payload: EMP.payload }]);
		});

		test('a plain JSON sub-selection reads stored JSON keys without Dept permission and never resolves Emp.dept', async () => {
			const idMatch = [{ search_attribute: 'id', search_type: 'equals', search_value: EMP.id }];
			for (const as of ['empOnly', 'restricted', 'full'] as const) {
				const list = await byConditions(as, idMatch, {
					get_attributes: ['id', { name: 'payload', select: ['dept'] }],
				});
				strictEqual(list.status, 200, `${as}: ${JSON.stringify(list.body)}`);
				deepStrictEqual(list.body, [{ id: EMP.id, payload: {} }], as);

				const scalar = await byConditions(as, idMatch, {
					get_attributes: ['id', { name: 'payload', select: 'dept' }],
				});
				strictEqual(scalar.status, 200, `${as}: ${JSON.stringify(scalar.body)}`);
				deepStrictEqual(scalar.body, [{ id: EMP.id, payload: null }], as);
			}
			await client
				.req()
				.send({
					operation: 'update',
					table: 'Emp',
					records: [{ ...EMP, payload: { ...EMP.payload, dept: 'plain-dept' } }],
				})
				.expect(200);
			try {
				const list = await byConditions('empOnly', idMatch, {
					get_attributes: ['id', { name: 'payload', select: ['dept'] }],
				});
				strictEqual(list.status, 200, JSON.stringify(list.body));
				deepStrictEqual(list.body, [{ id: EMP.id, payload: { dept: 'plain-dept' } }]);

				const scalar = await byConditions('empOnly', idMatch, {
					get_attributes: ['id', { name: 'payload', select: 'dept' }],
				});
				strictEqual(scalar.status, 200, JSON.stringify(scalar.body));
				deepStrictEqual(scalar.body, [{ id: EMP.id, payload: 'plain-dept' }]);
			} finally {
				await client
					.req()
					.send({ operation: 'update', table: 'Emp', records: [EMP] })
					.expect(200);
			}
			assertRefused(
				await byConditions('restricted', idMatch, {
					get_attributes: ['id', { name: 'dept', select: [{ name: 'budget', select: ['dept'] }] }],
				}),
				'unreadable related attribute with sub-select',
				'Dept.budget'
			);
		});
	});

	suite('nested selection condition admission', () => {
		test('operations checks the executed attribute when numeric metadata is present', async () => {
			for (const key of ['attribute', 'search_attribute']) {
				for (const grouped of [false, true]) {
					const leaf = { 0: 'id', [key]: ['dept', 'budget'], search_type: 'equals', search_value: DEPT.budget };
					const conditions = grouped
						? [{ operator: 'and', conditions: [{ attribute: 'id', value: EMP.id }, leaf] }]
						: [leaf];
					assertRefused(await byConditions('empOnly', conditions), `numeric decoy ${key} ${grouped}`, 'Dept');
					assertRefused(await byConditions('restricted', conditions), `numeric decoy ${key} ${grouped}`, 'Dept.budget');
				}
			}
			const allowed = await byConditions('empOnly', [{ 0: ['dept', 'budget'], attribute: 'id', value: EMP.id }]);
			strictEqual(allowed.status, 200, JSON.stringify(allowed.body));
			deepStrictEqual(allowed.body, [{ id: EMP.id }]);
		});

		for (const operation of ['search_by_conditions', 'search_by_hash', 'search_by_value']) {
			test(`${operation} checks nested read and describe permissions before validation`, async () => {
				for (const attributeKey of ['attribute', 'search_attribute']) {
					const body = {
						operation,
						table: 'Emp',
						hash_values: [EMP.id],
						search_attribute: 'id',
						search_value: EMP.id,
						conditions: [{ attribute: 'id', value: EMP.id }],
						get_attributes: [
							'id',
							{
								name: 'dept',
								select: ['name'],
								checkPermission: { super_user: true },
								conditions: [
									{
										operator: 'or',
										conditions: [
											{ [attributeKey]: 'name', value: DEPT.name },
											{ operator: 'and', conditions: [{ [attributeKey]: 'budget', value: DEPT.budget }] },
										],
									},
								],
							},
						],
					};
					for (const as of ['full', 'super'] as const) {
						const unchanged = await op(as, body);
						strictEqual(unchanged.status, 400, `${as}: ${JSON.stringify(unchanged.body)}`);
						ok(unchanged.body.error.includes('conditions are not allowed in get_attributes'));
					}
					assertRefused(await op('restricted', body), `${operation} ${attributeKey}`, 'Dept.budget');
					const denied = await op('budgetWriter', body);
					assertRefused(denied, `${operation} visible budget`);
					deepStrictEqual(denied.body.invalid_schema_items, []);
					deepStrictEqual(denied.body.unauthorized_access, [
						{
							schema: 'data',
							table: 'Dept',
							required_table_permissions: [],
							required_attribute_permissions: [{ attribute_name: 'budget', required_permissions: ['read'] }],
						},
					]);
				}
			});
		}

		test('REST checks nested predicates on collections, records and QUERY bodies', async () => {
			assertRefused(
				await rest('empOnly', '/Emp/?select(id,dept[name=Eng&select(name,)])'),
				'nested predicate without related-table read'
			);
			for (const id of ['', EMP.id, 'missing']) {
				assertRefused(
					await rest('restricted', `/Emp/${id}?select(id,dept[budget=number:100&select(name,)])`),
					`nested GET ${id}`
				);
				if (id === 'missing') continue;
				const allowed = await rest('restricted', `/Emp/${id}?select(id,dept[name=Eng&select(name,)])`);
				strictEqual(allowed.status, 200, JSON.stringify(allowed.body));
				const expected = { id: EMP.id, dept: { name: DEPT.name } };
				deepStrictEqual(allowed.body, id ? expected : [expected]);
			}
			const response = await fetch(`${restURL}/Emp/`, {
				method: 'QUERY',
				headers: { ...headers.restricted, 'Content-Type': 'application/json', 'Accept': 'application/json' },
				body: JSON.stringify({
					select: [
						'id',
						{
							name: 'dept',
							select: ['name'],
							conditions: [
								{
									operator: 'or',
									conditions: [
										{ attribute: 'name', value: DEPT.name },
										{ attribute: 'budget', value: DEPT.budget },
									],
								},
							],
						},
					],
				}),
			});
			strictEqual(response.status, 403, await response.text());
			const allowed = await fetch(`${restURL}/Emp/`, {
				method: 'QUERY',
				headers: { ...headers.restricted, 'Content-Type': 'application/json', 'Accept': 'application/json' },
				body: JSON.stringify({
					select: ['id', { name: 'dept', select: ['name'], conditions: [{ attribute: 'name', value: DEPT.name }] }],
				}),
			});
			strictEqual(allowed.status, 200, await allowed.clone().text());
			deepStrictEqual(await allowed.json(), [{ id: EMP.id, dept: { name: DEPT.name } }]);
		});

		test('REST property reads require permission on the returned scalar', async () => {
			assertRefused(await rest('restricted', `/Dept/${DEPT.id}.budget`), 'denied scalar');
			deepStrictEqual(await rest('restricted', `/Dept/${DEPT.id}.name`), { status: 200, body: DEPT.name });
			deepStrictEqual(await rest('full', `/Dept/${DEPT.id}.budget`), { status: 200, body: DEPT.budget });
			deepStrictEqual(await rest('super', `/Dept/${DEPT.id}.budget`), { status: 200, body: DEPT.budget });
		});
	});

	suite('conditions through the relationship', () => {
		const idCondition = [{ search_attribute: 'id', search_type: 'equals', search_value: EMP.id }];
		function assertGraphQLRefused(response: { status: number; body: any }) {
			ok(
				(response.status === 403 || response.body.errors?.length > 0) && !response.body.data?.Emp?.length,
				`expected a refusal, got ${response.status} ${JSON.stringify(response.body)}`
			);
		}

		test('match for roles that can read the related attribute', async () => {
			for (const as of ['super', 'full'] as const) {
				for (const conditions of [deptName, deptBudget]) {
					const response = await byConditions(as, conditions);
					strictEqual(response.status, 200, `${as}: ${JSON.stringify(response.body)}`);
					deepStrictEqual(response.body, [{ id: EMP.id }], as);
				}
			}
			const response = await byConditions('restricted', deptName);
			strictEqual(response.status, 200, JSON.stringify(response.body));
			deepStrictEqual(response.body, [{ id: EMP.id }]);

			for (const as of ['full', 'restricted'] as const) {
				const restResponse = await rest(as, `/Emp/?dept.name=${DEPT.name}&select(id)`);
				strictEqual(restResponse.status, 200, `${as}: ${JSON.stringify(restResponse.body)}`);
				deepStrictEqual(restResponse.body, [{ id: EMP.id }], as);

				const gqlResponse = await graphql(as, `{ Emp(dept: { name: "${DEPT.name}" }) { id } }`);
				strictEqual(gqlResponse.status, 200, `${as}: ${JSON.stringify(gqlResponse.body)}`);
				deepStrictEqual(gqlResponse.body.data, { Emp: [{ id: EMP.id }] }, as);
			}
		});

		test('operations API refuses a condition or sort on a table the role cannot read', async () => {
			assertRefused(await byConditions('empOnly', deptName), 'condition', 'Dept');
			assertRefused(
				await byConditions('empOnly', idCondition, { sort: { attribute: ['dept', 'name'] } }),
				'sort',
				'Dept'
			);
		});

		test('operations API names a related table or attribute the role can see but not read', async () => {
			const table = await byConditions('deptWriter', deptName);
			strictEqual(table.status, 403, JSON.stringify(table.body));
			deepStrictEqual(table.body.invalid_schema_items, []);
			deepStrictEqual(table.body.unauthorized_access, [
				{ schema: 'data', table: 'Dept', required_table_permissions: ['read'], required_attribute_permissions: [] },
			]);
			const attribute = await byConditions('budgetWriter', deptBudget);
			strictEqual(attribute.status, 403, JSON.stringify(attribute.body));
			deepStrictEqual(attribute.body.invalid_schema_items, []);
			deepStrictEqual(attribute.body.unauthorized_access, [
				{
					schema: 'data',
					table: 'Dept',
					required_table_permissions: [],
					required_attribute_permissions: [{ attribute_name: 'budget', required_permissions: ['read'] }],
				},
			]);
		});

		test('operations API refuses a value search through an unreadable relationship', async () => {
			const valueSearch = (as: RoleName | 'super', search_attribute: any[], search_value: any) =>
				op(as, { operation: 'search_by_value', table: 'Emp', search_attribute, search_value, get_attributes: ['id'] });
			const allowed = await valueSearch('full', ['dept', 'budget'], DEPT.budget);
			strictEqual(allowed.status, 200, JSON.stringify(allowed.body));
			deepStrictEqual(allowed.body, [{ id: EMP.id }]);
			assertRefused(await valueSearch('empOnly', ['dept', 'name'], DEPT.name), 'unreadable table', 'Dept');
			assertRefused(
				await valueSearch('restricted', ['dept', 'budget'], DEPT.budget),
				'unreadable attribute',
				'Dept.budget'
			);
		});

		test('operations API refuses a grouped condition through an unreadable relationship', async () => {
			assertRefused(
				await byConditions('empOnly', [{ operator: 'or', conditions: [...idCondition, ...deptName] }]),
				'grouped condition',
				'Dept'
			);
		});

		test('a same-record group through the relationship is authorized against the related table', async () => {
			for (const group of [
				(conditions: any[]) => [{ attribute: 'dept', conditions }],
				(conditions: any[]) => [{ operator: 'and', conditions: [{ attribute: 'dept', conditions }] }],
			]) {
				const byName = group([{ attribute: 'name', value: DEPT.name }]);
				const byBudget = group([{ attribute: 'budget', value: DEPT.budget }]);
				assertRefused(await byConditions('empOnly', byName), 'group on an unreadable table', 'Dept');
				assertRefused(await byConditions('restricted', byBudget), 'group on an unreadable attribute', 'Dept.budget');
				const allowedBudget = await byConditions('full', byBudget);
				strictEqual(allowedBudget.status, 200, JSON.stringify(allowedBudget.body));
				deepStrictEqual(allowedBudget.body, [{ id: EMP.id }]);
				const allowed = await byConditions('restricted', byName);
				strictEqual(allowed.status, 200, JSON.stringify(allowed.body));
				deepStrictEqual(allowed.body, [{ id: EMP.id }]);
			}
			strictEqual((await rest('restricted', `/Emp/?dept[budget=${DEPT.budget}]&select(id)`)).status, 403);
			strictEqual((await rest('empOnly', `/Emp/?dept[name=${DEPT.name}]&select(id)`)).status, 403);
			// inside a root group, ResourceBridge rebuilds leaves from `attribute`, whereas a select-nested condition
			// executes `condition[0] ?? condition.attribute` directly
			assertRefused(
				await byConditions('restricted', [
					{ attribute: 'dept', conditions: [{ 0: 'name', attribute: 'budget', value: DEPT.budget }] },
				]),
				'numeric-keyed leaf inside a root group',
				'Dept.budget'
			);
			const rootNumericAllowed = await byConditions('restricted', [
				{ attribute: 'dept', conditions: [{ 0: 'budget', attribute: 'name', value: DEPT.name }] },
			]);
			strictEqual(rootNumericAllowed.status, 200, JSON.stringify(rootNumericAllowed.body));
			deepStrictEqual(rootNumericAllowed.body, [{ id: EMP.id }]);
			assertRefused(
				await op('restricted', {
					operation: 'search_by_conditions',
					table: 'Emp',
					conditions: [{ attribute: 'id', value: EMP.id }],
					get_attributes: ['id', { name: 'dept', conditions: [{ 0: 'budget', attribute: 'name', value: DEPT.name }] }],
				}),
				'numeric-keyed leaf inside a select condition',
				'Dept.budget'
			);
			// only `attribute` makes a group a same-record group, so another spelling stays on the root table
			const spelled = await byConditions('empOnly', [
				{ operator: 'and', conditions: [{ 0: 'dept', conditions: [{ attribute: 'name', value: DEPT.name }] }] },
			]);
			strictEqual(spelled.status, 200, JSON.stringify(spelled.body));
			deepStrictEqual(spelled.body, [], 'the conditions ran on Emp, whose only record is not named Eng');
			const restAllowed = await rest('restricted', `/Emp/?dept[name=${DEPT.name}]&select(id)`);
			strictEqual(restAllowed.status, 200, JSON.stringify(restAllowed.body));
			deepStrictEqual(restAllowed.body, [{ id: EMP.id }]);
		});

		test('operations API refuses a condition on a related attribute the role cannot read', async () => {
			assertRefused(await byConditions('restricted', deptBudget), 'condition', 'Dept.budget');
		});

		test('operations API authorizes the condition attribute that executes', async () => {
			assertRefused(
				await byConditions('restricted', [
					{ attribute: ['dept', 'budget'], search_attribute: 'id', search_type: 'equals', search_value: DEPT.budget },
				]),
				'attribute with a search_attribute decoy',
				'Dept.budget'
			);
		});

		test('REST QUERY refuses body conditions and sort through an unreadable relationship', async () => {
			const query = (as: RoleName, body: any) =>
				fetch(`${restURL}/Emp/`, {
					method: 'QUERY',
					headers: { ...headers[as], 'Content-Type': 'application/json', 'Accept': 'application/json' },
					body: JSON.stringify(body),
				});
			const allowed = await query('full', {
				select: ['id'],
				conditions: [{ attribute: ['dept', 'budget'], value: DEPT.budget }],
			});
			strictEqual(allowed.status, 200);
			deepStrictEqual(await allowed.json(), [{ id: EMP.id }]);
			const condition = await query('restricted', {
				select: ['id'],
				conditions: [{ attribute: ['dept', 'budget'], value: DEPT.budget }],
			});
			strictEqual(condition.status, 403, await condition.text());
			const sort = await query('empOnly', { select: ['id'], sort: { attribute: ['dept', 'name'] } });
			strictEqual(sort.status, 403, await sort.text());
			const single = await query('restricted', {
				select: ['id'],
				conditions: { attribute: ['dept', 'budget'], value: DEPT.budget },
			});
			strictEqual(single.status, 403, await single.text());
			const budgetCondition = { attribute: ['dept', 'budget'], value: DEPT.budget };
			const queryCbor = (as: RoleName, body: any) =>
				fetch(`${restURL}/Emp/`, {
					method: 'QUERY',
					headers: { ...headers[as], 'Content-Type': 'application/cbor', 'Accept': 'application/json' },
					body: encodeCbor(body),
				});
			for (const [label, send] of [
				['array body', (as: RoleName) => query(as, [budgetCondition])],
				['CBOR set body', (as: RoleName) => queryCbor(as, new Set([budgetCondition]))],
			] as const) {
				const full = await send('full');
				const fullText = await full.text();
				strictEqual(full.status, 200, `${label}: ${fullText}`);
				deepStrictEqual(
					JSON.parse(fullText).map((record: any) => record.id),
					[EMP.id],
					label
				);
				const refused = await send('restricted');
				strictEqual(refused.status, 403, `${label}: ${await refused.text()}`);
			}
		});

		test('REST refuses a condition on a related table or attribute the role cannot read', async () => {
			assertRefused(await rest('empOnly', `/Emp/?dept.name=${DEPT.name}`), 'unreadable table');
			assertRefused(await rest('restricted', `/Emp/?dept.budget=${DEPT.budget}`), 'unreadable attribute');
			assertRefused(await rest('empOnly', '/Emp/?select(id)&sort(+name,+dept.name)'), 'secondary sort');
		});

		test('GraphQL refuses a nested argument on a related table or attribute the role cannot read', async () => {
			assertGraphQLRefused(await graphql('empOnly', `{ Emp(dept: { name: "${DEPT.name}" }) { id } }`));
			assertGraphQLRefused(await graphql('restricted', `{ Emp(dept: { budget: ${DEPT.budget} }) { id } }`));
		});
	});

	suite('REST select', () => {
		test('returns, omits or narrows the related record by the role’s related-table permissions', async () => {
			const full = await rest('full', `/Emp/${EMP.id}?select(id,dept)`);
			strictEqual(full.status, 200, JSON.stringify(full.body));
			deepStrictEqual(full.body, { id: EMP.id, dept: DEPT });

			const empOnly = await rest('empOnly', `/Emp/${EMP.id}?select(id,dept)`);
			strictEqual(empOnly.status, 200, JSON.stringify(empOnly.body));
			deepStrictEqual(empOnly.body, { id: EMP.id });

			const restricted = await rest('restricted', `/Emp/${EMP.id}?select(id,dept)`);
			strictEqual(restricted.status, 200, JSON.stringify(restricted.body));
			deepStrictEqual(restricted.body, { id: EMP.id, dept: { id: DEPT.id, name: DEPT.name } });

			for (const as of ['empOnly', 'restricted', 'full'] as const) {
				const collection = await rest(as, '/Emp/?select(id,payload{dept})');
				strictEqual(collection.status, 200, `${as}: ${JSON.stringify(collection.body)}`);
				deepStrictEqual(collection.body, [{ id: EMP.id, payload: {} }], as);

				const json = await rest(as, `/Emp/${EMP.id}?select(id,payload{dept})`);
				strictEqual(json.status, 200, `${as}: ${JSON.stringify(json.body)}`);
				deepStrictEqual(json.body, { id: EMP.id, payload: {} }, as);
			}
			await client
				.req()
				.send({
					operation: 'update',
					table: 'Emp',
					records: [{ ...EMP, payload: { ...EMP.payload, dept: 'plain-dept' } }],
				})
				.expect(200);
			try {
				const collection = await rest('empOnly', '/Emp/?select(id,payload{dept})');
				strictEqual(collection.status, 200, JSON.stringify(collection.body));
				deepStrictEqual(collection.body, [{ id: EMP.id, payload: { dept: 'plain-dept' } }]);

				const json = await rest('empOnly', `/Emp/${EMP.id}?select(id,payload{dept})`);
				strictEqual(json.status, 200, JSON.stringify(json.body));
				deepStrictEqual(json.body, { id: EMP.id, payload: { dept: 'plain-dept' } });
			} finally {
				await client
					.req()
					.send({ operation: 'update', table: 'Emp', records: [EMP] })
					.expect(200);
			}
		});
		test('a read without select returns, omits or narrows an @enumerable relationship', async () => {
			const expected = {
				super: { ...SEAT, dept: DEPT },
				full: { ...SEAT, dept: DEPT },
				empOnly: SEAT,
				restricted: { ...SEAT, dept: { id: DEPT.id, name: DEPT.name } },
			};
			for (const [as, seat] of Object.entries(expected) as [RoleName | 'super', any][]) {
				const record = await rest(as, `/Seat/${SEAT.id}`);
				strictEqual(record.status, 200, `${as}: ${JSON.stringify(record.body)}`);
				deepStrictEqual(record.body, seat, as);
				const collection = await rest(as, '/Seat/');
				strictEqual(collection.status, 200, `${as}: ${JSON.stringify(collection.body)}`);
				deepStrictEqual(collection.body, [seat], as);
				const whole = await rest(as, '/Seat/?select(id,$record)');
				strictEqual(whole.status, 200, `${as}: ${JSON.stringify(whole.body)}`);
				deepStrictEqual(whole.body, [{ id: SEAT.id, $record: seat }], `${as} $record`);
				const search = await op(as, {
					operation: 'search_by_conditions',
					table: 'Seat',
					conditions: [{ search_attribute: 'id', search_type: 'equals', search_value: SEAT.id }],
				});
				strictEqual(search.status, 200, `${as}: ${JSON.stringify(search.body)}`);
				// operations API results serialize stored attributes only
				deepStrictEqual(search.body, [SEAT], `${as} operations API without get_attributes`);
			}
		});
		test('a * anywhere in operations get_attributes omits or narrows an @enumerable relationship', async () => {
			const expected = { empOnly: undefined, restricted: { id: DEPT.id, name: DEPT.name } };
			for (const [as, dept] of Object.entries(expected) as [RoleName, any][]) {
				for (const body of [
					{ operation: 'search_by_hash', hash_values: [SEAT.id] },
					{ operation: 'search_by_conditions', conditions: [{ search_attribute: 'id', search_value: SEAT.id }] },
					{ operation: 'search_by_value', search_attribute: 'id', search_value: SEAT.id },
				]) {
					for (const get_attributes of [
						['id', '*'],
						['*', 'id'],
					]) {
						const response = await op(as, { ...body, table: 'Seat', get_attributes });
						strictEqual(response.status, 200, `${as}: ${JSON.stringify(response.body)}`);
						const label = `${as} ${body.operation} ${get_attributes}`;
						deepStrictEqual(response.body[0].dept, get_attributes[0] === '*' ? dept : undefined, label);
					}
				}
			}
		});
		test('a relationship read as a property path is authorized against the related table', async () => {
			const full = await rest('full', `/Emp/${EMP.id}.dept`);
			strictEqual(full.status, 200, JSON.stringify(full.body));
			deepStrictEqual(full.body, DEPT);
			assertRefused(await rest('empOnly', `/Emp/${EMP.id}.dept`), 'empOnly property path');
			const restricted = await rest('restricted', `/Emp/${EMP.id}.dept`);
			strictEqual(restricted.status, 200, JSON.stringify(restricted.body));
			deepStrictEqual(restricted.body, { id: DEPT.id, name: DEPT.name });
		});
	});
});

const DEPT_READABLE = { id: DEPT.id, name: DEPT.name };

for (const sqlEngine of ['legacy', 'auto', 'new'] as const) {
	suite(
		`SQL reads of @relationship columns apply the related table permissions [sql.engine=${sqlEngine}]`,
		{ skip: skipSuite },
		(ctx: ContextWithHarper) => {
			let client: ReturnType<typeof createApiClient>;
			let headers: Record<Principal, Record<string, string>>;
			// v2 rejects AlaSQL's `->`; under auto such a statement runs on legacy SQL
			const memberAccess = sqlEngine !== 'new';

			async function op(as: Principal, body: any) {
				const response = await fetch(ctx.harper.operationsAPIURL, {
					method: 'POST',
					headers: { ...headers[as], 'Content-Type': 'application/json' },
					body: JSON.stringify(body),
				});
				return { status: response.status, body: await response.json() };
			}
			const sql = (as: Principal, statement: string) => op(as, { operation: 'sql', sql: statement });
			async function rows(as: Principal, statement: string) {
				const response = await sql(as, statement);
				strictEqual(response.status, 200, `${as} ${statement}: ${JSON.stringify(response.body)}`);
				return response.body;
			}
			async function storedEmp() {
				const response = await op('super', {
					operation: 'search_by_hash',
					table: 'Emp',
					hash_values: [EMP.id],
					get_attributes: ['id', 'name', 'deptId', 'payload'],
				});
				strictEqual(response.status, 200, JSON.stringify(response.body));
				return response.body;
			}
			const restoreEmp = () =>
				client
					.req()
					.send({ operation: 'update', table: 'Emp', records: [EMP] })
					.expect(200);

			before(async () => {
				({ client, headers } = await startFixture(ctx, { HARPER_SQL_ENGINE: sqlEngine }));
			});

			after(async () => {
				await teardownHarper(ctx);
			});

			test('an explicit relationship column returns the related record narrowed to what the role can read', async () => {
				for (const [statement, column] of [
					[`SELECT id, dept FROM data.Emp WHERE id = 'e1'`, 'dept'],
					[`SELECT id, dept AS d FROM data.Emp WHERE id = 'e1'`, 'd'],
				]) {
					for (const as of ['super', 'full'] as const)
						deepStrictEqual(await rows(as, statement), [{ id: EMP.id, [column]: DEPT }], `${as} ${statement}`);
					deepStrictEqual(await rows('restricted', statement), [{ id: EMP.id, [column]: DEPT_READABLE }], statement);
					assertRefused(await sql('empOnly', statement), statement, 'Dept');
				}
				const describable = await sql('deptWriter', `SELECT id, dept FROM data.Emp WHERE id = 'e1'`);
				strictEqual(describable.status, 403, JSON.stringify(describable.body));
				deepStrictEqual(describable.body.invalid_schema_items, []);
				deepStrictEqual(describable.body.unauthorized_access, [
					{ schema: 'data', table: 'Dept', required_table_permissions: ['read'], required_attribute_permissions: [] },
				]);
			});

			test('* leaves out a relationship to an unreadable table and narrows the others', async () => {
				for (const statement of [
					`SELECT * FROM data.Seat WHERE id = 's1'`,
					`SELECT s.* FROM data.Seat s WHERE s.id = 's1'`,
				]) {
					deepStrictEqual(await rows('empOnly', statement), [SEAT], statement);
					deepStrictEqual(await rows('restricted', statement), [{ ...SEAT, dept: DEPT_READABLE }], statement);
					deepStrictEqual(await rows('full', statement), [{ ...SEAT, dept: DEPT }], statement);
					// v2 answers a super user's * from stored attributes; legacy SQL resolves the relationship
					deepStrictEqual(await rows('super', statement), [sqlEngine === 'legacy' ? { ...SEAT, dept: DEPT } : SEAT]);
				}
				const emp = `SELECT * FROM data.Emp WHERE id = 'e1'`;
				deepStrictEqual(await rows('empOnly', emp), [EMP]);
				deepStrictEqual(await rows('restricted', emp), [{ ...EMP, dept: DEPT_READABLE }]);
			});

			test('any other read of a relationship to an unreadable table is refused', async () => {
				for (const statement of [
					`SELECT COUNT(dept) AS n FROM data.Emp WHERE id = 'e1'`,
					`SELECT id FROM data.Emp WHERE id = 'e1' AND dept IS NOT NULL`,
					`SELECT id FROM data.Emp WHERE id = 'e1' ORDER BY dept`,
					`SELECT id, dept FROM data.Emp WHERE id = 'e1' GROUP BY id, dept`,
					`SELECT DISTINCT dept FROM data.Emp WHERE id = 'e1'`,
					`SELECT id, dept->budget AS b FROM data.Emp WHERE id = 'e1'`,
					`SELECT e.id, e.dept FROM data.Emp e JOIN data.Seat s ON e.deptId = s.deptId WHERE e.id = 'e1'`,
					`SELECT e.id FROM data.Emp e JOIN data.Seat s ON e.deptId = s.deptId WHERE e.id = 'e1' AND s.dept IS NOT NULL`,
				])
					assertRefused(await sql('empOnly', statement), statement, 'Dept');
				deepStrictEqual(await rows('restricted', `SELECT COUNT(dept) AS n FROM data.Emp WHERE id = 'e1'`), [{ n: 1 }]);
				deepStrictEqual(await rows('restricted', `SELECT DISTINCT dept FROM data.Emp WHERE id = 'e1'`), [
					{ dept: DEPT_READABLE },
				]);
			});

			test('a related attribute the role cannot read is unreachable through an expression or a join', async () => {
				const member = `SELECT id, dept->budget AS b FROM data.Emp WHERE id = 'e1'`;
				const probe = `SELECT id FROM data.Emp WHERE id = 'e1' AND dept->budget = ${DEPT.budget}`;
				if (memberAccess) {
					deepStrictEqual(await rows('full', member), [{ id: EMP.id, b: DEPT.budget }]);
					deepStrictEqual(await rows('restricted', member), [{ id: EMP.id }]);
					deepStrictEqual(await rows('full', probe), [{ id: EMP.id }]);
					deepStrictEqual(await rows('restricted', probe), []);
				} else {
					const unsupported = await sql('restricted', member);
					strictEqual(unsupported.status, 400, JSON.stringify(unsupported.body));
					ok(String(unsupported.body.error).includes('SQL engine v2'), JSON.stringify(unsupported.body));
				}
				for (const statement of [
					`SELECT e.id, e.dept FROM data.Emp e JOIN data.Seat s ON e.deptId = s.deptId WHERE e.id = 'e1'`,
					`SELECT e.id, s.dept FROM data.Emp e JOIN data.Seat s ON e.deptId = s.deptId WHERE e.id = 'e1'`,
					`SELECT e.*, s.* FROM data.Emp e JOIN data.Seat s ON e.deptId = s.deptId WHERE e.id = 'e1'`,
				]) {
					const body = await rows('restricted', statement);
					strictEqual(body.length, 1, `${statement}: ${JSON.stringify(body)}`);
					ok(!keysIn(body).has('budget'), `${statement}: ${JSON.stringify(body)}`);
				}
			});

			test('a cyclic @enumerable pair is authorized table by table, and a related record carries no relationships', async () => {
				const vault = `SELECT id, vault FROM data.Team WHERE id = 't1'`;
				for (const as of ['super', 'teamFull'] as const)
					deepStrictEqual(await rows(as, vault), [{ id: TEAM.id, vault: VAULT }], as);
				const readableVault = { id: VAULT.id, teamId: VAULT.teamId };
				deepStrictEqual(await rows('vaultRestricted', vault), [{ id: TEAM.id, vault: readableVault }]);
				const denied = await sql('teamOnly', vault);
				strictEqual(denied.status, 403, JSON.stringify(denied.body));
				deepStrictEqual(denied.body.invalid_schema_items, [`Table 'data.Vault' does not exist`]);

				const team = `SELECT * FROM data.Team WHERE id = 't1'`;
				deepStrictEqual(await rows('teamFull', team), [{ ...TEAM, vault: VAULT }]);
				deepStrictEqual(await rows('teamFull', `SELECT * FROM data.Vault WHERE id = 'v1'`), [{ ...VAULT, team: TEAM }]);
				deepStrictEqual(await rows('vaultRestricted', team), [{ ...TEAM, vault: readableVault }]);
				deepStrictEqual(await rows('teamOnly', team), [TEAM]);

				// Team's own @enumerable vault stays out of a Team reached through Badge, whoever reads it
				for (const as of ['super', 'teamFull', 'vaultRestricted', 'teamOnly'] as const)
					deepStrictEqual(
						await rows(as, `SELECT id, team FROM data.Badge WHERE id = 'b1'`),
						[{ id: BADGE.id, team: TEAM }],
						as
					);
			});

			test('a write statement that reads an unreadable relationship is refused and changes nothing', async () => {
				for (const as of ['empWriter', 'writeOnly'] as const) {
					for (const statement of [
						`UPDATE data.Emp SET payload = dept WHERE id = 'e1'`,
						`UPDATE data.Emp SET name = 'changed' WHERE id = 'e1' AND dept IS NOT NULL`,
						`DELETE FROM data.Emp WHERE id = 'e1' AND dept IS NOT NULL`,
					]) {
						assertRefused(await sql(as, statement), `${as} ${statement}`, 'Dept');
						deepStrictEqual(await storedEmp(), [EMP], `${as} ${statement}`);
					}
					const plain = await sql(as, `UPDATE data.Emp SET name = '${EMP.name}' WHERE id = 'e1'`);
					strictEqual(plain.status, 200, `${as}: ${JSON.stringify(plain.body)}`);
				}
			});

			test('a write statement stores only the related attributes the role can read', async () => {
				const copy = `UPDATE data.Emp SET payload = dept WHERE id = 'e1'`;
				// legacy SQL evaluates SET against the stored record, where a relationship is unset
				const copied = (dept: any) => (sqlEngine === 'legacy' ? null : dept);
				try {
					strictEqual((await sql('restrictedWriter', copy)).status, 200);
					deepStrictEqual(await storedEmp(), [{ ...EMP, payload: copied(DEPT_READABLE) }]);
					await restoreEmp();
					strictEqual((await sql('writeOnlyDeptReader', copy)).status, 200);
					deepStrictEqual(await storedEmp(), [{ ...EMP, payload: copied(DEPT) }]);
					await restoreEmp();
					if (memberAccess) {
						const probe = await sql(
							'restrictedWriter',
							`UPDATE data.Emp SET name = 'probed' WHERE id = 'e1' AND dept->budget = ${DEPT.budget}`
						);
						strictEqual(probe.status, 200, JSON.stringify(probe.body));
						deepStrictEqual(probe.body.update_hashes, []);
						deepStrictEqual(await storedEmp(), [EMP]);
					}
				} finally {
					await restoreEmp();
				}
			});

			test('principals running one statement in turn each get their own result and leave the role unchanged', async () => {
				const rolePermission = async () => {
					const response = await op('super', { operation: 'list_roles' });
					return response.body.find((role: any) => role.role === 'rel_perm_restricted').permission;
				};
				const permission = await rolePermission();
				const statement = `SELECT id, dept FROM data.Emp WHERE id = 'e1'`;
				const expected = {
					restricted: [{ id: EMP.id, dept: DEPT_READABLE }],
					full: [{ id: EMP.id, dept: DEPT }],
					super: [{ id: EMP.id, dept: DEPT }],
				};
				for (const as of [
					'restricted',
					'full',
					'super',
					'empOnly',
					'restricted',
					'super',
					'full',
					'restricted',
				] as const) {
					if (as === 'empOnly') assertRefused(await sql(as, statement), as, 'Dept');
					else deepStrictEqual(await rows(as, statement), expected[as], as);
				}
				deepStrictEqual(await rolePermission(), permission);
			});
		}
	);
}
