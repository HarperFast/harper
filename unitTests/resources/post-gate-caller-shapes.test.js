// Caller shapes across two v5.2.0 changes for classes extending Resource or a table: the bare
// POST gate in Resource.ts transactional() (0b98e8918, e157c21ec, PR #1807; 1b0c12b51, 49a9319f9,
// PR #1956) and the OpenAPI request-contract skip in openApi.ts. "v5.1.26:" notes the prior result
// where it differs. `new RequestTarget('')` is the target server/REST.ts builds for `POST /Name`
// (no trailing slash): getMatch() leaves relativeURL '' on an exact resource-path match.
require('../testUtils');
const assert = require('node:assert');
const { setupTestDBPath } = require('../testUtils');
const { setMainIsWorker } = require('#js/server/threads/manageThreads');
const { table } = require('#src/resources/databases');
const { Resource } = require('#src/resources/Resource');
const { Resources } = require('#src/resources/Resources');
const { RequestTarget } = require('#src/resources/RequestTarget');
const { generateJsonApi } = require('#src/resources/openApi');

const bare = () => new RequestTarget('');
const TRAILING_SLASH_404 = (error) => error.statusCode === 404 && /trailing slash is required/.test(error.message);

function capture(receiver, target, data, resource) {
	return {
		receiver,
		targetIsRequestTarget: target instanceof RequestTarget,
		dataValue: data?.value,
		resourceIsCollection: resource.isCollection,
		resourceId: resource.getId(),
		targetId: target.id,
		targetIsCollection: target.isCollection,
	};
}

describe('POST caller shapes across the v5.2.0 bare-collection gate', () => {
	let PostShapes;

	before(() => {
		setupTestDBPath();
		setMainIsWorker(true);
		PostShapes = table({
			table: 'PostShapes',
			database: 'test',
			attributes: [
				{ name: 'id', type: 'String', isPrimaryKey: true },
				{ name: 'value', type: 'String' },
			],
		});
	});

	describe('no post() override (prototype.post is Resource.prototype.post): bare POST is 404 (v5.1.26: 405 "does not have a post method")', () => {
		it('plain Resource subclass, instance mode', async () => {
			class NoPost extends Resource {
				get() {
					return 'read';
				}
			}
			await assert.rejects(async () => NoPost.post(bare(), { value: 'x' }, {}), TRAILING_SLASH_404);
		});

		it('plain Resource subclass, loadAsInstance = false', async () => {
			class NoPostStatic extends Resource {
				static loadAsInstance = false;
			}
			await assert.rejects(async () => NoPostStatic.post(bare(), { value: 'x' }, {}), TRAILING_SLASH_404);
		});

		it('exported table with no subclass', async () => {
			await assert.rejects(async () => PostShapes.post(bare(), { value: 'x' }, {}), TRAILING_SLASH_404);
		});

		it('table subclass, instance mode', async () => {
			class TableNoPost extends PostShapes {}
			await assert.rejects(async () => TableNoPost.post(bare(), { value: 'x' }, {}), TRAILING_SLASH_404);
		});

		it('table subclass, loadAsInstance = false', async () => {
			class TableNoPostStatic extends PostShapes {
				static loadAsInstance = false;
			}
			await assert.rejects(async () => TableNoPostStatic.post(bare(), { value: 'x' }, {}), TRAILING_SLASH_404);
		});

		it('the 404 is thrown synchronously, so a promise .catch() on X.post(...) does not see it (v5.1.26: rejected promise)', () => {
			assert.throws(() => PostShapes.post(bare(), { value: 'x' }, {}), TRAILING_SLASH_404);
		});
	});

	describe('prototype post() override, instance mode: bare POST is normalized to the collection', () => {
		// v5.1.26 dispatched the same override with resource and target isCollection/id all undefined.
		it('own override sees a collection target with a null id', async () => {
			class OwnPost extends Resource {
				post(data, target) {
					return capture('own', target, data, this);
				}
			}
			assert.deepStrictEqual(await OwnPost.post(bare(), { value: 'x' }, {}), {
				receiver: 'own',
				targetIsRequestTarget: true,
				dataValue: 'x',
				resourceIsCollection: true,
				resourceId: null,
				targetId: null,
				targetIsCollection: true,
			});
		});

		it('override inherited from an intermediate class is treated exactly like an own override', async () => {
			class Intermediate extends Resource {
				post(data, target) {
					return capture('intermediate', target, data, this);
				}
			}
			class Leaf extends Intermediate {}
			assert.deepStrictEqual(await Leaf.post(bare(), { value: 'x' }, {}), {
				receiver: 'intermediate',
				targetIsRequestTarget: true,
				dataValue: 'x',
				resourceIsCollection: true,
				resourceId: null,
				targetId: null,
				targetIsCollection: true,
			});
		});

		it('static Collection class receives the bare POST (v5.1.26: the base class received it)', async () => {
			class WithCollection extends Resource {
				post() {
					return 'base';
				}
			}
			WithCollection.Collection = class extends WithCollection {
				post() {
					return 'collection';
				}
			};
			assert.strictEqual(await WithCollection.post(bare(), { value: 'x' }, {}), 'collection');
		});

		it('table subclass override delegating to super.post creates a record (v5.1.26: 405)', async () => {
			class TableSuperPost extends PostShapes {
				post(data) {
					return super.post(data);
				}
			}
			const id = await TableSuperPost.post(bare(), { value: 'created-by-bare-post' }, {});
			assert.strictEqual((await PostShapes.get(id)).value, 'created-by-bare-post');
		});

		it('inherited super.post delegation on a table creates a record (v5.1.26: 405)', async () => {
			class Intermediate extends PostShapes {
				post(data) {
					return super.post(data);
				}
			}
			class Leaf extends Intermediate {}
			const id = await Leaf.post(bare(), { value: 'inherited-bare-post' }, {});
			assert.strictEqual((await PostShapes.get(id)).value, 'inherited-bare-post');
		});

		it('plain Resource override delegating to super.post still rejects with 405 (v5.1.26: 405, message named post)', async () => {
			class PlainSuperPost extends Resource {
				post(data) {
					return super.post(data);
				}
			}
			await assert.rejects(
				async () => PlainSuperPost.post(bare(), { value: 'x' }, {}),
				(error) => error.statusCode === 405 && /does not have a create method/.test(error.message)
			);
		});
	});

	describe('authorization of bare POST through a table subclass with an instance post() override', () => {
		let TableOwnPost;
		const userWith = (insert, update) => ({
			role: { permission: { test: { tables: { PostShapes: { read: true, insert, update, delete: false } } } } },
		});

		before(() => {
			TableOwnPost = class TableOwnPost extends PostShapes {
				post() {
					return 'handled';
				}
			};
		});

		it('requires insert permission (v5.1.26: insert-only user got 403)', async () => {
			const result = await TableOwnPost.post(bare(), { value: 'x' }, { user: userWith(true, false), authorize: true });
			assert.strictEqual(result, 'handled');
		});

		it('no longer accepts update-only permission (v5.1.26: update-only user was allowed)', async () => {
			await assert.rejects(
				async () => TableOwnPost.post(bare(), { value: 'x' }, { user: userWith(false, true), authorize: true }),
				/Unauthorized access/
			);
		});
	});

	describe('prototype post() override, loadAsInstance = false: dispatched with a non-collection target', () => {
		// v5.1.26 passed the same target with id and isCollection undefined.
		it('own override receives id null and isCollection false', async () => {
			class StaticOwnPost extends Resource {
				static loadAsInstance = false;
				post(target, data) {
					return capture('own', target, data, this);
				}
			}
			assert.deepStrictEqual(await StaticOwnPost.post(bare(), { value: 'x' }, {}), {
				receiver: 'own',
				targetIsRequestTarget: true,
				dataValue: 'x',
				resourceIsCollection: undefined,
				resourceId: null,
				targetId: null,
				targetIsCollection: false,
			});
		});

		it('inherited override receives id null and isCollection false', async () => {
			class Intermediate extends Resource {
				static loadAsInstance = false;
				post(target, data) {
					return capture('intermediate', target, data, this);
				}
			}
			class Leaf extends Intermediate {}
			assert.deepStrictEqual(await Leaf.post(bare(), { value: 'x' }, {}), {
				receiver: 'intermediate',
				targetIsRequestTarget: true,
				dataValue: 'x',
				resourceIsCollection: undefined,
				resourceId: null,
				targetId: null,
				targetIsCollection: false,
			});
		});

		it('table subclass override delegating to super.post still rejects with 405 (unchanged)', async () => {
			class StaticTableSuperPost extends PostShapes {
				static loadAsInstance = false;
				post(target, data) {
					return super.post(target, data);
				}
			}
			await assert.rejects(
				async () => StaticTableSuperPost.post(bare(), { value: 'x' }, {}),
				(error) => error.statusCode === 405
			);
		});
	});

	describe('post defined outside the prototype', () => {
		it('class-field post is invisible to the gate: bare POST is 404 (v5.1.26: the field handled it)', async () => {
			class FieldPost extends Resource {
				post = () => 'field';
			}
			await assert.rejects(async () => FieldPost.post(bare(), { value: 'x' }, {}), TRAILING_SLASH_404);
			assert.strictEqual(await FieldPost.post(new RequestTarget('/'), { value: 'x' }, {}), 'field');
		});

		it('class-field post on a table subclass: bare POST is 404 (v5.1.26: the field handled it)', async () => {
			class TableFieldPost extends PostShapes {
				post = () => 'field';
			}
			await assert.rejects(async () => TableFieldPost.post(bare(), { value: 'x' }, {}), TRAILING_SLASH_404);
		});

		it('static post override bypasses the gate and receives id null, isCollection false (v5.1.26: both undefined)', async () => {
			class StaticMethodPost extends Resource {
				static post(target) {
					return { id: target.id, isCollection: target.isCollection };
				}
			}
			assert.deepStrictEqual(await StaticMethodPost.post(bare(), { value: 'x' }, {}), {
				id: null,
				isCollection: false,
			});
		});
	});

	describe('in-process X.post(data, context) with no primary key builds the same target as POST /Name', () => {
		it('table without a post override rejects with the trailing-slash 404 (v5.1.26: 405)', async () => {
			class TableNoPost extends PostShapes {}
			await assert.rejects(async () => TableNoPost.post({ value: 'x' }, {}), TRAILING_SLASH_404);
		});

		it('table subclass override delegating to super.post creates a record (v5.1.26: 405)', async () => {
			class TableSuperPost extends PostShapes {
				post(data) {
					return super.post(data);
				}
			}
			const id = await TableSuperPost.post({ value: 'data-and-context' }, {});
			assert.strictEqual((await PostShapes.get(id)).value, 'data-and-context');
		});
	});

	describe('requests that never reach the gate (identical in v5.1.26)', () => {
		it('POST /Name/ creates through a table and its subclass', async () => {
			class TableNoPost extends PostShapes {}
			for (const Class of [PostShapes, TableNoPost]) {
				const id = await Class.post(new RequestTarget('/'), { value: 'slash' }, {});
				assert.strictEqual((await PostShapes.get(id)).value, 'slash');
			}
		});

		it('POST /Name?query is a collection target and creates', async () => {
			const target = new RequestTarget('?source=import');
			assert.strictEqual(target.isCollection, true);
			const id = await PostShapes.post(target, { value: 'query-string' }, {});
			assert.strictEqual((await PostShapes.get(id)).value, 'query-string');
		});

		it('POST /Name/id rejects with 405 on a table without a post override', async () => {
			await assert.rejects(
				async () => PostShapes.post(new RequestTarget('/abc'), { value: 'x' }, {}),
				(error) => {
					return error.statusCode === 405 && /does not have a post method/.test(error.message);
				}
			);
		});

		it('POST /Name/id dispatches an instance override with the record id', async () => {
			class OwnPost extends Resource {
				post(data, target) {
					return capture('own', target, data, this);
				}
			}
			const seen = await OwnPost.post(new RequestTarget('/abc'), { value: 'x' }, {});
			assert.strictEqual(seen.dataValue, 'x');
			assert.strictEqual(seen.resourceId, 'abc');
			assert.strictEqual(seen.targetId, 'abc');
		});

		it('in-process X.post(data) and X.post(null, data) create; X.post(id, data) rejects with 405', async () => {
			class TableNoPost extends PostShapes {}
			const fromData = await TableNoPost.post({ value: 'in-process-data' });
			assert.strictEqual((await PostShapes.get(fromData)).value, 'in-process-data');
			const fromNull = await TableNoPost.post(null, { value: 'in-process-null' });
			assert.strictEqual((await PostShapes.get(fromNull)).value, 'in-process-null');
			await assert.rejects(
				async () => TableNoPost.post('abc', { value: 'x' }),
				(error) => error.statusCode === 405
			);
		});

		it('in-process X.post(new RequestTarget(), data) leaves id undefined, so it rejects with 405, not the gate 404', async () => {
			await assert.rejects(
				async () => PostShapes.post(new RequestTarget(), { value: 'x' }),
				(error) => error.statusCode === 405 && /does not have a post method/.test(error.message)
			);
		});

		it('in-process X.post(data) on a class without post support rejects with 405, not the gate 404', async () => {
			class NoPost extends Resource {}
			await assert.rejects(
				async () => NoPost.post({ value: 'x' }),
				(error) => error.statusCode === 405
			);
		});
	});
});

describe('OpenAPI caller shapes across the v5.2.0 request-contract emitter', () => {
	let OpenApiShapes, paths;

	before(() => {
		setupTestDBPath();
		setMainIsWorker(true);
		OpenApiShapes = table({
			table: 'OpenApiShapes',
			database: 'test',
			attributes: [
				{ name: 'id', type: 'String', isPrimaryKey: true },
				{ name: 'value', type: 'String' },
			],
		});
		const resources = new Resources();
		resources.set('OpenApiShapes', OpenApiShapes);
		resources.set('TableSubclass', class TableSubclass extends OpenApiShapes {});
		resources.set(
			'PlainGet',
			class PlainGet extends Resource {
				get() {}
			}
		);
		resources.set(
			'PlainPost',
			class PlainPost extends Resource {
				get() {}
				post() {}
			}
		);
		resources.set(
			'FieldPost',
			class FieldPost extends Resource {
				post = () => {};
			}
		);
		resources.set(
			'widget/:id',
			class Widget extends Resource {
				get() {}
				post() {}
			}
		);
		resources.set(
			'CollidingContract',
			class CollidingContract extends Resource {
				static requestContract = {};
				get() {}
				post() {}
			}
		);
		resources.set(
			'gadget/:id',
			class Gadget extends Resource {
				static inputSchemas = { post: { body: { type: 'object', properties: { name: { type: 'string' } } } } };
				post() {}
			}
		);
		paths = generateJsonApi(resources, 'https://harper.fast').paths;
	});

	// The document for these shapes is identical to v5.1.26 apart from info.version.
	it('table and table subclass keep the table-CRUD paths', () => {
		for (const name of ['OpenApiShapes', 'TableSubclass']) {
			assert.deepStrictEqual(Object.keys(paths[`/${name}/`]).sort(), ['delete', 'get', 'options', 'post']);
			assert.deepStrictEqual(Object.keys(paths[`/${name}/{id}`]).sort(), ['delete', 'get', 'options', 'patch', 'put']);
			assert.ok(paths[`/${name}/{id}.{property}`]);
		}
	});

	it('plain Resource lists POST on the collection path only when post() is on the prototype', () => {
		assert.deepStrictEqual(Object.keys(paths['/PlainGet/']).sort(), ['get', 'options']);
		assert.deepStrictEqual(Object.keys(paths['/PlainPost/']).sort(), ['get', 'options', 'post']);
		assert.deepStrictEqual(Object.keys(paths['/FieldPost/']).sort(), ['options']);
	});

	it('parameterised route without contract statics keeps a loosely typed POST body', () => {
		assert.deepStrictEqual(paths['/widget/{id}'].post.requestBody.content['application/json'].schema, {
			type: 'object',
		});
	});

	it('a class declaring its own static requestContract moves to the contract emitter (v5.1.26: table-CRUD paths)', () => {
		assert.strictEqual(paths['/CollidingContract/'], undefined);
		assert.strictEqual(paths['/CollidingContract/{id}'], undefined);
		assert.deepStrictEqual(Object.keys(paths['/CollidingContract']).sort(), ['get', 'options', 'post']);
	});

	it('a parameterised route declaring its own static inputSchemas gets that body schema (v5.1.26: { type: object })', () => {
		assert.deepStrictEqual(paths['/gadget/{id}'].post.requestBody.content['application/json'].schema, {
			type: 'object',
			properties: { name: { type: 'string' } },
		});
	});
});
