'use strict';

/**
 * Unit tests for exposing the built-in agent over MCP (#626).
 * Verifies the curated agent tools register into the MCP registry, are super_user-gated for listing,
 * dispatch to the underlying operation's execute with the caller as hdb_user, and surface errors.
 */

const assert = require('node:assert/strict');
const { getTool, snapshotProfileTools, _resetRegistryForTest } = require('#src/components/mcp/toolRegistry');
const { registerAgentMcpTools } = require('#src/agent/mcpTools');

const SUPER = { username: 'admin', role: { permission: { super_user: true } } };
const RESTRICTED = { username: 'ro', role: { permission: { super_user: false } } };

function fakeOps(calls) {
	const make = (name) => ({ name, execute: async (body) => (calls.push({ name, body }), { ok: true, op: name }) });
	return ['agent_prompt', 'get_agent_session', 'list_agent_sessions', 'approve_agent_action', 'cancel_agent_run'].map(
		make
	);
}

describe('agent/mcpTools registerAgentMcpTools', () => {
	beforeEach(() => _resetRegistryForTest());
	afterEach(() => _resetRegistryForTest());

	it('registers the curated agent tools on the operations profile', () => {
		registerAgentMcpTools(fakeOps([]));
		const names = snapshotProfileTools('operations').map((t) => t.name);
		assert.ok(names.includes('agent_prompt'));
		assert.ok(names.includes('get_agent_session'));
		assert.ok(names.includes('list_agent_sessions'));
		// set_agent_config is intentionally NOT exposed over MCP.
		assert.ok(!names.includes('set_agent_config'));
	});

	it('lists only for super_users', () => {
		registerAgentMcpTools(fakeOps([]));
		const prompt = getTool('agent_prompt');
		assert.equal(prompt.visibleTo(SUPER), true);
		assert.equal(prompt.visibleTo(RESTRICTED), false);
	});

	it('annotates prompt/approve/cancel destructive and reads read-only', () => {
		registerAgentMcpTools(fakeOps([]));
		assert.equal(getTool('agent_prompt').annotations?.destructiveHint, true);
		assert.equal(getTool('cancel_agent_run').annotations?.destructiveHint, true);
		assert.equal(getTool('get_agent_session').annotations?.readOnlyHint, true);
	});

	it('dispatches to the op execute with operation + caller hdb_user, returning structuredContent', async () => {
		const calls = [];
		registerAgentMcpTools(fakeOps(calls));
		const res = await getTool('agent_prompt').handler({ message: 'hi' }, { user: SUPER });
		assert.deepEqual(res.structuredContent, { ok: true, op: 'agent_prompt' });
		assert.equal(calls.length, 1);
		assert.equal(calls[0].body.operation, 'agent_prompt');
		assert.equal(calls[0].body.message, 'hi');
		assert.equal(calls[0].body.hdb_user, SUPER); // enforcement identity passed through
	});

	it('surfaces an operation failure as an isError result (not a throw)', async () => {
		const ops = [
			{
				name: 'agent_prompt',
				execute: async () => {
					throw Object.assign(new Error('denied'), { http_resp_msg: 'nope' });
				},
			},
		];
		registerAgentMcpTools(ops);
		const res = await getTool('agent_prompt').handler({ message: 'x' }, { user: SUPER });
		assert.equal(res.isError, true);
		assert.match(res.content[0].text, /nope/);
	});
});
