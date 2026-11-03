const assert = require('node:assert');
const { resolveAttributes, filterAttributeTree, attributeToSchema } = require('#src/resources/jsonSchemaTypes');
const { deriveCreateSchema } = require('#src/components/mcp/tools/schemas/derive');

const emit = (attribute) =>
	attributeToSchema(attribute, { dialect: 'json-schema', mapPrimitive: (type) => ({ type }) });

describe('PR 1921 schema feedback regressions', () => {
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

	it('uses the non-enumerable target coordinates produced by the GraphQL parser', async () => {
		await require('#src/resources/graphql').loadGQLSchema(`
			type FeedbackAuthor @table {
				id: ID! @primaryKey
				books: [FeedbackBook] @relationship(to: "authorId")
			}
			type FeedbackBook @table {
				id: ID! @primaryKey
				authorId: ID
				author: FeedbackAuthor @relationship(from: "authorId")
			}
		`);
		const author = tables.FeedbackBook.attributes.find((attribute) => attribute.name === 'author');
		const books = tables.FeedbackAuthor.attributes.find((attribute) => attribute.name === 'books');
		assert.equal(Object.prototype.propertyIsEnumerable.call(author, 'relationshipReference'), false);
		assert.equal(emit(author).description, 'Reference to data.FeedbackAuthor.');
		assert.equal(emit(books).description, 'Reference to data.FeedbackBook.');
	});
});
