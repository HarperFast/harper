require('../testUtils');
const assert = require('node:assert');
const { Worker } = require('node:worker_threads');
const { setupTestDBPath } = require('../testUtils');
const { closeDatabase } = require('#src/resources/databases');
const { setMainIsWorker } = require('#src/server/threads/manageThreads');
const { getPlaneBinding } = require('#src/resources/indexes/hnswPlaneBinding');
const { waitFor } = require('../waitFor');
const { defineTables, search, vector } = require('./derivedIndexCoverageDemand-thread');

describe('derived-index coverage waits on a non-owner worker', function () {
	if (process.env.HARPER_STORAGE_ENGINE === 'lmdb' || !getPlaneBinding()) return;
	this.timeout(30_000);
	// The owner refreshes idle coverage at its 1 s flush cadence; a wait that is only answered by that
	// timer lands anywhere in (0, 1 s], so every sample staying under this bound proves the demand path.
	const PROMPT_MILLISECONDS = 250;
	let Product, index, worker;
	const current = () =>
		waitFor(
			async () => {
				try {
					return await search(index, 0);
				} catch (error) {
					if (error.statusCode === 503) return false;
					throw error;
				}
			},
			{ timeout: 15_000, message: 'native index did not certify current coverage' }
		);
	const nextMessage = () =>
		new Promise((resolve, reject) => {
			worker.once('message', resolve);
			worker.once('error', reject);
		});
	const writeAndSearch = async (table, id, record) => {
		const reply = nextMessage();
		// The pause lets the owner's commit-triggered drain finish first; a query racing that drain can
		// be answered by it, which is luck rather than the demand path under test.
		worker.postMessage({ table, id, record, waitForIndexMilliseconds: 5000, pauseMilliseconds: 50 });
		const result = await reply;
		assert.equal(result.type, 'searched', result.stack ?? result.message);
		return result;
	};

	before(async () => {
		setupTestDBPath();
		setMainIsWorker(true);
		({ Product } = defineTables());
		index = Product.indices.vector.customIndex;
		await Product.put('initial', { vector });
		await current();
		// This thread registered first and holds the runner lock, so the worker's runtime is a non-owner.
		assert.notEqual(Product.derivedIndexRuntime, undefined);
		worker = new Worker(require.resolve('./derivedIndexCoverageDemand-thread.js'));
		assert.equal((await nextMessage()).type, 'ready');
	});
	after(async () => {
		await worker?.terminate();
		await closeDatabase('coverage-demand');
	});

	it('answers a wait after an unindexed-table commit without the owner flush cadence', async () => {
		const elapsed = [];
		const { ownerEpoch } = index.derivedHost.readiness();
		for (let i = 0; i < 5; i++) {
			await current();
			const result = await writeAndSearch('Other', `unrelated-${i}`, { value: i });
			assert(result.keys.includes('initial'));
			elapsed.push(Math.round(result.elapsed));
		}
		assert(
			elapsed.every((milliseconds) => milliseconds < PROMPT_MILLISECONDS),
			`coverage waits took ${elapsed.join(', ')} ms`
		);
		assert.equal(index.derivedHost.readiness().ownerEpoch, ownerEpoch, 'the main thread must stay the owner');
	});

	it('still sees its own indexed write after the wait', async () => {
		await current();
		const result = await writeAndSearch('Product', 'from-worker', { vector });
		assert(result.keys.includes('from-worker'), `keys: ${result.keys.join(', ')}`);
	});
});
