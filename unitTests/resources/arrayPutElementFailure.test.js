// A malformed element throws synchronously inside the built-in array PUT dispatch loop, after
// earlier elements' writes are already in flight. Those writes must be settled before the batch
// fails, or a later rejection reaches no handler and becomes an unhandled rejection.
require('../testUtils');
const assert = require('node:assert');
const { setupTestDBPath } = require('../testUtils');
const { table } = require('#src/resources/databases');
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
		assert.ok(error, 'the batch must reject');
		// Not the sibling's rejection: the malformed element is what the caller has to fix. Matched
		// against the sibling's sentinel rather than the malformed element's own message, which for a
		// null dereference is V8's wording and has changed between versions.
		assert.notStrictEqual(error.message, 'element write failed');
		assert.deepStrictEqual(unhandled, []);
		assert.deepStrictEqual(await idsOf('fail-mixed'), []);
	});

	it('rejects the whole batch for a null element, persisting no earlier element', async function () {
		const { error, unhandled } = await withRejectionWatch(() =>
			Docs.put(collectionTarget(), [{ id: 'fail-null-a', kind: 'fail-null' }, null], {})
		);
		assert.ok(error, 'the batch must reject');
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

	// The async-resolution counterpart, and the load-bearing one. With `Promise.all` the batch rejected
	// on the first element while a slower element was still resolving its resource; that element then
	// staged its write outside the failed batch and committed on its own, leaving a partially applied
	// array PUT. The watch has to outlast the late element or this passes by not looking.
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
			// Outlast the late element so its settlement happens while the watch is still installed;
			// otherwise this test would pass by simply not looking.
			400
		);
		assert.strictEqual(error?.message, 'async element write failed');
		assert.strictEqual(latePuts, 1, 'the late element must have run inside the watch window');
		assert.deepStrictEqual(unhandled, []);
		// Read past the query layer too: the partial-apply bug committed this row to the store.
		assert.strictEqual(Docs.primaryStore.getSync('async-late'), undefined);
		assert.deepStrictEqual(await idsOf('fail-async'), []);
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
