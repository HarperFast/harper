// Pins, per caller code shape, what v5.2.0 changed for classes extending Resource or a table:
// - the bare-collection POST gate in Resource.ts transactional() (`POST /Name`, no trailing slash);
// - the OpenAPI skip of request-contract resources in openApi.ts generateJsonApi().
// Old (v5.1.26) behavior is stated per test; it was measured by running these shapes against a
// v5.1.26 build. The gate came from 0b98e8918 + e157c21ec (harper#678, PR #1807) and 1b0c12b51 +
// 49a9319f9 (PR #1956), all first released in v5.2.0; v5.2.0 and main behave identically here.
// `new RequestTarget('')` is the target server/REST.ts builds for `POST /Name`: getMatch() leaves
// relativeURL '' when the URL matches the resource path exactly.
require('../testUtils');
const assert = require('node:assert/strict');
const { setupTestDBPath } = require('../testUtils');
const { setMainIsWorker } = require('#js/server/threads/manageThreads');
const { table } = require('#src/resources/databases');
const { Resource } = require('#src/resources/Resource');
const { Resources } = require('#src/resources/Resources');
const { RequestTarget } = require('#src/resources/RequestTarget');
const { generateJsonApi } = require('#src/resources/openApi');

const bare = () => new RequestTarget('');
const TRAILING_SLASH_404 = (error) => error.statusCode === 404 && /trailing slash is required/.test(error.message);

function capture(receiver, first, second, resource) {
	const target = [first, second].find((argument) => argument instanceof URLSearchParams);
	return {
		receiver,
		resourceIsCollection: resource.isCollection,
		resourceId: resource.getId(),
		targetId: target?.id,
		targetIsCollection: target?.isCollection,
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

	describe('no post() anywhere on the prototype chain: bare POST is 404 (v5.1.26: 405 "does not have a post method")', () => {
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
					return capture('own', data, target, this);
				}
			}
			assert.deepEqual(await OwnPost.post(bare(), { value: 'x' }, {}), {
				receiver: 'own',
				resourceIsCollection: true,
				resourceId: null,
				targetId: null,
				targetIsCollection: true,
			});
		});

		it('override inherited from an intermediate class is treated exactly like an own override', async () => {
			class Intermediate extends Resource {
				post(data, target) {
					return capture('intermediate', data, target, this);
				}
			}
			class Leaf extends Intermediate {}
			assert.deepEqual(await Leaf.post(bare(), { value: 'x' }, {}), {
				receiver: 'intermediate',
				resourceIsCollection: true,
				resourceId: null,
				targetId: null,
				targetIsCollection: true,
			});
		});

		it('table subclass override delegating to super.post creates a record (v5.1.26: 405)', async () => {
			class TableSuperPost extends PostShapes {
				post(data) {
					return super.post(data);
				}
			}
			const id = await TableSuperPost.post(bare(), { value: 'created-by-bare-post' }, {});
			assert.equal((await PostShapes.get(id)).value, 'created-by-bare-post');
		});

		it('inherited super.post delegation on a table creates a record (v5.1.26: 405)', async () => {
			class Intermediate extends PostShapes {
				post(data) {
					return super.post(data);
				}
			}
			class Leaf extends Intermediate {}
			const id = await Leaf.post(bare(), { value: 'inherited-bare-post' }, {});
			assert.equal((await PostShapes.get(id)).value, 'inherited-bare-post');
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
			assert.equal(result, 'handled');
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
			const seen = await StaticOwnPost.post(bare(), { value: 'x' }, {});
			assert.equal(seen.receiver, 'own');
			assert.equal(seen.targetId, null);
			assert.equal(seen.targetIsCollection, false);
		});

		it('inherited override receives id null and isCollection false', async () => {
			class Intermediate extends Resource {
				static loadAsInstance = false;
				post(target, data) {
					return capture('intermediate', target, data, this);
				}
			}
			class Leaf extends Intermediate {}
			const seen = await Leaf.post(bare(), { value: 'x' }, {});
			assert.equal(seen.receiver, 'intermediate');
			assert.equal(seen.targetId, null);
			assert.equal(seen.targetIsCollection, false);
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
			assert.equal(await FieldPost.post(new RequestTarget('/'), { value: 'x' }, {}), 'field');
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
			assert.deepEqual(await StaticMethodPost.post(bare(), { value: 'x' }, {}), { id: null, isCollection: false });
		});
	});

	describe('requests that never reach the gate (identical in v5.1.26)', () => {
		it('POST /Name/ creates through a table and its subclass', async () => {
			class TableNoPost extends PostShapes {}
			for (const Class of [PostShapes, TableNoPost]) {
				const id = await Class.post(new RequestTarget('/'), { value: 'slash' }, {});
				assert.equal((await PostShapes.get(id)).value, 'slash');
			}
		});

		it('POST /Name?query is a collection target and creates', async () => {
			const target = new RequestTarget('?source=import');
			assert.equal(target.isCollection, true);
			const id = await PostShapes.post(target, { value: 'query-string' }, {});
			assert.equal((await PostShapes.get(id)).value, 'query-string');
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
					return capture('own', data, target, this);
				}
			}
			const seen = await OwnPost.post(new RequestTarget('/abc'), { value: 'x' }, {});
			assert.equal(seen.resourceId, 'abc');
			assert.equal(seen.targetId, 'abc');
		});

		it('in-process X.post(data) and X.post(null, data) create; X.post(id, data) rejects with 405', async () => {
			class TableNoPost extends PostShapes {}
			const fromData = await TableNoPost.post({ value: 'in-process-data' });
			assert.equal((await PostShapes.get(fromData)).value, 'in-process-data');
			const fromNull = await TableNoPost.post(null, { value: 'in-process-null' });
			assert.equal((await PostShapes.get(fromNull)).value, 'in-process-null');
			await assert.rejects(
				async () => TableNoPost.post('abc', { value: 'x' }),
				(error) => error.statusCode === 405
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
			assert.deepEqual(Object.keys(paths[`/${name}/`]).sort(), ['delete', 'get', 'options', 'post']);
			assert.deepEqual(Object.keys(paths[`/${name}/{id}`]).sort(), ['delete', 'get', 'options', 'patch', 'put']);
			assert.ok(paths[`/${name}/{id}.{property}`]);
		}
	});

	it('plain Resource lists POST on the collection path only when post() is on the prototype', () => {
		assert.deepEqual(Object.keys(paths['/PlainGet/']).sort(), ['get', 'options']);
		assert.deepEqual(Object.keys(paths['/PlainPost/']).sort(), ['get', 'options', 'post']);
		assert.deepEqual(Object.keys(paths['/FieldPost/']).sort(), ['options']);
	});

	it('parameterised route without contract statics keeps a loosely typed POST body', () => {
		assert.deepEqual(paths['/widget/{id}'].post.requestBody.content['application/json'].schema, { type: 'object' });
	});

	it('a class declaring its own static requestContract moves to the contract emitter (v5.1.26: table-CRUD paths)', () => {
		assert.equal(paths['/CollidingContract/'], undefined);
		assert.equal(paths['/CollidingContract/{id}'], undefined);
		assert.deepEqual(Object.keys(paths['/CollidingContract']).sort(), ['get', 'options', 'post']);
	});

	it('a parameterised route declaring its own static inputSchemas gets that body schema (v5.1.26: { type: object })', () => {
		assert.deepEqual(paths['/gadget/{id}'].post.requestBody.content['application/json'].schema, {
			type: 'object',
			properties: { name: { type: 'string' } },
		});
	});
});
