'use strict';

const assert = require('node:assert/strict');
const { runAgent, _resetInFlightForTests } = require('#src/agent/loop');
const session = require('#src/agent/session');

function makeMockTable() {
	const store = new Map();
	return {
		store,
		primaryStore: {
			async put(key, value) {
				store.set(key, structuredClone(value));
			},
			async get(key) {
				const value = store.get(key);
				return value ? structuredClone(value) : undefined;
			},
			getRange() {
				return [];
			},
		},
	};
}

function stubModels(turns) {
	let i = 0;
	return {
		async generate() {
			const turn = turns[i++];
			if (!turn) throw new Error('stubModels exhausted');
			return turn;
		},
	};
}

const scopes = { componentsRoot: '/tmp', logDir: '/tmp', configDir: '/tmp' };
const noTools = [];

describe('agent/loop runAgent', () => {
	beforeEach(() => {
		session._setTableForTests(makeMockTable());
		_resetInFlightForTests();
	});

	afterEach(() => {
		session._setTableForTests(undefined);
	});

	it('terminates on a no-tool-call response and marks the session completed', async () => {
		const created = await session.createSession({ user: 'admin' });
		await session.appendMessage(created.session_id, { role: 'user', content: 'hi', createdAt: Date.now() });
		const models = stubModels([{ content: 'done', finishReason: 'stop' }]);

		await runAgent({
			sessionId: created.session_id,
			models,
			tools: noTools,
			scopes,
			maxTurns: 5,
		});

		const reloaded = await session.getSession(created.session_id);
		assert.equal(reloaded.status, 'completed');
		const lastMessage = reloaded.messages[reloaded.messages.length - 1];
		assert.equal(lastMessage.role, 'assistant');
		assert.equal(lastMessage.content, 'done');
	});

	it('dispatches tool calls and appends tool messages between turns', async () => {
		const created = await session.createSession({ user: 'admin' });
		await session.appendMessage(created.session_id, { role: 'user', content: 'echo', createdAt: Date.now() });
		const calls = [];
		const tool = {
			def: { name: 'echo', description: 'echo', parameters: { type: 'object' } },
			handler: async (args) => {
				calls.push(args);
				return { echoed: args.value };
			},
		};
		const models = stubModels([
			{
				content: 'calling tool',
				finishReason: 'tool_calls',
				toolCalls: [{ id: 'c1', name: 'echo', arguments: { value: 7 } }],
			},
			{ content: 'all done', finishReason: 'stop' },
		]);

		await runAgent({
			sessionId: created.session_id,
			models,
			tools: [tool],
			scopes,
			maxTurns: 5,
		});

		const reloaded = await session.getSession(created.session_id);
		assert.equal(reloaded.status, 'completed');
		assert.deepEqual(calls, [{ value: 7 }]);
		const toolMessage = reloaded.messages.find((m) => m.role === 'tool');
		assert.ok(toolMessage);
		assert.equal(toolMessage.toolCallId, 'c1');
		assert.match(toolMessage.content, /echoed/);
	});

	it('records a tool failure as a structured observation without aborting', async () => {
		const created = await session.createSession({ user: 'admin' });
		await session.appendMessage(created.session_id, { role: 'user', content: 'go', createdAt: Date.now() });
		const tool = {
			def: { name: 'broken', description: 'broken', parameters: { type: 'object' } },
			handler: async () => {
				throw new Error('handler boom');
			},
		};
		const models = stubModels([
			{
				content: '',
				finishReason: 'tool_calls',
				toolCalls: [{ id: 'c1', name: 'broken', arguments: {} }],
			},
			{ content: 'recovered', finishReason: 'stop' },
		]);

		await runAgent({
			sessionId: created.session_id,
			models,
			tools: [tool],
			scopes,
			maxTurns: 5,
		});

		const reloaded = await session.getSession(created.session_id);
		assert.equal(reloaded.status, 'completed');
		const toolMessage = reloaded.messages.find((m) => m.role === 'tool');
		assert.match(toolMessage.content, /handler boom/);
	});

	it('completes with an explanatory error when maxTurns is hit', async () => {
		const created = await session.createSession({ user: 'admin' });
		await session.appendMessage(created.session_id, { role: 'user', content: 'loop', createdAt: Date.now() });
		const tool = {
			def: { name: 'spin', description: 'spin', parameters: { type: 'object' } },
			handler: async () => ({ ok: true }),
		};
		const turns = Array.from({ length: 5 }, (_, i) => ({
			content: `t${i}`,
			finishReason: 'tool_calls',
			toolCalls: [{ id: `c${i}`, name: 'spin', arguments: {} }],
		}));
		const models = stubModels(turns);

		await runAgent({
			sessionId: created.session_id,
			models,
			tools: [tool],
			scopes,
			maxTurns: 3,
		});

		const reloaded = await session.getSession(created.session_id);
		assert.equal(reloaded.status, 'completed');
		assert.match(reloaded.lastError ?? '', /maxTurns=3/);
	});

	it('halts on a destructive tool call when autoApprove is false', async () => {
		const created = await session.createSession({ user: 'admin' });
		await session.appendMessage(created.session_id, { role: 'user', content: 'go', createdAt: Date.now() });
		let executed = false;
		const tool = {
			def: { name: 'restart', description: 'restart', parameters: { type: 'object' } },
			destructive: true,
			handler: async () => {
				executed = true;
				return { ok: true };
			},
		};
		const models = stubModels([
			{
				content: '',
				finishReason: 'tool_calls',
				toolCalls: [{ id: 'c1', name: 'restart', arguments: {} }],
			},
		]);

		await runAgent({
			sessionId: created.session_id,
			models,
			tools: [tool],
			scopes,
			maxTurns: 5,
			autoApprove: false,
		});

		const reloaded = await session.getSession(created.session_id);
		assert.equal(executed, false);
		assert.equal(reloaded.status, 'awaiting_approval');
		assert.equal(reloaded.pendingApprovals.length, 1);
		assert.equal(reloaded.pendingApprovals[0].toolName, 'restart');
		// No placeholder tool response: LLM APIs reject duplicate tool responses for the same
		// tool_call_id. The tool response is only written when the operator resolves the approval.
		const toolMessages = reloaded.messages.filter((m) => m.role === 'tool');
		assert.equal(toolMessages.length, 0);
	});

	it('preserves 1:1 tool-call mapping when a turn mixes destructive and non-destructive calls', async () => {
		const created = await session.createSession({ user: 'admin' });
		await session.appendMessage(created.session_id, { role: 'user', content: 'go', createdAt: Date.now() });
		const reads = [];
		const readTool = {
			def: { name: 'read', description: 'read', parameters: { type: 'object' } },
			handler: async (args) => {
				reads.push(args);
				return { value: 'data' };
			},
		};
		const dropTool = {
			def: { name: 'drop', description: 'drop', parameters: { type: 'object' } },
			destructive: true,
			handler: async () => ({ dropped: true }),
		};
		const models = stubModels([
			{
				content: '',
				finishReason: 'tool_calls',
				toolCalls: [
					{ id: 'c1', name: 'read', arguments: { what: 'first' } },
					{ id: 'c2', name: 'drop', arguments: { table: 'x' } },
					{ id: 'c3', name: 'read', arguments: { what: 'second' } },
				],
			},
		]);

		await runAgent({
			sessionId: created.session_id,
			models,
			tools: [readTool, dropTool],
			scopes,
			maxTurns: 5,
			autoApprove: false,
		});

		const reloaded = await session.getSession(created.session_id);
		assert.equal(reloaded.status, 'awaiting_approval');
		assert.equal(reads.length, 2, 'both non-destructive reads should execute');
		const toolMessages = reloaded.messages.filter((m) => m.role === 'tool');
		// Two tool responses (for c1 and c3); c2 is awaiting approval — no placeholder.
		assert.equal(toolMessages.length, 2);
		const toolCallIds = toolMessages.map((m) => m.toolCallId).sort();
		assert.deepEqual(toolCallIds, ['c1', 'c3']);
		assert.equal(reloaded.pendingApprovals.length, 1);
		assert.equal(reloaded.pendingApprovals[0].toolCallId, 'c2');
	});

	it('executes a destructive tool when autoApprove is true', async () => {
		const created = await session.createSession({ user: 'admin' });
		await session.appendMessage(created.session_id, { role: 'user', content: 'go', createdAt: Date.now() });
		let executed = false;
		const tool = {
			def: { name: 'restart', description: 'restart', parameters: { type: 'object' } },
			destructive: true,
			handler: async () => {
				executed = true;
				return { ok: true };
			},
		};
		const models = stubModels([
			{
				content: '',
				finishReason: 'tool_calls',
				toolCalls: [{ id: 'c1', name: 'restart', arguments: {} }],
			},
			{ content: 'done', finishReason: 'stop' },
		]);

		await runAgent({
			sessionId: created.session_id,
			models,
			tools: [tool],
			scopes,
			maxTurns: 5,
			autoApprove: true,
		});

		assert.equal(executed, true);
		const reloaded = await session.getSession(created.session_id);
		assert.equal(reloaded.status, 'completed');
	});

	it('consumes an approved approval on the next run and executes the saved call', async () => {
		const created = await session.createSession({ user: 'admin' });
		await session.appendMessage(created.session_id, { role: 'user', content: 'go', createdAt: Date.now() });
		let executed = 0;
		const tool = {
			def: { name: 'restart', description: 'restart', parameters: { type: 'object' } },
			destructive: true,
			handler: async () => {
				executed++;
				return { restarted: true };
			},
		};
		const models = stubModels([
			{
				content: '',
				finishReason: 'tool_calls',
				toolCalls: [{ id: 'c1', name: 'restart', arguments: { force: true } }],
			},
			{ content: 'done after approval', finishReason: 'stop' },
		]);

		await runAgent({
			sessionId: created.session_id,
			models,
			tools: [tool],
			scopes,
			maxTurns: 5,
			autoApprove: false,
		});

		// First run halts at awaiting_approval. Operator approves, loop resumes.
		const halted = await session.getSession(created.session_id);
		const approval = halted.pendingApprovals[0];
		await session.resolveApproval(created.session_id, approval.id, true);

		await runAgent({
			sessionId: created.session_id,
			models,
			tools: [tool],
			scopes,
			maxTurns: 5,
			autoApprove: false,
		});

		assert.equal(executed, 1);
		const final = await session.getSession(created.session_id);
		assert.equal(final.status, 'completed');
		const toolMessages = final.messages.filter((m) => m.role === 'tool');
		// Exactly one tool response for the gated call (the executed one) — no placeholder.
		assert.equal(toolMessages.length, 1);
		assert.match(toolMessages[0].content, /restarted/);
		assert.equal(toolMessages[0].toolCallId, 'c1');
		assert.equal(final.pendingApprovals[0].consumed, true);
	});

	it('records a denied approval as denied_by_operator without executing', async () => {
		const created = await session.createSession({ user: 'admin' });
		await session.appendMessage(created.session_id, { role: 'user', content: 'go', createdAt: Date.now() });
		let executed = 0;
		const tool = {
			def: { name: 'restart', description: 'restart', parameters: { type: 'object' } },
			destructive: true,
			handler: async () => {
				executed++;
				return { restarted: true };
			},
		};
		const models = stubModels([
			{
				content: '',
				finishReason: 'tool_calls',
				toolCalls: [{ id: 'c1', name: 'restart', arguments: {} }],
			},
			{ content: 'pivoted', finishReason: 'stop' },
		]);

		await runAgent({
			sessionId: created.session_id,
			models,
			tools: [tool],
			scopes,
			maxTurns: 5,
			autoApprove: false,
		});

		const halted = await session.getSession(created.session_id);
		await session.resolveApproval(created.session_id, halted.pendingApprovals[0].id, false);

		await runAgent({
			sessionId: created.session_id,
			models,
			tools: [tool],
			scopes,
			maxTurns: 5,
			autoApprove: false,
		});

		assert.equal(executed, 0);
		const final = await session.getSession(created.session_id);
		assert.equal(final.status, 'completed');
		const toolMessages = final.messages.filter((m) => m.role === 'tool');
		assert.equal(toolMessages.length, 1);
		assert.match(toolMessages[0].content, /denied_by_operator/);
	});

	it('stays paused until ALL gated calls in a turn are resolved (no partial-approval 400)', async () => {
		const created = await session.createSession({ user: 'admin' });
		await session.appendMessage(created.session_id, { role: 'user', content: 'go', createdAt: Date.now() });
		let executed = 0;
		const dropTool = {
			def: { name: 'drop', description: 'drop', parameters: { type: 'object' } },
			destructive: true,
			handler: async () => {
				executed++;
				return { dropped: true };
			},
		};
		const models = stubModels([
			{
				content: '',
				finishReason: 'tool_calls',
				toolCalls: [
					{ id: 'c1', name: 'drop', arguments: { t: 'A' } },
					{ id: 'c2', name: 'drop', arguments: { t: 'B' } },
				],
			},
			{ content: 'done', finishReason: 'stop' },
		]);
		const run = { sessionId: created.session_id, models, tools: [dropTool], scopes, maxTurns: 5, autoApprove: false };

		await runAgent(run);
		let s = await session.getSession(created.session_id);
		assert.equal(s.status, 'awaiting_approval');
		assert.equal(s.pendingApprovals.length, 2);

		// Approve only the first. The loop must NOT advance to generate() with one tool response missing.
		await session.resolveApproval(created.session_id, s.pendingApprovals[0].id, true);
		await runAgent(run);
		s = await session.getSession(created.session_id);
		assert.equal(executed, 1, 'first approved call executed');
		assert.equal(s.status, 'awaiting_approval', 'still paused on the second pending approval');

		// Approve the second; now the loop can complete.
		await session.resolveApproval(created.session_id, s.pendingApprovals[1].id, true);
		await runAgent(run);
		s = await session.getSession(created.session_id);
		assert.equal(executed, 2);
		assert.equal(s.status, 'completed');
		const toolMsgs = s.messages.filter((m) => m.role === 'tool');
		assert.deepEqual(toolMsgs.map((m) => m.toolCallId).sort(), ['c1', 'c2']);
	});

	it('preserves aborted status when signal aborts mid-generate', async () => {
		const created = await session.createSession({ user: 'admin' });
		await session.appendMessage(created.session_id, { role: 'user', content: 'go', createdAt: Date.now() });
		const controller = new AbortController();
		const models = {
			async generate(_input, _opts) {
				// Caller aborts mid-call; honor the signal as a real backend would.
				controller.abort();
				await session.setStatus(created.session_id, 'aborted');
				const err = new Error('AbortError');
				err.name = 'AbortError';
				throw err;
			},
		};

		await runAgent({
			sessionId: created.session_id,
			models,
			tools: noTools,
			scopes,
			maxTurns: 5,
			signal: controller.signal,
		});

		const reloaded = await session.getSession(created.session_id);
		assert.equal(reloaded.status, 'aborted');
	});

	it('coalesces concurrent runs against the same session', async () => {
		const created = await session.createSession({ user: 'admin' });
		await session.appendMessage(created.session_id, { role: 'user', content: 'one', createdAt: Date.now() });
		let calls = 0;
		const models = {
			async generate() {
				calls++;
				return { content: 'ok', finishReason: 'stop' };
			},
		};
		const a = runAgent({ sessionId: created.session_id, models, tools: noTools, scopes, maxTurns: 1 });
		const b = runAgent({ sessionId: created.session_id, models, tools: noTools, scopes, maxTurns: 1 });
		assert.equal(a, b);
		await a;
		assert.equal(calls, 1);
	});
});
