// Default-mode (loadAsInstance !== false) array PUT: `Class.put(batch, context)` must keep the
// collection target the argument normalization inferred, and every element must be dispatched the
// same way whether `getResource()` resolves synchronously or asynchronously.
require('../testUtils');
const assert = require('node:assert');
const { setupTestDBPath } = require('../testUtils');
const { table } = require('#src/resources/databases');
const { Resource } = require('#src/resources/Resource');
const { RequestTarget } = require('#src/resources/RequestTarget');
const { setMainIsWorker } = require('#js/server/threads/manageThreads');

async function fromAsync(iterable) {
	const results = [];
	for await (const value of iterable) results.push(value);
	return results;
}

describe('default-mode array put normalization', () => {
	let Docs;
	let alice;

	before(function () {
		setupTestDBPath();
		setMainIsWorker(true);
		Docs = table({
			table: 'ArrayPutDocs',
			database: 'test',
			attributes: [{ name: 'id', isPrimaryKey: true }, { name: 'kind', indexed: true }, { name: 'label' }],
		});
		alice = {
			username: 'alice',
			role: {
				permission: {
					test: { tables: { ArrayPutDocs: { read: true, insert: true, update: true, delete: true } } },
				},
			},
		};
	});

	async function recordsOf(kind) {
		return fromAsync(Docs.search(new RequestTarget(`?kind=${kind}`), {}));
	}

	async function idsOf(kind) {
		return (await recordsOf(kind)).map((record) => record.id).sort();
	}

	it('keeps one collection-entry allowCreate verdict for an array put', async function () {
		const createCalls = [];
		let updateCalls = 0;
		class InstancePut extends Docs {
			allowCreate(_user, batch) {
				createCalls.push({ batch, owner: this.owner });
				return true;
			}
			allowUpdate() {
				updateCalls++;
				return false;
			}
		}
		const batch = [
			{ id: 'instance-put-a', kind: 'instance-put' },
			{ id: 'instance-put-b', kind: 'instance-put' },
		];
		await InstancePut.put(batch, { user: alice, authorize: true });
		assert.strictEqual(createCalls.length, 1);
		assert.strictEqual(createCalls[0].batch, batch);
		assert.strictEqual(createCalls[0].owner, undefined);
		assert.strictEqual(updateCalls, 0);
		assert.deepStrictEqual(await idsOf('instance-put'), ['instance-put-a', 'instance-put-b']);
	});

	it('dispatches a custom put() override once per element, not once with the batch', async function () {
		const calls = [];
		class OverridePut extends Docs {
			put(data, target) {
				calls.push({ isArray: Array.isArray(data), id: data?.id, targetIsCollection: target?.isCollection });
				return super.put(data, target);
			}
		}
		await OverridePut.put(
			[
				{ id: 'override-a', kind: 'override' },
				{ id: 'override-b', kind: 'override' },
			],
			{ user: alice }
		);
		assert.deepStrictEqual(calls, [
			{ isArray: false, id: 'override-a', targetIsCollection: true },
			{ isArray: false, id: 'override-b', targetIsCollection: true },
		]);
		assert.deepStrictEqual(await idsOf('override'), ['override-a', 'override-b']);
	});

	// The one shape whose whole-array `put()` worked programmatically before this change; it now
	// matches what the same class already got from a collection target.
	it('fans out for a plain non-Table Resource the same way a collection target does', async function () {
		const programmatic = [];
		const viaTarget = [];
		function widgetClass(calls) {
			return class Widget extends Resource {
				static primaryKey = 'id';
				put(data) {
					calls.push(Array.isArray(data) ? data.map((element) => element.id) : data.id);
					return data;
				}
			};
		}
		await widgetClass(programmatic).put([{ id: 'w1' }, { id: 'w2' }], {});
		const target = new RequestTarget();
		target.id = null;
		target.isCollection = true;
		await widgetClass(viaTarget).put(target, [{ id: 'w1' }, { id: 'w2' }], {});
		assert.deepStrictEqual(programmatic, ['w1', 'w2']);
		assert.deepStrictEqual(programmatic, viaTarget);
	});

	it("resolves to each element's own result, in request order", async function () {
		class Widget extends Resource {
			static primaryKey = 'id';
			put(data) {
				return data;
			}
		}
		const first = { id: 'order-1' };
		const second = { id: 'order-2' };
		const third = { id: 'order-3' };
		const resolved = await Widget.put([first, second, third], {});
		assert.strictEqual(resolved.length, 3);
		assert.strictEqual(resolved[0], first);
		assert.strictEqual(resolved[1], second);
		assert.strictEqual(resolved[2], third);
	});

	it('writes each element when getResource resolves asynchronously', async function () {
		class AsyncResolve extends Docs {
			static getResource(target, context, options) {
				return Promise.resolve(super.getResource(target, context, options));
			}
		}
		await AsyncResolve.put(
			[
				{ id: 'async-element-a', kind: 'async-element', label: 'one' },
				{ id: 'async-element-b', kind: 'async-element', label: 'two' },
			],
			{ user: alice }
		);
		// Whole records, not a projection: anything the dispatch leaks in shows up as an extra attribute.
		const stored = (await recordsOf('async-element'))
			.map((record) => ({ ...record }))
			.sort((a, b) => (a.id < b.id ? -1 : 1));
		assert.deepStrictEqual(stored, [
			{ id: 'async-element-a', kind: 'async-element', label: 'one' },
			{ id: 'async-element-b', kind: 'async-element', label: 'two' },
		]);
	});
});
