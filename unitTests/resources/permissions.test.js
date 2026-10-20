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
		const target = new RequestTarget('?id=r1&select(id,middle{grand})');
		target.checkPermission = true;
		const results = [];
		for await (const result of Root.search(target, { user })) results.push(result);
		assert.equal(results.length, 1);
		assert.deepStrictEqual(JSON.parse(JSON.stringify(results)), [{ id: 'r1', middle: { id: 'm1', grandId: 'g1' } }]);
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
