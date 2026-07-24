// #1920 — a single class-level metadata source (docstring + `static properties`) must surface on
// BOTH the MCP tool descriptors and the OpenAPI document. This is the cross-surface convergence the
// #1095 acceptance called for; previously each surface was tested in isolation.
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

		// MCP side
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

		// OpenAPI side — same source
		const api = generateJsonApi(resources, 'https://harper.fast');
		const schema = api.components.schemas.Widget;
		assert.equal(schema.description, 'A widget in the catalog.', 'OpenAPI schema should carry the docstring');
		assert.equal(schema.properties.label.description, 'Human-readable label');

		// Convergence: the per-property description is identical on both surfaces.
		assert.equal(create.inputSchema.properties.label.description, schema.properties.label.description);
	});
});

// #1941 / #1942 — the two surfaces used to diverge below the top level: OpenAPI dropped hints inside
// nested objects, neither suppressed a hidden sub-property, and nullability was expressed three
// different ways. These assert the same fragment on both surfaces, side by side.
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
			assert.equal(props.order.properties.kind.const, 'order', `${surface}: nested const`);
			assert.deepEqual(props.tags.items.enum, ['a', 'b'], `${surface}: array item enum`);
			assert.equal(props.tags.items.description, 'Tag value.', `${surface}: array item description`);
		}
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
		// OpenAPI 3.0.3 has no union types: the `nullable` keyword, at BOTH levels (it was previously
		// emitted only on nested properties and silently dropped at the top level).
		assert.equal(openapi.note.type, 'string', 'openapi top-level stays a single type');
		assert.equal(openapi.note.nullable, true, 'openapi top-level nullable is emitted');
		assert.equal(openapi.wrapper.properties.inner.nullable, true, 'openapi nested nullable is emitted');
	});

	it('emits an unrecognized type name as untyped on both surfaces instead of diverging', () => {
		// MCP used to coerce an unknown name to `string` while OpenAPI emitted `{}` — two different
		// wrong answers from one typo, with no signal to the author.
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
});
