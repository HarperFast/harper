const assert = require('node:assert/strict');
const {
	deriveGetSchema,
	deriveSearchSchema,
	deriveCreateSchema,
	deriveUpdateSchema,
	deriveDeleteSchema,
	deriveGetOutputSchema,
	deriveCreateOutputSchema,
	deriveUpdateOutputSchema,
	derivePatchOutputSchema,
	deriveDeleteOutputSchema,
} = require('#src/components/mcp/tools/schemas/derive');

const PRODUCT_ATTRS = [
	{ name: 'id', type: 'ID', isPrimaryKey: true },
	{ name: 'name', type: 'String' },
	{ name: 'price', type: 'Float', nullable: true },
	{ name: 'count', type: 'Int' },
	{ name: 'created', type: 'Date', assignCreatedTime: true },
	{ name: 'updated', type: 'Date', assignUpdatedTime: true },
];

describe('mcp/tools/schemas/derive', () => {
	describe('deriveGetSchema', () => {
		it('requires id and exposes get_attributes', () => {
			const schema = deriveGetSchema(PRODUCT_ATTRS);
			assert.equal(schema.type, 'object');
			assert.deepEqual(schema.required, ['id']);
			assert.equal(schema.properties.id.type, 'string');
			assert.ok(schema.properties.get_attributes);
		});

		it('falls back to a generic string PK if no primary key is declared', () => {
			const schema = deriveGetSchema([{ name: 'name', type: 'String' }]);
			assert.equal(schema.properties.id.type, 'string');
		});
	});

	describe('deriveSearchSchema', () => {
		it('exposes conditions, operator, get_attributes, limit, cursor', () => {
			const schema = deriveSearchSchema(PRODUCT_ATTRS);
			assert.equal(schema.type, 'object');
			assert.ok(schema.properties.conditions);
			assert.ok(schema.properties.operator);
			assert.ok(schema.properties.limit);
			assert.ok(schema.properties.cursor);
		});

		it('enumerates readable attribute names in conditions.attribute', () => {
			const schema = deriveSearchSchema(PRODUCT_ATTRS);
			const attrEnum = schema.properties.conditions.items.properties.attribute.enum;
			assert.ok(attrEnum.includes('name'));
			assert.ok(attrEnum.includes('price'));
		});

		it('hides attributes the user cannot read', () => {
			const perms = [
				{ attribute_name: 'id', read: true },
				{ attribute_name: 'name', read: true },
				{ attribute_name: 'price', read: false },
				{ attribute_name: 'count', read: true },
				{ attribute_name: 'created', read: true },
				{ attribute_name: 'updated', read: true },
			];
			const schema = deriveSearchSchema(PRODUCT_ATTRS, perms);
			const attrEnum = schema.properties.conditions.items.properties.attribute.enum;
			assert.ok(!attrEnum.includes('price'));
			assert.ok(attrEnum.includes('name'));
		});
	});

	describe('deriveCreateSchema', () => {
		it('requires non-nullable non-PK columns and omits auto-managed columns', () => {
			const schema = deriveCreateSchema(PRODUCT_ATTRS);
			// PK is optional in create input — Harper auto-generates when omitted.
			assert.ok('id' in schema.properties, 'PK present in create input');
			assert.ok(!schema.required.includes('id'), 'PK is not required (auto-generated when omitted)');
			assert.equal(schema.properties.created, undefined, 'assignCreatedTime field omitted');
			assert.equal(schema.properties.updated, undefined, 'assignUpdatedTime field omitted');
			assert.ok(schema.required.includes('name'));
			assert.ok(schema.required.includes('count'));
			assert.ok(!schema.required.includes('price'), 'nullable field is optional');
		});

		it('filters out attributes the user cannot insert', () => {
			const perms = [
				{ attribute_name: 'name', insert: true },
				{ attribute_name: 'count', insert: false },
				{ attribute_name: 'price', insert: true },
			];
			const schema = deriveCreateSchema(PRODUCT_ATTRS, perms);
			assert.ok('name' in schema.properties);
			assert.equal(schema.properties.count, undefined);
		});
	});

	describe('deriveUpdateSchema', () => {
		it('requires only id; other writable fields are optional', () => {
			const schema = deriveUpdateSchema(PRODUCT_ATTRS);
			assert.deepEqual(schema.required, ['id']);
			assert.ok('name' in schema.properties);
			assert.ok('price' in schema.properties);
			assert.equal(schema.properties.created, undefined, 'auto-managed field omitted');
		});
	});

	describe('deriveDeleteSchema', () => {
		it('requires only id', () => {
			const schema = deriveDeleteSchema(PRODUCT_ATTRS);
			assert.deepEqual(schema.required, ['id']);
			assert.equal(Object.keys(schema.properties).length, 1);
		});
	});

	// Output schemas (#1324): create/update/patch/delete advertise the result
	// envelope their handlers actually return — an object (MCP requires
	// structuredContent/outputSchema to be object-shaped), not the full record.
	describe('output schemas', () => {
		it('deriveGetOutputSchema returns the full record shape', () => {
			const schema = deriveGetOutputSchema(PRODUCT_ATTRS);
			assert.equal(schema.type, 'object');
			assert.ok('name' in schema.properties, 'record fields present');
			assert.ok('updated' in schema.properties, 'server-assigned fields present on read');
		});

		it('deriveCreateOutputSchema is { id } typed by the primary key', () => {
			const schema = deriveCreateOutputSchema(PRODUCT_ATTRS);
			assert.equal(schema.type, 'object');
			assert.deepEqual(Object.keys(schema.properties), ['id']);
			assert.deepEqual(schema.required, ['id']);
			assert.equal(schema.additionalProperties, false);
			// PK is type ID -> string.
			assert.equal(schema.properties.id.type, 'string');
			// Does not require server-assigned fields a fresh record may lack (#1324).
			assert.ok(!('updated' in schema.properties), 'no @updatedTime in create output');
		});

		it('deriveCreateOutputSchema falls back to a string id when no PK is declared', () => {
			const schema = deriveCreateOutputSchema([{ name: 'name', type: 'String' }]);
			assert.equal(schema.properties.id.type, 'string');
		});

		it('deriveCreateOutputSchema types a numeric primary key as integer', () => {
			const schema = deriveCreateOutputSchema([{ name: 'pk', type: 'Long', isPrimaryKey: true }]);
			assert.equal(schema.properties.id.type, 'integer');
		});

		for (const [label, fn] of [
			['deriveUpdateOutputSchema', deriveUpdateOutputSchema],
			['derivePatchOutputSchema', derivePatchOutputSchema],
		]) {
			it(`${label} is a { ok: boolean } acknowledgement`, () => {
				const schema = fn(PRODUCT_ATTRS);
				assert.equal(schema.type, 'object');
				assert.deepEqual(schema.required, ['ok']);
				assert.equal(schema.properties.ok.type, 'boolean');
				assert.equal(schema.additionalProperties, false);
			});
		}

		it('deriveDeleteOutputSchema is a { deleted: boolean } object', () => {
			const schema = deriveDeleteOutputSchema(PRODUCT_ATTRS);
			assert.equal(schema.type, 'object');
			assert.deepEqual(schema.required, ['deleted']);
			assert.equal(schema.properties.deleted.type, 'boolean');
			assert.equal(schema.additionalProperties, false);
		});
	});

	describe('type mapping', () => {
		const TYPES = [
			{ name: 'i', type: 'Int' },
			{ name: 'f', type: 'Float' },
			{ name: 'b', type: 'Boolean' },
			{ name: 's', type: 'String' },
			{ name: 'd', type: 'Date' },
			{ name: 'big', type: 'BigInt' },
			{ name: 'blob', type: 'Blob' },
			{ name: 'any', type: 'Any' },
			{ name: 'nul', type: 'String', nullable: true },
		];

		it('maps Harper types to the right JSON Schema types', () => {
			const schema = deriveUpdateSchema([{ name: 'id', type: 'ID', isPrimaryKey: true }, ...TYPES]);
			assert.equal(schema.properties.i.type, 'integer');
			assert.equal(schema.properties.f.type, 'number');
			assert.equal(schema.properties.b.type, 'boolean');
			assert.equal(schema.properties.s.type, 'string');
			// Date is union-typed for LLM flexibility (ISO string or epoch ms).
			assert.deepEqual(schema.properties.d.type, ['string', 'number']);
			assert.equal(schema.properties.big.type, 'integer');
			assert.equal(schema.properties.blob.type, 'string');
			assert.equal(schema.properties.blob.contentEncoding, 'base64');
			// `Any` becomes a schema without a `type` field (any JSON value).
			assert.equal(schema.properties.any.type, undefined);
			// Nullable adds 'null' to the type list.
			assert.deepEqual(schema.properties.nul.type, ['string', 'null']);
		});
	});
});
