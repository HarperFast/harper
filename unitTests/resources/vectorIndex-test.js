require('../test_utils');
const assert = require('node:assert');
const { table } = require('../../resources/databases');
const { HierarchicalNavigableSmallWorld } = require('../../ts-build/resources/indexes/HierarchicalNavigableSmallWorld');

describe('HierarchicalNavigableSmallWorld indexing', () => {
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
			table: 'HNSWTest',
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
			let vector = [(k % 20) + 0.3, (k % 33) + 0.2];
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
			withDistance.slice(0, 10).map((obj) => obj.vector),
			results.slice(0, 10).map((obj) => obj.vector)
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
					assert(neighborNode); // it should exist
					// verify that the connection is symmetrical
					let symmetrical = neighborNode[l].find(({ id }) => id === key);
					if (!symmetrical) {
						console.log('asymmetry in the graph', neighborNode[l], 'does not have key', key);
						asymmetries++;
					}
					let distance = testInstance.distance(value.vector, neighborNode.vector);
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
		if (invertedSimiliarities > 4)
			console.log('found', invertedSimiliarities, 'inversions of distance, which is more than desirable');
		assert(invertedSimiliarities < 5);
	}
});
async function fromAsync(iterable) {
	let results = [];
	for await (let entry of iterable) {
		results.push(entry);
	}
	return results;
}
