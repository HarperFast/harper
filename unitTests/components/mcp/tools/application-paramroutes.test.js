// Regression test for param-route enumeration: a custom resource declaring a
// parameterised path (e.g. `static path = '/widget/:id'`) is stored by
// Resources.setParamRoute in the `paramRoutes` side-array and never inserted
// into the base Map. MCP's buildApplicationTools previously iterated only the
// Map, so such resources produced ZERO tools — while OpenAPI (which iterates
// paramRoutes) did expose them. buildApplicationTools now enumerates paramRoutes
// too, so the tool surface matches the REST surface.

const assert = require('node:assert');
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

describe('mcp/tools/application — parameterised routes', () => {
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
	});

	it('keeps custom mcpTools on multi-segment/wildcard routes while suppressing generated verbs', () => {
		// Generated verb handlers cannot bind multi-segment/wildcard params yet, but
		// author-defined mcpTools carry their own schemas and handler methods — a
		// `files/*rest` resource with explicit tools must not become invisible.
		class Files {}
		Files.prototype.get = function () {};
		Files.get = async () => ({});
		Files.prototype.listVersions = function () {};
		Files.mcpTools = [
			{
				name: 'list_file_versions',
				method: 'listVersions',
				description: 'List versions of a file',
				inputSchema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
			},
		];
		_setResourcesForTest(makeRegistryWithParamRoute('files/*rest', Files));
		registerApplicationTools();
		const names = listSuperToolNames();
		assert.ok(names.includes('list_file_versions'), `expected the custom tool, got ${JSON.stringify(names)}`);
		assert.ok(
			!names.some((n) => n.startsWith('get_')),
			`expected no generated verb tools on a wildcard route, got ${JSON.stringify(names)}`
		);
	});

	it('does not register create_*/search_* for a param route (their handlers cannot bind the record id)', () => {
		// makeCreateHandler forces `target.isCollection = true` and never sets `target.id`;
		// makeSearchHandler is collection-scoped. Neither matches "the record named by :id",
		// so a param-route resource with `post`/`search` should still get its `get_*` tool but
		// not `create_*`/`search_*`.
		_setResourcesForTest(makeRegistryWithParamRoute('widget/:id', makeParamResource()));
		registerApplicationTools();
		const names = listSuperToolNames();
		assert.ok(
			names.some((n) => n.startsWith('get_')),
			`expected a get_* tool, got ${JSON.stringify(names)}`
		);
		assert.ok(
			!names.some((n) => n.startsWith('create_') || n.startsWith('search_')),
			`expected no create_*/search_* tool for a param route, got ${JSON.stringify(names)}`
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

	it('dispatches on the live paramRoutes entry, not the class captured at registration', async () => {
		// Regression guard: buildApplicationTools binds verb handlers to `liveResource(path, ...)`,
		// which re-reads the registry at call time. For a param route, that lookup must consult
		// `paramRoutes` (not just the base Map) or it silently falls back to the stale captured
		// class — the same live-dispatch guarantee static routes rely on for per-record RBAC.
		const registry = makeRegistryWithParamRoute('widget/:id', makeParamResource());
		_setResourcesForTest(registry);
		registerApplicationTools();

		class Replacement {}
		Replacement.get = async (target) => ({ id: target.id, name: 'from-replacement' });
		registry.paramRoutes[0].entry.Resource = Replacement;

		const result = await getTool('get_widget_id').handler({ id: '1' }, { user: SUPER });
		assert.equal(
			result.structuredContent?.name,
			'from-replacement',
			'expected the tool to dispatch on the live registry entry after it was swapped'
		);
	});

	// The verb handlers only bind `target.id = args.id`, treating `:id` as the record itself.
	// A route with a differently-named param, more than one param, a `*wildcard` segment, or an
	// `:id` that is not the final segment (`widget/:id/action` names a sub-resource, not the
	// widget) would advertise an `id`-only tool that silently drops the other segment(s) — so
	// those shapes must be skipped, not exposed.
	for (const pattern of [
		'widget/:id/action/:action',
		'widget/:id/action',
		'widget/:widgetId',
		'files/*rest',
		'files/*',
	]) {
		it(`skips a parameterised route the verb handlers cannot fully bind (${pattern})`, () => {
			_setResourcesForTest(makeRegistryWithParamRoute(pattern, makeParamResource()));
			registerApplicationTools();
			assert.equal(
				listSuperToolNames().length,
				0,
				`expected no tools for an unsupported param shape, got ${JSON.stringify(listSuperToolNames())}`
			);
		});
	}
});
