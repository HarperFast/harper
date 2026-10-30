'use strict';

const assert = require('node:assert');
const { setupTestDBPath } = require('../../testUtils');
const { table } = require('#src/resources/databases');

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
		assert.throws(
			() =>
				table({
					table: 'DecideRegProto',
					database: 'test',
					attributes: [
						{ name: 'id', isPrimaryKey: true },
						{ name: 'toString', type: 'String' },
						{
							name: 'vector',
							type: 'Array',
							embed: { source: 'toString', model: 'default' },
							indexed: { type: 'HNSW' },
						},
					],
				}),
			/"toString" is an Object.prototype key/
		);
	});

	it('a rejected redeclaration reaches neither the catalog nor the live registries', () => {
		const declare = (urgentConfidence) =>
			table({
				table: 'DecideRegRedeclare',
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
					{
						name: 'urgent',
						type: 'Boolean',
						decide: { source: 'body', model: 'default', confidence: urgentConfidence, schema: { type: 'boolean' } },
					},
					{ name: 'urgentConfidence', type: 'Float' },
				],
			});
		const Live = declare('urgentConfidence');
		const urgentDecider = Live.userDeciders.urgent;
		assert.throws(() => declare('routeConfidence'), /both write "routeConfidence"/);
		const urgent = Live.attributes.find((a) => a.name === 'urgent');
		assert.equal(urgent.decide.confidence, 'urgentConfidence', 'the live descriptor is unchanged');
		assert.deepEqual(
			Live.decideAttributes.map((a) => a.decide.confidence),
			['routeConfidence', 'urgentConfidence'],
			'the live hook list is unchanged'
		);
		assert.equal(Live.userDeciders.urgent, urgentDecider, 'the live deciders are unchanged');
		const Reloaded = declare('urgentConfidence');
		assert.equal(Reloaded.attributes.find((a) => a.name === 'urgent').decide.confidence, 'urgentConfidence');
	});

	(process.env.HARPER_STORAGE_ENGINE === 'lmdb' ? it.skip : it)(
		'a refused redeclaration that also changes @fullText leaves the persisted definitions untouched',
		() => {
			const declare = (urgentConfidence, indexName) =>
				table({
					table: 'DecideRegFullText',
					database: 'test',
					audit: true,
					attributes: [
						{ name: 'id', isPrimaryKey: true },
						{ name: 'body', type: 'String' },
						{
							name: 'route',
							type: 'String',
							decide: { source: 'body', model: 'default', confidence: 'routeConfidence', schema: { enum: ['a', 'b'] } },
						},
						{ name: 'routeConfidence', type: 'Float' },
						{
							name: 'urgent',
							type: 'Boolean',
							decide: { source: 'body', model: 'default', confidence: urgentConfidence, schema: { type: 'boolean' } },
						},
						{ name: 'urgentConfidence', type: 'Float' },
					],
					fullTextIndexes: [{ name: indexName, fields: [{ name: 'body' }] }],
				});
			const Live = declare('urgentConfidence', 'search');
			const persisted = () =>
				Live.dbisDB.getSync(`${Live.tableName}/${Live.primaryKey}`) ?? Live.dbisDB.getSync(`${Live.tableName}/`);
			assert.strictEqual(persisted().fullTextIndexes[0].name, 'search');
			assert.throws(() => declare('routeConfidence', 'renamed'), /both write "routeConfidence"/);
			assert.strictEqual(persisted().fullTextIndexes[0].name, 'search', 'the persisted definitions are unchanged');
			assert.strictEqual(persisted().fullTextIndexRetirements, undefined, 'no retirement was recorded');
			assert.strictEqual(Live.fullTextIndexes[0].name, 'search', 'the live definitions are unchanged');
		}
	);

	it('a peer declaration that conflicts only once merged with the live fields is rejected before it lands', () => {
		const Live = table({
			table: 'DecideRegPeer',
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
		assert.throws(
			() =>
				table({
					table: 'DecideRegPeer',
					database: 'test',
					origin: 'cluster',
					attributes: [
						{
							name: 'flag',
							type: 'Boolean',
							decide: { source: 'body', model: 'default', confidence: 'routeConfidence', schema: { type: 'boolean' } },
						},
					],
				}),
			/both write "routeConfidence"/
		);
		assert.equal(
			Live.attributes.find((a) => a.name === 'flag'),
			undefined,
			'the peer field did not land'
		);
		assert.equal(Live.decideAttributes.length, 1, 'the live hook list is unchanged');
	});

	it('a code-declared table gets the same field rules as a schema', () => {
		const declare = (name, attributes) => () => table({ table: name, database: 'test', attributes });
		const base = [
			{ name: 'id', isPrimaryKey: true },
			{ name: 'body', type: 'String' },
		];
		assert.throws(
			declare('DecideRegBoth', [
				...base,
				{
					name: 'both',
					type: 'String',
					embed: { source: 'body', model: 'default' },
					decide: { source: 'body', model: 'default', schema: { enum: ['a', 'b'] } },
				},
			]),
			/@decide on "both" and @embed on "both" both write "both"/
		);
		assert.throws(
			declare('DecideRegNoSource', [
				...base,
				{ name: 'route', type: 'String', decide: { source: 'bdoy', model: 'default', schema: { enum: ['a', 'b'] } } },
			]),
			/unknown source field "bdoy"/
		);
		assert.throws(
			declare('DecideRegNoConf', [
				...base,
				{
					name: 'route',
					type: 'String',
					decide: { source: 'body', model: 'default', confidence: 'nope', schema: { enum: ['a', 'b'] } },
				},
			]),
			/unknown confidence field "nope"/
		);
		assert.throws(
			declare('DecideRegConfType', [
				...base,
				{
					name: 'route',
					type: 'String',
					decide: { source: 'body', model: 'default', confidence: 'score', schema: { enum: ['a', 'b'] } },
				},
				{ name: 'score', type: 'String' },
			]),
			/requires a Float confidence attribute/
		);
		assert.throws(
			declare('DecideRegConfPk', [
				...base,
				{
					name: 'route',
					type: 'String',
					decide: { source: 'body', model: 'default', confidence: 'id', schema: { enum: ['a', 'b'] } },
				},
			]),
			/cannot be @primaryKey or @computed/
		);
		assert.throws(
			declare('DecideRegTargetPk', [
				{
					name: 'id',
					isPrimaryKey: true,
					type: 'String',
					decide: { source: 'body', model: 'default', schema: { enum: ['a', 'b'] } },
				},
				{ name: 'body', type: 'String' },
			]),
			/@decide on "id" cannot combine with @primaryKey or @computed/
		);
		assert.throws(
			declare('DecideRegTargetNonNull', [
				...base,
				{
					name: 'route',
					type: 'String',
					nullable: false,
					decide: { source: 'body', model: 'default', schema: { enum: ['a', 'b'] } },
				},
			]),
			/cannot be declared non-null/
		);
		assert.throws(
			declare('DecideRegTargetType', [
				...base,
				{ name: 'score', type: 'Float', decide: { source: 'body', model: 'default', schema: { enum: ['a', 'b'] } } },
			]),
			/requires a String, Boolean or Int attribute type; got "Float"/
		);
		assert.throws(
			declare('DecideRegLeafMismatch', [
				...base,
				{ name: 'urgent', type: 'Boolean', decide: { source: 'body', model: 'default', schema: { enum: ['a', 'b'] } } },
			]),
			/does not fit a Boolean attribute/
		);
		assert.throws(
			declare('DecideRegStringEnumKind', [
				...base,
				{ name: 'route', type: 'String', decide: { source: 'body', model: 'default', schema: { enum: [1, 2] } } },
			]),
			/does not fit a String attribute/
		);
		assert.throws(
			declare('DecideRegBooleanEnum', [
				...base,
				{
					name: 'urgent',
					type: 'Boolean',
					decide: { source: 'body', model: 'default', schema: { type: 'boolean', enum: ['a', 'b'] } },
				},
			]),
			/does not fit a Boolean attribute/
		);
		assert.throws(
			declare('DecideRegIntEnum', [
				...base,
				{
					name: 'severity',
					type: 'Int',
					decide: {
						source: 'body',
						model: 'default',
						schema: { type: 'integer', minimum: 1, maximum: 5, enum: [1, 2] },
					},
				},
			]),
			/does not fit a Int attribute/
		);
		assert.throws(
			declare('DecideRegIntBounds', [
				...base,
				{
					name: 'severity',
					type: 'Int',
					decide: {
						source: 'body',
						model: 'default',
						schema: { type: 'integer', minimum: 2147483640, maximum: 2147483650 },
					},
				},
			]),
			/does not fit a Int attribute/
		);
		assert.throws(
			declare('DecideRegBadSchema', [
				...base,
				{ name: 'route', type: 'String', decide: { source: 'body', model: 'default', schema: { enum: ['only'] } } },
			]),
			/@decide on "route":/
		);
	});

	it('a redeclaration that omits the primary key still resolves a directive sourced from it', () => {
		const attributes = (withId) => [
			...(withId ? [{ name: 'id', isPrimaryKey: true }] : []),
			{ name: 'label', type: 'String', decide: { source: 'id', model: 'default', schema: { enum: ['a', 'b'] } } },
		];
		table({ table: 'DecideRegInheritPk', database: 'test', attributes: attributes(true) });
		const Redeclared = table({ table: 'DecideRegInheritPk', database: 'test', attributes: attributes(false) });
		assert.ok(Redeclared.attributes.find((a) => a.name === 'id')?.isPrimaryKey, 'the primary key is inherited');
		assert.equal(typeof Redeclared.userDeciders.label, 'function');
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
