const assert = require('node:assert');
const { createServer } = require('node:http');
const { setupTestDBPath } = require('../testUtils.js');
const { table } = require('#src/resources/databases');
const { Resources } = require('#src/resources/Resources');
const { RequestTarget } = require('#src/resources/RequestTarget');
const { ResourceBridge } = require('#src/dataLayer/harperBridge/ResourceBridge');
const { verifyPerms } = require('#src/utility/operation_authorization');
const { handleApplication } = require('#src/server/REST');
const { Request } = require('#src/server/serverHelpers/Request');
const { getWorkerIndex, setMainIsWorker } = require('#js/server/threads/manageThreads');
require('#src/server/serverHelpers/serverUtilities');

const DATABASE = 'selection_read_permissions';
const READ = { read: true, insert: false, update: false, delete: false, attribute_permissions: [] };
const restricted = {
	username: 'selection-reader',
	role: {
		id: 'selection-reader',
		role: 'selection-reader',
		__updatedtime__: 1,
		permission: {
			[DATABASE]: {
				tables: {
					Emp: READ,
					Dept: {
						...READ,
						attribute_permissions: [
							{ attribute_name: 'id', read: true },
							{ attribute_name: 'name', read: true },
							{ attribute_name: 'secret', read: false, insert: true },
							{ attribute_name: 'orgId', read: true },
						],
					},
				},
			},
		},
	},
};
const condition = (attribute = 'secret') => ({ attribute, comparator: 'equals', value: 'hidden' });
const selection = (conditions) => ({ name: 'dept', select: ['name'], conditions });

function plain(value) {
	return JSON.parse(JSON.stringify(value));
}

describe('Read permission admission for nested selections and scalar properties', function () {
	this.timeout(15000);
	let Emp, Dept, Org, server, base, priorSchema, priorMainIsWorker;
	before(async () => {
		priorSchema = global.hdb_schema;
		priorMainIsWorker = getWorkerIndex() === 0;
		setupTestDBPath();
		setMainIsWorker(true);
		Org = table({
			database: DATABASE,
			table: 'Org',
			attributes: [{ name: 'id', isPrimaryKey: true }, { name: 'name' }, { name: 'secret' }],
		});
		restricted.role.permission[DATABASE].tables.Org = restricted.role.permission[DATABASE].tables.Dept;
		Dept = table({
			database: DATABASE,
			table: 'Dept',
			attributes: [
				{ name: 'id', isPrimaryKey: true },
				{ name: 'name' },
				{ name: 'secret' },
				{ name: 'orgId' },
				{ name: 'org', relationship: { from: 'orgId' }, definition: { tableClass: Org } },
			],
		});
		Emp = table({
			database: DATABASE,
			table: 'Emp',
			attributes: [
				{ name: 'id', isPrimaryKey: true },
				{ name: 'deptId' },
				{ name: 'reader', computed: true },
				{ name: 'dept', relationship: { from: 'deptId' }, definition: { tableClass: Dept } },
			],
		});
		Emp.setComputedAttribute('reader', (_record, context) => context?.user?.username ?? null);
		await Org.put({ id: 'o1', name: 'Org', secret: 'hidden' });
		await Dept.put({ id: 'd1', name: 'Eng', secret: 'hidden', orgId: 'o1' });
		await Emp.put({ id: 'e1', deptId: 'd1' });
		global.hdb_schema = {
			[DATABASE]: Object.fromEntries(
				[Emp, Dept, Org].map((Table) => [
					Table.tableName,
					{
						name: Table.tableName,
						schema: DATABASE,
						hash_attribute: 'id',
						attributes: Table.attributes.map((attribute) => ({ attribute: attribute.name })),
					},
				])
			),
		};
		const resources = new Resources();
		resources.set('Emp', Emp);
		resources.set('Dept', Dept);
		resources.set('Org', Org);
		let rest;
		handleApplication({
			resources,
			options: { getAll: () => ({ webSocket: false }) },
			routeFor: () => ({ urlPath: '/selection-permissions' }),
			server: { http: (handler) => (rest = handler), ws: () => [] },
		});
		server = createServer(async (input, output) => {
			try {
				const request = new Request(input, output);
				request.user = restricted;
				const response = await rest(request, () => ({ status: 404, headers: new Map(), body: 'not found' }));
				output.writeHead(response.status, Object.fromEntries(response.headers));
				if (typeof response.body === 'string' || Buffer.isBuffer(response.body)) output.end(response.body);
				else {
					for await (const chunk of response.body || []) output.write(chunk);
					output.end();
				}
			} catch (error) {
				output.writeHead(error.statusCode || 500);
				output.end(error.message);
			}
		});
		await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
		base = `http://127.0.0.1:${server.address().port}`;
	});
	after(async () => {
		if (server) await new Promise((resolve) => server.close(resolve));
		global.hdb_schema = priorSchema;
		if (priorMainIsWorker !== undefined) setMainIsWorker(priorMainIsWorker);
	});

	for (const conditions of [
		[condition()],
		[{ operator: 'or', conditions: [condition('name'), { operator: 'and', conditions: [condition()] }] }],
		[['secret', 'hidden']],
		[condition(['org', 'secret'])],
	]) {
		it(`rejects unreadable nested predicates at admission: ${JSON.stringify(conditions)}`, () => {
			const target = {
				select: ['id', { ...selection(conditions), checkPermission: { super_user: true } }],
				checkPermission: true,
			};
			assert.throws(
				() => new Emp(undefined, { user: restricted }).allowRead(restricted, target, { user: restricted }),
				(error) => error.statusCode === 403
			);
		});
	}

	it('checks nested predicates even when the parent record is missing', async () => {
		const target = new RequestTarget('/missing');
		target.id = 'missing';
		target.select = [selection([condition()])];
		target.checkPermission = true;
		await assert.rejects(
			async () => Emp.get(target, { user: restricted }),
			(error) => error.statusCode === 403
		);
	});

	it('defaults an omitted nested predicate attribute to the related primary key', async () => {
		const target = { select: ['id', selection([{ value: 'd1' }])], checkPermission: true };
		assert.ok(new Emp(undefined, { user: restricted }).allowRead(restricted, target, { user: restricted }));
		const rows = [];
		for await (const row of Emp.search(target, { user: restricted })) rows.push(plain(row));
		assert.deepStrictEqual(rows, [{ id: 'e1', dept: { name: 'Eng' } }]);
	});

	it('operations checks conditions relative to each selected relationship level', () => {
		for (const nested of [
			selection([condition(['org', 'secret'])]),
			{ name: 'dept', select: [{ name: 'org', select: ['name'], conditions: [['secret', 'hidden']] }] },
		]) {
			const response = verifyPerms(
				{ schema: DATABASE, table: 'Emp', hdb_user: plain(restricted), get_attributes: [nested] },
				'searchByHash'
			);
			assert.ok(response, 'nested Org predicate must be refused');
			assert.ok(response.unauthorized_access.length > 0, JSON.stringify(response));
			assert.strictEqual(response.unauthorized_access[0].table, 'Org', JSON.stringify(response));
		}
	});

	for (const tableAccess of ['missing', 'write-only']) {
		it(`denies nested predicates when related-table read is ${tableAccess}`, () => {
			const user = plain(restricted);
			if (tableAccess === 'missing') delete user.role.permission[DATABASE].tables.Dept;
			else user.role.permission[DATABASE].tables.Dept = { ...READ, read: false, insert: true };
			const target = { select: [selection([{ attribute: 'name', value: 'Eng' }])], checkPermission: true };
			assert.throws(
				() => new Emp(undefined, { user }).allowRead(user, target, { user }),
				(error) => error.statusCode === 403
			);
		});
	}

	for (const attributeKey of ['attribute', 'search_attribute']) {
		for (const grouped of [false, true]) {
			it(`operations checks the actual ${grouped ? 'grouped' : 'flat'} ${attributeKey} despite numeric metadata`, () => {
				const leaf = { 0: 'id', [attributeKey]: ['dept', 'secret'], comparator: 'equals', value: 'hidden' };
				const conditions = grouped
					? [{ operator: 'and', conditions: [{ attribute: 'id', value: 'e1' }, leaf] }]
					: [leaf];
				const response = verifyPerms(
					{ schema: DATABASE, table: 'Emp', hdb_user: plain(restricted), get_attributes: ['id'], conditions },
					'searchByConditions'
				);
				assert.ok(response, 'numeric metadata must not mask the executed predicate attribute');
				assert.ok(
					response.unauthorized_access.some((entry) => entry.table === 'Dept'),
					JSON.stringify(response)
				);
			});
		}
	}

	it('operations ignores numeric metadata when the executed attribute is readable', () => {
		const response = verifyPerms(
			{
				schema: DATABASE,
				table: 'Emp',
				hdb_user: plain(restricted),
				get_attributes: ['id'],
				conditions: [{ 0: ['dept', 'secret'], attribute: 'id', value: 'e1' }],
			},
			'searchByConditions'
		);
		assert.strictEqual(response, null);
	});

	for (const method of ['searchByConditions', 'searchByHash', 'searchByValue']) {
		for (const key of ['attribute', 'search_attribute']) {
			it(`${method} refuses a nested ${key} before execution`, () => {
				const request = {
					schema: DATABASE,
					table: 'Emp',
					hdb_user: plain(restricted),
					get_attributes: [
						selection([{ operator: 'or', conditions: [{ [key]: 'secret', value: 'hidden' }, condition('name')] }]),
					],
					conditions: [{ attribute: 'id', value: 'e1' }],
					hash_values: ['e1'],
					search_attribute: 'id',
					search_value: 'e1',
				};
				const response = verifyPerms(request, method);
				assert.ok(response, 'denied predicate must fail permission admission');
				assert.deepStrictEqual(response.invalid_schema_items, []);
				const denial = response.unauthorized_access.find((entry) => entry.table === 'Dept');
				assert.ok(denial, JSON.stringify(response));
				assert.deepStrictEqual(plain(denial.required_attribute_permissions), [
					{ attribute_name: 'secret', required_permissions: ['read'] },
				]);
			});
		}
	}

	it('normalizes nested operation aliases recursively', () => {
		const request = {
			schema: DATABASE,
			table: 'Emp',
			hdb_user: plain(restricted),
			get_attributes: [selection([{ operator: 'and', conditions: [{ search_attribute: 'name', value: 'Eng' }] }])],
			conditions: [{ attribute: 'id', value: 'e1' }],
		};
		assert.strictEqual(verifyPerms(request, 'searchByConditions'), null);
		assert.deepStrictEqual(request.get_attributes[0].conditions[0].conditions, [{ attribute: 'name', value: 'Eng' }]);
	});

	it('preserves describe concealment for a denied nested predicate', () => {
		const user = plain(restricted);
		user.role.id = user.role.role = 'selection-hidden';
		user.role.permission[DATABASE].tables.Dept.attribute_permissions[2].insert = false;
		user.role.permission[DATABASE].tables.Dept.attribute_permissions[2].describe = false;
		const response = verifyPerms(
			{ schema: DATABASE, table: 'Emp', hdb_user: user, get_attributes: [selection([condition()])] },
			'searchByHash'
		);
		assert.ok(response, 'denied predicate must fail permission admission');
		assert.deepStrictEqual(
			response.invalid_schema_items,
			[`Attribute 'secret' does not exist on '${DATABASE}.Dept'`],
			JSON.stringify(response)
		);
	});

	it('REST denies nested conditions for collection and single-record reads', async () => {
		for (const id of ['', 'e1']) {
			const response = await fetch(`${base}/Emp/${id}?select(id,dept[secret=hidden&select(name,)])`);
			assert.strictEqual(response.status, 403, await response.text());
		}
	});

	it('REST denies an unreadable scalar property and returns a readable one', async () => {
		for (const [table, id, name] of [
			['Dept', 'd1', 'Eng'],
			['Org', 'o1', 'Org'],
		]) {
			const denied = await fetch(`${base}/${table}/${id}.secret`);
			assert.strictEqual(denied.status, 403, await denied.text());
			const allowed = await fetch(`${base}/${table}/${id}.name`);
			assert.strictEqual(allowed.status, 200, await allowed.clone().text());
			assert.strictEqual(await allowed.json(), name);
		}
	});

	it('checks property permission before caller projections in both record modes', async () => {
		for (const [Table, id] of [
			[Dept, 'd1'],
			[Org, 'o1'],
		]) {
			const original = Table.loadAsInstance;
			try {
				for (const mode of [original, false]) {
					Table.loadAsInstance = mode;
					await assert.rejects(
						async () =>
							Table.get({ id, property: 'secret', select: ['name'], checkPermission: true }, { user: restricted }),
						(error) => error.statusCode === 403
					);
					const result = await Table.get(
						{ id, property: 'name', select: ['secret'], checkPermission: true },
						{ user: restricted }
					);
					if (mode === false) assert.ok(!JSON.stringify(result ?? null).includes('hidden'));
					else assert.strictEqual(result, Table === Dept ? 'Eng' : 'Org');
				}
			} finally {
				Table.loadAsInstance = original;
			}
		}
	});

	it('keeps permitted nested predicates working through REST', async () => {
		const response = await fetch(`${base}/Emp/?select(id,dept[name=Eng&select(name,)])`);
		assert.strictEqual(response.status, 200, await response.clone().text());
		assert.deepStrictEqual(await response.json(), [{ id: 'e1', dept: { name: 'Eng' } }]);
	});

	it('value search carries the same computed-attribute principal as condition search', async () => {
		const bridge = new ResourceBridge();
		for (const method of ['searchByConditions', 'searchByValue']) {
			const results = await bridge[method]({
				schema: DATABASE,
				table: 'Emp',
				attribute: 'id',
				value: 'e1',
				conditions: [{ attribute: 'id', value: 'e1' }],
				hash_values: ['e1'],
				get_attributes: ['reader'],
				hdb_user: restricted,
			});
			const rows = [];
			for await (const row of results) rows.push(plain(row));
			assert.deepStrictEqual(rows, [{ reader: restricted.username }], method);
		}
	});
});
