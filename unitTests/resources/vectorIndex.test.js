const assert = require('node:assert');
const { Worker } = require('worker_threads');
const { setupTestDBPath } = require('../testUtils');
const { table } = require('#src/resources/databases');
const { HierarchicalNavigableSmallWorld } = require('#src/resources/indexes/HierarchicalNavigableSmallWorld');
const { setMainIsWorker } = require('#js/server/threads/manageThreads');
const { transaction } = require('#src/resources/transaction');

describe('HierarchicalNavigableSmallWorld indexing', () => {
	if (process.env.HARPER_STORAGE_ENGINE === 'lmdb') return; // don't try to test lmdb
	let HNSWTest;
	let testInstance = new HierarchicalNavigableSmallWorld();
	let all = [];
	before(() => {
		HNSWTest = table({
			table: 'HNSWTest',
			database: 'test',
			attributes: [
				{ name: 'id', isPrimaryKey: true },
				{ name: 'name', indexed: true },
				{ name: 'vector', indexed: { type: 'HNSW', optimizeRouting: 0.6 }, type: 'Array' },
			],
		});
	});
	it('can index and search with vector index', async () => {
		for (let i = 0; i < 200; i++) {
			let vector = [i % 2, i % 3, i % 4, i % 5, i % 6, i % 7, i % 8, i % 9, i % 10, i % 11];
			await HNSWTest.put(i, {
				name: 'test' + i,
				vector,
			});
			all.push(vector);
		}
		await verifySearch();
		verifyIntegrity();
	});
	it('can delete and update and search with vector index with one dimension', async () => {
		let connectivity = HNSWTest.indices.vector.customIndex.validateConnectivity();
		console.log(connectivity);
		assert(connectivity.isFullyConnected);
		for (let i = 0; i < 100; i++) {
			const entryPointId = HNSWTest.indices.vector.get(Symbol.for('entryPoint'));
			if (typeof entryPointId !== 'number') {
				throw new Error('entry point not found');
			}
			await HNSWTest.delete(i);
		}
		all = all.slice(100);
		connectivity = HNSWTest.indices.vector.customIndex.validateConnectivity();
		console.log(connectivity);
		assert(connectivity.isFullyConnected);
		await verifySearch();
		verifyIntegrity();
		all = [];
		for (let i = 0; i < 200; i++) {
			let k = i * i + 1;
			let vector = [k % 2, k % 3, k % 4, k % 5, k % 6, k % 7, k % 8, k % 9, k % 10, k % 11];
			await HNSWTest.put(i, {
				name: 'test' + i,
				vector,
			});
			all.push(vector);
		}
		await verifySearch();
		verifyIntegrity();
	});
	it('can index and search with vector index with two dimensions', async () => {
		HNSWTest = table({
			table: 'HNSWTest2d',
			database: 'test',
			attributes: [
				{ name: 'id', isPrimaryKey: true },
				{ name: 'name', indexed: true },
				{ name: 'vector', indexed: { type: 'HNSW', optimizeRouting: false }, type: 'Array' },
			],
		});
		all = [];
		for (let i = 0; i < 200; i++) {
			let k = i * i + 1;
			let vector = [(k % 20) + 0.03 * i, (k % 33) + 10 / (i + 3)];
			await HNSWTest.put(i, {
				name: 'test',
				vector,
			});
			all.push(vector);
		}
		await verifySearch(all[55]);
		verifyIntegrity();
	});
	it('bad queries throw some errors', async () => {
		assert.throws(
			() => {
				HNSWTest.search({
					sort: { attribute: 'vector', distance: 'cosine' },
				});
			},
			{ message: /A target vector must be provided/ }
		);
		assert.throws(
			() => {
				HNSWTest.search({
					conditions: [{ attribute: 'vector', comparator: 'gt', value: 0.3, target: [1] }],
				});
			},
			{ message: /Can not use "gt" comparator/ }
		);
		assert.throws(
			() => {
				HNSWTest.search({
					conditions: [{ attribute: 'vector', comparator: 'lt', value: 0.3, target: 1 }],
				});
			},
			{ message: /must be an array/ }
		);
	});
	it('can remove and add and search with vector index', async () => {
		for await (let record of HNSWTest.search([])) {
			await HNSWTest.delete(record.id);
		}
		const records = [
			{ id: 0, name: 'test', vector: [1, 2, 3] },
			{ id: 1, name: 'test1', vector: [4, 5, 6] },
			{ id: 2, name: 'test1', vector: [7, 6, 5] },
			{ id: 3, name: 'test1', vector: [8, 7, 6] },
			{ id: 4, name: 'test1', vector: [9, 8, 7] },
		];
		for (let i = 0; i < 500; i++) {
			let promise;
			if (i % 17 > 10) {
				promise = HNSWTest.delete(records[i % 5].id);
			} else {
				promise = HNSWTest.put(records[i % 5]);
			}
			if (i % 13 === 0) {
				await promise;
			}
		}
		for (let i = 0; i < 5; i++) {
			await HNSWTest.put(records[i]);
		}
		let results = await fromAsync(
			HNSWTest.search({
				sort: { attribute: 'vector', target: [7, 6, 5], distance: 'cosine' },
				select: ['id', 'vector', 'name', '$distance'],
			})
		);
		assert.equal(results[0].id, 2);
	});
	it('produces different rankings under cosine, euclidean, and dot product metrics', async () => {
		const records = [
			{ id: 0, name: 'A', vector: [0.1, 0.1] }, // best cosine (direction match)
			{ id: 1, name: 'B', vector: [1.2, 0.8] }, // best euclidean (closest in space)
			{ id: 2, name: 'C', vector: [7.0, 8.0] }, // best dot product (max projection)
		];

		await HNSWTest.dropTable?.();

		HNSWTest = table({
			table: 'HNSWMetricTest',
			database: 'test',
			attributes: [
				{ name: 'id', isPrimaryKey: true },
				{ name: 'name', indexed: true },
				{ name: 'vector', indexed: { type: 'HNSW' }, type: 'Array' },
			],
		});

		for (let r of records) {
			await HNSWTest.put(r.id, r);
		}

		const target = [1, 1];

		const cosine = await fromAsync(
			HNSWTest.search({
				sort: { attribute: 'vector', target, distance: 'cosine' },
				select: ['id'],
				limit: 1,
			})
		);

		const euclidean = await fromAsync(
			HNSWTest.search({
				sort: { attribute: 'vector', target, distance: 'euclidean' },
				select: ['id'],
				limit: 1,
			})
		);

		const dot = await fromAsync(
			HNSWTest.search({
				sort: { attribute: 'vector', target, distance: 'dotProduct' },
				select: ['id'],
				limit: 1,
			})
		);

		assert.equal(cosine[0].id, 0);
		assert.equal(euclidean[0].id, 1);
		assert.equal(dot[0].id, 2);
	});
	after(() => {
		HNSWTest.dropTable();
	});
	async function verifySearch(testVector = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]) {
		let startingNodesVisited = HNSWTest.indices.vector.customIndex.nodesVisitedCount;
		// a standard HNSW query using sort
		let results = await fromAsync(
			HNSWTest.search(
				{
					sort: { attribute: 'vector', target: testVector, distance: 'cosine' },
					select: ['id', 'vector', '$distance'],
					limit: 10,
				},
				{}
			)
		);
		console.log(
			'nodes visited for search: ',
			HNSWTest.indices.vector.customIndex.nodesVisitedCount - startingNodesVisited
		);
		// find the best matches through brute force comparison
		let withDistance = all.map((vector) => ({ vector, distance: testInstance.distance(testVector, vector) }));
		withDistance.sort((a, b) => a.distance - b.distance);
		// verify the first 10 match
		assert.deepEqual(
			withDistance.slice(0, 5).map((obj) => obj.vector),
			results.slice(0, 5).map((obj) => obj.vector)
		);
		assert(results[0].$distance < 0.4);
		results = await fromAsync(
			HNSWTest.search({
				sort: { attribute: 'vector', target: testVector, distance: 'cosine' },
				conditions: [{ attribute: 'name', comparator: 'gt', value: 'test9' }],
				select: ['id', 'vector', 'name', '$distance'],
			})
		);
		let lastDistance = 0;
		for await (let record of results) {
			assert(record.name.startsWith('test9'));
			assert(record.$distance > lastDistance);
			lastDistance = record.$distance;
		}

		console.log(
			'nodes visited for search: ',
			HNSWTest.indices.vector.customIndex.nodesVisitedCount - startingNodesVisited,
			results
		);
	}
	function verifyIntegrity() {
		// now verify integrity and proper distance/distancing across levels
		let invertedSimiliarities = 0;
		for (let { key, value } of HNSWTest.indices.vector.getRange({})) {
			let lastDistance = 0;
			let l = 0;
			let connections;
			while ((connections = value[l])) {
				// verify that the level is not empty, otherwise this means we have an orphaned node
				if (connections.length === 0) {
					if (l === 0) console.log('no connections for ', key, ' at level ', l);
					l++;
					continue;
				}
				// compute the average distance of the neighbors in this level
				let totalDistance = 0;
				let asymmetries = 0;
				for (let { id: neighborId } of connections) {
					let neighborNode = HNSWTest.indices.vector.get(neighborId);
					// verify that the connection is symmetrical
					let symmetrical = neighborNode?.[l].find(({ id }) => id === key);
					if (!symmetrical) {
						console.log('asymmetry in the graph', neighborNode?.[l], 'does not have key', key);
						asymmetries++;
					}
					let distance = neighborNode ? testInstance.distance(value.vector, neighborNode.vector) : 0;
					totalDistance += distance;
				}
				assert(asymmetries < 5);
				let distance = totalDistance / connections.length;
				// verify that most of the higher level (skip level) similarities are less than previous levels
				// (non-skip,
				// or shorter skip), which should be the case for a HNSW index
				if (!(distance > lastDistance)) {
					console.log(distance, lastDistance);
					invertedSimiliarities++;
				}
				lastDistance = distance;
				l++;
			}
		}
		if (invertedSimiliarities > 6)
			console.log('found', invertedSimiliarities, 'inversions of distance, which is more than desirable');
		assert(invertedSimiliarities <= 6, `expected at most 6 distance inversions, got ${invertedSimiliarities}`);
	}
});

describe('HNSW concurrent PUT race condition (issue #386)', () => {
	if (process.env.HARPER_STORAGE_ENGINE === 'lmdb') return;
	const WORKER_COUNT = 4;
	const PUTS_PER_WORKER = 2;
	const DIMS = 768;
	let ConcurrentTest;
	let workers = [];

	before(() => {
		setupTestDBPath();
		setMainIsWorker(true);
		ConcurrentTest = table({
			table: 'HNSWConcurrentTest',
			database: 'test',
			attributes: [
				{ name: 'id', isPrimaryKey: true },
				{ name: 'embedding', indexed: { type: 'HNSW' }, type: 'Array' },
			],
		});
		for (let w = 0; w < WORKER_COUNT; w++) {
			workers.push(new Worker(__dirname + '/vectorIndex-thread.js'));
		}
	});

	it('handles concurrent multi-worker PUTs without race conditions', async () => {
		const replies = await Promise.all(
			workers.map(
				(worker, w) =>
					new Promise((resolve) => {
						worker.once('message', resolve);
						worker.once('error', (err) =>
							resolve({ type: 'error', start: w * PUTS_PER_WORKER, message: err.message, stack: err.stack })
						);
						worker.postMessage({
							type: 'insert',
							start: w * PUTS_PER_WORKER,
							count: PUTS_PER_WORKER,
							dims: DIMS,
						});
					})
			)
		);
		const errors = replies.filter((r) => r.type === 'error');
		assert.deepEqual(
			errors,
			[],
			`expected no worker errors, got: ${errors.map((e) => `[start=${e.start}] ${e.message} ${e.stack}`).join('; ')}`
		);

		const expected = WORKER_COUNT * PUTS_PER_WORKER;
		let count = 0;
		for await (const _ of ConcurrentTest.search([])) count++;
		assert.equal(count, expected, `expected ${expected} records after concurrent puts, got ${count}`);
	});

	after(async () => {
		await Promise.all(workers.map((w) => w.terminate()));
		ConcurrentTest.dropTable();
	});
});

describe('HNSW search result loading (searchByIndex)', () => {
	if (process.env.HARPER_STORAGE_ENGINE === 'lmdb') return;
	let T;

	before(() => {
		setupTestDBPath();
		setMainIsWorker(true);
		T = table({
			table: 'HNSWSearchLoadTest',
			database: 'test',
			attributes: [
				{ name: 'id', isPrimaryKey: true },
				{ name: 'name' },
				{ name: 'vector', indexed: { type: 'HNSW' }, type: 'Array' },
			],
		});
	});

	after(() => {
		T.dropTable();
	});

	it('skips a deleted record instead of returning a broken partial entry', async () => {
		await T.put(1, { name: 'keep', vector: [1, 0, 0] });
		await T.put(2, { name: 'delete-me', vector: [0.99, 0.1, 0] });

		await T.delete(2);

		const results = await fromAsync(
			T.search({ sort: { attribute: 'vector', target: [1, 0, 0], distance: 'cosine' }, limit: 5 })
		);

		assert(
			results.some((r) => r.id === 1),
			'kept record should appear in results'
		);
		assert(
			!results.some((r) => r.id === 2),
			'deleted record should not appear in results'
		);
		assert(
			results.every((r) => r.id != null),
			'no partial entries (missing id) should appear in results'
		);
	});

	it('write-then-search within the same transaction sees the written record', async () => {
		const context = {};
		let foundInTxn = false;

		await transaction(context, async () => {
			await T.put(100, { name: 'in-txn', vector: [0, 0, 1] }, context);

			const results = await fromAsync(
				T.search({ sort: { attribute: 'vector', target: [0, 0, 1], distance: 'cosine' }, limit: 5 }, context)
			);

			foundInTxn = results.some((r) => r.id === 100);
		});

		assert(foundInTxn, 'record written in a transaction must be visible to a search in the same transaction');
	});
});

async function fromAsync(iterable) {
	let results = [];
	for await (let entry of iterable) {
		results.push(entry);
	}
	return results;
}
