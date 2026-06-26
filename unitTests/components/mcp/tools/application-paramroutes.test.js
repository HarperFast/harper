// RFC 0001: parameterised custom resources must surface as MCP tools.
//
// Regression test for the verified gap: a custom resource declaring a
// parameterised path (e.g. `static path = '/widget/:id'`) is stored by
// Resources.setParamRoute in the `paramRoutes` side-array and never inserted
// into the base Map. MCP's buildApplicationTools previously iterated only the
// Map, so such resources produced ZERO tools — while OpenAPI (which iterates
// paramRoutes) did expose them. buildApplicationTools now enumerates paramRoutes
// too, so the tool surface matches the REST surface.

const assert = require('node:assert/strict');
const {
	registerApplicationTools,
	_setResourcesForTest,
	_setRequestTargetForTest,
	_resetApplicationToolsRegisteredForTest,
} = require('#src/components/mcp/tools/application');
const { listTools, _resetRegistryForTest } = require('#src/components/mcp/toolRegistry');
const { _resetPromptRegistryForTest } = require('#src/components/mcp/promptRegistry');

const SUPER = { username: 'admin', role: { permission: { super_user: true } } };

class FakeRequestTarget {}

// A custom (non-table) Resource registered at a parameterised path.
function makeParamResource() {
	class Widget {}
	Widget.prototype.get = function () {}; // read verb present
	Widget.prototype.post = function () {}; // create verb present
	Widget.get = async (target) => ({ id: target.id, name: 'sample' });
	Widget.post = async (_target, data) => ({ created: true, ...data });
	return Widget;
}

// A registry (Map) with a `paramRoutes` side-array, mirroring resources/Resources.ts.
function makeRegistryWithParamRoute(pattern, Resource, exportTypes) {
	const m = new Map(); // intentionally no static Map entries
	m.paramRoutes = [{ pattern, entry: { path: pattern, Resource, exportTypes, hasSubPaths: false, relativeURL: '' } }];
	return m;
}

function listSuperToolNames() {
	const { tools } = listTools({ user: SUPER, profile: 'application', sessionId: 's', limit: 200 });
	return tools.map((t) => t.name);
}

describe('mcp/tools/application — parameterised routes (RFC 0001)', () => {
	beforeEach(() => {
		_resetRegistryForTest();
		_resetPromptRegistryForTest();
		_setRequestTargetForTest(FakeRequestTarget);
	});

	afterEach(() => {
		_resetRegistryForTest();
		_resetPromptRegistryForTest();
		_setResourcesForTest(undefined);
		_setRequestTargetForTest(undefined);
		_resetApplicationToolsRegisteredForTest();
	});

	it('registers tools for a custom resource on a parameterised path (/widget/:id)', () => {
		_setResourcesForTest(makeRegistryWithParamRoute('widget/:id', makeParamResource()));
		registerApplicationTools();
		const names = listSuperToolNames();
		assert.ok(names.length > 0, `expected tools for the parameterised resource, got none`);
		assert.ok(
			names.some((n) => n.startsWith('get_')),
			`expected a get_* tool, got ${JSON.stringify(names)}`
		);
		assert.ok(
			names.some((n) => n.startsWith('create_')),
			`expected a create_* tool, got ${JSON.stringify(names)}`
		);
	});

	it('respects mcp:false on a parameterised route', () => {
		_setResourcesForTest(makeRegistryWithParamRoute('secret/:id', makeParamResource(), { mcp: false }));
		registerApplicationTools();
		assert.equal(listSuperToolNames().length, 0, 'mcp:false should suppress the param-route resource');
	});

	it('registers nothing when there are no resources at all', () => {
		const empty = new Map();
		empty.paramRoutes = [];
		_setResourcesForTest(empty);
		registerApplicationTools();
		assert.equal(listSuperToolNames().length, 0);
	});
});
