require('../testUtils');
const assert = require('assert');
const { setupTestDBPath } = require('../testUtils');
const { table } = require('#src/resources/databases');
const { RequestTarget } = require('#src/resources/RequestTarget');
const { transaction } = require('#src/resources/transaction');
const { GenericTrackedObject } = require('#src/resources/tracked');
const { setTimeout } = require('node:timers/promises');
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

	it('patch, collection post and publish bodies that resolve after dispatch are still checked', async function () {
		await seed('promise-2');
		await assert.rejects(
			async () => DocTable.patch('promise-2', Promise.resolve({ secret: 'overwritten' }), asUser()),
			/Unauthorized/
		);
		const collection = new RequestTarget('/');
		collection.isCollection = true;
		await assert.rejects(
			async () => DocTable.post(collection, Promise.resolve({ title: 't', secret: 's' }), asUser()),
			/Unauthorized/
		);
		await assert.rejects(
			async () => DocTable.publish('promise-2', Promise.resolve({ secret: 's' }), asUser()),
			/Unauthorized/
		);
		assert.equal((await DocTable.get('promise-2')).secret, 'promise-2 secret');
	});

	it('a promised falsy body is passed through as the body', async function () {
		let received = 'not called';
		class ScalarBody extends DocTable {
			static loadAsInstance = false;
			put(target, data) {
				received = data;
			}
		}
		await ScalarBody.put('scalar-1', Promise.resolve(0));
		assert.equal(received, 0);
	});

	it('a static update with a body that resolves after dispatch is still checked', async function () {
		await seed('promise-3');
		await assert.rejects(
			async () => DocTable.update('promise-3', Promise.resolve({ secret: 'overwritten' }), asUser()),
			/Unauthorized/
		);
		assert.equal((await DocTable.get('promise-3')).secret, 'promise-3 secret');
	});

	it('a body that fails to resolve fails the write with its own error', async function () {
		await seed('reject-1');
		await assert.rejects(
			async () => DocTable.put('reject-1', Promise.reject(new SyntaxError('bad body')), asUser()),
			/bad body/
		);
	});

	it('an allowUpdate override that calls super is called once', async function () {
		let calls = 0;
		class CountingDoc extends DocTable {
			allowUpdate(user, data, context) {
				calls++;
				return super.allowUpdate(user, data, context);
			}
		}
		await seed('count-1');
		await CountingDoc.put('count-1', Promise.resolve({ title: 'counted' }), asUser());
		assert.equal(calls, 1);
		assert.equal((await DocTable.get('count-1')).secret, 'count-1 secret');
	});

	it('an allowUpdate override still receives a promised body', async function () {
		class PromiseHookDoc extends DocTable {
			allowUpdate(user, data) {
				return data.then((record) => record.title !== 'refused');
			}
		}
		await seed('hook-1');
		await PromiseHookDoc.put('hook-1', Promise.resolve({ title: 'accepted' }), asUser());
		await assert.rejects(
			async () => PromiseHookDoc.put('hook-1', Promise.resolve({ title: 'refused' }), asUser()),
			/Unauthorized/
		);
		assert.equal((await DocTable.get('hook-1')).title, 'accepted');
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

	it('a restricted full put removes an omitted writable property named like an Object.prototype member', async function () {
		await DocTable.put('proto-1', { id: 'proto-1', title: 'old', toString: 'stale', secret: 'kept' });
		const user = {
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
									{ attribute_name: 'toString', read: true, insert: true, update: true },
								],
							},
						},
					},
				},
			},
		};
		await DocTable.put('proto-1', { title: 'new' }, { user, authorize: true });
		assert.deepEqual(JSON.parse(JSON.stringify(await DocTable.get('proto-1'))), {
			id: 'proto-1',
			title: 'new',
			secret: 'kept',
		});
	});

	it('a restricted full put whose id is only in the body keeps protected attributes', async function () {
		await seed('body-id-1');
		await DocTable.put({ id: 'body-id-1', title: 'by body id' }, asUser());
		assert.deepEqual(JSON.parse(JSON.stringify(await DocTable.get('body-id-1'))), {
			id: 'body-id-1',
			title: 'by body id',
			secret: 'body-id-1 secret',
			extra: 'undeclared',
		});
	});

	it('a restricted full put of a tracked object stores its values', async function () {
		await seed('tracked-1');
		await DocTable.put('tracked-1', new GenericTrackedObject({ title: 'tracked' }), asUser());
		assert.deepEqual(JSON.parse(JSON.stringify(await DocTable.get('tracked-1'))), {
			id: 'tracked-1',
			title: 'tracked',
			secret: 'tracked-1 secret',
			extra: 'undeclared',
		});
	});

	it('a published message may carry a field named getRecord', async function () {
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
									{ attribute_name: 'getRecord', read: true, insert: true, update: true },
								],
							},
						},
					},
				},
			},
		};
		await DocTable.publish('pub-2', { getRecord: 'a value' }, { user, authorize: true });
	});

	it('a tracked payload is checked by the values it carries', async function () {
		await seed('tracked-2');
		await assert.rejects(
			async () => DocTable.put('tracked-2', new GenericTrackedObject({ title: 't', secret: 'overwritten' }), asUser()),
			/Unauthorized/
		);
		await assert.rejects(
			async () => DocTable.patch('tracked-2', new GenericTrackedObject({ secret: 'overwritten' }), asUser()),
			/Unauthorized/
		);
		assert.equal((await DocTable.get('tracked-2')).secret, 'tracked-2 secret');
	});

	it('an override that retries super.put keeps the restriction on the retry', async function () {
		class RetryingDoc extends DocTable {
			put(record, target) {
				super.put(record, target);
				return super.put(record, target);
			}
		}
		await seed('retry-1');
		await RetryingDoc.put('retry-1', { title: 'retried' }, asUser());
		const stored = await DocTable.get('retry-1');
		assert.equal(stored.title, 'retried');
		assert.equal(stored.secret, 'retry-1 secret');
	});

	it('an override that updates the instance before super.put keeps the restriction', async function () {
		class IntermediateUpdateDoc extends DocTable {
			put(record, target) {
				this.update({ owner: 'set by override' });
				return super.put(record, target);
			}
		}
		await seed('override-1');
		await IntermediateUpdateDoc.put('override-1', { title: 'via override' }, asUser());
		const stored = await DocTable.get('override-1');
		assert.equal(stored.title, 'via override');
		assert.equal(stored.secret, 'override-1 secret');
		assert.equal(stored.extra, 'undeclared');
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
		try {
			await DocTable.publish('pub-1', { title: 'message' }, { user, authorize: true });
			await Promise.race([reading, setTimeout(5000).then(() => assert.fail('no message delivered'))]);
		} finally {
			subscription.return?.();
		}
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
				{ name: '__createdtime__' },
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

	it('a restricted full put keeps the created time even when the role lists it as updatable', async function () {
		const created = (await KeyTable.get('k-1')).__createdtime__;
		assert.ok(created > 0);
		const user = roleWith([
			{ attribute_name: 'title', read: true, insert: true, update: true },
			{ attribute_name: '__createdtime__', read: true, insert: true, update: true },
		]);
		await KeyTable.put('k-1', { title: 'timestamped' }, { user, authorize: true });
		assert.equal((await KeyTable.get('k-1')).__createdtime__, created);
		await KeyTable.put('k-1', { title: 'timestamped', __createdtime__: 0 }, { user, authorize: true });
		assert.equal((await KeyTable.get('k-1')).__createdtime__, created);
	});

	it("a request's attribute restriction applies to a later full put on the same instance", async function () {
		const user = roleWith([{ attribute_name: 'title', read: true, insert: true, update: true }]);
		await KeyTable.put('k-2', { id: 'k-2', title: 'seed', secret: 'kept' });
		const context = { user };
		await transaction(context, async () => {
			const resource = await KeyTable.getResource('k-2', context);
			assert.ok(resource.allowUpdate(user, { title: 'patched' }, context));
			await resource.patch({ id: 'k-2' }, { title: 'patched' });
			await resource.put({ id: 'k-2' }, { title: 'replaced' });
		});
		const stored = await KeyTable.get('k-2');
		assert.equal(stored.title, 'replaced');
		assert.equal(stored.secret, 'kept');
	});

	it('an attribute-restricted role cannot write an array body, even through an attribute named like an index', async function () {
		const user = roleWith([
			{ attribute_name: '0', read: true, insert: true, update: true },
			{ attribute_name: 'title', read: true, insert: true, update: true },
		]);
		const target = new RequestTarget('/');
		target.isCollection = true;
		await assert.rejects(
			async () => KeyTable.put(target, [{ id: 'k-1', title: 't', secret: 'overwritten' }], { user, authorize: true }),
			/Unauthorized/
		);
		assert.equal((await KeyTable.get('k-1')).secret, 'kept');
	});
});

describe('Attribute permissions on a keyless table (harper#3284)', () => {
	let Keyless, user;
	before(async function () {
		setupTestDBPath();
		setMainIsWorker(true);
		Keyless = table({
			table: 'AttrPermKeyless',
			database: 'test',
			schemaDefined: true,
			attributes: [
				{ name: 'title', type: 'String' },
				{ name: 'secret', type: 'String' },
			],
		});
		user = {
			role: {
				permission: {
					test: {
						tables: {
							AttrPermKeyless: {
								read: true,
								insert: true,
								update: true,
								delete: false,
								attribute_permissions: [{ attribute_name: 'title', read: true, insert: true, update: true }],
							},
						},
					},
				},
			},
		};
	});

	it('grants no primary key and still reads and refuses as listed', async function () {
		const id = await Keyless.post({ title: 'keyless', secret: 'kept' });
		const request = { user, authorize: true, id };
		assert.deepEqual(JSON.parse(JSON.stringify(await Keyless.get(request, request))), { title: 'keyless' });
		await assert.rejects(
			async () => Keyless.patch(id, { undefined: 'overwritten' }, { user, authorize: true }),
			/Unauthorized/
		);
	});

	it('a sealed table accepts a restricted full put when the role lists an undeclared attribute', async function () {
		const Sealed = table({
			table: 'AttrPermSealed',
			database: 'test',
			sealed: true,
			attributes: [{ name: 'id', isPrimaryKey: true }, { name: 'title' }, { name: 'secret' }],
		});
		await Sealed.put('s-1', { id: 's-1', title: 'old', secret: 'kept' });
		const sealedUser = {
			role: {
				permission: {
					test: {
						tables: {
							AttrPermSealed: {
								read: true,
								insert: true,
								update: true,
								delete: false,
								attribute_permissions: [
									{ attribute_name: 'title', read: true, insert: true, update: true },
									{ attribute_name: 'dropped', read: true, insert: true, update: true },
								],
							},
						},
					},
				},
			},
		};
		await Sealed.put('s-1', { title: 'new' }, { user: sealedUser, authorize: true });
		assert.deepEqual(JSON.parse(JSON.stringify(await Sealed.get('s-1'))), { id: 's-1', title: 'new', secret: 'kept' });
	});

	it('a restricted full put omitting a required attribute the role may update is rejected', async function () {
		const Required = table({
			table: 'AttrPermRequired',
			database: 'test',
			attributes: [
				{ name: 'id', isPrimaryKey: true },
				{ name: 'title', type: 'String', nullable: false },
				{ name: 'note' },
			],
		});
		await Required.put('r-1', { id: 'r-1', title: 'kept', note: 'n' });
		const requiredUser = {
			role: {
				permission: {
					test: {
						tables: {
							AttrPermRequired: {
								read: true,
								insert: true,
								update: true,
								delete: false,
								attribute_permissions: [
									{ attribute_name: 'title', read: true, insert: true, update: true },
									{ attribute_name: 'note', read: true, insert: true, update: true },
								],
							},
						},
					},
				},
			},
		};
		await assert.rejects(
			async () => Required.put('r-1', { note: 'changed' }, { user: requiredUser, authorize: true }),
			/title is required/
		);
		assert.equal((await Required.get('r-1')).title, 'kept');
	});

	it('a sealed table grants no primary key from an undeclared listed attribute', async function () {
		const Sealed = table({
			table: 'AttrPermSealedKey',
			database: 'test',
			sealed: true,
			attributes: [{ name: 'id', isPrimaryKey: true }, { name: 'title' }],
		});
		await Sealed.put('sk-1', { id: 'sk-1', title: 'hidden' });
		const user = {
			role: {
				permission: {
					test: {
						tables: {
							AttrPermSealedKey: {
								read: true,
								insert: false,
								update: false,
								delete: false,
								attribute_permissions: [{ attribute_name: 'dropped', read: true, insert: false, update: false }],
							},
						},
					},
				},
			},
		};
		const request = { user, authorize: true, id: 'sk-1' };
		assert.deepEqual(JSON.parse(JSON.stringify(await Sealed.get(request, request))), {});
	});
});
