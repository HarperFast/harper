const assert = require('node:assert');
const alasql = require('alasql');
const { setupTestDBPath } = require('../testUtils.js');
const { table } = require('#src/resources/databases');
const { verifyPermsAST } = require('#src/utility/operation_authorization');
const { sqlSelect } = require('#src/dataLayer/search');
const { relatedRecordData } = require('#src/resources/Table');
const { physicalIndexScan } = require('#src/sqlEngine/physical/PhysicalIndexScan');
const { physicalIndexNestedLoopJoin } = require('#src/sqlEngine/physical/PhysicalIndexNestedLoopJoin');
const { getWorkerIndex, setMainIsWorker } = require('#js/server/threads/manageThreads');
require('#src/server/serverHelpers/serverUtilities');

const DATABASE = 'sql_relationship_read';
const READ = { read: true, insert: false, update: false, delete: false, attribute_permissions: [] };
const DEPT_RESTRICTED = {
	...READ,
	attribute_permissions: [
		{ attribute_name: 'id', read: true, insert: false, update: false },
		{ attribute_name: 'name', read: true, insert: false, update: false },
		{ attribute_name: 'secret', read: false, insert: false, update: false },
	],
};
const DEPT = { id: 'd1', name: 'Eng', secret: 'hidden' };

function userWith(name, tables) {
	return {
		username: name,
		role: { id: name, role: name, __updatedtime__: 1, permission: { super_user: false, [DATABASE]: { tables } } },
	};
}
const users = {
	restricted: () => userWith('sql-rel-restricted', { Emp: READ, Dept: DEPT_RESTRICTED }),
	empOnly: () => userWith('sql-rel-emp-only', { Emp: READ }),
	writeOnly: () =>
		userWith('sql-rel-write-only', { Emp: { ...READ, read: false, update: true }, Dept: DEPT_RESTRICTED }),
	writeOnlyNoDept: () => userWith('sql-rel-write-only-no-dept', { Emp: { ...READ, read: false, update: true } }),
	full: () => userWith('sql-rel-full', { Emp: READ, Dept: READ }),
	super: () => ({ username: 'sql-rel-super', role: { role: 'super', permission: { super_user: true } } }),
};

function plain(value) {
	return JSON.parse(JSON.stringify(value));
}
function parse(sql) {
	return alasql.parse(sql).statements[0];
}
async function rows(iterable) {
	const out = [];
	for await (const row of iterable) out.push(plain(row));
	return out;
}

describe('SQL reads of relationship columns apply the related table permissions', function () {
	this.timeout(15000);
	let Emp, Dept, priorSchema, priorMainIsWorker;
	before(async () => {
		priorSchema = global.hdb_schema;
		priorMainIsWorker = getWorkerIndex() === 0;
		setupTestDBPath();
		setMainIsWorker(true);
		Dept = table({
			database: DATABASE,
			table: 'Dept',
			attributes: [{ name: 'id', isPrimaryKey: true }, { name: 'name' }, { name: 'secret' }],
		});
		Emp = table({
			database: DATABASE,
			table: 'Emp',
			attributes: [
				{ name: 'id', isPrimaryKey: true },
				{ name: 'deptId', indexed: true },
				{ name: 'payload' },
				{ name: 'dept', relationship: { from: 'deptId' }, definition: { tableClass: Dept } },
			],
		});
		await Dept.put(DEPT);
		await Emp.put({ id: 'e1', deptId: 'd1' });
		await Emp.put({ id: 'e2', deptId: 'd1' });
		global.hdb_schema = {
			[DATABASE]: Object.fromEntries(
				[Emp, Dept].map((Table) => [
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
	});
	after(() => {
		global.hdb_schema = priorSchema;
		if (priorMainIsWorker !== undefined) setMainIsWorker(priorMainIsWorker);
	});

	describe('Table._authorizeSelectedRelationships', () => {
		it('returns the select itself when there is nothing to narrow', () => {
			const select = ['id', 'dept'];
			assert.strictEqual(Emp._authorizeSelectedRelationships(select, users.super()), select);
			assert.strictEqual(Emp._authorizeSelectedRelationships(select, undefined), select);
			const scalars = ['id', 'deptId'];
			assert.strictEqual(Emp._authorizeSelectedRelationships(scalars, users.restricted()), scalars);
			const deptSelect = ['id', 'name'];
			assert.strictEqual(Dept._authorizeSelectedRelationships(deptSelect, users.restricted()), deptSelect);
		});

		it('narrows a relationship to the readable related attributes without changing the input or the role', () => {
			const user = users.restricted();
			const permission = plain(user.role.permission);
			const select = ['id', 'dept'];
			const first = Emp._authorizeSelectedRelationships(select, user);
			assert.notStrictEqual(first, select);
			assert.deepStrictEqual(select, ['id', 'dept']);
			assert.strictEqual(first[0], 'id');
			assert.strictEqual(first[1].name, 'dept');
			assert.deepStrictEqual([...first[1].select].sort(), ['id', 'name']);
			const second = Emp._authorizeSelectedRelationships(select, user);
			assert.notStrictEqual(second[1], first[1], 'each call authorizes its own selection object');
			assert.deepStrictEqual(plain(user.role.permission), permission);
		});

		it('refuses a relationship whose related table the user cannot read', () => {
			assert.throws(
				() => Emp._authorizeSelectedRelationships(['id', 'dept'], users.empOnly()),
				(error) => error.statusCode === 403
			);
		});
	});

	describe('verifyPermsAST', () => {
		const refusesDept = (response) => {
			assert.ok(response, 'expected a refusal');
			assert.deepStrictEqual(response.invalid_schema_items, [`Table '${DATABASE}.Dept' does not exist`]);
		};

		for (const sql of [
			`SELECT id, dept FROM ${DATABASE}.Emp WHERE id = 'e1'`,
			`SELECT id, dept AS d FROM ${DATABASE}.Emp WHERE id = 'e1'`,
			`SELECT COUNT(dept) AS n FROM ${DATABASE}.Emp`,
			`SELECT id FROM ${DATABASE}.Emp WHERE dept IS NOT NULL ORDER BY dept`,
			`SELECT e.id FROM ${DATABASE}.Emp e JOIN ${DATABASE}.Emp f ON e.id = f.id WHERE f.dept IS NULL`,
		]) {
			it(`refuses a read of an unreadable relationship: ${sql}`, () => {
				refusesDept(verifyPermsAST(parse(sql), users.empOnly(), 'select'));
				assert.strictEqual(verifyPermsAST(parse(sql), users.restricted(), 'select'), null);
			});
		}

		it('names no related table behind a relationship attribute the role cannot see', () => {
			const user = userWith('sql-rel-id-only', {
				Emp: { ...READ, attribute_permissions: [{ attribute_name: 'id', read: true, insert: false, update: false }] },
			});
			const response = verifyPermsAST(parse(`SELECT id, dept FROM ${DATABASE}.Emp WHERE id = 'e1'`), user, 'select');
			assert.ok(response);
			assert.ok(!JSON.stringify(response).includes('Dept'), JSON.stringify(response));
		});

		it('checks member access through a relationship as a path from the related table', () => {
			const member = (expression) => parse(`SELECT id, ${expression} AS m FROM ${DATABASE}.Emp WHERE id = 'e1'`);
			assert.strictEqual(verifyPermsAST(member('dept->name'), users.restricted(), 'select'), null);
			const secret = verifyPermsAST(member('dept->secret'), users.restricted(), 'select');
			assert.deepStrictEqual(secret?.invalid_schema_items, [`Attribute 'secret' does not exist on '${DATABASE}.Dept'`]);
			assert.strictEqual(verifyPermsAST(member('dept->secret'), users.full(), 'select'), null);
			assert.ok(verifyPermsAST(member('dept!secret'), users.restricted(), 'select'));
			for (const expression of ['(dept)->name', 'COALESCE(dept, 1)->name', "dept->('na' + 'me')"]) {
				assert.strictEqual(verifyPermsAST(member(expression), users.full(), 'select'), null, expression);
				const write = parse(`UPDATE ${DATABASE}.Emp SET payload = 'x' WHERE id = 'e1' AND ${expression} IS NULL`);
				const response = verifyPermsAST(write, users.writeOnly(), 'update');
				assert.ok(String(response?.unauthorized_access).includes('without naming the path'), expression);
			}
			assert.strictEqual(verifyPermsAST(member('payload->dept'), users.restricted(), 'select'), null);
			const joined = parse(
				`SELECT e.payload->dept AS m FROM ${DATABASE}.Emp e JOIN ${DATABASE}.Dept d ON e.deptId = d.id WHERE e.id = 'e1'`
			);
			assert.strictEqual(verifyPermsAST(joined, users.full(), 'select'), null);
			const hidden = userWith('sql-rel-hidden-dept', {
				Emp: { ...READ, attribute_permissions: [{ attribute_name: 'id', read: true, insert: false, update: false }] },
			});
			const hiddenResponse = verifyPermsAST(member('(dept)->name'), hidden, 'select');
			assert.ok(!JSON.stringify(hiddenResponse).includes('without naming the path'), JSON.stringify(hiddenResponse));
			const write = parse(`UPDATE ${DATABASE}.Emp SET payload = 'x' WHERE id = 'e1' AND dept->secret = 'hidden'`);
			assert.ok(verifyPermsAST(write, users.writeOnly(), 'update'));
		});

		it('names a related table the role can describe but not read as unauthorized', () => {
			const user = userWith('sql-rel-dept-writer', { Emp: READ, Dept: { ...READ, read: false, insert: true } });
			const response = verifyPermsAST(parse(`SELECT id, dept FROM ${DATABASE}.Emp`), user, 'select');
			assert.ok(response);
			assert.deepStrictEqual(response.invalid_schema_items, []);
			assert.deepStrictEqual(
				plain(response.unauthorized_access).map(({ table, required_table_permissions }) => ({
					table,
					required_table_permissions,
				})),
				[{ table: 'Dept', required_table_permissions: ['read'] }]
			);
		});

		it('leaves an unreadable relationship out of *', () => {
			const ast = parse(`SELECT * FROM ${DATABASE}.Emp WHERE id = 'e1'`);
			assert.strictEqual(verifyPermsAST(ast, users.empOnly(), 'select'), null);
			assert.deepStrictEqual(ast.columns.map((column) => column.columnid).sort(), ['deptId', 'id', 'payload']);
			const restrictedAst = parse(`SELECT * FROM ${DATABASE}.Emp WHERE id = 'e1'`);
			assert.strictEqual(verifyPermsAST(restrictedAst, users.restricted(), 'select'), null);
			assert.deepStrictEqual(restrictedAst.columns.map((column) => column.columnid).sort(), [
				'dept',
				'deptId',
				'id',
				'payload',
			]);
		});

		it('checks the related table of a write statement read even when the role cannot read the root', () => {
			for (const sql of [
				`UPDATE ${DATABASE}.Emp SET payload = dept WHERE id = 'e1'`,
				`UPDATE ${DATABASE}.Emp SET payload = 'x' WHERE id = 'e1' AND dept IS NOT NULL`,
			]) {
				refusesDept(verifyPermsAST(parse(sql), users.writeOnlyNoDept(), 'update'));
				assert.strictEqual(verifyPermsAST(parse(sql), users.writeOnly(), 'update'), null, sql);
			}
			assert.strictEqual(
				verifyPermsAST(
					parse(`UPDATE ${DATABASE}.Emp SET payload = 'x' WHERE id = 'e1'`),
					users.writeOnlyNoDept(),
					'update'
				),
				null
			);
		});
	});

	describe('a schema-loaded @enumerable closure', () => {
		const SQUAD = { id: 's1', name: 'Core', lockerId: 'l1' };
		const LOCKER = { id: 'l1', code: 'locker-code', squadId: 's1' };
		const memberUser = (name, Locker) => userWith(name, { Member: READ, Squad: READ, ...(Locker ? { Locker } : {}) });
		let Member;
		before(async () => {
			let Locker;
			const Squad = table({
				database: DATABASE,
				table: 'Squad',
				attributes: [
					{ name: 'id', isPrimaryKey: true },
					{ name: 'name' },
					{ name: 'lockerId' },
					{
						name: 'locker',
						relationship: { from: 'lockerId' },
						enumerable: true,
						definition: {
							get tableClass() {
								return Locker;
							},
						},
					},
					{
						name: 'members',
						relationship: { to: 'squadId' },
						elements: {
							definition: {
								get tableClass() {
									return Member;
								},
							},
						},
					},
				],
			});
			Locker = table({
				database: DATABASE,
				table: 'Locker',
				attributes: [
					{ name: 'id', isPrimaryKey: true },
					{ name: 'code' },
					{ name: 'squadId' },
					{ name: 'squad', relationship: { from: 'squadId' }, enumerable: true, definition: { tableClass: Squad } },
				],
			});
			Member = table({
				database: DATABASE,
				table: 'Member',
				attributes: [
					{ name: 'id', isPrimaryKey: true },
					{ name: 'squadId', indexed: true },
					{ name: 'squad', relationship: { from: 'squadId' }, definition: { tableClass: Squad } },
				],
			});
			for (const Table of [Squad, Locker, Member])
				global.hdb_schema[DATABASE][Table.tableName] = {
					name: Table.tableName,
					schema: DATABASE,
					hash_attribute: 'id',
					attributes: Table.attributes.map((attribute) => ({ attribute: attribute.name })),
				};
			await Squad.put(SQUAD);
			await Locker.put(LOCKER);
			await Member.put({ id: 'm1', squadId: 's1' });
		});

		async function squadRead(user) {
			const scan = {
				kind: 'Scan',
				boundTable: { resource: Member, attributes: Member.attributes },
				projection: ['id', 'squad'],
			};
			const op = physicalIndexScan(scan, {
				conditions: [{ attribute: 'id', comparator: 'equals', value: 'm1' }],
				operator: 'and',
			});
			const [row] = await rows(op.execute({ user }));
			return row.squad;
		}

		it('leaves out an @enumerable relationship to an unreadable table at every level', async () => {
			assert.deepStrictEqual(await squadRead(memberUser('sql-rel-no-locker')), SQUAD);
		});

		it('narrows an @enumerable relationship to the readable related attributes', async () => {
			const restricted = {
				...READ,
				attribute_permissions: [
					{ attribute_name: 'id', read: true, insert: false, update: false },
					{ attribute_name: 'squadId', read: true, insert: false, update: false },
					{ attribute_name: 'code', read: false, insert: false, update: false },
				],
			};
			assert.deepStrictEqual(await squadRead(memberUser('sql-rel-locker-restricted', restricted)), {
				...SQUAD,
				locker: { id: LOCKER.id, squadId: LOCKER.squadId },
			});
		});

		it('drops only the index into a to-many value from a member path', () => {
			const user = memberUser('sql-rel-member-paths');
			const member = (expression) =>
				verifyPermsAST(parse(`SELECT ${expression} AS m FROM ${DATABASE}.Member WHERE id = 'm1'`), user, 'select');
			assert.strictEqual(member('squad->members->0->id'), null);
			assert.strictEqual(member('squad->members->`0`->id'), null);
			const write = (expression) =>
				verifyPermsAST(
					parse(`UPDATE ${DATABASE}.Member SET squadId = 's1' WHERE id = 'm1' AND ${expression} IS NULL`),
					userWith('sql-rel-member-writer', { Member: { ...READ, update: true }, Squad: READ }),
					'update'
				);
			for (const expression of ['squad->members->`1e0`->squad', 'squad->members->`1.0`->squad'])
				assert.ok(String(write(expression)?.unauthorized_access).includes('without naming the path'), expression);
			for (const expression of ['squad->members->0->squad->locker->code', 'squad->members->`0`->squad->locker'])
				assert.deepStrictEqual(
					member(expression)?.invalid_schema_items,
					[`Table '${DATABASE}.Locker' does not exist`],
					expression
				);
		});

		it('walks a deeply nested member expression in linear time', () => {
			let expression = 'payload';
			for (let depth = 0; depth < 2000; depth++) expression = `(${expression})->x`;
			const ast = parse(`SELECT squad, ${expression} AS m FROM ${DATABASE}.Member WHERE id = 'm1'`);
			const start = performance.now();
			assert.strictEqual(
				verifyPermsAST(ast, memberUser('sql-rel-deep'), 'select')?.invalid_schema_items?.length ?? 0,
				0
			);
			assert.ok(performance.now() - start < 500, `${performance.now() - start} ms`);
		});

		it('hands legacy SQL a related record as data, with no relationship left to resolve', async () => {
			const select = (user) =>
				new Promise((resolve, reject) =>
					sqlSelect(
						{
							statement: parse(
								`SELECT id, squad->locker->code AS c, squad->members AS m, squad->name AS n FROM ${DATABASE}.Member WHERE id = 'm1'`
							),
							hdb_user: user,
						},
						(error, data) => (error ? reject(error) : resolve(plain(data)))
					)
				);
			// the @enumerable locker is part of what Squad serializes to; the plain members relationship is not
			assert.deepStrictEqual(await select(memberUser('sql-rel-data-reader', READ)), [
				{ id: 'm1', c: LOCKER.code, n: SQUAD.name },
			]);
			assert.deepStrictEqual(await select(memberUser('sql-rel-data-no-locker')), [{ id: 'm1', n: SQUAD.name }]);
		});

		it('returns the whole cyclic closure to a role that can read all of it', async () => {
			const squad = await squadRead(memberUser('sql-rel-locker-reader', READ));
			assert.strictEqual(squad.locker.code, LOCKER.code, JSON.stringify(squad));
		});
	});

	describe('relatedRecordData', () => {
		it('copies a related record to plain data and keeps native values', async () => {
			const user = users.full();
			let related;
			for await (const row of Emp.search(
				{ conditions: [{ attribute: 'id', value: 'e1' }], select: Emp._authorizeSelectedRelationships(['dept'], user) },
				{ user }
			))
				related = row.dept;
			const data = relatedRecordData(related);
			assert.strictEqual(Object.getPrototypeOf(data), Object.prototype);
			assert.deepStrictEqual(data, DEPT);
			const when = new Date(0);
			const bytes = Buffer.from('x');
			const nested = relatedRecordData([{ when, bytes, list: [related] }]);
			assert.strictEqual(nested[0].when, when);
			assert.strictEqual(nested[0].bytes, bytes);
			assert.deepStrictEqual(nested[0].list, [DEPT]);
			const keyed = relatedRecordData(JSON.parse('{"__proto__": {"polluted": true}}'));
			assert.strictEqual(Object.getPrototypeOf(keyed), Object.prototype);
			assert.deepStrictEqual(Object.keys(keyed), ['__proto__']);
		});
	});

	describe('engine reads carry the caller', () => {
		it('legacy SQL narrows the related record and keeps a refusal a 403', async () => {
			const select = (user) =>
				new Promise((resolve, reject) =>
					sqlSelect(
						{ statement: parse(`SELECT id, dept FROM ${DATABASE}.Emp WHERE id = 'e1'`), hdb_user: user },
						(error, data) => (error ? reject(error) : resolve(plain(data)))
					)
				);
			assert.deepStrictEqual(await select(users.restricted()), [{ id: 'e1', dept: { id: 'd1', name: 'Eng' } }]);
			assert.deepStrictEqual(await select(users.full()), [{ id: 'e1', dept: DEPT }]);
			await assert.rejects(select(users.empOnly()), (error) => error.statusCode === 403);
		});

		it('a v2 index scan narrows its relationship projection', async () => {
			const projection = ['dept', 'id'];
			const scan = { kind: 'Scan', boundTable: { resource: Emp, attributes: Emp.attributes }, projection };
			const op = physicalIndexScan(scan, {
				conditions: [{ attribute: 'id', comparator: 'equals', value: 'e1' }],
				operator: 'and',
			});
			assert.deepStrictEqual(await rows(op.execute({ user: users.restricted() })), [
				{ dept: { id: 'd1', name: 'Eng' }, id: 'e1' },
			]);
			assert.deepStrictEqual(await rows(op.execute({ user: users.full() })), [{ dept: DEPT, id: 'e1' }]);
			assert.deepStrictEqual(projection, ['dept', 'id']);
			await assert.rejects(rows(op.execute({ user: users.empOnly() })), (error) => error.statusCode === 403);
		});

		it('a v2 index join narrows its inner relationship projection on every probe', async () => {
			const innerSelect = ['dept', 'id'];
			const left = {
				schema: [],
				async *execute() {
					yield { 'o.empId': 'e1' };
					yield { 'o.empId': 'e2' };
				},
			};
			const op = physicalIndexNestedLoopJoin(left, {
				innerResource: Emp,
				innerAlias: 'e',
				innerAttribute: 'id',
				outerKey: { kind: 'column', table: 'o', name: 'empId' },
				innerBaseConditions: [],
				innerOperator: 'and',
				innerSelect,
				type: 'inner',
				rightNullKeys: [],
			});
			const narrowed = { id: 'd1', name: 'Eng' };
			assert.deepStrictEqual(await rows(op.execute({ user: users.restricted() })), [
				{ 'o.empId': 'e1', 'e.dept': narrowed, 'e.id': 'e1' },
				{ 'o.empId': 'e2', 'e.dept': narrowed, 'e.id': 'e2' },
			]);
			assert.deepStrictEqual(innerSelect, ['dept', 'id']);
			await assert.rejects(rows(op.execute({ user: users.empOnly() })), (error) => error.statusCode === 403);
		});
	});
});
