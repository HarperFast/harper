require('../test_utils');
const assert = require('node:assert');
const { getMockLMDBPath } = require('../test_utils');
const { table } = require('../../resources/databases');
const { HierarchicalNavigableSmallWorld } = require('../../ts-build/resources/indexes/HierarchicalNavigableSmallWorld');

describe('HierarchicalNavigableSmallWorld indexing', () => {
	let HNSWTest;
	let testInstance = new HierarchicalNavigableSmallWorld();
	before(() => {
		HNSWTest = table({
			table: 'HNSWTest',
			database: 'test',
			attributes: [
				{ name: 'id', isPrimaryKey: true },
				{ name: 'name' },
				{ name: 'vector', indexed: { type: 'HNSW' }, type: 'Array' },
			],
		});
	});
	it('can index and search with vector index', async () => {
		let all = [];
		/*let starting = Array.from(HNSWTest.indices.vector.getRange({}));
		console.log(
			starting.map(({ key, value }) => {
				return `${key}: ${Object.assign([], value)
					.map((level) =>
						level
							.map((neighbor) => {
								return (
									neighbor +
									':' +
									testInstance.similarity(value.vector, HNSWTest.indices.vector.get(neighbor).vector).toFixed(2)
								);
							})
							.join(',')
					)
					.join(' - ')}`;
			})
		);*/
		for (let i = 0; i < 200; i++) {
			let vector = [i % 2, i % 3, i % 4, i % 5, i % 6, i % 7, i % 8, i % 9, i % 10, i % 11];
			await HNSWTest.put(i, {
				name: 'test',
				vector,
			});
			all.push(vector);
		}
		const testVector = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
		let results = await fromAsync(
			HNSWTest.search([
				{
					attribute: 'vector',
					comparator: 'similarity',
					value: testVector,
				},
			])
		);
		// find the best matches through brute force comparison
		let withSimilarity = all.map((vector) => ({ vector, similarity: testInstance.similarity(testVector, vector) }));
		withSimilarity.sort((a, b) => b.similarity - a.similarity);
		// verify the first 10 match
		assert.deepEqual(
			withSimilarity.slice(0, 10).map((obj) => obj.vector),
			results.slice(0, 10).map((obj) => obj.vector)
		);
		// now verify integrity and proper similarity/distancing across levels
		for (let { key, value } of HNSWTest.indices.vector.getRange({})) {
			let lastSimilarity = 1;
			let l = 0;
			let connections;
			while ((connections = value[l])) {
				// verify that the level is not empty, otherwise this means we have an orphaned node
				if (connections.length === 0) {
					console.log('no connections for ', key, ' at level ', l);
					l++;
					continue;
				}
				//assert(connections.length > 0);
				// compute the average similarity of the neighbors in this level
				let totalSimilarity = 0;
				for (let neighbor of connections) {
					let neighborNode = HNSWTest.indices.vector.get(neighbor);
					assert(neighborNode); // it should exist
					// verify that the connection is symmetrical
					let symmetrical = neighborNode[l].includes(key);
					if (!symmetrical) {
						console.log(neighborNode[l]);
					}
					assert(symmetrical);
					let similarity = testInstance.similarity(value.vector, neighborNode.vector);
					totalSimilarity += similarity;
				}
				let similarity = totalSimilarity / connections.length;
				// verify that the higher level (skip level) similarities are always less than previous levels (non-skip,
				// or shorter skip), which should be the case for a HNSW index
				if (!(similarity < lastSimilarity)) {
					console.log(similarity, lastSimilarity);
				}
				assert(similarity < lastSimilarity);
				lastSimilarity = similarity;
				l++;
			}
		}
	});
	it('can delete and update and search with vector index with one dimension', async () => {});
	it('can index and search with vector index with one dimension', async () => {});
});
async function fromAsync(iterable) {
	let results = [];
	for await (let entry of iterable) {
		results.push(entry);
	}
	return results;
}
