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
				models: new Models({ write() {} }),
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
