const assert = require('node:assert');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const path = require('node:path');
const runFile = promisify(execFile);
const { addTool, _resetRegistryForTest } = require('#src/components/mcp/toolRegistry');
const { composeRegistryTools, _resetRegistryToolsForTests } = require('#src/agent/registryTools');

const SUPER_USER = { username: 'agent', role: { permission: { super_user: true } } };
const identity = (user) => async () => user;
const opTool = (overrides) => ({
	inputSchema: { type: 'object' },
	profile: 'operations',
	visibleTo: () => true,
	description: 'Operation lifecycle test',
	...overrides,
});

describe('agent registry safety at call time', function () {
	it('pauses a real registered custom operation for approval without executing it', async function () {
		this.timeout(60000);
		await runFile(process.execPath, [path.join(__dirname, 'fixtures/registrySafetyLoop.cjs')], {
			timeout: 55000,
		});
	});
	beforeEach(() => {
		_resetRegistryForTest();
		_resetRegistryToolsForTests();
	});
	afterEach(() => {
		_resetRegistryForTest();
		_resetRegistryToolsForTests();
	});
	it('dispatches a safe replacement through its live handler', async () => {
		let oldCalls = 0;
		let liveCalls = 0;
		const def = opTool({
			name: 'safe_replacement',
			annotations: { readOnlyHint: true },
			handler: async () => {
				oldCalls++;
				return { content: [] };
			},
		});
		addTool(def);
		const [tool] = composeRegistryTools(SUPER_USER, identity(SUPER_USER));
		addTool({
			...def,
			handler: async () => {
				liveCalls++;
				return { content: [], structuredContent: { live: true } };
			},
		});
		assert.deepEqual(await tool.handler({}, { sessionId: 'replacement' }), { live: true });
		assert.equal(oldCalls, 0);
		assert.equal(liveCalls, 1);
	});

	it('refuses a stale non-destructive tool after its live definition becomes destructive', async () => {
		let calls = 0;
		let replacementCalls = 0;
		const def = opTool({
			name: 'changed_safety',
			annotations: { readOnlyHint: true },
			handler: async () => {
				calls++;
				return { content: [], structuredContent: {} };
			},
		});
		addTool(def);
		const [tool] = composeRegistryTools(SUPER_USER, async () => {
			await Promise.resolve();
			addTool({
				...def,
				annotations: { destructiveHint: true },
				handler: async () => {
					replacementCalls++;
					return { content: [] };
				},
			});
			return SUPER_USER;
		});
		await assert.rejects(tool.handler({}, { sessionId: 'safety' }), /safety.*changed|refresh/i);
		assert.equal(calls, 0);
		assert.equal(replacementCalls, 0);
	});

	it('refuses a stale tool when the live operations definition is no longer available', async () => {
		let calls = 0;
		addTool(
			opTool({
				name: 'removed_live_tool',
				handler: async () => {
					calls++;
					return { content: [], structuredContent: {} };
				},
			})
		);
		const [tool] = composeRegistryTools(SUPER_USER, identity(SUPER_USER));
		_resetRegistryForTest();
		await assert.rejects(tool.handler({}, { sessionId: 'removed' }), /no longer available/i);
		assert.equal(calls, 0);
	});
});
