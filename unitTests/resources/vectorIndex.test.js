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
	it('does not crash when an index node decodes as corrupt', () => {
		const nodes = new Map();
		let entryPoint;
		let neighborReadCount = 0;

		// Minimal mock indexStore: corrupt reads on numeric neighbor-node keys after the first few
		const mockStore = {
			encoder: { useFloat32: false },
			getSync(key) {
				if (key === Symbol.for('entryPoint')) return entryPoint;
				if (typeof key === 'number') {
					neighborReadCount++;
					// After the graph has a few nodes, simulate a corrupt node read
					if (neighborReadCount > 3) {
						throw new Error('Data read, but end of buffer not reached 0');
					}
					return nodes.get(key);
				}
				return nodes.get(JSON.stringify(key));
			},
			put(key, value) {
				if (key === Symbol.for('entryPoint')) {
					entryPoint = value;
				} else if (typeof key === 'number') {
					nodes.set(key, value);
				} else {
					nodes.set(JSON.stringify(key), value);
				}
			},
			remove(key) {
				nodes.delete(typeof key === 'number' ? key : JSON.stringify(key));
			},
			getKeys() {
				return [];
			},
			getUserSharedBuffer(_name, buffer) {
				return buffer;
			},
		};

		const hnsw = new HierarchicalNavigableSmallWorld(mockStore, {});

		// Build a small graph (neighbor reads stay under threshold here)
		for (let i = 0; i < 5; i++) {
			hnsw.index(i, [i, i + 1, i + 2], null, {});
		}
		neighborReadCount = 0; // reset so subsequent inserts hit the corrupt path

		// Inserting new nodes must not throw even though neighbor reads now corrupt
		assert.doesNotThrow(() => hnsw.index(100, [1, 2, 3], null, {}));
		assert.doesNotThrow(() => hnsw.index(101, [4, 5, 6], null, {}));
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
		// HNSW is an approximate algorithm; recall@K is not guaranteed to be 100%, especially with
		// many near-duplicate vectors and after delete/update churn. Rather than asserting exact
		// vector equality at each rank, verify that each returned result's distance is close to the
		// brute-force optimum at that rank — close enough to be a useful neighbor.
		const DISTANCE_TOLERANCE = 0.05;
		assert(results.length >= 5, `expected at least 5 search results, got ${results.length}`);
		for (let i = 0; i < 5; i++) {
			const bruteDistance = withDistance[i].distance;
			const hnswDistance = results[i].$distance;
			assert(
				hnswDistance <= bruteDistance + DISTANCE_TOLERANCE,
				`HNSW result at position ${i} (distance ${hnswDistance}) is too far from the brute-force best at that rank (${bruteDistance})`
			);
		}
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
	// Graph nodes may store vectors as Int8Array (int8 default) or number[] (float opt-out).
	// Dequantize to a plain number[] so distance functions (which guard on Array.isArray) work.
	function toFloatVec(node) {
		if (!node || !node.vector) return null;
		if (Array.isArray(node.vector)) return node.vector;
		const buf = node.vector;
		const i8 = new Int8Array(buf.buffer, buf.byteOffset, buf.byteLength);
		const scale = node.scale || 1;
		const out = new Array(i8.length);
		for (let i = 0; i < i8.length; i++) out[i] = i8[i] * scale;
		return out;
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
					let distance = neighborNode ? testInstance.distance(toFloatVec(value), toFloatVec(neighborNode)) : 0;
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
		assert(!results.some((r) => r.id === 2), 'deleted record should not appear in results');
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

describe('HNSW int8 quantization (quantization: "int8")', () => {
	if (process.env.HARPER_STORAGE_ENGINE === 'lmdb') return;
	const testInstance = new HierarchicalNavigableSmallWorld();
	const DIMS = 32;
	const CLUSTERS = 12;
	let T;
	let all = [];

	// Deterministic clustered unit-ish vectors so genuine near-neighbours exist
	// (purely random high-dim vectors are near-orthogonal and make recall meaningless).
	function vec(seed) {
		let s = (seed * 2654435761) >>> 0;
		const rand = () => (s = (s * 1664525 + 1013904223) >>> 0) / 4294967296;
		const cluster = seed % CLUSTERS;
		let cs = (cluster * 40503 + 1) >>> 0;
		const crand = () => (cs = (cs * 1664525 + 1013904223) >>> 0) / 4294967296;
		const out = new Array(DIMS);
		let mag = 0;
		for (let i = 0; i < DIMS; i++) {
			const v = crand() * 2 - 1 + 0.15 * (rand() * 2 - 1);
			out[i] = v;
			mag += v * v;
		}
		const inv = 1 / (Math.sqrt(mag) || 1);
		for (let i = 0; i < DIMS; i++) out[i] = out[i] * inv;
		return out;
	}

	before(() => {
		setupTestDBPath();
		setMainIsWorker(true);
		T = table({
			table: 'HNSWInt8Test',
			database: 'test',
			attributes: [
				{ name: 'id', isPrimaryKey: true },
				{ name: 'vector', indexed: { type: 'HNSW', distance: 'cosine', quantization: 'int8' }, type: 'Array' },
			],
		});
	});
	after(() => {
		T.dropTable();
	});

	it('stores the vector as a compact int8 bin + scale, not a float array', async () => {
		for (let i = 0; i < 300; i++) {
			const v = vec(i);
			await T.put(i, { vector: v });
			all.push({ id: i, v });
		}
		let raw;
		for (const { key, value } of T.indices.vector.getRange({})) {
			if (typeof key === 'number' && value && value.vector) {
				raw = value;
				break;
			}
		}
		assert(raw, 'expected at least one stored graph node');
		assert(!Array.isArray(raw.vector), 'int8 vector must be stored as a bin, not a number[]');
		assert.equal(typeof raw.scale, 'number', 'int8 node must carry a dequant scale');
	});

	it('finds near-optimal neighbours through the int8 graph ($distance stays exact)', async () => {
		// $distance is recomputed from the record's full-precision vector, so it is exact;
		// only WHICH records the int8 graph navigates to is approximate.
		const target = vec(7); // lands in a populated cluster
		const results = await fromAsync(
			T.search({
				sort: { attribute: 'vector', target, distance: 'cosine' },
				select: ['id', '$distance'],
				limit: 10,
			})
		);
		assert(results.length >= 5, `expected >=5 results, got ${results.length}`);
		const brute = all.map(({ id, v }) => ({ id, d: testInstance.distance(target, v) })).sort((a, b) => a.d - b.d);
		// Top results must be close to the brute-force optimum at each rank. Slightly looser
		// tolerance than the float test to allow for quantization-induced ranking wobble.
		const TOL = 0.1;
		for (let i = 0; i < 3; i++) {
			assert(Number.isFinite(results[i].$distance), `result ${i} distance not finite`);
			assert(
				results[i].$distance <= brute[i].d + TOL,
				`int8 result at rank ${i} (${results[i].$distance}) too far from brute optimum (${brute[i].d})`
			);
		}
		// recall@10 should remain high on this clustered set despite quantization
		const truthTop = new Set(brute.slice(0, 10).map((t) => t.id));
		const hits = results.filter((r) => truthTop.has(r.id)).length;
		assert(hits >= 5, `int8 recall@10 unexpectedly low: ${hits}/10`);
	});

	it('handles update and delete on an int8 index without corruption', async () => {
		await T.put(0, { vector: vec(50000) }); // move id 0 to a new location
		await T.delete(5);
		const results = await fromAsync(
			T.search({ sort: { attribute: 'vector', target: vec(50000), distance: 'cosine' }, select: ['id'], limit: 10 })
		);
		assert(
			results.some((r) => r.id === 0),
			'updated record should be findable near its new vector'
		);
		assert(!results.some((r) => r.id === 5), 'deleted record must not be returned');
	});

	it('ranks correctly across cosine/euclidean/dotProduct on an int8 index (incl. cosine fallback)', async () => {
		// Default distance is euclidean, so nodes are stored WITHOUT a cached invMag — a cosine
		// query then exercises the int8 cosine-fallback magnitude path. The three queries also
		// exercise the inline asymmetric euclidean and dotProduct int8 distance paths.
		const records = [
			{ id: 0, vector: [0.1, 0.1] }, // best cosine (direction match to [1,1])
			{ id: 1, vector: [1.2, 0.8] }, // best euclidean (closest in space)
			{ id: 2, vector: [7.0, 8.0] }, // best dot product (max projection)
		];
		const M = table({
			table: 'HNSWInt8MetricTest',
			database: 'test',
			attributes: [
				{ name: 'id', isPrimaryKey: true },
				{ name: 'vector', indexed: { type: 'HNSW', distance: 'euclidean', quantization: 'int8' }, type: 'Array' },
			],
		});
		for (const r of records) await M.put(r.id, r);
		const target = [1, 1];
		const top = async (distance) =>
			(await fromAsync(M.search({ sort: { attribute: 'vector', target, distance }, select: ['id'], limit: 1 })))[0]?.id;
		assert.equal(await top('cosine'), 0, 'cosine fallback should rank the direction match first');
		assert.equal(await top('euclidean'), 1, 'euclidean should rank the closest-in-space first');
		assert.equal(await top('dotProduct'), 2, 'dotProduct should rank the max-projection first');
		M.dropTable();
	});

	it('reranks int8 results so returned $distance is exact (recomputed from the record), sorted', async () => {
		// The graph navigates on quantized distances, but the search layer reranks the candidates
		// against each record's full-precision vector. So the returned $distance must equal the exact
		// float distance to that record's own vector (within float epsilon), not the quantized value.
		const target = vec(7);
		const results = await fromAsync(
			T.search({
				sort: { attribute: 'vector', target, distance: 'cosine' },
				select: ['id', 'vector', '$distance'],
				limit: 8,
			})
		);
		assert(results.length >= 1, 'expected results');
		for (const r of results) {
			const exact = testInstance.distance(target, r.vector); // exact cosine over the record's full vector
			assert(
				Math.abs(r.$distance - exact) < 1e-6,
				`$distance ${r.$distance} should equal the exact full-precision distance ${exact} (reranked)`
			);
		}
		for (let i = 1; i < results.length; i++)
			assert(
				results[i].$distance >= results[i - 1].$distance - 1e-9,
				'results must be sorted ascending by exact distance'
			);
	});
});

// mocha has no `{ skip }` options arg like node:test (`it(title, {skip}, fn)` throws), so use
// describe.skip to make the lmdb skip explicit rather than a silent early return.
const describeUnlessLmdb = process.env.HARPER_STORAGE_ENGINE === 'lmdb' ? describe.skip : describe;
describeUnlessLmdb('HNSW int8 cold/frozen node reads (#1161)', () => {
	const DIMS = 16;
	const N = 250;
	let T;
	const all = [];

	function vec(seed) {
		let s = (seed * 2654435761) >>> 0;
		const rand = () => (s = (s * 1664525 + 1013904223) >>> 0) / 4294967296;
		let cs = ((seed % 16) * 40503 + 1) >>> 0;
		const crand = () => (cs = (cs * 1664525 + 1013904223) >>> 0) / 4294967296;
		const out = new Array(DIMS);
		let mag = 0;
		for (let i = 0; i < DIMS; i++) {
			const v = crand() * 2 - 1 + 0.15 * (rand() * 2 - 1);
			out[i] = v;
			mag += v * v;
		}
		const inv = 1 / (Math.sqrt(mag) || 1);
		for (let i = 0; i < DIMS; i++) out[i] *= inv;
		return out;
	}

	before(async () => {
		setupTestDBPath();
		setMainIsWorker(true);
		T = table({
			table: 'HNSWInt8Cold',
			database: 'test',
			attributes: [
				{ name: 'id', isPrimaryKey: true },
				{ name: 'vector', indexed: { type: 'HNSW', distance: 'cosine', quantization: 'int8' }, type: 'Array' },
			],
		});
		for (let i = 0; i < N; i++) {
			const v = vec(i);
			await T.put(i, { vector: v });
			all.push(v);
		}
	});
	after(() => T.dropTable());

	// The index store sets freezeData, so a node decoded from disk (a cache miss — which happens for
	// older nodes once a table outgrows the object cache, ~3-4k rows) is a FROZEN record whose int8
	// `vector` is an unsigned Uint8Array. safeGetSync must produce a signed Int8Array without mutating
	// the frozen record; mutating it throws, the node is silently dropped, and the graph fragments so
	// records become unfindable. Forcing every read to look like a freezeData disk decode makes this
	// deterministic without depending on cache eviction timing.
	it('still finds records when graph nodes are read cold/frozen', async () => {
		const store = T.indices.vector.customIndex.indexStore;
		const realGetSync = store.getSync.bind(store);
		// Return a STABLE frozen object per key, mirroring the store's object cache returning the same
		// decoded-from-disk (frozen, unsigned-bin) node reference on repeated hits.
		const coldByKey = new Map();
		store.getSync = function (key, opts) {
			const node = realGetSync(key, opts);
			if (node && typeof node === 'object' && node.vector != null && !Array.isArray(node.vector)) {
				let cold = coldByKey.get(key);
				if (!cold) {
					const v = node.vector;
					cold = { ...node, vector: new Uint8Array(v.buffer, v.byteOffset, v.byteLength).slice() };
					for (let level = 0; Array.isArray(cold[level]); level++) cold[level] = Object.freeze(cold[level].slice());
					cold = Object.freeze(cold);
					coldByKey.set(key, cold);
				}
				return cold;
			}
			return node;
		};
		try {
			let misses = 0;
			for (let i = 0; i < N; i++) {
				const results = await fromAsync(
					T.search({ sort: { attribute: 'vector', target: all[i], distance: 'cosine' }, select: ['id'], limit: 5 })
				);
				if (!results.some((r) => r.id === i)) misses++;
			}
			assert.equal(misses, 0, `${misses}/${N} int8 records unfindable when graph nodes are read cold/frozen`);
		} finally {
			store.getSync = realGetSync;
		}
	});
});

// ─── Data-integrity fixes (5.1 GA) ──────────────────────────────────────────
describeUnlessLmdb('HNSW data-integrity fixes (5.1 GA)', () => {
	// Minimal mock store used by several tests below. Supports put/get/remove with
	// optional numeric-range scan (getRange), and a shared-buffer allocator.
	function makeMockStore() {
		const nodes = new Map();
		let ep;
		return {
			encoder: { useFloat32: false },
			getSync(key, _opts) {
				if (key === Symbol.for('entryPoint')) return ep;
				const k = typeof key === 'number' ? key : JSON.stringify(key);
				return nodes.get(k);
			},
			put(key, value, _opts) {
				if (key === Symbol.for('entryPoint')) {
					ep = value;
					return;
				}
				const k = typeof key === 'number' ? key : JSON.stringify(key);
				nodes.set(k, value);
			},
			remove(key, _opts) {
				if (key === Symbol.for('entryPoint')) {
					ep = undefined;
					return;
				}
				const k = typeof key === 'number' ? key : JSON.stringify(key);
				nodes.delete(k);
			},
			*getRange({ start = 0, end = Infinity } = {}) {
				for (const [k, v] of nodes) {
					if (typeof k === 'number' && k >= start && k <= end) yield { key: k, value: v };
				}
			},
			getKeys({ transaction: _t } = {}) {
				return [];
			},
			getUserSharedBuffer(_name, buffer) {
				return buffer;
			},
			// For test assertions: iterate all numeric-key (node) entries
			_nodes() {
				return nodes.entries();
			},
		};
	}

	// ── non-finite vector guard ────────────────────────────────────────────
	describe('non-finite vector guard', () => {
		it('throws ClientError for a vector containing NaN', () => {
			const store = makeMockStore();
			const hnsw = new HierarchicalNavigableSmallWorld(store, {});
			// Insert a valid first node so the graph is not empty.
			hnsw.index('a', [1, 0, 0], null, {});
			assert.throws(
				() => hnsw.index('b', [0, NaN, 1], null, {}),
				(err) => {
					assert(err.message.includes('non-finite'), `expected "non-finite" in: ${err.message}`);
					assert(err.message.includes('1'), `expected component index in: ${err.message}`);
					return true;
				}
			);
		});

		it('throws ClientError for a vector containing Infinity', () => {
			const store = makeMockStore();
			const hnsw = new HierarchicalNavigableSmallWorld(store, {});
			hnsw.index('a', [1, 0, 0], null, {});
			assert.throws(
				() => hnsw.index('b', [Infinity, 0, 0], null, {}),
				(err) => {
					assert(err.message.includes('non-finite'), `expected "non-finite" in: ${err.message}`);
					return true;
				}
			);
		});

		it('index remains searchable after a rejected NaN insert', () => {
			const store = makeMockStore();
			const hnsw = new HierarchicalNavigableSmallWorld(store, { distance: 'euclidean' });
			hnsw.index('good', [1, 0, 0], null, {});
			// Swallow the expected error
			try {
				hnsw.index('bad', [NaN, 0, 0], null, {});
			} catch {}
			// The good node must still be reachable
			const results = hnsw.search(
				{ target: [1, 0, 0], comparator: 'sort', descending: false },
				{ transaction: undefined }
			);
			assert(Array.isArray(results), 'search must return an array');
			assert(
				results.some((r) => r.key === 'good'),
				'valid node must be findable after rejected NaN insert'
			);
		});
	});

	// ── `le` boundary inclusion ──────────────────────────────────────────────
	describe('le comparator includes the boundary distance', () => {
		it('le returns records at exactly the threshold distance', () => {
			const store = makeMockStore();
			// euclidean: distance([0], [d]) = d^2  — use 1D so we can predict exact distances
			const hnsw = new HierarchicalNavigableSmallWorld(store, { distance: 'euclidean' });
			// Insert vectors at known euclidean-squared distances from [0]: 0.04, 0.09, 0.16, 0.25
			hnsw.index('d0.04', [0.2], null, {});
			hnsw.index('d0.09', [0.3], null, {});
			hnsw.index('d0.16', [0.4], null, {});
			hnsw.index('d0.25', [0.5], null, {});

			const target = [0];
			// lt with value 0.09: should exclude the d0.09 record
			const lt = hnsw.search({ target, comparator: 'lt', value: 0.09, descending: false }, { transaction: undefined });
			assert(
				lt.every((r) => r.distance < 0.09),
				'lt should exclude exact boundary'
			);
			assert(!lt.some((r) => r.key === 'd0.09'), 'lt must not include d0.09 (distance == threshold)');

			// le with value 0.09: must include the d0.09 record
			const le = hnsw.search({ target, comparator: 'le', value: 0.09, descending: false }, { transaction: undefined });
			assert(
				le.some((r) => r.key === 'd0.09'),
				'le must include d0.09 (distance == threshold)'
			);
			assert(
				le.every((r) => r.distance <= 0.09),
				'le must not include records beyond threshold'
			);
		});

		it('le with a threshold of 0 filters to exact matches (0 is a valid threshold)', () => {
			const store = makeMockStore();
			const hnsw = new HierarchicalNavigableSmallWorld(store, { distance: 'euclidean' });
			hnsw.index('exact', [0.2], null, {});
			hnsw.index('near', [0.3], null, {});
			hnsw.index('far', [0.9], null, {});

			// le 0: only the exact-distance-0 record. A falsy-0 sentinel would skip the
			// filter entirely and return all three.
			const le0 = hnsw.search(
				{ target: [0.2], comparator: 'le', value: 0, descending: false },
				{ transaction: undefined }
			);
			assert.strictEqual(le0.length, 1, `le 0 must return only the exact match, got ${le0.length}`);
			assert.strictEqual(le0[0].key, 'exact');

			// lt 0: no distance can be negative for euclidean — must return nothing.
			const lt0 = hnsw.search(
				{ target: [0.2], comparator: 'lt', value: 0, descending: false },
				{ transaction: undefined }
			);
			assert.strictEqual(lt0.length, 0, 'lt 0 must return no records');
		});
	});

	// ── delete-entry-point, remaining records still findable ──────────────────
	describe('delete-entry-point leaves remaining records findable', () => {
		it('search returns remaining records after deleting the entry-point node', () => {
			// Use the mock store so this test is self-contained and immune to DB state.
			const store = makeMockStore();
			const hnsw = new HierarchicalNavigableSmallWorld(store, { distance: 'euclidean', optimizeRouting: 0 });

			// Insert N records with spread-out vectors.
			const N = 12;
			for (let i = 0; i < N; i++) hnsw.index(String(i), [i, i * 0.5, i % 3], null, {});

			// Identify the entry-point's primaryKey and delete it.
			const epNodeId = store.getSync(Symbol.for('entryPoint'));
			const epPrimaryKey = store.getSync(epNodeId)?.primaryKey ?? '0';
			hnsw.index(epPrimaryKey, null, null, {}); // deletion path (vector == null)

			// All remaining records must still be reachable via search.
			const results = hnsw.search(
				{ target: [5, 2.5, 2], comparator: 'sort', descending: false },
				{ transaction: undefined }
			);
			assert(Array.isArray(results), 'search must return an array');
			assert(!results.some((r) => r.key === epPrimaryKey), 'deleted entry-point must not appear in results');
			// Most remaining nodes must be reachable.
			assert(
				results.length >= N - 3,
				`expected at least ${N - 3} results after entry-point deletion, got ${results.length}`
			);
		});

		it('bulk-delete 50% including entry point still returns the remainder', () => {
			const store = makeMockStore();
			const hnsw = new HierarchicalNavigableSmallWorld(store, { distance: 'euclidean', optimizeRouting: 0 });

			const N = 14;
			for (let i = 0; i < N; i++) hnsw.index(String(i), [i, i % 3], null, {});

			// Collect the first half of node primary keys (including the entry point).
			const epNodeId = store.getSync(Symbol.for('entryPoint'));
			const deleteKeys = new Set();
			deleteKeys.add(store.getSync(epNodeId)?.primaryKey ?? '0');
			for (let i = 0; i < Math.floor(N / 2) - 1; i++) deleteKeys.add(String(i));

			for (const pk of deleteKeys) hnsw.index(pk, null, null, {});

			const results = hnsw.search(
				{ target: [10, 1], comparator: 'sort', descending: false },
				{ transaction: undefined }
			);
			// Deleted keys must not appear.
			for (const pk of deleteKeys) {
				assert(!results.some((r) => r.key === pk), `deleted key ${pk} must not appear in results`);
			}
		});
	});

	// ── update-then-search reachability ───────────────────────────────────────
	describe('update-then-search reachability (sweep-levels fix)', () => {
		it('repeatedly-updated record and its neighbors remain findable', () => {
			const store = makeMockStore();
			const hnsw = new HierarchicalNavigableSmallWorld(store, { distance: 'euclidean', optimizeRouting: 0.5 });

			// Build a small graph.
			const N = 20;
			for (let i = 0; i < N; i++) {
				hnsw.index(String(i), [Math.cos(i * 0.5), Math.sin(i * 0.5), 0.1 * (i % 3)], null, {});
			}
			// Update key '5' ten times — exercises the level-targeted reverse-edge sweep.
			for (let round = 0; round < 10; round++) {
				const newVec = [Math.cos(round * 0.7), Math.sin(round * 0.7), 0.2];
				// existingVector triggers the update path in index()
				hnsw.index('5', newVec, [Math.cos((round - 1) * 0.7) || 1, 0.2, 0.2], {});
			}
			// All N records must still be reachable via a broad search.
			const results = hnsw.search(
				{ target: [1, 0, 0], comparator: 'sort', descending: false },
				{ transaction: undefined }
			);
			// HNSW is approximate; allow up to 2 misses on a small graph.
			assert(
				results.length >= N - 2,
				`expected at least ${N - 2} results after repeated updates, got ${results.length}`
			);
		});

		it('symmetry check: fewer than 5 asymmetries after repeated updates', () => {
			const store = makeMockStore();
			const hnsw = new HierarchicalNavigableSmallWorld(store, { distance: 'euclidean', optimizeRouting: 0.5 });

			const N = 16;
			for (let i = 0; i < N; i++) {
				hnsw.index(String(i), [Math.cos(i * 0.5), Math.sin(i * 0.5)], null, {});
			}
			for (let round = 0; round < 8; round++) {
				const newVec = [Math.cos(round * 0.7), Math.sin(round * 0.7)];
				hnsw.index('3', newVec, [Math.cos((round - 1) * 0.7) || 1, 0.1], {});
			}

			// Check symmetry directly on the mock store.
			let asymmetries = 0;
			for (const [k, node] of store._nodes()) {
				if (typeof k !== 'number' || node?.level === undefined) continue;
				for (let l = 0; l <= node.level; l++) {
					for (const { id: neighborId } of node[l] || []) {
						const neighborNode = store.getSync(neighborId);
						if (!neighborNode) continue;
						const sym = (neighborNode[l] || []).find(({ id }) => id === k);
						if (!sym) asymmetries++;
					}
				}
			}
			assert(asymmetries < 5, `expected < 5 asymmetries after repeated updates, got ${asymmetries}`);
		});
	});

	// ── backfill idempotency (re-feeding existing key) ────────────────────────
	describe('backfill resume idempotency', () => {
		it('calling index() twice with the same key preserves symmetric connections', () => {
			const store = makeMockStore();
			const hnsw = new HierarchicalNavigableSmallWorld(store, { distance: 'euclidean', optimizeRouting: 0 });

			// First insert: establishes the node and its connections.
			for (let i = 0; i < 8; i++) {
				hnsw.index(String(i), [i, i * 0.5], null, {});
			}

			// Second call for key '0' with no existingVector (simulates a backfill re-feed).
			// Should behave as an update, not a fresh insert.
			hnsw.index('0', [0, 0], null, {});

			// Verify symmetry: for every connection a→b, b→a must also exist at the same level.
			let asymmetries = 0;
			for (const [k, node] of store._nodes()) {
				if (typeof k !== 'number' || node?.level === undefined) continue;
				let l = 0;
				while (node[l]) {
					for (const { id: neighborId } of node[l]) {
						const neighbor = store.getSync(neighborId);
						if (!neighbor) continue;
						const sym = (neighbor[l] || []).find(({ id }) => id === k);
						if (!sym) asymmetries++;
					}
					l++;
				}
			}
			assert(asymmetries < 3, `expected < 3 asymmetries after backfill re-feed, got ${asymmetries}`);
		});

		it('level is preserved when re-feeding an existing node without existingVector', () => {
			const store = makeMockStore();
			const hnsw = new HierarchicalNavigableSmallWorld(store, { distance: 'euclidean', optimizeRouting: 0 });
			// Seed a few nodes so the graph is non-trivial.
			for (let i = 0; i < 6; i++) hnsw.index(String(i), [i, 0], null, {});

			// Capture the level of node '0' after first insert.
			const safeKey0 = '0';
			const nodeId0 = store.getSync(safeKey0);
			const levelBefore = store.getSync(nodeId0)?.level;

			// Re-feed with same vector, no existingVector (backfill scenario).
			hnsw.index('0', [0, 0], null, {});

			const levelAfter = store.getSync(nodeId0)?.level;
			assert.equal(levelAfter, levelBefore, 'level must be preserved on backfill re-feed');
		});
	});
});

// Benchmark: int8 recall on unnormalized high-dynamic-range vectors (euclidean distance).
// The per-vector scale = max|component|/127 squashes small components when one dimension
// dominates. This suite measures whether recall stays acceptable in that worst-case shape,
// and serves as a regression baseline for default-on quantization decisions.
describeUnlessLmdb('HNSW int8 recall — unnormalized euclidean (high dynamic range)', () => {
	const DIMS = 16;
	const N = 300;
	let TFloat, TInt8;
	const allFloat = [];

	// Vectors with one large outlier component so the per-vector max-abs scale is set by that
	// outlier, leaving most other components at only a few quantization levels.
	function hdrVec(seed) {
		let s = (seed * 2654435761) >>> 0;
		const rand = () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296) * 2 - 1;
		const out = new Array(DIMS);
		// first component is the outlier (range ±10), the rest are small (range ±0.1)
		out[0] = rand() * 10;
		for (let i = 1; i < DIMS; i++) out[i] = rand() * 0.1;
		return out;
	}

	before(async () => {
		setupTestDBPath();
		setMainIsWorker(true);
		TFloat = table({
			table: 'HNSWHdrFloat',
			database: 'test',
			attributes: [
				{ name: 'id', isPrimaryKey: true },
				{ name: 'vector', indexed: { type: 'HNSW', distance: 'euclidean', quantization: 'none' }, type: 'Array' },
			],
		});
		TInt8 = table({
			table: 'HNSWHdrInt8',
			database: 'test',
			attributes: [
				{ name: 'id', isPrimaryKey: true },
				{ name: 'vector', indexed: { type: 'HNSW', distance: 'euclidean', quantization: 'int8' }, type: 'Array' },
			],
		});
		for (let i = 0; i < N; i++) {
			const v = hdrVec(i);
			allFloat.push({ id: i, v });
			await TFloat.put(i, { vector: v });
			await TInt8.put(i, { vector: v });
		}
	});
	after(() => {
		TFloat.dropTable();
		TInt8.dropTable();
	});

	it('int8 recall@10 on HDR euclidean is at least 0.5 (documenting known lossy case)', async () => {
		// HDR vectors where small components are quantized to 0 represent a worst-case for int8.
		// A floor of 0.5 is deliberately lenient — this test documents current behavior and gives
		// us a regression signal, not a quality guarantee. If we raise this floor, that's progress.
		const K = 10;
		const QUERIES = 20;
		let totalHits = 0;
		for (let q = 0; q < QUERIES; q++) {
			const target = hdrVec(N + q);
			const brute = allFloat
				.map(({ id, v }) => ({ id, d: euclideanDist(target, v) }))
				.sort((a, b) => a.d - b.d)
				.slice(0, K);
			const truth = new Set(brute.map((x) => x.id));
			const results = await fromAsync(
				TInt8.search({ sort: { attribute: 'vector', target, distance: 'euclidean' }, select: ['id'], limit: K })
			);
			totalHits += results.filter((r) => truth.has(r.id)).length;
		}
		const recall = totalHits / (QUERIES * K);
		console.log(`int8 HDR euclidean recall@${K} over ${QUERIES} queries: ${(recall * 100).toFixed(1)}%`);
		assert(recall >= 0.5, `int8 HDR euclidean recall@${K} too low: ${(recall * 100).toFixed(1)}%`);
	});

	it('float baseline recall@10 on same HDR euclidean vectors is at least 0.8', async () => {
		// The float index is the control: if it also underperforms, the issue is graph quality,
		// not quantization. Failure here means the HDR vectors create a hard graph structure.
		const K = 10;
		const QUERIES = 20;
		let totalHits = 0;
		for (let q = 0; q < QUERIES; q++) {
			const target = hdrVec(N + q);
			const brute = allFloat
				.map(({ id, v }) => ({ id, d: euclideanDist(target, v) }))
				.sort((a, b) => a.d - b.d)
				.slice(0, K);
			const truth = new Set(brute.map((x) => x.id));
			const results = await fromAsync(
				TFloat.search({ sort: { attribute: 'vector', target, distance: 'euclidean' }, select: ['id'], limit: K })
			);
			totalHits += results.filter((r) => truth.has(r.id)).length;
		}
		const recall = totalHits / (QUERIES * K);
		console.log(`float HDR euclidean recall@${K} over ${QUERIES} queries: ${(recall * 100).toFixed(1)}%`);
		assert(recall >= 0.8, `float HDR euclidean recall@${K} too low: ${(recall * 100).toFixed(1)}%`);
	});

	function euclideanDist(a, b) {
		let sum = 0;
		for (let i = 0; i < a.length; i++) sum += (a[i] - b[i]) ** 2;
		return Math.sqrt(sum);
	}
});

// int8 threshold queries now over-fetch from HNSW (suppressing the approximate distance filter)
// and re-filter on exact full-precision distances after loading records. All boundary assertions
// are exact: every record whose true distance satisfies the predicate must appear, and every
// record outside must not.
//
// Note: the euclidean distance function (vector.ts) returns SQUARED euclidean for ranking
// efficiency — threshold values and $distance are in that same squared space.
describeUnlessLmdb('HNSW int8 threshold queries (lt/le) — exact boundary after rerank', () => {
	let T;
	const records = [];

	// Vectors on the x-axis: target=[0,0], record at [d,0] has squared-euclidean distance d².
	// Choosing d² values that are exactly representable in float64 makes boundary assertions
	// unambiguous (no floating-point fuzz to worry about).
	// id 0: d=0.5  → sq_dist=0.25
	// id 1: d=0.75 → sq_dist=0.5625
	// id 2: d=1.0  → sq_dist=1.0   ← used as exact le/lt boundary
	// id 3: d=1.5  → sq_dist=2.25
	// id 4: d=2.0  → sq_dist=4.0
	const VECTORS = [0.5, 0.75, 1.0, 1.5, 2.0];

	before(async () => {
		setupTestDBPath();
		setMainIsWorker(true);
		T = table({
			table: 'HNSWInt8Threshold',
			database: 'test',
			attributes: [
				{ name: 'id', isPrimaryKey: true },
				{ name: 'vector', indexed: { type: 'HNSW', distance: 'euclidean', quantization: 'int8' }, type: 'Array' },
			],
		});
		for (let i = 0; i < VECTORS.length; i++) {
			const d = VECTORS[i];
			records.push({ id: i, sqDist: d * d, vector: [d, 0] });
			await T.put(i, { vector: [d, 0] });
		}
	});
	after(() => T.dropTable());

	it('lt returns exactly the records whose squared-euclidean distance is strictly less than the threshold', async () => {
		// threshold=1.5 → includes id=0 (sq=0.25) and id=1 (sq=0.5625), excludes id=2 (sq=1.0)..id=4
		const threshold = 1.5;
		const results = await fromAsync(
			T.search({
				conditions: [{ attribute: 'vector', comparator: 'lt', value: threshold, target: [0, 0] }],
				select: ['id'],
			})
		);
		const ids = new Set(results.map((r) => r.id));
		for (const { id, sqDist } of records) {
			if (sqDist < threshold)
				assert(ids.has(id), `record id=${id} (sq_dist=${sqDist}) must appear with lt ${threshold}`);
			else assert(!ids.has(id), `record id=${id} (sq_dist=${sqDist}) must not appear with lt ${threshold}`);
		}
	});

	it('le includes the record at exactly the threshold; lt excludes it', async () => {
		// id=2 has sq_dist=1.0; threshold=1.0 sits exactly on the boundary.
		const threshold = 1.0;
		const ltResults = await fromAsync(
			T.search({
				conditions: [{ attribute: 'vector', comparator: 'lt', value: threshold, target: [0, 0] }],
				select: ['id'],
			})
		);
		const leResults = await fromAsync(
			T.search({
				conditions: [{ attribute: 'vector', comparator: 'le', value: threshold, target: [0, 0] }],
				select: ['id'],
			})
		);
		const ltIds = new Set(ltResults.map((r) => r.id));
		const leIds = new Set(leResults.map((r) => r.id));

		assert(!ltIds.has(2), 'lt must exclude the record at exactly sq_dist=threshold');
		assert(leIds.has(2), 'le must include the record at exactly sq_dist=threshold');

		// Records strictly inside are in both
		for (const { id, sqDist } of records) {
			if (sqDist < threshold) {
				assert(ltIds.has(id), `record id=${id} (sq_dist=${sqDist}) must appear in lt`);
				assert(leIds.has(id), `record id=${id} (sq_dist=${sqDist}) must appear in le`);
			}
		}
	});

	it('$distance on threshold results is the exact squared-euclidean from the full-precision record vector', async () => {
		const threshold = 2.0;
		const results = await fromAsync(
			T.search({
				conditions: [{ attribute: 'vector', comparator: 'lt', value: threshold, target: [0, 0] }],
				select: ['id', 'vector', '$distance'],
			})
		);
		assert(results.length > 0, 'expected results');
		for (const r of results) {
			// euclideanDistance returns squared distance (see vector.ts)
			const exact = r.vector[0] ** 2 + r.vector[1] ** 2;
			assert(
				Math.abs(r.$distance - exact) < 1e-10,
				`$distance ${r.$distance} should equal exact sq-euclidean ${exact} for record id=${r.id}`
			);
		}
	});
});

async function fromAsync(iterable) {
	let results = [];
	for await (let entry of iterable) {
		results.push(entry);
	}
	return results;
}
