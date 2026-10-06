/**
 * The built-in agent's per-session usage and caps, end to end (#3040): model pricing from config, the
 * facade pricing each call, usage folded from the durable transcript, and the operations API.
 */
import { suite, test, before, after } from 'node:test';
import { strictEqual, ok, deepStrictEqual } from 'node:assert';
import { createServer, type IncomingMessage, type ServerResponse, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { startHarper, teardownHarper } from '@harperfast/integration-testing';
// @ts-expect-error utils/client.mjs has no type declarations; runtime resolves fine
import { createApiClient } from '../apiTests/utils/client.mjs';

const PROMPT_TOKENS = 1000;
const COMPLETION_TOKENS = 200;
// 1000 prompt tokens at $10/Mtok plus 200 completion tokens at $50/Mtok.
const COST_PER_CALL = 0.02;
const TOOL_ROUNDS_BEFORE_ANSWER = 2;

interface FakeModel {
	baseUrl: string;
	calls: () => number;
	close: () => Promise<void>;
}

/**
 * An OpenAI-compatible model that asks for a tool until the conversation holds two tool responses,
 * then answers. The tool name is unknown to the agent, so each call runs nothing and only feeds the
 * next model turn.
 */
async function startFakeModel(): Promise<FakeModel> {
	let calls = 0;
	const server: Server = createServer((req: IncomingMessage, res: ServerResponse) => {
		if (req.method !== 'POST' || req.url !== '/v1/chat/completions') {
			res.writeHead(404);
			res.end();
			return;
		}
		let raw = '';
		req.on('data', (chunk) => (raw += chunk));
		req.on('end', () => {
			calls++;
			const { messages } = JSON.parse(raw) as { messages: { role: string }[] };
			const toolResponses = messages.filter((message) => message.role === 'tool').length;
			const answer = toolResponses >= TOOL_ROUNDS_BEFORE_ANSWER;
			res.writeHead(200, { 'Content-Type': 'application/json' });
			res.end(
				JSON.stringify({
					choices: [
						{
							finish_reason: answer ? 'stop' : 'tool_calls',
							message: answer
								? { role: 'assistant', content: 'done' }
								: {
										role: 'assistant',
										content: null,
										tool_calls: [
											{
												id: `call-${calls}`,
												type: 'function',
												function: { name: 'fake_lookup', arguments: '{}' },
											},
										],
									},
						},
					],
					usage: { prompt_tokens: PROMPT_TOKENS, completion_tokens: COMPLETION_TOKENS },
				})
			);
		});
	});
	await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
	const { port } = server.address() as AddressInfo;
	return {
		baseUrl: `http://127.0.0.1:${port}/v1`,
		calls: () => calls,
		close: () => new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve()))),
	};
}

const TERMINAL = new Set(['completed', 'error', 'aborted', 'awaiting_approval']);

suite('agent per-session usage and caps (#3040)', (ctx: any) => {
	let fake: FakeModel;
	let client: any;

	const op = async (body: object, status = 200) => {
		const response = await client.req().send(body);
		strictEqual(response.status, status, response.text);
		return response.body;
	};

	async function runToEnd(message: string) {
		const { session_id: sessionId } = await op({ operation: 'agent_prompt', message });
		const deadline = Date.now() + 30_000;
		for (;;) {
			const session = await op({ operation: 'get_agent_session', session_id: sessionId });
			if (TERMINAL.has(session.status)) return session;
			ok(Date.now() < deadline, `session ${sessionId} still ${session.status} after 30s`);
			await new Promise((resolve) => setTimeout(resolve, 100));
		}
	}

	const toolResponsesAnswerEveryCall = (session: any) => {
		const asked = session.messages.flatMap((m: any) => (m.toolCalls ?? []).map((call: any) => call.id));
		const answered = session.messages.filter((m: any) => m.role === 'tool').map((m: any) => m.toolCallId);
		deepStrictEqual(answered.sort(), asked.sort());
	};

	before(async () => {
		fake = await startFakeModel();
		const entry = { backend: 'openai', baseUrl: fake.baseUrl, apiKey: 'fake-key', model: 'fake-model' };
		await startHarper(ctx, {
			config: {
				models: {
					generative: {
						default: { ...entry, pricing: { inputPerMtok: 10, outputPerMtok: 50 } },
						unpriced: entry,
					},
				},
				agent: { enabled: true },
			},
			env: {},
		});
		client = createApiClient(ctx.harper);
	});

	after(async () => {
		try {
			await teardownHarper(ctx);
		} finally {
			await fake.close();
		}
	});

	test('an uncapped run reports usage that matches what the model reported', async () => {
		const callsBefore = fake.calls();
		const session = await runToEnd('look something up');
		const calls = fake.calls() - callsBefore;
		strictEqual(session.status, 'completed', session.lastError);
		strictEqual(calls, TOOL_ROUNDS_BEFORE_ANSWER + 1);
		strictEqual(session.usage.calls, calls);
		strictEqual(session.usage.promptTokens, PROMPT_TOKENS * calls);
		strictEqual(session.usage.completionTokens, COMPLETION_TOKENS * calls);
		ok(Math.abs(session.usage.costUsd - COST_PER_CALL * calls) < 1e-9, String(session.usage.costUsd));

		const { sessions } = await op({ operation: 'list_agent_sessions' });
		const listed = sessions.find((s: any) => s.session_id === session.session_id);
		deepStrictEqual(listed.usage, session.usage);
	});

	test('maxTokens stops the session after the call that reaches it, with every tool call answered', async () => {
		await op({ operation: 'set_agent_config', maxTokens: 2000 });
		try {
			const callsBefore = fake.calls();
			const session = await runToEnd('look again');
			strictEqual(fake.calls() - callsBefore, 2, 'the second call reaches 2400 tokens');
			strictEqual(session.status, 'error');
			ok(/agent\.maxTokens=2000 reached: this session used 2400 tokens/.test(session.lastError), session.lastError);
			toolResponsesAnswerEveryCall(session);

			const before = fake.calls();
			await op({ operation: 'agent_prompt', session_id: session.session_id, message: 'continue' });
			// Asserting a non-event: the session was already `error`, so there is no state change to wait on.
			await new Promise((resolve) => setTimeout(resolve, 1000));
			const after = await op({ operation: 'get_agent_session', session_id: session.session_id });
			strictEqual(after.status, 'error');
			strictEqual(after.messages.at(-1).content, 'continue');
			strictEqual(fake.calls(), before, 'a capped session makes no further model call');
		} finally {
			await op({ operation: 'set_agent_config', maxTokens: null });
		}
	});

	test('maxCostUsd stops the session from the priced cost', async () => {
		await op({ operation: 'set_agent_config', maxCostUsd: 0.03 });
		try {
			const session = await runToEnd('price check');
			strictEqual(session.status, 'error');
			strictEqual(session.usage.calls, 2);
			ok(/agent\.maxCostUsd=0\.03 reached/.test(session.lastError), session.lastError);
			toolResponsesAnswerEveryCall(session);
		} finally {
			await op({ operation: 'set_agent_config', maxCostUsd: null });
		}
	});

	test('maxCostUsd against an unpriced model stops after one call and names the missing pricing', async () => {
		await op({ operation: 'set_agent_config', model: 'unpriced', maxCostUsd: 5 });
		try {
			const session = await runToEnd('no prices here');
			strictEqual(session.status, 'error');
			strictEqual(session.usage.calls, 1);
			strictEqual(session.usage.costUsd, undefined);
			ok(/maxCostUsd=5 cannot be enforced: .*declare pricing/.test(session.lastError), session.lastError);
		} finally {
			await op({ operation: 'set_agent_config', model: 'default', maxCostUsd: null });
		}
	});

	test('set_agent_config refuses a malformed cap', async () => {
		const body = await op({ operation: 'set_agent_config', maxTokens: -1 }, 400);
		ok(/agent\.maxTokens must be a positive integer/.test(JSON.stringify(body)), JSON.stringify(body));
	});
});
