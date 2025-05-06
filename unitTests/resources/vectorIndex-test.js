require('../test_utils');
const assert = require('node:assert');
const { getMockLMDBPath } = require('../test_utils');
const { table } = require('../../resources/databases');
const { HierarchicalNavigableSmallWorld } = require('../../ts-build/resources/indexes/HierarchicalNavigableSmallWorld');

describe('HierarchicalNavigableSmallWorld indexing', () => {
	let VectorTest;
	let testInstance = new HierarchicalNavigableSmallWorld();
	before(() => {
		VectorTest = table({
			table: 'VectorTest',
			database: 'test',
			attributes: [
				{ name: 'id', isPrimaryKey: true },
				{ name: 'name' },
				{ name: 'vector', indexed: { type: 'HNSW', dimension: 100, distance: 'cosine' }, type: 'Array' },
			],
		});
	});
	it('can index and search with vector index', async () => {
		let all = [];
		for (let i = 0; i < 200; i++) {
			let vector = [i % 2, i % 3, i % 4, i % 5, i % 6, i % 7, i % 8, i % 9, i % 10, i % 11];
			await VectorTest.put(i, {
				name: 'test',
				vector,
			});
			all.push(vector);
		}
		const testVector = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
		let results = await fromAsync(
			VectorTest.search([
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
	});
});
async function fromAsync(iterable) {
	let results = [];
	for await (let entry of iterable) {
		results.push(entry);
	}
	return results;
}
