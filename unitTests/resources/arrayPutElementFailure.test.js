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

	// An element with no primary key throws inside its own dispatch, with element 0's write already in
	// flight. Earliest index wins, and the loser is kept as the winner's cause rather than lost.
	it('fails the batch and abandons nothing when an earlier write rejects and a later element throws', async function () {
		class RejectingFirstElement extends Docs {
			put(record, target) {
				if (record?.id === 'fail-reject') return Promise.reject(new Error('element write failed'));
				return super.put(record, target);
			}
		}
		const { error, unhandled } = await withRejectionWatch(() =>
			RejectingFirstElement.put(
				collectionTarget(),
				[{ id: 'fail-reject', kind: 'fail-mixed' }, { kind: 'fail-mixed' }],
				{}
			)
		);
		assert.strictEqual(error?.message, 'element write failed');
		assert.deepStrictEqual(unhandled, []);
		assert.deepStrictEqual(await idsOf('fail-mixed'), []);
	});

	// The regression CI caught: which failure a mixed batch reports must not depend on whether an
	// element's `getResource` resolved synchronously or asynchronously. It used to — the synchronous
	// throw was reported directly while the asynchronous one became a rejection ordered by index.
	it('reports the same failure whether the throwing element resolves sync or async', async function () {
		const reported = [];
		for (const asyncResolve of [false, true]) {
			const kind = `fail-prec-${asyncResolve}`;
			class Mixed extends Docs {
				static getResource(target, context, options) {
					const resolved = super.getResource(target, context, options);
					return asyncResolve ? Promise.resolve(resolved) : resolved;
				}
				put(record, target) {
					if (record?.id === 'prec-reject') return Promise.reject(new Error('sibling failed'));
					if (record?.id === 'prec-throw') throw new Error('malformed element');
					return super.put(record, target);
				}
			}
			const { error, unhandled } = await withRejectionWatch(() =>
				Mixed.put(
					collectionTarget(),
					[
						{ id: 'prec-reject', kind },
						{ id: 'prec-throw', kind },
					],
					{}
				)
			);
			assert.deepStrictEqual(unhandled, []);
			assert.deepStrictEqual(await idsOf(kind), []);
			reported.push(error?.message);
		}
		assert.strictEqual(reported[0], reported[1]);
		assert.strictEqual(reported[0], 'sibling failed');
	});

	it('rejects the whole batch for a null element, persisting no earlier element', async function () {
		const { error, unhandled } = await withRejectionWatch(() =>
			Docs.put(collectionTarget(), [{ id: 'fail-null-a', kind: 'fail-null' }, null], {})
		);
		// A malformed body is the client's error: named position, 400, no engine wording. Rejected before
		// anything is dispatched, so it cannot race a sibling and nothing needs unwinding.
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

	// The async dispatch branch has its own `missingMethod` call; cover it separately from the sync one.
	it('answers 405 when an async-resolved element resource has no put()', async function () {
		class AsyncReadOnly extends Resource {
			static primaryKey = 'id';
			static getResource(target, context, options) {
				return Promise.resolve(super.getResource(target, context, options));
			}
			get() {
				return {};
			}
		}
		let error;
		try {
			await AsyncReadOnly.put(collectionTarget(), [{ id: 'aro-1' }], {});
		} catch (thrown) {
			error = thrown;
		}
		assert.strictEqual(error?.statusCode, 405, `expected 405, got ${error?.message}`);
		assert.match(error.message, /does not have a put method/);
	});

	// The value an override throws is never mutated on its way out — no `cause` is welded onto it. A
	// primitive and a frozen error are the shapes that made the previous attempt throw, and a shared
	// error object is the reason the attempt was abandoned rather than guarded further.
	for (const [shape, thrown, expectedIntact] of [
		['a primitive', 'a primitive string error', 'a primitive string error'],
		['a frozen error', Object.freeze(new Error('frozen original')), 'frozen original'],
	]) {
		it(`preserves ${shape} thrown by an override instead of replacing it`, async function () {
			const kind = `fail-prim-${shape.replace(/\W+/g, '-')}`;
			class PrimitiveThrower extends Docs {
				put(record, target) {
					if (record?.id === 'prim-reject') return Promise.reject(new Error('sibling failed'));
					if (record?.id === 'prim-throw') throw thrown;
					return super.put(record, target);
				}
			}
			const { error, unhandled } = await withRejectionWatch(() =>
				PrimitiveThrower.put(
					collectionTarget(),
					[
						{ id: 'prim-reject', kind },
						{ id: 'prim-throw', kind },
					],
					{}
				)
			);
			// Earliest index wins, so the sibling is reported — and the value the override threw is left
			// exactly as it was, never mutated on its way out.
			assert.strictEqual(error?.message, 'sibling failed');
			assert.strictEqual(thrown instanceof Error ? thrown.message : thrown, expectedIntact);
			assert.strictEqual(thrown.cause, undefined);
			assert.deepStrictEqual(unhandled, []);
			assert.deepStrictEqual(await idsOf(kind), []);
		});
	}

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
