const assert = require('node:assert');
require('../../mocha.init.js');
require('#src/server/serverHelpers/serverUtilities');
const { server } = require('#src/server/Server');
const { ensureSystemTables } = require('../../testUtils.js');
const { registerOperationsTools } = require('#src/components/mcp/tools/operations');
const { composeRegistryTools } = require('#src/agent/registryTools');
const { runAgent } = require('#src/agent/loop');
const session = require('#src/agent/session');

(async () => {
	await ensureSystemTables();
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
	process.exit(0);
})().catch((error) => {
	console.error(error);
	process.exit(1);
});
