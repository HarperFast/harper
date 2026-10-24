/**
 * Reading through an `@relationship` applies the role's permissions on the related table, on every
 * read API: selecting the relationship, and filtering or sorting by a path through it.
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

const EMP_READ = { read: true, insert: false, update: false, delete: false, attribute_permissions: [] };
const ROLES = {
	full: { Emp: EMP_READ, Seat: EMP_READ, Dept: EMP_READ },
	empOnly: { Emp: EMP_READ, Seat: EMP_READ },
	restricted: {
		Emp: EMP_READ,
		Seat: EMP_READ,
		Dept: {
			...EMP_READ,
			attribute_permissions: [
				{ attribute_name: 'id', read: true, insert: false, update: false },
				{ attribute_name: 'name', read: true, insert: false, update: false },
				{ attribute_name: 'budget', read: false, insert: false, update: false },
			],
		},
	},
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
};
type RoleName = keyof typeof ROLES;
const PASSWORD = 'Rel-perm-pw-3301!';

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
			[
				attribute
					? `Attribute '${attribute}' does not exist on 'data.${table}'`
					: `Table 'data.${table}' does not exist`,
			],
			`${context}: ${JSON.stringify(response.body)}`
		);
		deepStrictEqual(response.body.unauthorized_access, [], context);
	}

	before(async () => {
		await setupHarperWithFixture(ctx, FIXTURE_PATH, { config: {}, env: {} });
		client = createApiClient(ctx.harper);
		restURL = ctx.harper.httpURL;
		headers.super = client.headers;
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
		await client
			.req()
			.send({ operation: 'insert', table: 'Dept', records: [DEPT] })
			.expect(200);
		await client
			.req()
			.send({ operation: 'insert', table: 'Emp', records: [EMP] })
			.expect(200);
		await client
			.req()
			.send({ operation: 'insert', table: 'Seat', records: [SEAT] })
			.expect(200);
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

		test('a plain JSON sub-selection cannot reach the relationship', async () => {
			for (const select of ['dept', ['dept']]) {
				assertRefused(
					await byConditions('empOnly', [{ search_attribute: 'id', search_type: 'equals', search_value: EMP.id }], {
						get_attributes: ['id', { name: 'payload', select }],
					}),
					`payload select ${JSON.stringify(select)}`,
					'Dept'
				);
			}
			assertRefused(
				await byConditions('empOnly', [{ search_attribute: 'id', search_type: 'equals', search_value: EMP.id }], {
					get_attributes: ['id', { name: 'payload', select: ['dept'] }],
				}),
				'payload.dept',
				'Dept'
			);
			const restricted = await byConditions(
				'restricted',
				[{ search_attribute: 'id', search_type: 'equals', search_value: EMP.id }],
				{ get_attributes: ['id', { name: 'payload', select: ['dept'] }] }
			);
			strictEqual(restricted.status, 200, JSON.stringify(restricted.body));
			deepStrictEqual(restricted.body, [{ id: EMP.id, payload: { dept: { id: DEPT.id, name: DEPT.name } } }]);
			for (const [as, dept] of [
				['full', DEPT],
				['restricted', { id: DEPT.id, name: DEPT.name }],
			] as const) {
				const scalar = await byConditions(
					as,
					[{ search_attribute: 'id', search_type: 'equals', search_value: EMP.id }],
					{ get_attributes: ['id', { name: 'payload', select: 'dept' }] }
				);
				strictEqual(scalar.status, 200, `${as}: ${JSON.stringify(scalar.body)}`);
				deepStrictEqual(scalar.body, [{ id: EMP.id, payload: dept }], as);
			}
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

			const collection = await rest('empOnly', '/Emp/?select(id,payload{dept})');
			strictEqual(collection.status, 200, JSON.stringify(collection.body));
			deepStrictEqual(collection.body, [{ id: EMP.id, payload: {} }]);
			const narrowed = await rest('restricted', '/Emp/?select(id,payload{dept})');
			strictEqual(narrowed.status, 200, JSON.stringify(narrowed.body));
			deepStrictEqual(narrowed.body, [{ id: EMP.id, payload: { dept: { id: DEPT.id, name: DEPT.name } } }]);

			const json = await rest('empOnly', `/Emp/${EMP.id}?select(id,payload{dept})`);
			strictEqual(json.status, 200, JSON.stringify(json.body));
			strictEqual(json.body.payload?.dept, undefined, JSON.stringify(json.body));
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
