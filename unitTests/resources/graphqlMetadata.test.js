const { setupTestDBPath } = require('../testUtils');
const { loadGQLSchema } = require('#src/resources/graphql');
const assert = require('assert');

describe('GraphQL parser — metadata capture (#1095)', () => {
	before(() => {
		setupTestDBPath();
	});

	describe('docstring capture', () => {
		before(async () => {
			await loadGQLSchema(`
				"""
				Product catalog row — what shows up in the storefront listing.
				"""
				type DocstringProduct @table {
					"""
					Stock keeping unit — globally unique across catalogs.
					"""
					sku: String! @primaryKey

					"""
					Display name shown in the storefront.
					"""
					name: String!

					inStock: Int!
				}
			`);
		});

		it('captures the type-level docstring on Table.description', () => {
			const table = tables.DocstringProduct;
			assert.match(table.description, /Product catalog row/);
		});

		it('captures field-level docstrings on Attribute.description', () => {
			const skuAttr = tables.DocstringProduct.attributes.find((a) => a.name === 'sku');
			const nameAttr = tables.DocstringProduct.attributes.find((a) => a.name === 'name');
			const inStockAttr = tables.DocstringProduct.attributes.find((a) => a.name === 'inStock');
			assert.match(skuAttr.description, /Stock keeping unit/);
			assert.match(nameAttr.description, /Display name shown/);
			assert.strictEqual(inStockAttr.description, undefined, 'inStock has no docstring');
		});

		it('co-populates Table.properties (Record) alongside Table.attributes (Array)', () => {
			const properties = tables.DocstringProduct.properties;
			assert.ok(properties, 'Table.properties Record exists');
			assert.match(properties.sku.description, /Stock keeping unit/);
			assert.strictEqual(properties.sku.type, 'string', 'String GraphQL → JSON Schema "string"');
			assert.strictEqual(properties.sku.primaryKey, true);
			assert.strictEqual(properties.inStock.type, 'integer', 'Int GraphQL → JSON Schema "integer"');
		});

		it('bidirectional consistency: properties[name] ⇔ attributes.find(name)', () => {
			const { attributes, properties } = tables.DocstringProduct;
			for (const attr of attributes) {
				const fragment = properties[attr.name];
				assert.ok(fragment, `properties has entry for ${attr.name}`);
				if (attr.description) assert.strictEqual(fragment.description, attr.description);
				if (attr.isPrimaryKey) assert.strictEqual(fragment.primaryKey, true);
			}
			for (const name of Object.keys(properties)) {
				assert.ok(
					attributes.find((a) => a.name === name),
					`attributes has entry for ${name}`
				);
			}
		});
	});

	describe('@hidden directive', () => {
		before(async () => {
			await loadGQLSchema(`
				type HiddenFieldProduct @table {
					sku: String! @primaryKey
					name: String!
					"""Internal — should not surface in MCP / OpenAPI."""
					internalNote: String @hidden
				}

				type HiddenTypeProduct @table @hidden {
					sku: String! @primaryKey
					name: String!
				}
			`);
		});

		it('marks a @hidden field on Attribute.hidden and properties.<name>.hidden', () => {
			const internal = tables.HiddenFieldProduct.attributes.find((a) => a.name === 'internalNote');
			assert.strictEqual(internal.hidden, true);
			assert.strictEqual(tables.HiddenFieldProduct.properties.internalNote.hidden, true);
		});

		it('marks a non-hidden field as not hidden', () => {
			const sku = tables.HiddenFieldProduct.attributes.find((a) => a.name === 'sku');
			assert.strictEqual(sku.hidden, undefined);
			assert.strictEqual(tables.HiddenFieldProduct.properties.sku.hidden, undefined);
		});

		it('marks a @hidden type on Table.hidden', () => {
			assert.strictEqual(tables.HiddenTypeProduct.hidden, true);
		});

		it('does NOT remove the field from Table.attributes — RBAC remains the access mechanism', () => {
			// @hidden only suppresses introspectable surfaces (MCP/OpenAPI). The field is
			// still queryable via direct access subject to attribute_permissions.
			const internal = tables.HiddenFieldProduct.attributes.find((a) => a.name === 'internalNote');
			assert.ok(internal, 'hidden attribute still present in attributes Array');
		});
	});

	describe('array element types in projected properties', () => {
		before(async () => {
			await loadGQLSchema(`
				type ArrayHolder @table {
					id: ID! @primaryKey
					tags: [String]
					counts: [Int]
				}
			`);
		});

		it('emits items shape for primitive-array fields, not bare { type: array }', () => {
			const tagsFragment = tables.ArrayHolder.properties.tags;
			assert.strictEqual(tagsFragment.type, 'array');
			assert.ok(tagsFragment.items, 'array properties carry items');
			assert.strictEqual(tagsFragment.items.type, 'string', 'String element maps to JSON Schema "string"');

			const countsFragment = tables.ArrayHolder.properties.counts;
			assert.strictEqual(countsFragment.type, 'array');
			assert.strictEqual(countsFragment.items.type, 'integer', 'Int element maps to JSON Schema "integer"');
		});
	});

	describe('typeDef.properties / typeDef.attributes shape distinction', () => {
		before(async () => {
			await loadGQLSchema(`
				type ShapeCheck @table {
					id: Int! @primaryKey
					title: String!
				}
			`);
		});

		it('Table.attributes is an Array', () => {
			assert.ok(Array.isArray(tables.ShapeCheck.attributes));
		});

		it('Table.properties is a plain object Record (not an Array)', () => {
			assert.ok(!Array.isArray(tables.ShapeCheck.properties));
			assert.strictEqual(typeof tables.ShapeCheck.properties, 'object');
			assert.ok(tables.ShapeCheck.properties.id);
			assert.ok(tables.ShapeCheck.properties.title);
		});
	});

	// #1920: a programmatic Resource may declare `static properties` (the Record form) without an
	// `attributes` Array; `projectPropertiesToAttributes` rebuilds the Array so the schema-derivation
	// paths (MCP, OpenAPI) can consume it. It must be the structural inverse of the forward projection.
	describe('projectPropertiesToAttributes (#1920)', () => {
		const { projectPropertiesToAttributes, projectAttributesToProperties } = require('#src/resources/jsonSchemaTypes');

		it('projects each property into a named attribute carrying type + description + flags', () => {
			const attrs = projectPropertiesToAttributes({
				id: { type: 'string', primaryKey: true },
				label: { type: 'string', description: 'Human-readable label' },
				size: { type: 'integer', description: 'Width in pixels', nullable: true },
			});
			const byName = Object.fromEntries(attrs.map((a) => [a.name, a]));
			assert.strictEqual(byName.id.isPrimaryKey, true);
			assert.strictEqual(byName.label.type, 'string');
			assert.strictEqual(byName.label.description, 'Human-readable label');
			assert.strictEqual(byName.size.type, 'integer');
			assert.strictEqual(byName.size.nullable, true);
		});

		it('round-trips with projectAttributesToProperties (properties -> attributes -> properties)', () => {
			// The `.properties` projection is front-end-neutral: type, description, primaryKey,
			// nested/array shapes, and nested object-level constraints (required/additionalProperties)
			// survive. enum/format/const deliberately do NOT (they'd break code-first ⇔ GraphQL parity
			// for `types.enum`; the MCP/OpenAPI schema paths surface those instead — see below).
			const properties = {
				sku: { type: 'string', description: 'Stock keeping unit', primaryKey: true },
				tags: { type: 'array', items: { type: 'string' } },
				dims: {
					type: 'object',
					required: ['w'],
					additionalProperties: false,
					properties: { w: { type: 'integer' }, h: { type: 'integer' } },
				},
			};
			const roundTripped = projectAttributesToProperties(projectPropertiesToAttributes(properties));
			assert.deepStrictEqual(roundTripped, properties);
		});

		it('folds a JSON-Schema union `["T","null"]` into nullable (not truncated to the first member)', () => {
			const [note] = projectPropertiesToAttributes({ note: { type: ['string', 'null'] } });
			assert.strictEqual(note.type, 'string');
			assert.strictEqual(note.nullable, true, 'the null member must become nullable, not be dropped');
		});
	});
});
