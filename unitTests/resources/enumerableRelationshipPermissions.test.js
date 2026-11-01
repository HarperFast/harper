require('../testUtils');
const assert = require('assert');
const { setupTestDBPath } = require('../testUtils');
const { table } = require('#src/resources/databases');
const { RequestTarget } = require('#src/resources/RequestTarget');
const { setMainIsWorker } = require('#js/server/threads/manageThreads');
const { toCsvStream } = require('#src/server/serverHelpers/contentTypes');
const { verifyPerms } = require('#src/utility/operation_authorization');

const DATABASE = 'enumPerms';
const READ = { read: true, insert: false, update: false, delete: false, attribute_permissions: [] };
const roleWith = (tables) => ({ role: { permission: { [DATABASE]: { tables } } } });
const readOnly = (...names) => ({
	...READ,
	attribute_permissions: names.map((attribute_name) => ({ attribute_name, read: true, insert: false, update: false })),
});

describe('Default reads authorize @enumerable relationships against the related table', () => {
	let EnumOrg, EnumDept, EnumEmp, EnumAuthor, EnumBook, EnumPublisher;
	before(async () => {
		setupTestDBPath();
		setMainIsWorker(true);
		EnumOrg = table({
			table: 'EnumOrg',
			database: DATABASE,
			attributes: [{ name: 'id', isPrimaryKey: true }, { name: 'name' }],
		});
		EnumDept = table({
			table: 'EnumDept',
			database: DATABASE,
			attributes: [
				{ name: 'id', isPrimaryKey: true },
				{ name: 'name' },
				{ name: 'budget' },
				{ name: 'orgId' },
				{ name: 'org', relationship: { from: 'orgId' }, definition: { tableClass: EnumOrg }, enumerable: true },
			],
		});
		EnumEmp = table({
			table: 'EnumEmp',
			database: DATABASE,
			attributes: [
				{ name: 'id', isPrimaryKey: true },
				{ name: 'name' },
				{ name: 'deptId' },
				{ name: 'dept', relationship: { from: 'deptId' }, definition: { tableClass: EnumDept }, enumerable: true },
			],
		});
		EnumPublisher = table({
			table: 'EnumPublisher',
			database: DATABASE,
			attributes: [{ name: 'id', isPrimaryKey: true }, { name: 'name' }],
		});
		const authorDefinition = {};
		const bookDefinition = {};
		EnumBook = table({
			table: 'EnumBook',
			database: DATABASE,
			attributes: [
				{ name: 'id', isPrimaryKey: true },
				{ name: 'title' },
				{ name: 'authorId', indexed: true },
				{ name: 'publisherId' },
				{ name: 'author', relationship: { from: 'authorId' }, definition: authorDefinition, enumerable: true },
				{
					name: 'publisher',
					relationship: { from: 'publisherId' },
					definition: { tableClass: EnumPublisher },
					enumerable: true,
				},
			],
		});
		bookDefinition.tableClass = EnumBook;
		EnumAuthor = table({
			table: 'EnumAuthor',
			database: DATABASE,
			attributes: [
				{ name: 'id', isPrimaryKey: true },
				{ name: 'name' },
				{
					name: 'books',
					type: 'array',
					relationship: { to: 'authorId' },
					elements: { definition: bookDefinition },
					enumerable: true,
				},
			],
		});
		authorDefinition.tableClass = EnumAuthor;
		await EnumOrg.put({ id: 'o1', name: 'Org' });
		await EnumDept.put({ id: 'd1', name: 'Eng', budget: 100, orgId: 'o1' });
		await EnumEmp.put({ id: 'e1', name: 'Ann', deptId: 'd1', extra: 'x' });
		await EnumPublisher.put({ id: 'p1', name: 'Press' });
		await EnumAuthor.put({ id: 'a1', name: 'Ada' });
		await EnumBook.put({ id: 'b1', title: 'Notes', authorId: 'a1', publisherId: 'p1' });
	});

	const plain = (value) => JSON.parse(JSON.stringify(value));
	async function getAs(Table, user, id, select, property) {
		const target = new RequestTarget('/' + id);
		target.id = id;
		if (select) target.select = select;
		if (property) target.property = property;
		target.checkPermission = true;
		return plain(await Table.get(target, { user }));
	}
	async function searchAs(Table, user, select) {
		const target = new RequestTarget('/');
		if (select) target.select = select;
		target.checkPermission = true;
		const results = [];
		for await (const result of Table.search(target, { user })) results.push(result);
		return plain(results);
	}
	const fullEmp = {
		id: 'e1',
		name: 'Ann',
		deptId: 'd1',
		extra: 'x',
		dept: { id: 'd1', name: 'Eng', budget: 100, orgId: 'o1', org: { id: 'o1', name: 'Org' } },
	};

	it('leaves out an enumerable relationship to a table the role cannot read', async () => {
		const user = roleWith({ EnumEmp: READ });
		const expected = { id: 'e1', name: 'Ann', deptId: 'd1', extra: 'x' };
		assert.deepStrictEqual(await getAs(EnumEmp, user, 'e1'), expected);
		assert.deepStrictEqual(await searchAs(EnumEmp, user), [expected]);
		assert.deepStrictEqual(await searchAs(EnumEmp, user, ['*']), [expected]);
		assert.deepStrictEqual(await getAs(EnumEmp, user, 'e1', ['*']), expected);
	});

	it('narrows an enumerable relationship to the related attributes the role can read', async () => {
		const user = roleWith({ EnumEmp: READ, EnumDept: readOnly('id', 'name') });
		const expected = { id: 'e1', name: 'Ann', deptId: 'd1', extra: 'x', dept: { id: 'd1', name: 'Eng' } };
		assert.deepStrictEqual(await getAs(EnumEmp, user, 'e1'), expected);
		assert.deepStrictEqual(await searchAs(EnumEmp, user), [expected]);
	});

	it("authorizes the related table's own enumerable relationships", async () => {
		const user = roleWith({ EnumEmp: READ, EnumDept: READ });
		const dept = { id: 'd1', name: 'Eng', budget: 100, orgId: 'o1' };
		assert.deepStrictEqual(await getAs(EnumEmp, user, 'e1'), { ...fullEmp, dept });
		assert.deepStrictEqual(await searchAs(EnumEmp, user, ['id', 'dept']), [{ id: 'e1', dept }]);
		assert.deepStrictEqual(await searchAs(EnumEmp, user, ['id', { name: 'dept', select: ['*'] }]), [
			{ id: 'e1', dept },
		]);
	});

	it('authorizes a relationship read as a property against the related table', async () => {
		await assert.rejects(getAs(EnumEmp, roleWith({ EnumEmp: READ }), 'e1', undefined, 'dept'), /Unauthorized access/);
		const restricted = roleWith({ EnumEmp: READ, EnumDept: readOnly('id', 'name') });
		assert.deepStrictEqual(await getAs(EnumEmp, restricted, 'e1', undefined, 'dept'), { id: 'd1', name: 'Eng' });
		assert.deepStrictEqual(await getAs(EnumEmp, restricted, 'e1', ['name', 'budget'], 'dept'), { name: 'Eng' });
		const byForeignKey = roleWith({ EnumEmp: readOnly('id', 'deptId'), EnumDept: readOnly('id', 'name') });
		assert.deepStrictEqual(await getAs(EnumEmp, byForeignKey, 'e1', undefined, 'dept'), { id: 'd1', name: 'Eng' });
		await assert.rejects(
			getAs(EnumEmp, roleWith({ EnumEmp: readOnly('id'), EnumDept: READ }), 'e1', undefined, 'dept'),
			/Unauthorized access/
		);
		const noOrg = roleWith({ EnumEmp: READ, EnumDept: READ });
		assert.deepStrictEqual(await getAs(EnumEmp, noOrg, 'e1', undefined, 'dept'), {
			id: 'd1',
			name: 'Eng',
			budget: 100,
			orgId: 'o1',
		});
		const readAll = roleWith({ EnumEmp: READ, EnumDept: READ, EnumOrg: READ });
		assert.deepStrictEqual(await getAs(EnumEmp, readAll, 'e1', undefined, 'dept'), fullEmp.dept);
	});

	it('returns default reads unchanged to roles that can read every related table', async () => {
		const user = roleWith({ EnumEmp: READ, EnumDept: READ, EnumOrg: READ });
		assert.deepStrictEqual(await getAs(EnumEmp, user, 'e1'), fullEmp);
		assert.deepStrictEqual(await searchAs(EnumEmp, user), [fullEmp]);
		assert.deepStrictEqual(await getAs(EnumEmp, { role: { permission: { super_user: true } } }, 'e1'), fullEmp);
	});

	it('stops a cyclic enumerable relationship at the key of the record it returns to', async () => {
		const book = { id: 'b1', title: 'Notes', authorId: 'a1', publisherId: 'p1' };
		const readAll = roleWith({ EnumAuthor: READ, EnumBook: READ, EnumPublisher: READ });
		assert.deepStrictEqual(await getAs(EnumAuthor, readAll, 'a1'), {
			id: 'a1',
			name: 'Ada',
			books: [{ ...book, author: { id: 'a1' }, publisher: { id: 'p1', name: 'Press' } }],
		});
		const noPublisher = roleWith({ EnumAuthor: READ, EnumBook: READ });
		const expected = { id: 'a1', name: 'Ada', books: [{ ...book, author: { id: 'a1' } }] };
		assert.deepStrictEqual(await getAs(EnumAuthor, noPublisher, 'a1'), expected);
		assert.deepStrictEqual(await searchAs(EnumAuthor, noPublisher), [expected]);
	});

	it('leaves out or narrows the relationship columns of a CSV default read', async () => {
		async function csvAs(user) {
			const target = new RequestTarget('/');
			target.checkPermission = true;
			const results = EnumEmp.search(target, { user });
			let csv = '';
			for await (const chunk of toCsvStream(results, results.getColumns())) csv += chunk;
			return csv;
		}
		assert.strictEqual(await csvAs(roleWith({ EnumEmp: READ })), '"id","name","deptId"\n"e1","Ann","d1"\n');
		assert.strictEqual(
			await csvAs(roleWith({ EnumEmp: READ, EnumDept: readOnly('id', 'name') })),
			'"id","name","deptId","dept"\n"e1","Ann","d1","{""id"":""d1"",""name"":""Eng""}"\n'
		);
	});

	function countingUser(tables, failAt) {
		const user = {
			lookups: 0,
			role: {
				permission: {
					get [DATABASE]() {
						if (++user.lookups === failAt) throw new Error('permission lookup failed');
						return { tables };
					},
				},
			},
		};
		return user;
	}

	it('checks a readable subgraph shared by sibling relationships once per read', async () => {
		const length = 10;
		let shared;
		for (let i = length; i >= 0; i--) {
			const attributes = [{ name: 'id', isPrimaryKey: true }];
			if (shared) {
				attributes.push({ name: 'nextId' });
				attributes.push({
					name: 'next',
					relationship: { from: 'nextId' },
					definition: { tableClass: shared },
					enumerable: true,
				});
			}
			shared = table({ table: 'EnumShared' + i, database: DATABASE, attributes });
		}
		const tables = {};
		for (let i = 0; i <= length; i++) tables['EnumShared' + i] = READ;
		const rootAttributes = [{ name: 'id', isPrimaryKey: true }];
		const siblings = 10;
		for (let b = 0; b < siblings; b++) {
			const sibling = table({
				table: 'EnumSibling' + b,
				database: DATABASE,
				attributes: [
					{ name: 'id', isPrimaryKey: true },
					{ name: 'sharedId' },
					{ name: 'shared', relationship: { from: 'sharedId' }, definition: { tableClass: shared }, enumerable: true },
				],
			});
			tables['EnumSibling' + b] = READ;
			rootAttributes.push({ name: 's' + b + 'Id' });
			rootAttributes.push({
				name: 's' + b,
				relationship: { from: 's' + b + 'Id' },
				definition: { tableClass: sibling },
				enumerable: true,
			});
		}
		rootAttributes.push({ name: 'deptId' });
		rootAttributes.push({
			name: 'dept',
			relationship: { from: 'deptId' },
			definition: { tableClass: EnumDept },
			enumerable: true,
		});
		const Root = table({ table: 'EnumSharedRoot', database: DATABASE, attributes: rootAttributes });
		tables.EnumSharedRoot = READ;
		const user = countingUser(tables);
		assert.deepStrictEqual(await searchAs(Root, user), []);
		const tableCount = length + 1 + siblings + 3;
		assert.ok(user.lookups <= 2 * tableCount, `${user.lookups} permission lookups for ${tableCount} tables`);
		const selection = ['id'];
		for (let b = 0; b < siblings; b++) selection.push('s' + b);
		const withoutLeaf = { ...tables };
		delete withoutLeaf['EnumShared' + length];
		for (const [permissions, failAt] of [
			[tables],
			[withoutLeaf],
			[tables, 15],
			[tables],
			[withoutLeaf, 15],
			[withoutLeaf],
		]) {
			const explicit = countingUser(permissions, failAt);
			if (failAt) await assert.rejects(searchAs(Root, explicit, selection));
			else {
				assert.deepStrictEqual(await searchAs(Root, explicit, selection), []);
				// a restricted sibling writes its own select over the shared chain, so the bound is the projection's size
				const bound = permissions === tables ? tableCount : tableCount + siblings * (length + 1);
				assert.ok(explicit.lookups <= 2 * bound, `${explicit.lookups} lookups selecting ${siblings} siblings`);
			}
		}
	});

	it('checks a readable cycle shared by selected sibling relationships once per read', async () => {
		const length = 10;
		const first = {};
		let next = first;
		const tables = {};
		for (let i = length; i >= 0; i--) {
			const name = 'EnumCycle' + i;
			next = table({
				table: name,
				database: DATABASE,
				attributes: [
					{ name: 'id', isPrimaryKey: true },
					{ name: 'nextId' },
					{
						name: 'next',
						relationship: { from: 'nextId' },
						definition: i === length ? first : { tableClass: next },
						enumerable: true,
					},
				],
			});
			tables[name] = READ;
		}
		first.tableClass = next;
		const siblings = 10;
		const rootAttributes = [{ name: 'id', isPrimaryKey: true }];
		const selection = ['id'];
		for (let b = 0; b < siblings; b++) {
			const sibling = table({
				table: 'EnumCycleSibling' + b,
				database: DATABASE,
				attributes: [
					{ name: 'id', isPrimaryKey: true },
					{ name: 'cycleId' },
					{ name: 'cycle', relationship: { from: 'cycleId' }, definition: { tableClass: next }, enumerable: true },
				],
			});
			tables['EnumCycleSibling' + b] = READ;
			rootAttributes.push({ name: 'c' + b + 'Id' });
			rootAttributes.push({
				name: 'c' + b,
				relationship: { from: 'c' + b + 'Id' },
				definition: { tableClass: sibling },
			});
			selection.push('c' + b);
		}
		const Root = table({ table: 'EnumCycleRoot', database: DATABASE, attributes: rootAttributes });
		tables.EnumCycleRoot = READ;
		const user = countingUser(tables);
		assert.deepStrictEqual(await searchAs(Root, user, selection), []);
		const tableCount = length + 1 + siblings + 1;
		assert.ok(user.lookups <= 2 * tableCount, `${user.lookups} permission lookups for ${tableCount} tables`);
	});

	function defineGraph(prefix, edges) {
		const definitions = {};
		const tables = {};
		for (const name in edges) definitions[name] = {};
		for (const [name, targets] of Object.entries(edges)) {
			const attributes = [{ name: 'id', isPrimaryKey: true }];
			for (const target of targets) {
				attributes.push({ name: target + 'Id' });
				attributes.push({
					name: 'to' + target,
					relationship: { from: target + 'Id' },
					definition: definitions[target],
					enumerable: true,
				});
			}
			tables[name] = definitions[name].tableClass = table({ table: prefix + name, database: DATABASE, attributes });
		}
		return tables;
	}

	it('checks cyclic closures entered from alternating selections a bounded number of times', async () => {
		const length = 8;
		const edges = { Leaf: [] };
		for (let i = 0; i < length; i++) {
			edges['C' + i] = i + 1 < length ? ['C' + i, 'C' + (i + 1)] : ['C' + i];
			edges['S' + i] = ['Leaf'];
		}
		const graph = defineGraph('EnumAlt', edges);
		const rootAttributes = [{ name: 'id', isPrimaryKey: true }];
		const selection = ['id'];
		for (let i = 0; i < length; i++) {
			for (const name of ['C' + i, 'S' + i]) {
				rootAttributes.push({ name: name + 'Id' });
				rootAttributes.push({ name, relationship: { from: name + 'Id' }, definition: { tableClass: graph[name] } });
				selection.push(name);
			}
		}
		const Root = table({ table: 'EnumAltRoot', database: DATABASE, attributes: rootAttributes });
		const tables = { EnumAltRoot: READ };
		for (const name in graph) tables['EnumAlt' + name] = READ;
		const user = countingUser(tables);
		assert.deepStrictEqual(await searchAs(Root, user, selection), []);
		const tableCount = Object.keys(tables).length;
		assert.ok(user.lookups <= 3 * tableCount, `${user.lookups} permission lookups for ${tableCount} tables`);
	});

	it('proves a cycle only after the walk that reached it succeeds', () => {
		// R reaches A, whose success rests on R, before R reaches the unreadable X
		const graph = defineGraph('EnumWalk', { R: ['A', 'X'], A: ['R'], X: [], Q: ['L'], L: [] });
		const tables = { EnumWalkR: READ, EnumWalkA: READ, EnumWalkQ: READ, EnumWalkL: READ };
		const user = roleWith(tables);
		graph.R._inReadAdmission(() => {
			assert.equal(graph.R._readableInFull(user), false);
			assert.equal(graph.Q._readableInFull(user), true);
			assert.equal(graph.A._readableInFull(user), false);
		});
		const failing = countingUser(tables, 3);
		graph.R._inReadAdmission(() => {
			assert.throws(() => graph.R._readableInFull(failing), /permission lookup failed/);
			assert.equal(graph.Q._readableInFull(user), true);
			assert.equal(graph.A._readableInFull(user), false);
		});
	});

	it('keeps cycle proofs to the principal and permission source that made them', () => {
		const graph = defineGraph('EnumOwn', { P: ['P2'], P2: ['P'] });
		const readsCycle = roleWith({ EnumOwnP: READ, EnumOwnP2: READ });
		const readsOne = roleWith({ EnumOwnP: READ });
		graph.P._inReadAdmission(() => {
			assert.equal(graph.P._readableInFull(readsCycle), true);
			assert.equal(graph.P2._readableInFull(readsOne), false);
			assert.equal(graph.P._readableInFull(readsOne), false);
			assert.equal(graph.P2._readableInFull(readsCycle), true);
			assert.equal(graph.P._readableInFull(readsCycle, { checkPermission: readsOne.role.permission }), false);
			assert.equal(graph.P._readableInFull(readsCycle, { checkPermission: readsCycle.role.permission }), true);
		});
	});

	it('does not reuse a closure proof for another principal within one admission', () => {
		const readAll = roleWith({ EnumEmp: READ, EnumDept: READ, EnumOrg: READ });
		const empOnly = roleWith({ EnumEmp: READ });
		const admit = (user, checkPermission = true) => {
			const target = new RequestTarget('/');
			target.checkPermission = checkPermission;
			assert.ok(new EnumEmp(undefined, {}).allowRead(user, target, {}));
			return target.select && [...target.select];
		};
		EnumEmp._inReadAdmission(() => {
			assert.equal(admit(readAll), undefined);
			assert.deepStrictEqual(admit(empOnly), ['*']);
			assert.equal(admit(readAll), undefined);
			assert.deepStrictEqual(admit(readAll, empOnly.role.permission), ['*']);
			assert.equal(admit(readAll, readAll.role.permission), undefined);
		});
	});

	it('admits consecutive principals independently, also after a failed permission lookup', async () => {
		const restricted = roleWith({ EnumEmp: READ, EnumDept: readOnly('id', 'name') });
		const noOrg = roleWith({ EnumEmp: READ, EnumDept: READ });
		const readAll = roleWith({ EnumEmp: READ, EnumDept: READ, EnumOrg: READ });
		const narrowed = { id: 'e1', name: 'Ann', deptId: 'd1', extra: 'x', dept: { id: 'd1', name: 'Eng' } };
		const withoutOrg = { ...fullEmp, dept: { id: 'd1', name: 'Eng', budget: 100, orgId: 'o1' } };
		assert.deepStrictEqual(await getAs(EnumEmp, restricted, 'e1'), narrowed);
		assert.deepStrictEqual(await getAs(EnumEmp, readAll, 'e1'), fullEmp);
		assert.deepStrictEqual(await getAs(EnumEmp, noOrg, 'e1'), withoutOrg);
		for (let failAt = 1; failAt <= 4; failAt++) {
			const failing = countingUser({ EnumEmp: READ, EnumDept: READ }, failAt);
			await assert.rejects(getAs(EnumEmp, failing, 'e1'));
			assert.deepStrictEqual(await getAs(EnumEmp, readAll, 'e1'), fullEmp);
			assert.deepStrictEqual(await getAs(EnumEmp, noOrg, 'e1'), withoutOrg);
			assert.deepStrictEqual(await getAs(EnumEmp, roleWith({ EnumEmp: READ }), 'e1'), {
				id: 'e1',
				name: 'Ann',
				deptId: 'd1',
				extra: 'x',
			});
		}
	});

	it('authorizes a selected $record like the record itself', async () => {
		const empOnly = { id: 'e1', name: 'Ann', deptId: 'd1', extra: 'x' };
		const narrowed = { ...empOnly, dept: { id: 'd1', name: 'Eng' } };
		const cases = [
			[roleWith({ EnumEmp: READ }), empOnly],
			[roleWith({ EnumEmp: READ, EnumDept: readOnly('id', 'name') }), narrowed],
			[roleWith({ EnumEmp: READ, EnumDept: READ, EnumOrg: READ }), fullEmp],
		];
		for (const [user, record] of cases) {
			assert.deepStrictEqual(await searchAs(EnumEmp, user, ['id', '$record']), [{ id: 'e1', $record: record }]);
			assert.deepStrictEqual(await getAs(EnumEmp, user, 'e1', ['$record']), { $record: record });
		}
	});

	it('operations API reports a denied related attribute named __proto__', () => {
		const writeOnly = { attribute_name: '__proto__', read: false, insert: true, update: false };
		const priorSchema = global.hdb_schema;
		const schemaOf = (name, attributes) => ({
			name,
			schema: DATABASE,
			hash_attribute: 'id',
			attributes: attributes.map((attribute) => ({ attribute })),
		});
		global.hdb_schema = {
			[DATABASE]: {
				EnumEmp: schemaOf('EnumEmp', ['id', 'name', 'deptId', 'dept']),
				EnumDept: schemaOf('EnumDept', ['id', 'name', 'budget', 'orgId', 'org', '__proto__']),
			},
		};
		const request = {
			operation: 'search_by_conditions',
			schema: DATABASE,
			table: 'EnumEmp',
			get_attributes: ['id'],
			conditions: [{ search_attribute: ['dept', '__proto__'], search_type: 'equals', search_value: 1 }],
			hdb_user: {
				username: 'proto-reader',
				role: {
					id: 'proto-reader',
					role: 'proto-reader',
					__updatedtime__: Date.now(),
					permission: {
						super_user: false,
						[DATABASE]: {
							tables: {
								EnumEmp: READ,
								EnumDept: {
									...readOnly('id', 'name'),
									insert: true,
									attribute_permissions: [...readOnly('id').attribute_permissions, writeOnly],
								},
							},
						},
					},
				},
			},
		};
		let response, ignoredValueField;
		try {
			response = verifyPerms(request, 'searchByConditions');
			// search_by_conditions does not run a value predicate, so its fields are not authorized
			ignoredValueField = verifyPerms(
				{
					...request,
					conditions: [{ search_attribute: 'id', search_type: 'equals', search_value: 'e1' }],
					search_attribute: ['dept', '__proto__'],
					search_value: 1,
				},
				'searchByConditions'
			);
		} finally {
			global.hdb_schema = priorSchema;
		}
		assert.equal(ignoredValueField, null);
		assert.deepStrictEqual(response.invalid_schema_items, []);
		assert.deepStrictEqual(JSON.parse(JSON.stringify(response.unauthorized_access)), [
			{
				schema: DATABASE,
				table: 'EnumDept',
				required_table_permissions: [],
				required_attribute_permissions: [{ attribute_name: '__proto__', required_permissions: ['read'] }],
			},
		]);
	});

	it("keeps a source record's own __proto__ field when narrowing a default read", async () => {
		const EnumCachedEmp = table({
			table: 'EnumCachedEmp',
			database: DATABASE,
			attributes: [
				{ name: 'id', isPrimaryKey: true },
				{ name: 'name' },
				{ name: 'deptId' },
				{ name: 'dept', relationship: { from: 'deptId' }, definition: { tableClass: EnumDept }, enumerable: true },
			],
		});
		EnumCachedEmp.sourcedFrom({
			get: (id) => JSON.parse(`{"id":"${id}","name":"Pat","deptId":"d1","__proto__":{"name":"shadow"}}`),
		});
		const target = new RequestTarget('/c1');
		target.id = 'c1';
		target.checkPermission = true;
		const user = roleWith({ EnumCachedEmp: READ, EnumDept: readOnly('id', 'name') });
		const record = await EnumCachedEmp.get(target, { user });
		assert.equal(Object.getPrototypeOf(record), Object.prototype);
		assert.deepStrictEqual(Object.keys(record), ['id', 'name', 'deptId', '__proto__', 'dept']);
		assert.deepStrictEqual(Object.getOwnPropertyDescriptor(record, '__proto__').value, { name: 'shadow' });
	});

	it('filters a related selection through a forward relationship the role reads by its foreign key', async () => {
		const user = roleWith({ EnumEmp: READ, EnumDept: readOnly('id', 'orgId'), EnumOrg: READ });
		const byOrgName = (value) => [
			'id',
			{ name: 'dept', select: ['id'], conditions: [{ attribute: ['org', 'name'], value }] },
		];
		assert.deepStrictEqual(await searchAs(EnumEmp, user, byOrgName('Org')), [{ id: 'e1', dept: { id: 'd1' } }]);
		assert.deepStrictEqual(await searchAs(EnumEmp, user, byOrgName('Other')), [{ id: 'e1' }]);
	});

	it('applies the conditions of a single-object relationship selection', async () => {
		const search = async (select) => {
			const results = [];
			for await (const result of EnumEmp.search({ conditions: [{ attribute: 'id', value: 'e1' }], select }, {}))
				results.push(result);
			return plain(results);
		};
		const byBudget = (value) => ({ name: 'dept', select: ['id'], conditions: [{ attribute: 'budget', value }] });
		assert.deepStrictEqual(await search(byBudget(100)), [{ id: 'd1' }]);
		assert.deepStrictEqual(await search(byBudget(0)), [null]);
	});

	it('narrows a default read of a mutable instance without losing its fields', async () => {
		const loadAsInstance = EnumEmp.loadAsInstance;
		EnumEmp.loadAsInstance = true;
		EnumEmp.getReturnMutable = true;
		try {
			const own = { id: 'e1', name: 'Ann', deptId: 'd1', extra: 'x' };
			const restricted = roleWith({ EnumEmp: READ, EnumDept: readOnly('id', 'name') });
			assert.deepStrictEqual(await getAs(EnumEmp, roleWith({ EnumEmp: READ }), 'e1'), own);
			assert.deepStrictEqual(await getAs(EnumEmp, roleWith({ EnumEmp: READ }), 'e1', ['*']), own);
			assert.deepStrictEqual(await getAs(EnumEmp, restricted, 'e1', ['*']), {
				...own,
				dept: { id: 'd1', name: 'Eng' },
			});
		} finally {
			EnumEmp.getReturnMutable = false;
			EnumEmp.loadAsInstance = loadAsInstance;
		}
	});

	it('expands * only in a select written by authorization', async () => {
		const readAll = roleWith({ EnumEmp: READ, EnumDept: READ, EnumOrg: READ, EnumPublisher: READ });
		const superUser = { role: { permission: { super_user: true } } };
		assert.deepStrictEqual(await getAs(EnumEmp, readAll, 'e1', ['*']), await getAs(EnumEmp, superUser, 'e1', ['*']));
		assert.deepStrictEqual(
			await getAs(EnumPublisher, readAll, 'p1', ['*']),
			await getAs(EnumPublisher, superUser, 'p1', ['*'])
		);
		assert.deepStrictEqual(await getAs(EnumEmp, roleWith({ EnumEmp: READ }), 'e1', ['*']), {
			id: 'e1',
			name: 'Ann',
			deptId: 'd1',
			extra: 'x',
		});
	});

	it('checks each table of a long restricted enumerable chain a bounded number of times', async () => {
		const length = 16;
		let next;
		const chain = [];
		for (let i = length; i >= 0; i--) {
			const attributes = [{ name: 'id', isPrimaryKey: true }];
			if (next) {
				attributes.push({ name: 'nextId' });
				attributes.push({
					name: 'next',
					relationship: { from: 'nextId' },
					definition: { tableClass: next },
					enumerable: true,
				});
			}
			next = table({ table: 'EnumChain' + i, database: DATABASE, attributes });
			chain.unshift(next);
		}
		const tables = {};
		for (let i = 0; i < length; i++) tables['EnumChain' + i] = READ;
		let lookups = 0;
		const user = {
			role: {
				permission: {
					get [DATABASE]() {
						lookups++;
						return { tables };
					},
				},
			},
		};
		assert.deepStrictEqual(await searchAs(chain[0], user), []);
		assert.ok(lookups <= 3 * length, `${lookups} permission lookups for a chain of ${length}`);
	});
});
