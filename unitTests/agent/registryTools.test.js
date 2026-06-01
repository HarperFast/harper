'use strict';

const assert = require('node:assert/strict');
const { addTool, _resetRegistryForTest } = require('#src/components/mcp/toolRegistry');
const { composeRegistryTools } = require('#src/agent/registryTools');
const { composeToolset } = require('#src/agent/toolset');

const superUser = { username: 'hdb_agent', role: { permission: { super_user: true } } };
const limitedUser = { username: 'ro', role: { permission: { operations: ['describe_all'] } } };

function fakeOpTool(name, overrides = {}) {
	return {
		name,
		description: `op ${name}`,
		inputSchema: { type: 'object' },
		profile: 'operations',
		visibleTo: () => true,
		handler: async () => ({ content: [{ type: 'text', text: 'ok' }], structuredContent: { ran: name } }),
		...overrides,
	};
}

describe('agent/registryTools', () => {
	beforeEach(() => _resetRegistryForTest());
	afterEach(() => _resetRegistryForTest());

	it('adapts visible operations-profile tools to AgentTools', async () => {
		addTool(fakeOpTool('describe_all'));
		addTool(fakeOpTool('search'));
		const tools = composeRegistryTools(superUser, 'sess');
		const names = tools.map((t) => t.def.name).sort();
		assert.deepEqual(names, ['describe_all', 'search']);
		// parameters carries the registry inputSchema
		assert.deepEqual(tools[0].def.parameters, { type: 'object' });
	});

	it('respects RBAC visibleTo — excludes tools the user cannot invoke', async () => {
		addTool(fakeOpTool('describe_all', { visibleTo: () => true }));
		addTool(fakeOpTool('drop_table', { visibleTo: (u) => u.role?.permission?.super_user === true }));
		const visible = composeRegistryTools(limitedUser, 'sess').map((t) => t.def.name);
		assert.deepEqual(visible, ['describe_all']);
		const all = composeRegistryTools(superUser, 'sess')
			.map((t) => t.def.name)
			.sort();
		assert.deepEqual(all, ['describe_all', 'drop_table']);
	});

	it('maps destructiveHint annotation to the AgentTool destructive flag', async () => {
		addTool(fakeOpTool('restart', { annotations: { destructiveHint: true } }));
		addTool(fakeOpTool('describe_all', { annotations: { readOnlyHint: true } }));
		const tools = composeRegistryTools(superUser, 'sess');
		const restart = tools.find((t) => t.def.name === 'restart');
		const describe = tools.find((t) => t.def.name === 'describe_all');
		assert.equal(restart.destructive, true);
		assert.notEqual(describe.destructive, true);
	});

	it('adapter handler returns structuredContent on success', async () => {
		addTool(fakeOpTool('search'));
		const [tool] = composeRegistryTools(superUser, 'sess');
		const result = await tool.handler({ q: 1 }, { sessionId: 'sess', scopes: {} });
		assert.deepEqual(result, { ran: 'search' });
	});

	it('adapter handler throws the error text when the registry tool returns isError', async () => {
		addTool(
			fakeOpTool('drop_table', {
				handler: async () => ({ isError: true, content: [{ type: 'text', text: 'permission denied' }] }),
			})
		);
		const [tool] = composeRegistryTools(superUser, 'sess');
		await assert.rejects(tool.handler({}, { sessionId: 'sess', scopes: {} }), /permission denied/);
	});

	it('composeToolset drops a registry tool that collides with an operator-only tool name', () => {
		// `read_file` is an operator-only FS tool; a registry tool of the same name must not shadow it.
		const fakeRegistryReadFile = {
			def: { name: 'read_file', description: 'registry shadow', parameters: { type: 'object' } },
			handler: async () => ({ shadow: true }),
		};
		const { tools } = composeToolset({
			onFollowup: () => {},
			registryTools: [fakeRegistryReadFile],
		});
		const readFileTools = tools.filter((t) => t.def.name === 'read_file');
		assert.equal(readFileTools.length, 1);
		assert.equal(
			readFileTools[0].def.description,
			'Read a UTF-8 text file within componentsRoot, logDir, or configDir.'
		);
	});
});
