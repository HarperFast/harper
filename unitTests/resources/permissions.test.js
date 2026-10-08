require('../testUtils');
const assert = require('assert');
const { setupTestDBPath } = require('../testUtils');
const { table } = require('#src/resources/databases');
const { RequestTarget } = require('#src/resources/RequestTarget');
const { setMainIsWorker } = require('#js/server/threads/manageThreads');
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
