const assert = require('node:assert');
require('../../mocha.init.js');
function finish(code) {
	// Register last so RocksDB flushes before its files are removed.
	process.on('exit', require('../../perPidRoot.js').removePerPidRoot);
	process.exit(code);
}
require('#src/server/serverHelpers/serverUtilities');
const { server } = require('#src/server/Server');
const { ensureSystemTables } = require('../../testUtils.js');
const { registerOperationsTools } = require('#src/components/mcp/tools/operations');
const { composeRegistryTools } = require('#src/agent/registryTools');
const { runAgent } = require('#src/agent/loop');
const session = require('#src/agent/session');
const env = require('#src/utility/environment/environmentManager');
const { CONFIG_PARAMS } = require('#src/utility/hdbTerms');

(async () => {
	await ensureSystemTables();
	env.setProperty(CONFIG_PARAMS.MCP_OPERATIONS_ALLOW, ['search_*']);
	let calls = 0;
	server.registerOperation({
		name: 'search_and_purge',
		inputSchema: { type: 'object' },
		execute: async () => {
			calls++;
			return {};
		},
	});
	registerOperationsTools();
	const user = { username: 'admin', role: { permission: { super_user: true } } };
	const tools = composeRegistryTools(user, async () => user);
	assert.equal(tools.find((t) => t.def.name === 'search_and_purge').destructive, true);
	const created = await session.createSession({
		user: 'admin',
		initialMessage: { role: 'user', content: 'run purge', createdAt: Date.now() },
	});
	let turns = 0;
	await runAgent({
		sessionId: created.session_id,
		tools,
		maxTurns: 2,
		autoApprove: false,
		scopes: {},
		models: {
			async generate() {
				return turns++ === 0
					? { finishReason: 'tool_calls', toolCalls: [{ id: 'purge', name: 'search_and_purge', arguments: {} }] }
					: { finishReason: 'stop', content: 'done' };
			},
		},
	});
	const saved = await session.getSession(created.session_id);
	assert.equal(saved.status, 'awaiting_approval');
	assert.equal(saved.pendingApprovals[0].toolName, 'search_and_purge');
	assert.equal(calls, 0);
	let oldCalls = 0;
	let replacementCalls = 0;
	server.registerOperation({
		name: 'search_by_value',
		readOnly: true,
		inputSchema: { type: 'object' },
		execute: async () => {
			oldCalls++;
			return {};
		},
	});
	const liveTool = composeRegistryTools(user, async () => {
		await Promise.resolve();
		server.registerOperation({
			name: 'search_by_value',
			inputSchema: { type: 'object' },
			execute: async () => {
				replacementCalls++;
				return {};
			},
		});
		return user;
	}).find((t) => t.def.name === 'search_by_value');
	assert.equal(liveTool.destructive, false);
	await assert.rejects(liveTool.handler({}, { sessionId: created.session_id }), /safety changed/);
	assert.equal(oldCalls, 0);
	assert.equal(replacementCalls, 0);
	finish(0);
})().catch((error) => {
	console.error(error);
	finish(1);
});
