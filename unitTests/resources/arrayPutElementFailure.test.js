// A malformed element throws synchronously inside the built-in array PUT dispatch loop, after
// earlier elements' writes are already in flight. Those writes must be settled before the batch
// fails, or a later rejection reaches no handler and becomes an unhandled rejection (harper#2000).
require('../testUtils');
const assert = require('node:assert');
const { setupTestDBPath } = require('../testUtils');
const { table } = require('#src/resources/databases');
const { RequestTarget } = require('#src/resources/RequestTarget');
const { setMainIsWorker } = require('#js/server/threads/manageThreads');

// An unhandled rejection is reported a turn or two after the promise is abandoned, so give the
// loop time to fire before asserting it did not.
async function drainRejections() {
	for (let turn = 0; turn < 5; turn++) await new Promise((resolve) => setImmediate(resolve));
	await new Promise((resolve) => setTimeout(resolve, 50));
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
	async function withRejectionWatch(attempt) {
		const unhandled = [];
		const listener = (reason) => unhandled.push(reason?.message ?? String(reason));
		process.on('unhandledRejection', listener);
		let error;
		try {
			await attempt();
		} catch (thrown) {
			error = thrown;
		}
		await drainRejections();
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
		// The malformed element is what the caller has to fix, so its error is the batch's error.
		assert.match(error?.message ?? '', /reading 'id'/);
		assert.deepStrictEqual(unhandled, []);
		assert.deepStrictEqual(await idsOf('fail-mixed'), []);
	});

	it('rejects the whole batch for a null element, persisting no earlier element', async function () {
		const { error, unhandled } = await withRejectionWatch(() =>
			Docs.put(collectionTarget(), [{ id: 'fail-null-a', kind: 'fail-null' }, null], {})
		);
		assert.match(error?.message ?? '', /reading 'id'/);
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
