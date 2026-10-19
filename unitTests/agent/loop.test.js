'use strict';

const assert = require('node:assert');
const { runAgent, admitRun, fenceRuns, _resetInFlightForTests } = require('#src/agent/loop');
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

	it('ends in error, not completed, when a turn is cut off at maxTokens with no content', async () => {
		const created = await session.createSession({ user: 'admin' });
		await session.appendMessage(created.session_id, { role: 'user', content: 'report', createdAt: Date.now() });
		const sentOpts = [];
		const models = {
			async generate(_input, generateOpts) {
				sentOpts.push(generateOpts);
				return { content: '', finishReason: 'length' };
			},
		};

		await runAgent({
			sessionId: created.session_id,
			models,
			tools: noTools,
			scopes,
			maxTurns: 5,
			generateOpts: { maxTokens: 1234 },
		});

		assert.deepEqual(
			sentOpts.map((o) => o.maxTokens),
			[1234]
		);
		const reloaded = await session.getSession(created.session_id);
		assert.equal(reloaded.status, 'error');
		assert.match(reloaded.lastError, /maxTokens=1234/);
		assert.match(reloaded.lastError, /agent\.maxTokens/);
		assert.match(reloaded.lastError, /context window/);
		assert.deepEqual(
			reloaded.messages.map((m) => m.role),
			['user']
		);
	});

	it('ends in error when the model returns an empty reply with finishReason stop', async () => {
		const created = await session.createSession({ user: 'admin' });
		await session.appendMessage(created.session_id, { role: 'user', content: 'report', createdAt: Date.now() });
		const models = stubModels([{ content: '  \n', finishReason: 'stop' }]);

		await runAgent({ sessionId: created.session_id, models, tools: noTools, scopes, maxTurns: 5 });

		const reloaded = await session.getSession(created.session_id);
		assert.equal(reloaded.status, 'error');
		assert.match(reloaded.lastError, /empty/i);
		assert.match(reloaded.lastError, /finishReason=stop/);
		assert.deepEqual(
			reloaded.messages.map((m) => m.role),
			['user']
		);
	});

	it('does not record the partial text of a truncated reply as an answer', async () => {
		const created = await session.createSession({ user: 'admin' });
		await session.appendMessage(created.session_id, { role: 'user', content: 'report', createdAt: Date.now() });
		const models = stubModels([{ content: 'Health summary: 1. cluster-a OK 2. clu', finishReason: 'length' }]);

		await runAgent({ sessionId: created.session_id, models, tools: noTools, scopes, maxTurns: 5 });

		const reloaded = await session.getSession(created.session_id);
		assert.equal(reloaded.status, 'error');
		assert.match(reloaded.lastError, /maxTokens=backend default/);
		assert.deepEqual(
			reloaded.messages.map((m) => m.role),
			['user']
		);
	});

	it('ends in error when the model signals tool_calls but no call could be parsed', async () => {
		const created = await session.createSession({ user: 'admin' });
		await session.appendMessage(created.session_id, { role: 'user', content: 'go', createdAt: Date.now() });
		const models = stubModels([{ content: 'Let me check the logs.', finishReason: 'tool_calls' }]);

		await runAgent({ sessionId: created.session_id, models, tools: noTools, scopes, maxTurns: 5 });

		const reloaded = await session.getSession(created.session_id);
		assert.equal(reloaded.status, 'error');
		assert.match(reloaded.lastError, /could not be parsed/);
	});

	it('ends in error when the provider content filter stops the reply', async () => {
		const created = await session.createSession({ user: 'admin' });
		await session.appendMessage(created.session_id, { role: 'user', content: 'report', createdAt: Date.now() });
		const models = stubModels([{ content: 'Partial', finishReason: 'content_filter' }]);

		await runAgent({ sessionId: created.session_id, models, tools: noTools, scopes, maxTurns: 5 });

		const reloaded = await session.getSession(created.session_id);
		assert.equal(reloaded.status, 'error');
		assert.match(reloaded.lastError, /content filter/);
	});

	it('neither executes nor queues tool calls from a truncated turn, and keeps the transcript resumable', async () => {
		const created = await session.createSession({ user: 'admin' });
		await session.appendMessage(created.session_id, { role: 'user', content: 'go', createdAt: Date.now() });
		const executed = [];
		const readTool = {
			def: { name: 'read', description: 'read', parameters: { type: 'object' } },
			handler: async (args) => {
				executed.push(['read', args]);
				return { value: 'data' };
			},
		};
		const writeTool = {
			def: { name: 'write', description: 'write', parameters: { type: 'object' } },
			destructive: true,
			handler: async (args) => {
				executed.push(['write', args]);
				return { written: true };
			},
		};
		const requests = [];
		const turns = [
			{
				content: '',
				finishReason: 'length',
				toolCalls: [
					{ id: 'c1', name: 'read', arguments: { what: 'x' } },
					{ id: 'c2', name: 'write', arguments: { content: 'first half of a fi' } },
				],
			},
			{ content: 'retried properly', finishReason: 'stop' },
		];
		const models = {
			async generate(input) {
				requests.push(input.messages);
				return turns[requests.length - 1];
			},
		};

		await runAgent({
			sessionId: created.session_id,
			models,
			tools: [readTool, writeTool],
			scopes,
			maxTurns: 5,
			autoApprove: false,
		});

		let reloaded = await session.getSession(created.session_id);
		assert.equal(reloaded.status, 'error');
		assert.match(reloaded.lastError, /2 tool call\(s\) were not executed/);
		assert.deepEqual(executed, []);
		assert.deepEqual(reloaded.pendingApprovals, []);
		assert.deepEqual(
			reloaded.messages.map((m) => m.role),
			['user']
		);

		await session.appendMessage(created.session_id, { role: 'user', content: 'try again', createdAt: Date.now() });
		await runAgent({
			sessionId: created.session_id,
			models,
			tools: [readTool, writeTool],
			scopes,
			maxTurns: 5,
			autoApprove: false,
		});

		reloaded = await session.getSession(created.session_id);
		assert.equal(reloaded.status, 'completed');
		const sent = requests[1];
		const answered = new Set(sent.filter((m) => m.role === 'tool').map((m) => m.toolCallId));
		for (const message of sent) {
			for (const call of message.toolCalls ?? []) assert.ok(answered.has(call.id), `tool call ${call.id} unanswered`);
		}
	});

	it('keeps the aborted status when a cancel lands after generate has resolved', async () => {
		const created = await session.createSession({ user: 'admin' });
		await session.appendMessage(created.session_id, { role: 'user', content: 'go', createdAt: Date.now() });
		const controller = new AbortController();
		const models = {
			async generate() {
				controller.abort();
				await session.setStatus(created.session_id, 'aborted', 'Cancelled by operator');
				return { content: '', finishReason: 'length' };
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
		assert.equal(reloaded.lastError, 'Cancelled by operator');
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

describe('agent/loop observation size and context window', () => {
	beforeEach(() => {
		session._setTableForTests(makeMockTable());
		_resetInFlightForTests();
	});

	afterEach(() => {
		session._setTableForTests(undefined);
	});

	function contextWindowError() {
		return Object.assign(new Error('prompt is too long: 250000 tokens > 200000 maximum'), {
			contextWindowExceeded: true,
		});
	}

	function bigTool(name, bytes) {
		return {
			def: { name, description: name, parameters: { type: 'object' } },
			handler: async () => ({ text: 'L'.repeat(bytes) }),
		};
	}

	function toolTurn(...names) {
		return {
			content: '',
			finishReason: 'tool_calls',
			toolCalls: names.map((name, i) => ({ id: `${name}-${i}`, name, arguments: {} })),
		};
	}

	/** A model that replays `script` entries in order; an Error entry is thrown, anything else returned. */
	function scriptedModels(script) {
		const requests = [];
		return {
			requests,
			models: {
				async generate(input) {
					requests.push(structuredClone(input));
					const step = script[requests.length - 1];
					if (!step) throw new Error('script exhausted');
					if (step instanceof Error) throw step;
					return step;
				},
			},
		};
	}

	async function sessionWith(...messages) {
		const created = await session.createSession({ user: 'admin' });
		for (const message of messages) {
			await session.appendMessage(created.session_id, { createdAt: Date.now(), ...message });
		}
		return created.session_id;
	}

	it('cuts a tool result over maxToolResultBytes to the cap, with a marker, and the next turn runs', async () => {
		const sessionId = await sessionWith({ role: 'user', content: 'read the log' });
		const { models, requests } = scriptedModels([toolTurn('big'), { content: 'summary', finishReason: 'stop' }]);

		await runAgent({
			sessionId,
			models,
			tools: [bigTool('big', 200_000)],
			scopes,
			maxTurns: 5,
			maxToolResultBytes: 4096,
		});

		const reloaded = await session.getSession(sessionId);
		assert.equal(reloaded.status, 'completed');
		const toolMessage = reloaded.messages.find((m) => m.role === 'tool');
		assert.ok(Buffer.byteLength(toolMessage.content, 'utf8') <= 4096);
		assert.match(toolMessage.content, /^\{"ok":true,"result":\{"text":"LLL/);
		assert.match(
			toolMessage.content,
			/…\[truncated; full result is 200032 bytes\. Ask for less: read_file with startLine\/lineCount/
		);
		assert.equal(requests[1].messages.find((m) => m.role === 'tool').content, toolMessage.content);
	});

	it('caps a tool error observation too', async () => {
		const sessionId = await sessionWith({ role: 'user', content: 'go' });
		const failing = {
			def: { name: 'fail', description: 'fail', parameters: { type: 'object' } },
			handler: async () => {
				throw new Error('E'.repeat(50_000));
			},
		};
		const { models } = scriptedModels([toolTurn('fail'), { content: 'ok', finishReason: 'stop' }]);

		await runAgent({ sessionId, models, tools: [failing], scopes, maxTurns: 5, maxToolResultBytes: 2048 });

		const toolMessage = (await session.getSession(sessionId)).messages.find((m) => m.role === 'tool');
		assert.ok(Buffer.byteLength(toolMessage.content, 'utf8') <= 2048);
		assert.match(toolMessage.content, /^\{"ok":false,"error":"EEE/);
	});

	it('defaults the cap to 65536 bytes and hands it to tools as ctx.maxResultBytes', async () => {
		const sessionId = await sessionWith({ role: 'user', content: 'go' });
		let seen;
		const probe = {
			def: { name: 'probe', description: 'probe', parameters: { type: 'object' } },
			handler: async (_args, ctx) => {
				seen = ctx.maxResultBytes;
				return { text: 'x'.repeat(100_000) };
			},
		};
		const { models } = scriptedModels([toolTurn('probe'), { content: 'ok', finishReason: 'stop' }]);

		await runAgent({ sessionId, models, tools: [probe], scopes, maxTurns: 5 });

		assert.equal(seen, 65536);
		const toolMessage = (await session.getSession(sessionId)).messages.find((m) => m.role === 'tool');
		assert.ok(Buffer.byteLength(toolMessage.content, 'utf8') <= 65536);
	});

	it('reports a result JSON cannot serialize as a tool error with its message', async () => {
		// Harper's BigInt.prototype.toJSON throws a plain { message } object, not an Error.
		require('#src/server/serverHelpers/JSONStream');
		const sessionId = await sessionWith({ role: 'user', content: 'go' });
		const bigint = {
			def: { name: 'bigint', description: 'bigint', parameters: { type: 'object' } },
			handler: async () => ({ count: 10n }),
		};
		const { models } = scriptedModels([toolTurn('bigint'), { content: 'ok', finishReason: 'stop' }]);

		await runAgent({ sessionId, models, tools: [bigint], scopes, maxTurns: 5 });

		const reloaded = await session.getSession(sessionId);
		assert.equal(reloaded.status, 'completed');
		assert.match(
			reloaded.messages.find((m) => m.role === 'tool').content,
			/^\{"ok":false,"error":"Cannot serialize BigInt to JSON"\}$/
		);
	});

	it('sends the system prompt once, as `system`, not also as a message', async () => {
		const sessionId = await sessionWith({ role: 'user', content: 'hi' });
		const { models, requests } = scriptedModels([{ content: 'hello', finishReason: 'stop' }]);

		await runAgent({ sessionId, models, tools: noTools, scopes, maxTurns: 5, systemPrompt: 'You are the agent.' });

		assert.equal(requests[0].system, 'You are the agent.');
		assert.deepEqual(
			requests[0].messages.map((m) => m.role),
			['user']
		);
	});

	it('shrinks the newest tool results and retries once when the request overflows the context window', async () => {
		const sessionId = await sessionWith({ role: 'user', content: 'investigate' });
		const { models, requests } = scriptedModels([
			toolTurn('big', 'big'),
			contextWindowError(),
			{ content: 'answer', finishReason: 'stop' },
		]);

		await runAgent({ sessionId, models, tools: [bigTool('big', 30_000)], scopes, maxTurns: 5 });

		const reloaded = await session.getSession(sessionId);
		assert.equal(reloaded.status, 'completed');
		assert.equal(reloaded.lastError, undefined);
		const toolMessages = reloaded.messages.filter((m) => m.role === 'tool');
		assert.equal(toolMessages.length, 2);
		for (const message of toolMessages) {
			assert.ok(Buffer.byteLength(message.content, 'utf8') <= 2048);
			assert.match(message.content, /^\{"ok":true,"result":\{"text":"LLL/);
			assert.match(
				message.content,
				/…\[cut from 30032 bytes: a request including this result exceeded the model's context window/
			);
		}
		assert.equal(requests.length, 3);
		assert.ok(JSON.stringify(requests[2]).length < JSON.stringify(requests[1]).length / 10);
		assert.deepEqual(
			requests[2].messages.map((m) => m.role),
			['user', 'assistant', 'tool', 'tool']
		);
	});

	it('leaves older tool results alone and shrinks only the newest oversized group', async () => {
		const sessionId = await sessionWith(
			{ role: 'user', content: 'go' },
			{ role: 'assistant', content: '', toolCalls: [{ id: 'old', name: 'big', arguments: {} }] },
			{ role: 'tool', toolCallId: 'old', content: 'O'.repeat(10_000) },
			{
				role: 'assistant',
				content: '',
				toolCalls: [
					{ id: 'a', name: 'big', arguments: {} },
					{ id: 'b', name: 'big', arguments: {} },
				],
			},
			{ role: 'tool', toolCallId: 'a', content: 'small' },
			{ role: 'tool', toolCallId: 'b', content: 'N'.repeat(10_000) },
			{ role: 'user', content: 'and now?' }
		);
		const { models } = scriptedModels([contextWindowError(), { content: 'answer', finishReason: 'stop' }]);

		await runAgent({ sessionId, models, tools: noTools, scopes, maxTurns: 5 });

		const byId = Object.fromEntries(
			(await session.getSession(sessionId)).messages
				.filter((m) => m.role === 'tool')
				.map((m) => [m.toolCallId, m.content])
		);
		assert.equal(byId.old, 'O'.repeat(10_000));
		assert.equal(byId.a, 'small');
		assert.match(byId.b, /^N+…\[cut from 10000 bytes/);
	});

	it('recovers a session whose oversized result predates the cap, behind a newer prompt', async () => {
		const sessionId = await sessionWith(
			{ role: 'user', content: 'read it' },
			{ role: 'assistant', content: '', toolCalls: [{ id: 'c1', name: 'read_file', arguments: {} }] },
			{ role: 'tool', toolCallId: 'c1', content: JSON.stringify({ ok: true, result: 'x'.repeat(1_000_000) }) },
			{ role: 'user', content: 'Try again.' }
		);
		const { models } = scriptedModels([contextWindowError(), { content: 'recovered', finishReason: 'stop' }]);

		await runAgent({ sessionId, models, tools: noTools, scopes, maxTurns: 5 });

		const reloaded = await session.getSession(sessionId);
		assert.equal(reloaded.status, 'completed');
		assert.ok(Buffer.byteLength(reloaded.messages[2].content, 'utf8') <= 2048);
	});

	it('shrinks results written from resolved approvals before the first model call', async () => {
		const sessionId = await sessionWith(
			{ role: 'user', content: 'deploy' },
			{ role: 'assistant', content: '', toolCalls: [{ id: 'd1', name: 'dump', arguments: {} }] }
		);
		const approval = await session.addPendingApproval(sessionId, {
			toolName: 'dump',
			arguments: {},
			toolCallId: 'd1',
			reason: 'destructive',
		});
		await session.resolveApproval(sessionId, approval.id, true);
		const dump = { ...bigTool('dump', 50_000), destructive: true };
		const { models } = scriptedModels([contextWindowError(), { content: 'done', finishReason: 'stop' }]);

		await runAgent({ sessionId, models, tools: [dump], scopes, maxTurns: 5 });

		const reloaded = await session.getSession(sessionId);
		assert.equal(reloaded.status, 'completed');
		const toolMessage = reloaded.messages.find((m) => m.toolCallId === 'd1');
		assert.ok(Buffer.byteLength(toolMessage.content, 'utf8') <= 2048);
		assert.equal(reloaded.pendingApprovals[0].consumed, true);
	});

	it('ends in error when the retry also overflows', async () => {
		const sessionId = await sessionWith({ role: 'user', content: 'go' });
		const { models, requests } = scriptedModels([toolTurn('big'), contextWindowError(), contextWindowError()]);

		await assert.rejects(runAgent({ sessionId, models, tools: [bigTool('big', 30_000)], scopes, maxTurns: 5 }));

		const reloaded = await session.getSession(sessionId);
		assert.equal(reloaded.status, 'error');
		assert.match(
			reloaded.lastError,
			/no longer fits the model's context window: it still does not fit after shrinking/
		);
		assert.match(reloaded.lastError, /start a new session/);
		assert.match(reloaded.lastError, /prompt is too long/);
		assert.equal(requests.length, 3);
	});

	it('ends in error without retrying when no tool result is large enough to shrink', async () => {
		const sessionId = await sessionWith({ role: 'user', content: 'x'.repeat(5000) });
		const { models, requests } = scriptedModels([contextWindowError()]);

		await assert.rejects(runAgent({ sessionId, models, tools: noTools, scopes, maxTurns: 5 }));

		const reloaded = await session.getSession(sessionId);
		assert.equal(reloaded.status, 'error');
		assert.match(
			reloaded.lastError,
			/no tool result over 2048 bytes is left to shrink; shorten the prompt or start a new session/
		);
		assert.equal(requests.length, 1);
	});

	it('does not retry other provider errors', async () => {
		const sessionId = await sessionWith({ role: 'user', content: 'go' });
		const rateLimited = Object.assign(new Error('OpenAI /chat/completions returned HTTP 429'), { upstreamStatus: 429 });
		const { models, requests } = scriptedModels([toolTurn('big'), rateLimited]);

		await assert.rejects(runAgent({ sessionId, models, tools: [bigTool('big', 30_000)], scopes, maxTurns: 5 }));

		const reloaded = await session.getSession(sessionId);
		assert.equal(reloaded.status, 'error');
		assert.equal(reloaded.lastError, 'OpenAI /chat/completions returned HTTP 429');
		assert.equal(requests.length, 2);
		assert.ok(reloaded.messages.find((m) => m.role === 'tool').content.length > 30_000);
	});

	it('caps the observation for a tool the model invented', async () => {
		const sessionId = await sessionWith({ role: 'user', content: 'go' });
		const invented = {
			content: '',
			finishReason: 'tool_calls',
			toolCalls: [{ id: 'x', name: 'n'.repeat(10_000), arguments: {} }],
		};
		const { models } = scriptedModels([invented, { content: 'ok', finishReason: 'stop' }]);

		await runAgent({ sessionId, models, tools: noTools, scopes, maxTurns: 5, maxToolResultBytes: 2048 });

		const toolMessage = (await session.getSession(sessionId)).messages.find((m) => m.role === 'tool');
		assert.ok(Buffer.byteLength(toolMessage.content, 'utf8') <= 2048);
		assert.match(toolMessage.content, /^\{"error":"unknown_tool","name":"nnn/);
	});

	it('keeps the aborted status when a cancel lands while the model is answering', async () => {
		const sessionId = await sessionWith({ role: 'user', content: 'go' });
		const controller = new AbortController();
		const models = {
			async generate() {
				controller.abort();
				await session.setStatus(sessionId, 'aborted', 'Cancelled by operator');
				return { content: 'late answer', finishReason: 'stop' };
			},
		};

		await runAgent({ sessionId, models, tools: noTools, scopes, maxTurns: 5, signal: controller.signal });

		const reloaded = await session.getSession(sessionId);
		assert.equal(reloaded.status, 'aborted');
		assert.deepEqual(
			reloaded.messages.map((m) => m.role),
			['user']
		);
	});

	it('keeps the aborted status when a cancel lands while the answer is being recorded', async () => {
		const table = makeMockTable();
		session._setTableForTests(table);
		const sessionId = await sessionWith({ role: 'user', content: 'go' });
		const controller = new AbortController();
		let cancelWrite;
		const put = table.put.bind(table);
		table.put = async (record) => {
			await put(record);
			if (record.messages.at(-1)?.role === 'assistant' && !controller.signal.aborted) {
				controller.abort();
				cancelWrite = session.setStatus(sessionId, 'aborted', 'Cancelled by operator');
			}
		};
		const { models } = scriptedModels([{ content: 'answer', finishReason: 'stop' }]);

		await runAgent({ sessionId, models, tools: noTools, scopes, maxTurns: 5, signal: controller.signal });
		await cancelWrite;

		assert.equal((await session.getSession(sessionId)).status, 'aborted');
	});

	it('recovers through the real OpenAI backend and Models when the server rejects the request as too long', async () => {
		require('#src/resources/databases');
		const { OpenAIBackend } = require('#src/components/openai/index');
		const { setGenerative, clearRegistry } = require('#src/resources/models/backendRegistry');
		const { Models } = require('#src/resources/models/Models');
		const json = (body, status = 200) =>
			new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
		const requestBytes = [];
		const fetch = async (_url, init) => {
			requestBytes.push(init.body.length);
			if (init.body.length > 20_000) {
				return json({ error: { message: 'Context length exceeded.', code: 'context_length_exceeded' } }, 400);
			}
			const last = JSON.parse(init.body).messages.at(-1);
			const message =
				last.role === 'tool'
					? { role: 'assistant', content: 'done' }
					: {
							role: 'assistant',
							content: null,
							tool_calls: [{ id: 'c1', type: 'function', function: { name: 'big', arguments: '{}' } }],
						};
			return json({ choices: [{ message, finish_reason: last.role === 'tool' ? 'stop' : 'tool_calls' }] });
		};
		clearRegistry();
		setGenerative('default', new OpenAIBackend({ apiKey: 'sk-test', model: 'm' }, fetch));
		try {
			const sessionId = await sessionWith({ role: 'user', content: 'read it' });

			await runAgent({
				sessionId,
				// Stub every sink, so the test writes nothing to Harper's real analytics or decision tables.
				models: new Models({ write() {} }, () => {}, {}),
				tools: [bigTool('big', 30_000)],
				scopes,
				maxTurns: 5,
			});

			const reloaded = await session.getSession(sessionId);
			assert.equal(reloaded.status, 'completed', reloaded.lastError);
			assert.equal(requestBytes.length, 3);
			assert.ok(requestBytes[1] > 20_000 && requestBytes[2] < 20_000, String(requestBytes));
			assert.ok(Buffer.byteLength(reloaded.messages.find((m) => m.role === 'tool').content, 'utf8') <= 2048);
		} finally {
			clearRegistry();
		}
	});

	it('neither shrinks nor retries once the run is cancelled', async () => {
		const sessionId = await sessionWith(
			{ role: 'user', content: 'go' },
			{ role: 'assistant', content: '', toolCalls: [{ id: 'c1', name: 'big', arguments: {} }] },
			{ role: 'tool', toolCallId: 'c1', content: 'B'.repeat(10_000) }
		);
		const controller = new AbortController();
		let calls = 0;
		const models = {
			async generate() {
				calls++;
				controller.abort();
				await session.setStatus(sessionId, 'aborted', 'Cancelled by operator');
				throw contextWindowError();
			},
		};

		await runAgent({ sessionId, models, tools: noTools, scopes, maxTurns: 5, signal: controller.signal });

		const reloaded = await session.getSession(sessionId);
		assert.equal(reloaded.status, 'aborted');
		assert.equal(calls, 1);
		assert.equal(reloaded.messages[2].content, 'B'.repeat(10_000));
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

	it("records a rejected reply's usage beside the transcript and counts it toward the caps", async () => {
		const sessionId = await newSession();
		const cutOff = { content: 'partial', finishReason: 'length', ...usage(80, 30, 0.5) };
		await runAgent({ sessionId, models: stubModels([cutOff]), tools: noTools, scopes, maxTurns: 5 });

		const rejected = await session.getSession(sessionId);
		assert.equal(rejected.status, 'error');
		assert.equal(
			rejected.messages.filter((m) => m.role === 'assistant').length,
			0,
			'the reply stays out of the transcript'
		);
		assert.deepStrictEqual(rejected.rejectedCalls, [{ promptTokens: 80, completionTokens: 30, costUsd: 0.5 }]);
		assert.deepStrictEqual(summarizeSessionUsage(rejected.messages, rejected.rejectedCalls), {
			calls: 1,
			promptTokens: 80,
			completionTokens: 30,
			costUsd: 0.5,
		});

		await session.appendMessage(sessionId, { role: 'user', content: 'again', createdAt: Date.now() });
		let generateCalls = 0;
		const models = {
			async generate() {
				generateCalls++;
				return finalTurn('unreached', usage(1, 1));
			},
		};
		await runAgent({ sessionId, models, tools: noTools, scopes, maxTurns: 5, maxSessionTokens: 100 });
		assert.equal(generateCalls, 0, 'the rejected call alone already reached the cap');
		assert.match(
			(await session.getSession(sessionId)).lastError,
			/maxSessionTokens=100 reached: this session used 110 tokens/
		);
	});

	it('a rejected reply that reported no usage makes a capped session unmeasured', async () => {
		const sessionId = await newSession();
		await runAgent({
			sessionId,
			models: stubModels([{ content: '', finishReason: 'stop' }]),
			tools: noTools,
			scopes,
			maxTurns: 5,
		});
		const rejected = await session.getSession(sessionId);
		assert.deepStrictEqual(rejected.rejectedCalls, [{}]);
		assert.deepStrictEqual(summarizeSessionUsage(rejected.messages, rejected.rejectedCalls), { calls: 1 });
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

describe('agent/loop never overwrites a cancel', () => {
	beforeEach(() => {
		session._setTableForTests(makeMockTable());
		_resetInFlightForTests();
	});
	afterEach(() => {
		session._setTableForTests(undefined);
	});

	const cancel = (sessionId) => session.setStatus(sessionId, 'aborted', 'Cancelled by operator');
	const toolCall = (id, name) => ({
		content: '',
		finishReason: 'tool_calls',
		toolCalls: [{ id, name, arguments: {} }],
	});
	const tool = (name, { destructive = false, handler } = {}) => ({
		def: { name, description: name, parameters: { type: 'object' } },
		destructive,
		handler: handler ?? (async () => ({ ok: true })),
	});

	async function newSession() {
		const created = await session.createSession({ user: 'admin' });
		await session.appendMessage(created.session_id, { role: 'user', content: 'go', createdAt: Date.now() });
		return created.session_id;
	}

	async function expectStillAborted(sessionId) {
		const reloaded = await session.getSession(sessionId);
		assert.equal(reloaded.status, 'aborted');
		assert.equal(reloaded.lastError, 'Cancelled by operator');
		return reloaded;
	}

	it('keeps a cancel that lands while the final answer is generated', async () => {
		const sessionId = await newSession();
		const models = {
			async generate() {
				await cancel(sessionId);
				return { content: 'done', finishReason: 'stop' };
			},
		};
		await runAgent({ sessionId, models, tools: noTools, scopes, maxTurns: 5 });
		await expectStillAborted(sessionId);
	});

	it('keeps a cancel that lands before the maxTurns ceiling is written', async () => {
		const sessionId = await newSession();
		const models = {
			async generate() {
				await cancel(sessionId);
				return toolCall('c1', 'read');
			},
		};
		await runAgent({ sessionId, models, tools: [tool('read')], scopes, maxTurns: 1 });
		await expectStillAborted(sessionId);
	});

	it('keeps a cancel that lands while a run pauses on another pending approval', async () => {
		const sessionId = await newSession();
		const drop = tool('drop', { destructive: true, handler: async () => cancel(sessionId) });
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
				},
			]),
			tools: [drop],
			scopes,
			maxTurns: 5,
			autoApprove: false,
		});
		const paused = await session.getSession(sessionId);
		await session.resolveApproval(sessionId, paused.pendingApprovals[0].id, true);
		await runAgent({ sessionId, models: stubModels([]), tools: [drop], scopes, maxTurns: 5, autoApprove: false });
		await expectStillAborted(sessionId);
	});

	it('keeps a cancel that lands before a failed run writes its error', async () => {
		const sessionId = await newSession();
		const models = {
			async generate() {
				await cancel(sessionId);
				throw new Error('provider down');
			},
		};
		await assert.rejects(runAgent({ sessionId, models, tools: noTools, scopes, maxTurns: 5 }), /provider down/);
		await expectStillAborted(sessionId);
	});

	it('answers a gated call as cancelled instead of reopening a cancelled session for approval', async () => {
		const sessionId = await newSession();
		const models = {
			async generate() {
				await cancel(sessionId);
				return toolCall('c1', 'drop');
			},
		};
		await runAgent({
			sessionId,
			models,
			tools: [tool('drop', { destructive: true })],
			scopes,
			maxTurns: 5,
			autoApprove: false,
		});
		const reloaded = await expectStillAborted(sessionId);
		assert.equal(reloaded.pendingApprovals.length, 0);
		const response = reloaded.messages.find((m) => m.role === 'tool' && m.toolCallId === 'c1');
		assert.equal(JSON.parse(response.content).error, 'cancelled_by_operator');
	});

	it('leaves a session a run already finished as it is', async () => {
		const sessionId = await newSession();
		await session.setStatus(sessionId, 'completed');
		assert.equal(await session.cancelSession(sessionId), false);
		assert.equal((await session.getSession(sessionId)).status, 'completed');
	});

	it('answers the rest of the turn when a cancel lands between its tool calls', async () => {
		const sessionId = await newSession();
		const controller = new AbortController();
		const ran = [];
		const first = tool('first', {
			handler: async () => {
				ran.push('first');
				controller.abort();
				await cancel(sessionId);
				return { ok: true };
			},
		});
		const second = tool('second', { handler: async () => ran.push('second') });
		const models = stubModels([
			{
				content: '',
				finishReason: 'tool_calls',
				toolCalls: [
					{ id: 'c1', name: 'first', arguments: {} },
					{ id: 'c2', name: 'second', arguments: {} },
				],
			},
		]);
		await runAgent({ sessionId, models, tools: [first, second], scopes, maxTurns: 5, signal: controller.signal });

		assert.deepStrictEqual(ran, ['first']);
		const reloaded = await expectStillAborted(sessionId);
		const responses = reloaded.messages.filter((m) => m.role === 'tool');
		assert.deepStrictEqual(
			responses.map((m) => m.toolCallId),
			['c1', 'c2']
		);
		assert.equal(JSON.parse(responses[1].content).error, 'cancelled_by_operator');
	});

	it('starts no run for a request admitted before a cancel that arrived while it was writing', async () => {
		const sessionId = await newSession();
		const admitted = admitRun(sessionId);
		fenceRuns(sessionId);
		await cancel(sessionId);
		let generateCalls = 0;
		const models = {
			async generate() {
				generateCalls++;
				return { content: 'unreached', finishReason: 'stop' };
			},
		};
		await runAgent({ sessionId, models, tools: noTools, scopes, maxTurns: 5, admitted });
		assert.equal(generateCalls, 0);
		await expectStillAborted(sessionId);

		await runAgent({ sessionId, models, tools: noTools, scopes, maxTurns: 5, admitted: admitRun(sessionId) });
		assert.equal(generateCalls, 1, 'a request admitted after the cancel runs');
	});

	it('keeps a cancel that lands while a rejected reply is generated', async () => {
		const sessionId = await newSession();
		const models = {
			async generate() {
				await cancel(sessionId);
				return { content: 'partial', finishReason: 'length' };
			},
		};
		await runAgent({ sessionId, models, tools: noTools, scopes, maxTurns: 5 });
		await expectStillAborted(sessionId);
	});

	it('drains an approval resolved while the run is executing an earlier one', async () => {
		const sessionId = await newSession();
		const runs = [];
		let secondApprovalId;
		const drop = tool('drop', {
			destructive: true,
			handler: async (args) => {
				runs.push(args.n);
				if (args.n === 1) await session.resolveApproval(sessionId, secondApprovalId, true);
				return { ok: true };
			},
		});
		await runAgent({
			sessionId,
			models: stubModels([
				{
					content: '',
					finishReason: 'tool_calls',
					toolCalls: [
						{ id: 'c1', name: 'drop', arguments: { n: 1 } },
						{ id: 'c2', name: 'drop', arguments: { n: 2 } },
					],
				},
			]),
			tools: [drop],
			scopes,
			maxTurns: 5,
			autoApprove: false,
		});
		const paused = await session.getSession(sessionId);
		secondApprovalId = paused.pendingApprovals[1].id;
		await session.resolveApproval(sessionId, paused.pendingApprovals[0].id, true);
		let sentToModel;
		const models = {
			async generate(input) {
				sentToModel = input.messages;
				return { content: 'done', finishReason: 'stop' };
			},
		};
		await runAgent({ sessionId, models, tools: [drop], scopes, maxTurns: 5, autoApprove: false });

		assert.deepStrictEqual(runs, [1, 2]);
		const answered = sentToModel.filter((m) => m.role === 'tool').map((m) => m.toolCallId);
		assert.deepStrictEqual(
			answered.sort(),
			['c1', 'c2'],
			'every tool call has its response before the next model call'
		);
		assert.equal((await session.getSession(sessionId)).status, 'completed');
	});

	it('does not pause a session whose approvals were all resolved before the pause was written', async () => {
		const sessionId = await newSession();
		await session.addPendingApproval(sessionId, {
			toolName: 'drop',
			arguments: {},
			toolCallId: 'c1',
			reason: 'destructive',
		});
		const paused = await session.getSession(sessionId);
		await session.resolveApproval(sessionId, paused.pendingApprovals[0].id, true);
		const after = await session.endRun(sessionId, { status: 'awaiting_approval', pauseWhileApprovalsOpen: true });
		assert.equal(after.status, 'idle');
	});

	it('answers a claimed approval whose run died before its result, in place and without running it again', async () => {
		const sessionId = await newSession();
		const drop = tool('drop', { destructive: true, handler: async () => assert.fail('must not run twice') });
		await runAgent({
			sessionId,
			models: stubModels([toolCall('c1', 'drop')]),
			tools: [drop],
			scopes,
			maxTurns: 5,
			autoApprove: false,
		});
		const paused = await session.getSession(sessionId);
		await session.resolveApproval(sessionId, paused.pendingApprovals[0].id, true);
		assert.equal(await session.claimApproval(sessionId, paused.pendingApprovals[0].id), true);
		// What an operator does after the crash: cancel the stuck run, then prompt again.
		await session.cancelSession(sessionId);
		await session.appendMessage(sessionId, { role: 'user', content: 'what happened?', createdAt: Date.now() });

		let sentToModel;
		const models = {
			async generate(input) {
				sentToModel = input.messages;
				return { content: 'done', finishReason: 'stop' };
			},
		};
		await runAgent({ sessionId, models, tools: [drop], scopes, maxTurns: 5, autoApprove: false });
		const reloaded = await session.getSession(sessionId);
		const order = reloaded.messages.map((m) => m.toolCallId ?? m.role);
		assert.deepStrictEqual(order.slice(1, 4), ['assistant', 'c1', 'user'], 'the answer sits right after its tool call');
		const response = reloaded.messages.find((m) => m.toolCallId === 'c1');
		assert.deepStrictEqual(JSON.parse(response.content), {
			ok: false,
			error: 'interrupted',
			outcome: 'unknown',
			tool: 'drop',
		});
		assert.ok(
			sentToModel.findIndex((m) => m.toolCallId === 'c1') <
				sentToModel.findIndex((m) => m.role === 'user' && m.content === 'what happened?')
		);
		assert.equal(reloaded.status, 'completed');
	});

	it('answers an interrupted claim on the latest turn when a provider reused its tool-call id', async () => {
		const sessionId = await newSession();
		await session.appendMessage(sessionId, {
			role: 'assistant',
			content: '',
			toolCalls: [{ id: 'c1', name: 'read', arguments: {} }],
			createdAt: 1,
		});
		await session.appendMessage(sessionId, { role: 'tool', content: '{}', toolCallId: 'c1', createdAt: 2 });
		await session.appendMessage(sessionId, {
			role: 'assistant',
			content: '',
			toolCalls: [{ id: 'c1', name: 'drop', arguments: {} }],
			createdAt: 3,
		});
		const approval = await session.addPendingApproval(sessionId, {
			toolName: 'drop',
			arguments: {},
			toolCallId: 'c1',
			reason: 'destructive',
		});
		await session.resolveApproval(sessionId, approval.id, true);
		await session.claimApproval(sessionId, approval.id);

		await session.answerInterruptedClaims(sessionId);
		const roles = (await session.getSession(sessionId)).messages.map((m) => m.role);
		assert.deepStrictEqual(roles, ['user', 'assistant', 'tool', 'assistant', 'tool']);
	});

	it('a failed run answers its open approvals and unanswered tool calls in its final write', async () => {
		const sessionId = await newSession();
		const table = session.getAgentSessionTable();
		const put = table.put.bind(table);
		let parked = 0;
		table.put = async (row) => {
			if (row.pendingApprovals.length === 2 && ++parked === 1) throw new Error('storage fault');
			return put(row);
		};
		await assert.rejects(
			runAgent({
				sessionId,
				models: stubModels([
					{
						content: '',
						finishReason: 'tool_calls',
						toolCalls: [
							{ id: 'c1', name: 'drop', arguments: {} },
							{ id: 'c2', name: 'drop', arguments: {} },
						],
					},
				]),
				tools: [tool('drop', { destructive: true })],
				scopes,
				maxTurns: 5,
				autoApprove: false,
			}),
			/storage fault/
		);
		const failed = await session.getSession(sessionId);
		assert.equal(failed.status, 'error');
		assert.ok(failed.pendingApprovals.every((a) => a.consumed));
		const answers = failed.messages.filter((m) => m.role === 'tool');
		assert.deepStrictEqual(answers.map((m) => m.toolCallId).sort(), ['c1', 'c2']);
		assert.ok(answers.every((m) => JSON.parse(m.content).error === 'run_failed'));
	});

	it('answers an interrupted claim even when a budget stop ends the run first', async () => {
		const sessionId = await newSession();
		await runAgent({
			sessionId,
			models: stubModels([
				{
					content: '',
					finishReason: 'tool_calls',
					toolCalls: [{ id: 'c1', name: 'drop', arguments: {} }],
					usage: { promptTokens: 60, completionTokens: 10 },
				},
			]),
			tools: [tool('drop', { destructive: true })],
			scopes,
			maxTurns: 5,
			autoApprove: false,
		});
		const paused = await session.getSession(sessionId);
		await session.resolveApproval(sessionId, paused.pendingApprovals[0].id, true);
		await session.claimApproval(sessionId, paused.pendingApprovals[0].id);
		await runAgent({ sessionId, models: stubModels([]), tools: [], scopes, maxTurns: 5, maxSessionTokens: 50 });
		const reloaded = await session.getSession(sessionId);
		assert.equal(reloaded.status, 'error');
		assert.equal(JSON.parse(reloaded.messages.find((m) => m.toolCallId === 'c1').content).error, 'interrupted');
	});

	it('counts a billed call that returns after the cancel', async () => {
		const sessionId = await newSession();
		const controller = new AbortController();
		const models = {
			async generate() {
				controller.abort();
				await cancel(sessionId);
				return { content: 'late', finishReason: 'stop', usage: { promptTokens: 40, completionTokens: 5 } };
			},
		};
		await runAgent({ sessionId, models, tools: noTools, scopes, maxTurns: 5, signal: controller.signal });
		const reloaded = await expectStillAborted(sessionId);
		assert.deepStrictEqual(reloaded.rejectedCalls, [{ promptTokens: 40, completionTokens: 5 }]);
		assert.equal(reloaded.messages.filter((m) => m.role === 'assistant').length, 0);
	});

	it('does not mark a run that was cancelled before it started as running', async () => {
		const sessionId = await newSession();
		await cancel(sessionId);
		const controller = new AbortController();
		controller.abort();
		let generateCalls = 0;
		const models = {
			async generate() {
				generateCalls++;
				return { content: 'unreached', finishReason: 'stop' };
			},
		};
		await runAgent({ sessionId, models, tools: noTools, scopes, maxTurns: 5, signal: controller.signal });
		assert.equal(generateCalls, 0);
		await expectStillAborted(sessionId);
	});
});
