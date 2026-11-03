/**
 * The built-in agent's operator tool groups turned off at boot (harper#3993): the model is sent no
 * schema for them, a call to one runs nothing, a recompose does not bring them back, and the
 * operations API reports and refuses to change the switches.
 */
import { suite, test, before, after } from 'node:test';
import { strictEqual, ok, deepStrictEqual } from 'node:assert';
import { createServer, type IncomingMessage, type ServerResponse, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { startHarper, teardownHarper } from '@harperfast/integration-testing';
// @ts-expect-error utils/client.mjs has no type declarations; runtime resolves fine
import { createApiClient } from '../apiTests/utils/client.mjs';

const OPERATOR_TOOL_NAMES = [
	'read_file',
	'write_file',
	'list_dir',
	'grep_files',
	'tail_file',
	'http_fetch',
	'schedule_followup',
	'inspector_attach',
	'inspector_evaluate',
	'inspector_set_breakpoint',
	'inspector_set_logpoint',
	'inspector_profile_cpu',
	'harper_best_practice',
];

const TOOL_CALLS = [
	{ name: 'read_file', arguments: { root: 'config' } },
	{ name: 'schedule_followup', arguments: { delayMs: 1000, prompt: 'again' } },
	{ name: 'inspector_attach', arguments: { workerIndex: 0 } },
	{ name: 'harper_best_practice', arguments: {} },
	{ name: 'http_fetch', arguments: { url: 'http://127.0.0.1:1/' } },
];

interface FakeModel {
	baseUrl: string;
	requests: string[];
	close: () => Promise<void>;
}

async function startFakeModel(): Promise<FakeModel> {
	const requests: string[] = [];
	const server: Server = createServer((req: IncomingMessage, res: ServerResponse) => {
		let raw = '';
		req.on('data', (chunk) => (raw += chunk));
		req.on('end', () => {
			requests.push(raw);
			const { messages } = JSON.parse(raw) as { messages: { role: string }[] };
			const call = TOOL_CALLS[messages.filter((message) => message.role === 'tool').length];
			res.writeHead(200, { 'Content-Type': 'application/json' });
			res.end(
				JSON.stringify({
					choices: [
						{
							finish_reason: call ? 'tool_calls' : 'stop',
							message: call
								? {
										role: 'assistant',
										content: null,
										tool_calls: [
											{
												id: `call-${requests.length}`,
												type: 'function',
												function: { name: call.name, arguments: JSON.stringify(call.arguments) },
											},
										],
									}
								: { role: 'assistant', content: 'done' },
						},
					],
					usage: { prompt_tokens: 1, completion_tokens: 1 },
				})
			);
		});
	});
	await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
	const { port } = server.address() as AddressInfo;
	return {
		baseUrl: `http://127.0.0.1:${port}/v1`,
		requests,
		close: () => new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve()))),
	};
}

const OFF = { filesystem: false, schedule: false, inspector: false, bestPractices: false };

suite('agent operator tool groups off at boot (harper#3993)', (ctx: any) => {
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
			if (session.status !== 'running' && session.status !== 'idle') return session;
			ok(Date.now() < deadline, `session ${sessionId} still ${session.status} after 30s`);
			await new Promise((resolve) => setTimeout(resolve, 100));
		}
	}

	function assertGroupsAbsent(session: any, requests: string[]) {
		strictEqual(session.status, 'completed', session.lastError);
		const results = session.messages.filter((message: any) => message.role === 'tool').map((m: any) => m.content);
		strictEqual(results.length, TOOL_CALLS.length);
		for (const [index, result] of results.entries()) {
			ok(result.includes('unknown_tool'), `${TOOL_CALLS[index].name}: ${result}`);
		}
		ok(requests.length > 0);
		for (const raw of requests) {
			const request = JSON.parse(raw) as {
				messages: { role: string; content: string }[];
				tools?: { function: { name: string } }[];
			};
			const sent = (request.tools ?? []).map((tool) => tool.function.name);
			ok(sent.length > 0, 'the operations tools are still sent');
			for (const name of OPERATOR_TOOL_NAMES) ok(!sent.includes(name), `${name} was sent to the model`);
			const system = request.messages.find((message) => message.role === 'system');
			ok(system, 'the system prompt is sent');
			ok(!/filesystem|scheduling|inspector|best.practice|HTTP fetch/i.test(system.content), system.content);
		}
	}

	before(async () => {
		fake = await startFakeModel();
		await startHarper(ctx, {
			config: {
				models: {
					generative: {
						default: { backend: 'openai', baseUrl: fake.baseUrl, apiKey: 'fake-key', model: 'fake-model' },
					},
				},
				agent: { enabled: true, httpFetch: false, tools: OFF },
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

	test('get_agent_config reports the switches off, and set_agent_config refuses to change them', async () => {
		const config = await op({ operation: 'get_agent_config' });
		deepStrictEqual(config.tools, OFF);
		strictEqual(config.httpFetch, false);
		strictEqual(config.maxTurns, 50);

		const refused = await op({ operation: 'set_agent_config', tools: { filesystem: true }, maxTurns: 7 }, 400);
		ok(/agent\.tools is fixed at startup/.test(refused.error), refused.error);
		const after = await op({ operation: 'get_agent_config' });
		deepStrictEqual(after.tools, OFF);
		strictEqual(after.maxTurns, 50);
	});

	test('a call to a disabled tool runs nothing, and the model is sent no such tool', async () => {
		const before = fake.requests.length;
		const session = await runToEnd('use every tool');
		assertGroupsAbsent(session, fake.requests.slice(before));
	});

	test('a recompose after set_agent_config keeps the groups off', async () => {
		await op({ operation: 'set_agent_config', allowDestructive: true });
		try {
			const before = fake.requests.length;
			const session = await runToEnd('try again');
			assertGroupsAbsent(session, fake.requests.slice(before));
			const config = await op({ operation: 'get_agent_config' });
			strictEqual(config.allowDestructive, true);
			deepStrictEqual(config.tools, OFF);
		} finally {
			await op({ operation: 'set_agent_config', allowDestructive: false });
		}
	});
});
