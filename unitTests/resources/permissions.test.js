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
