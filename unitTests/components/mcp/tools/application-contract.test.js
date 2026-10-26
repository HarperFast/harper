// a custom resource carrying a request contract (via `Resource.withSchema`)
// drives its MCP tool INPUT schema off the contract — path params + declared query/body — instead of
// the empty/generic derivation a parameterised custom resource got before. Complements
// application-paramroutes.test.js (which proved such resources produce tools at all).

const assert = require('assert');
const {
	registerApplicationTools,
	_setResourcesForTest,
	_setRequestTargetForTest,
	_resetApplicationToolsRegisteredForTest,
} = require('#src/components/mcp/tools/application');
const { listTools, getTool, _resetRegistryForTest } = require('#src/components/mcp/toolRegistry');
const { _resetPromptRegistryForTest } = require('#src/components/mcp/promptRegistry');

const SUPER = { username: 'admin', role: { permission: { super_user: true } } };

class FakeRequestTarget {}

// A custom Resource carrying the static slots `Resource.withSchema` populates for `/widget/:id`.
function makeContractResource() {
	class Widget {}
	Widget.prototype.get = function () {};
	Widget.prototype.post = function () {};
	Widget.get = async () => ({});
	Widget.post = async () => ({});
	Widget.path = '/widget/:id';
	Widget.requestContract = { path: '/widget/:id' };
	Widget.inputSchemas = {
		get: {
			query: {
				type: 'object',
				properties: { expand: { type: 'array', items: { type: 'string', enum: ['parts', 'owner'] } } },
			},
		},
		post: {
			body: {
				type: 'object',
				properties: { name: { type: 'string' }, parts: { type: 'array', items: { type: 'string' } } },
				required: ['name'],
			},
		},
	};
	Widget.outputSchemas = { get: { type: 'object', properties: { id: { type: 'string' }, name: { type: 'string' } } } };
	return Widget;
}

function makeRegistryWithParamRoute(pattern, Resource) {
	const m = new Map();
	m.paramRoutes = [{ pattern, entry: { path: pattern, Resource, hasSubPaths: false, relativeURL: '' } }];
	return m;
}

function toolsByName() {
	const { tools } = listTools({ user: SUPER, profile: 'application', sessionId: 's', limit: 200 });
	return new Map(tools.map((t) => [t.name, t]));
}

describe('mcp/tools/application — request-contract input schemas', () => {
	beforeEach(() => {
		_resetRegistryForTest();
		_resetPromptRegistryForTest();
		_setRequestTargetForTest(FakeRequestTarget);
		_setResourcesForTest(makeRegistryWithParamRoute('widget/:id', makeContractResource()));
		registerApplicationTools();
	});

	afterEach(() => {
		_resetRegistryForTest();
		_resetPromptRegistryForTest();
		_setResourcesForTest(undefined);
		_setRequestTargetForTest(undefined);
		_resetApplicationToolsRegisteredForTest();
	});

	it('drives the get_* input schema off the contract: path param + declared query', () => {
		const tool = [...toolsByName().values()].find((t) => t.name.startsWith('get_'));
		assert.ok(tool, 'expected a get_* tool');
		const props = tool.inputSchema.properties;
		assert.ok(props.id, 'path param :id advertised');
		assert.deepStrictEqual(tool.inputSchema.required, ['id'], 'path param required');
		assert.ok(props.expand, 'declared query param advertised');
		assert.strictEqual(props.expand.type, 'array', 'query param carries its declared JSON-Schema type');
		assert.deepStrictEqual(props.expand.items.enum, ['parts', 'owner'], 'enum carried through');
	});

	it('drives the create_* input schema off the contract body (path param + body fields)', () => {
		const tool = [...toolsByName().values()].find((t) => t.name.startsWith('create_'));
		assert.ok(tool, 'expected a create_* tool');
		const props = tool.inputSchema.properties;
		assert.ok(props.id, 'path param advertised on create');
		assert.ok(props.name, 'body field advertised');
		assert.ok(props.parts, 'body array field advertised');
		assert.ok(tool.inputSchema.required.includes('name'), 'required body field carried through');
	});

	it('drives the get_* output schema off the contract record', () => {
		const tool = [...toolsByName().values()].find((t) => t.name.startsWith('get_'));
		assert.ok(tool.outputSchema, 'output schema present');
		assert.ok(tool.outputSchema.properties.name, 'record output advertised');
	});
});

// Blocker regression: MCP flattens path params + body fields into one args object. The create/update
// handlers must strip path params (bound onto the target) out of the body, or the contract's
// additionalProperties:false body schema would reject the bound `id` as an unknown property.
describe('mcp/tools/application — contract body strips bound path params', () => {
	let captured;
	function makeCapturingResource() {
		class Widget {}
		Widget.prototype.post = function () {};
		Widget.post = async (target, body) => {
			captured = { id: target.id, body };
			return { id: 'w1' };
		};
		Widget.path = '/widget/:id';
		Widget.requestContract = { path: '/widget/:id' };
		Widget.inputSchemas = {
			post: { body: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] } },
		};
		return Widget;
	}

	beforeEach(() => {
		captured = undefined;
		_resetRegistryForTest();
		_resetPromptRegistryForTest();
		_setRequestTargetForTest(FakeRequestTarget);
		_setResourcesForTest(makeRegistryWithParamRoute('widget/:id', makeCapturingResource()));
		registerApplicationTools();
	});
	afterEach(() => {
		_resetRegistryForTest();
		_resetPromptRegistryForTest();
		_setResourcesForTest(undefined);
		_setRequestTargetForTest(undefined);
		_resetApplicationToolsRegisteredForTest();
	});

	it('binds :id onto the target and excludes it from the forwarded body', async () => {
		const tool = [...toolsByName().values()].find((t) => t.name.startsWith('create_'));
		assert.ok(tool, 'create tool registered');
		await getTool(tool.name).handler({ id: 'w1', name: 'A' }, { user: SUPER });
		assert.strictEqual(captured.id, 'w1', 'path param bound onto target');
		assert.deepStrictEqual(captured.body, { name: 'A' }, 'body excludes the bound path param');
	});
});

describe('mcp/tools/application — contract nullability in JSON Schema 2020-12 terms', () => {
	const nodePath = require('node:path');
	const { projectTableFragment } = require('#src/resources/defineResource');
	const sdkDir = nodePath.dirname(require.resolve('@modelcontextprotocol/sdk/package.json'));
	const Ajv2020 = require(require.resolve('ajv/dist/2020', { paths: [sdkDir] })).default;

	const table = {
		attributes: [
			{ name: 'id', type: 'String', isPrimaryKey: true },
			{
				name: 'meta',
				type: 'Meta',
				properties: [
					{ name: 'label', type: 'String', nullable: false },
					{ name: 'count', type: 'Int' },
				],
			},
			{ name: 'tags', type: 'array', elements: { type: 'String' } },
		],
	};

	// Ajv honors `nullable` as an OpenAPI extension; drop it so the check behaves like a strict
	// 2020-12 validator (e.g. Python `jsonschema`) that ignores the unknown keyword.
	function strict2020(schema) {
		const stripped = JSON.parse(JSON.stringify(schema, (key, value) => (key === 'nullable' ? undefined : value)));
		return new Ajv2020({ strict: false, validateFormats: false }).compile(stripped);
	}

	function hasNullableKey(schema) {
		return JSON.stringify(schema).includes('"nullable"');
	}

	function makeTableContractResource() {
		class Song {}
		Song.prototype.get = function () {};
		Song.prototype.post = function () {};
		Song.post = async () => ({});
		Song.path = '/song/:id';
		Song.requestContract = { path: '/song/:id' };
		Song.get = async (target) => {
			boundQuery = target.bound;
			return {};
		};
		Song.inputSchemas = {
			get: { query: { type: 'object', properties: { limit: { type: 'integer', nullable: true } } } },
			post: { body: projectTableFragment(table, 'insert') },
		};
		Song.outputSchemas = { get: { ...projectTableFragment(table, 'record'), nullable: true } };
		return Song;
	}

	let boundQuery;
	class QueryTarget {
		bound = {};
		set(name, value) {
			this.bound[name] = value;
		}
	}

	beforeEach(() => {
		boundQuery = undefined;
		_resetRegistryForTest();
		_resetPromptRegistryForTest();
		_setRequestTargetForTest(QueryTarget);
		_setResourcesForTest(makeRegistryWithParamRoute('song/:id', makeTableContractResource()));
		registerApplicationTools();
	});
	afterEach(() => {
		_resetRegistryForTest();
		_resetPromptRegistryForTest();
		_setResourcesForTest(undefined);
		_setRequestTargetForTest(undefined);
		_resetApplicationToolsRegisteredForTest();
	});

	it('accepts null for a nullable nested Int and a nullable array element, and rejects it where nullable is false', () => {
		const tool = [...toolsByName().values()].find((t) => t.name.startsWith('create_'));
		assert.ok(!hasNullableKey(tool.inputSchema), JSON.stringify(tool.inputSchema));
		const validate = strict2020(tool.inputSchema);
		assert.ok(validate({ id: '1', meta: { label: 'a', count: null }, tags: [null] }), JSON.stringify(validate.errors));
		assert.ok(!validate({ id: '1', meta: { label: null } }), 'nullable:false nested field must reject null');
	});

	it('converts nested nullability in the output schema but keeps its root an object', () => {
		const tool = [...toolsByName().values()].find((t) => t.name.startsWith('get_'));
		assert.ok(!hasNullableKey(tool.outputSchema), JSON.stringify(tool.outputSchema));
		assert.strictEqual(tool.outputSchema.type, 'object');
		assert.ok(strict2020(tool.outputSchema)({ id: '1', meta: { label: 'a', count: null }, tags: [null] }));
	});

	it('advertises a nullable query param with a null type and binds a null argument as omitted', async () => {
		const tool = [...toolsByName().values()].find((t) => t.name.startsWith('get_'));
		assert.deepStrictEqual(tool.inputSchema.properties.limit.type, ['integer', 'null']);
		await getTool(tool.name).handler({ id: '1', limit: null }, { user: SUPER });
		assert.deepStrictEqual(boundQuery, {});
		await getTool(tool.name).handler({ id: '1', limit: 5 }, { user: SUPER });
		assert.deepStrictEqual(boundQuery, { limit: '5' });
	});
});
