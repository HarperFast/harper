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
		const observation = reloaded.messages.find((m) => m.role === 'tool');
		assert.match(observation.content, /awaiting_approval/);
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
		// One awaiting_approval observation, then the approved-execution observation.
		assert.equal(toolMessages.length, 2);
		assert.match(toolMessages[1].content, /restarted/);
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
		assert.match(toolMessages[1].content, /denied_by_operator/);
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
