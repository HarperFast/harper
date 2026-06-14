'use strict';

const assert = require('node:assert/strict');
const { setupTestDBPath } = require('../../testUtils');
const { table } = require('#src/resources/databases');

// Exercises the per-table `@embed` registry on the Table class: default-embedder
// registration, the component-author override (setEmbedAttribute) surviving a schema
// reload, and stale-entry pruning when an attribute's `@embed` is dropped.
describe('@embed registry (setEmbedAttribute + schema reload)', () => {
	let T;
	before(() => {
		setupTestDBPath();
		T = table({
			table: 'EmbedRegTest',
			database: 'test',
			attributes: [
				{ name: 'id', isPrimaryKey: true },
				{ name: 'content', type: 'String' },
				{ name: 'embedding', type: 'Array', embed: { source: 'content', model: 'default' }, indexed: { type: 'HNSW' } },
			],
		});
		T.updatedAttributes();
	});

	it('registers a default embedder for an @embed attribute', () => {
		assert.equal(typeof T.userEmbedders.embedding, 'function');
		assert.equal(T.userSetEmbedders.has('embedding'), false, 'default registration is not marked as an override');
	});

	it('a component-author override survives a schema reload', () => {
		const custom = async () => [1, 2, 3];
		T.setEmbedAttribute('embedding', custom);
		assert.equal(T.userEmbedders.embedding, custom);
		assert.ok(T.userSetEmbedders.has('embedding'));

		T.updatedAttributes(); // simulate an in-place schema reload
		assert.equal(T.userEmbedders.embedding, custom, 'custom embedder must not be clobbered by the default on reload');
		assert.ok(T.userSetEmbedders.has('embedding'));
	});

	it('dropping @embed prunes the registry (no stale embedder or override flag)', () => {
		const attr = T.attributes.find((a) => a.name === 'embedding');
		delete attr.embed; // schema redeployed without the @embed directive
		T.updatedAttributes();

		assert.equal(T.userEmbedders.embedding, undefined, 'stale embedder must be pruned');
		assert.equal(T.userSetEmbedders.has('embedding'), false, 'stale override flag must be pruned');
		assert.equal(T.embedAttributes.length, 0, 'embedAttributes must be refreshed');
	});
});
