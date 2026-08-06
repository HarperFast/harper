// Default-mode (loadAsInstance !== false) array PUT: `Class.put(batch, context)` must keep the
// collection target the argument normalization inferred, and every element must be dispatched the
// same way whether `getResource()` resolves synchronously or asynchronously (harper#2000).
require('../testUtils');
const assert = require('node:assert');
const { setupTestDBPath } = require('../testUtils');
const { table } = require('#src/resources/databases');
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
		// Whole records, not a projection: the defect staged the request context as record data, so
		// anything the dispatch leaks into the element shows up as an extra attribute here.
		const stored = (await recordsOf('async-element'))
			.map((record) => ({ ...record }))
			.sort((a, b) => (a.id < b.id ? -1 : 1));
		assert.deepStrictEqual(stored, [
			{ id: 'async-element-a', kind: 'async-element', label: 'one' },
			{ id: 'async-element-b', kind: 'async-element', label: 'two' },
		]);
	});
});
