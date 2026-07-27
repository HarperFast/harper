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

	it('expresses a declared type union on each surface in that surface’s own dialect', () => {
		const resources = makeResources();

		_setResourcesForTest(resources);
		registerApplicationTools();
		const create = getTool('create_Widget');
		// MCP speaks JSON Schema, which has type unions — pass the author's declaration through.
		assert.deepEqual(create.inputSchema.properties.mixed.type, ['string', 'number']);

		// OpenAPI 3.0 has no type arrays; the equivalent is `oneOf`. Same declaration, two encodings —
		// what must NOT happen is either surface narrowing it to `string`.
		const schema = generateJsonApi(resources, 'https://harper.fast').components.schemas.Widget;
		assert.deepEqual(schema.properties.mixed.oneOf, [{ type: 'string' }, { type: 'number' }]);
		assert.equal(schema.properties.mixed.type, undefined);
	});
});
