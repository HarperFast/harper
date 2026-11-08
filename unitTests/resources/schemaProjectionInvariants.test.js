const assert = require('node:assert');
const { resolveAttributes, filterAttributeTree, attributeToSchema } = require('#src/resources/jsonSchemaTypes');
const { deriveCreateSchema } = require('#src/components/mcp/tools/schemas/derive');

const emit = (attribute) =>
	attributeToSchema(attribute, { dialect: 'json-schema', mapPrimitive: (type) => ({ type }) });

describe('programmatic schema projection invariants', () => {
	before(() => require('../testUtils').setupTestDBPath());
	it('refreshes projections after in-place additions, deletions, and nested edits', () => {
		const source = { properties: { profile: { type: 'object', properties: { name: { type: 'string' } } } } };
		const first = resolveAttributes(source);
		source.properties.count = { type: 'integer' };
		assert.ok(resolveAttributes(source).some((attribute) => attribute.name === 'count'));
		delete source.properties.count;
		source.properties.profile.properties.name.description = 'Updated';
		const updated = resolveAttributes(source);
		assert.equal(
			updated.some((attribute) => attribute.name === 'count'),
			false
		);
		assert.equal(emit(updated[0]).properties.name.description, 'Updated');
		assert.equal(first[0].properties[0].description, undefined);
	});

	it('keeps structural type inference in metadata projections', () => {
		const attributes = resolveAttributes({ properties: { profile: { properties: { label: { type: 'string' } } } } });
		assert.equal(attributes[0].type, 'object');
		assert.equal(deriveCreateSchema(attributes).properties.profile.type, 'object');
		assert.equal(
			attributeToSchema(attributes[0], { dialect: 'openapi-3.0.3', mapPrimitive: (type) => ({ type }) }).type,
			'object'
		);
	});

	it('preserves undeclared required names while pruning explicitly hidden names', () => {
		const source = {
			properties: { secret: { type: 'string', hidden: true } },
			required: ['extension', 'secret'],
		};
		const attributes = resolveAttributes(source);
		assert.deepEqual(deriveCreateSchema(attributes, undefined).required, ['extension']);
		const [profile] = filterAttributeTree([{ name: 'profile', properties: attributes, required: source.required }]);
		assert.deepEqual(profile.required, ['extension']);
	});

	it('accepts object and array enum members with structural const intersection', () => {
		const [attribute] = resolveAttributes({
			properties: {
				value: { enum: [{ a: 1, b: [true, null] }, ['x']], const: { b: [true, null], a: 1 } },
			},
		});
		assert.deepEqual(emit(attribute).enum, [{ a: 1, b: [true, null] }, ['x']]);
		assert.deepEqual(emit(attribute).const, { b: [true, null], a: 1 });
	});

	it('invalidates a previously valid projection when nested metadata becomes malformed', () => {
		const source = { properties: { value: { enum: ['a'] } } };
		resolveAttributes(source);
		source.properties.value.enum = 'abc';
		assert.throws(() => resolveAttributes(source), /enum/);
	});

	it('labels scalar and array relationships using their target type', () => {
		assert.deepEqual(emit({ name: 'owner', type: 'Person', relationship: { from: 'ownerId' } }), {
			description: 'Reference to Person.',
		});
		assert.deepEqual(
			emit({ name: 'dogs', type: 'array', elements: { name: '', type: 'Dog' }, relationship: { to: 'ownerId' } }),
			{
				type: 'array',
				items: {},
				description: 'Reference to Dog.',
			}
		);
	});
	it('keeps required-only object fragments and safely normalizes undeclared names', () => {
		const [profile] = resolveAttributes({ properties: { profile: { type: 'object', required: ['extension'] } } });
		assert.deepEqual(emit(profile).required, ['extension']);
		const schema = deriveCreateSchema(resolveAttributes({ properties: {}, required: ['__proto__'] }));
		assert.equal(Object.getPrototypeOf(schema.properties), null);
		assert.deepEqual(schema.properties.__proto__, {});
		assert.deepEqual(schema.required, ['__proto__']);
	});

	it('deduplicates JSON enum values regardless of object key order', () => {
		const values = Array.from({ length: 5000 }, (_, index) =>
			index % 2 ? { b: [true, null], a: index % 50 } : { a: index % 50, b: [true, null] }
		);
		const [attribute] = resolveAttributes({ properties: { value: { enum: values } } });
		assert.equal(attribute.enum.length, 50);
	});

	it('rejects non-JSON enum and const values, including nested invalid values', () => {
		const cyclic = {};
		cyclic.self = cyclic;
		for (const value of [new Date(), new Map(), { nested: undefined }, [NaN], cyclic]) {
			for (const keyword of ['enum', 'const']) {
				assert.throws(
					() => resolveAttributes({ properties: { value: { [keyword]: keyword === 'enum' ? [value] : value } } }),
					/JSON|cycle/
				);
			}
		}
	});

	it('accepts JSON objects authored in an application VM realm', () => {
		const value = require('node:vm').runInNewContext('({ b: [true, null], a: 1 })');
		const [attribute] = resolveAttributes({
			properties: { value: { enum: [value], const: { a: 1, b: [true, null] } } },
		});
		assert.deepEqual(attribute.enum, [{ a: 1, b: [true, null] }]);
	});

	it('rejects sparse required lists and type arrays as malformed metadata', () => {
		assert.throws(() => resolveAttributes({ properties: {}, required: Array(1) }), /array of strings/);
		assert.throws(() => resolveAttributes({ properties: { value: { required: Array(1) } } }), /array of strings/);
		assert.throws(() => resolveAttributes({ properties: { value: { type: Array(1) } } }), /only strings/);
	});

	it('does not enforce advisory table enums in MCP inputs or responses', async () => {
		const { defineTable, types } = require('#src/resources/defineTable');
		const Table = defineTable(
			'AdvisoryEnum',
			{ id: types.id.primaryKey, status: types.enum(['open', 'closed']) },
			{ database: 'schemaProjection' }
		);
		await Table.put({ id: 'pending', status: 'pending' });
		const {
			deriveGetOutputSchema,
			deriveUpdateSchema,
			deriveGetSchema,
		} = require('#src/components/mcp/tools/schemas/derive');
		assert.equal(deriveCreateSchema(resolveAttributes(Table)).properties.status.enum, undefined);
		assert.equal(deriveUpdateSchema(resolveAttributes(Table)).properties.status.enum, undefined);
		Table.attributes.find((attribute) => attribute.isPrimaryKey).enum = ['limited'];
		assert.equal(deriveGetSchema(resolveAttributes(Table)).properties.id.enum, undefined);
		const programmatic = resolveAttributes({ properties: Table.attributes });
		assert.deepEqual(deriveGetOutputSchema(programmatic).properties.status.enum, ['open', 'closed']);
		const schema = deriveGetOutputSchema(resolveAttributes(Table));
		assert.equal(schema.properties.status.enum, undefined);
		const map = new Map([['AdvisoryEnum', { path: 'AdvisoryEnum', Resource: Table }]]);
		map.allTypes = new Map();
		const api = require('#src/resources/openApi').generateJsonApi(map, 'https://harper.fast');
		assert.equal(api.components.schemas.AdvisoryEnum.properties.status.enum, undefined);
		const path = require('node:path');
		const provider = path.join(
			path.dirname(require.resolve('@modelcontextprotocol/sdk/types.js')),
			'validation',
			'ajv-provider.js'
		);
		const { AjvJsonSchemaValidator } = require(provider);
		const result = JSON.parse(JSON.stringify(await Table.get('pending')));
		assert.equal(new AjvJsonSchemaValidator().getValidator(schema)(result).valid, true);
	});

	it('names the malformed value constraint in schema diagnostics', () => {
		assert.throws(
			() => resolveAttributes({ properties: { createdAt: { const: new Date(0) } } }),
			/createdAt.const.*JSON-serializable/
		);
		assert.throws(
			() => resolveAttributes({ properties: { state: { enum: [new Map()] } } }),
			/state.enum.*JSON-serializable/
		);
	});

	it('preserves hard constraints on Array-form programmatic declarations', () => {
		const Resource = { prototype: { get() {} }, properties: [{ name: 'status', type: 'string', enum: ['open'] }] };
		const attributes = resolveAttributes(Resource);
		const { deriveGetOutputSchema } = require('#src/components/mcp/tools/schemas/derive');
		assert.deepEqual(deriveGetOutputSchema(attributes).properties.status.enum, ['open']);
		const map = new Map([['ArrayResource', { path: 'ArrayResource', Resource }]]);
		map.allTypes = new Map();
		const api = require('#src/resources/openApi').generateJsonApi(map, 'https://harper.fast');
		assert.deepEqual(api.components.schemas.ArrayResource.properties.status.enum, ['open']);
	});

	it('keeps undeclared required fields out of attribute routes and search hints', () => {
		const Resource = {
			prototype: { get() {} },
			properties: { id: { type: 'string', primaryKey: true } },
			required: ['extension'],
		};
		const attributes = resolveAttributes(Resource);
		const { deriveSearchSchema } = require('#src/components/mcp/tools/schemas/derive');
		assert.deepEqual(deriveSearchSchema(attributes).properties.conditions.items.properties.attribute.enum, ['id']);
		const map = new Map([['RequiredResource', { path: 'RequiredResource', Resource }]]);
		map.allTypes = new Map();
		const api = require('#src/resources/openApi').generateJsonApi(map, 'https://harper.fast');
		assert.ok(Object.hasOwn(api.components.schemas.RequiredResource.properties, 'extension'));
		assert.ok(api.components.schemas.RequiredResource.required.includes('extension'));
		const parameters = api.paths['/RequiredResource/{id}.{property}'].get.parameters;
		assert.deepEqual(parameters.find((parameter) => parameter.name === 'property').schema.enum, ['id']);
		assert.equal(
			api.paths['/RequiredResource/'].get.parameters.some((parameter) => parameter.name === 'extension'),
			false
		);
	});

	it('derives schemas from real recursive GraphQL table metadata', async () => {
		await require('#src/resources/graphql').loadGQLSchema(`
			type RecursiveProjectionNode { label: String children: [RecursiveProjectionNode] }
			type RecursiveProjectionDoc @table(database: "schemaProjection") {
				id: ID! @primaryKey
				tree: RecursiveProjectionNode
			}
		`);
		const Table = require('#src/resources/databases').databases.schemaProjection.RecursiveProjectionDoc;
		const { deriveGetOutputSchema } = require('#src/components/mcp/tools/schemas/derive');
		assert.equal(deriveCreateSchema(Table.attributes).properties.id.type, 'string');
		assert.equal(deriveGetOutputSchema(Table.attributes).properties.id.type, 'string');
	});

	it('uses the non-enumerable target coordinates produced by the GraphQL parser', async () => {
		await require('#src/resources/graphql').loadGQLSchema(`
			type FeedbackAuthor @table(database: "schemaProjection") {
				id: ID! @primaryKey
				books: [FeedbackBook] @relationship(to: "authorId")
			}
			type FeedbackBook @table(database: "schemaProjection") {
				id: ID! @primaryKey
				authorId: ID
				payload: Blob
				author: FeedbackAuthor @relationship(from: "authorId")
			}
		`);
		const fixture = require('#src/resources/databases').databases.schemaProjection;
		const author = fixture.FeedbackBook.attributes.find((attribute) => attribute.name === 'author');
		const books = fixture.FeedbackAuthor.attributes.find((attribute) => attribute.name === 'books');
		assert.equal(Object.prototype.propertyIsEnumerable.call(author, 'relationshipReference'), false);
		assert.equal(emit(author).description, 'Reference to schemaProjection.FeedbackAuthor.');
		assert.equal(emit(books).description, 'Reference to schemaProjection.FeedbackBook.');
		const map = new Map([['FeedbackBook', { path: 'FeedbackBook', Resource: fixture.FeedbackBook }]]);
		map.allTypes = new Map();
		const api = require('#src/resources/openApi').generateJsonApi(map, 'https://harper.fast');
		assert.equal(api.components.schemas.FeedbackBook.properties.payload.type, 'string');
	});
});
