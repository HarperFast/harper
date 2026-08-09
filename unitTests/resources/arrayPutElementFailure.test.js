// Failure handling for the built-in array PUT fan-out: a batch fails whole, abandons no sibling
// write, commits no element, and classifies a malformed body as the client's error.
require('../testUtils');
const assert = require('node:assert');
const { setupTestDBPath } = require('../testUtils');
const { table } = require('#src/resources/databases');
const { Resource } = require('#src/resources/Resource');
const { RequestTarget } = require('#src/resources/RequestTarget');
const { setMainIsWorker } = require('#js/server/threads/manageThreads');

// An unhandled rejection is reported a turn or two after the promise is abandoned, so give the
// loop time to fire before asserting it did not.
async function drainRejections(settleMs = 50) {
	for (let turn = 0; turn < 5; turn++) await new Promise((resolve) => setImmediate(resolve));
	await new Promise((resolve) => setTimeout(resolve, settleMs));
}

describe('array put element failure', () => {
	let Docs;

	before(function () {
		setupTestDBPath();
		setMainIsWorker(true);
		Docs = table({
			table: 'ArrayPutFailureDocs',
			database: 'test',
			attributes: [
				{ name: 'id', isPrimaryKey: true },
				{ name: 'kind', indexed: true },
			],
		});
	});

	function collectionTarget() {
		const target = new RequestTarget();
		target.id = null;
		target.isCollection = true;
		return target;
	}

	async function idsOf(kind) {
		const ids = [];
		for await (const record of Docs.search(new RequestTarget(`?kind=${kind}`), {})) ids.push(record.id);
		return ids.sort();
	}

	// Runs `attempt` with a private unhandledRejection listener and returns what escaped.
	async function withRejectionWatch(attempt, settleMs) {
		const unhandled = [];
		const listener = (reason) => unhandled.push(reason?.message ?? String(reason));
		process.on('unhandledRejection', listener);
		let error;
		try {
			await attempt();
		} catch (thrown) {
			error = thrown;
		}
		await drainRejections(settleMs);
		process.off('unhandledRejection', listener);
		return { error, unhandled };
	}

	it('fails the batch and abandons nothing when an earlier write rejects and a later element throws', async function () {
		class RejectingFirstElement extends Docs {
			put(record, target) {
				if (record?.id === 'fail-reject') return Promise.reject(new Error('element write failed'));
				return super.put(record, target);
			}
		}
		const { error, unhandled } = await withRejectionWatch(() =>
			RejectingFirstElement.put(collectionTarget(), [{ id: 'fail-reject', kind: 'fail-mixed' }, null], {})
		);
		// Not the sibling's rejection: the malformed element is what the caller has to fix.
		assert.match(error?.message ?? '', /index 1 is null/);
		assert.strictEqual(error.statusCode, 400);
		assert.deepStrictEqual(unhandled, []);
		assert.deepStrictEqual(await idsOf('fail-mixed'), []);
	});

	it('rejects the whole batch for a null element, persisting no earlier element', async function () {
		const { error, unhandled } = await withRejectionWatch(() =>
			Docs.put(collectionTarget(), [{ id: 'fail-null-a', kind: 'fail-null' }, null], {})
		);
		// A malformed body is the client's error: named position, 400, no engine wording.
		assert.match(error?.message ?? '', /Array element at index 1 is null/);
		assert.strictEqual(error.statusCode, 400);
		assert.deepStrictEqual(unhandled, []);
		assert.deepStrictEqual(await idsOf('fail-null'), []);
	});

	it('rejects the whole batch for an element with no primary key, persisting no earlier element', async function () {
		const { error, unhandled } = await withRejectionWatch(() =>
			Docs.put(collectionTarget(), [{ id: 'fail-pk-a', kind: 'fail-pk' }, { kind: 'fail-pk' }], {})
		);
		assert.match(error?.message ?? '', /Invalid primary key/);
		assert.deepStrictEqual(unhandled, []);
		assert.deepStrictEqual(await idsOf('fail-pk'), []);
	});

	// With `Promise.all` the slower element committed outside the failed batch. The watch has to
	// outlast that element or this test passes by not looking.
	it('does not partially apply a batch when an element rejects while an async sibling resolves', async function () {
		let latePuts = 0;
		class AsyncMixed extends Docs {
			static getResource(target, context, options) {
				const resource = super.getResource(target, context, options);
				if (target?.id === 'async-late') return new Promise((resolve) => setTimeout(() => resolve(resource), 100));
				return Promise.resolve(resource);
			}
			put(record, target) {
				if (record?.id === 'async-reject') return Promise.reject(new Error('async element write failed'));
				if (record?.id === 'async-late') latePuts++;
				return super.put(record, target);
			}
		}
		const { error, unhandled } = await withRejectionWatch(
			() =>
				AsyncMixed.put(
					collectionTarget(),
					[
						{ id: 'async-reject', kind: 'fail-async' },
						{ id: 'async-late', kind: 'fail-async' },
					],
					{}
				),
			400
		);
		assert.strictEqual(error?.message, 'async element write failed');
		assert.strictEqual(latePuts, 1, 'the late element must have run inside the watch window');
		assert.deepStrictEqual(unhandled, []);
		// Past the query layer: the partial-apply bug committed this row.
		assert.strictEqual(Docs.primaryStore.getSync('async-late'), undefined);
		assert.deepStrictEqual(await idsOf('fail-async'), []);
	});

	// Index, not arrival order: the later index rejects FIRST here, so this cannot pass by coincidence.
	it('reports the earliest-index failure even when a later element fails sooner', async function () {
		const order = [];
		class TwoFailures extends Docs {
			put(record, target) {
				if (record?.id === 'multi-b')
					return new Promise((_resolve, reject) =>
						setTimeout(() => {
							order.push('multi-b');
							reject(new Error('second element failed'));
						}, 80)
					);
				if (record?.id === 'multi-c') {
					order.push('multi-c');
					return Promise.reject(new Error('third element failed'));
				}
				return super.put(record, target);
			}
		}
		const { error, unhandled } = await withRejectionWatch(() =>
			TwoFailures.put(
				collectionTarget(),
				[
					{ id: 'multi-a', kind: 'fail-multi' },
					{ id: 'multi-b', kind: 'fail-multi' },
					{ id: 'multi-c', kind: 'fail-multi' },
				],
				{}
			)
		);
		assert.deepStrictEqual(order, ['multi-c', 'multi-b']);
		assert.strictEqual(error?.message, 'second element failed');
		assert.deepStrictEqual(unhandled, []);
		assert.deepStrictEqual(await idsOf('fail-multi'), []);
	});

	// The fan-out must answer 405 like the single-record path, not a bare TypeError, for a resource
	// class that implements no `put`.
	it('answers 405 for a resource with no put(), on both the array and single paths', async function () {
		class ReadOnly extends Resource {
			static primaryKey = 'id';
			get() {
				return {};
			}
		}
		// The single-record path throws synchronously out of the action; the fan-out surfaces a rejected
		// promise. Both shapes reach an HTTP caller as the same 405, so accept either here.
		const attempt = async (call) => {
			try {
				await call();
			} catch (error) {
				return error;
			}
			return null;
		};
		const single = await attempt(() => ReadOnly.put({ id: 'ro-1' }, {}));
		const batch = await attempt(() => ReadOnly.put(collectionTarget(), [{ id: 'ro-2' }, { id: 'ro-3' }], {}));
		for (const error of [single, batch]) {
			assert.strictEqual(error?.statusCode, 405, `expected 405, got ${error?.message}`);
			assert.match(error.message, /does not have a put method/);
		}
	});

	it('still writes a well-formed batch', async function () {
		await Docs.put(
			collectionTarget(),
			[
				{ id: 'fail-ok-a', kind: 'fail-ok' },
				{ id: 'fail-ok-b', kind: 'fail-ok' },
			],
			{}
		);
		assert.deepStrictEqual(await idsOf('fail-ok'), ['fail-ok-a', 'fail-ok-b']);
	});
});
