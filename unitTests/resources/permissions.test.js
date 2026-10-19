require('../testUtils');
const assert = require('assert');
const { setupTestDBPath } = require('../testUtils');
const { table } = require('#src/resources/databases');
const { RequestTarget } = require('#src/resources/RequestTarget');
const { setMainIsWorker } = require('#src/server/threads/manageThreads');
// might want to enable an iteration with NATS being assigned as a source
describe('Permissions through Resource API', () => {
	let TestTable, restricted_user, authorized_role, attribute_authorized_role;
	before(async function () {
		setupTestDBPath();
		setMainIsWorker(true); // TODO: Should be default until changed
		let RelatedTable = table({
			table: 'RelatedTestTable',
			database: 'test',
			attributes: [
				{ name: 'id', isPrimaryKey: true },
				{ name: 'name', indexed: true },
			],
		});
		TestTable = table({
			table: 'TestTable',
			database: 'test',
			attributes: [
				{ name: 'id', isPrimaryKey: true },
				{ name: 'name', indexed: true },
				{ name: 'prop1' },
				{ name: 'relatedId' },
				{ name: 'related', relationship: { from: 'relatedId' }, definition: { tableClass: RelatedTable } },
			],
		});
		for (let i = 0; i < 10; i++) {
			await RelatedTable.put({ id: 'related-id-' + i, name: 'related name-' + i });
			await TestTable.put({
				id: 'id-' + i,
				name: i > 0 ? 'name-' + i : null,
				prop1: 'test',
				relatedId: 'related-id-' + i,
			});
		}
		restricted_user = {
			role: {
				permission: {
					test: {
						tables: {
							TestTable: {
								read: false,
								insert: false,
								update: false,
								delete: false,
							},
						},
					},
				},
			},
		};
		authorized_role = {
			role: {
				permission: {
					test: {
						tables: {
							TestTable: {
								read: true,
								insert: false,
								update: false,
								delete: false,
								attribute_permissions: [],
							},
						},
					},
				},
			},
		};
		attribute_authorized_role = {
			role: {
				permission: {
					test: {
						tables: {
							TestTable: {
								read: true,
								insert: true,
								update: true,
								delete: true,
								attribute_permissions: [
									{
										attribute_name: 'name',
										read: true,
										insert: true,
										update: true,
									},
									{
										attribute_name: 'related',
										read: true,
										insert: true,
										update: true,
									},
								],
							},
							RelatedTestTable: {
								read: true,
								insert: true,
								update: true,
								delete: true,
								attribute_permissions: [
									{
										attribute_name: 'id',
										read: true,
										insert: true,
										update: true,
									},
								],
							},
						},
					},
				},
			},
		};
	});
	it('Can not get without permission', async function () {
		let caught_error;
		try {
			await TestTable.get('id-2', {
				user: restricted_user,
				authorize: true,
			});
		} catch (error) {
			caught_error = error;
		}
		assert(caught_error.message.includes('Unauthorized access'));
	});
	it('loadAsInstance=false get settles an async allowRead before returning a delegated search', async function () {
		class DeniedGet extends TestTable {
			static loadAsInstance = false;
			async allowRead() {
				await new Promise((resolve) => setTimeout(resolve, 5));
				return false;
			}
			get(target) {
				return this.search(target);
			}
		}
		class DeniedEnvelopeGet extends DeniedGet {
			get(target) {
				return { headers: { 'X-Envelope': 'true' }, data: this.search(target) };
			}
		}
		class AllowedGet extends DeniedGet {
			async allowRead() {
				return true;
			}
		}
		const context = () => ({ user: authorized_role, authorize: true });
		for (const Denied of [DeniedGet, DeniedEnvelopeGet]) {
			await assert.rejects(
				Denied.get(new RequestTarget('?name=name-1'), context()),
				(error) => error.name === 'AccessViolation' && error.statusCode === 403,
				Denied.name
			);
		}
		const ids = [];
		for await (const record of await AllowedGet.get(new RequestTarget('?name=name-1'), context())) ids.push(record.id);
		assert.deepStrictEqual(ids, ['id-1']);
	});
	it('only loadAsInstance=false get inspects its result for a pending search authorization', async function () {
		let reads = 0;
		const result = {
			get [Symbol.for('harper.searchAuthorization')]() {
				reads++;
				return undefined;
			},
		};
		class DefaultModeGet extends TestTable {
			async get() {
				return result;
			}
		}
		class FalseModeGet extends DefaultModeGet {
			static loadAsInstance = false;
		}
		assert.strictEqual(await DefaultModeGet.get(new RequestTarget('?name=name-1'), {}), result);
		assert.strictEqual(reads, 0);
		assert.strictEqual(await FalseModeGet.get(new RequestTarget('?name=name-1'), {}), result);
		assert.strictEqual(reads, 1);
	});
	it('Can not write without permission', async function () {
		let caught_error;
		try {
			await TestTable.put(
				'id-2',
				{ name: 'new record' },
				{
					user: restricted_user,
					authorize: true,
				}
			);
		} catch (error) {
			caught_error = error;
		}
		assert(caught_error.message.includes('Unauthorized access'));
		caught_error = null;
		try {
			await TestTable.delete('id-2', {
				user: restricted_user,
				authorize: true,
			});
		} catch (error) {
			caught_error = error;
		}
		assert(caught_error.message.includes('Unauthorized access'));
	});

	it('Can get with permission', async function () {
		const request = {
			user: authorized_role,
			authorize: true,
			id: 'id-2',
		};
		let result = await TestTable.get(request, request);
		assert.equal(result.name, 'name-2');
		assert.equal(result.prop1, 'test');
	});
	it('Can get with (limited) permission', async function () {
		const request = {
			user: attribute_authorized_role,
			authorize: true,
			id: 'id-2',
		};
		let result = await TestTable.get(request, request);
		assert.equal(result.name, 'name-2');
		assert.equal(result.prop1, undefined);
		assert.equal(result.related, undefined);
	});
	it('Can query with select with (limited) permission', async function () {
		const request = {
			user: attribute_authorized_role,
		};
		const target = new RequestTarget('?id=id-2&select(name,related)');
		target.checkPermission = true;
		let results = [];
		for await (let result of TestTable.search(target, request)) {
			results.push(result);
		}
		assert.equal(results[0].name, 'name-2');
		assert.equal(results[0].prop1, undefined);
		assert.equal(results[0].related.id, 'related-id-2');
		assert.equal(results[0].related.name, undefined);
	});
	it('Can query with selecting inaccessible attributes with (limited) permission', async function () {
		const request = {
			user: attribute_authorized_role,
		};
		const target = new RequestTarget('?id=id-2&select(name,prop1,related{name})');
		target.checkPermission = true;
		let results = [];
		for await (let result of TestTable.search(target, request)) {
			results.push(result);
		}
		assert.equal(results[0].name, 'name-2');
		assert.equal(results[0].prop1, undefined);
		assert.equal(results[0].related.id, 'related-id-2');
		assert.equal(results[0].related.name, undefined);
	});
	async function searchAs(user, query) {
		const target = new RequestTarget(query);
		target.checkPermission = true;
		const results = [];
		for await (const result of TestTable.search(target, { user })) results.push(result);
		return results;
	}
	it('Can not query or sort through a relationship to a table the role cannot read', async function () {
		await assert.rejects(searchAs(authorized_role, '?related.name=related name-2'), /Unauthorized access/);
		await assert.rejects(searchAs(authorized_role, '?id=id-2&sort(related.name)'), /Unauthorized access/);
	});
	it('Can not query on a related attribute the role cannot read', async function () {
		await assert.rejects(searchAs(attribute_authorized_role, '?related.name=related name-2'), /Unauthorized access/);
		const results = await searchAs(attribute_authorized_role, '?related.id=related-id-2&select(name)');
		assert.deepEqual(
			results.map((result) => result.name),
			['name-2']
		);
	});
	it('Drops a related selection that sorts by, or carries permissions for, what the role cannot read', async function () {
		const searchWith = async (property) => {
			const target = new RequestTarget('?id=id-2');
			target.select = ['name', property];
			target.checkPermission = true;
			const results = [];
			for await (const result of TestTable.search(target, { user: attribute_authorized_role })) results.push(result);
			return results;
		};
		const sorted = await searchWith({ name: 'related', select: ['id'], sort: { attribute: 'name' } });
		assert.equal(sorted[0].related, undefined);
		const injected = await searchWith({
			name: 'related',
			select: ['id', 'name'],
			checkPermission: { super_user: true },
		});
		assert.deepEqual(injected[0].related, { id: 'related-id-2' });
	});
	it('Applies a one-shot conditions iterator once authorization has read it', async function () {
		const idCondition = () => [{ attribute: 'id', value: 'id-2' }][Symbol.iterator]();
		const context = () => ({ user: authorized_role, authorize: true });
		const searched = [];
		for await (const result of TestTable.search({ conditions: idCondition(), select: ['id'] }, context()))
			searched.push(result.id);
		assert.deepEqual(searched, ['id-2']);
		const target = new RequestTarget('/');
		target.isCollection = true;
		const queried = [];
		for await (const result of await TestTable.query(target, { conditions: idCondition(), select: ['id'] }, context()))
			queried.push(result.id);
		assert.deepEqual(queried, ['id-2']);
	});
	it('Reads through a relationship whose name or join key the role can read', async function () {
		const roleReading = (attributes) => ({
			role: {
				permission: {
					test: {
						tables: {
							TestTable: {
								read: true,
								attribute_permissions: attributes.map((attribute_name) => ({ attribute_name, read: true })),
							},
							RelatedTestTable: { read: true, attribute_permissions: [] },
						},
					},
				},
			},
		});
		const byJoinKey = await searchAs(
			roleReading(['id', 'name', 'relatedId']),
			'?related.name=related name-2&select(name)'
		);
		assert.deepEqual(
			byJoinKey.map((result) => result.name),
			['name-2']
		);
		await assert.rejects(
			searchAs(roleReading(['id', 'name']), '?related.name=related name-2&select(name)'),
			/Unauthorized access/
		);
	});
	it('Requires the name of an inverse relationship, whose key lives in the related table', async function () {
		const Child = table({
			table: 'PermInverseChild',
			database: 'test',
			attributes: [
				{ name: 'id', isPrimaryKey: true },
				{ name: 'name', indexed: true },
				{ name: 'parentId', indexed: true },
			],
		});
		const Parent = table({
			table: 'PermInverseParent',
			database: 'test',
			attributes: [
				{ name: 'id', isPrimaryKey: true },
				{ name: 'children', relationship: { to: 'parentId' }, elements: { definition: { tableClass: Child } } },
			],
		});
		await Parent.put({ id: 'p1' });
		await Child.put({ id: 'c1', name: 'Ann', parentId: 'p1' });
		const roleReading = (parentAttributes) => ({
			role: {
				permission: {
					test: {
						tables: {
							PermInverseParent: {
								read: true,
								attribute_permissions: parentAttributes.map((attribute_name) => ({ attribute_name, read: true })),
							},
							PermInverseChild: {
								read: true,
								attribute_permissions: ['id', 'name'].map((attribute_name) => ({ attribute_name, read: true })),
							},
						},
					},
				},
			},
		});
		const searchParents = async (user) => {
			const target = new RequestTarget('?children.name=Ann&select(id)');
			target.checkPermission = true;
			const results = [];
			for await (const result of Parent.search(target, { user })) results.push(result.id);
			return results;
		};
		await assert.rejects(searchParents(roleReading(['id'])), /Unauthorized access/);
		assert.deepEqual(await searchParents(roleReading(['id', 'children'])), ['p1']);
	});
	it('Does not resolve a second relationship hop through a REST property set', async function () {
		const Grand = table({
			table: 'PermHopGrand',
			database: 'test',
			attributes: [{ name: 'id', isPrimaryKey: true }],
		});
		const Middle = table({
			table: 'PermHopMiddle',
			database: 'test',
			attributes: [
				{ name: 'id', isPrimaryKey: true },
				{ name: 'grandId' },
				{ name: 'grand', relationship: { from: 'grandId' }, definition: { tableClass: Grand } },
			],
		});
		const Root = table({
			table: 'PermHopRoot',
			database: 'test',
			attributes: [
				{ name: 'id', isPrimaryKey: true },
				{ name: 'middleId' },
				{ name: 'middle', relationship: { from: 'middleId' }, definition: { tableClass: Middle } },
			],
		});
		await Grand.put({ id: 'g1' });
		await Middle.put({ id: 'm1', grandId: 'g1' });
		await Root.put({ id: 'r1', middleId: 'm1' });
		const user = {
			role: {
				permission: {
					test: {
						tables: {
							PermHopRoot: { read: true, attribute_permissions: [] },
							PermHopMiddle: { read: true, attribute_permissions: [] },
						},
					},
				},
			},
		};
		const select = async (query, asUser = user) => {
			const target = new RequestTarget(query);
			target.checkPermission = true;
			const results = [];
			for await (const result of Root.search(target, { user: asUser })) results.push(result);
			return JSON.parse(JSON.stringify(results));
		};
		assert.deepStrictEqual(
			await select('?id=r1&select(id,middle{id,grand,sort(+id)})', { role: { permission: { super_user: true } } }),
			[{ id: 'r1', middle: { id: 'm1', grand: { id: 'g1' } } }]
		);
		assert.deepStrictEqual(await select('?id=r1&select(id,middle{grand})'), [
			{ id: 'r1', middle: { id: 'm1', grandId: 'g1' } },
		]);
		assert.deepStrictEqual(await select('?id=r1&select(id,middle{id,grand,sort(+id)})'), [
			{ id: 'r1', middle: { id: 'm1' } },
		]);
	});
	it('Reports the first unreadable step of a relationship path', function () {
		assert.equal(TestTable._readDenial(['related', 'name'], { role: { permission: { super_user: true } } }), undefined);
		assert.deepEqual(TestTable._readDenial(['related'], authorized_role), {
			database: 'test',
			table: 'RelatedTestTable',
		});
		assert.deepEqual(TestTable._readDenial(['related', 'name'], attribute_authorized_role), {
			database: 'test',
			table: 'RelatedTestTable',
			attribute: 'name',
		});
		assert.deepEqual(TestTable._readDenial(['prop1'], attribute_authorized_role), {
			database: 'test',
			table: 'TestTable',
			attribute: 'prop1',
		});
		assert.equal(TestTable._readDenial(['related', 'id'], attribute_authorized_role), undefined);
	});
	it('QUERY body permission controls cannot authorize a related-table select', async function () {
		let receivedCheckPermission;
		let receivedNestedCheckPermission;
		class SafeQueryTable extends TestTable {
			search(target) {
				receivedCheckPermission = target.checkPermission;
				receivedNestedCheckPermission = target.select?.[0]?.checkPermission;
				return super.search(target);
			}
		}
		const target = new RequestTarget();
		target.isCollection = true;
		const body = {
			conditions: [{ attribute: 'id', comparator: 'equals', value: 'id-2' }],
			select: [{ name: 'related', select: ['id', 'name'], checkPermission: { super_user: true } }],
		};
		const iterable = await SafeQueryTable.query(target, Promise.resolve(body), {
			user: authorized_role,
			authorize: true,
		});
		const results = [];
		for await (const result of iterable) results.push(result);
		assert.equal(receivedCheckPermission, undefined);
		assert.equal(receivedNestedCheckPermission, undefined);
		assert.equal(results.length, 1);
		assert.equal(results[0].related, undefined);
	});
	it('Plain JSON sub-selections read stored keys without related-table permission and keep containing-attribute checks', async function () {
		await TestTable.put({
			id: 'id-json-1',
			name: 'json-1',
			prop1: { relatedId: 'related-id-1', related: 'stored-value' },
			relatedId: 'related-id-1',
		});
		try {
			assert.deepStrictEqual(
				JSON.parse(JSON.stringify(await searchAs(authorized_role, '?id=id-json-1&select(id,prop1{related})'))),
				[{ id: 'id-json-1', prop1: { related: 'stored-value' } }]
			);
			const single = new RequestTarget('/id-json-1?select(id,prop1{related})');
			single.id = 'id-json-1';
			single.checkPermission = true;
			assert.deepStrictEqual(JSON.parse(JSON.stringify(await TestTable.get(single, { user: authorized_role }))), {
				id: 'id-json-1',
				prop1: { related: 'stored-value' },
			});
			const scalarTarget = new RequestTarget('?id=id-json-1');
			scalarTarget.select = ['id', { name: 'prop1', select: 'related' }];
			scalarTarget.checkPermission = true;
			const scalarResults = [];
			for await (const result of TestTable.search(scalarTarget, { user: authorized_role })) scalarResults.push(result);
			assert.deepStrictEqual(JSON.parse(JSON.stringify(scalarResults)), [{ id: 'id-json-1', prop1: 'stored-value' }]);
			assert.deepStrictEqual(
				JSON.parse(
					JSON.stringify(await searchAs(attribute_authorized_role, '?id=id-json-1&select(name,prop1{related})'))
				),
				[{ name: 'json-1' }]
			);
		} finally {
			await TestTable.delete('id-json-1');
		}
	});
	it('Can write with permission', async function () {
		await TestTable.put(
			'id-2',
			{ name: 'new record' },
			{
				user: attribute_authorized_role,
				authorize: true,
			}
		);
		TestTable.delete('id-2', {
			user: attribute_authorized_role,
			authorize: true,
		});
	});
	it('Can not write with restricted attribute', async function () {
		let caught_error;
		try {
			await TestTable.put(
				'id-2',
				{ name: 'new record', prop1: 'change' },
				{
					user: restricted_user,
					authorize: true,
				}
			);
		} catch (error) {
			caught_error = error;
		}
		assert(caught_error.message.includes('Unauthorized access'));
	});
	it('Rejects promised updates with a restricted attribute', async function () {
		await assert.rejects(
			async () =>
				TestTable.put('id-8', Promise.resolve({ prop1: 'forbidden' }), {
					user: attribute_authorized_role,
					authorize: true,
				}),
			/Unauthorized access/
		);
		assert.equal((await TestTable.get('id-8')).prop1, 'test');
	});
	it('Rejects promised creates with a restricted attribute', async function () {
		await assert.rejects(
			async () =>
				TestTable.post(new RequestTarget('/'), Promise.resolve({ prop1: 'forbidden' }), {
					user: attribute_authorized_role,
					authorize: true,
				}),
			/Unauthorized access/
		);
	});
	it('Allows promised writes with permitted attributes', async function () {
		await TestTable.put('id-9', Promise.resolve({ name: 'permitted' }), {
			user: attribute_authorized_role,
			authorize: true,
		});
		assert.equal((await TestTable.get('id-9')).name, 'permitted');
		const id = await TestTable.post(new RequestTarget('/'), Promise.resolve({ name: 'permitted create' }), {
			user: attribute_authorized_role,
			authorize: true,
		});
		assert.equal((await TestTable.get(id)).name, 'permitted create');
	});
	it('Keeps concrete-record attribute checks synchronous', function () {
		const context = { user: attribute_authorized_role, authorize: true };
		const record = new TestTable('id-8', context);
		const collection = new TestTable(new RequestTarget('/'), context);
		assert.strictEqual(record.allowUpdate(attribute_authorized_role, { name: 'permitted' }, context), true);
		assert.strictEqual(record.allowUpdate(attribute_authorized_role, { prop1: 'forbidden' }, context), false);
		assert.strictEqual(collection.allowCreate(attribute_authorized_role, { name: 'permitted' }, context), true);
		assert.strictEqual(collection.allowCreate(attribute_authorized_role, { prop1: 'forbidden' }, context), false);
	});
	for (const method of ['allowUpdate', 'allowCreate']) {
		it(`does not re-enter a delegating ${method} override`, async function () {
			let calls = 0;
			class DelegatingTable extends TestTable {
				[method](user, data, context) {
					assert.equal(++calls, 1, 'Authorization override must run once');
					return super[method](user, Promise.resolve(data), context);
				}
			}
			const context = { user: attribute_authorized_role, authorize: true };
			const target = method === 'allowCreate' ? new RequestTarget('/') : 'id-8';
			const resource = await DelegatingTable.getResource(target, context, { isCollection: method === 'allowCreate' });
			assert.equal(!!resource.isCollection, method === 'allowCreate');
			assert.strictEqual(
				await resource[method](attribute_authorized_role, Promise.resolve({ name: 'allowed' }), context),
				true
			);
			assert.equal(calls, 1);
		});
	}
	it('preserves explicitly readonly fields on a promised full PUT', async function () {
		const permission = attribute_authorized_role.role.permission.test.tables.TestTable;
		const user = {
			role: {
				permission: {
					test: {
						tables: {
							TestTable: {
								...permission,
								attribute_permissions: [
									...permission.attribute_permissions,
									{
										attribute_name: 'prop1',
										read: true,
										insert: false,
										update: false,
									},
								],
							},
						},
					},
				},
			},
		};
		await TestTable.put({ id: 'readonly-promised', name: 'before', prop1: 'preserved' });
		await TestTable.put('readonly-promised', Promise.resolve({ name: 'after' }), { user, authorize: true });
		const record = await TestTable.get('readonly-promised');
		assert.equal(record.name, 'after');
		assert.equal(record.prop1, 'preserved');
	});
	it('applies the same restricted-attribute decision to concrete and promised arrays', async function () {
		const context = { user: attribute_authorized_role, authorize: true };
		for (const [method, target] of [
			['allowUpdate', 'id-8'],
			['allowCreate', new RequestTarget('/')],
		]) {
			const resource = await TestTable.getResource(target, context, { isCollection: method === 'allowCreate' });
			const records = [{ name: 'array record' }];
			assert.strictEqual(resource[method](attribute_authorized_role, records, context), false);
			assert.strictEqual(await resource[method](attribute_authorized_role, Promise.resolve(records), context), false);
		}
	});
});

describe('Bare collection POST authorization', () => {
	let PostBase, PostSub, insert_user, update_only_user;
	before(async function () {
		setupTestDBPath();
		setMainIsWorker(true);
		PostBase = table({
			table: 'BarePostTable',
			database: 'test',
			attributes: [{ name: 'id', isPrimaryKey: true }, { name: 'title' }],
		});
		// custom post() override, the accepted no-slash collection POST compatibility path
		PostSub = class extends PostBase {
			async post(data) {
				return super.post(data);
			}
		};
		Object.defineProperty(PostSub, 'name', { value: 'PostSub' });
		const perms = (insert, update) => ({
			role: {
				permission: {
					test: { tables: { BarePostTable: { read: true, insert, update, delete: false } } },
				},
			},
		});
		insert_user = perms(true, false);
		update_only_user = perms(false, true);
	});

	it('default bare table POST returns the trailing-slash 404', async function () {
		await assert.rejects(async () => PostBase.post(new RequestTarget(''), { title: 'x' }), /trailing slash/);
	});
	it('slash collection POST creates for a user with insert', async function () {
		const id = await PostSub.post(new RequestTarget('/'), { title: 'slash' }, { user: insert_user, authorize: true });
		assert.ok(id != null);
	});
	it('bare POST through a custom post() creates for a user with insert', async function () {
		const id = await PostSub.post(new RequestTarget(''), { title: 'bare' }, { user: insert_user, authorize: true });
		assert.ok(id != null);
	});
	it('update-only user is rejected on both bare and slash collection POST', async function () {
		for (const target of [new RequestTarget(''), new RequestTarget('/')]) {
			await assert.rejects(
				async () => PostSub.post(target, { title: 'nope' }, { user: update_only_user, authorize: true }),
				/Unauthorized/
			);
		}
	});
});

describe('Attribute permissions that omit the primary key (harper#3284)', () => {
	let DocTable, title_owner_user;
	before(async function () {
		setupTestDBPath();
		setMainIsWorker(true);
		DocTable = table({
			table: 'AttrPermDoc',
			database: 'test',
			attributes: [{ name: 'id', isPrimaryKey: true }, { name: 'title' }, { name: 'owner' }, { name: 'secret' }],
		});
		title_owner_user = {
			role: {
				permission: {
					test: {
						tables: {
							AttrPermDoc: {
								read: true,
								insert: true,
								update: true,
								delete: false,
								attribute_permissions: [
									{ attribute_name: 'title', read: true, insert: true, update: true },
									{ attribute_name: 'owner', read: true, insert: true, update: true },
									// listed but not a declared attribute: the resource path stores undeclared properties
									{ attribute_name: 'nickname', read: true, insert: true, update: true },
								],
							},
						},
					},
				},
			},
		};
	});
	const asUser = () => ({ user: title_owner_user, authorize: true });
	const seed = (id) => DocTable.put(id, { id, title: 'seed', owner: 'o', secret: `${id} secret`, extra: 'undeclared' });

	it('reads include the unlisted primary key and omit unlisted attributes', async function () {
		await seed('read-1');
		const request = { ...asUser(), id: 'read-1' };
		const record = await DocTable.get(request, request);
		assert.deepEqual(JSON.parse(JSON.stringify(record)), { id: 'read-1', title: 'seed', owner: 'o' });

		const target = new RequestTarget('?id=read-1&select(id,title)');
		target.checkPermission = true;
		const results = [];
		for await (const result of DocTable.search(target, { user: title_owner_user }))
			results.push(JSON.parse(JSON.stringify(result)));
		assert.deepEqual(results, [{ id: 'read-1', title: 'seed' }]);
	});

	it('a payload carrying the primary key may be written and published', async function () {
		await seed('key-1');
		await DocTable.put('key-1', { id: 'key-1', title: 'put', owner: 'o' }, asUser());
		await DocTable.publish('key-1', { id: 'key-1', title: 'published' }, asUser());
		assert.equal((await DocTable.get('key-1')).title, 'put');
	});

	it('a full put keeps every stored property the role cannot update, without changing the payload', async function () {
		await seed('put-1');
		const payload = { title: 'new', owner: 'new owner' };
		await DocTable.put('put-1', payload, asUser());
		assert.deepEqual(JSON.parse(JSON.stringify(await DocTable.get('put-1'))), {
			id: 'put-1',
			title: 'new',
			owner: 'new owner',
			secret: 'put-1 secret',
			extra: 'undeclared',
		});
		assert.ok(!('secret' in payload) && !('extra' in payload));
	});

	it('a full put drops a property the role can update but omitted', async function () {
		await seed('put-2');
		await DocTable.put('put-2', { title: 'only title' }, asUser());
		const stored = JSON.parse(JSON.stringify(await DocTable.get('put-2')));
		assert.deepEqual(stored, { id: 'put-2', title: 'only title', secret: 'put-2 secret', extra: 'undeclared' });
	});

	it('a payload setting an attribute the role cannot update is refused', async function () {
		await seed('refuse-1');
		await assert.rejects(
			async () => DocTable.put('refuse-1', { title: 't', secret: 'overwritten' }, asUser()),
			/Unauthorized/
		);
		await assert.rejects(async () => DocTable.patch('refuse-1', { extra: 'overwritten' }, asUser()), /Unauthorized/);
		const stored = await DocTable.get('refuse-1');
		assert.equal(stored.secret, 'refuse-1 secret');
		assert.equal(stored.extra, 'undeclared');
	});

	it('a listed attribute the schema does not declare stays readable and writable', async function () {
		await seed('nick-1');
		await DocTable.patch('nick-1', { nickname: 'nick' }, asUser());
		const request = { ...asUser(), id: 'nick-1' };
		assert.equal((await DocTable.get(request, request)).nickname, 'nick');
	});

	it('a full put body that only resolves after authorization is still checked', async function () {
		await seed('promise-1');
		await assert.rejects(
			async () => DocTable.put('promise-1', Promise.resolve({ title: 't', secret: 'overwritten' }), asUser()),
			/Unauthorized/
		);
		assert.equal((await DocTable.get('promise-1')).secret, 'promise-1 secret');
	});

	it('a restricted full put creates a missing record with its primary key', async function () {
		await DocTable.put('new-1', { title: 'created', owner: 'o' }, asUser());
		assert.deepEqual(JSON.parse(JSON.stringify(await DocTable.get('new-1'))), {
			id: 'new-1',
			title: 'created',
			owner: 'o',
		});
	});

	it('a collection put with a body that resolves after dispatch is refused', async function () {
		await seed('array-1');
		const target = new RequestTarget('/');
		target.isCollection = true;
		await assert.rejects(
			async () =>
				DocTable.put(target, Promise.resolve([{ id: 'array-1', title: 't', secret: 'overwritten' }]), asUser()),
			/Unauthorized/
		);
		assert.equal((await DocTable.get('array-1')).secret, 'array-1 secret');
	});

	it('a restricted full put of a non-record root is rejected without changing the record', async function () {
		await seed('root-1');
		for (const body of [[], Buffer.alloc(0)]) {
			await assert.rejects(async () => DocTable.put('root-1', body, asUser()));
		}
		assert.deepEqual(JSON.parse(JSON.stringify(await DocTable.get('root-1'))), {
			id: 'root-1',
			title: 'seed',
			owner: 'o',
			secret: 'root-1 secret',
			extra: 'undeclared',
		});
	});

	it('a restricted full put is logged as a patch, which replay and replication apply onto their own base', async function () {
		await seed('log-1');
		await DocTable.put('log-1', { title: 'logged' }, asUser());
		const history = await DocTable.getHistoryOfRecord('log-1');
		const last = history[history.length - 1];
		assert.equal(last.type, 'patch');
		assert.deepEqual(JSON.parse(JSON.stringify(last.value)), {
			id: 'log-1',
			title: 'logged',
			secret: 'log-1 secret',
			extra: 'undeclared',
		});
	});

	it('a static (loadAsInstance = false) table keeps unwritable properties on a full put', async function () {
		class StaticDocTable extends DocTable {
			static loadAsInstance = false;
		}
		await seed('static-1');
		await StaticDocTable.put('static-1', { title: 'static' }, asUser());
		assert.deepEqual(JSON.parse(JSON.stringify(await DocTable.get('static-1'))), {
			id: 'static-1',
			title: 'static',
			secret: 'static-1 secret',
			extra: 'undeclared',
		});
	});

	it('authorizing a publish does not add stored values to the message', async function () {
		await seed('pub-1');
		const permission = title_owner_user.role.permission.test.tables.AttrPermDoc;
		const user = {
			role: {
				permission: {
					test: {
						tables: {
							AttrPermDoc: {
								...permission,
								attribute_permissions: [
									...permission.attribute_permissions,
									{ attribute_name: 'secret', read: false, insert: false, update: false },
								],
							},
						},
					},
				},
			},
		};
		const subscription = await DocTable.subscribe('pub-1');
		const received = [];
		const reading = (async () => {
			for await (const event of subscription) {
				if (event.type !== 'message') continue;
				received.push(event.value);
				break;
			}
		})();
		await DocTable.publish('pub-1', { title: 'message' }, { user, authorize: true });
		await reading;
		assert.deepEqual(JSON.parse(JSON.stringify(received[0])), { title: 'message' });
	});

	it('a full put without attribute permissions still replaces the whole record', async function () {
		await seed('admin-1');
		await DocTable.put('admin-1', { title: 'replaced' });
		assert.deepEqual({ ...(await DocTable.get('admin-1')) }, { id: 'admin-1', title: 'replaced' });
	});
});

describe('Primary key grant edge cases (harper#3284)', () => {
	let KeyTable;
	const roleWith = (attribute_permissions) => ({
		role: {
			permission: {
				test: {
					tables: {
						AttrPermKey: { read: true, insert: true, update: true, delete: false, attribute_permissions },
					},
				},
			},
		},
	});
	before(async function () {
		setupTestDBPath();
		setMainIsWorker(true);
		KeyTable = table({
			table: 'AttrPermKey',
			database: 'test',
			attributes: [
				{ name: 'id', isPrimaryKey: true },
				{ name: 'title' },
				{ name: 'secret', type: 'String', nullable: false },
			],
		});
		await KeyTable.put('k-1', { id: 'k-1', title: 'seed', secret: 'kept' });
	});

	it('an explicitly listed primary key keeps its listed access', async function () {
		const user = roleWith([
			{ attribute_name: 'id', read: false, insert: false, update: false },
			{ attribute_name: 'title', read: true, insert: true, update: true },
		]);
		const request = { user, authorize: true, id: 'k-1' };
		assert.deepEqual(JSON.parse(JSON.stringify(await KeyTable.get(request, request))), { title: 'seed' });
		await assert.rejects(
			async () => KeyTable.put('k-1', { id: 'k-1', title: 't' }, { user, authorize: true }),
			/Unauthorized/
		);
	});

	it('a timestamp-only update grant does not grant primary key update', async function () {
		const user = roleWith([
			{ attribute_name: '__updatedtime__', read: false, insert: true, update: true },
			{ attribute_name: 'title', read: true, insert: false, update: false },
		]);
		const request = { user, authorize: true, id: 'k-1' };
		assert.equal((await KeyTable.get(request, request)).id, 'k-1');
		await assert.rejects(async () => KeyTable.put('k-1', { id: 'k-1' }, { user, authorize: true }), /Unauthorized/);
	});

	it('a full put need not carry a required attribute the role cannot update', async function () {
		const user = roleWith([{ attribute_name: 'title', read: true, insert: true, update: true }]);
		await KeyTable.put('k-1', { title: 'required kept' }, { user, authorize: true });
		const stored = await KeyTable.get('k-1');
		assert.equal(stored.title, 'required kept');
		assert.equal(stored.secret, 'kept');
	});

	it('a restricted full put creating a record still requires attributes the role cannot write', async function () {
		const user = roleWith([{ attribute_name: 'title', read: true, insert: true, update: true }]);
		await assert.rejects(
			async () => KeyTable.put('k-new', { title: 'no secret' }, { user, authorize: true }),
			/secret/
		);
		assert.equal(await KeyTable.get('k-new'), undefined);
	});

	it('a repeated attribute name takes its last entry for the primary key grant', async function () {
		for (const [first, last, keyUpdatable] of [
			[true, false, false],
			[false, true, true],
		]) {
			const user = roleWith([
				{ attribute_name: 'title', read: true, insert: true, update: first },
				{ attribute_name: 'title', read: true, insert: true, update: last },
			]);
			const write = async () => KeyTable.put('k-1', { id: 'k-1' }, { user, authorize: true });
			if (keyUpdatable) await write();
			else await assert.rejects(write, /Unauthorized/);
		}
	});
});
