'use strict';

const assert = require('node:assert');
const { runAgent, _resetInFlightForTests } = require('#src/agent/loop');
const session = require('#src/agent/session');

function deepFreeze(o) {
	if (o && typeof o === 'object') {
		for (const v of Object.values(o)) deepFreeze(v);
		Object.freeze(o);
	}
	return o;
}

function makeMockTable() {
	const store = new Map();
	return {
		store,
		// Resource-level put — the versioned write path session.ts writes through. Keys by the record's PK.
		async put(record) {
			store.set(record.session_id, structuredClone(record));
		},
		primaryStore: {
			async put(key, value) {
				store.set(key, structuredClone(value));
			},
			async get(key) {
				const value = store.get(key);
				// Return a FROZEN record, like the real store — so an in-place mutation (a mutator missing
				// the requireSession clone) throws instead of silently passing, as it did in production.
				return value ? deepFreeze(structuredClone(value)) : undefined;
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

describe('agent/loop per-session budgets (#3040)', () => {
	const { summarizeSessionUsage } = require('#src/agent/budget');

	beforeEach(() => {
		session._setTableForTests(makeMockTable());
		_resetInFlightForTests();
	});
	afterEach(() => {
		session._setTableForTests(undefined);
	});

	const usage = (promptTokens, completionTokens, costUsd) => ({
		usage: { promptTokens, completionTokens },
		...(costUsd !== undefined && { costUsd }),
	});
	const toolTurn = (id, name, metered) => ({
		content: '',
		finishReason: 'tool_calls',
		toolCalls: [{ id, name, arguments: {} }],
		...metered,
	});
	const finalTurn = (content, metered) => ({ content, finishReason: 'stop', ...metered });

	function countingTool(name, { destructive = false } = {}) {
		const tool = {
			runs: 0,
			def: { name, description: name, parameters: { type: 'object' } },
			destructive,
			handler: async () => {
				tool.runs++;
				return { ok: true };
			},
		};
		return tool;
	}

	async function newSession() {
		const created = await session.createSession({ user: 'admin' });
		await session.appendMessage(created.session_id, { role: 'user', content: 'go', createdAt: Date.now() });
		return created.session_id;
	}

	it('records each call on its assistant message, and the folded total matches the sum', async () => {
		const sessionId = await newSession();
		const read = countingTool('read');
		const models = stubModels([toolTurn('c1', 'read', usage(100, 20, 0.01)), finalTurn('done', usage(150, 30, 0.02))]);
		await runAgent({ sessionId, models, tools: [read], scopes, maxTurns: 5 });

		const reloaded = await session.getSession(sessionId);
		assert.equal(reloaded.status, 'completed');
		const assistants = reloaded.messages.filter((m) => m.role === 'assistant');
		assert.deepStrictEqual(assistants[0].usage, { promptTokens: 100, completionTokens: 20, costUsd: 0.01 });
		assert.deepStrictEqual(summarizeSessionUsage(reloaded.messages), {
			calls: 2,
			promptTokens: 250,
			completionTokens: 50,
			costUsd: 0.03,
		});
	});

	it('maxSessionTokens reached on a tool-call turn answers the calls without running them and ends the session error', async () => {
		const sessionId = await newSession();
		const read = countingTool('read');
		const models = stubModels([toolTurn('c1', 'read', usage(80, 30))]);
		await runAgent({ sessionId, models, tools: [read], scopes, maxTurns: 5, maxSessionTokens: 100 });

		const reloaded = await session.getSession(sessionId);
		assert.equal(read.runs, 0);
		assert.equal(reloaded.status, 'error');
		assert.match(reloaded.lastError, /agent\.maxSessionTokens=100 reached: this session used 110 tokens/);
		const toolMessages = reloaded.messages.filter((m) => m.role === 'tool');
		assert.equal(toolMessages.length, 1, 'every tool call keeps its response, so the transcript stays sendable');
		assert.equal(toolMessages[0].toolCallId, 'c1');
		assert.equal(JSON.parse(toolMessages[0].content).error, 'budget_exceeded');
	});

	it('a final answer that crosses the cap is delivered, and the completed run names the cap', async () => {
		const sessionId = await newSession();
		const models = stubModels([finalTurn('the answer', usage(80, 30))]);
		await runAgent({ sessionId, models, tools: noTools, scopes, maxTurns: 5, maxSessionTokens: 100 });

		const reloaded = await session.getSession(sessionId);
		assert.equal(reloaded.status, 'completed');
		assert.match(reloaded.lastError, /agent\.maxSessionTokens=100 reached/);
		assert.equal(reloaded.messages.at(-1).content, 'the answer');
	});

	it('a session already at its cap makes no model call on the next prompt', async () => {
		const sessionId = await newSession();
		await runAgent({
			sessionId,
			models: stubModels([finalTurn('first', usage(80, 30))]),
			tools: noTools,
			scopes,
			maxTurns: 5,
			maxSessionTokens: 100,
		});
		await session.appendMessage(sessionId, { role: 'user', content: 'more', createdAt: Date.now() });
		let generateCalls = 0;
		const models = {
			async generate() {
				generateCalls++;
				return finalTurn('unreached', usage(1, 1));
			},
		};
		await runAgent({ sessionId, models, tools: noTools, scopes, maxTurns: 5, maxSessionTokens: 100 });

		const reloaded = await session.getSession(sessionId);
		assert.equal(generateCalls, 0);
		assert.equal(reloaded.status, 'error');
		assert.match(reloaded.lastError, /maxSessionTokens=100 reached/);
	});

	it('maxCostUsd stops after a call it cannot price, naming the missing pricing', async () => {
		const sessionId = await newSession();
		const read = countingTool('read');
		const models = stubModels([toolTurn('c1', 'read', usage(10, 10)), finalTurn('unreached', usage(1, 1))]);
		await runAgent({ sessionId, models, tools: [read], scopes, maxTurns: 5, maxCostUsd: 1 });

		const reloaded = await session.getSession(sessionId);
		assert.equal(read.runs, 0);
		assert.equal(reloaded.status, 'error');
		assert.match(reloaded.lastError, /maxCostUsd=1 cannot be enforced: .*declare pricing/);
	});

	it('maxSessionTokens stops after a call that reported no token usage', async () => {
		const sessionId = await newSession();
		const models = stubModels([toolTurn('c1', 'read', {}), finalTurn('unreached', usage(1, 1))]);
		await runAgent({ sessionId, models, tools: [countingTool('read')], scopes, maxTurns: 5, maxSessionTokens: 1000 });

		const reloaded = await session.getSession(sessionId);
		assert.equal(reloaded.status, 'error');
		assert.match(reloaded.lastError, /maxSessionTokens=1000 cannot be enforced/);
	});

	it('priced calls under maxCostUsd keep running', async () => {
		const sessionId = await newSession();
		const read = countingTool('read');
		const models = stubModels([toolTurn('c1', 'read', usage(10, 10, 0.2)), finalTurn('done', usage(10, 10, 0.2))]);
		await runAgent({ sessionId, models, tools: [read], scopes, maxTurns: 5, maxCostUsd: 1 });

		const reloaded = await session.getSession(sessionId);
		assert.equal(read.runs, 1);
		assert.equal(reloaded.status, 'completed');
	});

	it('a cap lowered while an action awaits approval stops the approved action from running', async () => {
		const sessionId = await newSession();
		const drop = countingTool('drop', { destructive: true });
		await runAgent({
			sessionId,
			models: stubModels([toolTurn('c1', 'drop', usage(60, 10))]),
			tools: [drop],
			scopes,
			maxTurns: 5,
			autoApprove: false,
		});
		const paused = await session.getSession(sessionId);
		assert.equal(paused.status, 'awaiting_approval');
		await session.resolveApproval(sessionId, paused.pendingApprovals[0].id, true);

		await runAgent({
			sessionId,
			models: stubModels([]),
			tools: [drop],
			scopes,
			maxTurns: 5,
			autoApprove: false,
			maxSessionTokens: 50,
		});

		const reloaded = await session.getSession(sessionId);
		assert.equal(drop.runs, 0, 'the approved destructive action must not run over the cap');
		assert.equal(reloaded.status, 'error');
		assert.equal(reloaded.pendingApprovals[0].consumed, true);
		const toolMessages = reloaded.messages.filter((m) => m.role === 'tool');
		assert.equal(toolMessages.length, 1);
		assert.equal(toolMessages[0].toolCallId, 'c1');
		assert.equal(JSON.parse(toolMessages[0].content).error, 'budget_exceeded');
	});

	it('a stop on resume answers every open approval, resolved or not, so none is left pending', async () => {
		const sessionId = await newSession();
		const drop = countingTool('drop', { destructive: true });
		await runAgent({
			sessionId,
			models: stubModels([
				{
					content: '',
					finishReason: 'tool_calls',
					toolCalls: [
						{ id: 'c1', name: 'drop', arguments: {} },
						{ id: 'c2', name: 'drop', arguments: {} },
					],
					...usage(60, 10),
				},
			]),
			tools: [drop],
			scopes,
			maxTurns: 5,
			autoApprove: false,
		});
		const paused = await session.getSession(sessionId);
		assert.equal(paused.pendingApprovals.length, 2);
		await session.resolveApproval(sessionId, paused.pendingApprovals[0].id, true);

		await runAgent({
			sessionId,
			models: stubModels([]),
			tools: [drop],
			scopes,
			maxTurns: 5,
			autoApprove: false,
			maxSessionTokens: 50,
		});

		const reloaded = await session.getSession(sessionId);
		assert.equal(drop.runs, 0);
		assert.equal(reloaded.status, 'error');
		assert.ok(reloaded.pendingApprovals.every((a) => a.resolved && a.consumed));
		assert.equal(reloaded.pendingApprovals[1].approved, false);
		const answered = reloaded.messages.filter((m) => m.role === 'tool').map((m) => m.toolCallId);
		assert.deepStrictEqual(answered.sort(), ['c1', 'c2']);
	});

	it('a run that sees a cancel runs no approved action, and the cancel closes it for later prompts', async () => {
		for (const caps of [{}, { maxSessionTokens: 1_000_000 }]) {
			_resetInFlightForTests();
			const sessionId = await newSession();
			const drop = countingTool('drop', { destructive: true });
			await runAgent({
				sessionId,
				models: stubModels([toolTurn('c1', 'drop', usage(60, 10))]),
				tools: [drop],
				scopes,
				maxTurns: 5,
				autoApprove: false,
			});
			const paused = await session.getSession(sessionId);
			await session.resolveApproval(sessionId, paused.pendingApprovals[0].id, true);
			const controller = new AbortController();
			controller.abort();
			await runAgent({
				sessionId,
				models: stubModels([]),
				tools: [drop],
				scopes,
				maxTurns: 5,
				autoApprove: false,
				signal: controller.signal,
				...caps,
			});
			assert.equal(drop.runs, 0, JSON.stringify(caps));

			await session.cancelSession(sessionId);
			const cancelled = await session.getSession(sessionId);
			assert.ok(cancelled.pendingApprovals.every((a) => a.consumed));
			assert.equal(JSON.parse(cancelled.messages.at(-1).content).error, 'cancelled_by_operator');

			await session.appendMessage(sessionId, { role: 'user', content: 'summarize', createdAt: Date.now() });
			await runAgent({
				sessionId,
				models: stubModels([finalTurn('summary', usage(1, 1))]),
				tools: [drop],
				scopes,
				maxTurns: 5,
				autoApprove: false,
				...caps,
			});
			assert.equal(drop.runs, 0, 'the next prompt must not run the cancelled approval');
		}
	});

	it('a cancel that lands while an approved action runs leaves that call one response, its real result', async () => {
		const sessionId = await newSession();
		let release;
		let markStarted;
		const started = new Promise((resolve) => (markStarted = resolve));
		const drop = {
			runs: 0,
			def: { name: 'drop', description: 'drop', parameters: { type: 'object' } },
			destructive: true,
			handler: async () => {
				drop.runs++;
				markStarted();
				await new Promise((resolve) => (release = resolve));
				return { dropped: true };
			},
		};
		await runAgent({
			sessionId,
			models: stubModels([toolTurn('c1', 'drop', usage(60, 10))]),
			tools: [drop],
			scopes,
			maxTurns: 5,
			autoApprove: false,
		});
		const paused = await session.getSession(sessionId);
		await session.resolveApproval(sessionId, paused.pendingApprovals[0].id, true);

		const run = runAgent({
			sessionId,
			models: stubModels([finalTurn('done', usage(1, 1))]),
			tools: [drop],
			scopes,
			maxTurns: 5,
			autoApprove: false,
		});
		await started;
		await session.cancelSession(sessionId);
		release();
		await run;

		const reloaded = await session.getSession(sessionId);
		const responses = reloaded.messages.filter((m) => m.role === 'tool' && m.toolCallId === 'c1');
		assert.equal(responses.length, 1, 'one response per tool call');
		assert.deepStrictEqual(JSON.parse(responses[0].content), { ok: true, result: { dropped: true } });
		assert.equal(drop.runs, 1);
	});

	it('a cancel that lands during the claim answers the call instead of running the action', async () => {
		const sessionId = await newSession();
		const drop = countingTool('drop', { destructive: true });
		await runAgent({
			sessionId,
			models: stubModels([toolTurn('c1', 'drop', usage(60, 10))]),
			tools: [drop],
			scopes,
			maxTurns: 5,
			autoApprove: false,
		});
		const paused = await session.getSession(sessionId);
		const approvalId = paused.pendingApprovals[0].id;
		await session.resolveApproval(sessionId, approvalId, true);

		const controller = new AbortController();
		const table = session.getAgentSessionTable();
		const put = table.put.bind(table);
		table.put = async (row) => {
			await put(row);
			if (row.pendingApprovals.some((a) => a.id === approvalId && a.consumed)) controller.abort();
		};
		await runAgent({
			sessionId,
			models: stubModels([]),
			tools: [drop],
			scopes,
			maxTurns: 5,
			autoApprove: false,
			signal: controller.signal,
		});

		const reloaded = await session.getSession(sessionId);
		assert.equal(drop.runs, 0);
		const responses = reloaded.messages.filter((m) => m.role === 'tool' && m.toolCallId === 'c1');
		assert.equal(responses.length, 1);
		assert.equal(JSON.parse(responses[0].content).error, 'cancelled_by_operator');
	});

	it('endRun completes the transcript but keeps an aborted status a cancel already wrote', async () => {
		const sessionId = await newSession();
		await session.setStatus(sessionId, 'aborted', 'Cancelled by operator');
		await session.endRun(sessionId, {
			append: [{ role: 'tool', content: '{}', toolCallId: 'c1', createdAt: Date.now() }],
			status: 'error',
			lastError: 'agent.maxSessionTokens=1 reached',
		});
		const reloaded = await session.getSession(sessionId);
		assert.equal(reloaded.status, 'aborted');
		assert.equal(reloaded.lastError, 'Cancelled by operator');
		assert.equal(reloaded.messages.at(-1).toolCallId, 'c1');
	});

	it('an assistant turn written before usage was recorded makes a capped session unmeasured, not free', async () => {
		const sessionId = await newSession();
		await session.appendMessage(sessionId, { role: 'assistant', content: 'legacy', createdAt: Date.now() });
		await session.appendMessage(sessionId, { role: 'user', content: 'again', createdAt: Date.now() });
		let generateCalls = 0;
		const models = {
			async generate() {
				generateCalls++;
				return finalTurn('unreached', usage(1, 1));
			},
		};
		await runAgent({ sessionId, models, tools: noTools, scopes, maxTurns: 5, maxSessionTokens: 1_000_000 });

		const reloaded = await session.getSession(sessionId);
		assert.equal(generateCalls, 0);
		assert.equal(reloaded.status, 'error');
		assert.match(reloaded.lastError, /cannot be enforced/);
	});
});
