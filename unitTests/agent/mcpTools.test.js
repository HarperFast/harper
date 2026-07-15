'use strict';

/**
 * Unit tests for exposing the built-in agent over MCP (#626).
 * Verifies the curated agent tools register into the MCP registry, gate listing to the op's
 * role-level policy, and dispatch through the SAME enforced path as the generic operations
 * profile (chooseOperation + processLocalTransaction → verifyPerms), NOT a direct op.execute
 * that would bypass the requiresSuperUser gate (#1549 review).
 */

const assert = require('node:assert/strict');
const { getTool, snapshotProfileTools, _resetRegistryForTest } = require('#src/components/mcp/toolRegistry');
const {
	_setChooseOperationForTest,
	_setProcessLocalTransactionForTest,
} = require('#src/components/mcp/tools/operations');
const { registerAgentMcpTools } = require('#src/agent/mcpTools');

const SUPER = { username: 'admin', role: { permission: { super_user: true } } };
const RESTRICTED = { username: 'ro', role: { permission: { super_user: false } } };
// A scoped delegation role: not super_user, but explicitly granted the agent ops.
const DELEGATE = { username: 'agent-runner', role: { permission: { operations: ['agent_prompt'] } } };

function fakeOps() {
	const make = (name) => ({ name, execute: async () => ({ ok: true, op: name }) });
	return ['agent_prompt', 'get_agent_session', 'list_agent_sessions', 'approve_agent_action', 'cancel_agent_run'].map(
		make
	);
}

// Wire the dispatch seams so handlers run the enforced path without booting Harper's
// server-helpers graph. `calls` captures the body chooseOperation/processLocalTransaction saw.
function wireDispatch(calls) {
	_setChooseOperationForTest((body) => {
		calls.push({ name: body.operation, body });
		return async () => ({ ok: true, op: body.operation });
	});
	_setProcessLocalTransactionForTest(async ({ body }, fn) => fn(body));
}

describe('agent/mcpTools registerAgentMcpTools', () => {
	beforeEach(() => _resetRegistryForTest());
	afterEach(() => {
		_resetRegistryForTest();
		_setChooseOperationForTest(undefined);
		_setProcessLocalTransactionForTest(undefined);
	});

	it('registers the curated agent tools on the operations profile', () => {
		registerAgentMcpTools(fakeOps());
		const names = snapshotProfileTools('operations').map((t) => t.name);
		assert.ok(names.includes('agent_prompt'));
		assert.ok(names.includes('get_agent_session'));
		assert.ok(names.includes('list_agent_sessions'));
		// set_agent_config is intentionally NOT exposed over MCP.
		assert.ok(!names.includes('set_agent_config'));
	});

	it('lists for super_users and scoped delegation roles, not for restricted users', () => {
		registerAgentMcpTools(fakeOps());
		const prompt = getTool('agent_prompt');
		assert.equal(prompt.visibleTo(SUPER), true);
		assert.equal(prompt.visibleTo(DELEGATE), true); // operations: ['agent_prompt']
		assert.equal(prompt.visibleTo(RESTRICTED), false);
		// A delegate scoped to agent_prompt does NOT see the ops it wasn't granted.
		assert.equal(getTool('get_agent_session').visibleTo(DELEGATE), false);
	});

	it('annotates prompt/approve/cancel destructive and reads read-only', () => {
		registerAgentMcpTools(fakeOps());
		assert.equal(getTool('agent_prompt').annotations?.destructiveHint, true);
		assert.equal(getTool('cancel_agent_run').annotations?.destructiveHint, true);
		assert.equal(getTool('get_agent_session').annotations?.readOnlyHint, true);
	});

	it('dispatches through the enforced operation path (chooseOperation + processLocalTransaction), not op.execute', async () => {
		const calls = [];
		wireDispatch(calls);
		// Give the op a spy execute so we can prove the direct-execute bypass is gone: it must NOT be called.
		let directExecuteCalled = false;
		const ops = fakeOps();
		ops[0].execute = async () => {
			directExecuteCalled = true;
			return { ok: true, op: 'agent_prompt' };
		};
		registerAgentMcpTools(ops);

		const res = await getTool('agent_prompt').handler({ message: 'hi' }, { user: SUPER });

		assert.equal(directExecuteCalled, false); // enforcement path, not op.execute
		assert.deepEqual(res.structuredContent, { ok: true, op: 'agent_prompt' });
		assert.equal(calls.length, 1);
		assert.equal(calls[0].body.operation, 'agent_prompt');
		assert.equal(calls[0].body.message, 'hi');
		assert.equal(calls[0].body.hdb_user, SUPER); // enforcement identity attached for verifyPerms
	});

	it('surfaces a permission-denied error from the dispatch path as an isError result (not a throw)', async () => {
		// processLocalTransaction/verifyPerms rejects — the handler maps it to isError, matching MCP semantics.
		_setChooseOperationForTest(() => {
			throw Object.assign(new Error('User is not permitted to agent_prompt'), { statusCode: 403 });
		});
		_setProcessLocalTransactionForTest(async () => null);
		registerAgentMcpTools(fakeOps());

		const res = await getTool('agent_prompt').handler({ message: 'x' }, { user: RESTRICTED });
		assert.equal(res.isError, true);
		assert.match(res.content[0].text, /not permitted/);
	});
});
