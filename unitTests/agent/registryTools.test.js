'use strict';

/**
 * Unit tests for the agent's registry-tool composition (#626).
 *
 * Registers fake Operations-profile tools directly via the registry's `addTool`
 * (same technique as `unitTests/components/mcp/toolRegistry.test.js`), then
 * verifies `composeRegistryTools` filters by RBAC visibility, adapts the tool
 * shape, wires the destructive gate, and unwraps / re-throws the handler result.
 * `composeToolset` is checked for the operator-wins-on-collision merge rule.
 *
 * No server boot and no real operations runtime — the registry is populated
 * with stubs, so this stays a fast, credit-free unit test.
 */

const assert = require('node:assert/strict');
const { addTool, _resetRegistryForTest } = require('#src/components/mcp/toolRegistry');
const { composeRegistryTools, _resetRegistryToolsForTests } = require('#src/agent/registryTools');
const { composeToolset } = require('#src/agent/toolset');

const SUPER_USER = { username: 'agent', role: { permission: { super_user: true } } };
const RESTRICTED = { username: 'ro', role: { permission: { super_user: false } } };

function opTool(overrides = {}) {
	return {
		name: 'describe_all',
		description: 'Describe everything',
		inputSchema: { type: 'object', properties: {} },
		profile: 'operations',
		visibleTo: () => true,
		handler: async () => ({ content: [{ type: 'text', text: 'ok' }], structuredContent: { ok: true } }),
		...overrides,
	};
}

const scheduleDeps = { onFollowup: async () => {} };

// composeRegistryTools takes (listingUser, resolveIdentity). Most tests use the same user for both.
const identity = (user) => async () => user;

describe('agent/registryTools composeRegistryTools', () => {
	beforeEach(() => {
		_resetRegistryForTest();
		_resetRegistryToolsForTests();
	});
	afterEach(() => {
		_resetRegistryForTest();
		_resetRegistryToolsForTests();
	});

	it('adapts a registry ToolDef to the agent AgentTool shape', () => {
		addTool(opTool({ name: 'search', description: 'Search', inputSchema: { type: 'object', properties: { q: {} } } }));
		const [tool] = composeRegistryTools(SUPER_USER, identity(SUPER_USER));
		assert.equal(tool.def.name, 'search');
		assert.equal(tool.def.description, 'Search');
		// inputSchema → parameters
		assert.deepEqual(tool.def.parameters, { type: 'object', properties: { q: {} } });
	});

	it('only includes tools whose visibleTo(user) is true', () => {
		addTool(opTool({ name: 'visible_op', visibleTo: () => true }));
		addTool(opTool({ name: 'hidden_op', visibleTo: (user) => user?.role?.permission?.super_user === true }));
		const names = composeRegistryTools(RESTRICTED, identity(RESTRICTED)).map((t) => t.def.name);
		assert.deepEqual(names, ['visible_op']);
	});

	it('only drains the operations profile, not other profiles', () => {
		addTool(opTool({ name: 'ops_op', profile: 'operations' }));
		addTool(opTool({ name: 'app_op', profile: 'application' }));
		const names = composeRegistryTools(SUPER_USER, identity(SUPER_USER)).map((t) => t.def.name);
		assert.deepEqual(names, ['ops_op']);
	});

	it('marks a tool destructive when annotations.destructiveHint is set', () => {
		addTool(opTool({ name: 'restart', annotations: { destructiveHint: true } }));
		addTool(opTool({ name: 'describe_all', annotations: { readOnlyHint: true } }));
		const byName = new Map(composeRegistryTools(SUPER_USER, identity(SUPER_USER)).map((t) => [t.def.name, t]));
		assert.equal(byName.get('restart').destructive, true);
		assert.equal(byName.get('describe_all').destructive, false);
	});

	it("handler unwraps structuredContent and passes the agent's user as hdb_user", async () => {
		let seenUser;
		addTool(
			opTool({
				name: 'search',
				handler: async (args, context) => {
					seenUser = context.user;
					return { content: [{ type: 'text', text: 'x' }], structuredContent: { rows: [1, 2] } };
				},
			})
		);
		const [tool] = composeRegistryTools(SUPER_USER, identity(SUPER_USER));
		const result = await tool.handler({ table: 't' }, { sessionId: 's1' });
		assert.deepEqual(result, { rows: [1, 2] });
		assert.equal(seenUser, SUPER_USER); // enforcement identity is the configured agent user
	});

	it('handler falls back to joined text when there is no structuredContent', async () => {
		addTool(
			opTool({
				name: 'search',
				handler: async () => ({
					content: [
						{ type: 'text', text: 'line one' },
						{ type: 'text', text: 'line two' },
					],
				}),
			})
		);
		const [tool] = composeRegistryTools(SUPER_USER, identity(SUPER_USER));
		assert.equal(await tool.handler({}, { sessionId: 's1' }), 'line one\nline two');
	});

	it('handler throws on an isError result so the loop records a recoverable failure', async () => {
		addTool(
			opTool({
				name: 'search',
				handler: async () => ({ isError: true, content: [{ type: 'text', text: 'boom' }] }),
			})
		);
		const [tool] = composeRegistryTools(SUPER_USER, identity(SUPER_USER));
		await assert.rejects(() => tool.handler({}, { sessionId: 's1' }), /boom/);
	});

	it('resolves the enforcement identity fresh on each call (live role change is honored)', async () => {
		const seen = [];
		addTool(
			opTool({
				name: 'search',
				handler: async (args, context) => {
					seen.push(context.user);
					return { content: [{ type: 'text', text: 'ok' }], structuredContent: { ok: true } };
				},
			})
		);
		// resolveIdentity returns a different user object each call — the second reflects a role change.
		let call = 0;
		const resolveIdentity = async () => (call++ === 0 ? SUPER_USER : RESTRICTED);
		const [tool] = composeRegistryTools(SUPER_USER, resolveIdentity);
		await tool.handler({}, { sessionId: 's1' });
		await tool.handler({}, { sessionId: 's1' });
		assert.equal(seen[0], SUPER_USER);
		assert.equal(seen[1], RESTRICTED); // not the cached startup identity
	});

	it('handler propagates a fail-closed resolveIdentity rejection (never runs with a stale identity)', async () => {
		let handlerRan = false;
		addTool(
			opTool({
				name: 'search',
				handler: async () => {
					handlerRan = true;
					return { content: [{ type: 'text', text: 'ok' }] };
				},
			})
		);
		const resolveIdentity = async () => {
			throw new Error("agent.user 'ghost' could not be resolved to a permissioned user; failing closed");
		};
		const [tool] = composeRegistryTools(SUPER_USER, resolveIdentity);
		await assert.rejects(() => tool.handler({}, { sessionId: 's1' }), /failing closed/);
		assert.equal(handlerRan, false); // the operation never dispatched
	});
});

describe('agent/toolset composeToolset — registry merge', () => {
	beforeEach(() => {
		_resetRegistryForTest();
		_resetRegistryToolsForTests();
	});
	afterEach(() => {
		_resetRegistryForTest();
		_resetRegistryToolsForTests();
	});

	function registryTool(name, destructive = false) {
		return {
			def: { name, description: name, parameters: { type: 'object' } },
			destructive,
			_fromRegistry: true, // marker so we can tell it apart from an operator tool of the same name
			handler: async () => 'registry',
		};
	}

	it('includes registry tools alongside operator-only tools', () => {
		const { tools } = composeToolset({ ...scheduleDeps, registryTools: [registryTool('search')] });
		assert.ok(tools.some((t) => t.def.name === 'search'));
		// operator-only tools are still present
		assert.ok(tools.some((t) => t.def.name === 'read_file'));
	});

	it('operator-only tools win on a name collision (registry tool is dropped)', () => {
		const { tools } = composeToolset({ ...scheduleDeps, registryTools: [registryTool('read_file')] });
		const readFile = tools.filter((t) => t.def.name === 'read_file');
		assert.equal(readFile.length, 1, 'no duplicate read_file');
		assert.notEqual(readFile[0]._fromRegistry, true, 'operator read_file survives, not the registry one');
	});

	it('filters destructive registry tools when allowDestructive is false', () => {
		const { tools } = composeToolset({
			...scheduleDeps,
			allowDestructive: false,
			registryTools: [registryTool('restart', true), registryTool('search', false)],
		});
		const names = tools.map((t) => t.def.name);
		assert.ok(!names.includes('restart'));
		assert.ok(names.includes('search'));
	});
});
