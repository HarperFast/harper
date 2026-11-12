// Class-level metadata must agree across MCP tool descriptors and OpenAPI.
const assert = require('node:assert');
const {
	registerApplicationTools,
	_setResourcesForTest,
	_setRequestTargetForTest,
	_resetApplicationToolsRegisteredForTest,
} = require('#src/components/mcp/tools/application');
const { getTool, _resetRegistryForTest } = require('#src/components/mcp/toolRegistry');
const { generateJsonApi } = require('#src/resources/openApi');
const { _resetUnknownTypeWarningsForTest } = require('#src/resources/jsonSchemaTypes');

class FakeRequestTarget {}

// One programmatic Resource, shared by both surfaces.
function makeResources() {
	class Widget {}
	Widget.databaseName = 'data';
	Widget.tableName = 'widget';
	Widget.primaryKey = 'id';
	Widget.description = 'A widget in the catalog.';
	Widget.properties = {
		id: { type: 'string', primaryKey: true },
		label: { type: 'string', description: 'Human-readable label' },
		mixed: { type: ['string', 'number'] },
		when: { type: ['Date', 'null'] },
		value: { type: ['String', 'Int'] },
		tags: { type: ['array', 'null'], items: { type: 'string' } },
		nothing: { type: ['null'] },
		structural: { type: ['array', 'string'], items: { type: 'number' } },
		typoUnion: { type: ['Text', 'string'] },
	};
	for (const v of ['get', 'put', 'patch', 'delete', 'search', 'post']) Widget.prototype[v] = function () {};
	Widget.get = async (t) => ({ id: t.id });
	Widget.put = async () => ({ ok: true });
	Widget.patch = async () => ({ ok: true });
	Widget.post = async (_t, d) => ({ created: true, ...d });
	Widget.delete = async () => ({ deleted: true });
	Widget.search = async () => [];

	const resources = new Map();
	resources.set('Widget', { path: 'Widget', Resource: Widget, hasSubPaths: false, relativeURL: '' });
	resources.allTypes = new Map();
	return resources;
}

describe('mcp/openapi — #1920 description convergence across surfaces', () => {
	beforeEach(() => {
		_resetRegistryForTest();
		_setRequestTargetForTest(FakeRequestTarget);
	});
	afterEach(() => {
		_resetRegistryForTest();
		_setResourcesForTest(undefined);
		_setRequestTargetForTest(undefined);
		_resetApplicationToolsRegisteredForTest();
	});

	it('surfaces the docstring and per-property descriptions on both MCP tools and OpenAPI', () => {
		const resources = makeResources();

		_setResourcesForTest(resources);
		registerApplicationTools();
		const get = getTool('get_Widget');
		const create = getTool('create_Widget');
		assert.ok(get && create, 'MCP verb tools registered');
		assert.ok(
			get.description.includes('A widget in the catalog.'),
			`MCP get tool should carry the docstring, got: ${get.description}`
		);
		assert.equal(create.inputSchema.properties.label.description, 'Human-readable label');

		const api = generateJsonApi(resources, 'https://harper.fast');
		const schema = api.components.schemas.Widget;
		assert.equal(schema.description, 'A widget in the catalog.', 'OpenAPI schema should carry the docstring');
		assert.equal(schema.properties.label.description, 'Human-readable label');

		assert.equal(create.inputSchema.properties.label.description, schema.properties.label.description);
	});

	it('expresses a declared type union on each surface in that surface’s own dialect', () => {
		const resources = makeResources();

		_setResourcesForTest(resources);
		registerApplicationTools();
		const create = getTool('create_Widget');
		// MCP speaks JSON Schema, which has type unions — pass the author's declaration through.
		assert.deepEqual(create.inputSchema.properties.mixed.type, ['string', 'number']);

		// OpenAPI 3.0 has no type arrays; the equivalent is `anyOf`. Same declaration, two encodings —
		// what must NOT happen is either surface narrowing it to `string`.
		const schema = generateJsonApi(resources, 'https://harper.fast').components.schemas.Widget;
		assert.deepEqual(schema.properties.mixed.anyOf, [{ type: 'string' }, { type: 'number' }]);
		assert.equal(schema.properties.mixed.type, undefined);
	});

	it('normalizes Harper type names inside unions on both surfaces', () => {
		const resources = makeResources();
		_setResourcesForTest(resources);
		registerApplicationTools();
		const mcp = getTool('create_Widget').inputSchema.properties;
		const openapi = generateJsonApi(resources, 'https://harper.fast').components.schemas.Widget.properties;
		assert.deepEqual(mcp.when.type, ['string', 'number', 'null']);
		assert.deepEqual(mcp.value.type, ['string', 'integer']);
		assert.deepEqual(openapi.when, { type: 'string', format: 'Date', nullable: true });
		assert.deepEqual(openapi.value.anyOf, [{ type: 'string' }, { type: 'integer', format: 'Int' }]);
	});

	it('retains array items and null-only constraints through dialect projection', () => {
		const resources = makeResources();
		_setResourcesForTest(resources);
		registerApplicationTools();
		const mcp = getTool('create_Widget').inputSchema.properties;
		const openapi = generateJsonApi(resources, 'https://harper.fast').components.schemas.Widget.properties;
		assert.deepEqual(mcp.tags.type, ['array', 'null']);
		assert.deepEqual(mcp.tags.items, { type: 'string' });
		assert.deepEqual(openapi.tags, { type: 'array', items: { type: 'string' }, nullable: true });
		assert.deepEqual(mcp.nothing, { type: 'null' });
		assert.deepEqual(openapi.nothing, { nullable: true, enum: [null] });
	});

	it('preserves structural union members and drops unknown members on both surfaces', () => {
		const resources = makeResources();
		_setResourcesForTest(resources);
		registerApplicationTools();
		const mcp = getTool('create_Widget').inputSchema.properties;
		const openapi = generateJsonApi(resources, 'https://harper.fast').components.schemas.Widget.properties;
		const expectedStructural = [{ type: 'array', items: { type: 'number' } }, { type: 'string' }];
		assert.deepEqual(mcp.structural.anyOf, expectedStructural);
		assert.deepEqual(openapi.structural.anyOf, expectedStructural);
		assert.deepEqual(mcp.typoUnion, { type: 'string' });
		assert.deepEqual(openapi.typoUnion, { type: 'string' });
	});
	it('preserves undeclared root required names without exposing hidden fields', () => {
		const resources = makeResources();
		const Widget = resources.get('Widget').Resource;
		Widget.properties.secret = { type: 'string', hidden: true };
		Widget.required = ['extension', 'secret'];
		_setResourcesForTest(resources);
		registerApplicationTools();
		const create = getTool('create_Widget').inputSchema;
		const output = getTool('get_Widget').outputSchema;
		const openapi = generateJsonApi(resources, 'https://harper.fast').components.schemas.Widget;
		assert.deepEqual(create.required, ['extension']);
		assert.deepEqual(openapi.required, ['extension']);
		assert.ok(output.required.includes('extension'));
		assert.equal(output.additionalProperties, false);
		assert.deepEqual(output.properties.extension, {});
		for (const schema of [create, output, openapi]) assert.equal(schema.properties.secret, undefined);
	});

	it('refreshes both surfaces after an in-place metadata edit and tool rebuild', () => {
		const resources = makeResources();
		const Widget = resources.get('Widget').Resource;
		_setResourcesForTest(resources);
		registerApplicationTools();
		generateJsonApi(resources, 'https://harper.fast');
		Widget.properties.label.description = 'Changed in place';
		Widget.properties.added = { type: 'integer' };
		delete Widget.properties.mixed;
		_resetApplicationToolsRegisteredForTest();
		registerApplicationTools();
		for (const properties of [
			getTool('create_Widget').inputSchema.properties,
			generateJsonApi(resources, 'https://harper.fast').components.schemas.Widget.properties,
		]) {
			assert.equal(properties.label.description, 'Changed in place');
			assert.equal(properties.added.type, 'integer');
			assert.equal(properties.mixed, undefined);
		}
	});
});

// Nested hints, visibility, and nullability must agree across surfaces.
describe('mcp/openapi — schema emitter convergence (#1941, #1942)', () => {
	beforeEach(() => {
		_resetRegistryForTest();
		_setRequestTargetForTest(FakeRequestTarget);
		_resetUnknownTypeWarningsForTest();
	});
	afterEach(() => {
		_resetRegistryForTest();
		_setResourcesForTest(undefined);
		_setRequestTargetForTest(undefined);
		_resetApplicationToolsRegisteredForTest();
	});

	// Builds both surfaces from one `static properties` declaration and hands back the emitted
	// property schemas so a test can compare them directly.
	function bothSurfaces(properties) {
		class Thing {}
		Thing.databaseName = 'data';
		Thing.tableName = 'thing';
		Thing.primaryKey = 'id';
		Thing.properties = { id: { type: 'string', primaryKey: true }, ...properties };
		for (const v of ['get', 'put', 'patch', 'delete', 'search', 'post']) Thing.prototype[v] = function () {};
		Thing.get = async (t) => ({ id: t.id });
		Thing.put = async () => ({ ok: true });
		Thing.patch = async () => ({ ok: true });
		Thing.post = async (_t, d) => ({ created: true, ...d });
		Thing.delete = async () => ({ deleted: true });
		Thing.search = async () => [];

		const resources = new Map();
		resources.set('Thing', { path: 'Thing', Resource: Thing, hasSubPaths: false, relativeURL: '' });
		resources.allTypes = new Map();

		_setResourcesForTest(resources);
		registerApplicationTools();
		const mcp = getTool('create_Thing').inputSchema.properties;
		const openapi = generateJsonApi(resources, 'https://harper.fast').components.schemas.Thing.properties;
		return { mcp, openapi };
	}

	for (const [label, declaration, mcpType, openapiType] of [
		['JSON scalar', { type: 'string' }, 'string', 'string'],
		['JSON array', { type: 'array', items: { type: 'string' } }, 'array', 'array'],
		['nullable scalar', { type: ['string', 'null'] }, ['string', 'null'], 'string'],
		['nullable array', { type: ['array', 'null'], items: { type: 'string' } }, ['array', 'null'], 'array'],
		['Harper scalar', { type: 'String' }, 'string', 'string'],
		['Harper date', { type: 'Date' }, ['string', 'number'], 'string'],
		['Harper blob', { type: 'Blob' }, 'string', 'string'],
		['Harper any', { type: 'Any' }, undefined, undefined],
	]) {
		it(`preserves an explicit ${label} alongside conditional properties`, () => {
			const { mcp, openapi } = bothSurfaces({
				value: { ...declaration, properties: { label: { type: 'integer' } } },
			});
			assert.deepStrictEqual(mcp.value.type, mcpType);
			assert.deepStrictEqual(openapi.value.type, openapiType);
			for (const schema of [mcp.value, openapi.value]) {
				assert.deepStrictEqual(schema.properties.label, { type: 'integer' });
				if (declaration.items) assert.deepStrictEqual(schema.items, { type: 'string' });
			}
		});
	}

	it('preserves nested explicit types and primary-key addressing schemas', () => {
		const { mcp, openapi } = bothSurfaces({
			id: { type: 'string', primaryKey: true, properties: { label: { type: 'integer' } } },
			profile: {
				type: 'object',
				properties: {
					text: { type: 'string', properties: { label: { type: 'integer' } } },
					tags: { type: 'array', properties: {}, items: { type: 'string' } },
				},
			},
		});
		for (const properties of [mcp, openapi, getTool('get_Thing').outputSchema.properties]) {
			assert.strictEqual(properties.id.type, 'string');
			assert.strictEqual(properties.profile.properties.text.type, 'string');
			assert.strictEqual(properties.profile.properties.tags.type, 'array');
			assert.deepStrictEqual(properties.profile.properties.tags.items, { type: 'string' });
		}
		for (const verb of ['get', 'delete', 'update']) {
			assert.strictEqual(getTool(`${verb}_Thing`).inputSchema.properties.id.type, 'string');
		}
	});

	it('keeps inference for omitted types and does not invent a type from items', () => {
		const { mcp, openapi } = bothSurfaces({
			profile: { properties: { label: { type: 'string' } } },
			untyped: { items: { type: 'string' } },
		});
		for (const properties of [mcp, openapi]) {
			assert.strictEqual(properties.profile.type, 'object');
			assert.deepStrictEqual(properties.untyped, {});
		}
	});

	for (const field of ['attributes', 'properties']) {
		it(`keeps named legacy objects in ${field} arrays`, () => {
			const resources = makeResources();
			resources.get('Widget').Resource[field] = [
				{ name: 'profile', type: 'LegacyProfile', properties: [{ name: 'label', type: 'String' }] },
			];
			_setResourcesForTest(resources);
			registerApplicationTools();
			assert.strictEqual(getTool('create_Widget').inputSchema.properties.profile.type, 'object');
			assert.strictEqual(
				generateJsonApi(resources, 'https://harper.fast').components.schemas.Widget.properties.profile.type,
				'object'
			);
		});
	}

	it('keeps named definitions whose names overlap JSON types', () => {
		const resources = makeResources();
		const definition = { type: 'number', attributes: [{ name: 'label', type: 'String' }] };
		resources.get('Widget').Resource.attributes = [
			{ name: 'profile', type: 'number', properties: definition.attributes, definition },
		];
		_setResourcesForTest(resources);
		registerApplicationTools();
		assert.strictEqual(getTool('create_Widget').inputSchema.properties.profile.type, 'object');
		assert.deepStrictEqual(
			generateJsonApi(resources, 'https://harper.fast').components.schemas.Widget.properties.profile,
			{
				$ref: '#/components/schemas/number',
			}
		);
	});

	it('suppresses a hidden sub-property on both surfaces and never emits `hidden` as a schema key', () => {
		const { mcp, openapi } = bothSurfaces({
			profile: {
				type: 'object',
				properties: {
					name: { type: 'string' },
					creditScore: { type: 'integer', hidden: true, description: 'internal only' },
				},
			},
		});
		for (const [surface, props] of [
			['mcp', mcp],
			['openapi', openapi],
		]) {
			assert.ok(props.profile.properties.name, `${surface}: visible sub-property kept`);
			assert.equal(
				props.profile.properties.creditScore,
				undefined,
				`${surface}: hidden sub-property must be suppressed`
			);
			assert.equal(
				JSON.stringify(props.profile).includes('"hidden"'),
				false,
				`${surface}: the hidden directive must not leak into the emitted schema`
			);
			assert.equal(
				JSON.stringify(props.profile).includes('internal only'),
				false,
				`${surface}: a hidden sub-property's description must not leak`
			);
		}
	});

	it('preserves JSON enum members and intersects structurally equal const values', () => {
		const { mcp, openapi } = bothSurfaces({
			value: { enum: [{ a: 1, b: [true, null] }, ['x']], const: { b: [true, null], a: 1 } },
		});
		assert.deepEqual(mcp.value.enum, [{ a: 1, b: [true, null] }, ['x']]);
		assert.deepEqual(mcp.value.const, { b: [true, null], a: 1 });
		assert.deepEqual(openapi.value.enum, [{ a: 1, b: [true, null] }]);
	});

	it('drops a suppressed sub-property from the nested `required` list', () => {
		// Advertising a required property the schema doesn't define makes the object unsatisfiable.
		const { mcp, openapi } = bothSurfaces({
			profile: {
				type: 'object',
				properties: { name: { type: 'string' }, secret: { type: 'string', hidden: true } },
				required: ['name', 'secret'],
			},
		});
		assert.deepEqual(mcp.profile.required, ['name']);
		assert.deepEqual(openapi.profile.required, ['name']);
	});

	it('preserves required undeclared properties while dropping explicitly hidden ones', () => {
		const { mcp, openapi } = bothSurfaces({
			profile: {
				type: 'object',
				properties: { secret: { type: 'string', hidden: true } },
				required: ['extensionField', 'secret'],
			},
		});
		assert.deepEqual(mcp.profile.required, ['extensionField']);
		assert.deepEqual(openapi.profile.required, ['extensionField']);
	});

	it('carries enum/format/const/description into nested objects and array items on both surfaces', () => {
		const { mcp, openapi } = bothSurfaces({
			order: {
				type: 'object',
				properties: {
					status: { type: 'string', enum: ['open', 'closed'], description: 'Fulfillment state.' },
					placedAt: { type: 'string', format: 'date-time' },
					kind: { type: 'string', const: 'order' },
				},
			},
			tags: { type: 'array', items: { type: 'string', enum: ['a', 'b'], description: 'Tag value.' } },
		});
		for (const [surface, props] of [
			['mcp', mcp],
			['openapi', openapi],
		]) {
			assert.deepEqual(props.order.properties.status.enum, ['open', 'closed'], `${surface}: nested enum`);
			assert.equal(props.order.properties.status.description, 'Fulfillment state.', `${surface}: nested description`);
			assert.equal(props.order.properties.placedAt.format, 'date-time', `${surface}: nested format`);
			assert.deepEqual(props.tags.items.enum, ['a', 'b'], `${surface}: array item enum`);
			assert.equal(props.tags.items.description, 'Tag value.', `${surface}: array item description`);
		}
		// `const` is the one hint whose *form* differs: it is draft-06, so the 3.0.3 document emits the
		// equivalent single-value `enum` while MCP takes `const` directly. The constraint reaches both.
		assert.equal(mcp.order.properties.kind.const, 'order', 'mcp keeps const');
		assert.equal(mcp.order.properties.kind.enum, undefined, 'mcp does not also emit enum');
		assert.deepEqual(openapi.order.properties.kind.enum, ['order'], 'openapi translates const to enum');
		assert.equal(openapi.order.properties.kind.const, undefined, 'openapi emits no const keyword');
	});

	it('expresses nullability per dialect, consistently at top level and nested', () => {
		const { mcp, openapi } = bothSurfaces({
			note: { type: ['string', 'null'] },
			wrapper: { type: 'object', properties: { inner: { type: 'string', nullable: true } } },
		});
		// MCP speaks JSON Schema: a union including 'null'.
		assert.deepEqual(mcp.note.type, ['string', 'null'], 'mcp top-level union');
		assert.deepEqual(mcp.wrapper.properties.inner.type, ['string', 'null'], 'mcp nested union');
		assert.equal(mcp.note.nullable, undefined, 'mcp must not emit the OpenAPI keyword');
		assert.equal(openapi.note.type, 'string', 'openapi top-level stays a single type');
		assert.equal(openapi.note.nullable, true, 'openapi top-level nullable is emitted');
		assert.equal(openapi.wrapper.properties.inner.nullable, true, 'openapi nested nullable is emitted');
	});

	it('preserves enum intersection semantics for a nullable multi-type union', () => {
		const { mcp, openapi } = bothSurfaces({ choice: { type: ['string', 'integer', 'null'], enum: ['a', 1] } });
		assert.ok(mcp.choice.type.includes('null'));
		assert.deepEqual(mcp.choice.enum, ['a', 1]);
		assert.ok(openapi.choice.anyOf.some((arm) => arm.enum?.includes(null)));
		assert.deepEqual(openapi.choice.enum, ['a', 1]);
	});

	it('emits unconstrained arrays in the form required by each dialect', () => {
		const { mcp, openapi } = bothSurfaces({
			plain: { type: 'array' },
			union: { type: ['array', 'string'] },
		});
		assert.deepEqual(mcp.plain, { type: 'array' });
		assert.deepEqual(openapi.plain, { type: 'array', items: {} });
		assert.deepEqual(mcp.union.type, ['array', 'string']);
		assert.deepEqual(
			openapi.union.anyOf.find((arm) => arm.type === 'array'),
			{ type: 'array', items: {} }
		);
	});

	for (const [label, type] of [
		['scalar', 'string'],
		['multi-type union', ['string', 'number', 'null']],
	]) {
		it(`keeps const stricter than nullability for a ${label}`, () => {
			const { mcp, openapi } = bothSurfaces({ fixed: { type, const: 'x', nullable: true } });
			assert.equal(mcp.fixed.const, 'x');
			assert.equal(mcp.fixed.enum, undefined);
			assert.deepEqual(openapi.fixed.enum, ['x']);
			assert.equal(openapi.fixed.enum.includes(null), false);
		});
	}

	it('preserves a property named `__proto__` on both surfaces', () => {
		const properties = Object.create(null);
		properties.__proto__ = { type: 'string' };
		const { mcp, openapi } = bothSurfaces(properties);
		assert.ok(Object.hasOwn(mcp, '__proto__'));
		assert.ok(Object.hasOwn(openapi, '__proto__'));
		assert.equal(mcp.__proto__.type, 'string');
		assert.equal(openapi.__proto__.type, 'string');
	});

	it('emits an unrecognized type name as untyped on both surfaces instead of diverging', () => {
		const { mcp, openapi } = bothSurfaces({ weird: { type: 'Text' } });
		assert.equal(mcp.weird.type, undefined, 'mcp does not invent a type');
		assert.equal(openapi.weird.type, undefined, 'openapi does not invent a type');
	});

	it('leaves recognized GraphQL and JSON Schema type names mapping correctly', () => {
		const { mcp, openapi } = bothSurfaces({ a: { type: 'String' }, b: { type: 'integer' } });
		assert.equal(mcp.a.type, 'string');
		assert.equal(mcp.b.type, 'integer');
		assert.equal(openapi.a.type, 'string');
		assert.equal(openapi.b.type, 'integer');
	});

	it('preserves constraints on an `Any` property across both surfaces', () => {
		const { mcp, openapi } = bothSurfaces({ payload: { type: 'Any', enum: ['a', 'b'], const: 'a' } });
		assert.deepEqual(mcp.payload.enum, ['a', 'b']);
		assert.equal(mcp.payload.const, 'a');
		assert.deepEqual(openapi.payload.enum, ['a']);
		assert.equal(openapi.payload.format, 'Any');
	});
});

// Emitter-level behaviors that are cheaper to assert directly than through both surfaces.
describe('attributeToSchema — emitter edge cases (#1941, #1942)', () => {
	const {
		attributeToSchema,
		resolveDeclaredType,
		_resetUnknownTypeWarningsForTest: resetWarnings,
	} = require('#src/resources/jsonSchemaTypes');
	const emit = (attr, dialect = 'openapi-3.0.3') =>
		attributeToSchema(attr, { dialect, mapPrimitive: (type) => (type ? { type } : {}) });

	beforeEach(() => resetWarnings());

	it('omits `required` entirely when every required sub-property is suppressed', () => {
		// JSON Schema draft-04 (which OpenAPI 3.0.3 inherits) requires at least one element, so
		// `required: []` fails validators — and this list was synthesized from a non-empty one.
		const out = emit({
			name: 'profile',
			properties: [{ name: 'secret', type: 'string', hidden: true }],
			required: ['secret'],
		});
		assert.equal('required' in out, false, `required must be omitted, got ${JSON.stringify(out)}`);
	});

	it('does not resolve Object.prototype members as type names', () => {
		for (const bogus of ['constructor', '__proto__', 'toString']) {
			assert.equal(resolveDeclaredType(bogus), undefined, `${bogus} must not resolve`);
		}
	});

	it('drops nullability when the type never resolved', () => {
		// A bare `nullable: true` with no `type` is meaningless in OpenAPI 3.0.3 — it modifies `type`.
		const out = attributeToSchema(
			{ name: 'x', type: 'Nonsense', nullable: true },
			{ dialect: 'openapi-3.0.3', mapPrimitive: () => ({}) }
		);
		assert.equal(out.nullable, undefined, `got ${JSON.stringify(out)}`);
	});

	it('warns once per unrecognized type name, and names the property', () => {
		const loggerModule = require('#src/utility/logging/harper_logger');
		const logger = loggerModule.default || loggerModule;
		const warnings = [];
		const original = logger.warn;
		logger.warn = (m) => warnings.push(String(m));
		try {
			resolveDeclaredType('Nonsense', 'OpenAPI property "widget"');
			resolveDeclaredType('Nonsense', 'OpenAPI property "widget"');
		} finally {
			logger.warn = original;
		}
		assert.equal(warnings.length, 1, 'warn-once per name');
		assert.ok(warnings[0].includes('"Nonsense"'), warnings[0]);
		assert.ok(warnings[0].includes('widget'), `warning should name the property: ${warnings[0]}`);
		assert.ok(warnings[0].includes('Blob'), `Harper type list should be complete: ${warnings[0]}`);
	});

	it('keeps a hidden sub-property suppressed even under ignoreHidden', () => {
		// ignoreHidden exists for the primary-key addressing argument; it must not cascade into fields.
		const out = attributeToSchema(
			{
				name: 'pk',
				hidden: true,
				properties: [
					{ name: 'visible', type: 'string' },
					{ name: 'secret', type: 'string', hidden: true },
				],
			},
			{ dialect: 'json-schema', mapPrimitive: (type) => ({ type }), ignoreHidden: true }
		);
		assert.ok(out, 'the hidden attribute itself is emitted');
		assert.ok(out.properties.visible);
		assert.equal(out.properties.secret, undefined, 'hidden sub-property stays suppressed');
	});

	it('rejects a cyclic attribute graph with an actionable error', () => {
		const cyclic = { name: 'self', type: 'object', properties: [] };
		cyclic.properties.push(cyclic);
		assert.throws(() => emit(cyclic), /Schema attribute "self" contains a cycle/);
	});

	it('stops at production-style non-enumerable relationship edges', () => {
		const owner = { name: 'owner', type: 'Person', relationship: true };
		const dogs = { name: 'dogs', type: 'array', relationship: true, elements: { name: '', type: 'Dog' } };
		const dog = { name: 'Dog', properties: [owner] };
		const person = { name: 'Person', properties: [dogs] };
		Object.defineProperty(owner, 'properties', { value: person.properties });
		Object.defineProperty(dogs.elements, 'properties', { value: dog.properties });
		assert.deepEqual(emit(owner, 'json-schema'), { description: 'Reference to Person.' });
		assert.deepEqual(emit(dogs, 'json-schema'), { type: 'array', items: {}, description: 'Reference to Dog.' });
	});

	it('prunes hidden children from a cloned required list', () => {
		const { filterAttributeTree } = require('#src/resources/jsonSchemaTypes');
		const [profile] = filterAttributeTree([
			{
				name: 'profile',
				properties: [
					{ name: 'name', type: 'string' },
					{ name: 'secret', type: 'string', hidden: true },
				],
				required: ['name', 'secret'],
			},
		]);
		assert.deepEqual(profile.required, ['name']);
		assert.equal(
			profile.properties.some((property) => property.name === 'secret'),
			false
		);
	});
});
