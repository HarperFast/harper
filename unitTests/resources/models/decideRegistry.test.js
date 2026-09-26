'use strict';

const assert = require('node:assert');
const { setupTestDBPath } = require('../../testUtils');
const { table } = require('#src/resources/databases');

// The per-table `@decide` registry on the Table class: default-decider registration, the
// component-author override (setDecideAttribute) surviving a schema reload, and stale-entry
// pruning when an attribute's `@decide` is dropped. Mirrors embedRegistry.test.js.
describe('@decide registry (setDecideAttribute + schema reload)', () => {
	let T;
	before(() => {
		setupTestDBPath();
		T = table({
			table: 'DecideRegTest',
			database: 'test',
			attributes: [
				{ name: 'id', isPrimaryKey: true },
				{ name: 'body', type: 'String' },
				{
					name: 'route',
					type: 'String',
					decide: { source: 'body', model: 'default', confidence: 'routeConfidence', schema: { enum: ['a', 'b'] } },
				},
				{ name: 'routeConfidence', type: 'Float' },
			],
		});
		T.updatedAttributes();
	});

	it('registers a default decider for a @decide attribute', () => {
		assert.equal(typeof T.userDeciders.route, 'function');
		assert.equal(T.userSetDeciders.has('route'), false, 'default registration is not marked as an override');
		assert.equal(T.decideAttributes.length, 1);
	});

	it('table() registers the default decider before the class is returned', () => {
		const Fresh = table({
			table: 'DecideRegFresh',
			database: 'test',
			attributes: [
				{ name: 'id', isPrimaryKey: true },
				{ name: 'body', type: 'String' },
				{ name: 'urgent', type: 'Boolean', decide: { source: 'body', model: 'default', schema: { type: 'boolean' } } },
			],
		});
		assert.equal(typeof Fresh.userDeciders.urgent, 'function', 'a write can never precede registration');
	});

	it('a programmatic declaration is held to the one-writer rule', () => {
		assert.throws(
			() =>
				table({
					table: 'DecideRegShared',
					database: 'test',
					attributes: [
						{ name: 'id', isPrimaryKey: true },
						{ name: 'body', type: 'String' },
						{
							name: 'route',
							type: 'String',
							decide: { source: 'body', model: 'default', confidence: 'confidence', schema: { enum: ['a', 'b'] } },
						},
						{
							name: 'urgent',
							type: 'Boolean',
							decide: { source: 'body', model: 'default', confidence: 'confidence', schema: { type: 'boolean' } },
						},
						{ name: 'confidence', type: 'Float' },
					],
				}),
			(err) => {
				assert.equal(err.statusCode, 400);
				assert.match(err.message, /both write "confidence"/);
				return true;
			}
		);
		assert.throws(
			() =>
				table({
					table: 'DecideRegChain',
					database: 'test',
					attributes: [
						{ name: 'id', isPrimaryKey: true },
						{ name: 'body', type: 'String' },
						{
							name: 'route',
							type: 'String',
							decide: { source: 'body', model: 'default', schema: { enum: ['a', 'b'] } },
						},
						{ name: 'vector', type: 'Array', embed: { source: 'route', model: 'default' }, indexed: { type: 'HNSW' } },
					],
				}),
			/derives from "route", which @decide on "route" writes/
		);
	});

	it('refuses an override for an attribute without @decide, or that does not exist', () => {
		const errors = [];
		const original = console.error;
		console.error = (message) => errors.push(String(message));
		try {
			T.setDecideAttribute('body', async () => null);
			T.setDecideAttribute('nope', async () => null);
		} finally {
			console.error = original;
		}
		assert.equal(T.userDeciders.body, undefined);
		assert.equal(T.userDeciders.nope, undefined);
		assert.match(errors[0], /not declared with @decide/);
		assert.match(errors[1], /does not exist/);
	});

	it('a component-author override survives a schema reload', () => {
		const custom = async () => ({ value: 'a', probability: 1 });
		T.setDecideAttribute('route', custom);
		assert.equal(T.userDeciders.route, custom);
		assert.ok(T.userSetDeciders.has('route'));

		T.updatedAttributes(); // simulate an in-place schema reload
		assert.equal(T.userDeciders.route, custom, 'custom decider must not be clobbered by the default on reload');
		assert.ok(T.userSetDeciders.has('route'));
	});

	it('dropping @decide prunes the registry (no stale decider or override flag)', () => {
		const attr = T.attributes.find((a) => a.name === 'route');
		delete attr.decide; // schema redeployed without the @decide directive
		T.updatedAttributes();

		assert.equal(T.userDeciders.route, undefined, 'stale decider must be pruned');
		assert.equal(T.userSetDeciders.has('route'), false, 'stale override flag must be pruned');
		assert.equal(T.decideAttributes.length, 0, 'decideAttributes must be refreshed');
	});
});
